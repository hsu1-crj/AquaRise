# 7B 模型云端训练与生产部署指南

> 本指南覆盖从云 GPU 实例创建到 Ollama 模型上线的完整流程。
> 本地 0.5B 实验已完成（详见 `doc/11.过程参考/LLM模块开发记录/2026-08-06-LLM模块工作记录.md`），
> 生产环境推荐使用 Qwen2-7B-Instruct 在 AutoDL / 阿里云 PAI 上训练。

---

## 一、云 GPU 环境准备

### AutoDL（推荐，按量计费）

```bash
# 镜像选择：PyTorch 2.3 / Python 3.10 / CUDA 12.1（A100/RTX4090均可）
# 实例类型：单卡24G（RTX3090/A5000）可跑7B LoRA；单卡40G（A100）更宽裕

# 登录实例后，激活 conda 环境（镜像自带）
conda activate base

# 克隆仓库（或通过 AutoDL 数据盘挂载）
git clone <your-repo-url> issedu_ysu2026_7439
cd issedu_ysu2026_7439
```

### 阿里云 PAI-DSW

```bash
# 选择 PyTorch 2.3 + Python 3.10 镜像
# 存储：绑定 NAS 挂载到 /mnt/workspace 用于存放大文件
git clone <your-repo-url>
cd issedu_ysu2026_7439
```

---

## 二、依赖安装

```bash
# 设置 HuggingFace 国内镜像
export HF_ENDPOINT=https://hf-mirror.com

# 安装 LLM 模块依赖
pip install -r src/LLM/requirements.txt

# 7B 训练额外需要（云环境通常已预装）
pip install bitsandbytes accelerate deepspeed
```

---

## 三、执行 7B LoRA 微调

```bash
# 确认数据集完整（应有 701 条）
python -c "
import json, glob
total = 0
for f in glob.glob('src/LLM/fine_tune/data/*.json'):
    data = json.load(open(f, encoding='utf-8'))
    total += len(data)
    print(f'{f}: {len(data)} 条')
print(f'合计: {total} 条')
"

# 执行 7B 微调（约 2-4 小时，A100 40G）
python src/LLM/fine_tune/train_lora.py --mode cloud

# 可选：指定自定义路径
python src/LLM/fine_tune/train_lora.py \
  --mode cloud \
  --output-dir models/llm/ocean-7b-lora
```

**预期训练参数**（来自 `train_config.yaml`）:

| 参数 | 值 |
|---|---|
| 基座模型 | Qwen/Qwen2-7B-Instruct |
| LoRA rank | 8 |
| LoRA alpha | 16 |
| batch_size | 16（梯度累积×8） |
| epochs | 3 |
| 预期 Loss | 从 ~2.8 降至 ~1.5-2.0 |
| 预期耗时 | RTX4090: ~2h / A100 40G: ~1.5h |

---

## 四、LoRA 权重合并

```bash
# 云端：合并 7B 权重（需 ~28GB 显存或 CPU offload）
python src/LLM/fine_tune/merge_lora.py --mode cloud

# 输出：models/llm/ocean-7b-merged/
# 包含：model-*.safetensors, config.json, tokenizer.json, merge_info.json
```

---

## 五、导出 GGUF 格式

### 5.1 安装转换工具

```bash
pip install gguf

# 下载 llama.cpp 官方转换脚本（需访问 GitHub）
curl -sL https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py \
  -o convert_hf_to_gguf.py

# 若 GitHub 访问受限，使用镜像站
curl -sL https://mirror.ghproxy.com/https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py \
  -o convert_hf_to_gguf.py
```

### 5.2 转换为 F16 GGUF

```bash
python convert_hf_to_gguf.py \
  models/llm/ocean-7b-merged \
  --outfile models/llm/ocean-7b.gguf \
  --outtype f16

# 文件大小参考：7B F16 约 14GB；4-bit 量化后约 4GB
```

### 5.3 量化（推荐 Q4_K_M，兼顾质量与速度）

```bash
# 需要从 llama.cpp 编译 llama-quantize 工具
# 或使用 llama-cpp-python 的量化接口

# 方案A：llama-cpp-python 量化
python -c "
from llama_cpp import llama_model_quantize_params, llama_model_quantize
params = llama_model_quantize_params()
# 量化到 Q4_K_M
llama_model_quantize(
    b'models/llm/ocean-7b.gguf',
    b'models/llm/ocean-7b-q4km.gguf',
    params
)
"

# 方案B：docker 使用 llama.cpp 镜像（最简单）
docker run --rm \
  -v $(pwd)/models/llm:/models \
  ghcr.io/ggerganov/llama.cpp:full \
  /app/llama-quantize \
  /models/ocean-7b.gguf \
  /models/ocean-7b-q4km.gguf \
  Q4_K_M
```

> **量化说明**
> - `Q4_K_M`：推荐，质量损失<5%，7B模型约4GB
> - `Q8_0`：高质量，7B模型约8GB
> - `F16`：无量化，7B模型约14GB（占用最大）

---

## 六、Ollama 打包与部署

### 本地 Ollama 服务器（已验证 0.32.5）

```bash
# 将量化后的 GGUF 文件放到 deploy 目录
cp models/llm/ocean-7b-q4km.gguf src/LLM/deploy/ocean-assistant.gguf

# 更新 Modelfile 中的 FROM 路径（使用绝对路径或相对于 Modelfile 的路径）
# 当前 Modelfile 已配置：FROM ./ocean-assistant.gguf

# 创建 Ollama 模型
cd src/LLM/deploy
ollama create ocean-assistant -f Modelfile

# 验证模型可用
ollama list | grep ocean-assistant
ollama run ocean-assistant "你好，介绍一下你自己"

# 如需替换旧模型
ollama rm ocean-assistant   # 删除旧版本
cd src/LLM/deploy
ollama create ocean-assistant -f Modelfile
```

### 更新后端默认模型

修改 `src/backend/main.py` 中的 `ChatRequest` 默认模型：

```python
# 将 default="qwen2:0.5b" 改为
model: str = Field(default="ocean-assistant", ...)
```

或通过环境变量：

```bash
export LLM_MODEL=ocean-assistant
```

---

## 七、部署验证清单

```bash
# 1. 模型已加载
ollama list | grep ocean-assistant

# 2. 基础问答测试
ollama run ocean-assistant "塑料袋在水下多久能降解？"

# 3. RAG 增强测试
curl -X POST http://localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "MARPOL公约的主要内容"}],
    "model": "ocean-assistant",
    "enable_rag": true
  }'

# 4. 流式输出测试
curl -N -X POST http://localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"你好"}], "stream": true}'
```

---

## 八、文件产出清单

| 文件 | 大小（估计） | 说明 |
|---|---|---|
| `models/llm/ocean-7b-lora/` | ~120MB | 7B LoRA adapter 权重 |
| `models/llm/ocean-7b-merged/` | ~14GB | 合并后完整模型（safetensors） |
| `models/llm/ocean-7b.gguf` | ~14GB | F16 GGUF（中间文件，可删） |
| `models/llm/ocean-7b-q4km.gguf` | ~4GB | 量化后 GGUF（最终产出） |
| `src/LLM/deploy/ocean-assistant.gguf` | 软链或副本 | Ollama 打包用 |

> **清理建议**: F16 GGUF（14GB）用完可删，保留 Q4_K_M 版本即可。
> `ocean-7b-merged/` 占用14GB，如磁盘紧张可在打包 Ollama 模型后删除。

---

## 九、常见问题

| 问题 | 原因 | 解决 |
|---|---|---|
| CUDA OOM | 批次过大 | 调小 `per_device_train_batch_size` |
| 模型下载失败 | 网络限制 | 确认 `HF_ENDPOINT=https://hf-mirror.com` |
| convert_hf_to_gguf.py 报错 | gguf 版本不匹配 | 使用同一 commit 的脚本和 gguf 包 |
| ollama create 超时 | GGUF 文件大 | 使用本地绝对路径，确保磁盘 >20GB |
| 生成质量差 | 数据集不足 | 补充领域数据后重训，目标 loss<2.0 |
