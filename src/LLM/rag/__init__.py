"""RAG 模块。向量依赖缺失时仍可直接使用 lexical_retriever。"""

try:
    from .knowledge_base import OceanKnowledgeBase
    from .retriever import OceanRetriever
except ImportError:  # 开发机未安装可选向量依赖
    OceanKnowledgeBase = None
    OceanRetriever = None

from .lexical_retriever import LocalKnowledgeRetriever

__all__ = ["OceanKnowledgeBase", "OceanRetriever", "LocalKnowledgeRetriever"]
