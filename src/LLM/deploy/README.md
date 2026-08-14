# Ollama 部署说明

> **当前状态（2026-08-12）**：DeepSeek-R1-Distill-Qwen-1.5B 的海洋 LoRA v9 候选正在本机 RTX 4060 上训练（v9 数据：443 训练 / 44 评估，24 条固定生成合同）。训练、固定问题生成验收、合并与 Ollama 烟测全部通过前，生产配置必须继续使用 `deepseek-r1:1.5b`；旧的 `ocean-assistant` 不再是默认链路，也不能作为新训练结果的替代品。

## 生产链路

```text
用户问题 → 确定性身份/高风险规则 → RAG（向量优先、词法兜底）
→ Ollama 模型 → think 过滤与回答质量门禁 → 知识库安全兜底 → 前端/数字人分句播报
```

服务层已经固定项目身份、范围边界、低置信度提示和知识库证据约束，因此即使模型短暂不可用也不会把旧模型或无依据回答直接暴露给用户。

## 当前基线模型

```bash
ollama pull deepseek-r1:1.5b
```

根目录 `.env` 在 v9 候选验收通过前保持：

```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=deepseek-r1:1.5b
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=1024
```

## v9 合格后的部署步骤

仅当 `models/llm/deepseek-r1-ocean-lora-v9/generation_eval.json` 的人工验收通过后执行（v9 为候选待验收状态）。重点检查开发者、父母、微塑料、MARPOL、低置信度和越界天气题，不得只看 loss 或 `passed` 数量。

### 1. 合并 LoRA

```powershell
conda activate xa_code
python src/LLM/fine_tune/merge_lora.py --mode deepseek --device-map cuda
```

脚本默认指向 v9 候选：adapter=`models/llm/deepseek-r1-ocean-lora-v9`，输出=`models/llm/deepseek-r1-ocean-merged/`；也可用 `--adapter` / `--output` / `--base-model` 显式覆盖。本地 RTX 4060 8GB 显存不足时改用 `--device-map auto` 由 accelerate 自动分配。产物为本地忽略目录，模型权重、checkpoint 和缓存不得提交 Git。

### 2. 转换为 GGUF

```powershell
python src/LLM/deploy/convert_to_gguf.py ^
  --model-dir models/llm/deepseek-r1-ocean-merged ^
  --output    models/llm/deepseek-r1-ocean.gguf
```

转换脚本按 Qwen2 架构（DeepSeek-R1-Distill-Qwen-1.5B 为 Qwen2 家族）输出 F16 GGUF，产物 `models/llm/deepseek-r1-ocean.gguf` 约 3 GB。

### 3. 创建 Ollama 模型

在项目根目录创建临时 Modelfile（`FROM` 指向上面转换出的 GGUF 文件）：

```text
FROM ./models/llm/deepseek-r1-ocean.gguf
PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER num_predict 1024
PARAMETER repeat_penalty 1.12
SYSTEM """
你是“海洋守护者”。遵守服务端提供的知识库证据与范围约束，不编造来源、数字或实时信息；不要输出思考过程。
"""
```

然后执行：

```powershell
ollama create deepseek-r1-ocean:1.5b --experimental --quantize q4_K_M -f .\Modelfile
```

`src/LLM/deploy/Modelfile` 作为正式配置基线，`FROM` 行在模型创建后替换为 `deepseek-r1-ocean:1.5b` 使用。

### 4. Ollama 与后端烟测

```powershell
ollama run deepseek-r1-ocean:1.5b "这个项目是谁开发的？"
ollama run deepseek-r1-ocean:1.5b "你的爸爸是谁？"
ollama run deepseek-r1-ocean:1.5b "MARPOL 附则 V 如何管理船舶塑料垃圾？"
python src/LLM/verify_upgrade.py --ollama
```

确认回答自然、无 `<think>` 泄漏、无身份错答且后端 RAG 链路正常后，才把 `.env` 的 `OLLAMA_MODEL` 改为：

```env
OLLAMA_MODEL=deepseek-r1-ocean:1.5b
```

随后重启后端；保留 `deepseek-r1:1.5b` 作为可回滚基线，确认稳定后再决定是否删除旧 `ocean-assistant`。
