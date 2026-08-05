"""
魔珐星云数字人平台 → LLM文本驱动对接模块

功能:
- LLM 输出断句处理
- SSML 标记注入（停顿、语调）
- 文本推送至魔珐星云 JS SDK（通过服务端 WebSocket/SSE 中转）

魔珐星云数字人自带语音能力，本模块仅负责文本→SSML→推送的管道处理。
"""

import re
from typing import List, Generator, Optional

import yaml
from pathlib import Path


class DigitalHumanPipeline:
    """LLM 输出 → 魔珐星云数字人驱动的文本处理管道"""

    # 默认配置文件路径
    CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"

    def __init__(self, config_path: Optional[str] = None):
        """
        初始化管道

        Args:
            config_path: 魔珐星云配置文件路径
        """
        config_file = Path(config_path) if config_path else self.CONFIG_PATH
        with open(config_file, "r", encoding="utf-8") as f:
            self.config = yaml.safe_load(f)

        self.split_config = self.config["interaction"]["sentence_split"]
        self.ssml_config = self.config["interaction"]["ssml"]

    def split_sentences(self, text: str) -> List[str]:
        """
        将 LLM 输出断句为适合数字人口播的短句

        断句规则:
        1. 在标点符号处断开
        2. 单句不超过 max_length 字符
        3. 单句不少于 min_length 字符（会合并过短的句子）

        Args:
            text: LLM 原始输出

        Returns:
            断句后的句子列表
        """
        punctuations = self.split_config["punctuations"]
        max_len = self.split_config["max_length"]
        min_len = self.split_config["min_length"]

        # 构建断句正则
        punct_pattern = "|".join(re.escape(p) for p in punctuations)
        raw_sentences = re.split(f"(?<=[{punct_pattern}])", text)

        # 清理并合并短句
        sentences = []
        buffer = ""

        for s in raw_sentences:
            s = s.strip()
            if not s:
                continue

            buffer += s

            # 如果缓冲区足够长或在标点处结束，则输出
            if len(buffer) >= min_len and any(buffer.endswith(p) for p in punctuations):
                if len(buffer) > max_len:
                    # 超长句子二次切割（在逗号处断开）
                    sub_sentences = self._split_long(buffer, max_len)
                    sentences.extend(sub_sentences)
                else:
                    sentences.append(buffer)
                buffer = ""

        # 处理剩余文本
        if buffer.strip():
            sentences.append(buffer.strip())

        return sentences

    def _split_long(self, text: str, max_len: int) -> List[str]:
        """处理超长句子的二次切割"""
        parts = []
        while len(text) > max_len:
            # 在 max_len 范围内找最后一个逗号断开
            cut_point = text.rfind("，", 0, max_len)
            if cut_point == -1:
                cut_point = text.rfind("、", 0, max_len)
            if cut_point == -1:
                cut_point = max_len

            parts.append(text[:cut_point + 1])
            text = text[cut_point + 1:]

        if text.strip():
            parts.append(text.strip())
        return parts

    def inject_ssml(self, sentences: List[str]) -> str:
        """
        为断句后的文本注入 SSML 标记

        魔珐星云支持 SSML 增强数字人表达，包括停顿和语调控制。

        Args:
            sentences: 断句后的句子列表

        Returns:
            SSML 标记后的完整文本
        """
        if not self.ssml_config.get("enabled", False):
            return "".join(sentences)

        break_ms = self.ssml_config.get("break_between_sentences", 500)

        ssml_parts = ["<speak>"]
        for sentence in sentences:
            # 对每个句子包裹语气标记
            ssml_parts.append(
                f'<s>{sentence}<break time="{break_ms}ms"/></s>'
            )
        ssml_parts.append("</speak>")

        return "\n".join(ssml_parts)

    def process_stream(self, text_stream: Generator[str, None, None]) -> Generator[dict, None, None]:
        """
        处理 LLM 流式输出并逐句推送至数字人

        使用方式:
            for chunk in llm.stream_response(prompt):
                for event in pipeline.process_stream([chunk]):
                    yield event  # 通过 WebSocket/SSE 推送至前端魔珐星云 SDK

        Args:
            text_stream: LLM 流式文本生成器

        Yields:
            包含 sentence 和 ssml 的字典事件，前端直接调用 sdk.speak(ssml)
        """
        buffer = ""

        for chunk in text_stream:
            buffer += chunk

            # 检查是否有完整句子
            sentences = self.split_sentences(buffer)

            # 如果最后一个句子不完整，保留在缓冲区
            if len(sentences) > 1 or (
                sentences and any(buffer.endswith(p) for p in self.split_config["punctuations"])
            ):
                complete_sentences = sentences[:-1] if len(sentences) > 1 else sentences
                for sent in complete_sentences:
                    yield {
                        "sentence": sent,
                        "ssml": self.inject_ssml([sent]),
                        "type": "speak",
                    }
                buffer = sentences[-1] if len(sentences) > 1 else ""

        # 推送剩余缓冲
        if buffer.strip():
            yield {
                "sentence": buffer.strip(),
                "ssml": self.inject_ssml([buffer.strip()]),
                "type": "speak",
            }

        # 发送结束事件
        yield {"type": "end"}

    def process(self, text: str) -> dict:
        """
        处理完整的 LLM 输出文本

        Args:
            text: LLM 完整输出

        Returns:
            {"sentences": [...], "ssml": "..."}
        """
        sentences = self.split_sentences(text)
        ssml = self.inject_ssml(sentences)
        return {
            "sentences": sentences,
            "ssml": ssml,
        }
