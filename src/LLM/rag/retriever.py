"""海洋环保知识检索器（向量库适配器）。"""
from typing import List, Dict, Optional


class OceanRetriever:
    def __init__(self, knowledge_base):
        self.kb = knowledge_base
        self.k = 5

    def search(self, query: str, k: Optional[int] = None) -> List[Dict]:
        limit = k or self.k
        # LangChain 的普通 ``retriever.invoke`` 只返回文档，不带相似度，
        # 这会让上层无法区分强证据和“碰巧同词”的片段。优先调用 Chroma
        # 的带相关性分数接口；旧版/测试替身没有该接口时再退回原路径。
        vector_store = getattr(self.kb, "vector_store", None)
        if vector_store is not None and hasattr(vector_store, "similarity_search_with_relevance_scores"):
            try:
                pairs = vector_store.similarity_search_with_relevance_scores(query, k=limit)
                results: List[Dict] = []
                for doc, score in pairs:
                    metadata = dict(getattr(doc, "metadata", {}) or {})
                    try:
                        normalized_score = float(score)
                    except (TypeError, ValueError):
                        normalized_score = metadata.get("score")
                    results.append({
                        "content": str(getattr(doc, "page_content", "") or ""),
                        "metadata": metadata,
                        "score": normalized_score,
                    })
                return results
            except Exception:
                # 兼容旧 Chroma、简化测试替身和没有持久化集合的开发环境。
                pass
        retriever = self.kb.get_retriever(limit)
        docs = retriever.invoke(query)
        return [
            {
                "content": d.page_content,
                "metadata": dict(d.metadata or {}),
                "score": (d.metadata or {}).get("score"),
            }
            for d in docs
        ]

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
