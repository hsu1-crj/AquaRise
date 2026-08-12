@echo off
chcp 65001 >nul 2>&1
title AQUARISE 移动端服务器
echo.
echo   AQUARISE 移动端 · 启动中...
echo.
python "%~dp0serve.py" %*
pause
