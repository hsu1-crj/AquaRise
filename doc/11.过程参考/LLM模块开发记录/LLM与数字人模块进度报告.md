# LLM 与数字人模块进度报告

> 更新日期: 2026-08-14（晚间，覆盖 8/14 早间版本）
> 项目: 水下垃圾自动识别与海洋污染分析系统（第8组）
> 本报告汇总 LLM 对话、RAG、微调、部署与数字人交互模块的当前完成状态、遗留问题和下一步计划。

---

## 一、模块总览

| 子模块 | 状态 | 说明 |
|---|---|---|
| 在线对话链路 | ✅ 运行中 | FastAPI → Ollama（**ds-ocean_mingzhe**）+ RAG + 规则门禁 |
| RAG 知识库 | ✅ 27 篇 | 覆盖 22 类识别、检测、法规、生态、治理等全领域 |
| 训练数据集 | ✅ 24719+ 条 | 原始 701 + 扩充 v1 10216 + 扩充 v2 14503 + 身份/边界强化 280 |
| LoRA 微调 | ✅ 边界强化版已部署 | PAI 2.4 万条链路已验证（产物未用）；本地身份/边界强化 423 条×8 轮已合并部署 |
| Ollama 部署 | ✅ 上线 | `ds-ocean_mingzhe`（q8_0 1.9GB）为线上默认，`deepseek-r1:1.5b` 回滚基线 |
| 数字人（前端） | ✅ 代码完整 | SDK 封装、状态机、流式字幕（逐句+单行）、快捷问题 |
| 数字人（后端/配置） | ✅ 前端配置就绪 | 后端占位接口（前端未调用）；`src/frontend/.env` 已配置 VITE_DH_* → 3D 可加载 |

---

## 二、LLM 模块

### 2.1 在线对话链路（已完成 ✅）

```
用户问题 → 前端 Assistant.tsx → POST /api/v1/chat (SSE)
→ chat_router.py
→ ① 确定性规则 direct_response（海瞳身份/寒暄/越界题/渔网/微塑料/MARPOL/低置信度/清理方案）
→ ② RAG 注入证据 → Ollama 生成（ds-ocean_mingzhe）
→ ③ 质量门禁 is_acceptable_model_answer（拦截复述/think泄漏/无依据套话）
→ 不合格 → 知识库证据兜底 _knowledge_fallback
→ 前端短句流式输出 + 数字人字幕/播报
```

- 模型：`ds-ocean_mingzhe`（`.env` 中 `OLLAMA_MODEL` 配置，`chat_api.py` 默认值同步更新）
- **身份口径（8/14 更新）**：海瞳平台 / 海瞳项目开发组 / 海瞳 LLM 组（LLM 模块负责人）；"你是谁/哪个平台/哪家公司/来自哪里"等 → `PLATFORM_IDENTITY`
- RAG 双通道：ChromaDB 向量优先，依赖缺失自动降级本地中文词法检索（无需网络）
- `<think>` 过滤 + 三层防护保证 1.5B 小模型不乱说

### 2.2 RAG 知识库（27 篇 ✅）

`data/knowledge/`（口径：保守准确、区分"检出/潜在风险/已证实"、不写伪精确数字）：

**基础篇（5 篇）**：垃圾分类与特征、降解周期表、微塑料污染、MARPOL 公约概要、塑料治理技术综述
**扩充篇 v1（15 篇）**：来源与输运路径、幽灵渔网专项、污染类型与生态影响、监测与清理评估、YOLO 检测要点、塑料材质与回收、生物与生态、ROV 作业、水质监测、渔业与垃圾、环保法律法规、深海环境、循环经济、报告解读、误区事实核查
**扩充篇 v2（7 篇）**：碳汇与气候变化、船舶防污染与港口、人类健康、城市径流拦截、污染事件应急、水下图像采集与标注、海滩垃圾与公众参与

### 2.3 训练数据集（24719+ 条 ✅）

| 文件 | 条数 | 说明 |
|---|---|---|
| ocean_trash_qa.json | 367 | 原始语料 |
| ocean_knowledge_qa.json | 128 | 原始语料 |
| ocean_trash_recognition_qa.json | 176 | 原始语料 |
| ocean_trash_multi_turn.json | 30 | 多轮（alpaca+history 注册） |
| ocean_expanded_qa.json | 10216 | v1 生成（12 问法×子句+场景+对比+否定+22类检测模板） |
| ocean_expanded_v2_qa.json | 14503 | v2 生成（16 全新问法，与 v1 问题 0 重叠） |
| train_enhanced.json | 74 | 身份/探针强化（海瞳口径第一版） |
| train_enhanced2.json | 206 | 身份/开发/家庭/礼貌/越界 206 问法 |
| train_enhanced3.json | 62 | "你是谁/你是哪家"密集变体 |

质量保障：答案逐字摘录知识库（0 编造）、问题去重、Alpaca 格式合规。生成器 `expand_dataset.py`（--v2/--output/--exclude）。

### 2.4 LoRA 微调（✅ 边界强化版已部署）

**PAI 平台链路（已验证，产物弃用）**：
- 2.4 万条数据上传/注册/训练全流程跑通（踩坑：multi_turn 注册格式 KeyError、cosine_warmup_with_min_lr 缺 min_lr_rate）
- 下载的 merged 模型实测为 **base 行为**（自称 DeepSeek、MARPOL 答错）→ 微调权重未正确导出，未采用

**本地边界强化训练（8/14 下午，已部署）**：
- 数据：423 条（train_enhanced/2/3 + 多轮 81）× 8 轮，LoRA rank 8/alpha 16，lr 3e-5，~10 分钟
- 产出：`models/llm/ds-ocean_mingzhe-full-lora/` → 合并 → GGUF(q8_0) → Ollama
- 验收：名字/自我介绍/礼貌题 → 海瞳口径 ✅；"你是谁"仍被 base 强先验压制（规则层兜底）；知识题未训（规则+RAG 兜底）

### 2.5 Ollama 部署（✅ 上线）

- `ds-ocean_mingzhe:latest`（1.9GB q8_0，qwen 模板 + 海瞳 SYSTEM）已导入
- 转换链路：HF→GGUF（llama.cpp convert_hf_to_gguf.py）→ ollama create
- 回滚基线 `deepseek-r1:1.5b` 保留
- `deploy/Modelfile` 已同步为 ds-ocean_mingzhe + 海瞳口径

---

## 三、数字人模块（魔珐星云 XmovAvatar）

### 3.1 前端集成（代码完整 ✅）

- `src/frontend/src/services/digitalHuman.ts`：SDK 动态加载 + `OceanDigitalHuman` 类（init/speak 队列/think/idle/setVolume/destroy + 事件系统）
- `src/frontend/src/pages/Assistant.tsx`：海洋守护者页（左数字人舞台 + 右聊天面板）
  - 状态机：`offline → loading → idle → thinking → speaking`
  - 加载分阶段文案 + 进度条
  - 思考覆盖层动画
  - **字幕（8/14 重构）**：流式生成（当前句末行+打字光标）→ 播报按**行队列**逐行推进（30 字/行，每字 230ms 估算，配合口型）；队列清理全覆盖（stop/清空/卸载/speakEnd）
  - 字幕样式：渐变毛玻璃、青色发光装饰条、打字光标、单行 nowrap
  - SDK 内置字幕隐藏（MutationObserver + 定时扫描）
  - AbortController 中断、DOMPurify + marked 安全渲染
- 快捷问题 8 个（海瞳平台/识别复核/渔网/MARPOL/微塑料/降解/报告解读/清理）

### 3.2 后端接口（存根 ⚠️）

- `digital_human_router.py`：`GET /api/v1/digital-human/config`（JWT 保护）返回占位配置；**前端未调用**（前端读 VITE_DH_*），保留无副作用

### 3.3 配置（✅ 前端已配置）

- `src/frontend/.env` **已配置**：`VITE_DH_APP_ID`（32位）、`VITE_DH_APP_SECRET`（32位）、`VITE_API_MODE` → 数字人 3D 可正常加载（非纯文本模式）
- 根 `.env`：OLLAMA 配置就绪（`OLLAMA_MODEL=ds-ocean_mingzhe`）；DH 凭据为空（前端直读 VITE_DH_*，不经后端，不影响数字人运行）
- `src/LLM/digital_human/config.yaml` 存在历史硬编码 appId 与 `${MOFA_APP_SECRET}` 占位符（已确认不作为运行配置来源，不影响使用）
- 已知风险：SDK 要求浏览器端 appSecret；生产化需服务端 Session Token（未实施）

---

## 四、当前状态汇总

| 事项 | 状态 |
|---|---|
| 在线聊天（规则+RAG+ds-ocean_mingzhe） | ✅ 运行 |
| 知识库 27 篇 / 训练数据 24719+ 条 | ✅ 完成 |
| 海瞳身份口径（规则层 + 模型层） | ✅ 规则层全兜底，模型层部分覆盖 |
| ds-ocean_mingzhe 部署（GGUF/Ollama/Modelfile） | ✅ 上线 |
| 数字人字幕（流式+逐句+单行） | ✅ 完成 |
| 数字人前端配置（VITE_DH_*） | ✅ 已配置（3D 可加载） |
| 冗余清理（死代码/pycache/过时配置） | ✅ 完成 |
| git 提交 | ✅ 本地两笔（大升级 + 字幕单行），**未 push** |

---

## 五、下一步计划（按优先级）

1. **push 本地提交**（de9e889 大升级 + 484509e 字幕单行）
2. **模型层补强"你是谁"**：rank 32/alpha 64 重训边界样本（规则层已兜底，非紧急）
3. **知识题模型层覆盖**：PAI 重新导出真正合并的 LoRA 模型（确认 Export 勾选合并）
4. **数字人**：验证 3D 加载与逐句播报（`.env` 已配置）
5. **安全**：评估 Session Token 方案（config.yaml 非运行配置来源，不影响使用）
6. **交付文档**：需求/设计/测试用例/用户手册等 doc/ 目录补齐

---

## 六、关键文件清单

| 文件 | 说明 |
|---|---|
| src/backend/services/llm.py | 确定性规则（海瞳口径）+ 质量门禁 + 兜底 |
| src/LLM/chat_api.py | Ollama 客户端 + RAG 双通道 + think 过滤（默认模型 ds-ocean_mingzhe） |
| src/LLM/rag/lexical_retriever.py | 本地词法检索 |
| src/backend/routers/chat_router.py | SSE 对话路由 |
| src/frontend/src/services/digitalHuman.ts | 数字人 SDK 封装 |
| src/frontend/src/pages/Assistant.tsx | 海洋守护者页（字幕队列/快捷问题/状态机） |
| src/LLM/fine_tune/expand_dataset.py | 数据集生成器（v1/v2） |
| src/LLM/fine_tune/train_lora.py | 本地 LoRA 训练脚本（含身份/边界强化数据） |
| src/LLM/fine_tune/gen_enhanced_samples.py / gen_boundary_samples.py | 身份/边界样本生成器（海瞳口径） |
| src/LLM/fine_tune/data/ | 训练数据（24719+ 条） |
| data/knowledge/ | RAG 知识库（27 篇） |
| models/llm/ | base / adapter / merged / GGUF / Modelfile（gitignore） |
| src/LLM/deploy/ | Modelfile（ds-ocean_mingzhe）/ 转换说明 |
| doc/11.过程参考/LLM模块开发记录/ | 开发日志（8.5~8.14）+ 本报告 |

---

## 七、风险与备注

1. 1.5B 小模型固有幻觉 → 三层防护兜底（规则/RAG/门禁）；"你是谁"类 base 强先验问题需 rank 32 以上训练才能覆盖
2. 数字人 appSecret 浏览器暴露为平台 SDK 设计约束，生产化前需 Session Token 方案
3. PAI 实例多次重建（数据需重传）；导出 merged 模型时务必勾选"合并 LoRA"并核对路径
