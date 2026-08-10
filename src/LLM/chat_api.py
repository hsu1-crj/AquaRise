"""
LLM对话API模块

功能:
- FastAPI 对话接口（流式 SSE 输出）
- Ollama 模型调用封装
- RAG 检索增强对话
- 对话历史管理

接口:
- POST /api/v1/chat       流式对话（SSE）
- POST /api/v1/chat/rag   RAG 增强对话
- GET  /api/v1/models     可用模型列表
"""

import json
import logging
import os
from typing import Optional, AsyncGenerator, List, Dict

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ============================================================
# Pydantic 数据模型
# ============================================================

class ChatMessage(BaseModel):
    """对话消息"""
    role: str = Field(..., description="角色: user / assistant / system")
    content: str = Field(..., description="消息内容")


class ChatRequest(BaseModel):
    """对话请求"""
    messages: List[ChatMessage] = Field(..., description="对话历史")
    model: str = Field(default="qwen2:0.5b", description="模型名称")
    temperature: float = Field(default=0.7, ge=0, le=2.0, description="生成温度")
    max_tokens: int = Field(default=2048, ge=1, le=8192, description="最大生成token数")
    stream: bool = Field(default=True, description="是否流式输出")
    enable_rag: bool = Field(default=False, description="是否启用RAG检索增强")


class ChatResponse(BaseModel):
    """非流式对话响应"""
    role: str = "assistant"
    content: str
    model: str
    finish_reason: Optional[str] = None


class ModelInfo(BaseModel):
    """模型信息"""
    name: str
    size: str
    modified_at: str


# ============================================================
# Ollama 客户端封装
# ============================================================

class OllamaClient:
    """Ollama API 客户端"""

    def __init__(self, base_url: str = "http://localhost:11434"):
        self.base_url = base_url

    async def chat(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stream: bool = False,
    ):
        """调用Ollama聊天接口"""
        import aiohttp

        url = f"{self.base_url}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
            "stream": stream,
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status != 200:
                    error_text = await response.text()
                    raise Exception(f"Ollama API 错误 ({response.status}): {error_text}")

                if stream:
                    # 返回异步生成器用于流式读取
                    return response.content
                else:
                    return await response.json()

    async def chat_stream(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> AsyncGenerator[str, None]:
        """
        流式对话生成器

        Yields:
            SSE 格式的事件字符串
        """
        import aiohttp

        url = f"{self.base_url}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
            "stream": True,
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status != 200:
                    error_text = await response.text()
                    yield f"data: {json.dumps({'error': f'Ollama API 错误 ({response.status}): {error_text}'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                buffer = ""
                async for chunk in response.content.iter_chunked(1024):
                    buffer += chunk.decode("utf-8")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        if line.strip():
                            try:
                                data = json.loads(line)
                                if "message" in data and "content" in data["message"]:
                                    content = data["message"]["content"]
                                    yield f"data: {json.dumps({'content': content})}\n\n"
                                if data.get("done"):
                                    yield "data: [DONE]\n\n"
                                    return
                            except json.JSONDecodeError:
                                continue

    async def list_models(self) -> List[Dict]:
        """获取可用模型列表"""
        import aiohttp

        url = f"{self.base_url}/api/tags"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status != 200:
                    raise Exception(f"获取模型列表失败: {response.status}")
                data = await response.json()
                return data.get("models", [])


# ============================================================
# RAG 增强服务
# ============================================================

class RAGService:
    """RAG 检索增强服务"""

    def __init__(self):
        self._kb = None
        self._retriever = None
        self._initialized = False

    def initialize(self):
        """延迟初始化 RAG 知识库"""
        if self._initialized:
            return

        try:
            from .rag.knowledge_base import OceanKnowledgeBase
            from .rag.retriever import OceanRetriever

            self._kb = OceanKnowledgeBase()
            self._kb.build()
            self._retriever = OceanRetriever(self._kb)
            self._initialized = True
            logger.info("RAG 知识库初始化完成")
        except Exception as e:
            logger.warning(f"RAG 知识库初始化失败（将继续使用纯LLM模式）: {e}")
            self._initialized = True  # 标记已尝试，避免重复失败

    def retrieve_context(self, query: str, k: Optional[int] = None) -> str:
        """检索相关上下文（k 默认取环境变量 RAG_TOP_K，缺省 4）"""
        if not self._retriever:
            self.initialize()
        if not self._retriever:
            return ""

        if k is None:
            try:
                k = int(os.getenv("RAG_TOP_K", "4"))
            except ValueError:
                k = 4

        try:
            context, _ = self._retriever.retrieve_for_llm(query, k)
            return context
        except Exception as e:
            logger.warning(f"RAG 检索失败: {e}")
            return ""


# ============================================================
# 对话服务
# ============================================================

class ChatService:
    """对话服务（单例模式，FastAPI依赖注入使用）"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def initialize(self, ollama_base_url: str = "http://localhost:11434"):
        """初始化服务"""
        if self._initialized:
            return

        self.ollama = OllamaClient(base_url=ollama_base_url)
        self.rag = RAGService()
        self._initialized = True
        logger.info("ChatService 初始化完成")

    def build_messages(
        self,
        request: ChatRequest,
        system_prompt: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """
        构建发送给 LLM 的消息列表

        Args:
            request: 对话请求
            system_prompt: 系统提示词（可选，覆盖默认）

        Returns:
            消息列表 [{"role": "...", "content": "..."}, ...]
        """
        messages = []

        # 添加系统提示词
        if system_prompt is None:
            system_prompt = (
                "你是'海洋守护者'，一个专注于水下垃圾识别、海洋污染分析和环保教育的AI助手。"
                "请用专业、准确、积极鼓励的语气回答用户问题。"
                "如果不确定的信息要明确说明，不编造虚假数据。"
            )

        messages.append({"role": "system", "content": system_prompt})

        # 如果启用RAG，为最后一条用户消息检索上下文
        if request.enable_rag and request.messages:
            last_user_msg = None
            for msg in reversed(request.messages):
                if msg.role == "user":
                    last_user_msg = msg.content
                    break

            if last_user_msg:
                context = self.rag.retrieve_context(last_user_msg)
                if context:
                    # 在用户消息前插入检索到的上下文
                    messages.append({
                        "role": "system",
                        "content": f"请参考以下知识回答用户问题:\n\n{context}",
                    })

        # 添加对话历史
        for msg in request.messages:
            messages.append({"role": msg.role, "content": msg.content})

        return messages

    async def chat(
        self,
        request: ChatRequest,
        system_prompt: Optional[str] = None,
    ) -> ChatResponse:
        """非流式对话"""
        messages = self.build_messages(request, system_prompt)
        result = await self.ollama.chat(
            model=request.model,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=False,
        )
        return ChatResponse(
            content=result.get("message", {}).get("content", ""),
            model=request.model,
            finish_reason=result.get("done_reason"),
        )

    async def chat_stream(
        self,
        request: ChatRequest,
        system_prompt: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        """流式对话"""
        messages = self.build_messages(request, system_prompt)
        async for event in self.ollama.chat_stream(
            model=request.model,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        ):
            yield event


# ============================================================
# 全局服务实例
# ============================================================

chat_service = ChatService()


def init_chat_service(ollama_base_url: str = "http://localhost:11434"):
    """初始化全局对话服务（应用启动时调用）"""
    chat_service.initialize(ollama_base_url)
