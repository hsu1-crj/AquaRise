# Ollama 部署说明

## 前置条件

- Ollama 已安装并运行（本项目环境: Ollama 0.32.5）
- 模型已导出为 GGUF 格式

## 部署步骤

### 1. 导出 GGUF 模型

在 LLaMA Factory 微调完成后，使用 `llama.cpp` 工具将合并后的模型转换为 GGUF 格式:

```bash
# 合并 LoRA 权重
llamafactory-cli export \
    --model_name_or_path Qwen/Qwen2-7B-Instruct \
    --adapter_name_or_path ../../models/llm/ocean-lora \
    --template qwen \
    --finetuning_type lora \
    --export_dir ./exported_model \
    --export_size 2 \
    --export_legacy_format false

# 转换为 GGUF（需安装 llama.cpp）
python llama.cpp/convert-hf-to-gguf.py ./exported_model --outtype q8_0
```

### 2. 创建 Ollama 模型

```bash
ollama create ocean-assistant -f Modelfile
```

### 3. 运行模型

```bash
# 命令行交互
ollama run ocean-assistant

# API调用（端口 11434）
curl http://localhost:11434/api/chat -d '{
  "model": "ocean-assistant",
  "messages": [{"role": "user", "content": "如何识别水下垃圾?"}],
  "stream": true
}'
```

### 4. 模型管理

```bash
ollama list                    # 查看已有模型
ollama show ocean-assistant    # 查看模型详情
ollama rm ocean-assistant      # 删除模型
```
