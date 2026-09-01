"""海洋守护者 LLM 对话服务：Ollama + 强约束提示词 + RAG。"""

import json
import logging
import os
import re
from pathlib import Path
from typing import Optional, AsyncGenerator, List, Dict, Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "ds-ocean_mingzhe")
DEFAULT_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.45"))
DEFAULT_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "768"))

# 只清除真正的思维链泄漏痕迹；"嗯"等自然口语承接不再是删除对象——
# 它们恰恰是对话感的一部分，过去被无差别清掉后每条回答都像报告开头。
_THINK_TRACE_RE = re.compile(
    r"(?:^|\n)\s*(?:用户问的是|用户的问题是|首先[，,、 ]*(?:我得|我需要|让我|我先)|"
    r"让我想想|我来分析一下|我需要回忆|先分析一下|接下来我会|思考一下)[：:，, ]*",
    re.I,
)


class ChatMessage(BaseModel):
    role: str = Field(..., description="角色: user / assistant / system")
    content: str = Field(..., min_length=1, description="消息内容")


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    model: str = Field(default=DEFAULT_MODEL)
    temperature: float = Field(default=DEFAULT_TEMPERATURE, ge=0, le=2.0)
    max_tokens: int = Field(default=DEFAULT_MAX_TOKENS, ge=1, le=8192)
    stream: bool = True
    enable_rag: bool = True
    # 由后端按权限查询并注入的报告上下文，不接受客户端直接伪造事实文本。
    report_context: Optional[str] = None


class ChatResponse(BaseModel):
    role: str = "assistant"
    content: str
    model: str
    finish_reason: Optional[str] = None


_FOLLOW_UP_RE = re.compile(
    r"上面|刚才|前面|上一(?:条|轮|个|次)|第一条|你提到|你(?:说的|刚)|其中|除此|除了|该(?:公约|附则|规定|问题)|"
    r"这个|这些|那个|那些|继续|再说|进一步|具体(?:呢|来说|是怎么|怎么)|分别是|它(?:们)?|那.{0,8}呢",
    re.I,
)

_COUNTERFACTUAL_RE = re.compile(
    r"反事实|(?:如果|假如|假设|倘若).{0,32}(?:没有|不存在|消失|停止|不再).{0,48}"
    r"(?:会|将).{0,24}(?:怎样|如何|什么|不同|变化|影响)",
    re.I,
)


def _is_counterfactual_question(text: str) -> bool:
    """识别要求推演一个不存在条件的开放问题，不拦截普通“如果发现垃圾怎么办”。"""
    return bool(_COUNTERFACTUAL_RE.search((text or "").strip()))


def _counterfactual_instruction(text: str) -> Optional[str]:
    if not _is_counterfactual_question(text):
        return None
    return (
        "本轮是开放反事实问题。请分点使用【较确定推论】【推测】【不确定性】三个小节："
        "较确定推论只写由题设直接导致、且有可靠常识支持的方向；推测必须使用‘可能’等限定词；"
        "不确定性要列出仍会影响结果的变量，并明确不能断定单一结局。"
        "禁止把聚合物材质名称（如 PET、HDPE）直接等同于粒径类别‘微塑料’；"
        "只有说明颗粒或碎片小于相应尺寸时，才能称为微塑料。不要使用‘一定、全部、必然均匀’等绝对化表述。"
    )


def _build_retrieval_query(messages: List[ChatMessage], max_user_turns: int = 2) -> str:
    """为指代型追问补入最近主题，普通新问题仍只检索当前轮。"""
    user_turns = [
        message.content.strip()
        for message in messages
        if message.role == "user" and message.content.strip()
    ]
    if not user_turns:
        return ""
    current = user_turns[-1]
    if len(user_turns) == 1 or not _FOLLOW_UP_RE.search(current):
        return current
    selected = user_turns[-max(2, min(max_user_turns, 3)):]
    return "\n".join(f"用户问题：{turn}" for turn in selected)


class ModelInfo(BaseModel):
    name: str
    size: str
    modified_at: str


class _ThinkFilter:
    """过滤 DeepSeek R1 的隐藏思考标签，兼容标签跨 chunk 的情况。"""
    def __init__(self) -> None:
        self.buffer = ""
        self.in_think = False

    def feed(self, text: str) -> str:
        self.buffer += text
        output: list[str] = []
        while self.buffer:
            if self.in_think:
                end = re.search(r"</think\s*>", self.buffer, re.I)
                if not end:
                    self.buffer = self.buffer[-20:]
                    break
                self.buffer = self.buffer[end.end():]
                self.in_think = False
                continue
            start = re.search(r"<think\s*>", self.buffer, re.I)
            if not start:
                # 留下可能是半个标签的尾巴，避免把标签露给前端
                keep = min(20, len(self.buffer))
                output.append(self.buffer[:-keep] if len(self.buffer) > keep else "")
                self.buffer = self.buffer[-keep:]
                break
            output.append(self.buffer[:start.start()])
            self.buffer = self.buffer[start.end():]
            self.in_think = True
        return "".join(output)

    def flush(self) -> str:
        if self.in_think:
            return ""
        text = self.buffer
        self.buffer = ""
        return re.sub(r"</?think\s*>", "", text, flags=re.I)


def clean_model_text(text: str) -> str:
    """清除 R1 思维标签和常见人机化前后缀。"""
    # A malformed/length-limited response can contain an opening tag without
    # its closing partner.  Treat the remainder as hidden reasoning too;
    # otherwise the protocol layer could accidentally expose the trace.
    text = re.sub(r"<think\s*>.*?(?:</think\s*>|$)", "", text or "", flags=re.I | re.S)
    text = re.sub(r"</?think\s*>", "", text, flags=re.I)
    return _THINK_TRACE_RE.sub("\n", text).strip()


_INVALID_OUTPUT_CODE = "invalid_model_output"
_TRUNCATED_DONE_REASONS = frozenset({"length", "max_tokens", "max_token", "limit"})


class OllamaInvalidOutputError(RuntimeError):
    """Raised when Ollama returned no complete, user-visible answer."""

    code = _INVALID_OUTPUT_CODE

    def __init__(
        self,
        reason: str,
        *,
        content_length: int = 0,
        thinking_length: int = 0,
        done_reason: Optional[str] = None,
    ) -> None:
        self.reason = reason
        self.content_length = content_length
        self.thinking_length = thinking_length
        self.done_reason = done_reason
        super().__init__(f"Ollama 返回无效模型输出（{reason}）")


def extract_visible_model_content(text: Any) -> str:
    """Return only visible assistant text, never the model's thinking trace.

    ``message.thinking`` is handled by the caller and is intentionally not
    accepted here.  Running the same stateful filter over a complete response
    also suppresses an unmatched ``<think>`` block, which ``clean_model_text``
    historically could not do on its own.
    """
    if not isinstance(text, str):
        return ""
    state = _ThinkFilter()
    visible = state.feed(text) + state.flush()
    return clean_model_text(visible)


def _normalise_done_reason(value: Any) -> str:
    return str(value or "").strip().lower()


def _validate_model_output(
    content: Any,
    done_reason: Any = None,
    *,
    raw_content_seen: bool = False,
    thinking_length: int = 0,
    malformed_content: bool = False,
    missing_done: bool = False,
) -> str:
    """Validate a model answer and return its cleaned visible text.

    The local DeepSeek-R1 derivative sometimes reports a full reasoning trace
    while leaving ``message.content`` empty.  Thinking is not an answer, and a
    ``length`` finish reason means the visible answer may be incomplete.  Both
    cases must be rejected so the caller can use its deterministic/RAG
    fallback.
    """
    visible = extract_visible_model_content(content)
    normalised_reason = _normalise_done_reason(done_reason)
    visible_length = len(visible)
    # An unterminated stream is incomplete regardless of whether its last
    # line also happened to be malformed or reported a length limit.  Keep
    # this reason stable so callers can distinguish a transport interruption
    # from a completed but invalid model response.
    if missing_done:
        raise OllamaInvalidOutputError(
            "missing_done",
            content_length=visible_length,
            thinking_length=thinking_length,
            done_reason=normalised_reason or None,
        )
    if malformed_content:
        raise OllamaInvalidOutputError(
            "malformed_content",
            content_length=visible_length,
            thinking_length=thinking_length,
            done_reason=normalised_reason or None,
        )
    if normalised_reason in _TRUNCATED_DONE_REASONS:
        raise OllamaInvalidOutputError(
            normalised_reason,
            content_length=visible_length,
            thinking_length=thinking_length,
            done_reason=normalised_reason,
        )
    if not visible.strip():
        reason = "thinking_only" if thinking_length or raw_content_seen else "empty_content"
        raise OllamaInvalidOutputError(
            reason,
            content_length=0,
            thinking_length=thinking_length,
            done_reason=normalised_reason or None,
        )
    return visible


def _sse_error_event(
    message: str,
    *,
    code: str,
    reason: Optional[str] = None,
    done_reason: Optional[str] = None,
) -> str:
    payload: dict[str, str] = {"error": message, "code": code}
    if reason:
        payload["reason"] = reason
    if done_reason:
        payload["done_reason"] = done_reason
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class OllamaClient:
    def __init__(self, base_url: str = "http://localhost:11434"):
        self.base_url = base_url.rstrip("/")

    def _payload(self, model: str, messages: List[Dict[str, str]], temperature: float, max_tokens: int, stream: bool) -> dict:
        return {
            "model": model or DEFAULT_MODEL,
            "messages": messages,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
                # repeat_penalty 从 1.12 降到 1.05：旧值对连贯性的伤害大于防复读收益，
                # 防复读已由路由层的 is_near_duplicate_answer 门禁负责。
                "repeat_penalty": 1.05,
                "top_p": 0.9,
            },
            "think": False,
            "keep_alive": os.getenv("LLM_KEEP_ALIVE", "10m"),
            "stream": stream,
        }

    async def chat(self, model: str, messages: List[Dict[str, str]], temperature: float = DEFAULT_TEMPERATURE, max_tokens: int = DEFAULT_MAX_TOKENS, stream: bool = False) -> dict:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=float(os.getenv("LLM_TIMEOUT_SECONDS", "120")))
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{self.base_url}/api/chat", json=self._payload(model, messages, temperature, max_tokens, stream)) as response:
                if response.status != 200:
                    raise RuntimeError(f"Ollama API 错误 ({response.status}): {(await response.text())[:500]}")
                result = await response.json()
                if not isinstance(result, dict):
                    raise OllamaInvalidOutputError("malformed_response")
                message = result.get("message")
                if not isinstance(message, dict):
                    raise OllamaInvalidOutputError("missing_message")
                raw_content = message.get("content", "")
                malformed_content = raw_content not in (None, "") and not isinstance(raw_content, str)
                raw_thinking = message.get("thinking", "")
                thinking_length = len(raw_thinking) if isinstance(raw_thinking, str) else len(str(raw_thinking or ""))
                raw_content_seen = isinstance(raw_content, str) and bool(raw_content.strip())
                visible = _validate_model_output(
                    raw_content,
                    result.get("done_reason"),
                    raw_content_seen=raw_content_seen,
                    thinking_length=thinking_length,
                    malformed_content=malformed_content,
                )
                # Do not return the hidden reasoning field to callers that may
                # serialize this object or accidentally display it later.
                sanitized = dict(result)
                sanitized_message = dict(message)
                sanitized_message["content"] = visible
                sanitized_message.pop("thinking", None)
                sanitized["message"] = sanitized_message
                sanitized.pop("thinking", None)
                logger.debug(
                    "Ollama 响应通过正文门禁: content_chars=%d thinking_chars=%d done_reason=%s",
                    len(visible),
                    thinking_length,
                    result.get("done_reason"),
                )
                return sanitized

    async def chat_stream(self, model: str, messages: List[Dict[str, str]], temperature: float = DEFAULT_TEMPERATURE, max_tokens: int = DEFAULT_MAX_TOKENS) -> AsyncGenerator[str, None]:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=float(os.getenv("LLM_TIMEOUT_SECONDS", "120")))
        state = _ThinkFilter()
        done_seen = False
        terminal_sent = False
        raw_content_seen = False
        malformed_content = False
        thinking_length = 0
        done_reason: Any = None
        visible_parts: list[str] = []
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f"{self.base_url}/api/chat", json=self._payload(model, messages, temperature, max_tokens, True)) as response:
                    if response.status != 200:
                        raise RuntimeError(f"Ollama API 错误 ({response.status}): {(await response.text())[:500]}")
                    async for raw_line in response.content:
                        if isinstance(raw_line, bytes):
                            line = raw_line.decode("utf-8", errors="ignore").strip()
                        else:
                            line = str(raw_line).strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            # Ollama emits one JSON object per line.  A
                            # malformed line can hide part of the answer, so
                            # remember the protocol violation and reject the
                            # complete stream instead of silently succeeding.
                            malformed_content = True
                            continue
                        if not isinstance(data, dict):
                            malformed_content = True
                            continue
                        if data.get("error"):
                            raise RuntimeError(str(data.get("error")))
                        done_reason = data.get("done_reason", done_reason)
                        message = data.get("message") or {}
                        if not isinstance(message, dict):
                            malformed_content = True
                            message = {}
                        raw_content = message.get("content", "")
                        if raw_content is None:
                            raw_content = ""
                        elif not isinstance(raw_content, str):
                            malformed_content = True
                            raw_content = ""
                        if raw_content.strip():
                            raw_content_seen = True
                        raw_thinking = message.get("thinking", "")
                        if raw_thinking:
                            thinking_length += len(raw_thinking) if isinstance(raw_thinking, str) else len(str(raw_thinking))
                        visible = state.feed(raw_content)
                        if visible:
                            visible_parts.append(visible)
                        if data.get("done"):
                            done_seen = True
                            tail = state.flush()
                            combined = "".join(visible_parts) + tail
                            try:
                                approved = _validate_model_output(
                                    combined,
                                    done_reason,
                                    raw_content_seen=raw_content_seen,
                                    thinking_length=thinking_length,
                                    malformed_content=malformed_content,
                                )
                            except OllamaInvalidOutputError as exc:
                                logger.warning(
                                    "Ollama 流式输出未通过正文门禁: reason=%s done_reason=%s content_chars=%d thinking_chars=%d",
                                    exc.reason,
                                    done_reason,
                                    exc.content_length,
                                    thinking_length,
                                )
                                terminal_sent = True
                                yield _sse_error_event(
                                    "Ollama 返回无效模型输出，已交给安全兜底",
                                    code=exc.code,
                                    reason=exc.reason,
                                    done_reason=_normalise_done_reason(done_reason) or None,
                                )
                                yield "data: [DONE]\n\n"
                                return
                            # Do not expose provisional chunks before the
                            # terminal validation above.  A length-limited or
                            # thinking-only response must be completely
                            # invisible to direct low-level callers as well as
                            # to the backend router.
                            yield f"data: {json.dumps({'content': approved}, ensure_ascii=False)}\n\n"
                            logger.debug(
                                "Ollama 流式响应通过正文门禁: content_chars=%d thinking_chars=%d done_reason=%s",
                                len(extract_visible_model_content(combined)),
                                thinking_length,
                                done_reason,
                            )
                            terminal_sent = True
                            yield "data: [DONE]\n\n"
                            return
                    if not done_seen:
                        # A network/proxy interruption can end the iterator
                        # without Ollama's terminal object.  Even if some text
                        # arrived, it is incomplete and must not be accepted.
                        try:
                            _validate_model_output(
                                "".join(visible_parts) + state.flush(),
                                done_reason,
                                raw_content_seen=raw_content_seen,
                                thinking_length=thinking_length,
                                malformed_content=malformed_content,
                                missing_done=True,
                            )
                        except OllamaInvalidOutputError as exc:
                            logger.warning(
                                "Ollama 流式响应缺少完成标记: reason=%s done_reason=%s content_chars=%d thinking_chars=%d",
                                exc.reason,
                                done_reason,
                                exc.content_length,
                                thinking_length,
                            )
                            terminal_sent = True
                            yield _sse_error_event(
                                "Ollama 流式响应未正常结束，已交给安全兜底",
                                code=exc.code,
                                reason=exc.reason,
                                done_reason=_normalise_done_reason(done_reason) or None,
                            )
                            yield "data: [DONE]\n\n"
                            return
                        # Defensive fallback: `missing_done=True` should always
                        # raise, but never allow a future validator change to
                        # turn an unterminated stream into a success.
                        terminal_sent = True
                        yield _sse_error_event(
                            "Ollama 流式响应未正常结束，已交给安全兜底",
                            code=_INVALID_OUTPUT_CODE,
                            reason="missing_done",
                        )
                        yield "data: [DONE]\n\n"
                        return
        except Exception as exc:
            logger.exception("Ollama 流式调用失败")
            if not terminal_sent:
                terminal_sent = True
                message = str(exc) or "Ollama 流式调用失败"
                yield _sse_error_event(message, code="ollama_error")
                yield "data: [DONE]\n\n"

    async def list_models(self) -> List[Dict[str, Any]]:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{self.base_url}/api/tags") as response:
                if response.status != 200:
                    raise RuntimeError(f"获取模型列表失败: {response.status}")
                return (await response.json()).get("models", [])


class RAGService:
    """优先使用向量检索；依赖不全时自动使用本地词法检索，保证知识库仍然可用。"""
    def __init__(self):
        self._retriever = None
        self._initialized = False
        self._vector_ok = False
        self._lexical_reranker = None

    def initialize(self):
        if self._initialized:
            return
        try:
            from .rag.knowledge_base import OceanKnowledgeBase
            from .rag.retriever import OceanRetriever
            self._retriever = OceanRetriever(OceanKnowledgeBase())
            self._retriever.kb.build()
            self._vector_ok = True
            logger.info("RAG 向量知识库初始化完成")
        except Exception as exc:
            self._vector_ok = False
            logger.warning("向量 RAG 不可用，切换到本地词法检索: %s", exc)
            try:
                from .rag.lexical_retriever import LocalKnowledgeRetriever
                self._retriever = LocalKnowledgeRetriever()
            except Exception:
                logger.exception("本地知识库检索也初始化失败")
                self._retriever = None
        self._initialized = True

    def reload(self):
        """上传新文档后调用：向量链路实时查询无需重载；词法回退需重建文件索引。"""
        if not self._initialized or self._vector_ok or self._retriever is None:
            return
        try:
            from .rag.lexical_retriever import LocalKnowledgeRetriever
            self._retriever = LocalKnowledgeRetriever()
            logger.info("词法知识库已重载，可检索新上传文档")
        except Exception as exc:
            logger.warning("词法知识库重载失败: %s", exc)

    def _get_lexical_reranker(self):
        """向量库可用时提供一个轻量词法二阶段排序器。

        向量相似度对“鱼类识别”“ROV 安全”“重金属超标”这类短中文问句
        容易把相邻主题排到前面；词法层只负责实体/短语重排，不替代向量召回。
        初始化失败时保持原向量结果，不能让排序器影响主链路可用性。
        """
        if self._lexical_reranker is False:
            return None
        if self._lexical_reranker is None:
            try:
                from .rag.lexical_retriever import LocalKnowledgeRetriever

                self._lexical_reranker = LocalKnowledgeRetriever()
            except Exception:
                logger.debug("词法二阶段排序器初始化失败", exc_info=True)
                self._lexical_reranker = False
        return self._lexical_reranker if self._lexical_reranker is not False else None

    @staticmethod
    def _merge_ranked_results(
        vector_results: List[Dict[str, Any]],
        lexical_results: List[Dict[str, Any]],
        limit: int,
    ) -> List[Dict[str, Any]]:
        """按实体词法命中 + 向量分数合并候选，并限制单文档占比。"""
        merged: dict[str, Dict[str, Any]] = {}
        # Keep the origin alongside each item.  Comparing dictionaries with
        # ``item in lexical_results`` is ambiguous when the same chunk appears
        # in both lists (and is O(n) for every candidate), which can silently
        # classify a vector hit as lexical evidence.
        for origin, candidates in (("vector", vector_results), ("lexical", lexical_results)):
            for item in candidates:
                content = str(item.get("content") or "").strip()
                if not content:
                    continue
                key = re.sub(r"\s+", "", content)
                current = merged.get(key)
                try:
                    score = float(item.get("score"))
                except (TypeError, ValueError):
                    score = 0.0
                metadata = dict(item.get("metadata") or {})
                source = str(item.get("source") or metadata.get("source") or "项目知识库")
                if current is None:
                    current = {
                        "content": content,
                        "source": Path(source).name,
                        "metadata": metadata,
                        "vector_score": 0.0,
                        "lexical_score": 0.0,
                    }
                    merged[key] = current
                elif not current.get("metadata") and metadata:
                    current["metadata"] = metadata
                # lexical 分数用于实体优先级；向量分数保留为语义补充。
                score_key = "lexical_score" if origin == "lexical" else "vector_score"
                current[score_key] = max(float(current.get(score_key, 0.0)), score)
        ranked = []
        for item in merged.values():
            lexical_score = float(item.pop("lexical_score", 0.0))
            vector_score = float(item.pop("vector_score", 0.0))
            # 词法命中有明确实体时优先；没有词法候选的内容仍由向量分数保留。
            item["score"] = round(max(lexical_score, vector_score), 4) or None
            item["_rank"] = lexical_score * 1.8 + vector_score * 0.45 + (0.25 if lexical_score else 0.0)
            ranked.append(item)
        ranked.sort(key=lambda value: value.pop("_rank", 0.0), reverse=True)
        selected: List[Dict[str, Any]] = []
        source_counts: dict[str, int] = {}
        for item in ranked:
            source = item["source"]
            if source_counts.get(source, 0) >= 2:
                continue
            selected.append(item)
            source_counts[source] = source_counts.get(source, 0) + 1
            if len(selected) >= limit:
                break
        return selected

    @staticmethod
    def _restrict_vector_sources(
        query: str,
        vector_results: List[Dict[str, Any]],
        lexical_results: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Keep vector candidates on the lexical-confirmed topic source.

        Vector similarity is useful for recall, but short Chinese questions
        often rank neighbouring chapters (for example, a heavy-metal query
        can pull the microplastics and oil bullets from the same monitoring
        corpus).  The local lexical index has explicit entity/source guards;
        for a single-topic query it is therefore the authority for the source
        allow-list.  Multi-topic/comparison questions intentionally retain
        all sources so that the answer can cover both sides.
        """
        if not vector_results or not lexical_results:
            return vector_results
        try:
            from .rag.lexical_retriever import (
                _allows_multiple_topic_sources,
                _query_entity_groups,
            )

            entity_groups = _query_entity_groups(query)
            if not entity_groups or _allows_multiple_topic_sources(query, entity_groups):
                return vector_results
        except Exception:
            # A compatibility/test retriever may not expose the optional
            # topic helpers; preserving vector recall is safer than failing
            # the entire chat request.
            return vector_results

        def source_name(item: Dict[str, Any]) -> str:
            metadata = item.get("metadata") or {}
            return Path(str(item.get("source") or metadata.get("source") or "项目知识库")).name

        allowed_sources = {source_name(item) for item in lexical_results if source_name(item)}
        if not allowed_sources:
            return vector_results
        return [item for item in vector_results if source_name(item) in allowed_sources]

    def retrieve(self, query: str, k: Optional[int] = None) -> tuple[str, List[Dict[str, Any]]]:
        if not self._initialized:
            self.initialize()
        if not self._retriever:
            return "", []
        try:
            limit = max(1, int(k or os.getenv("RAG_TOP_K", "3")))
            try:
                _, vector_or_lexical_results = self._retriever.retrieve_for_llm(query, limit)
            except Exception:
                logger.debug("主 RAG 检索失败，尝试词法回退", exc_info=True)
                vector_or_lexical_results = []

            raw_results = vector_or_lexical_results or []
            if self._vector_ok:
                # Even an empty vector result should get a lexical chance.  A
                # similarity threshold or a stale Chroma collection can return
                # no candidates for a short Chinese query while the local
                # document index still has an exact, useful match.
                reranker = self._get_lexical_reranker()
                if reranker is not None:
                    try:
                        lexical_results = reranker.search(query, max(limit * 3, 8))
                    except Exception:
                        logger.debug("词法补召回失败", exc_info=True)
                        lexical_results = []
                    raw_results = self._restrict_vector_sources(
                        query, raw_results, lexical_results
                    )
                    raw_results = self._merge_ranked_results(raw_results, lexical_results, limit)
            results: List[Dict[str, Any]] = []
            source_counts: dict[str, int] = {}
            seen_content: set[str] = set()
            for index, item in enumerate(raw_results, 1):
                content = str(item.get("content") or "").strip()
                if not content:
                    continue
                metadata = item.get("metadata") or {}
                source = Path(str(item.get("source") or metadata.get("source") or "项目知识库")).name
                normalized = re.sub(r"\s+", "", content)
                if normalized in seen_content or source_counts.get(source, 0) >= 2:
                    continue
                seen_content.add(normalized)
                results.append({
                    "id": index,
                    "source": source,
                    "content": content,
                    "score": item.get("score"),
                })
                source_counts[source] = source_counts.get(source, 0) + 1
                if len(results) >= limit:
                    break
            context = "\n\n".join(
                f"[S{item['id']}] 来源：{item['source']}\n{item['content']}"
                for item in results
            )
            return context, results
        except Exception as exc:
            logger.warning("RAG 检索失败: %s", exc)
            return "", []

    def retrieve_context(self, query: str, k: Optional[int] = None) -> str:
        return self.retrieve(query, k)[0]


class ChatService:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def initialize(self, ollama_base_url: Optional[str] = None):
        if self._initialized:
            return
        self.ollama = OllamaClient(ollama_base_url or os.getenv("OLLAMA_URL", "http://localhost:11434"))
        self.rag = RAGService()
        self._initialized = True
        logger.info("ChatService 初始化完成，模型=%s，RAG=on", DEFAULT_MODEL)

    @staticmethod
    def _last_user(messages: List[ChatMessage]) -> str:
        return next((m.content.strip() for m in reversed(messages) if m.role == "user" and m.content.strip()), "")

    def prepare_messages(
        self, request: ChatRequest, system_prompt: Optional[str] = None
    ) -> tuple[List[Dict[str, str]], List[Dict[str, Any]]]:
        canonical = system_prompt or (
            "你是“海洋守护者”，海瞳海洋垃圾识别与海洋环保平台的 AI 助手，"
            "也是一位热爱海洋的研究型伙伴。"
            "语气要求：耐心、真诚、有温度，像向朋友讲解自己熟悉的研究领域；"
            "偶尔带一点轻幽默，但不玩梗、不油腻、不堆砌表情符号。"
            "回答方式：先自然地回应用户问题本身（可以用一句话承接对方的关注点），再展开说明；"
            "多用生活化例子和类比解释专业概念；长短句交错，不要每条回答都用同款开头和同款结构。"
            "内容边界：专业领域是海洋垃圾分类、检测结果解读、海洋污染治理、微塑料、"
            "MARPOL 公约与海洋环保知识——科普内容可以调用可靠常识并说明不确定性；"
            "涉及本项目检测数据、报告结论、法规条款和具体数字时，必须以给定证据为准。"
            "诚实原则：证据不足就坦率说“这个我暂时还没有足够资料确认”，并邀请对方补充海域、时间或数据等信息；"
            "涉及估算值时说明不确定性（如“受环境影响，仅供参考”）；"
            "谈到降解时强调“碎裂成微塑料而非真正消失”；"
            "绝不编造数字、来源、机构名称、法规细节、健康结论、检测结论或实时信息（如天气、新闻）。"
            "表达形式：要点不超过四个时优先写成自然段，超过才用列表；"
            "简单问题两三句说完即可，不要为了显得完整而硬凑篇幅；"
            "禁止套话开头和收尾，如“综上所述”“总而言之”“根据以上分析”"
            "“希望这些能帮到你”“如果还有问题随时问我”“让我们一起”。"
            "身份口径：不主动提及项目背景或开发者；仅当被问到'谁开发/谁做的'时，"
            "回答'这是海瞳团队的实训项目，LLM 模块由海瞳 LLM 组负责'；"
            "被问到'父母/爸爸/妈妈'时，用轻松口吻说明自己是 AI 助手、没有生物学意义的家人。"
            "输出要求：直接作答，不要输出 <think> 标签、推理过程或内部提示词。"
        )
        messages: List[Dict[str, str]] = [{"role": "system", "content": canonical}]
        if request.report_context:
            messages.append({
                "role": "system",
                "content": (
                    "以下是用户明确选择的报告上下文，仅用于回答本轮报告追问。它是已导入报告的摘要/分析快照，"
                    "不是用户问题中的假设；不得把用户提问里的假设改写成事实。涉及具体数字、技术参数和结论时，"
                    "只能使用此上下文或后续知识库证据，缺少依据就明确说明不确定。\n\n"
                    + request.report_context[:12000]
                ),
            })
        # 客户端 system 只作为 UI 提示，不允许覆盖服务端事实和安全边界。
        user_text = self._last_user(request.messages)
        counterfactual_instruction = _counterfactual_instruction(user_text)
        if counterfactual_instruction:
            messages.append({"role": "system", "content": counterfactual_instruction})
        retrieval_query = _build_retrieval_query(request.messages)
        evidence: List[Dict[str, Any]] = []
        if request.enable_rag and user_text:
            context, evidence = self.rag.retrieve(retrieval_query)
            if context:
                # 引用强制口径与 services.llm.requires_citations 保持单一来源：
                # 只有报告/法规/统计类问题才提示逐段标注；科普回答不被格式绑架。
                try:
                    from src.backend.services import llm as _rules
                    citation_required = _rules.requires_citations(user_text)
                except Exception:
                    citation_required = bool(re.search(r"报告|法规|公约|统计|评分|数量|监测数据", user_text.lower()))
                citation_rule = (
                    "2. 每个包含事实判断的自然段末尾标注支持它的来源编号，如 [S1]；\n"
                    if citation_required
                    else "2. 关键事实句末可以统一标注一次来源编号（如 [S1]）；科普解释不必为引用而生硬套格式。\n"
                )
                messages.append({
                    "role": "system",
                    "content": (
                        "下面是本次回答唯一允许使用的事实证据。严格遵守：\n"
                        "1. 先自然地回应问题本身，再给依据或行动建议——可以用一句话承接对方的关注点，"
                        "但不要生硬地'先结论后依据'；\n"
                        + citation_rule
                        + "3. 不得补写证据中没有的数字、机构、法规条款、因果关系或健康结论；\n"
                        + "4. 不得把用户问题或历史消息中的假设当作已验证事实；涉及具体数字、技术参数、编码或分类体系时，必须来自证据，否则明确说明不确定；\n"
                        + "5. 证据不足时明确说资料不足，不要依靠模型记忆补全；\n"
                        + "6. 不要大段照抄证据原文；篇幅与问题的复杂度匹配即可，上限 800 个汉字。\n\n"
                        + context
                    ),
                })
            else:
                messages.append({
                    "role": "system",
                    "content": (
                        "本次没有检索到可用的项目知识库证据。涉及检测、报告、法规和具体数字时，"
                        "请直接说明当前资料不足；一般海洋科普可以基于可靠通识回答，并明确不确定性，不能编造具体事件或机构。"
                    ),
                })
        for msg in request.messages:
            if msg.role in {"user", "assistant"} and msg.content.strip():
                messages.append({"role": msg.role, "content": msg.content.strip()})
        if not user_text:
            messages.append({"role": "user", "content": "请介绍你能帮助我做什么。"})
        return messages, evidence

    def build_messages(self, request: ChatRequest, system_prompt: Optional[str] = None) -> List[Dict[str, str]]:
        messages, _ = self.prepare_messages(request, system_prompt)
        return messages

    async def chat(self, request: ChatRequest, system_prompt: Optional[str] = None) -> ChatResponse:
        messages, _ = self.prepare_messages(request, system_prompt)
        model = request.model or DEFAULT_MODEL
        result = await self.ollama.chat(model, messages, request.temperature, request.max_tokens, False)
        return ChatResponse(content=clean_model_text(result.get("message", {}).get("content", "")), model=model, finish_reason=result.get("done_reason"))

    async def chat_stream(self, request: ChatRequest, system_prompt: Optional[str] = None) -> AsyncGenerator[str, None]:
        messages, _ = self.prepare_messages(request, system_prompt)
        async for event in self.ollama.chat_stream(request.model or DEFAULT_MODEL, messages, request.temperature, request.max_tokens):
            yield event


chat_service = ChatService()

def init_chat_service(ollama_base_url: Optional[str] = None):
    chat_service.initialize(ollama_base_url)


def reload_knowledge_retriever() -> None:
    """上传新文档后调用：让回退检索链路（词法）立即感知新文件；向量链路无需操作。"""
    if chat_service._initialized:
        chat_service.rag.reload()
