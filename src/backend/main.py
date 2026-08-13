"""
海洋守护者 FastAPI 后端主入口
=====================================
由 test/ 的完整后端迁移而来，作为 React 前端（src/frontend）的真实后端。
SSR 管理页面由 React SPA 取代，故不再挂载 pages_router / templates。

启动方式（二选一）：
    cd src/backend && uvicorn main:app --reload --port 8000
    或 从项目根  uvicorn src.backend.main:app --reload --port 8000

浏览器：
    http://127.0.0.1:8000/docs   Swagger API 文档
    http://127.0.0.1:5173        React 前端（npm run dev，/api 代理到 8000）
"""

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# 将项目根与后端目录加入 Python 路径：
#   - 项目根  → 允许 `from src.LLM.chat_api import ...`（Ollama 对话混合模式）
#   - 后端目录 → 允许平铺导入 `import config / from models import ...`
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
for _p in (str(PROJECT_ROOT), str(BACKEND_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
import config  # noqa: E402
import models  # noqa: F401  E402  导入全部模型，注册到 Base.metadata 才能建表
from auth import hash_password  # noqa: E402
from database import Base, SessionLocal, engine, ensure_database_exists, ensure_login_session_platform_column  # noqa: E402
from routers import (  # noqa: E402
    auth_router,
    chat_router,
    detect_router,
    digital_human_router,
    knowledge_router,
    reports_router,
    stats_router,
)


def _migrate_legacy_users(db):
    """兼容旧版 users 表：补齐新列并迁移明文密码 → bcrypt 哈希。"""
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("users")}

    if "password" in cols and "password_hash" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL"))
    if "email" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(100) NULL"))
    if "phone_num" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN phone_num VARCHAR(20) NULL"))
    if "role" not in cols:
        db.execute(
            text("ALTER TABLE users ADD COLUMN role ENUM('admin','user') NOT NULL DEFAULT 'user'")
        )
    if "created_at" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN created_at DATETIME NULL"))
    if "updated_at" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN updated_at DATETIME NULL"))

    if "password" in cols:
        rows = db.execute(
            text("SELECT id, password FROM users WHERE password_hash IS NULL")
        ).fetchall()
        for uid, raw in rows:
            if raw and not raw.startswith("$2"):
                db.execute(
                    text("UPDATE users SET password_hash = :h WHERE id = :i"),
                    {"h": hash_password(raw), "i": uid},
                )
        db.execute(text("ALTER TABLE users DROP COLUMN password"))

    db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动：建目录 → 建库建表 → 迁移旧数据 → 播种 admin → 预热 Ollama"""
    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    os.makedirs("reports", exist_ok=True)

    ensure_database_exists()
    Base.metadata.create_all(bind=engine)
    ensure_login_session_platform_column()

    db = SessionLocal()
    try:
        _migrate_legacy_users(db)
        admin = db.query(models.User).filter(models.User.username == "admin").first()
        if admin is None:
            db.add(
                models.User(
                    username="admin",
                    password_hash=hash_password("123456"),
                    role=models.UserRole.admin,
                )
            )
            db.commit()
        else:
            if not admin.password_hash or admin.role != models.UserRole.admin:
                admin.password_hash = admin.password_hash or hash_password("123456")
                admin.role = models.UserRole.admin
                db.commit()
    finally:
        db.close()

    # 预热 Ollama 对话服务（不可用则回退存根，不影响启动）
    try:
        chat_router._get_ollama_service()
    except Exception:
        pass

    yield


# ============ 创建应用 ============
app = FastAPI(
    title="海洋守护者 API（水下垃圾自动识别与海洋污染分析系统）",
    description="认证 / 检测 / 统计 / 对话 / 报告 / 知识库 / 数字人",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS：开发环境前端经 Vite 代理（同源）无需跨域，放开便于绕过代理直连 / 本地调试
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ 挂载 API 路由 ============
app.include_router(auth_router.router)           # /login /register /logout /captcha /api/v1/auth/*
app.include_router(detect_router.router)         # /api/v1/detect/* + /api/v1/detections
app.include_router(chat_router.router)           # /api/v1/chat (SSE) /api/v1/chat/history
app.include_router(stats_router.router)          # /api/v1/stats/*
app.include_router(reports_router.router)        # /api/v1/reports/*
app.include_router(knowledge_router.router)      # /api/v1/knowledge/*
app.include_router(digital_human_router.router)  # /api/v1/digital-human/*

# ============ 静态文件：上传产物（图片/视频/视频预览帧）同源访问 ============
# 挂载 /uploads → config.UPLOAD_DIR（默认 uploads/，相对 cwd=src/backend），
# 使 /uploads/video_preview/{task_id}.jpg 等 URL 可直接被 <img> 加载。
_UPLOADS_ABS = os.path.abspath(config.UPLOAD_DIR)
os.makedirs(_UPLOADS_ABS, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_UPLOADS_ABS), name="uploads")


@app.get("/")
async def root():
    return {
        "service": "海洋守护者 API",
        "version": "0.1.0",
        "docs": "/docs",
        "frontend": "http://localhost:5173 (npm run dev)",
    }


# ============ 入口 ============
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
