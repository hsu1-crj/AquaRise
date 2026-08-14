# LLM 与数字人模块进度报告

> 更新日期: 2026-08-14
> 项目: 水下垃圾自动识别与海洋污染分析系统（第8组）
> 本报告汇总 LLM 对话、RAG、微调、部署与数字人交互模块的当前完成状态、遗留问题和下一步计划。

---

## 一、模块总览

| 子模块 | 状态 | 说明 |
|---|---|---|
| 在线对话链路 | ✅ 运行中 | FastAPI → Ollama（deepseek-r1:1.5b）+ RAG + 质量门禁 |
| RAG 知识库 | ✅ 27 篇 | 覆盖 22 类识别、检测、法规、生态、治理等全领域 |
| 训练数据集 | ✅ 24719+ 条 | 原始 701 + 扩充 v1 10216 + 扩充 v2 14503 |
| LoRA 微调 | ⚠️ 流程跑通 | PAI 训练链路已验证，**微调模型产物未正确就位** |
| Ollama 部署 | ⚠️ 流程跑通 | HF→GGUF→Ollama 导入已验证，**当前导入的是 base 模型** |
| 数字人 | ✅ 代码完整 | SDK 封装、状态机、流式字幕、思考动画 |

---

## 二、LLM 模块

### 2.1 在线对话链路（已完成 ✅）

```
用户问题 → 前端 Assistant.tsx → POST /api/v1/chat (SSE)
→ chat_router.py
→ ① 确定性规则 direct_response（身份/寒暄/越界题/渔网/微塑料/MARPOL/低置信度/清理方案）
→ ② RAG 注入证据 → Ollama 模型生成
→ ③ 质量门禁 is_acceptable_model_answer（拦截复述/think泄漏/无依据套话）
→ 不合格 → 知识库证据兜底 _knowledge_fallback
→ 前端短句流式输出 + 数字人字幕/播报
```

- 模型：`deepseek-r1:1.5b`（Ollama，`.env` 中 `OLLAMA_MODEL` 配置）
- RAG 双通道：ChromaDB 向量优先，依赖缺失自动降级本地中文词法检索（无需网络）
- `<think>` 过滤：`_ThinkFilter` 跨 chunk 过滤 DeepSeek R1 推理标签
- 三层防护保证 1.5B 小模型不乱说

### 2.2 RAG 知识库（27 篇 ✅）

`data/knowledge/` 文档清单（口径：保守准确、区分"检出/潜在风险/已证实"、不写伪精确数字）：

**基础篇（9 篇）**：垃圾分类与特征、降解周期表、微塑料污染、MARPOL 公约概要、塑料治理技术综述、来源与输运路径、幽灵渔网专项、污染类型与生态影响、监测与清理评估方法

**扩充篇（v1，11 篇）**：YOLO 目标检测要点、塑料材质与回收、海洋生物与生态、ROV 作业、水质监测、渔业与垃圾、环保法律法规、深海环境、循环经济、检测报告解读、误区事实核查

**扩充篇（v2，7 篇）**：海洋碳汇与气候变化、船舶防污染与港口管理、海洋垃圾与人类健康、城市径流源头拦截、污染事件应急、水下图像采集与标注、海滩垃圾与公众参与

### 2.3 训练数据集（24719+ 条 ✅）

| 文件 | 条数 | 说明 |
|---|---|---|
| ocean_trash_qa.json | 367 | 原始语料 |
| ocean_knowledge_qa.json | 128 | 原始语料 |
| ocean_trash_recognition_qa.json | 176 | 原始语料 |
| ocean_trash_multi_turn.json | 30 | 多轮（alpaca+history 注册） |
| ocean_expanded_qa.json | 10216 | v1 生成（12 问法 × 子句 + 场景 + 对比 + 否定 + 22类检测模板） |
| ocean_expanded_v2_qa.json | 14503 | v2 生成（16 全新问法，与 v1 问题 0 重叠） |

质量保障：答案逐字摘录自 27 篇知识文档（校验 0 编造）、问题去重、Alpaca 格式合规。
生成器：`src/LLM/fine_tune/expand_dataset.py`（支持 `--v2`、`--output`、`--exclude`）。

### 2.4 LoRA 微调（⚠️ 流程已验证，产物未就位）

**已完成**：
- PAI（阿里云 DSW）环境：LLaMA Factory WebUI 部署、数据上传（6 文件）、`dataset_info.json` 注册（alpaca 映射 + multi_turn 修正为 history 格式）
- 基座模型：`deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B`（ModelScope 下载）
- 训练参数：LoRA rank 8 / alpha 16 / lr 3e-5 / epochs 2-3 / cutoff 640 / batch 2 / grad accum 8 / 模板 qwen / 调度器 cosine
- 曾踩坑：multi_turn 误注册 sharegpt → `KeyError: None`；`cosine_warmup_with_min_lr` 缺 `min_lr_rate` → ValueError

**未完成**：
- ❌ 从 PAI 下载的 `model.safetensors`（3.4GB）经实测为 **base 模型**（自称 DeepSeek、MARPOL 答错、think 泄漏），微调权重未正确合并/导出/下载
- 本地训练实验（8/12-13）：v7 候选 0/24 合同被拒、v8 15/24 未达门槛，已清理；本地工作区已删除

**待办**：确认 PAI 训练完成 → Export 勾选"合并 LoRA" → 下载 merged 模型 → 重新转换部署

### 2.5 Ollama 部署（⚠️ 流程已验证）

已验证链路：HF 目录（safetensors+config+tokenizer）→ `convert_hf_to_gguf.py`（q8_0，1.9GB）→ Modelfile（qwen 模板 + 海洋守护者 SYSTEM）→ `ollama create ds-ocean_mingzhe`

- ✅ Ollama 0.32.6 支持直接导入 HF 目录（自动转换），亦可走 llama.cpp 标准转换
- ✅ tokenizer 正常、无 think 泄漏（qwen 模板）
- ⚠️ 当前 Ollama 中模型已清理，待真正微调模型就位后重新导入
- 回滚基线：`deepseek-r1:1.5b` 保留

---

## 三、数字人模块（魔珐星云 XmovAvatar）

### 3.1 前端集成（代码完整 ✅）

- `src/frontend/src/services/digitalHuman.ts`：SDK 动态加载 + `OceanDigitalHuman` 类（init/speak 队列/think/idle/setVolume/destroy + ready/speakStart/speakEnd/error/progress 事件）
- `src/frontend/src/pages/Assistant.tsx`：海洋守护者页（左数字人舞台 + 右聊天面板）
  - 状态机：`offline → loading → idle → thinking → speaking`
  - 加载分阶段文案：加载引擎 → 连接服务 → 就绪
  - 思考覆盖层动画（旋转光环 + Brain 图标 + 呼吸点）
  - 回答完整生成后整段字幕 + 播报（避免半句抖动/抢跑）
  - MutationObserver + 定时扫描隐藏 SDK 内置字幕
  - AbortController 中断、DOMPurify + marked 安全渲染
- 文案统一"海洋守护者"

### 3.2 后端接口（存根 ⚠️）

- `src/backend/routers/digital_human_router.py`：`GET /api/v1/digital-human/config`（JWT 保护），仅返回占位配置（enabled/avatar_id/voice_id/stub-token），不返回 appSecret
- 实际凭据路径：前端直接读 `VITE_DH_APP_ID/SECRET`

### 3.3 配置与安全（⚠️）

- 根目录 `.env` 与 `src/frontend/.env` 当前**均不存在** → 数字人实际运行在纯文本模式
- `src/LLM/digital_human/config.yaml` 仍含硬编码 appId + `${MOFA_APP_SECRET}` 占位符（需清理）
- 已知风险：魔珐星云 SDK 要求浏览器端持有 appSecret；生产化需服务端换取短期 Session Token（未实施）

---

## 四、当前状态汇总

| 事项 | 状态 |
|---|---|
| 在线聊天（规则+RAG+1.5B 原版） | ✅ 运行 |
| 知识库 27 篇 / 训练数据 24719+ 条 | ✅ 完成 |
| PAI 微调链路（数据/注册/参数/踩坑） | ✅ 跑通 |
| 微调模型产物（合并 LoRA） | ❌ 未就位（下载的是 base） |
| Ollama 部署链路（HF→GGUF→create） | ✅ 跑通，待换模型 |
| 数字人前端代码 | ✅ 完成 |
| 数字人 .env 凭据 | ❌ 未配置 |
| services/llm.py 身份文案（燕山大学/海瞳 LLM 组新口径） | ❌ 待更新 |
| git 提交（LLM 升级 + 扩充产物） | ❌ 待提交 |

---

## 五、下一步计划（按优先级）

1. **PAI 侧**：确认训练完成 → Export 合并 LoRA → 下载 merged 模型（验证身份题/MARPOL 题回答正确后再下载）
2. **部署**：新模型 → convert → Modelfile → `ollama create ds-ocean_mingzhe` → 切 `.env` → 重启后端 → 全链路验证（7 探针：身份/家庭/渔网/MARPOL/微塑料/越界/置信度）
3. **代码**：更新 `services/llm.py` 身份文案（燕山大学实训项目/海瞳 LLM 组 LLM 模块负责人）
4. **数字人**：创建 `.env`（DH_APP_ID/SECRET）→ 验证 3D 加载与播报
5. **安全**：清理 config.yaml 硬编码；评估 Session Token 方案
6. **git**：提交本轮全部改动

---

## 六、关键文件清单

| 文件 | 说明 |
|---|---|
| src/backend/services/llm.py | 确定性规则 + 质量门禁 + 兜底 |
| src/LLM/chat_api.py | Ollama 客户端 + RAG 双通道 + think 过滤 |
| src/LLM/rag/lexical_retriever.py | 本地词法检索 |
| src/backend/routers/chat_router.py | SSE 对话路由 |
| src/backend/routers/digital_human_router.py | 数字人配置存根 |
| src/frontend/src/services/digitalHuman.ts | 数字人 SDK 封装 |
| src/frontend/src/pages/Assistant.tsx | 海洋守护者页 |
| src/LLM/fine_tune/expand_dataset.py | 数据集生成器（v1/v2） |
| src/LLM/fine_tune/data/ | 训练数据（24719+ 条） |
| data/knowledge/ | RAG 知识库（27 篇） |
| src/LLM/deploy/ | Modelfile / GGUF 转换说明 |
| doc/11.过程参考/LLM模块开发记录/ | 开发日志（8.5~8.13） |

---

## 七、风险与备注

1. 1.5B 小模型固有幻觉风险 → 由三层防护（规则/RAG/门禁）兜底，微调只能降低不能消除
2. PAI 实例多次重建（数据需重传），建议训练完成后一次性下载全部产物
3. 数字人 appSecret 浏览器暴露为平台 SDK 设计约束，生产化前需 Session Token 方案
