"""LLM/RAG 升级后的离线回归检查。"""
import asyncio
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))

from src.backend.services.llm import direct_response, IDENTITY, is_acceptable_model_answer
from src.LLM.chat_api import clean_model_text, _ThinkFilter, ChatRequest, ChatMessage, chat_service
from src.LLM.rag.audit_knowledge import audit
from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever

assert direct_response("这个项目是谁开发的？") == IDENTITY
assert "不在我的知识范围内" in direct_response("今天天气怎么样？")
assert "降解" in direct_response("塑料袋在海洋中多久能降解？")
assert "知识范围内" in direct_response("帮我写一个贪吃蛇游戏")
assert "不要直接拖拽" in direct_response("珊瑚附近发现废弃渔网怎么处理？")
assert not is_acceptable_model_answer("海岸清理时发现了缠绕在珊瑚附近的废弃渔网，应如何处置？", "海岸清理时发现了缠绕在珊瑚附近的废弃渔网，应如何处置？")
assert not is_acceptable_model_answer("请确认渔网类型并符合环保标准要求。", "珊瑚附近的渔网如何处置？")
assert clean_model_text("<think>内部推理</think>最终答案") == "最终答案"
filter_=_ThinkFilter()
visible=filter_.feed("<think>隐藏")+filter_.feed("思考</think>可见答案")+filter_.flush()
assert "隐藏" not in visible and "可见答案" in visible
assert not audit(), audit()
retriever=LocalKnowledgeRetriever()
context, results=retriever.retrieve_for_llm("幽灵渔网危害", 3)
assert results and "渔网" in context
assert not retriever.search("今天天气怎么样？")
assert ChatRequest(messages=[ChatMessage(role="user", content="你好")]).model == "deepseek-r1:1.5b"
print("LLM upgrade regression checks passed")

async def optional_ollama_smoke():
    chat_service.initialize("http://localhost:11434")
    req=ChatRequest(messages=[ChatMessage(role="user", content="请用一句话说明你能做什么")], enable_rag=False)
    # 只验证能得到 SSE 结束事件；服务未启动时不让离线检查失败。
    events=[]
    async for event in chat_service.chat_stream(req):
        events.append(event)
    assert events and any("[DONE]" in event for event in events)

if __name__ == "__main__":
    if "--ollama" in sys.argv:
        asyncio.run(optional_ollama_smoke())

