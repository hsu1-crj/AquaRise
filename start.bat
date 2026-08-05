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
uvicorn src.backend.main:app --host 0.0.0.0 --port 8000 --reload
pause
