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
    "传感器", "无人艇", "usv", "rov", "rfid", "pops", "富集", "食物链", "洋流", "潮汐", "碳汇", "蓝碳",
    "巡航", "拦截", "监测", "复测", "降级", "风险标注", "作业", "切割", "微创", "网格", "抽检",
    "pet", "pp", "hdpe", "ldpe", "聚对苯二甲酸乙二醇酯", "聚丙烯", "聚乙烯", "聚合物", "材料", "紫外", "老化", "光氧化", "水解", "耐候", "性能", "对比",
}
_SPECIAL_TERM_ALIASES = {
    "pet": ("pet", "聚对苯二甲酸乙二醇酯"),
    "pp": ("pp", "聚丙烯"),
    "hdpe": ("hdpe", "高密度聚乙烯"),
    "ldpe": ("ldpe", "低密度聚乙烯"),
    "rov": ("rov", "遥控水下机器人"),
    "aldfg": ("aldfg", "幽灵渔网", "废弃渔具"),
    "marpol": ("marpol", "附则", "防污染"),
}

_ENTITY_ALIASES = {
    "fish": ("鱼类", "鱼", "animal_fish", "鳍", "鳞", "鳃"),
    "blue_carbon": ("蓝碳", "碳汇", "红树林", "海草床", "盐沼"),
    "heavy_metals": ("重金属", "铅", "汞", "镉", "砷"),
    "rov": ("rov", "遥控水下机器人"),
}

# A lexical match only tells us that a chunk mentions the same object.  It
# does not tell us that it answers the requested *intent*.  Keep a small set
# of explicit intent profiles so short queries such as ``重金属超标怎么处理``
# prefer the monitoring/procedure paragraph over a neighbouring health-risk
# paragraph that happens to repeat ``重金属`` and ``超标``.
_INTENT_PROFILES = (
    {
        "name": "heavy_metal_health",
        "query": re.compile(
            r"人体|健康|海产品|水产品|食用|摄入|暴露|危害|风险",
            re.I,
        ),
        "entity": "heavy_metals",
        "preferred": (
            "海产品", "水产品", "摄入", "食用", "人体", "健康", "食品监管",
            "暴露", "风险", "疾病",
        ),
        "distractors": (
            "采样", "标准", "复核", "复测", "点位", "深度", "校准", "浓度",
        ),
    },
    {
        "name": "heavy_metal_disposal",
        "query": re.compile(
            r"(?:处理|怎么办|处置|复核|复测|采样|检测|监测|核对|标准|校准|异常|发现.*超标|超标.*(?:处理|怎么办|处置))",
            re.I,
        ),
        "entity": "heavy_metals",
        "preferred": (
            "采样", "标准", "复核", "复测", "检测", "监测", "浓度", "核对",
            "点位", "时间", "深度", "单位", "校准", "处置",
        ),
        "distractors": (
            "海产品", "水产品", "摄入", "食用", "人体", "健康", "食品监管",
        ),
    },
    {
        "name": "rov_operation",
        "query": re.compile(
            r"流程|安全|措施|作业|下潜|采集|回收|检查|步骤|操作|规范|标准作业|指引",
            re.I,
        ),
        "entity": "rov",
        "preferred": (
            "作业前", "下潜", "定位", "采集", "回收", "系缆", "声呐", "电量",
            "海况", "密封", "照明", "航线", "样方", "避障",
        ),
        "distractors": ("yolo", "幽灵渔网", "废弃渔具", "塑料", "垃圾分类"),
    },
    {
        "name": "fish_identification",
        "query": re.compile(
            r"识别|辨认|区分|记录|类别|分类|形态|视频|图像|拍到|拍摄",
            re.I,
        ),
        "entity": "fish",
        "preferred": (
            "形态", "鳍", "鳞", "鳃", "游动", "视频", "图像", "清晰帧", "记录", "类别",
        ),
        # ``animal_fish`` is a detector label, not an identification guide.
        "distractors": ("animal_fish", "trash_", "瓶子", "袋子", "金属罐"),
    },
    {
        "name": "blue_carbon_definition",
        "query": re.compile(r"什么是|是什么|定义|含义|指什么|介绍", re.I),
        "entity": "blue_carbon",
        "preferred": (
            "红树林", "海草床", "盐沼", "滨海湿地", "固碳", "储存", "碳储", "碳埋藏",
        ),
        "distractors": ("塑料", "微塑料", "油污", "排放", "垃圾分类"),
    },
)


def _query_entity_groups(query: str) -> list[tuple[str, ...]]:
    lowered = (query or "").lower()
    return [aliases for aliases in _ENTITY_ALIASES.values() if any(
        _contains_alias(lowered, alias) for alias in aliases
    )]


def _query_intent_profile(query: str, entity_groups: list[tuple[str, ...]] | None = None):
    """Return the narrow intent profile applicable to ``query``, if any."""
    lowered = (query or "").lower()
    groups = entity_groups if entity_groups is not None else _query_entity_groups(query)
    entity_names = {
        name for name, aliases in _ENTITY_ALIASES.items()
        if aliases in groups
    }
    matched = []
    for profile in _INTENT_PROFILES:
        if profile["entity"] not in entity_names:
            continue
        if profile["query"].search(lowered):
            matched.append(profile)
    if not matched:
        return None
    # A question can mention both a health consequence and a measurement
    # operation (for example ``检测到重金属对人体有什么危害``).  Unless it
    # explicitly asks how to remediate/recheck the result, keep the health
    # profile so the monitoring document does not drown out the exposure
    # guidance.
    health_profile = next((p for p in matched if p["name"] == "heavy_metal_health"), None)
    disposal_profile = next((p for p in matched if p["name"] == "heavy_metal_disposal"), None)
    explicit_disposal = bool(re.search(
        r"处理|怎么办|处置|复核|复测|采样|核对|校准|发现.*超标|超标.*(?:处理|怎么办|处置)",
        lowered,
        re.I,
    ))
    if disposal_profile and explicit_disposal:
        return disposal_profile
    if health_profile:
        return health_profile
    return matched[0]


def _intent_score(item_text: str, profile: dict | None) -> float:
    """Score evidence for a matched intent, with a modest distractor penalty."""
    if not profile:
        return 0.0
    text = (item_text or "").lower()
    preferred_hits = sum(1 for term in profile["preferred"] if term.lower() in text)
    distractor_hits = sum(1 for term in profile["distractors"] if term.lower() in text)
    # Four hits are enough to establish a procedure; cap both sides so a long
    # chunk cannot win merely by repeating a keyword many times.
    return min(preferred_hits, 4) * 0.48 - min(distractor_hits, 3) * 0.22


def _allows_multiple_topic_sources(query: str, entity_groups: list[tuple[str, ...]]) -> bool:
    """Whether a query explicitly asks for independent topics.

    A single-topic compound such as “ROV 流程和安全” must stay on one source;
    only clear comparison/list wording should permit multiple source documents.
    If multiple entity groups are named (for example fish *and* blue carbon),
    retaining more than one source is intentional.
    """
    if len(entity_groups) > 1:
        return True
    return bool(re.search(
        r"分别|各自|分开(?:介绍|说明)?|还是|对比|比较|同时(?:讨论|涉及|包含)|不同.*(?:影响|特点|区别)",
        query or "",
        re.I,
    ))


def _chunks_preserving_lines(text: str, target_chars: int = 900) -> List[str]:
    """优先在换行处切片，避免把表格中的对象、数字和限定条件拆开。"""
    lines = [line.rstrip() for line in text.splitlines()]
    chunks: List[str] = []
    current: List[str] = []
    heading = ""
    for line in lines:
        if line.lstrip().startswith("#"):
            heading = line
        candidate = "\n".join(current + [line]).strip()
        if current and len(candidate) > target_chars:
            chunk = "\n".join(current).strip()
            if chunk:
                chunks.append(chunk)
            current = [heading] if heading and heading != line else []
        current.append(line)
    tail = "\n".join(current).strip()
    if tail:
        chunks.append(tail)
    return chunks


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


def _query_special_aliases(query: str) -> list[tuple[str, ...]]:
    identifiers = {token.lower() for token in _WORD.findall(query or "")}
    return [aliases for key, aliases in _SPECIAL_TERM_ALIASES.items() if key in identifiers]


def _contains_alias(text: str, alias: str) -> bool:
    """英文/数字标识按完整 token 匹配，避免 PP 命中 support/APP 等子串。"""
    if re.fullmatch(r"[A-Za-z0-9_+#.-]+", alias):
        return alias.lower() in {token.lower() for token in _WORD.findall(text or "")}
    return alias.lower() in (text or "").lower()


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
                for chunk in _chunks_preserving_lines(part):
                    if len(chunk) >= 25:
                        self.chunks.append({
                            "content": chunk,
                            "source": path.name,
                            "terms": _terms(chunk),
                            "substantive_terms": _substantive_terms(chunk),
                        })

    def search(self, query: str, k: int = 5) -> List[Dict]:
        q_terms = _terms(query)
        if not q_terms:
            return []
        q_substantive_terms = _substantive_terms(query)
        special_aliases = _query_special_aliases(query)
        entity_groups = _query_entity_groups(query)
        intent_profile = _query_intent_profile(query, entity_groups)
        scored = []
        query_has_cjk = bool(_CJK.search(query))
        query_has_identifier = bool(_WORD.search(query))
        action_query = bool(re.search(r"治理|措施|处理|清理|怎么做|如何|建议|流程", query))
        action_terms = ("源头", "减量", "拦截", "清理", "回收", "复测", "监测", "记录", "评估", "管理")
        for item in self.chunks:
            # 专有对象是硬约束：问 PET/PP/ROV 等时，不允许只因命中“塑料/海洋”等泛词
            # 把同一主题下的其它对象文档抬进候选，避免跨材质、跨设备串答。
            item_lower = item["content"].lower()
            if special_aliases:
                special_hits = [
                    any(_contains_alias(item_lower, alias) for alias in aliases)
                    for aliases in special_aliases
                ]
                # A multi-topic query may name a special identifier (for
                # example “蓝碳和 ROV 分别介绍”) whose evidence lives in a
                # different document. Do not force every chunk to contain
                # the same identifier; the entity filter below handles the
                # per-topic match. For identifier-only comparisons (PET/HDPE)
                # retain at least one matching identifier per chunk.
                if len(entity_groups) > 1:
                    pass
                elif _allows_multiple_topic_sources(query, entity_groups):
                    if not any(special_hits):
                        continue
                elif any(not hit for hit in special_hits):
                    continue
            # 生物、蓝碳、水质和 ROV 是不同主题。命中其中一个实体时，
            # 不允许只靠“海洋/识别/处理”等泛词把其他主题抬进 Top-K。
            if entity_groups:
                entity_hits = [
                    sum(1 for alias in aliases if _contains_alias(item_lower, alias))
                    for aliases in entity_groups
                ]
                # A single-topic query must stay on one entity.  For an
                # explicit multi-topic query ("鱼类和 ROV 分别…"), each
                # topic is retrieved independently; requiring one chunk to
                # mention every entity would incorrectly return no evidence.
                if len(entity_groups) > 1:
                    if not any(hit > 0 for hit in entity_hits):
                        continue
                elif any(hit == 0 for hit in entity_hits):
                    continue
            overlap = len(q_terms & item["terms"])
            # 至少命中一个非泛化主题词，避免“海洋/问题”等常见词把无关段落抬进 Top-K。
            substantive_overlap = len(q_substantive_terms & item["substantive_terms"])
            if q_substantive_terms and substantive_overlap == 0:
                continue
            phrase = sum(1 for t in q_terms if len(t) > 2 and t in item["content"])
            title_overlap = len(q_terms & _terms(Path(item["source"]).stem))
            score = (
                overlap / math.sqrt(max(1, len(item["terms"])))
                + phrase * 0.04
                + title_overlap * 0.12
            )
            if entity_groups:
                # 实体命中优先于泛化动作词，确保“鱼类识别”先看到鱼类条目。
                score += sum(min(2, hit) * 0.35 for hit in entity_hits)
            # Prefer chunks that contain the requested operation/definition
            # vocabulary.  This is intentionally a small additive term: the
            # normal lexical score still decides when no intent profile fits.
            score += _intent_score(item_lower, intent_profile)
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
        if entity_groups and scored and not _allows_multiple_topic_sources(query, entity_groups):
            # For an explicit single entity, return evidence from the highest
            # scoring topic source only.  Without this gate a fish query gets
            # the dataset's generic category table, a heavy-metal query gets
            # a health/microplastics chunk, and an ROV query gets ghost-net or
            # YOLO process text simply because those chunks repeat the entity.
            source_best: dict[str, tuple[float, int]] = {}
            for index, (score, item) in enumerate(scored):
                source = item["source"]
                current = source_best.get(source)
                if current is None or score > current[0]:
                    source_best[source] = (score, index)
            best_source = max(
                source_best.items(),
                key=lambda pair: (pair[1][0], -pair[1][1]),
            )[0]
            scored = [(score, item) for score, item in scored if item["source"] == best_source]
        elif len(entity_groups) > 1 and scored:
            # For explicit multi-topic questions, keep the strongest source
            # for each named entity. This preserves one evidence stream per
            # topic while dropping generic documents that merely repeat a
            # shared word such as "鱼" or "ROV".
            topic_sources: set[str] = set()
            for aliases in entity_groups:
                topic_candidates = [
                    (score, item) for score, item in scored
                    if any(_contains_alias(item["content"].lower(), alias) for alias in aliases)
                ]
                if topic_candidates:
                    # Prefer a source with repeated/explicit entity evidence,
                    # and use a not-yet-selected source when one exists. A
                    # fish chapter may mention ROV once as context; that must
                    # not displace the dedicated ROV chapter.
                    unused = [pair for pair in topic_candidates if pair[1]["source"] not in topic_sources]
                    pool = unused or topic_candidates
                    best_item = max(
                        pool,
                        key=lambda pair: (
                            sum(
                                1
                                for alias in aliases
                                if _contains_alias(pair[1]["content"].lower(), alias)
                            ),
                            pair[0],
                        ),
                    )[1]
                    topic_sources.add(best_item["source"])
            if topic_sources:
                scored = [(score, item) for score, item in scored if item["source"] in topic_sources]
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
