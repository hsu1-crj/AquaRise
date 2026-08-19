"""海洋环保知识库构建（Chroma + BGE，可选依赖）。"""
import html as html_lib
import re
from pathlib import Path
from typing import List, Optional

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings

# 剥掉 script/style 与标签，保留报告正文文本（系统生成的 HTML 报告结构简单，正则足够）
_TAG_RE = re.compile(r"<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<[^>]+>", re.I | re.S)
_WS_RE = re.compile(r"[ \t\u3000]+")


class HtmlTextLoader:
    """把 HTML 文件转成纯文本 Document（metadata.source 与 TextLoader 一致）。"""

    def __init__(self, path: str, encoding: str = "utf-8"):
        self.path = str(path)
        self.encoding = encoding

    def load(self) -> List[Document]:
        with open(self.path, encoding=self.encoding, errors="ignore") as f:
            raw = f.read()
        text = html_lib.unescape(_TAG_RE.sub("", raw))
        text = _WS_RE.sub(" ", text)
        text = re.sub(r"\n\s*\n+", "\n", text).strip()
        if not text:
            return []
        return [Document(page_content=text, metadata={"source": self.path})]


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
        for pattern, cls, kwargs in (
            ("*.md", TextLoader, {"encoding": "utf-8"}),
            ("*.txt", TextLoader, {"encoding": "utf-8"}),
            ("*.html", HtmlTextLoader, {"encoding": "utf-8"}),
            ("*.pdf", PyPDFLoader, {}),
        ):
            for path in sorted(self.knowledge_dir.glob(pattern)):
                try:
                    documents.extend(cls(str(path), **kwargs).load())
                except Exception as exc:
                    print(f"加载文档 {path} 失败: {exc}")
        return documents

    def _split_file(self, file_path: str) -> List[Document]:
        """按扩展名加载单个文件并分块，返回带 source 元数据的分片。"""
        ext = Path(file_path).suffix.lower()
        if ext == ".pdf":
            chunks = PyPDFLoader(file_path).load()
        elif ext == ".html":
            chunks = HtmlTextLoader(file_path).load()
        else:
            chunks = TextLoader(file_path, encoding="utf-8").load()
        for chunk in chunks:
            chunk.metadata["source"] = str(file_path)
        return self.text_splitter.split_documents(chunks)

    def add_document(self, file_path: str) -> int:
        """把单个文件增量加入向量库，返回分片数（幂等：同源分片先删除再写入）。"""
        file_path = str(file_path)
        chunks = self._split_file(file_path)
        if not chunks:
            return 0
        self.remove_document(file_path)
        if self.vector_store is None:
            self.build()
        self.vector_store.add_documents(chunks)
        return len(chunks)

    def remove_document(self, file_path: str) -> None:
        """从向量库删除该文件的全部分片（按 source 元数据匹配）。"""
        file_path = str(file_path)
        if self.vector_store is None:
            if not self.persist_dir.exists():
                return
            self.build()
        data = self.vector_store.get()
        ids = [
            doc_id
            for doc_id, meta in zip(data.get("ids", []), data.get("metadatas", []))
            if meta and meta.get("source") == file_path
        ]
        if ids:
            self.vector_store.delete(ids=ids)

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
