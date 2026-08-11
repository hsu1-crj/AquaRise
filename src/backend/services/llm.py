"""Ollama 不可用时的高质量安全兜底。

兜底不是随机闲聊：它只覆盖高频海洋意图、开发者身份和范围边界，
避免服务异常时继续输出答非所问的模板话。
"""
from __future__ import annotations

import asyncio
import re
from typing import AsyncGenerator, Optional

IDENTITY = "海瞳 LLM 组负责这个项目的 LLM 对话与数字人模块开发。"
SCOPE_RESPONSE = (
    "我目前专注于海洋垃圾识别、海洋污染分析、治理技术和检测结果解读。"
    "这个问题不在我的知识范围内；如果你提供检测结果或海洋环保问题，我可以继续帮你分析。"
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


def is_acceptable_model_answer(answer: str, question: str) -> bool:
    """拦截 R1 1.5B 常见的复述、空答和无证据套话。"""
    text = re.sub(r"\s+", "", answer or "")
    query = re.sub(r"\s+", "", question or "")
    if len(text) < 24 or text == query or text.startswith(query):
        return False
    # 这些表达在实际回归中反复出现，但不提供可执行信息或不受知识库支持。
    unsupported_patterns = (
        r"确认.*?(渔网|垃圾).*?类型", r"符合.*?(法规|标准)要求", r"环保材料", r"清洁剂",
        r"长期监测和分类", r"确保.*?(安全|可持续)", r"立即停止活动",
    )
    if any(re.search(pattern, text) for pattern in unsupported_patterns):
        return False
    required_terms = {
        "渔网": ("缠绕", "打捞", "拖拽", "珊瑚", "专业", "调查"),
        "微塑料": ("5毫米", "碎片", "颗粒", "摄入", "研究"),
        "marpol": ("附则", "船舶", "塑料", "排放"),
        "船舶": ("附则", "船舶", "塑料", "排放"),
        "降解": ("碎裂", "老化", "微塑料", "环境"),
        "检测": ("置信度", "类别", "数量", "复核", "任务"),
    }
    q_lower = (question or "").lower()
    for topic, terms in required_terms.items():
        if topic in q_lower and not any(term in text for term in terms):
            return False
    return True


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
    return (
        f"根据项目知识库《{source}》的相关内容：\n{evidence}\n\n"
        "如需给出现场处置优先级，请补充地点、垃圾类型、数量、潮汐或检测置信度。"
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
    q = (message or "").strip().lower()
    if not q:
        return "请告诉我你想了解的海洋垃圾、污染治理或检测结果。"
    if re.search(r"谁开发|开发者|作者|谁做的|谁创建|项目是谁", q):
        return IDENTITY
    if re.search(r"^(你好|您好|嗨|hello|hi)[！!。．. ]*$", q):
        return "你好，我是海洋守护者。我可以结合项目知识库，帮你分析海洋垃圾、污染风险和检测结果。"
    if re.search(r"你是谁|你能做什么|有什么功能|介绍一下你", q):
        return "我是海洋守护者，负责海洋垃圾识别、检测结果解读、污染分析、微塑料与治理知识问答。需要时我会优先引用项目知识库；证据不足时会明确说明。"
    if re.search(r"天气|股票|写代码|编程|写程序|游戏|小说|笑话|算命|新闻|影视|作业", q):
        return SCOPE_RESPONSE
    if "幽灵渔网" in q or "渔网" in q or "渔具" in q:
        return "幽灵渔网是遗失或被遗弃后仍在海中持续捕捞的废弃渔网，属于典型海洋垃圾。它会缠绕鱼类、海龟、海鸟和海洋哺乳动物，并可能损伤珊瑚礁。发现缠绕在珊瑚或生物附近的渔网时，应先记录位置和风险，由专业团队评估后分段解缠、打捞；不要直接拖拽，避免二次损伤。"
    if "塑料袋" in q and re.search(r"多久|几年|降解|消失", q):
        return "塑料袋在海洋中没有一个可靠、统一的‘降解年限’。温度、光照、材质和受力差异很大；很多塑料首先是老化、碎裂成微塑料，并不等于真正消失。因此不建议把‘20年/1000年’当作精确答案，应把它视为长期持留污染物，重点是源头减量、回收和及时清理。"
    if "微塑料" in q and re.search(r"危害|影响|人体|健康|是什么", q):
        return "微塑料通常指粒径或长度小于5毫米的塑料颗粒，可由塑料制品直接进入环境，也可由大块塑料磨损碎裂形成。它可能被海洋生物摄入并造成物理刺激，同时还可能携带或释放部分化学物质；对人体健康的具体风险仍在研究，不能把‘每周5克’等流行说法当作确定结论。"
    if re.search(r"marpol|船舶.*垃圾|船.*塑料|附则v", q):
        return "MARPOL 是《国际防止船舶造成污染公约》。与船舶垃圾最直接相关的是附则V：塑料禁止从船舶排放入海，其他垃圾需按类别、区域和排放条件管理，并配合垃圾管理计划、记录簿和港口接收设施。具体履约还要结合船旗国、港口国和适用特殊区域的现行要求。"
    if re.search(r"海岸.*清理|清理.*方案|治理.*方案|垃圾.*怎么处理|怎么打捞|如何打捞", q):
        return "建议按‘先评估、再分区、后清理、再复测’执行：1）记录坐标、潮汐、水深、垃圾类型和数量；2）优先处理幽灵渔网、大型缠绕物、尖锐金属和可能含油/化学品的垃圾；3）按风险选择人工、船舶或 ROV 打捞，渔网不要直接拖拽珊瑚礁；4）现场分拣、称重、拍照留档，疑似危险废物单独隔离；5）清理后按同一航线或样方复测，比较数量、密度和误检情况。若你提供检测报告，我可以进一步给出优先级。"
    if re.search(r"检测结果|识别结果|报告|污染等级|怎么处理", q):
        return "请提供检测任务编号、识别出的垃圾类别、数量、置信度或报告摘要。我会按‘现象—风险—优先级—处置建议’给出分析；仅凭一张模糊图片不能把低置信度结果当成确定事实。"
    if not is_domain_question(q):
        return SCOPE_RESPONSE
    return None


def _fallback_response(message: str) -> str:
    return direct_response(message) or _knowledge_fallback(message) or (
        "现有知识库不足以确认这个问题。请补充对象、地点、时间或检测结果；"
        "我会基于可检索到的证据再给出结论。"
    )


async def generate_chat_stream(message: str) -> AsyncGenerator[str, None]:
    response = _fallback_response(message)
    # 按词组/短句输出，速度自然且不会像逐字符机器人。
    async for piece in stream_text(response):
        yield piece
