"""Ollama 不可用时的高质量安全兜底。

兜底不是随机闲聊：它只覆盖高频海洋意图、开发者身份和范围边界，
避免服务异常时继续输出答非所问的模板话。
"""
from __future__ import annotations

import asyncio
import re
from typing import AsyncGenerator, Optional

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
    "检测", "识别", "置信度", "检测报告", "污染等级", "yolo", "环保",
)


def is_domain_question(message: str) -> bool:
    q = (message or "").strip().lower()
    return any(term.replace(" ", "") in q.replace(" ", "") for term in DOMAIN_TERMS)


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _strip_think(text: str) -> str:
    """移除模型可能泄漏的推理标签；路由层只把可展示内容交给前端。"""
    cleaned = re.sub(r"<think>.*?</think>", "", text or "", flags=re.I | re.S)
    return re.sub(r"</?think\s*>", "", cleaned, flags=re.I).strip()


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


def is_acceptable_model_answer(answer: str, question: str) -> bool:
    """拦截 R1 1.5B 的复述、空答、推理泄漏和明显事实偏移。"""
    raw = answer or ""
    text = _compact(_strip_think(raw))
    query = _compact(question)

    # 基础质量检查：推理泄漏、空答、完全复述问题
    if "<think" in raw.lower() or len(text) < 24 or text == query or text.startswith(query):
        return False
    if _has_obvious_repetition(raw):
        return False

    # 只拦截严重的事实错误模板，放宽自然表达的空间
    critical_errors = (
        r"系统无法直接回答",  # 回避式模板
        r"立即停止.*?活动",   # 无依据的紧急指令
    )
    if any(re.search(pattern, text) for pattern in critical_errors):
        return False

    # 只对高风险术语检查必需要素，避免拦截自然表达
    critical_terms = {
        "微塑料": ("5毫米", "毫米", "碎片", "颗粒", "小于"),  # 尺寸定义必需
        "marpol": ("附则", "公约", "船舶"),  # 基本概念必需
    }
    q_lower = (question or "").lower()
    for topic, terms in critical_terms.items():
        if topic in q_lower and not any(term in text for term in terms):
            return False

    # 拦截违反核心知识边界的结论
    if "marpol" in q_lower and re.search(r"(允许|可以|能够).{0,12}(塑料|垃圾).{0,12}(倒|排放).{0,8}(海|海里)", text):
        return False

    return True


def finalize_model_answer(question: str, model_answer: str) -> str:
    """统一模型后处理：净化后须通过质量门禁，否则返回可追溯兜底。"""
    cleaned = _strip_think(model_answer)
    if is_acceptable_model_answer(cleaned, question):
        return cleaned
    return _fallback_response(question)


def _knowledge_fallback(message: str) -> Optional[str]:
    """模型不可用或被质量门禁拦截时，返回可追溯的知识库证据。"""
    if not is_domain_question(message):
        return None
    try:
        from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever

        results = LocalKnowledgeRetriever().search(message, 1)
    except Exception:
        return None
    if not results:
        return None
    result = results[0]
    source = result["metadata"].get("source", "项目知识库")
    evidence = re.sub(r"^#{1,6}\s*", "", result["content"], flags=re.M).strip()
    if len(evidence) > 650:
        evidence = evidence[:650].rsplit("。", 1)[0] + "。"

    # 自然语言包装，不直接贴原文
    return (
        f"关于这个问题，项目知识库里有相关记录：\n\n{evidence}\n\n"
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
    if re.search(r"^(你好|您好|嗨|hello|hi)[！!。．. ]*$", q):
        return "你好！我是海洋守护者，可以帮你分析检测结果、解答海洋环保问题。有什么想了解的吗？"
    if re.search(r"你是谁|你是什么|你是哪个平台|你是哪家|你属于|来自哪里|你叫什么|介绍一下你|你能做什么|有什么功能|海瞳", q):
        return PLATFORM_IDENTITY
    if re.search(r"天气|股票|写代码|编程|写程序|游戏|小说|笑话|算命|新闻|影视|作业", q):
        return SCOPE_RESPONSE

    # 以下是核心专业知识，需要保持权威性但可以更亲和
    if re.search(r"(置信度|把握|可信度).{0,12}(低|不足|不高)|\b[0-5]?\d%|能否.{0,8}(统计|上报)|能直接.{0,8}(统计|确认)", q):
        return (
            "低置信度的识别结果不能直接当成确定结论来统计。"
            "建议先回看原始图像，核对类别和目标框是否合理，结合采集时间、地点判断，必要时人工复核或补拍确认后再录入正式记录。"
        )
    if "幽灵渔网" in q or ("渔网" in q and re.search(r"发现|看到|处理|怎么办|打捞", q)):
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
    if "微塑料" in q and re.search(r"危害|影响|人体|健康|是什么|定义|多大|疾病|5mm|5毫米", q):
        return (
            "微塑料通常是指小于5毫米的塑料颗粒或碎片，可能来自塑料制品的磨损碎裂，也可能是直接进入环境的小颗粒。"
            "它会被海洋生物误食，造成物理伤害，也可能携带一些化学物质。"
            "对人体健康的具体影响还在研究中，目前不能说检出微塑料就一定会导致某种疾病，但长期累积的风险需要警惕。"
        )
    if re.search(r"marpol|船舶.*垃圾|船.*塑料|附则\s*v|塑料垃圾.*(倒|排放).*(海|海里)", q):
        return (
            "MARPOL 是《国际防止船舶造成污染公约》，和船舶垃圾最相关的是附则V：\n"
            "**塑料禁止从船上排放入海**——不能把塑料垃圾倒进海里。\n"
            "其他垃圾要按类别、区域和条件分类管理，配合垃圾管理计划和记录簿。"
            "具体履约还得看船旗国、港口国和适用区域的要求。"
        )
    if re.search(r"海岸.*清理|海滩.*清理|海滩.*优先|清理.*方案|治理.*方案|垃圾.*(优先级|怎么处理)|怎么打捞|如何打捞", q):
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
        return (
            "要分析检测结果的话，建议提供这些信息：检测任务编号、识别出的垃圾类别、数量、置信度，或者直接给报告摘要。"
            "我会按’现象-风险-优先级-处置建议’帮你分析。"
            "不过要注意，一张模糊图片 + 低置信度结果不能直接当成确定事实哦。"
        )
    if not is_domain_question(q):
        return SCOPE_RESPONSE
    return None


def _fallback_response(message: str) -> str:
    """兜底响应：确定性规则 → 知识库检索 → 友好的信息不足提示"""
    return direct_response(message) or _knowledge_fallback(message) or (
        "嗯，这个问题我暂时还没有足够的资料来确认。"
        "如果能补充一些具体信息（比如对象、地点、时间、检测数据），我可以结合知识库再给你分析。"
    )


async def generate_chat_stream(message: str) -> AsyncGenerator[str, None]:
    response = _fallback_response(message)
    # 按词组/短句输出，速度自然且不会像逐字符机器人。
    async for piece in stream_text(response):
        yield piece
