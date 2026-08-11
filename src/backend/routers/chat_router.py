"""海洋守护者对话 API：优先 Ollama + RAG，失败时安全兜底。"""

import json
import logging
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
import config
from database import get_db, SessionLocal
from models import ChatHistory, ChatRole, User
from schemas import ChatMessage, SpaChatRequest
from services import llm as llm_stub

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["chat"])
_chat_service = None
_ollama_ready = False


def _get_ollama_service():
    global _chat_service, _ollama_ready
    if _ollama_ready:
        return _chat_service
    _ollama_ready = True
    try:
        from src.LLM.chat_api import chat_service
        chat_service.initialize(config.OLLAMA_URL)
        _chat_service = chat_service
    except Exception as exc:
        logger.exception("LLM 服务初始化失败")
        _chat_service = None
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


def _sse(content: str) -> str:
    return f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(body: SpaChatRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    message = _extract_user_message(body)
    if not message:
        return StreamingResponse(iter([f"data: {json.dumps({'error': '消息不能为空'}, ensure_ascii=False)}\n\n", "data: [DONE]\n\n"]), media_type="text/event-stream")

    user_id = current_user.id
    session_id = body.session_id or uuid.uuid4().hex
    db.add(ChatHistory(user_id=user_id, session_id=session_id, role=ChatRole.user, content=message))
    db.commit()

    async def event_stream():
        full = ""
        used_ollama = False
        # 身份、寒暄、范围边界和高风险常识先走确定性回答，防止 1.5B 模型胡编。
        direct = llm_stub.direct_response(message)
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
                    )
                    # 先缓冲、再通过质量门禁。DeepSeek R1 1.5B 偶尔会复述问题或输出无依据套话；
                    # 此处不能把未验证的半句直接送到 UI。通过后按短句重新流式输出，阅读节奏仍自然。
                    for_event_errors = False
                    async for event in svc.chat_stream(req):
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
                    if for_event_errors or not llm_stub.is_acceptable_model_answer(full, message):
                        if full:
                            logger.warning("Ollama 输出未通过质量门禁，改用知识库兜底")
                        full = ""
                    else:
                        used_ollama = True
                        async for chunk in llm_stub.stream_text(full):
                            yield _sse(chunk)
                except Exception as exc:
                    logger.warning("Ollama 对话失败，使用安全兜底: %s", exc)
                    full = ""
            if not used_ollama:
                async for chunk in llm_stub.generate_chat_stream(message):
                    full += chunk
                    yield _sse(chunk)

        if full:
            save_db = SessionLocal()
            try:
                save_db.add(ChatHistory(user_id=user_id, session_id=session_id, role=ChatRole.assistant, content=full))
                save_db.commit()
            finally:
                save_db.close()
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/chat/history", response_model=list[ChatMessage])
async def chat_history(session_id: str | None = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = db.query(ChatHistory).filter(ChatHistory.user_id == current_user.id)
    if session_id:
        query = query.filter(ChatHistory.session_id == session_id)
    rows = query.order_by(ChatHistory.id.asc()).all()
    return [ChatMessage(role=r.role.value, content=r.content) for r in rows]
