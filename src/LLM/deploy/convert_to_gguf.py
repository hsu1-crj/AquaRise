#!/usr/bin/env python3
"""
Qwen2 HuggingFace → GGUF 转换脚本
将合并后的 HF 格式模型转为 GGUF 格式，供 Ollama 打包使用。

依赖:
  pip install gguf  (已安装于 xa_code 环境)

用法:
  python src/LLM/deploy/convert_to_gguf.py \
    --model-dir models/llm/ocean-0.5b-merged \
    --output    models/llm/ocean-0.5b.gguf

  # 云端 7B（在 AutoDL/PAI 执行）
  python src/LLM/deploy/convert_to_gguf.py \
    --model-dir models/llm/ocean-7b-merged \
    --output    models/llm/ocean-7b.gguf

注意:
  - F16 精度，7B 约 14 GB，0.5B 约 1 GB
  - 转换完成后可用 llama-quantize 进行量化（Q4_K_M 推荐）
  - 量化命令: ollama show ocean-assistant --modelfile 查看基础 Modelfile
"""

import os
import sys
import json
import struct
import argparse
import numpy as np
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))


# ─── Qwen2 HF → GGUF 张量名映射 ─────────────────────────────────────────────
def _make_tensor_map(num_layers: int) -> dict[str, str]:
    """构建 HuggingFace 张量名 → llama.cpp GGUF 张量名的映射表"""
    m: dict[str, str] = {
        "model.embed_tokens.weight": "token_embd.weight",
        "model.norm.weight":         "output_norm.weight",
        "lm_head.weight":            "output.weight",
    }
    for i in range(num_layers):
        p = f"model.layers.{i}"
        b = f"blk.{i}"
        m.update({
            f"{p}.input_layernorm.weight":          f"{b}.attn_norm.weight",
            f"{p}.post_attention_layernorm.weight":  f"{b}.ffn_norm.weight",
            # Attention（带 bias 的 qkv 是 Qwen2 特有）
            f"{p}.self_attn.q_proj.weight":          f"{b}.attn_q.weight",
            f"{p}.self_attn.q_proj.bias":            f"{b}.attn_q.bias",
            f"{p}.self_attn.k_proj.weight":          f"{b}.attn_k.weight",
            f"{p}.self_attn.k_proj.bias":            f"{b}.attn_k.bias",
            f"{p}.self_attn.v_proj.weight":          f"{b}.attn_v.weight",
            f"{p}.self_attn.v_proj.bias":            f"{b}.attn_v.bias",
            f"{p}.self_attn.o_proj.weight":          f"{b}.attn_output.weight",
            # MLP
            f"{p}.mlp.gate_proj.weight":             f"{b}.ffn_gate.weight",
            f"{p}.mlp.up_proj.weight":               f"{b}.ffn_up.weight",
            f"{p}.mlp.down_proj.weight":             f"{b}.ffn_down.weight",
        })
    return m


def convert_to_gguf(model_dir: str, output_path: str) -> None:
    """将 Qwen2 HF 模型转换为 GGUF 格式"""
    from gguf import GGUFWriter, GGMLQuantizationType

    model_dir  = Path(model_dir)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ── 1. 读取模型配置 ──────────────────────────────────────────────────────
    print("[1/5] 读取模型配置...")
    with open(model_dir / "config.json", encoding="utf-8") as f:
        cfg = json.load(f)

    arch              = "qwen2"
    num_layers        = cfg["num_hidden_layers"]
    hidden_size       = cfg["hidden_size"]
    num_heads         = cfg["num_attention_heads"]
    num_kv_heads      = cfg.get("num_key_value_heads", num_heads)
    intermediate_size = cfg["intermediate_size"]
    max_pos           = cfg.get("max_position_embeddings", 32768)
    rope_theta        = cfg.get("rope_theta", 1000000.0)
    rms_norm_eps      = cfg.get("rms_norm_eps", 1e-6)
    vocab_size        = cfg["vocab_size"]
    head_dim          = hidden_size // num_heads

    print(f"      架构: {arch}  层数: {num_layers}  隐藏维度: {hidden_size}")
    print(f"      注意力头: {num_heads}  KV头: {num_kv_heads}  词表: {vocab_size}")

    # ── 2. 读取 tokenizer ────────────────────────────────────────────────────
    print("[2/5] 读取 tokenizer...")
    with open(model_dir / "vocab.json", encoding="utf-8") as f:
        vocab = json.load(f)          # token → id
    with open(model_dir / "merges.txt", encoding="utf-8") as f:
        merges = [l.strip() for l in f if l.strip() and not l.startswith("#")]

    tokenizer_cfg_path = model_dir / "tokenizer_config.json"
    eos_token = "<|im_end|>"
    bos_token = None
    if tokenizer_cfg_path.exists():
        with open(tokenizer_cfg_path, encoding="utf-8") as f:
            tc = json.load(f)
        eos_token = tc.get("eos_token", eos_token)
        bos_token = tc.get("bos_token", None)

    eos_id = vocab.get(eos_token, 151645)
    bos_id = vocab.get(bos_token, 151643) if bos_token else 151643

    # ── 3. 初始化 GGUFWriter ─────────────────────────────────────────────────
    print(f"[3/5] 初始化 GGUF 输出: {output_path}")
    writer = GGUFWriter(str(output_path), arch)

    # 通用元数据
    writer.add_name(f"Ocean-Assistant-Qwen2-{hidden_size//1024}B")
    writer.add_description("水下垃圾识别与海洋污染分析 LoRA 微调模型")
    writer.add_file_type(1)   # F16

    # 架构参数（qwen2.* 命名空间）
    writer.add_context_length(max_pos)
    writer.add_embedding_length(hidden_size)
    writer.add_block_count(num_layers)
    writer.add_feed_forward_length(intermediate_size)
    writer.add_rope_freq_base(float(rope_theta))
    writer.add_head_count(num_heads)
    writer.add_head_count_kv(num_kv_heads)
    writer.add_layer_norm_rms_eps(float(rms_norm_eps))
    writer.add_key_length(head_dim)
    writer.add_value_length(head_dim)

    # Tokenizer 元数据
    id_to_token = {v: k for k, v in vocab.items()}
    tokens_sorted = [id_to_token.get(i, f"<unk_{i}>") for i in range(vocab_size)]
    token_types   = [1] * vocab_size  # BPE=1
    scores        = [0.0] * vocab_size

    writer.add_tokenizer_model("gpt2")           # Qwen2 使用 BPE（GPT-2 风格）
    writer.add_tokenizer_pre("qwen2")
    writer.add_token_list(tokens_sorted)
    writer.add_token_scores(scores)
    writer.add_token_types(token_types)
    writer.add_bos_token_id(bos_id)
    writer.add_eos_token_id(eos_id)
    writer.add_pad_token_id(eos_id)
    writer.add_token_merges(merges)

    # ── 4. 读取并写入张量 ────────────────────────────────────────────────────
    print("[4/5] 加载并写入张量（F16）...")
    import torch
    from safetensors import safe_open

    tensor_map = _make_tensor_map(num_layers)
    safetensor_files = sorted(model_dir.glob("model*.safetensors"))

    if not safetensor_files:
        raise FileNotFoundError(f"未找到 safetensors 文件: {model_dir}/model*.safetensors")

    written = 0
    skipped = []
    for stfile in safetensor_files:
        print(f"      处理: {stfile.name}")
        with safe_open(str(stfile), framework="pt", device="cpu") as f:
            for hf_name in f.keys():
                gguf_name = tensor_map.get(hf_name)
                if gguf_name is None:
                    skipped.append(hf_name)
                    continue
                tensor = f.get_tensor(hf_name).to(torch.float16).numpy()
                writer.add_tensor(gguf_name, tensor)
                written += 1

    if skipped:
        print(f"      跳过 {len(skipped)} 个未映射张量（通常无影响）")
    print(f"      已写入 {written} 个张量")

    # ── 5. 写文件 ────────────────────────────────────────────────────────────
    print("[5/5] 写入 GGUF 文件...")
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    size_mb = output_path.stat().st_size / (1024 ** 2)
    print(f"\n✅ GGUF 转换完成!")
    print(f"   输出文件: {output_path}")
    print(f"   文件大小: {size_mb:.1f} MB")
    print(f"   下一步: 将文件复制到 src/LLM/deploy/ocean-assistant.gguf，然后运行:")
    print(f"           cd src/LLM/deploy && ollama create ocean-assistant -f Modelfile")


def main():
    parser = argparse.ArgumentParser(description="Qwen2 HF→GGUF 转换脚本")
    parser.add_argument(
        "--model-dir", default="models/llm/ocean-0.5b-merged",
        help="合并后的 HF 模型目录（包含 model*.safetensors 和 config.json）"
    )
    parser.add_argument(
        "--output", default="models/llm/ocean-0.5b.gguf",
        help="输出 GGUF 文件路径"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("  Qwen2 → GGUF 转换")
    print("=" * 60)
    print(f"  输入目录: {args.model_dir}")
    print(f"  输出文件: {args.output}")
    print()

    convert_to_gguf(
        model_dir   = str(ROOT / args.model_dir) if not Path(args.model_dir).is_absolute() else args.model_dir,
        output_path = str(ROOT / args.output)    if not Path(args.output).is_absolute()    else args.output,
    )


if __name__ == "__main__":
    main()
