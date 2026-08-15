"""后端配置（MySQL / JWT / 上传 / RAG / Ollama）。"""

import os
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _env_bool(key: str, default: bool) -> bool:
    value = os.getenv(key)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


# MySQL
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "123456")
DB_NAME = os.getenv("DB_NAME", "fastapi_login")


DATABASE_URL = (
    f"mysql+pymysql://{quote_plus(DB_USER)}:{quote_plus(DB_PASSWORD)}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
)

# JWT
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "fastapi-learning-jwt-secret-change-me")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "8"))
# 「保持登录」勾选时签发的长有效期 token（天）：跨浏览器重启自动登录，直到用户退出
JWT_REMEMBER_DAYS = int(os.getenv("JWT_REMEMBER_DAYS", "30"))

# 同一账号在同一平台(pc/mobile)的最大并发登录数（按角色）：
# 同平台超限踢掉最早会话；跨平台(PC ↔ 移动端)互不挤占，便于移动端观察 PC 端进度。
# platform 由官方客户端登录时声明(PC=pc / 移动端=mobile)并据此分组限流：
# 面向协作式官方客户端，不构成对抗「多账号共享」的强保证(强保证需设备绑定)。
MAX_CONCURRENT_SESSIONS = {"admin": 3, "user": 1}

# 文件上传
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")

# RAG：默认打开，保证每次海洋问题都优先走知识库
RAG_ENABLED = _env_bool("RAG_ENABLED", True)
RAG_TOP_K = max(1, int(os.getenv("RAG_TOP_K", "5")))
KNOWLEDGE_DIR = str(PROJECT_ROOT / os.getenv("KNOWLEDGE_DIR", "data/knowledge"))
CHROMA_DIR = str(PROJECT_ROOT / os.getenv("CHROMA_DIR", "data/chroma_db"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")

# Ollama：统一唯一模型配置，移除 ocean-assistant/qwen2 旧默认值
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "deepseek-r1:1.5b")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.2"))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "1024"))
LLM_KEEP_ALIVE = os.getenv("LLM_KEEP_ALIVE", "10m")
LLM_TIMEOUT_SECONDS = float(os.getenv("LLM_TIMEOUT_SECONDS", "120"))

# YOLO
YOLO_MODEL_PATH = os.getenv("YOLO_MODEL_PATH", str(PROJECT_ROOT / "src" / "vision" / "best.pt"))
YOLO_CONF = float(os.getenv("YOLO_CONF", "0.25"))
YOLO_DEVICE = os.getenv("YOLO_DEVICE") or None
