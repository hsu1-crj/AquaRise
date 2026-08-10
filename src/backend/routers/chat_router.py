"""
对话 API：海洋小助手
=====================================
POST /api/v1/chat           SSE 流式对话（兼容前端 {messages, stream} 契约）
GET  /api/v1/chat/history   对话历史

LLM 混合模式：优先调用本地 Ollama（src.LLM.chat_api.ChatService），
连接失败自动回退到 services/llm.py 关键字存根，保证开箱即用。
"""

import json
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
import config
from database import get_db
from models import ChatHistory, ChatRole, User
from schemas import ChatMessage, SpaChatRequest
from services import llm as llm_stub

router = APIRouter(prefix="/api/v1", tags=["chat"])

# Ollama 服务（惰性加载，初始化失败则为 None）
_chat_service = None
_ollama_ready = False


def _get_ollama_service():
    """惰性加载 src.LLM.chat_api.ChatService，失败返回 None（不抛异常）"""
    global _chat_service, _ollama_ready
    if _ollama_ready:
        return _chat_service
    _ollama_ready = True
    try:
        from src.LLM.chat_api import chat_service  # noqa: PLC0415
        chat_service.initialize()
        _chat_service = chat_service
    except Exception:
        _chat_service = None
    return _chat_service


def _extract_user_message(body: SpaChatRequest) -> str:
    """从前端 messages 数组取最后一条 user 消息；旧格式直接取 body.message"""
    if body.message:
        return body.message
    for msg in reversed(body.messages):
        if msg.role == "user" and msg.content.strip():
            return msg.content
    return ""


@router.post("/chat")
async def chat(
    body: SpaChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    SSE 流式对话。
    请求体（前端）：{"messages": [{"role": "user", "content": "..."}], "stream": true}
    响应：data: {"content": "<chunk>"} / 结尾 data: [DONE]
    """
    message = _extract_user_message(body)
    if not message:
        return StreamingResponse(
            iter([
                f"data: {json.dumps({'error': '消息不能为空'}, ensure_ascii=False)}\n\n",
                "data: [DONE]\n\n",
            ]),
            media_type="text/event-stream",
        )

    user_id = current_user.id
    session_id = body.session_id or uuid.uuid4().hex

    # 保存用户提问
    db.add(
        ChatHistory(
            user_id=user_id,
            session_id=session_id,
            role=ChatRole.user,
            content=message,
        )
    )
    db.commit()

    async def event_stream():
        full = ""
        svc = _get_ollama_service()
        used_ollama = False

        # 1) 优先 Ollama 真实 LLM
        if svc is not None:
            try:
                from src.LLM.chat_api import ChatMessage as OllamaMessage  # noqa: PLC0415
                from src.LLM.chat_api import ChatRequest as OllamaChatRequest  # noqa: PLC0415

                ollama_messages = [
                    OllamaMessage(role=m.role, content=m.content) for m in body.messages
                ]
                ollama_request = OllamaChatRequest(
                    messages=ollama_messages,
                    stream=True,
                    enable_rag=config.RAG_ENABLED,
                )
                async for event in svc.chat_stream(ollama_request):
                    for line in event.split("\n"):
                        if line.startswith("data:") and "[DONE]" not in line:
                            try:
                                data = json.loads(line[5:].strip())
                                full += data.get("content", "")
                            except (ValueError, TypeError):
                                pass
                    yield event
                used_ollama = True
            except Exception:
                full = ""
                used_ollama = False

        # 2) 回退：本地关键字存根
        if not used_ollama:
            async for chunk in llm_stub.generate_chat_stream(message):
                full += chunk
                yield f"data: {json.dumps({'content': chunk}, ensure_ascii=False)}\n\n"

        # 保存助手完整回复（生成器运行时请求级会话已关闭，需新建会话）
        if full:
            from database import SessionLocal

            save_db = SessionLocal()
            try:
                save_db.add(
                    ChatHistory(
                        user_id=user_id,
                        session_id=session_id,
                        role=ChatRole.assistant,
                        content=full,
                    )
                )
                save_db.commit()
            finally:
                save_db.close()
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/chat/history", response_model=list[ChatMessage])
async def chat_history(
    session_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """返回当前用户的对话历史（可按 session_id 过滤）"""
    query = db.query(ChatHistory).filter(ChatHistory.user_id == current_user.id)
    if session_id:
        query = query.filter(ChatHistory.session_id == session_id)
    rows = query.order_by(ChatHistory.id.asc()).all()
    return [ChatMessage(role=r.role.value, content=r.content) for r in rows]
