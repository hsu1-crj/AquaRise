"""
LLM模块 - 水下垃圾自动识别与海洋污染分析系统

子模块:
- fine_tune/   : LLaMA Factory 微调配置与数据集
- deploy/      : Ollama 本地部署配置 (Modelfile)
- rag/         : RAG 知识库 (ChromaDB + LangChain)
- digital_human/: 数字人API平台 SDK集成与文本驱动
- chat_api.py  : FastAPI 对话接口 (流式SSE输出)
"""

__version__ = "0.1.0"
