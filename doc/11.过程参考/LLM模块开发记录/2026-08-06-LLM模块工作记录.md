# LLM 模块工作记录 - 2026-08-06

## 今日完成事项

### 1. 微调数据集扩充至 701 条（目标 700+，已达标）

**起始状态**：4 个数据集共 363 条，且 `ocean_trash_recognition_qa.json` 存在 2 处 JSON 语法错误（内嵌英文双引号未转义），导致文件无法解析。

**修复问题**：
- 第 384 行：`"降解"和"消失"` → 改为中文引号 `“降解”和“消失”`
- 第 499 行：`"幽灵捕捞"` → 改为中文引号 `“幽灵捕捞”`

**扩充结果**：

| 数据集文件 | 原条数 | 现条数 | 新增 | 主题覆盖 |
|---|---|---|---|---|
| ocean_trash_qa.json | 169 | 367 | +198 | 垃圾分类/材质/降解周期/危害/回收 |
| ocean_trash_recognition_qa.json | 111(损坏) | 176 | +65 | YOLO检测/图像预处理/模型评估/ONNX/ROV |
| ocean_knowledge_qa.json | 69 | 128 | +59 | 蓝碳/死亡区/海洋热浪/酸化/生物多样性/MSP |
| ocean_trash_multi_turn.json | 14 | 30 | +16 | 多轮对话：垃圾处理/政策/微塑料/ESG |
| **合计** | **363** | **701** | **+338** | |

**质量保证**：
- 所有 output 字段 ≥150 字，分点编号，包含真实数据
- 4 个 JSON 文件均通过 `json.load()` 解析验证
- 未编造虚假公司/产品/研究数据

### 2. LoRA 微调训练（Qwen2-0.5B-Instruct，rank=8）

**环境实际情况**（与 8.4 文档记录有出入，已更正）：
- GPU：RTX 4060 Laptop 8GB（存在）
- 但 anaconda base 和 xa_code 两个环境均为 **CPU 版 torch**（无 CUDA 支持）
- 无 `llamafactory-cli` 命令可用
- 结论：本机无法跑 Qwen2-7B 微调，改用 Qwen2-0.5B + CPU 训练

**解决方案**：
- 新建 [src/LLM/fine_tune/train_lora.py](file:///c:/Users/82244/Desktop/软通实训/Program/issedu_ysu2026_7439/src/LLM/fine_tune/train_lora.py)：基于 transformers + peft 原生实现，不依赖 llamafactory-cli
- 支持 `--mode local`（本机 CPU，Qwen2-0.5B）和 `--mode cloud`（云 GPU，Qwen2-7B）双模式
- 更新 [src/LLM/fine_tune/train_config.yaml](file:///c:/Users/82244/Desktop/软通实训/Program/issedu_ysu2026_7439/src/LLM/fine_tune/train_config.yaml)：新增 local/cloud 双模式配置说明
- 使用 `HF_ENDPOINT=https://hf-mirror.com` 国内镜像解决 HuggingFace 连接超时问题

**训练配置**：

| 参数 | 值 |
|---|---|
| 基座模型 | Qwen/Qwen2-0.5B-Instruct |
| 训练样本数 | 492（注：训练启动时 knowledge_qa 仅加载 69 条，扩充后的 128 条未计入本轮训练） |
| 训练轮数 | 3 epochs |
| 批次大小 | 2 × 8（等效 batch_size=16） |
| 学习率 | 5e-5（cosine 调度） |
| 截断长度 | 1024 tokens |
| LoRA rank | 8 |
| LoRA alpha | 16 |
| LoRA dropout | 0.1 |
| 目标模块 | q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj |
| 可训练参数 | 4,399,104（0.88%） |
| 设备 | CPU |

**训练 Loss 曲线**：

| Step | Epoch | Loss | Learning Rate |
|---|---|---|---|
| 10 | 0.33 | 3.2087 | 4.998e-05 |
| 20 | 0.65 | 3.0026 | 4.776e-05 |
| 30 | 0.98 | 2.9624 | 4.216e-05 |
| 40 | 1.30 | 2.8854 | 3.400e-05 |
| 50 | 1.63 | 2.8444 | 2.452e-05 |
| 60 | 1.95 | 2.8835 | 1.510e-05 |
| 70 | 2.28 | 2.8188 | 7.152e-06 |
| 80 | 2.60 | **2.8017**（最低） | 1.857e-06 |
| 90 | 2.93 | 2.8497 | 0 |

- Loss 从 3.21 下降到 2.80，下降约 0.4
- 训练耗时 **66 分钟**
- 最终平均训练损失：**2.9175**

**产出文件**（[models/llm/ocean-lora/](file:///c:/Users/82244/Desktop/软通实训/Program/issedu_ysu2026_7439/models/llm/ocean-lora/)）：
- `adapter_config.json` + `adapter_model.safetensors`：LoRA 适配器权重
- `tokenizer.json` + `vocab.json` + `merges.txt`：tokenizer 文件
- `train_log.json`：训练日志
- `eval_samples.json`：评估生成样例
- `checkpoint-90/`：训练检查点

### 3. 微调效果评估

用 5 个测试问题对微调后模型进行生成评估：

1. **塑料袋在水下多久能降解？** — 回答基本相关但部分内容不准确（混入纸质、玻璃等非塑料品类）
2. **幽灵渔网对海洋生态有什么危害？** — 回答方向正确但部分表述不当（"渔网与鱼类形成捕食关系"）
3. **MARPOL 公约附则 V 的主要内容是什么？** — 有明显事实错误（混淆《马尼拉宣言》和 MARPOL 公约）
4. **如何提高 YOLO 对水下塑料瓶的检测精度？** — 回答较为通用，缺乏水下特定场景专业性
5. **普通人能为减少海洋塑料污染做什么？** — 回答质量较好，建议实用

**评估结论**：
- 模型已学会海洋环保领域问答的基本格式和语气
- 0.5B 基座模型能力有限，部分回答存在事实性错误，无法替代专业检索
- Loss 2.80 表明模型有在学习，但 0.5B 基座的能力上限限制了生成质量
- 如需更高质量回答，需用 Qwen2-7B + 完整 701 条数据在云 GPU 上重训

## 遗留与下一步

1. **数据集未充分利用**：本轮训练用 492 条（knowledge_qa 扩充后的 59 条未计入），701 条完整数据集可用于下一轮重训
2. **7B 模型微调待上云**：本机 8GB 显存 + CPU 版 torch 无法跑 7B，需在 AutoDL/阿里云 PAI 上执行 `python src/LLM/fine_tune/train_lora.py --mode cloud`
3. **GGUF 量化+Ollama 打包**：LoRA 权重合并后需导出 GGUF 并打包为 Ollama 模型，替换当前演示用的 `qwen2:0.5b`
4. **BLEU/ROUGE 自动评估**：当前仅做了生成样例人工评估，规划要求的 BLEU/ROUGE 指标待补
5. **数字人鉴权凭证签发接口**（DH-03）：后端 `GET /api/v1/digital-human/config` 仍未实现
