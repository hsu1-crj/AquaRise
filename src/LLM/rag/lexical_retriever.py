"""无第三方向量依赖时的本地中文词法 RAG。

它不是模型替代品，而是保证开发机缺少 Chroma/Embedding 依赖时，
知识库仍能被实际检索和注入 Ollama。
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Dict, List, Optional

_CJK = re.compile(r"[\u4e00-\u9fff]")
_WORD = re.compile(r"[A-Za-z0-9_+#.-]+")
MIN_RELEVANCE_SCORE = 0.10


def _terms(text: str) -> set[str]:
    chars = "".join(_CJK.findall(text))
    terms = set(_WORD.findall(text.lower()))
    for n in (2, 3, 4):
        terms.update(chars[i:i+n] for i in range(max(0, len(chars)-n+1)))
    return terms


class LocalKnowledgeRetriever:
    def __init__(self, knowledge_dir: Optional[str] = None):
        root = Path(__file__).resolve().parents[3]
        self.knowledge_dir = Path(knowledge_dir or root / "data" / "knowledge")
        self.chunks: List[Dict] = []
        self._load()

    def _load(self) -> None:
        self.chunks.clear()
        for path in sorted(self.knowledge_dir.glob("*.md")) + sorted(self.knowledge_dir.glob("*.txt")) + sorted(self.knowledge_dir.glob("*.html")):
            text = path.read_text(encoding="utf-8", errors="ignore")
            if path.suffix.lower() == ".html":
                # 与向量链路一致：剥掉标签再分词，避免把 HTML 标签当成检索词
                text = re.sub(r"<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<[^>]+>", "", text, flags=re.I | re.S)
                text = re.sub(r"[ \t\u3000]+", " ", text)
            # 以标题/段落为边界，避免跨主题拼接。
            raw_parts = re.split(r"(?=^#{1,3}\s)", text, flags=re.M)
            for part in raw_parts:
                part = part.strip()
                if not part:
                    continue
                for start in range(0, len(part), 900):
                    chunk = part[start:start + 1050].strip()
                    if len(chunk) >= 25:
                        self.chunks.append({"content": chunk, "source": path.name, "terms": _terms(chunk)})

    def search(self, query: str, k: int = 5) -> List[Dict]:
        q_terms = _terms(query)
        if not q_terms:
            return []
        scored = []
        action_query = bool(re.search(r"治理|措施|处理|清理|怎么做|如何|建议|流程", query))
        action_terms = ("源头", "减量", "拦截", "清理", "回收", "复测", "监测", "记录", "评估", "管理")
        for item in self.chunks:
            overlap = len(q_terms & item["terms"])
            phrase = sum(1 for t in q_terms if len(t) > 2 and t in item["content"])
            title_overlap = len(q_terms & _terms(Path(item["source"]).stem))
            score = (
                overlap / math.sqrt(max(1, len(item["terms"])))
                + phrase * 0.04
                + title_overlap * 0.12
            )
            if action_query:
                score += sum(0.18 for term in action_terms if term in item["content"])
            if len(item["content"]) < 90:
                score *= 0.7
            # 过滤仅由常见汉字或偶然词命中的弱相关片段，防止把“天气”等问题
            # 错误注入海洋治理文档，诱发小模型答非所问。
            if score >= MIN_RELEVANCE_SCORE:
                scored.append((score, item))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [{"content": x[1]["content"], "metadata": {"source": x[1]["source"]}, "score": round(x[0], 4)} for x in scored[:k]]

    def format_context(self, query: str, k: int = 5) -> str:
        results = self.search(query, k)
        if not results:
            return ""
        return "以下是本项目知识库的相关证据（仅供当前问题使用）：\n\n" + "\n\n".join(
            f"[证据{i}] 来源：{r['metadata']['source']}\n{r['content']}" for i, r in enumerate(results, 1)
        )

    def retrieve_for_llm(self, query: str, k: Optional[int] = None):
        results = self.search(query, k or 5)
        if not results:
            return "", []
        context = "以下是本项目知识库的相关证据（仅供当前问题使用）：\n\n" + "\n\n".join(
            f"[证据{i}] 来源：{r['metadata']['source']}\n{r['content']}"
            for i, r in enumerate(results, 1)
        )
        return context, results
