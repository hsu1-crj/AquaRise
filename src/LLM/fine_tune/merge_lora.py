#!/usr/bin/env python3
"""
LoRA 权重合并脚本
将训练好的 LoRA adapter 合并进基座模型，输出完整 HuggingFace 格式模型。

用法:
  # 合并 0.5B 本地模型（默认，CPU 可运行）
  python src/LLM/fine_tune/merge_lora.py --mode local

  # 合并 7B 云端模型（需在云 GPU 环境运行）
  python src/LLM/fine_tune/merge_lora.py --mode cloud

输出目录:
  local: models/llm/ocean-0.5b-merged/
  cloud: models/llm/ocean-7b-merged/
"""

import os
import sys
import json
import argparse
import shutil
from pathlib import Path

# 国内 HuggingFace 镜像
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 防止 OpenMP 多副本警告
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# ─── 项目根目录 ──────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

# ─── 模式配置 ────────────────────────────────────────────────────────────────
CONFIGS = {
    "local": {
        "base_model": "Qwen/Qwen2-0.5B-Instruct",
        "lora_adapter": ROOT / "models" / "llm" / "ocean-lora",
        "output_dir":   ROOT / "models" / "llm" / "ocean-0.5b-merged",
        "dtype":        "float16",     # CPU 下 float16 节省内存
        "device_map":   "cpu",
    },
    "cloud": {
        "base_model": "Qwen/Qwen2-7B-Instruct",
        "lora_adapter": ROOT / "models" / "llm" / "ocean-7b-lora",   # 云端训练产出路径
        "output_dir":   ROOT / "models" / "llm" / "ocean-7b-merged",
        "dtype":        "bfloat16",    # 云 GPU 推荐 bfloat16
        "device_map":   "auto",        # 自动分配多 GPU
    },
}


def check_prerequisites(cfg: dict) -> None:
    """检查前置条件"""
    adapter_path = Path(cfg["lora_adapter"])
    if not adapter_path.exists():
        raise FileNotFoundError(f"LoRA adapter 目录不存在: {adapter_path}")
    required_files = ["adapter_config.json", "adapter_model.safetensors"]
    for fname in required_files:
        if not (adapter_path / fname).exists():
            raise FileNotFoundError(f"缺少必要文件: {adapter_path / fname}")
    print(f"✅ 前置检查通过: {adapter_path}")


def merge_lora(
    base_model: str,
    lora_adapter: str,
    output_dir: str,
    dtype: str = "float16",
    device_map: str = "cpu",
) -> None:
    """执行 LoRA 合并"""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    dtype_map = {
        "float16":  torch.float16,
        "bfloat16": torch.bfloat16,
        "float32":  torch.float32,
    }
    torch_dtype = dtype_map.get(dtype, torch.float16)

    # ── 1. 加载基座模型 ──────────────────────────────────────────────────────
    print(f"\n[1/5] 加载基座模型: {base_model}  (dtype={dtype}, device={device_map})")
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch_dtype,
        device_map=device_map,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )
    print(f"      基座模型参数量: {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M")

    # ── 2. 加载 LoRA adapter ─────────────────────────────────────────────────
    print(f"[2/5] 加载 LoRA adapter: {lora_adapter}")
    model = PeftModel.from_pretrained(model, lora_adapter)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total     = sum(p.numel() for p in model.parameters())
    print(f"      可训练参数: {trainable/1e6:.2f}M / 总参数: {total/1e6:.1f}M")

    # ── 3. 合并权重 ──────────────────────────────────────────────────────────
    print("[3/5] 合并 LoRA 权重...")
    model = model.merge_and_unload()
    # CPU 上 float16 可能不稳定，转为 float32 保存
    if device_map == "cpu" and torch_dtype == torch.float16:
        model = model.to(torch.float32)
        print("      CPU 模式: 已转换为 float32 以保证兼容性")

    # ── 4. 保存合并后模型 ────────────────────────────────────────────────────
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"[4/5] 保存合并模型: {out}")
    model.save_pretrained(out, safe_serialization=True)

    # ── 5. 保存 tokenizer ────────────────────────────────────────────────────
    print("[5/5] 保存 tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    tokenizer.save_pretrained(out)

    # ── 写入合并信息 ─────────────────────────────────────────────────────────
    meta = {
        "base_model":   base_model,
        "lora_adapter": str(lora_adapter),
        "output_dir":   str(out),
        "dtype":        dtype,
        "merged_at":    __import__("datetime").datetime.now().isoformat(),
        "total_params": f"{sum(p.numel() for p in model.parameters()) / 1e6:.1f}M",
    }
    with open(out / "merge_info.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # ── 验证输出 ─────────────────────────────────────────────────────────────
    model_files = list(out.glob("model*.safetensors"))
    config_file = out / "config.json"
    tokenizer_file = out / "tokenizer.json"

    if not model_files:
        raise RuntimeError("合并失败：未找到 safetensors 权重文件")
    if not config_file.exists():
        raise RuntimeError("合并失败：缺少 config.json")
    if not tokenizer_file.exists():
        raise RuntimeError("合并失败：缺少 tokenizer.json")

    total_size = sum(f.stat().st_size for f in out.iterdir()) / (1024 ** 2)
    print(f"\n✅ 合并完成！")
    print(f"   输出目录: {out}")
    print(f"   模型文件: {[f.name for f in model_files]}")
    print(f"   目录大小: {total_size:.1f} MB")


def main():
    parser = argparse.ArgumentParser(description="LoRA 权重合并脚本")
    parser.add_argument(
        "--mode", choices=["local", "cloud"], default="local",
        help="local=0.5B CPU合并（本机）, cloud=7B GPU合并（云端）"
    )
    parser.add_argument("--base-model",    help="覆盖基座模型路径/名称")
    parser.add_argument("--lora-adapter",  help="覆盖 LoRA adapter 路径")
    parser.add_argument("--output-dir",    help="覆盖输出目录")
    parser.add_argument("--dtype",         help="覆盖 dtype（float16/bfloat16/float32）")
    args = parser.parse_args()

    cfg = dict(CONFIGS[args.mode])  # 复制，防止修改原始配置
    if args.base_model:   cfg["base_model"]   = args.base_model
    if args.lora_adapter: cfg["lora_adapter"] = args.lora_adapter
    if args.output_dir:   cfg["output_dir"]   = args.output_dir
    if args.dtype:        cfg["dtype"]        = args.dtype

    print("=" * 60)
    print(f"  LoRA 权重合并  [模式: {args.mode}]")
    print("=" * 60)
    print(f"  基座模型  : {cfg['base_model']}")
    print(f"  LoRA路径  : {cfg['lora_adapter']}")
    print(f"  输出目录  : {cfg['output_dir']}")
    print(f"  数据类型  : {cfg['dtype']}")
    print()

    check_prerequisites(cfg)
    merge_lora(
        base_model   = cfg["base_model"],
        lora_adapter = str(cfg["lora_adapter"]),
        output_dir   = str(cfg["output_dir"]),
        dtype        = cfg["dtype"],
        device_map   = cfg["device_map"],
    )


if __name__ == "__main__":
    main()
