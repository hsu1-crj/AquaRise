# LLM 模块修复日志 — 2026-08-07（下午修复）

**操作员**: Mingzhe
**执行环境**: Windows 11 / Conda env `xa_code` (Python 3.11)
**前置引用**: `llm-module-progress-8.7.md`（上午完成的生产模型部署/RAG 构建工作）

---

## 问题总览

上午完成 LLM 模块全部搭建后，下午验证发现前端对话和数字人功能均不可用，共定位 4 个 Bug 并全部修复。

| # | Bug | 严重度 | 影响 |
|---|-----|--------|------|
| 1 | HF 离线变量未生效 | 🔴 高危 | RAG 加载嵌入模型时反复向 huggingface.co 发 HEAD 请求，流式响应挂死数分钟 |
| 2 | RAG 知识库路径多算一层 | 🔴 高危 | 路径指向错误目录，RAG 始终静默失败，降级为纯 LLM 无知识增强 |
| 3 | 数字人配置接口依赖同步 RAG 预热 | 🟠 中危 | 浏览器打开时服务未就绪，配置请求失败降级为纯文本模式 |
| 4 | appSecret 硬编码回退值与 .env 不一致 | 🟡 低 | 配置接口返回错误值，安全隐患 |

---

## 修复详情

### 修复1: HF 离线模式 — OS 层强制设置

**文件**: `start.bat`

**根因**: uvicorn 进程中 `huggingface_hub` 在 `config.py` 之前就被某模块（如 `sentence_transformers` → `langchain_community`）导入，其在 import 时缓存了 `HF_HUB_OFFLINE=False` 状态。`config.py` 中的 `os.environ.setdefault("HF_HUB_OFFLINE", "1")` 无法改变已缓存的状态。

**修复**: 在 Python 启动前于 OS 层设置环境变量：
```batch
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
set HF_DATASETS_OFFLINE=1
uvicorn src.backend.main:app --host 0.0.0.0 --port 8000 --reload
```

**验证**: 设置后 `sentence_transformers` 加载 BAAI/bge-small-zh-v1.5 完全无网络请求，29.6s 从磁盘加载成功。

---

### 修复2: RAG 知识库路径 Bug

**文件**: `src/LLM/rag/knowledge_base.py`

**根因**: `OceanKnowledgeBase.DEFAULT_KNOWLEDGE_DIR` 使用了 5 个 `.parent`（从 `knowledge_base.py` 向上：rag → LLM → src → 项目根 → 父目录 = 多了一层），导致路径指向 `...\Program\data\knowledge` 而非 `...\issedu_ysu2026_7439\data\knowledge`。

**修复**: 删除有 bug 的类常量，改用 `src.backend.config.settings` 中已正确计算的路径：
```python
# 之前
DEFAULT_KNOWLEDGE_DIR = Path(__file__).parent.parent.parent.parent.parent / "data" / "knowledge"

# 之后
from src.backend.config import settings
self.knowledge_dir = Path(knowledge_dir) if knowledge_dir else settings.KNOWLEDGE_DIR
self.persist_dir = Path(persist_dir) if persist_dir else settings.CHROMA_DIR
```

---

### 修复3: RAG 预热改为后台线程 + 服务秒级启动

**文件**: `src/backend/main.py`

**根因**: 之前 RAG 预热在 `startup` 事件中同步执行（约 15-30s），而 `start.bat` 在服务启动前就 `start http://localhost:8000/assistant` 打开浏览器。浏览器加载页面时服务尚未就绪，`/api/v1/digital-human/config` 请求失败，前端降级为"纯文本模式"。

**修复**: RAG 预热改为后台守护线程，服务秒级启动：
```python
@app.on_event("startup")
async def startup():
    init_chat_service()
    threading.Thread(target=_warmup_rag, daemon=True, name="rag-warmup").start()
```

**降级策略**: 若 RAG 预热失败，日志警告但不阻塞服务，对话请求按需触发 `initialize()`。

---

### 修复4: 数字人配置接口改用 settings

**文件**: `src/backend/main.py`

**根因**: `digital_human_config` 端点使用 `os.environ.get("DH_APP_SECRET", "51f8afff...")` 硬编码回退值，与 `.env` 中的 `3aacdad3...` 不一致，导致配置接口返回错误值。

**修复**: 导入 `settings`，改用 `settings.DH_APP_ID` / `settings.DH_APP_SECRET`，删除所有硬编码。

---

## 字幕优化（UI 微调）

**文件**: `src/frontend/static/js/assistant.js` + `src/frontend/static/css/assistant.css`

**问题**: 数字人字幕只显示第一句（`if (dhIsFirst)` 条件限制），且样式简陋（12px 小字、纯黑背景、60 字符截断加"…"）。

**修改**:
1. 移除 `if (dhIsFirst)` 条件，每句数字人说话都更新字幕
2. 移除 60/80 字符硬截断，完整显示
3. 字幕框样式升级：渐变背景、左侧青色边条、圆角、阴影、淡入动画

---

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `start.bat` | 修改 | 新增 HF 离线环境变量（3 行 set） |
| `src/LLM/rag/knowledge_base.py` | 修复 | 删除 bug 常量，改用 settings |
| `src/backend/main.py` | 修复 | RAG 预热改后台线程 + 配置接口改用 settings + 新增 import |
| `src/frontend/static/js/assistant.js` | 优化 | 字幕逻辑：移除截断、每句更新、淡入动画 |
| `src/frontend/static/css/assistant.css` | 优化 | 字幕样式：渐变背景、边条、阴影、动画 |

---

## 验证结果

| 验证项 | 结果 |
|--------|------|
| 服务启动 | `Application startup complete`（秒级，不阻塞）✅ |
| RAG 知识库加载 | `加载已有向量库: ...\issedu_ysu2026_7439\data\chroma_db`（正确路径）✅ |
| Chat 接口 SSE 流式响应 | 正常返回，RAG 启用 ✅ |
| 数字人配置接口 | `{"appId":"a1fbc741...","appSecret":"3aacdad3..."}`（与 .env 一致）✅ |
| 浏览器数字人面板 | 可见、状态"空闲"、3D 渲染正常 ✅ |
| 字幕显示 | 完整显示每句，样式美观 ✅ |

---

## 清理操作

- 删除 `src/backend/__pycache__/`
- 删除 `src/LLM/rag/__pycache__/`
- 删除 `src/LLM/__pycache__/`
- 删除 `.tmp_chat_test.json`（临时测试文件）
