@echo off
chcp 936 >nul
title 海瞳 - 海洋3D态势 启动器
echo ============================================
echo   海瞳 · 海洋 3D 态势 一键启动
echo   依赖: MySQL 服务已运行 (默认本机3306)
echo ============================================
echo.
echo [1/3] 启动后端 (端口8000)...
start "haitong-backend" cmd /k "cd /d %~dp0src\backend && python -m uvicorn main:app --port 8000"
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
start http://localhost:5173/#ocean3d
echo.
echo 已就绪并打开浏览器! 没弹出手动访问: http://localhost:5173
echo 登录: admin / 123456   入口: 左侧菜单「海洋 3D 态势」
echo 用完关闭两个黑窗口即可。
pause
