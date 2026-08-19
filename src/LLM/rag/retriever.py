"""海洋环保知识检索器（向量库适配器）。"""
from typing import List, Dict, Optional


class OceanRetriever:
    def __init__(self, knowledge_base):
        self.kb = knowledge_base
        self.k = 5

    def search(self, query: str, k: Optional[int] = None) -> List[Dict]:
        retriever = self.kb.get_retriever(k or self.k)
        docs = retriever.invoke(query)
        return [{"content": d.page_content, "metadata": d.metadata, "score": d.metadata.get("score")} for d in docs]

    def format_context(self, query: str, k: Optional[int] = None) -> str:
        results = self.search(query, k)
        if not results:
            return ""
        return "以下是本项目知识库的相关证据：\n\n" + "\n\n".join(
            f"[证据{i}] 来源：{r['metadata'].get('source', '未知')}\n{r['content']}" for i, r in enumerate(results, 1)
        )

    def retrieve_for_llm(self, query: str, k: Optional[int] = None):
        results = self.search(query, k)
        if not results:
            return "", []
        context = "以下是本项目知识库的相关证据：\n\n" + "\n\n".join(
            f"[证据{i}] 来源：{r['metadata'].get('source', '未知')}\n{r['content']}"
            for i, r in enumerate(results, 1)
        )
        return context, results
