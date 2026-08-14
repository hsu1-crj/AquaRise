#!/usr/bin/env python3
"""
LoRA 权重合并脚本
将训练好的 LoRA adapter 合并进基座模型，输出完整 HuggingFace 格式模型。

用法:
  # 合并 DeepSeek-R1-1.5B v9 候选 LoRA（默认，验收通过后使用）
  python src/LLM/fine_tune/merge_lora.py --mode deepseek --device-map cuda

  # 合并 0.5B 本地模型（默认，CPU 可运行）
  python src/LLM/fine_tune/merge_lora.py --mode local

  # 合并 7B 云端模型（需在云 GPU 环境运行）
  python src/LLM/fine_tune/merge_lora.py --mode cloud

  # 指定 adapter / 输出目录 / 基座模型（覆盖 deepseek 模式默认值）
  python src/LLM/fine_tune/merge_lora.py --mode deepseek \
    --adapter models/llm/deepseek-r1-ocean-lora-v9 \
    --output  models/llm/deepseek-r1-ocean-merged \
    --base-model models/llm/base/DeepSeek-R1-Distill-Qwen-1.5B

输出目录:
  deepseek: models/llm/deepseek-r1-ocean-merged/
  local:    models/llm/ocean-0.5b-merged/
  cloud:    models/llm/ocean-7b-merged/
"""

import os
import sys
import json
import math
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
    # 2026-08 DeepSeek-R1 v9 候选产物（443 训练 / 44 评估）。仅在生成验收全部通过后才允许合并和部署。
    "deepseek": {
        "base_model": ROOT / "models" / "llm" / "base" / "DeepSeek-R1-Distill-Qwen-1.5B",
        "lora_adapter": ROOT / "models" / "llm" / "deepseek-r1-ocean-lora-v9",
        "output_dir": ROOT / "models" / "llm" / "deepseek-r1-ocean-merged",
        "dtype": "float16",
        "device_map": "auto",
    },
}


def check_prerequisites(cfg: dict) -> None:
    """检查前置条件"""
    base_path = Path(str(cfg["base_model"]))
    if ("/" in str(cfg["base_model"]) or "\\" in str(cfg["base_model"])) and not base_path.exists():
        raise FileNotFoundError(f"基座模型目录不存在: {base_path}")
    adapter_path = Path(cfg["lora_adapter"])
    if not adapter_path.exists():
        raise FileNotFoundError(f"LoRA adapter 目录不存在: {adapter_path}")
    required_files = ["adapter_config.json", "adapter_model.safetensors"]
    for fname in required_files:
        if not (adapter_path / fname).exists():
            raise FileNotFoundError(f"缺少必要文件: {adapter_path / fname}")
    print(f"✅ 前置检查通过: {adapter_path}")



def check_deployment_gate(cfg: dict) -> None:
    """仅允许通过固定生成验收的 DeepSeek 海洋 LoRA 被合并部署。"""
    adapter_path = Path(cfg["lora_adapter"])
    report_path = adapter_path / "training_report.json"
    eval_path = adapter_path / "generation_eval.json"
    missing = [str(path) for path in (report_path, eval_path) if not path.exists()]
    if missing:
        raise RuntimeError("部署门禁失败：缺少训练验收报告：" + "；".join(missing))

    try:
        training = json.loads(report_path.read_text(encoding="utf-8"))
        generation = json.loads(eval_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"部署门禁失败：无法读取验收报告：{exc}") from exc

    eval_loss = training.get("eval_metrics", {}).get("eval_loss")
    summary = generation.get("summary", {})
    total = summary.get("total")
    passed = summary.get("passed")
    contains_think = summary.get("contains_think")
    items = generation.get("items", [])
    failed_items = [item.get("question", "未命名题目") for item in items if not item.get("passed")]

    failures: list[str] = []
    if not isinstance(eval_loss, (int, float)) or not math.isfinite(float(eval_loss)):
        failures.append(f"eval_loss 无效：{eval_loss!r}")
    if not isinstance(total, int) or total <= 0:
        failures.append(f"生成验收总题数无效：{total!r}")
    elif passed != total:
        failures.append(f"固定生成验收未全通过：{passed}/{total}；失败题：{failed_items}")
    if contains_think != 0:
        failures.append(f"检测到 {contains_think!r} 条 <think> 泄漏")
    if not isinstance(items, list) or len(items) != total:
        failures.append("生成验收题目明细不完整")

    if failures:
        raise RuntimeError("部署门禁失败，禁止合并或导入 Ollama：\n- " + "\n- ".join(failures))
    print(f"✅ 部署门禁通过：eval_loss={float(eval_loss):.4f}，固定生成验收 {passed}/{total}，无 <think> 泄漏")

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
    # Transformers 使用 {"": 0} 明确表示单卡 CUDA；其余值交由 accelerate 处理。
    resolved_device_map = {"": 0} if device_map == "cuda" else device_map
    print(f"\n[1/5] 加载基座模型: {base_model}  (dtype={dtype}, device={device_map})")
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch_dtype,
        device_map=resolved_device_map,
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
    if out.exists() and any(out.iterdir()):
        raise RuntimeError(f"拒绝覆盖非空的合并目录: {out}")
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
        "device_map":   device_map,
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
        "--mode", choices=["local", "cloud", "deepseek"], default="deepseek",
        help="local=旧0.5B CPU，cloud=旧7B，deepseek=DeepSeek-R1-1.5B 海洋 LoRA（默认，指向 v9 候选）"
    )
    parser.add_argument(
        "--adapter", "--lora-adapter", dest="adapter",
        help="覆盖 LoRA adapter 路径（deepseek 默认 models/llm/deepseek-r1-ocean-lora-v9）"
    )
    parser.add_argument(
        "--output", "--output-dir", dest="output",
        help="覆盖输出目录（deepseek 默认 models/llm/deepseek-r1-ocean-merged）"
    )
    parser.add_argument(
        "--base-model",
        help="覆盖基座模型路径/名称（deepseek 默认 models/llm/base/DeepSeek-R1-Distill-Qwen-1.5B）"
    )
    parser.add_argument("--dtype", help="覆盖 dtype（float16/bfloat16/float32）")
    parser.add_argument(
        "--device-map", choices=["cpu", "auto", "cuda"],
        help="覆盖权重加载设备；cuda 明确使用第 0 张 GPU（本地 8GB 显存建议 auto），auto 交由 accelerate 分配"
    )
    args = parser.parse_args()

    cfg = dict(CONFIGS[args.mode])  # 复制，防止修改原始配置
    if args.base_model: cfg["base_model"]   = args.base_model
    if args.adapter:    cfg["lora_adapter"] = args.adapter
    if args.output:     cfg["output_dir"]   = args.output
    if args.dtype:      cfg["dtype"]        = args.dtype
    if args.device_map: cfg["device_map"]   = args.device_map

    print("=" * 60)
    print(f"  LoRA 权重合并  [模式: {args.mode}]")
    print("=" * 60)
    print(f"  基座模型  : {cfg['base_model']}")
    print(f"  LoRA路径  : {cfg['lora_adapter']}")
    print(f"  输出目录  : {cfg['output_dir']}")
    print(f"  数据类型  : {cfg['dtype']}")
    print()

    check_prerequisites(cfg)
    if args.mode == "deepseek":
        check_deployment_gate(cfg)
    merge_lora(
        base_model   = cfg["base_model"],
        lora_adapter = str(cfg["lora_adapter"]),
        output_dir   = str(cfg["output_dir"]),
        dtype        = cfg["dtype"],
        device_map   = cfg["device_map"],
    )


if __name__ == "__main__":
    main()


