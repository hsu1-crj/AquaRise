"""海洋守护者对话 API：优先 Ollama + RAG，失败时安全兜底。"""

import json
import logging
import os
import time
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
import config
from database import get_db, SessionLocal
from models import ChatHistory, ChatRole, KnowledgeDoc, Report, ReportAnalysis, User, UserRole
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
    if not any(m["role"] == "user" for m in items):
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
        if current_user.role != UserRole.admin and report.user_id != current_user.id:
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
        parts.append(
            f"报告 ID：RPT-{report.id}\n"
            f"报告摘要：{report.summary or '暂无摘要'}\n"
            f"报告类型：{getattr(report.report_type, 'value', report.report_type) or 'unknown'}\n"
            f"结构化分析快照：\n{analysis_text or '该报告尚未完成结构化分析，请明确说明。'}"
        )
    if body.document_id:
        doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.id == body.document_id).first()
        if not doc:
            raise HTTPException(status_code=404, detail="导入文档不存在")
        if current_user.role != UserRole.admin and doc.uploaded_by not in {None, current_user.id}:
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


def _sse(content: str) -> str:
    return f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"


def _sse_error(message: str) -> str:
    return f"data: {json.dumps({'error': message}, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(body: SpaChatRequest, request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    message = _extract_user_message(body)
    if not message:
        return StreamingResponse(iter([f"data: {json.dumps({'error': '消息不能为空'}, ensure_ascii=False)}\n\n", "data: [DONE]\n\n"]), media_type="text/event-stream")

    user_id = current_user.id
    session_id = body.session_id or uuid.uuid4().hex
    report_context = _build_report_context(body, current_user, db)
    db.add(ChatHistory(user_id=user_id, session_id=session_id, role=ChatRole.user, content=message))
    db.commit()

    async def event_stream():
        full = ""
        used_ollama = False
        try:
            # 身份、寒暄、范围边界和高风险常识先走确定性回答，防止 1.5B 模型胡编。
            # 选中报告/导入文档后，必须让请求进入带上下文的模型链路；
            # 否则同一问题可能被通用 direct_response 提前回答，追问就无法真正基于当前报告。
            # 请求显式绑定报告/文档时，平台功能规则不得抢答；即使上下文暂时为空，
            # 也必须保留绑定语义并进入报告/文档链路。
            direct = None if (body.report_id or body.document_id) else llm_stub.direct_response(message)
            if direct:
                async for chunk in llm_stub.generate_chat_stream(message):
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
                        prepared_messages, evidence = svc.prepare_messages(req)
                        # 强相关的报告/法规/检测事实直接使用已排序、带来源的证据，
                        # 避免让 1.5B 模型生成后再被引用门禁拦截，端到端控制在秒级。
                        grounded = None
                        if not report_context and llm_stub.is_strong_evidence_question(message, evidence):
                            grounded = llm_stub._knowledge_fallback(message, evidence)
                        if grounded:
                            full = grounded
                            async for chunk in llm_stub.stream_text(full):
                                yield _sse(chunk)
                            used_ollama = True
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
                                message, full, evidence, report_context=report_context
                            )
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
                        message, report_context=report_context
                    ):
                        full += chunk
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


@router.get("/chat/history", response_model=list[ChatMessage])
async def chat_history(session_id: str | None = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(ChatHistory).filter(ChatHistory.user_id == current_user.id)
    if session_id:
        query = query.filter(ChatHistory.session_id == session_id)
    rows = query.order_by(ChatHistory.id.asc()).all()
    return [ChatMessage(role=r.role.value, content=r.content) for r in rows]
