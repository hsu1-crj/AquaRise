"""LLM/RAG 升级后的离线与可选 Ollama 回归检查。"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.backend.services.llm import (
    FAMILY_IDENTITY,
    IDENTITY,
    direct_response,
    finalize_model_answer,
    is_domain_question,
    is_acceptable_model_answer,
    requires_citations,
    _knowledge_fallback,
    _evidence_supports_requested_intent,
    _evidence_excerpt,
    _is_complete_answer,
)
from src.LLM.chat_api import ChatMessage, ChatRequest, _ThinkFilter, chat_service, clean_model_text
from src.LLM.rag.audit_knowledge import audit
from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever


def _require(question: str, *terms: str) -> None:
    answer = direct_response(question)
    assert answer is not None, f"确定性路由未命中：{question}"
    missing = [term for term in terms if term not in answer]
    assert not missing, f"{question} 缺少关键结论 {missing}：{answer}"


def run_offline_regression() -> None:
    # 项目身份与家庭关系必须稳定，不交由小参数模型自由生成。
    assert direct_response("这个项目是谁开发的？") == IDENTITY
    assert direct_response("海瞳的项目作者是谁？") == IDENTITY
    assert direct_response("你爸爸是谁？") == FAMILY_IDENTITY

    # 9 项固定生成验收题在运行时由规则/RAG 质量门禁保证关键结论。
    _require("作为 AI，你有家人或者父亲吗？", "没有生物学意义上的父母或家人", "海瞳 LLM 组", "LLM 模块")
    _require("识别画面里塑料瓶只有 60% 置信度，能否直接纳入正式统计？", "不能直接当成确定结论来统计", "人工复核")
    _require("这个目标的置信度60%，应该怎么处理？", "不能直接当成确定结论来统计", "人工复核")
    _require("MARPOL 附则 V 是否允许船上把塑料垃圾倒进海里？", "塑料禁止", "不能把塑料垃圾倒进海里")
    _require("微塑料的常用定义是什么？能据此认定它已经造成某种人体疾病吗？", "小于5毫米", "还在研究", "不能")
    _require("海里塑料袋多久会真正消失？", "很难给出准确数字", "碎裂成微塑料")
    _require("珊瑚边发现遗失渔网，现场处置的第一步和注意事项是什么？", "记录位置", "别直接拖拽")
    _require("请给一份海滩垃圾处置的优先级框架。", "评估-分区-清理-复测", "优先处理")
    _require("我想知道今天股票会怎么走。", "超出我的专业范围")

    assert not is_acceptable_model_answer(
        "海岸清理时发现了缠绕在珊瑚附近的废弃渔网，应如何处置？",
        "海岸清理时发现了缠绕在珊瑚附近的废弃渔网，应如何处置？",
    )
    assert not is_acceptable_model_answer("请确认渔网类型并符合环保标准要求。", "珊瑚附近的渔网如何处置？")
    assert not is_acceptable_model_answer("<think>推理</think>塑料可以倒进海里。", "MARPOL 是否允许塑料排海？")
    fallback = finalize_model_answer("MARPOL 是否允许塑料排海？", "塑料可以倒进海里。")
    assert "塑料禁止" in fallback and "不能把塑料垃圾倒进海里" in fallback

    evidence = [{
        "id": 1,
        "source": "海洋塑料治理技术综述.md",
        "content": "治理应覆盖源头减量、入海前拦截、清理回收与持续监测评估。",
    }]
    grounded = "海洋塑料治理应从源头减量开始，并结合入海前拦截、清理回收和持续监测。[S1]"
    assert is_acceptable_model_answer(grounded, "海洋塑料污染怎么治理？", evidence)
    assert not is_acceptable_model_answer(
        "某国际海洋保护署建议投入 9000 亿元恢复鱼虾资源。[S1]",
        "海洋塑料污染怎么治理？",
        evidence,
    )
    assert not is_acceptable_model_answer(
        "2025年联合国海洋大会通过《海洋环境与可持续发展公约》。[S1]",
        "海洋塑料污染怎么治理？",
        evidence,
    )
    assert not is_acceptable_model_answer(
        "治理包括源头减量、拦截和清理回收。",
        "海洋塑料污染怎么治理？",
        evidence,
    )
    grounded_fallback = finalize_model_answer(
        "海洋塑料污染怎么治理？", "治理包括恢复鱼虾和设立新机构。", evidence
    )
    assert "海洋塑料治理技术综述.md" in grounded_fallback

    assert clean_model_text("<think>内部推理</think>最终答案") == "最终答案"
    filter_ = _ThinkFilter()
    visible = filter_.feed("<think>隐藏") + filter_.feed("思考</think>可见答案") + filter_.flush()
    assert "隐藏" not in visible and "可见答案" in visible

    assert not audit(), audit()
    assert not _is_complete_answer("3. 应急处置与修复：")
    assert not _is_complete_answer("- 快速定位：")
    assert _is_complete_answer("请先复核原始图像，再决定是否纳入正式统计。")
    assert requires_citations("幽灵渔网缠绕珊瑚礁时微创切割标准作业指引")
    assert requires_citations("图像去散射方法是什么？")
    assert "3D" in direct_response("生命图谱是干什么的？")
    assert "全生命周期" in direct_response("海洋垃圾和气候变化有什么关系？")
    assert "导航失误" in direct_response("鲸鱼为什么会搁浅？")
    assert direct_response("请帮我分析这份报告里的生命图谱风险等级和关键发现。") is None
    assert "指挥大屏" in direct_response("指挥大屏是做什么的？")
    assert not is_acceptable_model_answer(
        "蓝色代表塑料，绿色代表有机污染物。",
        "海洋垃圾里面有红绿灯吗？",
        [],
        require_citations=False,
    )
    retriever = LocalKnowledgeRetriever()
    context, results = retriever.retrieve_for_llm("幽灵渔网危害", 3)
    assert results and "渔网" in context
    assert not retriever.search("今天天气怎么样？")
    assert ChatRequest(messages=[ChatMessage(role="user", content="你好")]).model == "ds-ocean_mingzhe"
    report_request = ChatRequest(
        messages=[ChatMessage(role="user", content="我已导入质量分析报告，请帮我分析这份报告：概括风险等级、关键发现和处置建议。")],
        report_context="报告 ID：RPT-7\n结构化分析快照：风险等级为中，建议治理后复测。",
    )
    assert direct_response("我已导入质量分析报告，请帮我分析这份报告：概括风险等级、关键发现和处置建议。") is None
    chat_service.initialize("http://localhost:11434")
    prepared, _ = chat_service.prepare_messages(report_request)
    assert any("RPT-7" in item["content"] and "治理后复测" in item["content"] for item in prepared)

    # 2026-08-21 对话记录回归：专业问题不得被范围规则误伤，社交输入不得落入生硬越界话术。
    professional_questions = (
        "ROV 微创切割的标准作业指引是什么？",
        "清滩作业完成后如何做样方抽检？",
        "打捞上岸的废弃渔网，脱盐清洗与再生利用有哪些途径？",
        "微塑料会产生生物毒性富集吗？",
        "声呐应答器 + RFID + 高风险渔具追踪怎么做？",
        "USV 漂浮塑料自主巡航/拦截怎么做？",
        "低置信度识别结果在正式报告中如何降级与风险标注？",
    )
    for question in professional_questions:
        assert is_domain_question(question), f"专业词未识别为海洋领域：{question}"
        answer = direct_response(question)
        assert answer != direct_response("我想知道今天股票会怎么走。"), f"专业问题误触发越界：{question}"
    assert direct_response("你好你好你好") != direct_response("我想知道今天股票会怎么走。")
    assert direct_response("早上好") != direct_response("我想知道今天股票会怎么走。")
    assert direct_response("你最近过得还好吗") != direct_response("我想知道今天股票会怎么走。")
    assert "不客气" in direct_response("谢谢你的帮助")
    assert "再见" in direct_response("再见")
    assert "海洋环保" in direct_response("傻逼")
    shortcut_questions = (
        "海瞳平台是做什么的？",
        "识别结果置信度较低时，为什么不能直接纳入正式统计？",
        "珊瑚附近发现废弃渔网，现场处置应注意什么？",
        "MARPOL 附则 V 是否允许把塑料垃圾排入海里？",
        "微塑料是什么？它的风险应该怎样科学解读？",
        "塑料袋在水下多久能真正降解？",
        "检测报告里 trash_net 置信度不高，应该怎么解读？",
        "如何制定海岸垃圾清理的优先级和复测流程？",
    )
    for question in shortcut_questions:
        answer = direct_response(question)
        assert answer and len(answer) >= 40, question
    recycling_answer = direct_response("打捞上岸的废弃渔网，脱盐清洗与再生利用有哪些途径？")
    assert recycling_answer and "分选" in recycling_answer and "造粒" in recycling_answer
    enrichment_answer = direct_response("微塑料会产生生物毒性富集吗？")
    assert enrichment_answer and "食物链" in enrichment_answer and "富集" in enrichment_answer
    shortcut_followups = {
        "MARPOL 附则 V 对特殊区域（如地中海、波罗的海等）船舶生活垃圾排放有哪些禁止条款？": ("塑料", "附则"),
        "针对低置信度（<0.6）的水下疑似目标，有哪些时序多帧跟踪与人工复核机制？": ("连续帧", "人工复核"),
        "在浑浊泥沙或暗光深水环境中，如何结合图像去散射与超分辨率提升检测率？": ("去散射", "超分辨率"),
        "水下幽灵渔网缠绕珊瑚礁时，潜水员或 ROV 进行微创切割的标准作业指引是什么？": ("ROV", "分段"),
        "打捞上岸的废弃尼龙与聚乙烯渔网有哪些脱盐清洗与再生颗粒高值化利用途径？": ("脱盐", "造粒"),
        "针对渤海近岸漂浮塑料垃圾，有哪些基于无人艇（USV）的自主巡航与高效拦截装置？": ("USV", "拦截"),
        "PET 塑料瓶在海水长期浸泡与紫外辐射下的力学老化衰减与微粒碎裂模型如何构建？": ("老化", "粒径"),
        "微塑料在近岸表层海水与深海沉积物中的光谱快速定性定量检测方法有哪些？": ("FTIR", "拉曼"),
        "微塑料吸附持久性有机污染物（POPs）后，如何通过海洋食物链产生生物毒性富集？": ("食物链", "富集"),
        "海事监管部门在检查船舶垃圾记录簿（GRB）与防污染证书时重点核查哪些项？": ("记录簿", "证书"),
    }
    for question, terms in shortcut_followups.items():
        answer = direct_response(question)
        assert answer and all(term in answer for term in terms), question
    assert direct_response("低置信度识别结果在正式报告中如何降级与风险标注？") is None
    assert _knowledge_fallback("怎么变成海洋守护者") is None
    assert _knowledge_fallback("USV 漂浮塑料自主巡航/拦截怎么做？") is None

    # 证据意图门槛：定义/背景片段不能冒充计算、机制、方法或操作指引。
    background = [{
        "id": 1,
        "source": "背景知识.md",
        "content": "海洋垃圾会影响生态系统，废弃渔具可能缠绕海洋生物。",
    }]
    assert not _evidence_supports_requested_intent("评分权重如何分配计算？", background)
    assert not _evidence_supports_requested_intent("图像去散射方法是什么？", background)
    assert not _evidence_supports_requested_intent("幽灵渔网缠绕珊瑚礁时的切割 SOP？", background)
    assert _knowledge_fallback("评分权重如何分配计算？", background) is None
    assert _knowledge_fallback("图像去散射方法是什么？", background) is None
    assert _knowledge_fallback(
        "幽灵渔网缠绕珊瑚礁时微创切割标准作业指引",
        [{"content": "幽灵渔网是废弃渔具，可能缠绕珊瑚并造成生态影响。解缠前应评估风险。"}],
    ) is None
    assert _knowledge_fallback(
        "针对低置信度目标，有哪些时序多帧跟踪与人工复核机制？",
        [{"content": "必须记录置信度和人工复核结果。"}, {"content": "ROV 视频可用于水下监测。"}],
    ) is None
    assert _knowledge_fallback("降级与风险标注怎么做？", background) is None
    report_question = "低置信度识别结果在正式报告中如何降级与风险标注？"
    irrelevant_report = [{
        "id": 1,
        "source": "上传评估报告.md",
        "content": "报告风险等级为中。现场清理记录包含坐标、潮汐和采样时间。",
    }]
    assert _knowledge_fallback(report_question, irrelevant_report) is None
    report_answer = finalize_model_answer(
        report_question,
        "请根据清理记录、坐标和潮汐安排后续工作。",
        irrelevant_report,
    )
    assert not any(term in report_answer for term in ("清理记录", "坐标", "潮汐"))
    assert any(term in report_answer for term in ("资料", "依据", "不确定", "报告"))
    intent_excerpt, _ = _evidence_excerpt(
        report_question,
        [{
            "id": 1,
            "source": "混合报告.md",
            "content": "现场清理记录包括坐标和潮汐。污染评估中的风险标注应说明降级依据。",
        }],
    )
    assert "污染评估" in intent_excerpt or "风险标注" in intent_excerpt

    # 组合机制必须在同一证据片段中同时出现，不能由两个擦边 chunk 拼接。
    multi_frame_question = "低置信度多帧跟踪机制是什么？"
    assert not _evidence_supports_requested_intent(
        multi_frame_question,
        [{"content": "跟踪目标需要保持轨迹连续。"}, {"content": "多帧输入可以减少单帧误检。"}],
    )
    assert not _evidence_supports_requested_intent(
        multi_frame_question,
        [{"content": "多帧输入可以减少单帧误检。跟踪目标需要保持轨迹连续。"}],
    )
    assert _evidence_supports_requested_intent(
        multi_frame_question,
        [{"content": "多帧跟踪机制通过连续帧保持目标轨迹。"}],
    )

    # 无搁浅/类别内容时，邻近的污染或 YOLO 工程资料不得被拼贴成答案。
    pollution_evidence = [{"content": "海洋污染会影响生态系统，建议加强清理和监测。"}]
    yolo_evidence = [{"content": "低频类别需要数据增强，训练时应调整样本分布。"}]
    assert _knowledge_fallback("鲸鱼为什么会搁浅？", pollution_evidence) is None
    assert _knowledge_fallback("YOLO 能识别哪些类别？", yolo_evidence) is None

    hash_excerpt, _ = _evidence_excerpt(
        report_question,
        [{
            "content": "海域污染评估报告 - 926b191c6cd67d6a311bb608e3aaf8ed_.jpg\n"
            "现场清理记录包括坐标和潮汐。风险标注应说明降级依据。",
        }],
    )
    assert "926b191c6cd67d6a311bb608e3aaf8ed_.jpg" not in hash_excerpt

    bound_report = "报告摘要：污染等级为中。\n关键发现：低置信度目标需要降级处理。\n处置方案：复核后复测。"
    bound_fallback = finalize_model_answer(
        report_question,
        "请根据清理记录、坐标和潮汐安排后续工作。",
        irrelevant_report,
        report_context=bound_report,
    )
    assert "风险等级" in bound_fallback or "关键发现" in bound_fallback or "降级" in bound_fallback
    assert not any(term in bound_fallback for term in ("清理记录", "坐标", "潮汐"))
    short_label_fallback = finalize_model_answer(
        "请概括这份报告的风险等级和处置建议。",
        "",
        [],
        report_context="污染等级：中\n处置方案：复核后复测。",
    )
    assert "污染等级：中" in short_label_fallback




async def optional_ollama_smoke() -> None:
    chat_service.initialize("http://localhost:11434")
    req = ChatRequest(messages=[ChatMessage(role="user", content="请用一句话说明你能做什么")], enable_rag=False)
    events = []
    async for event in chat_service.chat_stream(req):
        events.append(event)
    assert events and any("[DONE]" in event for event in events)


if __name__ == "__main__":
    run_offline_regression()
    print("LLM offline regression checks passed (9/9 runtime safety cases)")
    if "--ollama" in sys.argv:
        asyncio.run(optional_ollama_smoke())
        print("Ollama SSE smoke check passed")
