# Ollama 部署说明

当前生产配置统一使用 `deepseek-r1:1.5b`，旧的 LoRA `ocean-assistant` 不再作为聊天默认模型。

## 直接运行

```bash
ollama pull deepseek-r1:1.5b
ollama run deepseek-r1:1.5b
```

后端通过根目录 `.env` 配置：

```env
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=deepseek-r1:1.5b
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=1024
```

## 可选：创建带项目提示词的别名

```bash
ollama create ocean-guardian -f src/LLM/deploy/Modelfile
ollama run ocean-guardian
```

后端仍建议使用 `deepseek-r1:1.5b`，因为项目提示词、RAG 证据和安全兜底都在服务层统一管理，避免别名模型与代码配置再次分叉。
