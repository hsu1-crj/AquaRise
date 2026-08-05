"""
RAG 知识库模块

基于 LangChain + ChromaDB 实现海洋环保领域的检索增强生成(RAG):
- knowledge_base.py : 知识库文档加载、分块与向量化
- retriever.py      : 检索器封装，支持语义搜索与重排序
"""

from .knowledge_base import OceanKnowledgeBase
from .retriever import OceanRetriever

__all__ = ["OceanKnowledgeBase", "OceanRetriever"]
