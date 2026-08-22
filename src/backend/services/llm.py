"""Ollama 不可用时的高质量安全兜底。

兜底不是随机闲聊：它只覆盖高频海洋意图、开发者身份和范围边界，
避免服务异常时继续输出答非所问的模板话。
"""
from __future__ import annotations

import asyncio
import os
import re
from typing import Any, AsyncGenerator, Optional, Sequence

IDENTITY = (
    '我是海瞳平台的海洋守护者，这个项目是海瞳团队共同开发的成果。'
    'LLM 这块主要由海瞳 LLM 组负责，包括模型微调和对话能力升级。有什么海洋环保问题想了解吗？'
)
FAMILY_IDENTITY = (
    '哈哈，我是 AI 助手，没有生物学意义上的父母或家人。'
    '不过这个项目确实是海瞳团队一起搭建的，LLM 模块由海瞳 LLM 组负责开发。'
    '要不聊聊海洋垃圾识别？这才是我擅长的领域。'
)
PLATFORM_IDENTITY = (
    '我是海瞳平台的海洋守护者，主要帮你分析水下垃圾检测结果、解读污染风险、'
    '回答海洋环保相关的问题。比如检测报告怎么看、不同垃圾该怎么处理、MARPOL 公约是什么等等。'
)
SCOPE_RESPONSE = (
    "这个问题超出我的专业范围了——我主要聚焦在海洋垃圾识别、污染分析和海洋环保政策这块。"
    "如果你有检测结果需要解读，或者想了解海洋治理方面的内容，我会更有帮助。"
)

# 只有命中业务语境的复杂问题才交给小参数模型；其余问题明确收敛范围，
# 避免模型把天气、编程、闲聊等内容硬套成海洋回答。
DOMAIN_TERMS = (
    "海洋", "海岸", "海滩", "海底", "海水", "海域", "海洋生物", "海洋环保",
    "垃圾", "废弃物", "污染", "塑料", "微塑料", "渔网", "渔具", "漂浮物", "漂浮垃圾",
    "珊瑚", "m arpol", "marpol", "船舶", "附则", "清理", "打捞", "回收", "分拣", "治理",
    "检测", "识别", "置信度", "检测报告", "污染等级", "yolo", "环保", "trashcan", "数据集",
    "鲸鱼", "海豚", "鲨鱼", "洋流", "潮汐", "海平面", "气候变化", "生态", "珊瑚礁", "生物多样性",
    "样方", "样带", "声呐", "传感器", "无人艇", "usv", "rov", "rfid", "pops", "富集", "食物链",
    "碳汇", "监测方法", "监测", "微创", "切割", "指引", "清滩", "尼龙", "聚乙烯", "pe",
    "图像", "多帧", "时序", "跟踪", "追踪", "机制", "方法", "去散射", "超分辨率", "类别",
    "生命图谱", "指挥大屏", "污染分析", "检测历史", "报告页", "海洋守护者",
)

THINK_TRACE_RE = re.compile(
    r"(?:^|\n)\s*(?:嗯[，,、 ]*)?(?:用户问的是|用户的问题是|首先[，,、 ]*(?:我得|我需要|让我|我先)|"
    r"让我想想|我来分析一下|我需要回忆|先分析一下|接下来我会|思考一下)[：:，, ]*",
    re.I,
)
FABRICATED_EVENT_RE = re.compile(
    r"\b(?:19|20)\d{2}\s*年[^。！？\n]{0,32}(?:事件|海啸|事故|灾难|战役)"
    r"|\b(?:19|20)\d{2}\s*年[^。！？\n]{0,40}(?:大会|决议|公约|协议|条例|标准|法案)"
    r"|(?:马里亚纳海沟|科罗拉多海平面)[^。！？\n]{0,24}(?:事件|海啸|事故)",
    re.I,
)

_CITATION_RE = re.compile(r"\[S(\d+)\]", re.I)
_UNSUPPORTED_ORG_RE = re.compile(
    r"[\u4e00-\u9fffA-Za-z·]{2,24}(?:委员会|研究院|保护署|管理局|协会|组织|大学)"
)
_UNSUPPORTED_NAMED_FACT_RE = re.compile(r"《[^》]{2,40}(?:公约|协议|条例|标准|法案)》")
_UNSUPPORTED_SCHEMA_RE = re.compile(
    r"(?:[红黄蓝绿黑白橙紫]色|[A-Z]\s*级|[A-Z]\s*类)\s*(?:代表|表示|对应|编码|标记)"
    r"|(?:颜色|编码|代码|分类体系|等级体系|标签体系)\s*(?:规定|分为|是|包括)"
)


def is_domain_question(message: str) -> bool:
    q = (message or "").strip().lower()
    return any(term.replace(" ", "") in q.replace(" ", "") for term in DOMAIN_TERMS)


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _strip_think(text: str) -> str:
    """移除模型可能泄漏的推理标签；路由层只把可展示内容交给前端。"""
    cleaned = re.sub(r"<think>.*?</think>", "", text or "", flags=re.I | re.S)
    cleaned = re.sub(r"</?think\s*>", "", cleaned, flags=re.I)
    return THINK_TRACE_RE.sub("\n", cleaned).strip()


def _has_obvious_repetition(text: str) -> bool:
    """拦截小模型常见的短句/短语循环，不因正常的项目符号而误伤。"""
    compact = _compact(text)
    if len(compact) < 40:
        return False
    for size in (8, 10, 12):
        for index in range(0, max(0, len(compact) - size + 1), 2):
            fragment = compact[index:index + size]
            if fragment and compact.count(fragment) >= 4:
                return True
    return False


def _evidence_text(evidence: Sequence[dict[str, Any]]) -> str:
    return "\n".join(str(item.get("content") or "") for item in evidence)


def _numbers(text: str) -> set[str]:
    cleaned = _CITATION_RE.sub("", text or "")
    cleaned = re.sub(r"(?m)^\s*\d+[.、)]\s*", "", cleaned)
    return set(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?%?", cleaned))


def _has_unsupported_facts(answer: str, question: str, evidence: Sequence[dict[str, Any]]) -> bool:
    support = f"{question}\n{_evidence_text(evidence)}"
    if _numbers(answer) - _numbers(support):
        return True
    support_compact = _compact(support).lower()
    for match in _UNSUPPORTED_ORG_RE.finditer(answer):
        if _compact(match.group(0)).lower() not in support_compact:
            return True
    for match in FABRICATED_EVENT_RE.finditer(answer):
        if _compact(match.group(0)).lower() not in support_compact:
            return True
    for match in _UNSUPPORTED_NAMED_FACT_RE.finditer(answer):
        if _compact(match.group(0)).lower() not in support_compact:
            return True
    for match in _UNSUPPORTED_SCHEMA_RE.finditer(answer):
        if _compact(match.group(0)).lower() not in support_compact:
            return True
    return False


def _is_complete_answer(answer: str) -> bool:
    """拦截 num_predict 到顶时常见的半句、冒号和列表项截断。"""
    text = re.sub(r"\s+", " ", _strip_think(answer)).strip()
    if not text:
        return False
    # 引用标记可以位于最后，先剥离再检查正文终止符。
    body = re.sub(r"(?:\s*\[S\d+\])+$", "", text, flags=re.I).rstrip()
    if not body or re.search(r"(?:[：:]|[-*•])\s*$", body):
        return False
    return bool(re.search(r"[。！？!?；;.!?](?:[」』）》】)）\"']*)?$", body))


def _claim_terms(text: str) -> set[str]:
    chars = "".join(re.findall(r"[\u4e00-\u9fff]", text or ""))
    stop = {"这个", "问题", "主要", "需要", "可以", "应该", "通过", "进行", "以及", "相关", "方面"}
    return {
        chars[index:index + 2]
        for index in range(max(0, len(chars) - 1))
        if chars[index:index + 2] not in stop
    }


def _claims_have_citations(answer: str, evidence: Sequence[dict[str, Any]]) -> bool:
    """每个实质性段落/列表项都必须在同一行给出来源，避免用一个引用装饰整篇幻觉。"""
    for raw_line in (answer or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        visible = re.sub(r"^[#>*\-+\d.、)\s]+", "", line)
        visible = re.sub(r"[*_`~]", "", visible).strip()
        if not visible or visible.endswith(("：", ":")) or len(_compact(visible)) < 6:
            continue
        citation_ids = [int(value) for value in _CITATION_RE.findall(line)]
        if not citation_ids:
            return False
        claim_terms = _claim_terms(_CITATION_RE.sub("", visible))
        cited_text = "\n".join(
            str(evidence[index - 1].get("content") or "")
            for index in citation_ids
            if 1 <= index <= len(evidence)
        )
        if claim_terms:
            support_ratio = len(claim_terms & _claim_terms(cited_text)) / len(claim_terms)
            if support_ratio < 0.16:
                return False
    return True


def requires_citations(question: str) -> bool:
    """只有需要可核验事实的问法强制引用，科普问法允许模型组织通识回答。"""
    q = (question or "").lower()
    return bool(re.search(
        r"检测报告|报告|污染等级|污染指数|置信度|统计|正式|纳入|m arpol|marpol|附则|法规|公约|"
        r"任务编号|点位|监测数据|多少|数量|评分|结论|条款|切割|微创|rov|潜水员|"
        r"去散射|超分辨率|多帧|时序|跟踪|追踪|机制|方法|标准作业|sop|流程|步骤|操作",
        q.replace(" ", ""),
    ))


def is_strong_evidence_question(question: str, evidence: Sequence[dict[str, Any]]) -> bool:
    """判断是否可直接用已排序证据回答，避免强相关问题白跑模型再被门禁拦截。"""
    if not evidence or not requires_citations(question):
        return False
    try:
        score = float(evidence[0].get("score") or 0)
    except (TypeError, ValueError):
        score = 0.0
    return score >= 0.32


def is_acceptable_model_answer(
    answer: str,
    question: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    require_citations: Optional[bool] = None,
) -> bool:
    """拦截 R1 1.5B 的复述、空答、推理泄漏和明显事实偏移。"""
    raw = answer or ""
    text = _compact(_strip_think(raw))
    query = _compact(question)

    # 基础质量检查：推理泄漏、空答、完全复述问题
    if "<think" in raw.lower() or THINK_TRACE_RE.search(raw) or len(text) < 24 or text == query or text.startswith(query):
        return False
    if _has_obvious_repetition(raw):
        return False
    if not _is_complete_answer(raw):
        return False

    # 只拦截严重的事实错误模板，放宽自然表达的空间
    critical_errors = (
        r"系统无法直接回答",  # 回避式模板
        r"立即停止.*?活动",   # 无依据的紧急指令
    )
    if any(re.search(pattern, text) for pattern in critical_errors):
        return False

    # RAG 回答必须能追溯到实际检索结果，来源编号必须存在。
    if evidence is not None:
        require = (
            os.getenv("LLM_REQUIRE_CITATIONS", "true").strip().lower() in {"1", "true", "yes", "on"}
            if require_citations is None else require_citations
        )
        if not _evidence_supports_requested_intent(question, evidence):
            return False
        if not evidence:
            if _has_unsupported_facts(raw, question, evidence):
                return False
            return (not require) or bool(re.search(r"资料不足|没有足够资料|暂时无法确认|未检索到", text))
        citations = [int(value) for value in _CITATION_RE.findall(raw)]
        if require and not citations:
            return False
        if require and not _claims_have_citations(raw, evidence):
            return False
        if any(value < 1 or value > len(evidence) for value in citations):
            return False
        if len(text) > 800:
            return False
        if _has_unsupported_facts(raw, question, evidence):
            return False

    # 引用存在不等于回答了问题：至少要回应问题中的高信号主题词。
    query_lower = (question or "").lower()
    answer_lower = text.lower()
    generic_topics = {"海洋", "海岸", "海滩", "海水", "海域", "问题", "检测", "报告", "治理", "污染"}
    core_topics = [
        term.replace(" ", "") for term in DOMAIN_TERMS
        if len(term.replace(" ", "")) >= 2
        and term.replace(" ", "") not in generic_topics
        and term.replace(" ", "") in query_lower.replace(" ", "")
    ]
    # 领域词较少时，保留两个以上汉字的连续主题词作为轻量相关性检查。
    if core_topics and not any(term.lower() in answer_lower for term in core_topics):
        return False
    for key, aliases in _SPECIAL_TERM_ALIASES.items():
        if key in query_lower and not any(alias in answer_lower for alias in aliases):
            return False

    # 只对高风险术语检查必需要素，避免拦截自然表达
    critical_terms = {
        "微塑料": ("5毫米", "毫米", "碎片", "颗粒", "小于"),  # 尺寸定义必需
        "marpol": ("附则", "公约", "船舶"),  # 基本概念必需
        "渔网": ("缠绕", "打捞", "解缠", "生物", "珊瑚", "清洗", "脱盐", "再生", "回收", "利用", "分类"),
        "塑料": ("减量", "清理", "回收", "污染", "微塑料"),
        "珊瑚": ("栖息", "损伤", "保护", "缠绕", "复核"),
        "声呐": ("声呐", "定位", "探测", "避障", "扫描"),
        "rfid": ("rfid", "射频", "标签", "追踪", "识别"),
        "usv": ("usv", "无人艇", "巡航", "拦截", "漂浮"),
        "样方": ("样方", "样带", "计数", "抽检", "复测"),
        "富集": ("富集", "食物链", "污染物", "累积", "毒性"),
        "食物链": ("食物链", "富集", "毒性", "生物"),
        "传感器": ("传感器", "声呐", "深度计", "监测"),
    }
    q_lower = query_lower
    for topic, terms in critical_terms.items():
        if topic in q_lower and not any(term in text for term in terms):
            return False

    # 拦截违反核心知识边界的结论
    if "marpol" in q_lower and re.search(r"(允许|可以|能够).{0,12}(塑料|垃圾).{0,12}(倒|排放).{0,8}(海|海里)", text):
        return False

    return True


def finalize_model_answer(
    question: str,
    model_answer: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> str:
    """统一模型后处理：净化后须通过质量门禁，否则返回可追溯兜底。"""
    cleaned = _strip_think(model_answer)
    if is_acceptable_model_answer(cleaned, question, evidence, require_citations=requires_citations(question)):
        return cleaned
    return _fallback_response(question, evidence, report_context)


def _query_terms(text: str) -> set[str]:
    compact = "".join(re.findall(r"[\u4e00-\u9fff]", text or ""))
    words = set(re.findall(r"[A-Za-z0-9_+#.-]+", (text or "").lower()))
    for size in (2, 3, 4):
        words.update(compact[index:index + size] for index in range(max(0, len(compact) - size + 1)))
    return words


_GENERIC_QUERY_TERMS = {
    "海洋", "海岸", "海滩", "海水", "海域", "问题", "怎么", "如何", "什么", "这个", "那个",
    "相关", "方面", "可以", "应该", "需要", "进行", "一下", "变成", "成为", "守护者", "告诉",
}
_NOISE_QUERY_CHARS = set("怎么如何这个那个变成成为守护者告诉以及是否请问和的了呢吗")
_QUERY_SIGNAL_TERMS = {
    "垃圾", "塑料", "塑料袋", "微塑料", "渔网", "渔具", "珊瑚", "鲸鱼", "海豚", "鲨鱼", "生态",
    "检测", "识别", "置信度", "报告", "污染", "清理", "打捞", "回收", "样方", "样带", "声呐",
    "传感器", "无人艇", "usv", "rov", "rfid", "pops", "富集", "食物链", "洋流", "潮汐", "碳汇",
    "巡航", "拦截", "监测", "复测", "降级", "风险标注", "作业", "切割", "微创", "网格", "抽检",
}
_SPECIAL_TERM_ALIASES = {
    "usv": ("usv", "无人艇", "无人船"),
    "rfid": ("rfid", "射频识别", "射频标签"),
    "rov": ("rov", "遥控水下机器人"),
    "声呐": ("声呐", "声纳", "声学"),
    "样方": ("样方", "样带"),
}


def _substantive_query_terms(text: str) -> set[str]:
    """提取用于证据相关性判断的高信号词，排除泛化寒暄和功能词。"""
    compact = "".join(re.findall(r"[\u4e00-\u9fff]", text or ""))
    terms = {word.lower() for word in re.findall(r"[A-Za-z0-9_+#.-]+", text or "") if len(word) >= 2}
    for size in (2, 3, 4):
        terms.update(compact[index:index + size] for index in range(max(0, len(compact) - size + 1)))
    signal_terms = {term for term in _QUERY_SIGNAL_TERMS if term in (text or "").lower()}
    return {
        term for term in terms
        if term not in _GENERIC_QUERY_TERMS
        and (term in signal_terms or not any(char in _NOISE_QUERY_CHARS for char in term))
    }


_CALCULATION_INTENT_RE = re.compile(r"计算|权重|公式|评分|分配|系数|加权|百分比", re.I)
_MECHANISM_INTENT_RE = re.compile(r"机制|原理|为什么|如何形成|成因|传递|富集|跟踪", re.I)
_METHOD_INTENT_RE = re.compile(r"方法|方案|步骤|指引|标准作业|sop|流程|操作", re.I)
_REPORT_INTERPRETATION_INTENT_RE = re.compile(r"降级|风险标注|标注", re.I)
_OPERATION_INTENT_RE = re.compile(
    r"切割|微创|rov|潜水员|去散射|超分辨率|多帧|跟踪|机制", re.I
)


def _evidence_supports_requested_intent(
    message: str, evidence: Sequence[dict[str, Any]]
) -> bool:
    """证据必须覆盖问题要求的计算、机制、方法或操作内容。"""
    query = message or ""
    text = "\n".join(str(item.get("content") or "") for item in evidence or [])

    def _same_sentence_has(left_pattern: str, right_pattern: str) -> bool:
        """组合意图必须在同一句成立，避免同一 chunk 的擦边词拼接放行。"""
        for content in (str(item.get("content") or "") for item in evidence or []):
            sentences = re.split(r"(?<=[。！？；.!?;])|\n+", content)
            if any(
                re.search(left_pattern, sentence, re.I)
                and re.search(right_pattern, sentence, re.I)
                for sentence in sentences
            ):
                return True
        return False

    # “多帧跟踪/时序跟踪/跨帧关联”是一个不可拆分的机制意图。
    # 证据必须在同一句同时出现“帧”和“跟踪”，或直接出现组合术语。
    if re.search(r"多帧|时序|跨帧", query, re.I) and re.search(r"跟踪|追踪|关联", query, re.I):
        if not (
            re.search(r"多帧\s*(?:跟踪|追踪)|时序\s*(?:跟踪|追踪)|跨帧\s*关联", text, re.I)
            or _same_sentence_has(r"帧|多帧", r"跟踪|追踪|关联")
        ):
            return False
    if _CALCULATION_INTENT_RE.search(query) and not re.search(
        r"权重|公式|评分|计算|分配|系数|加权", text, re.I
    ):
        return False
    if _MECHANISM_INTENT_RE.search(query) and not re.search(
        r"机制|原理|过程|导致|成因|传递|富集|跟踪|多帧", text, re.I
    ):
        return False
    if _METHOD_INTENT_RE.search(query) and not re.search(
        r"方法|方案|步骤|流程|指引|sop|操作|切割|解缠", text, re.I
    ):
        return False
    if _REPORT_INTERPRETATION_INTENT_RE.search(query) and not re.search(
        r"降级|风险标注|标注", text, re.I
    ):
        return False
    if _OPERATION_INTENT_RE.search(query):
        operation_groups = (
            (r"切割|微创", r"切割|微创|解缠"),
            (r"rov|潜水员", r"rov|潜水员|解缠|打捞"),
            (r"去散射", r"去散射|散射"),
            (r"超分辨率", r"超分辨率|分辨率"),
            (r"多帧", r"多帧|帧"),
            (r"跟踪", r"跟踪|追踪"),
        )
        for query_terms, evidence_terms in operation_groups:
            if re.search(query_terms, query, re.I) and not re.search(evidence_terms, text, re.I):
                return False
    if re.search(r"鲸鱼|鲸类|搁浅", query, re.I) and not re.search(
        r"搁浅|导航|疾病|声呐|迷航|受伤|救助", text, re.I
    ):
        return False
    if re.search(r"识别哪些类别|哪些类别|类别有哪些|分类有哪些|识别什么垃圾|目标类别", query, re.I) and not re.search(
        r"(?:类别|分类).{0,12}(?:包括|有|分为|例如)|trash_|瓶|袋|渔网|塑料|金属|玻璃|泡沫|轮胎", text, re.I
    ):
        return False
    return True


def _has_substantive_evidence_overlap(message: str, evidence: Sequence[dict[str, Any]]) -> bool:
    query_terms = _substantive_query_terms(message)
    if not query_terms:
        return False
    contents = [str(item.get("content") or "") for item in evidence]
    if not any(query_terms & _substantive_query_terms(content) for content in contents):
        return False
    if not _evidence_supports_requested_intent(message, evidence):
        return False
    # 专用标识符不能只靠“塑料/海洋”等泛词擦边命中；缺少其本身的资料时不拼贴兜底。
    query_lower = (message or "").lower()
    for key, aliases in _SPECIAL_TERM_ALIASES.items():
        if key in query_lower and not any(alias in "\n".join(contents).lower() for alias in aliases):
            return False
    return True


def _evidence_excerpt(message: str, evidence: Sequence[dict[str, Any]]) -> tuple[str, list[str]]:
    query_terms = _query_terms(message)
    action_query = bool(re.search(r"治理|措施|处理|清理|怎么做|如何|建议|流程", message))
    action_terms = ("源头", "减量", "拦截", "清理", "回收", "复测", "监测", "记录", "评估", "管理")
    intent_query = bool(_REPORT_INTERPRETATION_INTENT_RE.search(message or ""))
    intent_terms = ("降级", "风险标注", "标注")
    hash_artifact_re = re.compile(
        r"^.{1,80}\s*[-–—]\s*[a-f0-9]{20,}_?\.(?:jpg|jpeg|png|html|md|txt)$", re.I
    )
    candidates: list[tuple[int, int, str, str, int]] = []
    for item_index, item in enumerate(evidence[:2]):
        source = str(item.get("source") or (item.get("metadata") or {}).get("source") or "项目知识库")
        content = str(item.get("content") or "")
        parts = re.split(r"(?<=[。！？；])|\n+", content)
        for part_index, part in enumerate(parts):
            if part.lstrip().startswith(("#", ">")):
                continue
            sentence = re.sub(r"^#{1,6}\s*", "", part).strip(" -*\t")
            sentence = re.sub(r"^\d+[.、)]\s*", "", sentence)
            if len(sentence) < 18:
                continue
            if hash_artifact_re.search(sentence):
                continue
            if sentence.startswith(("以下内容介绍", "本文介绍")):
                continue
            overlap = len(query_terms & _query_terms(sentence))
            source_bonus = max(0, 6 - item_index * 3)
            action_bonus = sum(8 for term in action_terms if action_query and term in sentence)
            intent_bonus = sum(18 for term in intent_terms if intent_query and term in sentence)
            candidates.append((overlap + source_bonus + action_bonus + intent_bonus, -part_index, sentence, source, item_index + 1))
    candidates.sort(reverse=True)
    selected: list[str] = []
    sources: list[str] = []
    total = 0
    selected_ids: list[int] = []
    for _, _, sentence, source, source_id in candidates:
        if sentence in selected or total + len(sentence) > 650:
            continue
        selected.append(sentence)
        total += len(sentence)
        selected_ids.append(source_id)
        if source not in sources:
            sources.append(source)
        if len(selected) >= 4:
            break
    return "\n".join(
        f"- [S{selected_ids[index] if index < len(selected_ids) else 1}] {sentence}"
        for index, sentence in enumerate(selected)
    ), sources


def _knowledge_fallback(
    message: str, evidence: Optional[Sequence[dict[str, Any]]] = None
) -> Optional[str]:
    """模型不可用或被质量门禁拦截时，返回可追溯的知识库证据。"""
    if not is_domain_question(message):
        return None
    results: Sequence[dict[str, Any]] = evidence or []
    if not results:
        try:
            from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever

            results = LocalKnowledgeRetriever().search(message, 3)
        except Exception:
            return None
    if not results:
        return None
    # 有检索分数或引用编号仍不代表答到了问题；没有实质词重叠时禁止拼贴弱相关资料。
    if not _has_substantive_evidence_overlap(message, results):
        return None
    # 操作型渔网问题需要“怎么做”的实质依据，不能因为命中“渔网/处置”等泛词就拼贴法规或概述。
    if re.search(r"渔网|渔具", message, re.I) and re.search(
        r"切割|微创|解缠|rov|潜水员|打捞|标准作业|步骤|流程|sop", message, re.I
    ):
        evidence_text = "\n".join(str(item.get("content") or "") for item in results)
        if not re.search(r"切割|微创|解缠|rov|潜水员", evidence_text, re.I):
            return None
    excerpt, sources = _evidence_excerpt(message, results)
    if not excerpt:
        return None
    # 操作型问题不能用同一 chunk 里的定义/背景句冒充操作指引；
    # 摘录本身也必须出现对应动作词，否则返回资料不足模板。
    if re.search(
        r"切割|微创|rov|潜水员|去散射|超分辨率|多帧|跟踪|追踪|机制|标准作业|sop|步骤|流程|方法|操作",
        message,
        re.I,
    ) and not re.search(
        r"切割|微创|rov|潜水员|去散射|超分辨率|多帧|跟踪|追踪|机制|标准作业|sop|步骤|流程|方法|操作|解缠",
        excerpt,
        re.I,
    ):
        return None
    # 多帧跟踪是组合机制，摘录也必须保留组合句，不能只摘 ROV/置信度等邻近背景。
    if re.search(r"多帧|时序|跨帧", message, re.I) and re.search(r"跟踪|追踪|关联", message, re.I):
        sentences = re.split(r"(?<=[。！？；.!?;])|\n+", excerpt)
        if not (
            re.search(r"多帧\s*(?:跟踪|追踪)|时序\s*(?:跟踪|追踪)|跨帧\s*关联", excerpt, re.I)
            or any(
                re.search(r"帧|多帧", sentence, re.I)
                and re.search(r"跟踪|追踪|关联", sentence, re.I)
                for sentence in sentences
            )
        ):
            return None

    result_sources: list[str] = []
    for item in results[:3]:
        source = str(item.get("source") or (item.get("metadata") or {}).get("source") or "项目知识库")
        if source not in result_sources:
            result_sources.append(source)
    source_text = "、".join(
        f"[S{index + 1}] {source}" for index, source in enumerate(result_sources)
    ) or "项目知识库"
    return (
        f"根据项目知识库中与这个问题最相关的资料，可以确认：\n\n{excerpt}\n\n"
        f"资料来源：{source_text}。"
        "如果你有具体的检测数据（比如地点、垃圾类型、数量、置信度），我可以给出更针对性的建议。"
    )


def stream_text(text: str) -> AsyncGenerator[str, None]:
    """把已通过质量检查的完整答案以短句输出，保持前端阅读节奏。"""
    async def _stream() -> AsyncGenerator[str, None]:
        pieces = re.findall(r"[^，。！？；：,!?;: ]+[，。！？；：,!?;: ]*", text) or [text]
        for piece in pieces:
            await asyncio.sleep(0.025)
            yield piece
    return _stream()


def direct_response(message: str) -> Optional[str]:
    """为身份、证据边界和高风险海洋题提供稳定的确定性答案。

    这不是替代 RAG，而是防止 1.5B 基座在项目事实、法规禁令和检测阈值上自由发挥。
    未命中的垂直领域问题仍会进入"RAG → Ollama → 质量门禁"链路。
    """
    q = (message or "").strip().lower()
    if not q:
        return "你好呀，有什么想了解的海洋环保话题吗？比如检测报告、垃圾分类或者污染治理。"

    if re.search(r"爸爸|父亲|母亲|妈妈|父母|家人|家长|你爸|你爹|老爸|老妈|亲爹", q):
        return FAMILY_IDENTITY
    if re.search(r"谁开发|开发者|项目作者|作者|谁做的|谁创建|项目是谁|谁制作|谁写的|谁设计|制作者|创始人|开发这个项目|aquarise.*作者", q):
        return IDENTITY
    if re.search(r"^(?:(?:你好|您好|嗨|hello|hi)(?:呀|啊|哟)?[！!。．.、, ]*)+$", q):
        return "你好！我是海洋守护者，可以帮你分析检测结果、解答海洋环保问题。有什么想了解的吗？"
    if re.search(r"早上好|下午好|晚上好|还好吗|过得还好吗|在吗|有空吗", q):
        return "我在呢，状态不错！我是海洋守护者，想聊聊海洋垃圾、生态保护或检测报告哪一块？"
    if re.search(r"谢谢|感谢|多谢|辛苦了|麻烦你了", q):
        return "不客气！能帮你梳理海洋环保和检测问题就好。之后有报告或数据，随时发给我。"
    if re.search(r"再见|拜拜|拜拜了|下次见|先这样", q):
        return "再见！祝你今天顺利，之后想继续看海洋数据或报告，随时来找我。"
    if re.search(r"傻逼|他妈的|妈的|操你|草泥马|滚蛋|废物|蠢货|弱智", q):
        return "我的专业是海洋环保，骂人我不太擅长～有什么海洋问题尽管问。"
    platform_lookup = not re.search(
        r"导入|上传|分析|解读|这份|《|》|请|帮我|概括|风险等级|关键发现|依据", q
    )
    if platform_lookup and re.search(r"生命图谱|生命图谱3d|海洋生命图谱", q):
        return "生命图谱是海瞳平台里的 3D 海洋生态探索页面，用来查看海洋生物、生态关系和保护知识。它偏向科普与知识浏览，不是检测结果或污染等级的统计页面。"
    if platform_lookup and re.search(r"指挥大屏|指挥中心|大屏是做什么|态势大屏", q):
        return "指挥大屏用于集中查看海域监测态势、污染指标、任务进度和风险提醒，适合项目汇报和治理调度。具体检测结果仍以检测任务和报告详情为准。"
    if platform_lookup and re.search(r"污染分析页|污染分析|分析页是做什么", q):
        return "污染分析页面聚合检测数据，展示污染趋势、材质构成、海域对比和高频目标，帮助判断治理重点；它不替代单个报告的原始证据复核。"
    if platform_lookup and re.search(r"检测历史|历史记录|历史页是做什么", q):
        return "检测历史页面用于检索、筛选和查看已完成的水下影像识别任务，也可以按污染等级和关键词定位任务详情。"
    if platform_lookup and re.search(r"^(?:报告页|报告页面).{0,8}(?:是|做|干).{0,4}什么", q):
        return "报告页面用于查看检测任务生成的质量报告，并在导入或分析后查看关键发现、风险等级、处置方案和证据。"
    if platform_lookup and re.search(r"你是谁|你是什么|你是哪个平台|你是哪家|你属于|来自哪里|你叫什么|介绍一下你|你能做什么|有什么功能|海瞳", q):
        return PLATFORM_IDENTITY
    if re.search(r"天气|股票|写代码|编程|写程序|游戏|小说|笑话|算命|新闻|影视|家庭作业|作业题|写作业", q):
        return SCOPE_RESPONSE

    # 以下是核心专业知识，需要保持权威性但可以更亲和
    if re.search(r"(置信度|把握|可信度).{0,12}(低|不足|不高)|(?:置信度|把握|可信度).{0,12}(?:\d{1,3}(?:\.\d+)?)%|能否.{0,8}(统计|上报)|能直接.{0,8}(统计|确认)", q) and not re.search(r"降级|风险标注|正式报告|多帧|跟踪|机制|方法", q):
        return (
            "低置信度的识别结果不能直接当成确定结论来统计。"
            "建议先回看原始图像，核对类别和目标框是否合理，结合采集时间、地点判断，必要时人工复核或补拍确认后再录入正式记录。"
        )
    net_operation_intent = re.search(
        r"切割|微创|rov|潜水员|操作|指引|标准作业|程序|步骤|方案|sop|细节|怎么做|如何做|怎么处理|如何处理|方法",
        q,
        re.I,
    )
    net_disposal_intent = re.search(r"处置|注意|怎么办|危害|发现|看到|现场|缠绕|打捞", q)
    if (
        not net_operation_intent
        and not re.search(r"清洗|脱盐|再生|利用|回收", q)
        and "渔网" in q
        and net_disposal_intent
    ):
        return (
            "幽灵渔网是指遗失或废弃后仍在海里持续捕捞的渔网，会缠绕海洋生物、损伤珊瑚礁。"
            "发现后先记录位置和周边情况，别直接拖拽——容易造成二次伤害。"
            "正确做法是通知专业团队评估风险，再分段解缠、安全打捞。"
        )
    if "塑料袋" in q and re.search(r"多久|几年|降解|消失", q):
        return (
            "塑料袋在海洋中的’降解时间’其实很难给出准确数字——受温度、光照、材质影响太大了。"
            "而且很多塑料并不是真的消失，只是碎裂成微塑料继续存在。"
            "所以比起纠结’多少年分解’，更重要的是源头减量、及时清理和回收利用。"
        )
    # 快捷咨询的技术追问需要一个可执行、但不虚构设备参数的基线答案。
    # 这些回答只描述通用流程，具体阈值和型号仍要求以现场方案/报告为准。
    if re.search(r"多帧|时序.*跟踪|跨帧", q) and re.search(r"跟踪|追踪|关联", q):
        return (
            "低置信度目标可采用‘检测-跨帧关联-人工复核’的闭环：先在连续帧中保留目标框、时间戳和置信度，"
            "再用位置、外观或运动轨迹把相邻帧关联为同一目标；只有在连续多帧稳定出现时才形成待复核事件。"
            "复核人员应回看原始帧，确认类别、数量和目标框，记录确认/驳回原因；遮挡、剧烈晃动或置信度持续下降时标记为不确定，"
            "不得仅凭单帧结果纳入正式统计。关联窗口和最低置信度应通过本项目验证集校准，不能套用未经验证的固定数值。"
        )
    if re.search(r"去散射|超分辨率", q) and re.search(r"浑浊|泥沙|暗光|深水|检测率|提升", q):
        return (
            "浑浊或暗光环境建议分两步处理：先做图像去散射（颜色偏移与背散射校正），保留一份未经增强的原图作为审计证据；"
            "再用经过验证的超分辨率模型恢复边缘和纹理，并把增强图与原图成对送入检测器。"
            "上线前应在同一海域的标注样本上比较增强前后的召回率、误检率和小目标表现；增强结果只能辅助定位，"
            "不能凭视觉变清晰就把低置信度目标当成确定结论。"
        )
    if re.search(r"微创切割|切割.*标准作业|rov.*切割|潜水员.*切割", q):
        return (
            "幽灵渔网缠珊瑚时，切割应由具备资质的潜水员或 ROV 团队按现场安全方案执行："
            "先设警戒区并记录珊瑚、人员和渔网位置，确认没有被生物继续缠绕；从远离珊瑚、张力较小的网段分段解除，"
            "每切一段就固定和回收，禁止整张拖拽。ROV 操作要持续回传画面，潜水员作业要配置联络、供气和应急撤离方案；"
            "发现强张力、可疑危险物或珊瑚结构不稳定时立即暂停并升级给专业救援单位。具体刀具、切口顺序和潜水参数必须由现场负责人确认。"
        )
    if re.search(r"脱盐清洗|再生颗粒|高值化|渔网.*清洗|渔网.*回收", q):
        return (
            "打捞上岸的尼龙或聚乙烯渔网可按‘隔离-脱盐-分选-破碎-熔融过滤-造粒’处理："
            "先去除贝类、泥沙和危险缠绕物，单独收集含油或受污染材料；用清水充分冲洗并干燥，按尼龙、PE 等材质分开，"
            "再破碎、磁选/人工挑杂、熔融过滤和挤出造粒。再生料用途要依据洁净度、分子量和力学检测结果确定，"
            "不能把不同材质混料直接宣称为高值化产品；清洗废水和筛下微粒也要收集处理，避免二次排放。"
        )
    if re.search(r"无人艇|USV", q) and re.search(r"自主巡航|拦截|漂浮塑料", q):
        return (
            "USV 拦截漂浮塑料可采用‘巡航感知-规划航线-柔性拦截-满载回收’方案："
            "用相机/雷达或声学传感器识别漂浮带，结合风、流和潮汐规划低速巡航；船艏布置可脱离的拦截围栏或导流网，"
            "把垃圾引导到收集舱，达到载荷或安全阈值后返航卸载。靠近人员、珊瑚区和航道时应限速并启用人工接管，"
            "每次任务记录航迹、拦截量、漏拦原因和影像，装置尺寸与吃水需按渤海现场试验确定。"
        )
    if re.search(r"PET.*老化|力学老化|微粒碎裂模型", q):
        return (
            "PET 在海水和紫外辐射下的老化模型可先做分层实验：设置海水浸泡、紫外照射、温度和时间等因素，"
            "定期测量质量、拉伸强度、断裂伸长率、表面裂纹和粒径分布；把紫外氧化与水解造成的强度衰减拟合成时间函数，"
            "再用碎裂产生的粒径/数量数据校准颗粒释放模型。模型必须用独立批次样品验证，并报告不确定性；"
            "没有实测材料、辐照和水文条件时，不应直接给出寿命或碎裂速率数字。"
        )
    if re.search(r"光谱.*(定性|定量)|定性定量.*检测|光谱快速", q) and "微塑料" in q:
        return (
            "微塑料光谱检测通常先标准化采样和过滤，再用显微-FTIR 或显微拉曼按光谱库匹配聚合物类型；"
            "需要定量时用已知粒径、材质和浓度的标准物建立校准曲线，并设置空白、平行样和回收率。"
            "深海沉积物要先去除有机物和矿物干扰，近岸海水则要记录体积、粒径分级和采样深度；"
            "复杂样品可用热裂解-GC/MS 做总量复核。最终结果应同时报告检出限、误差和无法匹配的颗粒比例。"
        )
    if "微塑料" in q and re.search(r"POPs|持久性有机污染物|生物毒性|食物链|富集", q):
        return (
            "微塑料吸附 POPs 后，可能通过摄食进入浮游生物、贝类和鱼类等食物链环节。"
            "污染物在生物体内的吸收、代谢和排出速度不同，才可能出现生物富集或营养级放大；"
            "这不是看到微塑料就能直接断定的结果，还要测定颗粒表面污染物、物种组织浓度、摄食关系和暴露时间。"
            "风险评估应把化学暴露与微塑料本身的物理影响分开，并用现场样品和对照组验证。"
        )
    if re.search(r"记录簿|GRB|防污染证书|海事监管", q, re.I):
        return (
            "检查船舶垃圾管理时，通常要把垃圾记录簿（GRB）与防污染证书、垃圾管理计划和实际留存垃圾相互核对："
            "确认船名/航次、日期、位置和垃圾类别记录完整，塑料等禁止排放项没有虚假排放记录；"
            "核查交岸接收凭证、接收港口和数量是否与记录簿一致，证书是否在有效期内，船员是否按计划分类、暂存和交接。"
            "具体检查清单以船旗国、港口国和适用海域的现行要求为准，不能仅凭一页记录簿认定合规。"
        )
    if "微塑料" in q and re.search(r"危害|影响|人体|健康|是什么|定义|多大|疾病|5mm|5毫米", q):
        return (
            "微塑料通常是指小于5毫米的塑料颗粒或碎片，可能来自塑料制品的磨损碎裂，也可能是直接进入环境的小颗粒。"
            "它会被海洋生物误食，造成物理伤害，也可能携带一些化学物质。"
            "对人体健康的具体影响还在研究中，目前不能说检出微塑料就一定会导致某种疾病，但长期累积的风险需要警惕。"
        )
    if "微塑料" in q and re.search(r"来源|路径|从哪|哪里来|怎么产生|如何产生", q):
        return (
            "海洋微塑料主要有两类来源：一类是塑料袋、包装、渔具等较大塑料在日晒、风浪和磨损下逐步碎裂，"
            "另一类是生产和使用环节中本来就很小的塑料颗粒或纤维进入环境。"
            "具体来源通常要结合河流输入、沿岸生活垃圾、渔业活动和海流输运一起判断；单个样本不能直接断定唯一来源。"
        )
    if re.search(r"海洋垃圾|海洋塑料|塑料垃圾", q) and re.search(r"气候变化|全球变暖|气候", q):
        return (
            "海洋垃圾与气候变化是相互影响、但不能简单等同的两个问题。"
            "一方面，塑料从生产、运输到焚烧或填埋的全生命周期会消耗能源并产生温室气体；"
            "另一方面，风暴、洪水和海平面变化会把陆地垃圾更快带入海洋，也会改变垃圾的漂移路径。"
            "塑料和废弃渔具还会损伤红树林、盐沼、海草床等蓝碳生态系统，削弱其固碳能力。"
            "具体海域的影响方向和大小需要结合垃圾来源、气象水文和生态监测数据判断，不能仅凭一次发现归因。"
        )
    if re.search(r"鲸鱼|鲸类|海豚", q) and re.search(r"搁浅|为什么|原因|救助", q):
        return (
            "鲸类搁浅可能与导航失误、疾病或受伤、极端海况、群体行为以及人类噪声干扰等因素有关，"
            "不同物种和个体的原因并不相同。污染可能是长期压力因素之一，但不能仅凭一次搁浅就断定由污染造成。"
            "现场应保持距离、避免围观和强行拖拽，记录位置与状态并联系当地海洋救助或野生动物主管部门。"
        )
    if (
        re.search(r"声呐|声纳", q, re.I)
        and re.search(r"rfid|射频标签|射频识别", q, re.I)
        and re.search(r"追踪|跟踪|定位|应答器|遗失渔具|渔具", q, re.I)
    ):
        return (
            "可以把两类设备分工使用，形成‘水下定位 + 近距离身份核验’的闭环：\n"
            "1. 建档：为每件高风险渔具建立唯一资产 ID，把 RFID 编码、声呐应答器 ID、渔具类型、布放时间、责任人和许可海域绑定；布放前读取 RFID 并记录母船 GPS、深度和初始状态。\n"
            "2. 定位：声呐应答器按计划发送可识别的水下信号，船载接收机或 ROV 记录时间、位置、深度和信号状态，形成最后已知位置与漂移轨迹。\n"
            "3. 告警：超过约定巡检周期未收到应答、位置越过许可海域或渔具状态异常时，生成遗失告警；告警记录应保留原始声学日志，避免只保存一个人工判断结果。\n"
            "4. 核验与回收：ROV 或潜水员到达目标附近后，用 RFID 在近距离核对资产身份，再拍摄缠绕对象和海底栖息地，按风险分段解缠、回收或原位加固。\n"
            "5. 闭环复盘：回收后更新 RFID 状态、声呐设备状态、处置时间、坐标、影像和责任链，生成从布放到回收的时间线。\n"
            "需要特别注意：普通 RFID 不适合在海水中承担远距离实时定位，海水会明显衰减无线电信号；它更适合出水后或近距离核验。真正的水下长效追踪仍要依赖声呐应答器、接收机和定期巡检。具体频率、续航、通信距离和固定方式必须根据水深、盐度、海流、渔具类型及设备规格现场验证，项目知识库目前没有这些参数。"
        )
    if re.search(r"marpol|船舶.*垃圾|船.*塑料|附则\s*v|塑料垃圾.*(倒|排放).*(海|海里)", q):
        return (
            "MARPOL 是《国际防止船舶造成污染公约》，和船舶垃圾最相关的是附则V：\n"
            "**塑料禁止从船上排放入海**——不能把塑料垃圾倒进海里。\n"
            "其他垃圾要按类别、区域和条件分类管理，配合垃圾管理计划和记录簿。"
            "具体履约还得看船旗国、港口国和适用区域的要求。"
        )
    if re.search(r"海岸.*清理|海滩.*清理|海岸垃圾.*优先|清理.*优先级|海滩.*优先|清理.*方案|治理.*方案|垃圾.*(优先级|怎么处理)|怎么打捞|如何打捞", q):
        return (
            "海岸清理建议按’评估-分区-清理-复测’的流程来：\n"
            "1. 记录坐标、潮汐、水深、垃圾类型和数量\n"
            "2. 优先处理幽灵渔网、大型缠绕物、尖锐金属和可能含油/化学品的垃圾\n"
            "3. 根据风险选人工、船舶或ROV打捞，渔网别直接拖拽\n"
            "4. 现场分拣、称重、拍照记录，疑似危险废物单独隔离\n"
            "5. 清理后沿同一路线复测，对比数量和密度变化\n\n"
            "如果你有具体的检测报告，我可以给出更有针对性的优先级建议。"
        )
    if re.search(r"检测结果|识别结果|报告|污染等级|怎么处理", q):
        # 导入报告到知识库后的咨询放行给RAG链路
        if "报告" in q and (
            re.search(r"导入|上传|知识库|刚才|这份|这个|那个", q)
            or re.search(r"里|中|内|内容|多少|几张|等级|评分|目标|图片|摘要|什么|总结|数量", q)
        ):
            return None
        if re.search(r"降级|风险标注|正式报告|多帧|跟踪|机制|方法|为什么|如何|怎么|分析|解读", q):
            return None
        return (
            "要分析检测结果的话，建议提供这些信息：检测任务编号、识别出的垃圾类别、数量、置信度，或者直接给报告摘要。"
            "我会按’现象-风险-优先级-处置建议’帮你分析。"
            "不过要注意，一张模糊图片 + 低置信度结果不能直接当成确定事实哦。"
        )
    if not is_domain_question(q):
        return SCOPE_RESPONSE
    return None


def _report_context_fallback(message: str, report_context: str) -> Optional[str]:
    """模型门禁失败时，直接从当前绑定的报告/文档快照组织可追溯回答。"""
    if not report_context or not report_context.strip():
        return None
    hash_artifact_re = re.compile(
        r"^.{1,80}\s*[-–—]\s*[a-f0-9]{20,}_?\.(?:jpg|jpeg|png|html|md|txt)$", re.I
    )
    query_terms = _query_terms(message)
    candidates: list[tuple[int, int, str]] = []
    labels = ("风险等级", "污染等级", "关键发现", "可能来源", "处置方案", "后续监测", "摘要", "评分", "目标数量")
    for index, raw in enumerate(re.split(r"(?<=[。！？；])|\n+", report_context)):
        line = re.sub(r"^[-#>*\s]+", "", raw).strip()
        # 风险等级/质量评分等短标签本身就是报告事实，不能因长度短被过滤。
        if len(line) < 4 or hash_artifact_re.search(line):
            continue
        if re.match(r"^(?:报告 ID|导入文档 ID|文件名|报告类型)\s*[：:]", line):
            continue
        overlap = len(query_terms & _query_terms(line))
        label_bonus = sum(20 for label in labels if label in line)
        candidates.append((label_bonus + overlap * 3, -index, line))
    candidates.sort(reverse=True)
    selected: list[str] = []
    total = 0
    for _, _, line in candidates:
        if line in selected or total + len(line) > 1200:
            continue
        selected.append(line)
        total += len(line)
        if len(selected) >= 6:
            break
    if not selected:
        return None
    return (
        "根据当前绑定的报告/文档内容，可以先确认：\n\n"
        + "\n".join(f"- {line}" for line in selected)
        + "\n\n以上内容仅来自当前绑定报告/文档；报告未明确的结论我不会替它补写。"
    )


def _fallback_response(
    message: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> str:
    """兜底响应：绑定报告快照 → 确定性规则 → 知识库检索 → 友好提示。"""
    return (
        _report_context_fallback(message, report_context or "")
        or direct_response(message)
        or _knowledge_fallback(message, evidence)
        or _friendly_unknown(message)
    )


def _friendly_unknown(message: str) -> str:
    """资料不足时给出短、可行动的引导，避免固定句造成重复感。"""
    templates = (
        "哎呀，这个问题我暂时还没找到靠谱的资料，不敢乱说误导你～你补充点信息（比如具体海域、时间、检测数据），我马上帮你查！",
        "呜呜，这个我翻遍知识库也没找到依据，不能瞎编给你。要不试试上方的快捷问题？或者说说你具体想了解哪一块？",
        "这个我目前还真不太确定呢～不过你要是告诉我检测任务编号或报告里的数据，我可以帮你做针对性分析！",
    )
    return templates[sum(ord(ch) for ch in (message or "")) % len(templates)]


async def generate_chat_stream(
    message: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    response = _fallback_response(message, evidence, report_context)
    # 按词组/短句输出，速度自然且不会像逐字符机器人。
    async for piece in stream_text(response):
        yield piece
