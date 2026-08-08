# 海洋守护者 API（src/backend）

由 `test/` 完整 FastAPI 后端迁移而来，作为 React 前端（`src/frontend`）的真实后端。
SSR 管理页面被 React SPA 取代，`pages_router` / `templates` 保留但仅作兼容（表单登录端点仍在）。

## 环境要求

- Python 3.12（用 `py -3`，避免 Windows Store 的 `python` 存根）
- MySQL 5.5+，账号 `root / 123456`，库 `fastapi_login`（不存在会自动创建）
- 可选：本地 Ollama（端口 11434），对话会优先走真实 LLM，不可用时自动回退到关键字存根

## 安装与启动

```bash
cd src/backend
py -3 -m pip install -r requirements.txt
py -3 -m uvicorn main:app --port 8000
```

## 前端启动（另一个终端）

```bash
cd src/frontend
npm install
npm run dev        # http://localhost:5173，/api 代理到 127.0.0.1:8000
```

登录账号：**admin / 123456**（首次启动自动播种；若 `users` 表来自旧库会自动迁移明文密码为 bcrypt）。

## 访问入口

| 地址 | 说明 |
|---|---|
| http://127.0.0.1:8000/docs | Swagger API 文档 |
| http://127.0.0.1:8000/assistant | 独立海洋小助手页面（备用入口） |
| http://localhost:5173 | React 前端（主入口） |

## API 一览（与前端 `src/frontend/src/types.ts` 契约对齐）

- `POST /api/v1/auth/login | /register | GET /me` — JWT 认证（Bearer token）
- `POST /api/v1/detect/image`（multipart: file, width, height）→ 前端 `DetectionResult`
- `POST /api/v1/detect/video` → 后台任务；`GET /detect/status|result` 查进度
- `GET /api/v1/detections` — 当前用户检测历史（中文等级）
- `GET /api/v1/stats/summary | /trend` — 仪表盘统计
- `POST /api/v1/chat`（`{messages, stream:true}`）— SSE 流式对话
- `GET/POST /api/v1/reports` — 报告列表 / 生成（JSON `{task_id, format}`）
- `GET /api/v1/knowledge` · `/api/v1/digital-human` — 知识库 / 数字人配置

## 前端数据模式

`src/frontend/.env.example`：`VITE_API_MODE=live`（默认走真实后端）；改为 `mock` 则用演示数据。
