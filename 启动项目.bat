@echo off
chcp 936 >nul
title 海瞳 - 项目一键启动器
echo ============================================
echo   海瞳 · 海洋全域智守平台 一键启动
echo   依赖: MySQL 服务已运行 (默认本机3306)
echo ============================================
echo.
REM 优先使用 xa_code 虚拟环境(含insightface人脸识别依赖), 找不到则回退系统python
set "PY=python"
for /f "delims=" %%i in ('conda info --base 2^>nul') do (
  if exist "%%i\envs\xa_code\python.exe" set "PY=%%i\envs\xa_code\python.exe"
)
REM 首次运行(或 node_modules 被清理后)自动安装前端依赖
if not exist "%~dp0src\frontend\node_modules\" (
  echo [0/3] 检测到前端依赖缺失, 自动执行 npm install (约1-3分钟)...
  cd /d "%~dp0src\frontend"
  call npm install
  cd /d "%~dp0"
)
echo [1/3] 启动后端 (端口8000, 解释器: %PY%)...
start "haitong-backend" cmd /k "cd /d %~dp0src\backend && %PY% -m uvicorn main:app --port 8000"
echo [2/3] 启动前端 (端口5173, 首次编译约10-20秒)...
start "haitong-frontend" cmd /k "cd /d %~dp0src\frontend && npm run dev"
echo [3/3] 等待前端就绪后自动打开浏览器 (最长60秒)...
set /a waited=0
REM 等待循环: 前端就绪则跳到ready标签(注意: 标签必须单冒号, 双冒号是注释不可作为goto目标)
:waitloop
curl -s -o nul http://localhost:5173 2>nul && goto ready
set /a waited+=3
if %waited% lss 60 goto waitloop
echo 前端60秒内未就绪, 请看 haitong-frontend 窗口里的报错。
pause
exit /b 1
:ready
start http://localhost:5173
echo.
echo 已就绪并打开浏览器! 没弹出手动访问: http://localhost:5173
echo 登录: admin / 123456   检测/分析/报告/3D态势等各功能均从左侧菜单进入。
echo 用完关闭两个黑窗口即可。
pause
