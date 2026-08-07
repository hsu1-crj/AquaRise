"""
海洋环保知识库构建模块

功能:
- 加载知识文档（Markdown、PDF、TXT）
- 文档分块（RecursiveCharacterTextSplitter）
- 向量化存储（ChromaDB + Sentence Transformers）
"""

import os
from pathlib import Path
from typing import List, Optional

from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import (
    TextLoader,
    UnstructuredMarkdownLoader,
    PyPDFLoader,
    DirectoryLoader,
)
from langchain_chroma import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings

from src.backend.config import settings


class OceanKnowledgeBase:
    """水下垃圾与海洋环保知识库"""

    # 中文嵌入模型
    EMBEDDING_MODEL_NAME = "BAAI/bge-small-zh-v1.5"

    # 分块参数
    CHUNK_SIZE = 500
    CHUNK_OVERLAP = 50

    def __init__(
        self,
        knowledge_dir: Optional[str] = None,
        persist_dir: Optional[str] = None,
        embedding_model: Optional[str] = None,
    ):
        """
        初始化知识库

        Args:
            knowledge_dir: 知识文档目录路径（默认读取 settings.KNOWLEDGE_DIR）
            persist_dir: ChromaDB 持久化目录（默认读取 settings.CHROMA_DIR）
            embedding_model: 嵌入模型名称
        """
        self.knowledge_dir = Path(knowledge_dir) if knowledge_dir else settings.KNOWLEDGE_DIR
        self.persist_dir = Path(persist_dir) if persist_dir else settings.CHROMA_DIR
        self.embedding_model = embedding_model or self.EMBEDDING_MODEL_NAME

        # 初始化嵌入模型
        self.embeddings = HuggingFaceEmbeddings(
            model_name=self.embedding_model,
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )

        # 初始化文本分割器
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.CHUNK_SIZE,
            chunk_overlap=self.CHUNK_OVERLAP,
            separators=["\n\n", "\n", "。", "！", "？", "；", " ", ""],
        )

        # 向量存储
        self.vector_store: Optional[Chroma] = None

    def load_documents(self) -> List:
        """加载知识库目录中的所有文档"""
        documents = []

        if not self.knowledge_dir.exists():
            raise FileNotFoundError(f"知识库目录不存在: {self.knowledge_dir}")

        # 加载不同格式的文档
        loaders = {
            "*.txt": (TextLoader, {"encoding": "utf-8"}),
            "*.md": (UnstructuredMarkdownLoader, {}),
            "*.pdf": (PyPDFLoader, {}),
        }

        for pattern, (loader_cls, kwargs) in loaders.items():
            files = list(self.knowledge_dir.glob(pattern))
            for file_path in files:
                try:
                    loader = loader_cls(str(file_path), **kwargs)
                    documents.extend(loader.load())
                except Exception as e:
                    print(f"加载文档 {file_path} 失败: {e}")

        print(f"共加载 {len(documents)} 个文档")
        return documents

    def build(self, force_rebuild: bool = False) -> Chroma:
        """
        构建或加载知识库向量存储

        Args:
            force_rebuild: 是否强制重建

        Returns:
            Chroma 向量存储实例
        """
        if not force_rebuild and self.persist_dir.exists():
            print(f"加载已有向量库: {self.persist_dir}")
            self.vector_store = Chroma(
                persist_directory=str(self.persist_dir),
                embedding_function=self.embeddings,
                collection_name="ocean_knowledge",
            )
            return self.vector_store

        # 加载并分块文档
        documents = self.load_documents()
        if not documents:
            raise ValueError(f"知识库目录 {self.knowledge_dir} 中未找到任何文档")

        chunks = self.text_splitter.split_documents(documents)
        print(f"文档分块完成: 共 {len(chunks)} 个文本块")

        # 创建向量存储
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self.vector_store = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            persist_directory=str(self.persist_dir),
            collection_name="ocean_knowledge",
        )
        print(f"向量库已保存至: {self.persist_dir}")

        return self.vector_store

    def get_retriever(self, k: int = 4):
        """获取检索器（需先调用 build()）"""
        if self.vector_store is None:
            raise RuntimeError("请先调用 build() 构建/加载向量库")
        return self.vector_store.as_retriever(search_kwargs={"k": k})
