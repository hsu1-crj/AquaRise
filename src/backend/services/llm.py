"""Ollama 不可用时的高质量安全兜底。

兜底不是随机闲聊：它只覆盖高频海洋意图、开发者身份和范围边界，
避免服务异常时继续输出答非所问的模板话。
"""
from __future__ import annotations

import ast
import asyncio
import json
import os
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, AsyncGenerator, Optional, Sequence

# 身份/范围类固定文案过去是单条常量：同一问题连问三次得到一字不差的答案，
# 是"机器人感"最强的来源之一。现在每个语义类别提供多个语气变体，
# 由 pick_variant 保证同一类别连续两次调用不会返回同一句；
# 每个变体都保留稳定的"核心事实句"（海瞳 LLM 组负责 LLM、专业范围描述等），
# 便于测试用子串断言而不是全文相等断言。
_IDENTITY_POOL = (
    '我是海瞳平台的海洋守护者～这个项目是海瞳团队一起做的，LLM 这块主要由海瞳 LLM 组负责，'
    '包括模型微调和对话能力升级。有什么海洋环保的问题想聊，随时来。',
    '你好呀！我是海洋守护者，海瞳团队的成员之一——具体到对话这块，是海瞳 LLM 组在负责 LLM 的微调和升级。'
    '想了解检测报告、垃圾分类还是污染治理？',
    '这个问题问到我身上了。我是海瞳平台的 AI 助手"海洋守护者"，项目由海瞳团队开发，'
    '其中 LLM 模块由海瞳 LLM 组负责。海洋环保相关的问题都可以找我聊聊。',
)
_FAMILY_POOL = (
    '哈哈，这个我可答不上——我是 AI 助手，没有生物学意义上的父母或家人。'
    '不过这个项目确实是海瞳团队一起搭的，LLM 模块由海瞳 LLM 组负责。要不聊聊海洋垃圾？这才是我的主场。',
    '被你问住了～我是 AI，没有生物学意义上的父母或家人。'
    '不过海瞳这个"家"倒是有真实分工：团队一起搭建，LLM 模块由海瞳 LLM 组负责开发。有什么海洋环保的事想问吗？',
    '哈哈我没有爸爸妈妈——AI 助手没有生物学意义上的父母或家人。'
    '顺便说一句，这个项目是海瞳团队的成果，LLM 模块归海瞳 LLM 组管。聊聊微塑料或者渔网怎么处理？',
)
_PLATFORM_POOL = (
    '我是海瞳平台的海洋守护者，主要帮你分析水下垃圾检测结果、解读污染风险、回答海洋环保问题——'
    '比如检测报告怎么看、不同垃圾该怎么处理、MARPOL 公约讲了什么。',
    '简单说，我是海瞳平台的海洋守护者：检测结果交给我帮你研判，污染风险帮你解读，'
    '海洋治理和环保知识也可以随时问我。',
    '你可以把我当成海瞳平台的海洋环保顾问（代号"海洋守护者"）：识别结果解读、报告分析、'
    '垃圾分类处置建议，还有微塑料这类科普话题都在我的能力范围内。',
)
_SCOPE_POOL = (
    '这个问题超出我的专业范围了——我主要聚焦在海洋垃圾识别、污染分析和海洋环保政策这块。'
    '换个方向问我检测报告或海洋治理的内容，我会更帮得上忙。',
    '说实话这题我不是行家，我的主场是海洋垃圾、污染分析和海洋环保政策。'
    '要不我们回到这片"海"？有检测数据或治理问题尽管抛过来。',
    '这个我就不太懂了——毕竟我的知识主要泡在海水里：垃圾识别、污染分析、海洋环保政策。'
    '换我擅长的领域问你随便挑。',
)


def pick_variant(key: str, pool: Sequence[str]) -> str:
    """按类别轮换文案变体，保证同一类别连续两次调用拿到不同的句子。"""
    cursor = _VARIANT_CURSOR.get(key, -1)
    nxt = (cursor + 1) % max(1, len(pool))
    _VARIANT_CURSOR[key] = nxt
    return pool[nxt]


_VARIANT_CURSOR: dict[str, int] = {}


def identity_statement() -> str:
    return pick_variant("identity", _IDENTITY_POOL)


def family_statement() -> str:
    return pick_variant("family", _FAMILY_POOL)


def platform_intro() -> str:
    return pick_variant("platform", _PLATFORM_POOL)


def scope_response() -> str:
    return pick_variant("scope", _SCOPE_POOL)


# 领域知识卡的"语气壳"：卡片的结论、数字和边界表述是反幻觉资产，一字不动；
# 只允许在整段末尾追加可轮换的收尾建议——不做开场白改写，
# 因为"纠正前提""给出阈值"这类回答必须保持直给的开头（有回归测试锚定）。
_CARD_CLOSINGS = {
    "info": (
        "还想深入哪一块？相关的来源、危害或处置方式都可以接着问。",
        "如果你是想结合自己的检测数据看这个问题，把报告发我能讲得更具体。",
        "这块知识库里有对应文档，想了解更多细节随时喊我。",
    ),
    "action": (
        "如果你有具体的现场条件或数据，我可以帮你把方案再细化。",
        "实际执行前记得结合海域环境、作业规范和装备条件做校准。",
        "遇到拿不准的场景，先按保守口径处理并完整记录，再升级给专业人员确认。",
    ),
}


def _card_close(kind: str = "info") -> str:
    return pick_variant(f"close-{kind}", _CARD_CLOSINGS[kind])

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
    "pet", "hdpe", "聚合物", "材料", "紫外", "紫外老化", "光氧化", "水解", "耐候", "耐老化", "性能对比",
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
_NAMED_DOCUMENT_RE = re.compile(r"《\s*([^》]{2,60})\s*》")
_UNQUOTED_NAMED_DOCUMENT_RE = re.compile(
    r"[\u4e00-\u9fffA-Za-z0-9·_-]{2,60}(?:国际公约|公约|协议|条例|法规|法案)",
    re.I,
)
_NAMED_DOCUMENT_SUFFIX_RE = re.compile(r"(?:国际)?(?:公约|协议|条例|法规|法案|标准)$", re.I)
_NAMED_DOCUMENT_LEADING_RE = re.compile(
    r"^(?:(?:请问|请|帮我|麻烦|你知道|关于|依据|按照|介绍一下|介绍|概括一下|概括|"
    r"说明一下|说明|查询|核实|了解一下|了解))+",
)


def is_domain_question(message: str) -> bool:
    q = (message or "").strip().lower()
    return any(term.replace(" ", "") in q.replace(" ", "") for term in DOMAIN_TERMS)


_COUNTERFACTUAL_RE = re.compile(
    r"反事实|(?:如果|假如|假设|倘若).{0,32}(?:没有|不存在|消失|停止|不再).{0,48}"
    r"(?:会|将).{0,24}(?:怎样|如何|什么|不同|变化|影响)",
    re.I,
)


def is_counterfactual_question(message: str) -> bool:
    """识别开放反事实推演，不把普通条件式处置问题纳入此门禁。"""
    return bool(_COUNTERFACTUAL_RE.search((message or "").strip()))


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def is_near_duplicate_answer(answer: str, previous_answer: str, threshold: float = 0.88) -> bool:
    """识别原样重发或仅改少量前后缀的上一轮答案。"""
    current = re.sub(r"[^\w\u4e00-\u9fff]+", "", (answer or "").lower())
    previous = re.sub(r"[^\w\u4e00-\u9fff]+", "", (previous_answer or "").lower())
    if len(current) < 20 or len(previous) < 20:
        return bool(current and current == previous)
    return SequenceMatcher(None, current, previous).ratio() >= threshold


def duplicate_follow_up_response(message: str) -> str:
    """重复门禁后的确定性说明：不把旧答案伪装成新答案，并给出可推进的追问方向。"""
    return pick_variant("duplicate", (
        "针对你补充的问题，知识库暂时没有检索到比上一轮更细、可核验的新依据——"
        "与其把上一段换个说法再发一遍，不如我们往前走一步：你可以补充具体的对象、海域或想核对的条款，我按这些条件重新查。",
        "这轮的答案和上一轮的核心内容是一致的，知识库里目前没有新的证据支撑出不同结论。"
        "如果你觉得哪里没说清，指出来我再展开；或者换个角度问，比如具体到某种垃圾、某个海域。",
        "我又核对了一遍知识库，得到的依据还是上一轮那些，没有更细的新材料。"
        "硬要复述一遍对你没什么帮助——补充点约束条件（材质、地点、数量）再来一轮会更有收获。",
    ))


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


def _named_document_entities(message: str) -> list[str]:
    """提取书名号内或直接写出的法规、公约、协议和标准专名。"""
    entities: list[str] = []
    candidates = list(_NAMED_DOCUMENT_RE.findall(message or ""))
    candidates.extend(_UNQUOTED_NAMED_DOCUMENT_RE.findall(message or ""))
    for raw in candidates:
        entity = _NAMED_DOCUMENT_LEADING_RE.sub("", raw.strip())
        if _NAMED_DOCUMENT_SUFFIX_RE.search(entity) and entity not in entities:
            entities.append(entity)
    return entities


def _unsupported_named_entities(
    message: str, evidence: Sequence[dict[str, Any]]
) -> list[str]:
    """返回未被任何证据原文直接支持的文书专名。"""
    evidence_compact = _compact(_evidence_text(evidence)).lower()
    missing: list[str] = []
    for entity in _named_document_entities(message):
        normalized = _compact(entity).lower()
        core = _NAMED_DOCUMENT_SUFFIX_RE.sub("", normalized)
        if normalized not in evidence_compact and (len(core) < 4 or core not in evidence_compact):
            missing.append(entity)
    return missing


def _missing_named_document_response(entities: Sequence[str]) -> str:
    names = "、".join(f"《{entity}》" for entity in entities)
    return (
        f"项目知识库中没有查到{names}的记录，无法确认该文件是否真实存在，"
        "也无法核实所谓修订版或主要条款，因此不能用其他资料替它作答。"
        "当前知识库实际包含的相关主题有：MARPOL附则V、海洋环境保护法律法规、"
        "海洋垃圾监测与清理评估、海洋塑料治理。若能提供正式发布机构或原文，我可以继续核对。"
    )


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


def _has_material_microplastic_confusion(text: str) -> bool:
    """材质可以形成微塑料，但材质名称本身不等于粒径类别。"""
    material = r"(?:pet|hdpe|ldpe|pvc|pp|ps|聚对苯二甲酸乙二醇酯|高密度聚乙烯)"
    equivalence = r"(?:就是|等同于|等于|是一种|属于)"
    for sentence in re.split(r"[。！？!?；;\n]+", (text or "").lower()):
        if not re.search(
            rf"{material}.{{0,10}}{equivalence}.{{0,8}}微塑料|微塑料.{{0,10}}{equivalence}.{{0,8}}{material}",
            sentence,
            re.I,
        ):
            continue
        if re.search(r"碎片|颗粒|纤维|粒径|小于\s*5\s*(?:毫米|mm)|尺寸", sentence, re.I):
            continue
        return True
    return False


def _has_counterfactual_uncertainty_structure(text: str) -> bool:
    compact = _compact(text)
    return (
        bool(re.search(r"较确定|相对确定|可以确定", compact))
        and bool(re.search(r"推测|可能|倾向", compact))
        and bool(re.search(r"不确定|不能断定|取决于|仍需", compact))
    )


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
    if _has_material_microplastic_confusion(raw):
        return False
    if is_counterfactual_question(question) and not _has_counterfactual_uncertainty_structure(raw):
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
        # 引用强制开关的默认值已放开：主链路由 requires_citations(question) 决定，
        # 只有报告/法规/统计类问题才逐段要求 [S编号]；科普回答不再因格式被整段替换。
        require = (
            os.getenv("LLM_REQUIRE_CITATIONS", "false").strip().lower() in {"1", "true", "yes", "on"}
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
        # 篇幅上限从 800 放宽到 1100：这是形式层检查，误杀完整的长科普答案得不偿失。
        if len(text) > 1100:
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
    # 必需要素表从"缺一项即整段否决"降级为分层处置：硬幻觉特征（编造数字/机构/事件）
    # 仍然单独一票否决；这里只累计形式层缺失，缺 2 项以上才判定为答非所问走兜底。
    missing_required = 0
    for topic, terms in critical_terms.items():
        if topic in q_lower and not any(term in text for term in terms):
            missing_required += 1
    if missing_required >= 2:
        return False

    # 拦截违反核心知识边界的结论
    if "marpol" in q_lower and re.search(r"(允许|可以|能够).{0,12}(塑料|垃圾).{0,12}(倒|排放).{0,8}(海|海里)", text):
        return False

    return True


def _trim_to_complete_sentence(text: str, max_chars: int = 700) -> str:
    """把可能停在不完整处的答案裁到最近的句末，保留可读性。"""
    trimmed = text.strip()
    if len(trimmed) <= max_chars:
        return trimmed if re.search(r"[。！？!?；;]\s*$", trimmed) else trimmed
    cut = trimmed[:max_chars]
    ends = [m.end() for m in re.finditer(r"[。！？!?；;]", cut)]
    return cut[:ends[-1]] if ends else cut


def _patch_with_evidence(
    question: str, model_answer: str, evidence: Optional[Sequence[dict[str, Any]]]
) -> Optional[str]:
    """门禁未通过但模型原文没有硬幻觉时的中间层：保留原文主体，
    附上两条可直接核验的知识库要点，替代过去"整段替换为拼贴摘录"的做法。"""
    raw = (model_answer or "").strip()
    cleaned = _strip_think(raw)
    if not evidence or len(_compact(cleaned)) < 60:
        return None
    # 硬幻觉（无依据数字/机构/事件）不适用拼接层——那种内容一个字都不能留。
    if _has_unsupported_facts(cleaned, question, evidence):
        return None
    if not _has_substantive_evidence_overlap(question, evidence):
        return None
    excerpt_lines, _sources = _evidence_excerpt(question, evidence)
    if not excerpt_lines:
        return None
    top_lines = [f"- [S{source_id}] {sentence}" for source_id, sentence in excerpt_lines[:2]]
    supplement = "\n".join(top_lines)
    return (
        f"{_trim_to_complete_sentence(cleaned)}\n\n"
        f"另外补充两点可以直接核验的要点：\n{supplement}"
    )


def finalize_model_answer(
    question: str,
    model_answer: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> str:
    """统一模型后处理：净化后须通过质量门禁；形式层擦伤优先走"原文+证据补丁"，
    只有硬幻觉或完全跑题才落到可追溯兜底链。"""
    cleaned = _strip_think(model_answer)
    if is_acceptable_model_answer(cleaned, question, evidence, require_citations=requires_citations(question)):
        return cleaned
    patched = _patch_with_evidence(question, model_answer, evidence)
    if patched and is_acceptable_model_answer(patched, question, evidence, require_citations=False):
        return patched
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
    "pet", "hdpe", "聚合物", "材料", "紫外", "老化", "光氧化", "水解", "耐候", "性能", "对比",
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
    if _unsupported_named_entities(message, evidence):
        return False
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


def _evidence_excerpt(
    message: str, evidence: Sequence[dict[str, Any]]
) -> tuple[list[tuple[int, str]], list[str]]:
    """挑选与问题最相关的证据句。

    返回 (lines, sources)：lines 为 [(来源编号, 原句)]，sources 为涉及文档名列表。
    排版由调用方决定——报告类保留逐行 [S编号]，科普类可拼成自然段落。
    """
    query_terms = _query_terms(message)
    action_query = bool(re.search(r"治理|措施|处理|清理|怎么做|如何|建议|流程", message))
    action_terms = ("源头", "减量", "拦截", "清理", "回收", "复测", "监测", "记录", "评估", "管理")
    intent_query = bool(_REPORT_INTERPRETATION_INTENT_RE.search(message or ""))
    intent_terms = ("降级", "风险标注", "标注")
    hash_artifact_re = re.compile(
        r"^.{1,80}\s*[-–—]\s*[a-f0-9]{20,}_?\.(?:jpg|jpeg|png|html|md|txt)$", re.I
    )
    candidates: list[tuple[int, int, str, int]] = []
    for item_index, item in enumerate(evidence[:2]):
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
            candidates.append((overlap + source_bonus + action_bonus + intent_bonus, -part_index, sentence, item_index + 1))
    candidates.sort(reverse=True)
    selected: list[tuple[int, str]] = []
    seen_sentences: set[str] = set()
    sources: list[str] = []
    total = 0
    for _, _, sentence, source_id in candidates:
        if sentence in seen_sentences or total + len(sentence) > 650:
            continue
        seen_sentences.add(sentence)
        selected.append((source_id, sentence))
        total += len(sentence)
        if len(selected) >= 4:
            break
    items_by_id = {index + 1: evidence[index] for index in range(min(len(evidence), 2))}
    for source_id, _sentence in selected:
        item = items_by_id.get(source_id, {})
        source = str(item.get("source") or (item.get("metadata") or {}).get("source") or "项目知识库")
        if source not in sources:
            sources.append(source)
    return selected, sources


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
            missing_entities = _named_document_entities(message)
            return _missing_named_document_response(missing_entities) if missing_entities else None
    missing_entities = _unsupported_named_entities(message, results)
    if missing_entities:
        return _missing_named_document_response(missing_entities)
    if not results:
        named_entities = _named_document_entities(message)
        return _missing_named_document_response(named_entities) if named_entities else None
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
    excerpt_lines, _excluded_sources = _evidence_excerpt(message, results)
    if not excerpt_lines:
        return None
    excerpt_text = "\n".join(sentence for _, sentence in excerpt_lines)
    # 操作型问题不能用同一 chunk 里的定义/背景句冒充操作指引；
    # 摘录本身也必须出现对应动作词，否则返回资料不足模板。
    if re.search(
        r"切割|微创|rov|潜水员|去散射|超分辨率|多帧|跟踪|追踪|机制|标准作业|sop|步骤|流程|方法|操作",
        message,
        re.I,
    ) and not re.search(
        r"切割|微创|rov|潜水员|去散射|超分辨率|多帧|跟踪|追踪|机制|标准作业|sop|步骤|流程|方法|操作|解缠",
        excerpt_text,
        re.I,
    ):
        return None
    # 多帧跟踪是组合机制，摘录也必须保留组合句，不能只摘 ROV/置信度等邻近背景。
    if re.search(r"多帧|时序|跨帧", message, re.I) and re.search(r"跟踪|追踪|关联", message, re.I):
        sentences = re.split(r"(?<=[。！？；.!?;])|\n+", excerpt_text)
        if not (
            re.search(r"多帧\s*(?:跟踪|追踪)|时序\s*(?:跟踪|追踪)|跨帧\s*关联", excerpt_text, re.I)
            or any(
                re.search(r"帧|多帧", sentence, re.I)
                and re.search(r"跟踪|追踪|关联", sentence, re.I)
                for sentence in sentences
            )
        ):
            return None

    def display_source(name: str) -> str:
        return re.sub(r"\.(md|markdown)$", "", name) or name

    items_by_id = {index + 1: results[index] for index in range(min(len(results), 2))}
    doc_names: list[str] = []
    referenced_docs: dict[int, str] = {}
    for source_id, _sentence in excerpt_lines:
        item = items_by_id.get(source_id, {})
        raw_source = str(item.get("source") or (item.get("metadata") or {}).get("source") or "")
        name = display_source(raw_source) if raw_source else "项目知识库"
        referenced_docs.setdefault(source_id, name)
        if name not in doc_names:
            doc_names.append(name)

    if requires_citations(message):
        # 报告/法规/统计类：保留逐行编号的审稿式排版，便于人工核对每条依据。
        # 脚注按正文实际引用的编号逐一列出，保证 [Sx] 与来源一一对应。
        cite_body = "\n".join(f"- [S{source_id}] {sentence}" for source_id, sentence in excerpt_lines)
        cited_sources = "、".join(
            f"[S{source_id}] {referenced_docs[source_id]}" for source_id in sorted(referenced_docs)
        ) or "项目知识库"
        opening = pick_variant(
            "kb-cite-open",
            ("根据项目知识库中与这个问题最相关的资料，可以确认：", "知识库里能直接支撑回答的依据如下："),
        )
        return (
            f"{opening}\n\n{cite_body}\n\n"
            f"资料来源：{cited_sources}。"
            "如果你有具体的检测数据（比如地点、垃圾类型、数量、置信度），我可以给出更针对性的建议。"
        )

    # 科普类：摘录拼成自然段落 + 单一来源脚注 + 可轮换引导语，
    # 不再逐行挂 [S]——这条路径本是模型不可用/被拦时的保底，不宜再用审稿脸。
    prose = "".join(sentence for _, sentence in excerpt_lines).strip()
    asks_for_risk_judgement = bool(re.search(
        r"值得.{0,4}(?:警惕|担心|关注)|(?:需要|要不要).{0,4}(?:警惕|担心|注意)|"
        r"(?:危险|有害|严重|可怕)吗",
        message,
        re.I,
    ))
    has_risk_basis = bool(re.search(
        r"释放|迁移|暴露|风险|危害|毒|检出|摄入|累积|影响",
        excerpt_text,
        re.I,
    ))
    if asks_for_risk_judgement and has_risk_basis:
        lead = "值得警惕，但不必恐慌。风险高低取决于具体材料、接触条件和实际暴露水平，不能只凭‘检出’就断定一定会造成伤害。"
    else:
        lead = pick_variant("kb-prose-open", (
            "这个话题项目档案里有直接对应的说法，帮你把要点理一下：",
            "翻了翻海瞳的知识库，和你的问题对得上的内容是这些——",
            "先给你一个基于档案资料的可靠版本：",
        ))
    tail = pick_variant("kb-prose-close", (
        "想再往下挖的话，告诉我你关注的具体场景或数据，我接着讲。",
        "如果你手头有检测报告或具体海域信息，我可以把这份解释落得更细。",
        "上面只是档案里的保守口径；补充时间、地点或对象，我能答得更准。",
    ))
    attribution = f"（依据：{'、'.join(doc_names)}）" if doc_names else ""
    return f"{lead}\n\n{prose}\n\n{attribution}{tail}"


def stream_text(text: str) -> AsyncGenerator[str, None]:
    """把已通过质量检查的完整答案以短句输出，保持前端阅读节奏。"""
    async def _stream() -> AsyncGenerator[str, None]:
        pieces = re.findall(r"[^，。！？；：,!?;: ]+[，。！？；：,!?;: ]*", text) or [text]
        for piece in pieces:
            await asyncio.sleep(0.025)
            yield piece
    return _stream()


def _format_number(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.10g}"


_CHINESE_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3,
    "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


def _parse_chinese_number(text: str) -> Optional[float]:
    """解析百分比中常见的 0–100 中文数字，不承担通用中文数词转换。"""
    value = (text or "").strip().replace("两", "二")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    if "点" in value:
        integer_text, decimal_text = value.split("点", 1)
        integer = _parse_chinese_number(integer_text or "零")
        if integer is None or not decimal_text or any(char not in _CHINESE_DIGITS for char in decimal_text):
            return None
        decimal = "".join(str(_CHINESE_DIGITS[char]) for char in decimal_text)
        return integer + float(f"0.{decimal}")
    if value == "一百":
        return 100.0
    if "十" in value:
        tens_text, ones_text = value.split("十", 1)
        tens = 1 if not tens_text else _CHINESE_DIGITS.get(tens_text)
        ones = 0 if not ones_text else _CHINESE_DIGITS.get(ones_text)
        if tens is None or ones is None:
            return None
        return float(tens * 10 + ones)
    if len(value) == 1 and value in _CHINESE_DIGITS:
        return float(_CHINESE_DIGITS[value])
    return None


def _percentage_values(text: str) -> list[float]:
    """按原句顺序提取 60%、六成、百分之六十等比例。"""
    pattern = re.compile(
        r"(?P<arabic>\d+(?:\.\d+)?)\s*%"
        r"|百分之(?P<chinese>[零〇一二三四五六七八九十百两点\d.]+)"
        r"|(?P<tenths>[零〇一二三四五六七八九十两点\d.]+)成"
    )
    values: list[float] = []
    for match in pattern.finditer(text):
        if match.group("arabic") is not None:
            percent = float(match.group("arabic"))
        elif match.group("chinese") is not None:
            parsed = _parse_chinese_number(match.group("chinese"))
            if parsed is None:
                continue
            percent = parsed
        else:
            parsed = _parse_chinese_number(match.group("tenths"))
            if parsed is None:
                continue
            percent = parsed * 10
        if 0 <= percent <= 100:
            values.append(percent / 100)
    return values


def _deterministic_percentage_response(message: str) -> Optional[str]:
    """求解“基础量 × 占比 × 占比”题；统计陈述没有求值意图时不抢答。"""
    text = (message or "").strip().lower()
    if not re.search(r"(?:重|重量|质量|数量|合计|一共|总共)?多少(?:吨|千克|公斤|克)?|(?:有)?几(?:吨|千克|公斤|克)|求(?:出|得)?|计算(?:出|一下)?|等于多少|是多少", text):
        return None
    base_match = re.search(r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>吨|千克|公斤|克)", text)
    percentages = _percentage_values(text)
    if not base_match or not percentages:
        return None

    base = float(base_match.group("value"))
    result = base
    for ratio in percentages:
        result *= ratio
    chain = "×".join(
        [_format_number(base), *[f"{_format_number(ratio * 100)}%" for ratio in percentages]]
    )
    unit = base_match.group("unit")
    return (
        f"{chain} = {_format_number(result)}{unit}。"
        "这是按题目给出的总量和占比逐级相乘得到的结果；这类确定性计算我可以直接完成，"
        "更主要的专业范围仍是海洋垃圾与污染分析。"
    )


_UNIT_ALIASES = {
    "海里": "海里",
    "公里": "公里",
    "千米": "公里",
    "米": "米",
    "节": "节",
    "公里每小时": "公里/小时",
    "千米每小时": "公里/小时",
    "公里/小时": "公里/小时",
    "千米/小时": "公里/小时",
    "吨": "吨",
    "千克": "千克",
    "公斤": "千克",
}
_UNIT_FACTORS = {
    ("海里", "公里"): 1.852,
    ("海里", "米"): 1852.0,
    ("公里", "海里"): 1 / 1.852,
    ("米", "海里"): 1 / 1852.0,
    ("节", "公里/小时"): 1.852,
    ("公里/小时", "节"): 1 / 1.852,
    ("吨", "千克"): 1000.0,
    ("千克", "吨"): 1 / 1000.0,
}


def _marine_unit_conversion_response(message: str) -> Optional[str]:
    """只处理平台常用的海洋距离、航速和质量换算。"""
    text = re.sub(r"\s+", "", (message or "").strip().lower())
    if not re.search(r"等于多少|相当于多少|换算(?:成|为)?|是多少", text):
        return None
    unit_pattern = "|".join(sorted((re.escape(unit) for unit in _UNIT_ALIASES), key=len, reverse=True))
    match = re.search(
        rf"(?P<value>\d+(?:\.\d+)?)(?P<source>{unit_pattern})"
        rf"(?:等于|相当于|换算成|换算为|换算)(?:多少)?(?P<target>{unit_pattern})",
        text,
    )
    if not match:
        return None
    source = _UNIT_ALIASES[match.group("source")]
    target = _UNIT_ALIASES[match.group("target")]
    factor = _UNIT_FACTORS.get((source, target))
    if factor is None:
        return None
    value = float(match.group("value"))
    result = value * factor
    return (
        f"{_format_number(value)}{source} = {_format_number(result)}{target}。"
        "这是海洋作业中常用的固定单位换算；其他专业判断仍需结合具体海域和检测条件。"
    )


def _marine_safety_response(message: str) -> Optional[str]:
    """覆盖少量高频海边险情，给出保守自救步骤而不替代现场救援。"""
    q = (message or "").strip().lower()
    if re.search(r"离岸流|裂流|rip\s*current", q, re.I):
        return (
            "遇到离岸流时先保持镇定、保存体力，不要逆流直接往岸上硬游。"
            "能游动时沿着与海岸线平行的方向离开狭窄水流，再借助海浪斜向返回岸边；"
            "如果暂时游不出，就漂浮或踩水并挥手、呼救。看到他人遇险时应先通知救生员并投递漂浮物，"
            "不要在没有救生装备的情况下贸然下水。遇紧急情况立即呼叫当地专业救援。"
        )
    if re.search(r"涨潮|潮水", q) and re.search(r"被困|困住|回不去|礁石|岩石|洞穴", q):
        return (
            "涨潮受困时应立即离开低洼处，转移到稳固、不会被继续淹没的高处，不要冒险涉水、跳岩或盲目游回岸边。"
            "尽快联系救生员、海警或当地应急部门，说明人数和所在位置（可见地标、手机定位），并保持通信和保暖；"
            "若能看到救援人员，用醒目物品或灯光示意。遇紧急情况立即呼叫当地专业救援。"
        )
    if "水母" in q and re.search(r"蜇|蛰|刺|伤|怎么办|处理", q):
        return (
            "水母蜇伤后先安全离水，不要揉搓伤处；可戴手套或隔着塑料袋、毛巾，用钝边工具小心移除可见触手，"
            "没有工具时可先用海水轻柔冲走残留物。随后用不烫伤皮肤、人体可耐受的热水浸泡伤处约20分钟或至疼痛缓解。"
            "醋是否适用与水母种类和当地指引有关，不宜一概而论。若出现呼吸困难、意识异常、全身反应，"
            "或蜇伤位于面颈部、致伤生物不明，属于紧急情况，应立即呼叫当地专业救援和急救服务。"
        )
    return None


def _low_confidence_direct_response(message: str) -> Optional[str]:
    """识别 0.6/60% 等低置信度表达，并把平台处置结论放在首句。"""
    q = re.sub(r"\s+", "", (message or "").strip().lower())
    if not re.search(r"置信度|可信度|把握", q) or not re.search(r"怎么处理|如何处理|怎么办|能否|是否|统计|上报|复核", q):
        return None
    match = re.search(
        r"(?:置信度|可信度|把握)(?:只有|仅有|为|是|约|达到)?"
        r"(?P<value>\d+(?:\.\d+)?)(?P<percent>%)?",
        q,
    )
    if not match:
        return None
    raw_value = float(match.group("value"))
    score = raw_value / 100 if match.group("percent") else raw_value
    if not 0 <= score < 0.7:
        return None
    shown = f"{_format_number(raw_value)}%" if match.group("percent") else _format_number(raw_value)
    return (
        f"{shown}属于低置信度：建议人工复核，不作为正式统计依据。"
        "它不能直接当成确定结论来统计；应先回看原始图像或视频，核对类别、目标框和图像质量，"
        "必要时结合连续帧或补采样确认，并记录复核后的确认或驳回结果。"
    )


def _safe_arithmetic_value(expression: str) -> Optional[float]:
    """只计算数字、括号和四则运算，拒绝名称、调用、幂等其他 AST 节点。"""
    if not expression or len(expression) > 80:
        return None
    try:
        tree = ast.parse(expression, mode="eval")
    except (SyntaxError, ValueError):
        return None

    def evaluate(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return evaluate(node.body)
        if isinstance(node, ast.Constant) and type(node.value) in {int, float}:
            return float(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.Add):
                value = left + right
            elif isinstance(node.op, ast.Sub):
                value = left - right
            elif isinstance(node.op, ast.Mult):
                value = left * right
            else:
                value = left / right
            if abs(value) > 1e15:
                raise ValueError("结果过大")
            return value
        raise ValueError("不支持的表达式")

    try:
        return evaluate(tree)
    except (ValueError, ZeroDivisionError, OverflowError):
        return None


def _deterministic_math_response(message: str) -> Optional[str]:
    """覆盖基础四则运算和标准鸡兔同笼题，不把任意文本交给 eval。"""
    text = (message or "").strip().lower()
    if "鸡兔同笼" in text:
        heads_match = re.search(r"(?:共|有)?\s*(\d+)\s*(?:个|只)?头", text)
        legs_match = re.search(r"(\d+)\s*(?:只|条|个)?(?:脚|腿)", text)
        if heads_match and legs_match:
            heads, legs = int(heads_match.group(1)), int(legs_match.group(1))
            rabbits_twice = legs - 2 * heads
            if rabbits_twice >= 0 and rabbits_twice % 2 == 0:
                rabbits = rabbits_twice // 2
                chickens = heads - rabbits
                if chickens >= 0:
                    return (
                        f"鸡{chickens}只，兔{rabbits}只。设兔为 x，则 4x + 2×({heads}-x) = {legs}，"
                        f"解得 x={rabbits}；再用总头数相减得到鸡{chickens}只。"
                        "这类基础方程我可以直接计算；更主要的专业范围仍是海洋垃圾与污染分析。"
                    )

    expression = text.replace("×", "*").replace("÷", "/").replace("（", "(").replace("）", ")")
    expression = re.sub(r"请问|帮我算(?:一下)?|计算(?:一下)?|等于多少|是多少|结果(?:是)?", "", expression)
    expression = expression.strip(" =？?。！!，,")
    if not re.fullmatch(r"[\d.()+\-*/\s]+", expression) or not re.search(r"[+\-*/]", expression):
        return None
    value = _safe_arithmetic_value(expression)
    if value is None:
        return None
    return (
        f"{expression.replace('*', '×').replace('/', '÷')} = {_format_number(value)}。"
        "这类基础四则运算我可以直接计算；更主要的专业范围仍是海洋垃圾与污染分析。"
    )


# 这些特征出现在卡片末段时，说明它自带免责/校准收尾（安全、法规类），不再叠第二层收尾句；
# 兜底摘录(_knowledge_fallback)、报告快照等结构化输出也不二次包装。
_CARD_TAIL_SKIP_RE = re.compile(
    r"以[^。，]{0,12}为准|必须由现场负责人确认|不能(?:直接)?套[用固]|不得仅凭单帧"
    r"|项目知识库目前没有这些参数|马上帮你查|随时来找我|有什么想了解的吗"
    r"|检出.{0,8}不等于.{0,12}(?:伤害|危害)|基于当前物种档案|当前档案给出的核心原因",
)
_STYLE_EXEMPT_MARKER = (
    "根据项目知识库中与这个问题最相关的资料",
    "根据当前绑定的报告/文档内容",
    "基于当前物种档案",
    "当前档案给出的核心原因",
)


def _apply_card_style(text: str) -> str:
    """给长领域知识卡追加可轮换的收尾建议；短句、话术池输出和带免责尾段的原文保持原样。"""
    if not text or len(text) < 90 or any(marker in text for marker in _STYLE_EXEMPT_MARKER):
        return text
    # 身份/家人/平台/越界/重复拒答这些已经走各自的变体池，不再二次包装。
    for pool in (_IDENTITY_POOL, _FAMILY_POOL, _PLATFORM_POOL, _SCOPE_POOL):
        if text in pool:
            return text
    if _CARD_TAIL_SKIP_RE.search(text[-120:]):
        return text
    is_action = bool(re.search(r"建议|流程|步骤|方案|处理|清理|执行|作业|操作|复核|拍摄", text))
    return f"{text}\n\n{_card_close('action' if is_action else 'info')}"


def direct_response(message: str) -> Optional[str]:
    """确定性直答的公开入口：核心命中后统一追加语气壳，让重复知识点的表达不完全相同。"""
    atlas_answer = _atlas_species_context_response(message)
    if atlas_answer:
        return atlas_answer
    answer = _direct_response_core(message)
    return _apply_card_style(answer) if answer else None


_ATLAS_SPECIES_CONTEXT_RE = re.compile(
    r"【当前浏览物种】\s*(?P<cn>[^/｜\n]+?)\s*/\s*(?P<en>[^/｜\n]+?)\s*/\s*"
    r"(?P<latin>[^｜\n]+?)\s*｜IUCN：\s*(?P<code>[^·｜\n]+?)\s*·\s*"
    r"(?P<status>[^｜\n]+?)\s*｜简介：\s*(?P<story>[^\n]+?)\s*\n我的问题：\s*(?P<question>.+)$",
    re.S,
)


def _atlas_species_context_response(message: str) -> Optional[str]:
    """只依据生命图谱随请求携带的当前档案回答，避免通用 RAG 抢答成别的物种。"""
    match = _ATLAS_SPECIES_CONTEXT_RE.search((message or "").strip())
    if not match:
        return None
    data = {key: value.strip() for key, value in match.groupdict().items()}
    cn, code, status = data["cn"], data["code"].upper(), data["status"]
    story = data["story"].rstrip("，,；;：: ")
    if not re.search(r"[。！？!?]$", story):
        story += "。"
    question = data["question"].lower()
    actions: list[str] = []
    if re.search(r"刺网|渔网|渔具|兼捕|捕捞", story):
        actions.append(
            "选择来源可追溯、采用减缓兼捕措施的海产品，不购买与非法捕捞相关的野生动物制品，"
            "并妥善处置钓线和渔具"
        )
    if re.search(r"船舶|撞击|航运|航道", story):
        actions.append("参与观鲸或近海航行时遵守减速要求和安全距离，并支持船舶预警与避让措施")
    if re.search(r"塑料|垃圾|误食|污染", story):
        actions.append("减少一次性塑料，分类回收并阻止垃圾进入河流和海岸")
    if re.search(r"猎杀|捕鲸|贸易|鱼翅|制品", story):
        actions.append("拒绝购买相关野生动物制品，不为非法贸易提供需求")
    if re.search(r"栖息地|珊瑚|红树林|海草|繁殖地", story):
        actions.append("减少对栖息地的踩踏和干扰，参与来源可靠的海岸与栖息地保护行动")
    if not actions:
        actions.append("不追逐、投喂或触碰野生动物，并支持来源可靠的物种保护与监测项目")
    action = (
        "针对档案里提到的威胁，普通人能做的是："
        + "；".join(actions)
        + "。发现搁浅、受伤或缠绕个体时，应保持距离并联系当地渔政或专业救护机构。"
    )

    if code == "EX" or "灭绝" in status:
        return (
            f"{cn}已被标记为 {code}·{status}。基于当前物种档案：{story}"
            "它已经不能靠保护行动恢复种群，但这份档案仍能帮助我们识别导致灭绝的压力，避免相同风险落到现存物种上。"
        )
    if re.search(r"生存现状|目前.*(?:状况|状态)|主要威胁|介绍", question) and re.search(
        r"保护|普通人|行动", question
    ):
        return (
            f"{cn}目前处于 {code}·{status}。基于当前物种档案，核心情况是：{story}"
            f"{action}"
        )
    if re.search(r"为什么.{0,4}(?:濒危|危险)|濒危.{0,4}(?:原因|因素)", question):
        return (
            f"当前档案给出的核心原因很明确：{story}"
            f"这也是它被列为 {code}·{status} 的直接背景；档案没有提供的数量或时间点，我不会替它补写。"
        )
    if re.search(r"垃圾|塑料|渔网|渔具|缠绕", question):
        if re.search(r"刺网|渔网|渔具|兼捕|缠绕|塑料|垃圾", story):
            return (
                f"对{cn}来说，当前档案明确提到的相关压力是：{story}"
                "其中废弃或遗失渔具会增加缠绕与误捕风险；至于塑料摄入等其他影响，当前档案没有数据，不能直接下结论。"
            )
        return (
            f"当前档案没有把海洋垃圾列为{cn}的核心威胁，已确认的信息是：{story}"
            "一般性的缠绕或误食风险不能替代这个物种的实测证据，因此这里不作过度推断。"
        )
    if re.search(r"我能|普通人|怎么保护|保护行动|能做什么", question):
        return f"当前档案显示：{story}{action}"
    return None


def _direct_response_core(message: str) -> Optional[str]:
    """为身份、证据边界和高风险海洋题提供稳定的确定性答案。

    这不是替代 RAG，而是防止 1.5B 基座在项目事实、法规禁令和检测阈值上自由发挥。
    未命中的垂直领域问题仍会进入"RAG → Ollama → 质量门禁"链路。
    """
    q = (message or "").strip().lower()
    if not q:
        return "你好呀，有什么想了解的海洋环保话题吗？比如检测报告、垃圾分类或者污染治理。"

    if re.search(r"爸爸|父亲|母亲|妈妈|父母|家人|家长|你爸|你爹|老爸|老妈|亲爹", q):
        return family_statement()
    if re.search(r"谁开发|开发者|项目作者|作者|谁做的|谁创建|项目是谁|谁制作|谁写的|谁设计|制作者|创始人|开发这个项目|aquarise.*作者", q):
        return identity_statement()
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
    if (
        requires_citations(message)
        and re.search(r"添加剂|增塑剂|阻燃剂|稳定剂|化学物质", q)
        and re.search(r"警惕|担心|关注|危险|有害|严重", q)
    ):
        # 报告/统计混合意图必须保留具体数值与引用，不能被通用风险卡抢答。
        return None
    if (
        re.search(r"塑料|微塑料", q)
        and re.search(r"添加剂|增塑剂|阻燃剂|稳定剂|化学物质", q)
        and re.search(r"值得.{0,4}(?:警惕|担心|关注)|(?:需要|要不要).{0,4}(?:警惕|担心|注意)|(?:危险|有害|严重)吗", q)
        and not requires_citations(message)
    ):
        return (
            "值得警惕，但不必恐慌。塑料中的增塑剂、阻燃剂、稳定剂等，在特定条件下可能迁移或释放。"
            "风险高低取决于聚合物类型、温度、接触介质、时间和实际暴露水平；"
            "‘检出’不等于一定会造成健康伤害。"
        )
    safety_response = _marine_safety_response(message)
    if safety_response:
        return safety_response
    confidence_response = _low_confidence_direct_response(message)
    if confidence_response:
        return confidence_response
    percentage_response = _deterministic_percentage_response(message)
    if percentage_response:
        return percentage_response
    conversion_response = _marine_unit_conversion_response(message)
    if conversion_response:
        return conversion_response
    math_response = _deterministic_math_response(message)
    if math_response:
        return math_response
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
        return platform_intro()
    if re.search(r"天气|股票|写代码|编程|写程序|游戏|小说|笑话|算命|新闻|影视|家庭作业|作业题|写作业", q):
        return scope_response()

    # 以下是核心专业知识，需要保持权威性但可以更亲和
    if re.search(r"(?:你|您).{0,4}(?:刚才|前面|上一轮).{0,8}3\s*年.{0,8}(?:降解|分解).{0,4}(?:完|掉)", q) and re.search(r"对吗|是不是|没错吧|正确吗", q):
        return (
            "不对，我需要纠正这个前提：如果你指的是上一轮的塑料饮料瓶，常见海洋垃圾科普估算约为450年，"
            "不是3年。这个数值只是长期环境持留的数量级，并非适用于所有海域的精确寿命；"
            "很多塑料还会先碎裂成微塑料，而不是真正完全消失。"
        )
    if re.search(r"a\s*/\s*b\s*/\s*c|abc", q, re.I) and re.search(r"网格|分区|清理优先", q):
        return (
            "这里的 A/B/C 应理解为项目作业中的清理优先级，不是通用法规规定的‘面积/距离/时间’三种网格。"
            "可先把垃圾堆积密度、生态脆弱度和可安全作业的潮汐窗口叠加到同一空间网格，再分三级："
            "A级为高优先级，适用于垃圾密集、存在缠绕或危险物，或生态敏感且错过潮汐窗口会扩大风险的区域，应在最近的安全窗口组织专业清理；"
            "B级为中优先级，适用于密度或生态风险居中、短期内相对稳定的区域，可排入近期计划并复核；"
            "C级为低优先级，适用于垃圾零散、生态扰动较低且暂不具备安全清理条件的区域，先持续监测、源头管控和定期巡检。"
            "具体密度阈值、生态权重和响应时限必须用本海域调查数据、保护目标及作业能力校准，不能直接套固定数字。"
        )
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
    if re.search(r"塑料(?:饮料|水)?瓶|pet(?:饮料|水)?瓶", q) and re.search(r"多久|几年|降解|消失|分解", q):
        return (
            "常见海洋垃圾科普材料给塑料饮料瓶的估算是约450年。这个数字只能理解为长期环境持留的数量级，"
            "不是所有海域都适用的精确寿命，也不表示到期后会完全矿化、变得无害。实际时间受材质配方、光照、"
            "温度、海水深度和机械磨损影响；很多塑料瓶会先碎裂成微塑料，继续留在环境中。"
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
    if all(term in q for term in ("pet", "hdpe")) and re.search(r"紫外|uv|老化|耐候|更耐|对比|比较", q):
        return (
            "以下为通识判断：在都未使用耐候添加剂（尤其是紫外稳定剂）、厚度和加工条件相近时，PET 通常比 HDPE 更耐紫外线老化。"
            "PET 主链中的芳香环让结构相对刚性、耐候性通常更好；HDPE 的碳氢链在紫外照射和氧气共同作用下更容易发生光氧化，"
            "随后出现表面粉化、脆化和强度下降。不过这不是所有制品都适用的固定结论：添加剂、颜料、结晶度、厚度、"
            "机械应力和海水温度都可能改变排序，工程选材应以相同条件下的加速老化和力学保持率试验为准。"
        )
    if re.search(r"pet.*老化|力学老化|微粒碎裂模型", q):
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
    if "微塑料" in q and re.search(r"进入人体|人体.{0,8}(?:途径|路径)|暴露途径|摄入途径|主要途径", q):
        return (
            "针对你补充问的暴露途径，目前较明确的主要是两类：一是摄入，例如通过食物、饮用水以及吞咽沉降到上呼吸道的颗粒；"
            "二是吸入，例如室内外空气和尘埃中的微塑料纤维或颗粒。完整健康皮肤对较大颗粒有屏障作用，"
            "日常环境下经皮吸收的证据仍有限，通常不列为主要途径。检出或暴露不等于已经造成具体疾病，"
            "不同粒径和暴露剂量的健康影响仍需更多研究。"
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
    if re.search(r"食物垃圾|厨余", q) and re.search(r"marpol|船舶|附则\s*v|入海|排放|处理", q):
        return (
            "针对你追问的食物垃圾，MARPOL 附则V不是一律允许排海，而是按处理方式和海域限制："
            "在一般海域且船舶正在航行时，粉碎或研磨至可通过25毫米筛孔的食物垃圾，通常须在距最近陆地超过3海里后才可排放；"
            "未粉碎的食物垃圾通常须超过12海里。特殊区域和极地水域要求更严，未粉碎食物垃圾通常禁止排放，"
            "粉碎后的也通常须超过12海里并满足附加条件。最稳妥的做法仍是分类暂存并交岸接收；具体操作应以现行附则、"
            "船旗国和港口国规定为准。"
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
        return scope_response()
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


def _counterfactual_fallback(message: str) -> Optional[str]:
    """模型无法稳定完成开放推演时，只给方向性、可证伪的保守说明。"""
    if not is_counterfactual_question(message):
        return None
    q = (message or "").lower()
    if "月球" in q and "潮汐" in q and re.search(r"海滩|海岸|垃圾", q):
        return (
            "【较确定推论】月球是地球潮汐的主要驱动力，但不是唯一驱动力；即使去掉月球作用，"
            "太阳引潮力、风浪、洋流和岸形仍会搬运海滩垃圾，因此潮汐不会简单地‘完全消失’。\n"
            "【推测】月球潮引起的周期性淹没、退水和潮线搬运会减弱，原本反复在高潮线附近搁置的垃圾带可能变得不那么稳定；"
            "局部分布可能更多受风向、波浪、暴雨径流和海岸地形控制。\n"
            "【不确定性】这只是方向性推测。不同海岸的太阳潮响应、风浪、洋流、坡度和垃圾浮力差异很大，"
            "不能断定垃圾一定更均匀、更多或更少；需要结合具体海岸的水动力模型和监测数据验证。"
        )
    return (
        "【较确定推论】这是一个反事实情景，现实中无法直接观察题设条件，只能从已知机制做方向性判断。\n"
        "【推测】相关结果可能随条件变化，但不应把一种可能写成必然结论。\n"
        "【不确定性】当前问题缺少对象、时间尺度和环境变量，不能断定单一结果；"
        "若补充具体海域或机制，我可以继续拆分哪些是较确定推论、哪些只是推测。"
    )


def _fallback_response(
    message: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> str:
    """兜底响应：绑定报告快照 → 确定性规则 → 反事实保守说明 → 知识库检索。"""
    return (
        _report_context_fallback(message, report_context or "")
        or direct_response(message)
        or _counterfactual_fallback(message)
        or _knowledge_fallback(message, evidence)
        or _friendly_unknown(message)
    )


# ==================== 建议追问（证据锚定） ====================
# 此前前端写死的 34 条"建议追问"包含大量知识库覆盖不到的深水区问题
# （RFID 渔具追踪、UUV 巡检、PLA 特定环境降解速率等），用户点过去必然得到
# "资料不足"。现在唯一允许的追问来源是本仓库维护的证据锚定索引：
# 每条问题都标注了来源文档与关键词，服务端按黑名单+历史去重后再下发。
_SUGGESTION_BLACKLIST_RE = re.compile(
    r"rfid|uuv|全天候|数值(?:模拟|同化|模式)|电化学|老化衰减|碎裂模型"
    r"|光谱[^。]{0,8}(?:定性|定量)|(?:pla|pha)\s*/|(?:低温高盐|缺氧)"
    r"|毒性权重|评分[^。]{0,6}算法|荧光检测法|内分泌干扰|实名制|减塑激励",
    re.I,
)
_SUGGESTION_INDEX_CACHE: dict[str, Any] = {"mtime": None, "items": []}


def _suggestion_index_path() -> str:
    # services/llm.py -> backend -> src -> 仓库根
    default = Path(__file__).resolve().parents[3] / "data" / "knowledge" / "suggestion_index.json"
    return os.getenv("SUGGESTION_INDEX_FILE", str(default))


def _load_suggestion_index() -> list[dict[str, Any]]:
    path = Path(_suggestion_index_path())
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    if _SUGGESTION_INDEX_CACHE["mtime"] == mtime:
        return _SUGGESTION_INDEX_CACHE["items"]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = [
        {
            "question": str(entry.get("question") or "").strip(),
            "sourceDoc": str(entry.get("sourceDoc") or "").strip(),
            "keywords": [str(k).lower() for k in (entry.get("keywords") or [])],
        }
        for entry in payload
        if isinstance(payload, list) and isinstance(entry, dict)
    ] if isinstance(payload, list) else []
    _SUGGESTION_INDEX_CACHE["mtime"] = mtime
    _SUGGESTION_INDEX_CACHE["items"] = items
    return items


def _is_usable_suggestion(question: str, asked_norms: set[str]) -> bool:
    text = (question or "").strip()
    if not text or len(text) < 8 or len(text) > 60:
        return False
    if _SUGGESTION_BLACKLIST_RE.search(text):
        return False
    compact = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.lower())
    return compact not in asked_norms


def suggest_adjacent_questions(
    context: str,
    limit: int = 3,
    asked_questions: Sequence[str] = (),
    hit_docs: Sequence[str] = (),
) -> list[dict[str, str]]:
    """从证据锚定索引中挑出与当前话题相关且知识库确实能答的问题。

    排序依据：命中文档匹配 > 关键词在上下文中的出现次数；凑不满就少给，
    绝不用超纲问题凑数。
    """
    items = _load_suggestion_index()
    if not items:
        return []
    asked_norms = {
        re.sub(r"[^\w\u4e00-\u9fff]+", "", (q or "").lower()) for q in asked_questions
    }
    asked_norms.discard("")
    context_lower = (context or "").lower()
    hit_set = {str(doc) for doc in hit_docs}
    scored: list[tuple[int, int, int, dict[str, str]]] = []
    for order, entry in enumerate(items):
        question = entry["question"]
        if not _is_usable_suggestion(question, asked_norms):
            continue
        keywords = set(entry["keywords"])
        keyword_hits = sum(1 for keyword in keywords if keyword and keyword in context_lower)
        doc_bonus = 30 if entry.get("sourceDoc") in hit_set else 0
        # 覆盖面兜底：文档标题与上下文的重叠也算弱信号
        doc_name = re.sub(r"\.(md|markdown)$", "", entry.get("sourceDoc") or "")
        topic_overlap = len(_query_terms(doc_name) & _substantive_query_terms(context))
        score = doc_bonus + keyword_hits * 10 + min(topic_overlap, 5)
        if score <= 0:
            continue
        scored.append((score, -keyword_hits, -order, {"question": question, "sourceDoc": entry.get("sourceDoc") or ""}))
    scored.sort(reverse=True)
    return [entry for _, _, _, entry in scored[: max(1, limit)]]


def _friendly_unknown(message: str) -> str:
    """资料不足时给出短、可行动的引导：承认边界，并主动递上真正能答的问题。"""
    templates = (
        "这个问题我暂时还没找到足够靠谱的资料，不敢乱说误导你～你补充点信息（比如具体海域、时间、检测数据），我马上帮你查！",
        "这个我翻了一圈知识库也没找到可核验的依据，不能瞎编给你。你要是能描述得更具体一点，我再找一轮。",
        "这个话题目前超出我能确认的范围了～说说你的具体场景？有报告编号或检测数据的话我可以做针对性分析。",
        "这题我手头的资料答不扎实——不想拿半懂的知识糊弄你。换个角度问或者补充背景信息，我们再试一次。",
        "这块我真的还在学习中，暂时给不出负责任的答案。如果你愿意说明具体想解决什么问题，也许我能从别的角度帮上忙。",
        "这题超纲了哈哈。我的档案库里海洋垃圾、污染治理这块存货最足，相关的问题尽管来！",
    )
    base = templates[sum(ord(ch) for ch in (message or "")) % len(templates)]
    adjacent = suggest_adjacent_questions(message, limit=2)
    if adjacent:
        listed = "、".join(f"「{item['question']}」" for item in adjacent)
        return f"{base}\n\n要不先聊这两个我更有把握的话题：{listed}"
    return base


async def generate_chat_stream(
    message: str,
    evidence: Optional[Sequence[dict[str, Any]]] = None,
    report_context: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    response = _fallback_response(message, evidence, report_context)
    # 按词组/短句输出，速度自然且不会像逐字符机器人。
    async for piece in stream_text(response):
        yield piece
