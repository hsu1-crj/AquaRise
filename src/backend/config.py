"""
后端配置（MySQL / JWT / 上传 / RAG / Ollama）
=====================================
- RAG、Ollama 等可从项目根 .env 覆盖（本文件优先读环境变量，缺省用下方默认值）
- 敏感字段（数字人 appSecret 等）只放 .env，不写代码
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# 项目根目录（config.py 位于 src/backend/）
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _env_bool(key: str, default: bool) -> bool:
    val = os.getenv(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


# ============ MySQL 连接配置 ============
# MySQL 服务器地址（本机通常为 localhost / 127.0.0.1）
DB_HOST = os.getenv("DB_HOST", "localhost")

# MySQL 端口，默认 3306
DB_PORT = int(os.getenv("DB_PORT", "3306"))

# 登录 MySQL 的用户名
DB_USER = os.getenv("DB_USER", "root")

# 登录 MySQL 的密码（没有密码就留空字符串 ""）
DB_PASSWORD = os.getenv("DB_PASSWORD", "123456")

# 数据库名：本项目用到的库，运行时会自动创建
DB_NAME = os.getenv("DB_NAME", "fastapi_login")

# SQLAlchemy 连接串（一般不用改）
DATABASE_URL = (
    f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
)

# ============ JWT 配置 ============
# 生产环境务必改成随机长字符串！可用：python -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET_KEY = "fastapi-learning-jwt-secret-change-me"
# JWT 签名算法与有效期（小时）
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 8

# ============ 文件上传 ============
# 上传文件（检测图片/视频、知识库文档）存放目录
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")


# ============ RAG 知识库配置 ============
# 对话 API 是否默认启用 RAG 检索增强（.env: RAG_ENABLED）
RAG_ENABLED = _env_bool("RAG_ENABLED", True)
# 每次检索返回的文档块数（.env: RAG_TOP_K）
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "4"))
# 知识文档目录与向量库目录（相对项目根，.env: KNOWLEDGE_DIR / CHROMA_DIR）
KNOWLEDGE_DIR = str(PROJECT_ROOT / os.getenv("KNOWLEDGE_DIR", "data/knowledge"))
CHROMA_DIR = str(PROJECT_ROOT / os.getenv("CHROMA_DIR", "data/chroma_db"))


# ============ Ollama 本地推理配置 ============
# 对话优先调用本地 Ollama（.env: OLLAMA_URL）
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")


# ============ YOLO 检测模型配置 ============
# 水下垃圾检测权重路径（.env: YOLO_MODEL_PATH，默认 src/vision/best.pt）
YOLO_MODEL_PATH = os.getenv(
    "YOLO_MODEL_PATH", str(PROJECT_ROOT / "src" / "vision" / "best.pt")
)
# 检测置信度阈值（.env: YOLO_CONF）
YOLO_CONF = float(os.getenv("YOLO_CONF", "0.25"))
# 推理设备（.env: YOLO_DEVICE，如 "0"/"cpu"/"mps"；空串 → None → ultralytics 自动选 CPU/GPU）
YOLO_DEVICE = os.getenv("YOLO_DEVICE") or None
