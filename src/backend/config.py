"""
集中配置管理 — 从 .env 文件和系统环境变量读取所有运行时参数。

优先级: 系统环境变量 > .env 文件 > 默认值
.env 文件由 python-dotenv 在模块导入时自动加载；
.env 仅存于本地，不提交 Git（已在 .gitignore 中排除）。

使用方法:
    from src.backend.config import settings

    settings.OLLAMA_URL       # Ollama 服务地址
    settings.DH_APP_ID        # 数字人 appId（空字符串表示未配置）
    settings.is_dh_configured # 布尔值，数字人凭据是否齐全
"""
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# 从本文件向上找三级即为项目根目录
# config.py 位于 src/backend/config.py → 根目录 = ../../../
_ROOT = Path(__file__).resolve().parent.parent.parent

# override=False: 系统中已有的环境变量不被 .env 覆盖（容器/CI 注入优先）
load_dotenv(_ROOT / ".env", override=False)

# ── HuggingFace 离线模式 ────────────────────────────────────────────
# 本机网络无法访问 huggingface.co / hf-mirror.com（连接超时）。
# RAG 嵌入模型 BAAI/bge-small-zh-v1.5 已缓存于本地，需强制离线加载，
# 否则 sentence_transformers 会在首次对话时发 HEAD 请求检查更新并反复重试，
# 导致流式响应挂死数分钟。setdefault 允许 .env / 系统变量显式覆盖。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")


@dataclass
class Settings:
    # ── 数字人 API 平台 ──────────────────────────────────────
    # 在控制台获取；DH_APP_SECRET 为高敏感字段，不得写入代码或日志
    DH_APP_ID:     str = field(default_factory=lambda: os.environ.get("DH_APP_ID", ""))
    DH_APP_SECRET: str = field(default_factory=lambda: os.environ.get("DH_APP_SECRET", ""))

    # ── Ollama 本地推理服务 ──────────────────────────────────
    OLLAMA_URL:   str = field(default_factory=lambda: os.environ.get("OLLAMA_URL",   "http://localhost:11434"))
    OLLAMA_MODEL: str = field(default_factory=lambda: os.environ.get("OLLAMA_MODEL", "ocean-assistant"))

    # ── LLM 生成参数 ─────────────────────────────────────────
    LLM_TEMPERATURE: float = field(default_factory=lambda: float(os.environ.get("LLM_TEMPERATURE", "0.7")))
    LLM_MAX_TOKENS:  int   = field(default_factory=lambda: int(  os.environ.get("LLM_MAX_TOKENS",  "2048")))

    # ── RAG 知识库 ───────────────────────────────────────────
    RAG_ENABLED:     bool  = field(default_factory=lambda: os.environ.get("RAG_ENABLED", "true").lower() == "true")
    RAG_TOP_K:       int   = field(default_factory=lambda: int(os.environ.get("RAG_TOP_K", "4")))
    EMBEDDING_MODEL: str   = field(default_factory=lambda: os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"))
    KNOWLEDGE_DIR:   Path  = field(default_factory=lambda: _ROOT / os.environ.get("KNOWLEDGE_DIR", "data/knowledge"))
    CHROMA_DIR:      Path  = field(default_factory=lambda: _ROOT / os.environ.get("CHROMA_DIR",    "data/chroma_db"))

    # ── FastAPI 服务 ─────────────────────────────────────────
    APP_HOST: str = field(default_factory=lambda: os.environ.get("APP_HOST", "0.0.0.0"))
    APP_PORT: int = field(default_factory=lambda: int(os.environ.get("APP_PORT", "8000")))

    @property
    def is_dh_configured(self) -> bool:
        """数字人凭据是否齐全（appId 和 appSecret 均非空）"""
        return bool(self.DH_APP_ID and self.DH_APP_SECRET)


# 全局单例 — 应用内所有模块均从此处导入
settings = Settings()
