"""海洋守护者对话 API：优先 Ollama + RAG，失败时安全兜底。"""

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import is_privileged, require_permission
import config
from database import get_db, SessionLocal
from models import ChatHistory, ChatRole, KnowledgeDoc, Report, ReportAnalysis, User
from schemas import ChatMessage, SpaChatRequest
from services import llm as llm_stub

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["chat"])
_chat_service = None
_ollama_ready = False
_init_retry_after = 0.0


def _get_ollama_service():
    global _chat_service, _ollama_ready, _init_retry_after
    if _ollama_ready:
        return _chat_service
    if time.time() < _init_retry_after:
        # 上次初始化失败的冷却期内直接走兜底，避免每个请求都重复昂贵的初始化。
        return None
    try:
        from src.LLM.chat_api import chat_service
        chat_service.initialize(config.OLLAMA_URL)
        _chat_service = chat_service
        _ollama_ready = True
    except Exception:
        logger.exception("LLM 服务初始化失败，30 秒后允许重试")
        _chat_service = None
        _init_retry_after = time.time() + 30
    return _chat_service


def _extract_user_message(body: SpaChatRequest) -> str:
    if body.message and body.message.strip():
        return body.message.strip()
    for msg in reversed(body.messages):
        if msg.role == "user" and msg.content.strip():
            return msg.content.strip()
    return ""


def _build_messages(body: SpaChatRequest, message: str):
    items = [{"role": m.role, "content": m.content} for m in body.messages if m.content.strip()]
    # `message` is the current turn in the legacy payload.  A request may also
    # carry prior `messages`; checking only for any user message would silently
    # omit the current turn and make the model answer the previous question.
    # Keep an already-present final user turn to avoid duplicating modern payloads.
    if not items or not (
        items[-1]["role"] == "user" and items[-1]["content"].strip() == message.strip()
    ):
        items.append({"role": "user", "content": message})
    return items


def _format_analysis_snapshot(raw: str) -> str:
    """把 ReportAnalysis 的 JSON 快照转换为可读的报告事实，避免把 JSON 键值直接展示给用户。"""
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return str(raw or "").strip()
    if not isinstance(payload, dict):
        return str(payload).strip()

    labels = {
        "summary": "分析摘要",
        "risk_level": "风险等级",
        "key_findings": "关键发现",
        "possible_causes": "可能来源",
        "solutions": "处置方案",
        "follow_up_monitoring": "后续监测",
        "evidence": "证据",
    }
    lines: list[str] = []
    for key in ("summary", "risk_level", "key_findings", "possible_causes", "solutions", "follow_up_monitoring", "evidence"):
        value = payload.get(key)
        if value in (None, "", [], {}):
            continue
        label = labels[key]
        if isinstance(value, list):
            lines.append(f"{label}：")
            for item in value:
                if isinstance(item, dict):
                    priority = item.get("priority")
                    action = item.get("action")
                    if priority or action:
                        detail = f"{priority}：" if priority else ""
                        detail += str(action or "")
                        owner = item.get("owner")
                        deadline = item.get("deadline")
                        if owner:
                            detail += f"（责任：{owner}"
                            if deadline:
                                detail += f"；时限：{deadline}"
                            detail += "）"
                        lines.append(f"- {detail}")
                    else:
                        compact = "；".join(f"{k}：{v}" for k, v in item.items() if v not in (None, ""))
                        if compact:
                            lines.append(f"- {compact}")
                else:
                    lines.append(f"- {item}")
        elif isinstance(value, dict):
            compact = "；".join(f"{k}：{v}" for k, v in value.items() if v not in (None, ""))
            if compact:
                lines.append(f"{label}：{compact}")
        else:
            lines.append(f"{label}：{value}")
    return "\n".join(lines).strip()


def _build_report_context(body: SpaChatRequest, current_user: User, db: Session) -> str | None:
    """按当前用户权限构造报告追问上下文，事实来自数据库快照或已导入文档。"""
    parts: list[str] = []
    if body.report_id:
        report = db.query(Report).filter(Report.id == body.report_id).first()
        if not report:
            raise HTTPException(status_code=404, detail="报告不存在")
        if not is_privileged(db, current_user) and report.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="无权限访问该报告上下文")
        latest = (
            db.query(ReportAnalysis)
            .filter(ReportAnalysis.report_id == report.id)
            .order_by(ReportAnalysis.id.desc())
            .first()
        )
        analysis_text = ""
        if latest and latest.result_json:
            analysis_text = _format_analysis_snapshot(latest.result_json)
        created = report.created_at.strftime("%Y-%m-%d %H:%M") if report.created_at else "未知时间"
        area = "近岸监测点"
        try:
            if report.task and report.task.sea_area_id:
                from models import SeaArea

                sea = db.query(SeaArea).filter(SeaArea.id == report.task.sea_area_id).first()
                if sea and getattr(sea, "name", None):
                    area = sea.name
        except Exception:
            logger.debug("报告海域解析失败，使用默认值", exc_info=True)
        if report.task and report.task.file_name:
            task_hint = f"任务 {report.task_id}（{report.task.file_name}）"
        elif report.task_id:
            task_hint = f"任务 {report.task_id}"
        else:
            task_hint = "未关联检测任务"
        parts.append(
            f"报告 ID：RPT-{report.id}\n"
            f"生成时间：{created}\n"
            f"检测海域：{area}\n"
            f"关联任务：{task_hint}\n"
            f"报告摘要：{report.summary or '暂无摘要'}\n"
            f"报告类型：{getattr(report.report_type, 'value', report.report_type) or 'unknown'}\n"
            f"结构化分析快照：\n{analysis_text or '该报告尚未完成结构化分析，请明确说明。'}"
        )
    if body.document_id:
        doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.id == body.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="导入文档不存在")
        if not is_privileged(db, current_user) and doc.uploaded_by not in {None, current_user.id}:
            raise HTTPException(status_code=403, detail="无权限访问该导入文档")
        content = ""
        if doc.file_path and os.path.isfile(doc.file_path):
            try:
                with open(doc.file_path, "r", encoding="utf-8", errors="ignore") as handle:
                    content = handle.read(9000)
            except OSError:
                content = ""
        parts.append(
            f"导入文档 ID：DOC-{doc.id}\n文件名：{doc.file_name}\n"
            f"文档原文节选：\n{content or '文档原文暂不可读取，请明确说明。'}"
        )
    return "\n\n".join(parts)[:12000] if parts else None


def _build_recent_reports_context(current_user: User, db: Session, limit: int = 3) -> str:
    """报告类问题未绑定具体报告时，按权限自动检索最近报告事实。

    实测缺陷：用户问"我最近的检测报告结论"时没有 report_id，模型此前拿不到任何
    真实报告数据，凭空编出"污染等级[高]、重金属超标"。这里把最近几份报告的
    真实快照注入上下文（无报告则注入"暂无报告"事实），配合 finalize 的反编造
    门禁，保证报告结论只能来自数据库。
    """
    query = db.query(Report)
    if not is_privileged(db, current_user):
        query = query.filter(Report.user_id == current_user.id)
    reports = query.order_by(Report.id.desc()).limit(max(1, limit)).all()
    if not reports:
        return (
            "系统按权限检索后确认：当前用户名下暂无已生成的质量报告。"
            "若用户询问报告结论、污染等级或评分，必须明确说明目前没有可核对的报告，"
            "并引导其在报告页生成或导入报告；严禁编造等级、评分或污染物数据。"
        )
    parts: list[str] = []
    for report in reports:
        latest = (
            db.query(ReportAnalysis)
            .filter(ReportAnalysis.report_id == report.id)
            .order_by(ReportAnalysis.id.desc())
            .first()
        )
        analysis_text = ""
        if latest and latest.result_json:
            analysis_text = _format_analysis_snapshot(latest.result_json)
        created = report.created_at.strftime("%Y-%m-%d %H:%M") if report.created_at else "未知时间"
        parts.append(
            f"报告 ID：RPT-{report.id}（生成时间：{created}）\n"
            f"报告摘要：{report.summary or '暂无摘要'}\n"
            f"结构化分析快照：\n{analysis_text or '该报告尚未完成结构化分析，请明确说明。'}"
        )
    return (
        "以下为系统按权限自动检索到的用户最近报告事实清单（用户未手动绑定报告，等同绑定语义）。"
        "回答报告结论、污染等级、评分时只能使用这些事实；若用户所问的报告不在此列，"
        "必须明确说明未找到，严禁编造。\n\n" + "\n\n".join(parts)
    )


def _sse(content: str) -> str:
    return f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"


def _sse_error(message: str) -> str:
    return f"data: {json.dumps({'error': message}, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(body: SpaChatRequest, request: Request, current_user: User = Depends(require_permission("assistant")), db: Session = Depends(get_db)):
    message = _extract_user_message(body)
    if not message:
        return StreamingResponse(iter([f"data: {json.dumps({'error': '消息不能为空'}, ensure_ascii=False)}\n\n", "data: [DONE]\n\n"]), media_type="text/event-stream")

    user_id = current_user.id
    session_id = body.session_id or uuid.uuid4().hex
    report_context = _build_report_context(body, current_user, db)
    if not report_context and llm_stub._is_report_data_question(message):
        # 报告类问题未绑定具体报告时自动注入最近报告事实，堵住"凭空编造报告结论"。
        report_context = _build_recent_reports_context(current_user, db)
    # 指代/超短追问（"那成本呢？""你说的分段解缠怎么操作"）不能被范围外兜底抢答，
    # 必须带着历史上下文进入模型链路。
    follow_up = llm_stub.is_referential_follow_up(message, body.messages)
    db.add(ChatHistory(user_id=user_id, session_id=session_id, role=ChatRole.user, content=message))
    db.commit()

    async def event_stream():
        full = ""
        used_ollama = False
        # Keep the last assistant turn available even when Ollama is offline.
        # The fallback path also needs it to answer referential follow-ups
        # (for example, "那成本呢？") without losing the conversation topic.
        previous_assistant = next(
            (
                item.content.strip()
                for item in reversed(body.messages)
                if item.role == "assistant" and item.content.strip()
            ),
            "",
        )
        try:
            # 身份、寒暄、范围边界和高风险常识先走确定性回答，防止 1.5B 模型胡编。
            # 选中报告/导入文档后，必须让请求进入带上下文的模型链路；
            # 否则同一问题可能被通用 direct_response 提前回答，追问就无法真正基于当前报告。
            # 请求显式绑定报告/文档时，平台功能规则不得抢答；即使上下文暂时为空，
            # 也必须保留绑定语义并进入报告/文档链路。
            direct = None if (body.report_id or body.document_id) else llm_stub.direct_response(
                message, allow_scope_fallback=not follow_up
            )
            if direct:
                # direct_response 已经完成了物种档案/安全规则匹配，不能再回到
                # 通用 fallback，否则当前物种语境会被泛化答案覆盖。
                async for chunk in llm_stub.stream_text(direct):
                    full += chunk
                    yield _sse(chunk)
            else:
                svc = _get_ollama_service()
                if svc is not None:
                    try:
                        from src.LLM.chat_api import ChatMessage as OllamaMessage, ChatRequest as OllamaChatRequest
                        request_messages = [OllamaMessage(role=m["role"], content=m["content"]) for m in _build_messages(body, message) if m["role"] in {"user", "assistant", "system"}]
                        req = OllamaChatRequest(
                            messages=request_messages, model=config.OLLAMA_MODEL, temperature=config.LLM_TEMPERATURE,
                            max_tokens=config.LLM_MAX_TOKENS, stream=True, enable_rag=config.RAG_ENABLED,
                            report_context=report_context,
                        )
                        prepared_messages, evidence = await asyncio.to_thread(svc.prepare_messages, req)
                        previous_assistant = next(
                            (
                                item.content
                                for item in reversed(request_messages)
                                if item.role == "assistant" and item.content.strip()
                            ),
                            "",
                        )
                        # 强相关的报告/法规/检测事实直接使用已排序、带来源的证据，
                        # 避免让 1.5B 模型生成后再被引用门禁拦截，端到端控制在秒级。
                        grounded = None
                        if not report_context and llm_stub.is_strong_evidence_question(message, evidence):
                            grounded = await asyncio.to_thread(llm_stub._knowledge_fallback, message, evidence)
                        if grounded and llm_stub.is_near_duplicate_answer(grounded, previous_assistant):
                            logger.info("强证据答案与上一轮高度重复，改走模型链路")
                            grounded = None
                        if grounded:
                            full = grounded
                            async for chunk in llm_stub.stream_text(full):
                                yield _sse(chunk)
                            used_ollama = True
                        else:
                            # 先缓冲、再通过质量门禁。DeepSeek R1 1.5B 偶尔会复述问题或输出无依据套话；
                            # 此处不能把未验证的半句直接送到 UI。通过后按短句重新流式输出，阅读节奏仍自然。
                            for_event_errors = False
                            upstream = svc.ollama.chat_stream(
                                req.model, prepared_messages, req.temperature, req.max_tokens
                            )
                            checked_chunks = 0
                            try:
                                async for event in upstream:
                                    # 缓冲阶段没有 yield 点，客户端取消要靠主动探测；
                                    # 否则已取消的请求仍会烧满 num_predict 个 token。
                                    checked_chunks += 1
                                    if checked_chunks % 16 == 0 and await request.is_disconnected():
                                        logger.info("客户端已断开，提前中止模型生成")
                                        full = ""
                                        return
                                    for line in event.splitlines():
                                        if not line.startswith("data:"):
                                            continue
                                        payload = line[5:].strip()
                                        if payload == "[DONE]":
                                            continue
                                        try:
                                            data = json.loads(payload)
                                        except (TypeError, ValueError):
                                            continue
                                        if data.get("error"):
                                            for_event_errors = True
                                            logger.warning("Ollama 返回错误: %s", data["error"])
                                        part = data.get("content", "")
                                        if part:
                                            full += part
                            finally:
                                await upstream.aclose()
                            candidate = llm_stub.finalize_model_answer(
                                message, full, evidence, report_context=report_context,
                                allow_scope_fallback=not follow_up,
                                history_note=previous_assistant,
                            )
                            # 报告上下文绑定期间，连续追问同一报告的答案天然高度相似
                            # （都在引用同一份快照），复读门禁会把新事实误判为复读，
                            # 因此仅在无报告上下文的普通聊天中启用该替换。
                            if (
                                not report_context
                                and llm_stub.is_near_duplicate_answer(candidate, previous_assistant)
                            ):
                                logger.warning("模型答案与上一轮高度重复，使用追问说明")
                                candidate = llm_stub.duplicate_follow_up_response(message)
                            if for_event_errors or candidate != llm_stub._strip_think(full):
                                # 质量门禁拒绝的内容不会先泄漏到 UI；统一改用确定性回答或知识库兜底。
                                if full:
                                    logger.warning("Ollama 输出未通过质量门禁，改用知识库/规则兜底")
                            else:
                                used_ollama = True
                            full = candidate
                            # 无论来自模型还是兜底，都从完整答案按短句输出，保持统一的流式体验。
                            async for chunk in llm_stub.stream_text(full):
                                yield _sse(chunk)
                            used_ollama = True
                    except Exception as exc:
                        logger.warning("Ollama 对话失败，使用安全兜底: %s", exc)
                        full = ""
                if not used_ollama:
                    async for chunk in llm_stub.generate_chat_stream(
                        message,
                        report_context=report_context,
                        allow_scope_fallback=not follow_up,
                        history_note=previous_assistant,
                    ):
                        full += chunk
                        yield _sse(chunk)
        except Exception:
            # 不让异常静默中断 SSE：给出错误事件后再收尾，前端才能停止等待。
            logger.exception("对话流处理异常")
            full = ""
            try:
                yield _sse_error("对话服务暂时不可用，请稍后重试")
            except Exception:
                pass
        finally:
            # 无论正常结束还是客户端中途断开（切页/刷新/停止），都把已生成的回答落库，
            # 保证“思考中离开再回来”时历史里仍有完整回答；主动中止的请求不落残句。
            if full:
                try:
                    save_db = SessionLocal()
                    try:
                        save_db.add(ChatHistory(user_id=user_id, session_id=session_id, role=ChatRole.assistant, content=full))
                        save_db.commit()
                    finally:
                        save_db.close()
                except Exception:
                    logger.exception("对话记录落库失败")
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/chat/suggestions")
async def chat_suggestions(
    context: str = "",
    session_id: str | None = None,
    limit: int = 3,
    current_user: User = Depends(require_permission("assistant")),
    db: Session = Depends(get_db),
):
    """证据锚定的"建议追问"：只下发 suggestion_index 内、知识库确实能答的问题。

    - 检索命中的文档用于加重排序（hit_docs），检索不可用时退化为纯关键词匹配；
    - 同会话已问过的问题自动排除；
    - 凑不满 limit 就少给甚至返回空数组——宁可不展示，也不能重新引入超纲问题。
    """
    context = (context or "").strip()
    if not context:
        return []
    limit = max(1, min(int(limit or 3), 5))

    asked_questions: list[str] = []
    if session_id:
        rows = (
            db.query(ChatHistory.content)
            .filter(
                ChatHistory.session_id == session_id,
                ChatHistory.user_id == current_user.id,
                ChatHistory.role == ChatRole.user,
            )
            .order_by(ChatHistory.id.desc())
            .limit(40)
            .all()
        )
        asked_questions = [row[0] for row in rows if row[0]]

    hit_docs: list[str] = []
    svc = _get_ollama_service()
    if svc is not None and getattr(svc, "rag", None) is not None:
        try:
            _, results = await asyncio.to_thread(svc.rag.retrieve, context, 4)
            hit_docs = [str(item.get("source") or "") for item in results if item.get("source")]
        except Exception:
            logger.debug("建议追问检索加权失败，忽略命中文档", exc_info=True)
    elif not hit_docs:
        # Ollama/RAG 未就绪时退化到本地词法检索，仍能给排序加权。
        try:
            from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever

            items = await asyncio.to_thread(lambda: LocalKnowledgeRetriever().search(context, 3)) or []
            for item in items:
                source = str((item.get("metadata") or {}).get("source") or "")
                if source:
                    hit_docs.append(Path(source).name)
        except Exception:
            pass

    items = llm_stub.suggest_adjacent_questions(
        context, limit=limit, asked_questions=asked_questions, hit_docs=hit_docs
    )
    return [{"question": item["question"], "sourceDoc": item["sourceDoc"]} for item in items]


@router.get("/chat/history", response_model=list[ChatMessage])
async def chat_history(session_id: str | None = None, current_user: User = Depends(require_permission("assistant")), db: Session = Depends(get_db)):
    query = db.query(ChatHistory).filter(ChatHistory.user_id == current_user.id)
    if session_id:
        query = query.filter(ChatHistory.session_id == session_id)
    rows = query.order_by(ChatHistory.id.asc()).all()
    return [ChatMessage(role=r.role.value, content=r.content) for r in rows]
