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
MAX_RESULTS_PER_SOURCE = 2
_GENERIC_TERMS = {
    "海洋", "海岸", "海滩", "海水", "海域", "问题", "怎么", "如何", "什么", "这个", "那个",
    "相关", "方面", "可以", "应该", "需要", "进行", "一下", "变成", "成为", "守护者", "告诉",
}
_NOISE_CHARS = set("怎么如何这个那个变成成为守护者告诉以及是否请问和的了呢吗")
_SIGNAL_TERMS = {
    "垃圾", "塑料", "塑料袋", "微塑料", "渔网", "渔具", "珊瑚", "鲸鱼", "海豚", "鲨鱼", "生态",
    "检测", "识别", "置信度", "报告", "污染", "清理", "打捞", "回收", "样方", "样带", "声呐",
    "传感器", "无人艇", "usv", "rov", "rfid", "pops", "富集", "食物链", "洋流", "潮汐", "碳汇",
    "巡航", "拦截", "监测", "复测", "降级", "风险标注", "作业", "切割", "微创", "网格", "抽检",
}


def _terms(text: str) -> set[str]:
    chars = "".join(_CJK.findall(text))
    terms = set(_WORD.findall(text.lower()))
    for n in (2, 3, 4):
        terms.update(chars[i:i+n] for i in range(max(0, len(chars)-n+1)))
    return terms


def _substantive_terms(text: str) -> set[str]:
    terms = _terms(text)
    signal_terms = {term for term in _SIGNAL_TERMS if term in text.lower()}
    return {
        term for term in terms
        if term not in _GENERIC_TERMS
        and (term in signal_terms or not any(char in _NOISE_CHARS for char in term))
    }


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
        q_substantive_terms = _substantive_terms(query)
        scored = []
        query_has_cjk = bool(_CJK.search(query))
        query_has_identifier = bool(_WORD.search(query))
        action_query = bool(re.search(r"治理|措施|处理|清理|怎么做|如何|建议|流程", query))
        action_terms = ("源头", "减量", "拦截", "清理", "回收", "复测", "监测", "记录", "评估", "管理")
        for item in self.chunks:
            overlap = len(q_terms & item["terms"])
            # 至少命中一个非泛化主题词，避免“海洋/问题”等常见词把无关段落抬进 Top-K。
            substantive_overlap = len(q_substantive_terms & _substantive_terms(item["content"]))
            if q_substantive_terms and substantive_overlap == 0:
                continue
            phrase = sum(1 for t in q_terms if len(t) > 2 and t in item["content"])
            title_overlap = len(q_terms & _terms(Path(item["source"]).stem))
            score = (
                overlap / math.sqrt(max(1, len(item["terms"])))
                + phrase * 0.04
                + title_overlap * 0.12
            )
            if action_query:
                score += sum(0.18 for term in action_terms if term in item["content"])
            # 英文类别标识是检测字段，不应压过中文语义问题；只有标识命中时轻微降权。
            if query_has_cjk and query_has_identifier and overlap and not any(
                term in item["content"] for term in q_terms if _CJK.search(term)
            ):
                score *= 0.82
            if len(item["content"]) < 90:
                score *= 0.7
            # 过滤仅由常见汉字或偶然词命中的弱相关片段，防止把“天气”等问题
            # 错误注入海洋治理文档，诱发小模型答非所问。
            if score >= MIN_RELEVANCE_SCORE:
                scored.append((score, item))
        scored.sort(key=lambda x: x[0], reverse=True)
        results = []
        source_counts: dict[str, int] = {}
        for score, item in scored:
            source = item["source"]
            if source_counts.get(source, 0) >= MAX_RESULTS_PER_SOURCE:
                continue
            results.append({
                "content": item["content"],
                "metadata": {"source": source},
                "score": round(score, 4),
            })
            source_counts[source] = source_counts.get(source, 0) + 1
            if len(results) >= k:
                break
        return results

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
