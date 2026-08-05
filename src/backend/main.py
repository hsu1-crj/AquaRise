"""
FastAPI 主应用 - 海洋守护者后端服务
启动: uvicorn src.backend.main:app --port 8000
访问: http://localhost:8000/assistant
"""
import sys
from pathlib import Path

# 将项目根目录加入Python路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
import json
import logging

from src.LLM.chat_api import ChatRequest, ChatMessage, chat_service, init_chat_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="海洋守护者 API", version="0.1.0")

# 启动时初始化对话服务
@app.on_event("startup")
async def startup():
    init_chat_service()
    logger.info("ChatService 已初始化")

# ==================== API路由 ====================

@app.post("/api/v1/chat")
async def chat(request: ChatRequest):
    """LLM对话接口（支持流式和非流式）"""
    if request.stream:
        return StreamingResponse(
            chat_service.chat_stream(request),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    return await chat_service.chat(request)


@app.get("/api/v1/models")
async def list_models():
    """可用模型列表"""
    try:
        models = await chat_service.ollama.list_models()
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


# ==================== 静态文件 ====================

static_dir = Path(__file__).resolve().parent.parent / "frontend" / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/assistant")
async def assistant_page():
    """海洋小助手页面"""
    return FileResponse(str(static_dir / "assistant.html"))


@app.get("/")
async def root():
    return {"service": "海洋守护者 API", "version": "0.1.0", "docs": "/docs"}
