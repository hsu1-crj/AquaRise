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
    is_acceptable_model_answer,
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
    retriever = LocalKnowledgeRetriever()
    context, results = retriever.retrieve_for_llm("幽灵渔网危害", 3)
    assert results and "渔网" in context
    assert not retriever.search("今天天气怎么样？")
    assert ChatRequest(messages=[ChatMessage(role="user", content="你好")]).model == "ds-ocean_mingzhe"



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
