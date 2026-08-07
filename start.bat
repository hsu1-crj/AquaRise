@echo off
echo ========================================
echo   Ocean Guardian - Backend Server
echo ========================================
echo.
echo Make sure Ollama is running (ollama serve)
echo URL: http://localhost:8000/assistant
echo Docs: http://localhost:8000/docs
echo.
cd /d "%~dp0"
start http://localhost:8000/assistant
REM ── HuggingFace 离线模式 ──
REM 本机无法访问 huggingface.co，嵌入模型已缓存于本地。
REM 必须在 Python 启动前设置，否则 huggingface_hub 会在 import 时缓存为在线模式，
REM 导致首次对话时 RAG 卡在网络重试中数分钟无响应。
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
set HF_DATASETS_OFFLINE=1
uvicorn src.backend.main:app --host 0.0.0.0 --port 8000 --reload
pause
