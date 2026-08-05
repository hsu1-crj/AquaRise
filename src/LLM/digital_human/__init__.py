"""
数字人交互模块 - 魔珐星云（魔珐科技）平台

子模块:
- config.yaml         : 魔珐星云 SDK 配置文件（形象、交互行为、SSML等）
- sdk_integration.js  : 浏览器端 JS SDK 集成（init/speak/stop/状态控制/降级/Token刷新）
- pipeline.py         : LLM → 数字人文本驱动管道（断句+SSML注入+流式推送）

魔珐星云数字人自带语音能力，无需独立配置 TTS。
"""

__version__ = "0.1.0"
