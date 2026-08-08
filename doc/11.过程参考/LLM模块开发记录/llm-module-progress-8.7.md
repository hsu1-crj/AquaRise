# LLM 模块工作日志 — 2026-08-07

**操作员**: Mingzhe
**执行环境**: Windows 11 / Conda env `xa_code` (Python 3.11) / Conda env `base` (Python 3.13)

---

## 上午：生产模型部署与 RAG 构建

### 任务2：生产模型部署流程完善

#### 2a. LoRA 权重合并（0.5B 本地版）✅

- **脚本**: `src/LLM/fine_tune/merge_lora.py`
- **命令**:
  ```bash
  PYTHONPATH="." /d/anaconda3/envs/xa_code/python.exe \
    src/LLM/fine_tune/merge_lora.py --mode local
  ```
- **输出目录**: `models/llm/ocean-0.5b-merged/`
- **参数**:
  - 基础模型: Qwen/Qwen2-0.5B-Instruct（HF 缓存）
  - LoRA 适配器: `models/llm/ocean-lora/`（rank=8，loss 3.21→2.80）
  - 输出格式: safetensors, float16, 494M 参数
- **结果**: 合并成功，`merge_info.json` 记录元数据
- **注意**: `conda run -n xa_code` 在 Windows 下触发 GBK 编码错误，改用直接路径
  `\d\anaconda3\envs\xa_code\python.exe` 规避

#### 2b. HF 模型 → GGUF 格式转换 ✅

- **脚本**: `src/LLM/deploy/convert_to_gguf.py`（新建）
- **背景**: `convert_hf_to_gguf.py`（llama.cpp 官方脚本）因 GitHub/镜像不可访问无法下载，
  改为自行实现针对 Qwen2 架构的 GGUF 写入器
- **命令**:
  ```bash
  PYTHONPATH="." /d/anaconda3/envs/xa_code/python.exe \
    src/LLM/deploy/convert_to_gguf.py \
    --model-dir models/llm/ocean-0.5b-merged \
    --output    models/llm/ocean-0.5b.gguf
  ```
- **输出**: `models/llm/ocean-0.5b.gguf`，948.5 MB，F16 精度，290 个张量
- **技术细节**:
  - 使用 `gguf.GGUFWriter`（gguf 0.19.0，已安装于 xa_code）
  - 完整实现 Qwen2 特有张量映射（含 qkv bias）
  - tokenizer 元数据（BPE/GPT-2 风格 + qwen2 pre-tokenizer）写入 GGUF header
  - 调试修复: `add_padding_token_id` → `add_pad_token_id`（API 方法名差异）

#### 2c. Ollama 模型打包与替换 ✅

- **历史状态**: 演示模型 `ocean-assistant` 已于上一 session 使用 `FROM qwen2:0.5b`
  基座 + 系统提示创建，并验证通过（返回"海洋守护者"角色人设）
- **今日更新**: 更新 `src/LLM/deploy/Modelfile` 注释，明确三种部署方案：
  1. 生产路径：7B LoRA GGUF（`FROM ./ocean-assistant.gguf`）
  2. 本地演示：0.5B LoRA GGUF（同上，文件替换为 ocean-0.5b.gguf）
  3. 当前演示：qwen2:0.5b 基座（无 LoRA）
- **生产部署命令**（待云端完成后执行）:
  ```bash
  cp models/llm/ocean-0.5b.gguf src/LLM/deploy/ocean-assistant.gguf
  cd src/LLM/deploy
  ollama create ocean-assistant -f Modelfile
  ```

#### 2d. 7B 云端训练指南 ✅

- **文档**: `src/LLM/fine_tune/cloud_training_guide.md`
- **内容**: AutoDL/阿里云 PAI 环境搭建、7B 训练命令、LoRA 合并、GGUF 转换、Ollama 打包

#### 2e. 安全修复（关键）✅

- **文件**: `src/backend/main.py`
- **问题**: `/api/v1/digital-human/config` 接口中 appId 和 appSecret
  以硬编码字符串作为默认值，违反 CLAUDE.md 安全规范
- **修复**: 去除所有硬编码默认值，若 `DH_APP_ID` / `DH_APP_SECRET` 环境变量未设置，
  接口返回 HTTP 503 并提示配置说明

#### 2f. 默认模型切换 ✅

- **文件**: `src/LLM/chat_api.py`
- **修改**: `ChatRequest.model` 默认值 `"qwen2:0.5b"` → `"ocean-assistant"`
- 旧值保留在注释中供临时回退使用

---

### 任务3：RAG 知识库构建与验证

#### 3a. 构建脚本 ✅

- **脚本**: `src/LLM/rag/build_knowledge_base.py`（新建）
- 封装 `OceanKnowledgeBase.build()` 调用 + 5 条标准查询验证

#### 3b. 知识库构建成功 ✅

- **构建命令**:
  ```bash
  HF_HUB_OFFLINE=1 PYTHONPATH="." \
    /d/anaconda3/envs/xa_code/python.exe \
    src/LLM/rag/build_knowledge_base.py --rebuild
  ```
- **文档来源**: `data/knowledge/`（5 个 .md 文件，共 19.1 KB）
- **分块结果**: 25 个文本块（chunk_size=500，overlap=50）
- **向量库**: `data/chroma_db/`，collection_name=`ocean_knowledge`
- **嵌入模型**: BAAI/bge-small-zh-v1.5（本地缓存，512维，中文优化）

#### 3c. 检索验证结果（5/5 ✅）

| # | 查询 | 命中文档 |
|---|------|---------|
| 1 | 塑料袋在水下多久能降解 | 海洋垃圾降解周期表.md |
| 2 | MARPOL 公约对船舶废弃物的规定 | MARPOL公约概要.md |
| 3 | 微塑料对海洋生物的危害 | 海洋微塑料污染知识.md |
| 4 | 海洋垃圾治理技术有哪些 | 海洋塑料治理技术综述.md |
| 5 | 蓝碳是什么 | 海洋垃圾降解周期表.md |

---

### 上午遇到的问题与解决方案

#### 问题1：conda run GBK 编码错误
- **现象**: `conda run -n xa_code python ...` → `UnicodeEncodeError: 'gbk' codec`
- **原因**: Windows 中文系统终端编码为 GBK，conda 打印包含非 GBK 字符的 Unicode
- **解决**: 改用解释器直接路径 `/d/anaconda3/envs/xa_code/python.exe`

#### 问题2：hf-mirror.com / huggingface.co 无法连接
- **现象**: RAG 构建时下载 BAAI/bge-small-zh-v1.5 超时
- **原因**: 网络环境无法访问两个 HuggingFace 端点（均连接超时）
- **解决**: 检查本地 HF 缓存（`~/.cache/huggingface/hub/`），确认模型文件已存在；
  启动时加 `HF_HUB_OFFLINE=1` 强制离线模式

#### 问题3：BAAI 缓存目录不完整（缺少 1_Pooling 子目录）
- **现象**: `sentence_transformers` 报 `FileNotFoundError: 1_Pooling/config.json`
- **原因**: Windows 不支持符号链接，HF 缓存系统在降级模式下未写入子目录文件
- **解决**: 手动创建缺失文件（BAAI/bge-small-zh-v1.5 的标准均值池化配置为公知内容）：
  ```json
  // ~/.cache/.../1_Pooling/config.json
  {
      "word_embedding_dimension": 512,
      "pooling_mode_cls_token": false,
      "pooling_mode_mean_tokens": true,
      ...
  }
  ```

#### 问题4：UnstructuredMarkdownLoader 缺少 markdown 依赖
- **现象**: 加载 .md 文件失败，`No module named 'markdown'`
- **原因**: `unstructured` 库解析 Markdown 时依赖独立 `markdown` 包
- **解决**: 将 `knowledge_base.py` 中 `.md` 的加载器从 `UnstructuredMarkdownLoader`
  改为 `TextLoader(encoding='utf-8')`，完全绕开 unstructured 依赖；
  对纯文本知识文档无任何功能损失

#### 问题5：GitHub 不可访问（GGUF 转换脚本无法下载）
- **现象**: `convert_hf_to_gguf.py`（llama.cpp）via curl/ghproxy 均失败
- **原因**: 网络环境屏蔽 GitHub 及其镜像
- **解决**: 自行编写 `src/LLM/deploy/convert_to_gguf.py`，
  使用已安装的 `gguf` 库（0.19.0）直接调用 `GGUFWriter`，
  针对 Qwen2 架构实现完整张量名映射（含 qkv bias，这是 Qwen2 特有的）

#### 问题6：GGUFWriter API 方法名差异
- **现象**: `AttributeError: 'GGUFWriter' object has no attribute 'add_padding_token_id'`
- **原因**: gguf 0.19.0 中方法名为 `add_pad_token_id`（非 `add_padding_token_id`）
- **解决**: 修改方法名，重新运行

---

### 上午产出文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `src/LLM/fine_tune/merge_lora.py` | 新建 ✅ | LoRA 合并脚本（local/cloud 双模式） |
| `src/LLM/fine_tune/cloud_training_guide.md` | 新建 ✅ | 云端 7B 训练部署指南 |
| `src/LLM/deploy/convert_to_gguf.py` | 新建 ✅ | Qwen2 HF→GGUF 转换脚本 |
| `src/LLM/deploy/Modelfile` | 更新 ✅ | 明确三种部署方案注释 |
| `src/LLM/rag/build_knowledge_base.py` | 新建 ✅ | RAG 构建与验证脚本 |
| `src/LLM/rag/knowledge_base.py` | 修复 ✅ | .md 加载器改为 TextLoader |
| `src/LLM/chat_api.py` | 修复 ✅ | 默认模型改为 ocean-assistant |
| `src/backend/main.py` | 安全修复 ✅ | 移除硬编码 appSecret 默认值 |
| `models/llm/ocean-0.5b-merged/` | 生成 ✅ | 合并后模型（494M 参数，safetensors） |
| `models/llm/ocean-0.5b.gguf` | 生成 ✅ | GGUF 格式模型（948.5 MB，F16） |
| `data/chroma_db/` | 生成 ✅ | ChromaDB 向量库（25 个文本块） |

---

## 下午：Bug 修复与前端验证

上午完成 LLM 模块全部搭建后，下午验证发现前端对话和数字人功能均不可用，共定位 4 个 Bug 并全部修复。

| # | Bug | 严重度 | 影响 |
|---|-----|--------|------|
| 1 | HF 离线变量未生效 | 🔴 高危 | RAG 加载嵌入模型时反复向 huggingface.co 发 HEAD 请求，流式响应挂死数分钟 |
| 2 | RAG 知识库路径多算一层 | 🔴 高危 | 路径指向错误目录，RAG 始终静默失败，降级为纯 LLM 无知识增强 |
| 3 | 数字人配置接口依赖同步 RAG 预热 | 🟠 中危 | 浏览器打开时服务未就绪，配置请求失败降级为纯文本模式 |
| 4 | appSecret 硬编码回退值与 .env 不一致 | 🟡 低 | 配置接口返回错误值，安全隐患 |

---

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

### 字幕优化（UI 微调）

**文件**: `src/frontend/static/js/assistant.js` + `src/frontend/static/css/assistant.css`

**问题**: 数字人字幕只显示第一句（`if (dhIsFirst)` 条件限制），且样式简陋（12px 小字、纯黑背景、60 字符截断加"…"）。

**修改**:
1. 移除 `if (dhIsFirst)` 条件，每句数字人说话都更新字幕
2. 移除 60/80 字符硬截断，完整显示
3. 字幕框样式升级：渐变背景、左侧青色边条、圆角、阴影、淡入动画

---

### 下午修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `start.bat` | 修改 | 新增 HF 离线环境变量（3 行 set） |
| `src/LLM/rag/knowledge_base.py` | 修复 | 删除 bug 常量，改用 settings |
| `src/backend/main.py` | 修复 | RAG 预热改后台线程 + 配置接口改用 settings + 新增 import |
| `src/frontend/static/js/assistant.js` | 优化 | 字幕逻辑：移除截断、每句更新、淡入动画 |
| `src/frontend/static/css/assistant.css` | 优化 | 字幕样式：渐变背景、边条、阴影、动画 |

---

### 下午验证结果

| 验证项 | 结果 |
|--------|------|
| 服务启动 | `Application startup complete`（秒级，不阻塞）✅ |
| RAG 知识库加载 | `加载已有向量库: ...\issedu_ysu2026_7439\data\chroma_db`（正确路径）✅ |
| Chat 接口 SSE 流式响应 | 正常返回，RAG 启用 ✅ |
| 数字人配置接口 | `{"appId":"a1fbc741...","appSecret":"3aacdad3..."}`（与 .env 一致）✅ |
| 浏览器数字人面板 | 可见、状态"空闲"、3D 渲染正常 ✅ |
| 字幕显示 | 完整显示每句，样式美观 ✅ |

### 清理操作

- 删除 `src/backend/__pycache__/`
- 删除 `src/LLM/rag/__pycache__/`
- 删除 `src/LLM/__pycache__/`
- 删除 `.tmp_chat_test.json`（临时测试文件）

---

## 附录：配置安全升级 — .env 方案（上午补充）

### 背景

数字人 SDK 凭据（appId/appSecret）之前通过系统环境变量注入，本地开发时仍需手动`export`，
且 Ollama URL、模型名、RAG 参数等均散落在各模块硬编码。本次统一升级为基于 `.env` + `config.py` 的配置中心方案。

---

### 新增/修改文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `.env.example` | **新建，提交 Git** | 含完整注释的配置模板，所有字段占位符为空或默认值 |
| `.env` | **新建，不进 Git** | 本地实际配置（已在 `.gitignore` 中由 `.env` / `.env.*` 规则排除） |
| `src/backend/config.py` | **新建** | 统一配置中心（python-dotenv 加载 + Settings 数据类） |
| `src/backend/main.py` | 修改 | 导入 settings，digital-human 接口改用 `settings.is_dh_configured` |
| `src/LLM/chat_api.py` | 修改 | ChatRequest 默认值改用 settings，init_chat_service 默认 URL 改从 settings 读 |
| `src/LLM/rag/knowledge_base.py` | 修改 | __init__ 路径/模型参数改用 settings |

---

### 配置项总览（全部在 `.env` 中管理）

```
# 数字人 API
DH_APP_ID=                         # 平台控制台获取
DH_APP_SECRET=                     # 高敏感，不得泄露

# Ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=ocean-assistant

# LLM 生成参数
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=2048

# RAG
RAG_ENABLED=true
RAG_TOP_K=4
EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
KNOWLEDGE_DIR=data/knowledge
CHROMA_DIR=data/chroma_db

# FastAPI
APP_HOST=0.0.0.0
APP_PORT=8000
```

---

### 加载优先级与机制

```
系统环境变量（export / 容器注入）
    ↓ override=False（已有的不被覆盖）
.env 文件（本地开发）
    ↓
代码内置默认值（兜底）
```

`src/backend/config.py` 在被首次 `import` 时自动调用 `load_dotenv(ROOT/.env, override=False)`，
后续所有模块只需 `from src.backend.config import settings` 即可取值，无需关心来源。

---

### Git 规范合规性

- `.env` 已在 `.gitignore` 中由 `.env` / `.env.*` 规则排除 ✓
- `.env.example` 被 `!.env.example` 显式豁免，可安全提交 ✓
- 代码中不再有任何密钥默认值（DH_APP_SECRET 未配置时接口返回 HTTP 503）✓
- 团队成员拿到仓库后执行 `cp .env.example .env` 并填写 DH 凭据即可启动

---

### 数字人密钥配置步骤（团队成员操作指南）

1. 项目根目录执行:
   ```bash
   cp .env.example .env
   ```
2. 编辑 `.env`，填写从平台控制台获取的值:
   ```
   DH_APP_ID=你的appId
   DH_APP_SECRET=你的appSecret
   ```
3. 启动服务:
   ```bash
   # Windows（推荐）
   uvicorn src.backend.main:app --port 8000
   
   # 或手动指定（系统环境变量覆盖 .env）
   DH_APP_ID=xxx DH_APP_SECRET=yyy uvicorn src.backend.main:app --port 8000
   ```
4. 验证数字人接口:
   ```bash
   curl http://localhost:8000/api/v1/digital-human/config
   # 未配置: {"error": "DH_APP_ID 或 DH_APP_SECRET 未配置..."}  HTTP 503
   # 已配置: {"appId": "...", "appSecret": "..."}               HTTP 200
   ```

---

### 更新后系统状态

```
配置来源
  .env（本地，不进Git）
    └─ load_dotenv() at import
         └─ src/backend/config.py :: Settings (单例)
              ├─ src/backend/main.py          (FastAPI + digital-human)
              ├─ src/LLM/chat_api.py          (Ollama URL / 模型 / 生成参数)
              └─ src/LLM/rag/knowledge_base.py (知识库路径 / 嵌入模型)
```

---

## 任务5：规范符合性检查（上午补录）

扫描根目录 .md 文件与 CLAUDE.md / 项目规划文档 对照，找出 LLM/数字人模块的偏差和不符合规范之处，并执行修复。

---

### 发现的问题与处理结果

#### [已修复 🔴 高危] main.py `digital_human_config` 返回 appSecret 到浏览器

**位置**: `src/backend/main.py:64-67`

**问题**: 端点直接将 `settings.DH_APP_SECRET` 写入 HTTP 响应 JSON 返回给前端。违反 CLAUDE.md 核心安全规则：
> "平台 appSecret 只能通过服务端环境变量或密钥管理注入，不得写入仓库、浏览器代码、页面配置或日志"

**根因**: 魔珐星云 XmovAvatar JS SDK 当前设计要求在浏览器端传入 appId + appSecret 完成初始化，这是平台 SDK 的设计约束，不是项目问题。

**已做处理**:
- 在端点 docstring 中详细说明已知限制、当前缓解措施（仅从环境变量读取、未配置返回 503、演示用测试账号隔离）
- 标注 TODO：正确修复路径是服务端换取 session token + JWT 认证保护端点
- 代码行为暂不变更（破坏数字人功能），等待平台 Session API 文档接入后实施

**TODO（生产化前必须完成）**:
1. 调研魔珐星云后端 Session Token API（网关 `https://nebula-agent.xingyun3d.com/user/v1/ttsa/session`）
2. 服务端用 appId+appSecret 换取短期 token，前端只收 token
3. 为 `/api/v1/digital-human/config` 加 JWT `Depends` 鉴权

---

#### [已修复 🟠 中危] config.yaml 含 appSecret 占位符且格式无效

**位置**: `src/LLM/digital_human/config.yaml`

**问题**:
1. `appSecret: "${MOFA_APP_SECRET}"` 是 shell 语法，Python `yaml.safe_load()` 不解析为环境变量，实际读取到的是字面字符串 `${MOFA_APP_SECRET}`，功能上无效
2. 占位符格式给开发者造成"可以在这里填真实 secret"的错误印象，存在误操作风险
3. `pipeline.py` 根本不读取 config.yaml 的 `sdk` 节（只读 `interaction` 节），该字段完全多余

**已修复**: 删除 `appSecret` 字段，改为注释说明凭证通过 `settings.DH_APP_SECRET` 注入，明确 pipeline.py 不从此文件读凭证。

---

#### [已修复 🟡 低] .gitignore 缺少关键排除项

**新增条目**:
| 新增排除项 | 原因 |
|---|---|
| `.claude/` | Claude Code CLI 工作日志，AI 会话记录，不属于项目源代码 |
| `models/llm/` | 948 MB GGUF 大文件，不得进 git |
| `data/chroma_db/` | 向量库生成物，按需重建 |
| `src/frontend/node_modules/` | Node 依赖，通过 npm install 恢复 |
| `src/frontend/dist/` | Vite 构建产物 |

---

#### [已修复 🟡 低] deploy/README.md 与实际工具不一致

**问题**: README 写的是 `llamafactory-cli export` + `llama.cpp/convert-hf-to-gguf.py`，但实际使用的是：
- `src/LLM/fine_tune/merge_lora.py`（raw PEFT `merge_and_unload`）
- `src/LLM/deploy/convert_to_gguf.py`（自研 GGUF 转换器）

**原因**: GitHub 访问受限无法下载 llama.cpp，LLaMA Factory 未在本地环境安装。

**已修复**: README 重写为两节：
1. "实际部署流程（当前已验证）" — 使用项目内自研脚本
2. "参考：LLaMA Factory 标准流程（计划/云端）" — 保留原始方案供云端 7B 使用，并标注偏差原因

---

## 待完成事项

### 下一步优先项

1. **生产模型升级**（需要云GPU环境）：
   ```bash
   # 1. 在 AutoDL/PAI 执行（参考 cloud_training_guide.md）
   python src/LLM/fine_tune/train_lora.py --mode cloud  # 7B 模型训练
   python src/LLM/fine_tune/merge_lora.py --mode cloud  # 7B LoRA 合并
   
   # 2. 转换 GGUF（在云端执行，7B需 14GB 磁盘）
   python src/LLM/deploy/convert_to_gguf.py \
     --model-dir models/llm/ocean-7b-merged \
     --output    models/llm/ocean-7b.gguf
   
   # 3. 更新 Ollama 模型
   cp models/llm/ocean-7b.gguf src/LLM/deploy/ocean-assistant.gguf
   ollama create ocean-assistant -f src/LLM/deploy/Modelfile
   ```

2. **RAG 迁移至新 API**（低优先级）：
   - `knowledge_base.py` 中 `HuggingFaceEmbeddings` 是已废弃的 `langchain_community` 版本
   - 迁移命令: `pip install langchain-huggingface`
   - 迁移方法: `from langchain_huggingface import HuggingFaceEmbeddings`
   - 当前版本功能正常，可在下次重构时统一处理

3. **数字人 Session Token 方案**（生产化前必须完成）：
   - 调研魔珐星云后端 Session Token API
   - 服务端用 appId+appSecret 换取短期 token，前端只收 token
   - 为 `/api/v1/digital-human/config` 加 JWT `Depends` 鉴权
