"""海洋环保知识库构建（Chroma + BGE，可选依赖）。"""
from pathlib import Path
from typing import List, Optional

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings


class OceanKnowledgeBase:
    EMBEDDING_MODEL_NAME = "BAAI/bge-small-zh-v1.5"
    CHUNK_SIZE = 650
    CHUNK_OVERLAP = 80

    def __init__(self, knowledge_dir: Optional[str] = None, persist_dir: Optional[str] = None, embedding_model: Optional[str] = None):
        root = Path(__file__).resolve().parents[3]
        self.knowledge_dir = Path(knowledge_dir) if knowledge_dir else root / "data" / "knowledge"
        self.persist_dir = Path(persist_dir) if persist_dir else root / "data" / "chroma_db"
        self.embedding_model = embedding_model or self.EMBEDDING_MODEL_NAME
        self.embeddings = HuggingFaceEmbeddings(
            model_name=self.embedding_model, model_kwargs={"device": "cpu"}, encode_kwargs={"normalize_embeddings": True}
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.CHUNK_SIZE, chunk_overlap=self.CHUNK_OVERLAP,
            separators=["\n\n", "\n", "。", "！", "？", "；", " ", ""],
        )
        self.vector_store: Optional[Chroma] = None

    def load_documents(self) -> List:
        documents = []
        if not self.knowledge_dir.exists():
            raise FileNotFoundError(f"知识库目录不存在: {self.knowledge_dir}")
        for pattern, cls, kwargs in (("*.md", TextLoader, {"encoding": "utf-8"}), ("*.txt", TextLoader, {"encoding": "utf-8"}), ("*.pdf", PyPDFLoader, {})):
            for path in sorted(self.knowledge_dir.glob(pattern)):
                try:
                    documents.extend(cls(str(path), **kwargs).load())
                except Exception as exc:
                    print(f"加载文档 {path} 失败: {exc}")
        return documents

    def build(self, force_rebuild: bool = False) -> Chroma:
        if not force_rebuild and self.persist_dir.exists():
            self.vector_store = Chroma(persist_directory=str(self.persist_dir), embedding_function=self.embeddings, collection_name="ocean_knowledge")
            return self.vector_store
        documents = self.load_documents()
        if not documents:
            raise ValueError("知识库没有可加载文档")
        chunks = self.text_splitter.split_documents(documents)
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self.vector_store = Chroma.from_documents(chunks, self.embeddings, persist_directory=str(self.persist_dir), collection_name="ocean_knowledge")
        return self.vector_store

    def get_retriever(self, k: int = 5):
        if self.vector_store is None:
            self.build()
        return self.vector_store.as_retriever(search_type="similarity", search_kwargs={"k": k})
