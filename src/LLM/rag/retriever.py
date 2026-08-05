"""
海洋环保知识检索器

功能:
- 语义相似度检索
- 检索结果格式化
- 与LLM对话进行上下文拼接
"""

from typing import List, Dict, Optional

from langchain_core.documents import Document


class OceanRetriever:
    """海洋环保知识检索器"""

    def __init__(self, knowledge_base):
        """
        初始化检索器

        Args:
            knowledge_base: OceanKnowledgeBase 实例（需已调用 build()）
        """
        self.kb = knowledge_base
        self.k = 4  # 默认返回 top-4 文档片段

    def search(self, query: str, k: Optional[int] = None) -> List[Dict]:
        """
        检索相关知识片段

        Args:
            query: 查询文本
            k: 返回结果数量

        Returns:
            [{"content": "...", "metadata": {...}, "score": 0.92}, ...]
        """
        retriever = self.kb.get_retriever(k or self.k)
        docs = retriever.invoke(query)

        results = []
        for doc in docs:
            results.append({
                "content": doc.page_content,
                "metadata": doc.metadata,
                "score": doc.metadata.get("score", None),
            })

        return results

    def format_context(self, query: str, k: Optional[int] = None) -> str:
        """
        检索并格式化为 LLM 上下文

        Args:
            query: 查询文本
            k: 返回结果数量

        Returns:
            格式化后的上下文字符串，可直接拼接到 LLM prompt
        """
        results = self.search(query, k)

        if not results:
            return ""

        context_parts = ["以下是与问题相关的海洋环保知识:\n"]
        for i, r in enumerate(results, 1):
            source = r["metadata"].get("source", "未知来源")
            context_parts.append(f"[参考{i}] (来源: {source})\n{r['content']}\n")

        return "\n".join(context_parts)

    def retrieve_for_llm(
        self, query: str, k: Optional[int] = None
    ) -> tuple[str, List[Dict]]:
        """
        为LLM对话准备检索结果

        Args:
            query: 查询文本
            k: 返回结果数量

        Returns:
            (formatted_context, raw_results)
        """
        results = self.search(query, k)
        context = self.format_context(query, k)
        return context, results
