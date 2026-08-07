"""
FastAPI 主应用 - 海洋守护者后端服务
启动: uvicorn src.backend.main:app --port 8000
访问: http://localhost:8000/assistant
"""
import sys
from pathlib import Path

# 将项目根目录加入Python路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import os
import threading
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
import json
import logging

from src.LLM.chat_api import ChatRequest, ChatMessage, chat_service, init_chat_service
from src.backend.config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="海洋守护者 API", version="0.1.0")

# 启动时初始化对话服务
@app.on_event("startup")
async def startup():
    init_chat_service()
    logger.info("ChatService 已初始化")
    # 后台预热 RAG 知识库：嵌入模型首次加载耗时约 10-15 秒，
    # 若在 startup 中同步执行会阻塞服务启动，导致浏览器打开页面时服务尚未就绪、
    # 数字人配置请求失败而降级为纯文本模式。改为后台线程预热，服务立即就绪，
    # RAG 在后台加载完成后即可服务对话请求；加载期间的首条对话会触发按需初始化。
    def _warmup_rag():
        try:
            chat_service.rag.initialize()
        except Exception as e:
            logger.warning(f"RAG 预热失败（将降级为纯 LLM 模式）: {e}")
    threading.Thread(target=_warmup_rag, daemon=True, name="rag-warmup").start()

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


@app.get("/api/v1/digital-human/config")
async def digital_human_config():
    """数字人 SDK 配置（appId/appSecret 从 .env 注入，不写入仓库代码）"""
    app_id = settings.DH_APP_ID
    app_secret = settings.DH_APP_SECRET
    if not app_id or not app_secret:
        return JSONResponse({
            "appId": app_id or "",
            "note": "DH_APP_ID 或 DH_APP_SECRET 环境变量未配置",
        }, status_code=200)
    return JSONResponse({
        "appId": app_id,
        "appSecret": app_secret,
    })


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
