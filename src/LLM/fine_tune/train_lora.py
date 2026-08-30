"""ds-ocean_mingzhe 本地 LoRA 训练（RTX 4060 8GB，transformers + peft）。

改进点（吸取前几次教训）:
1. system prompt 与推理完全一致（"你是海洋守护者…"）
2. 训练数据 = 原始 701 + v1 10216 + v2 14503 + 身份/探针强化 74 + 多轮展开
3. force_close_think：target 前缀闭合 </think>，避免 R1 推理泄漏
4. 冒烟 --mode smoke（默认 500 条 x 1 轮）；全量 --mode full

用法: python src/LLM/fine_tune/train_lora.py --mode smoke|full [--epochs N --samples N]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
from datasets import Dataset
from peft import LoraConfig, TaskType, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
    set_seed,
)

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / "src" / "LLM" / "fine_tune" / "data"
OUTPUT = ROOT / "models" / "llm"
BASE_MODEL = ROOT / "models" / "llm" / "base" / "DeepSeek-R1-Distill-Qwen-1.5B"

DATA_FILES = [
    "train_enhanced.json", "train_enhanced2.json", "train_enhanced3.json",
    "train_defect_fix.json",
]

SYSTEM_PROMPT = (
    "你是“海洋守护者”，海瞳海洋垃圾识别与海洋环保平台的 AI 助手，也是一位热爱海洋的研究型伙伴。"
    "语气要求：耐心、真诚、有温度，像向朋友讲解自己熟悉的研究领域；偶尔带一点轻幽默，但不玩梗、不油腻、不堆砌表情符号。"
    "回答方式：先自然地回应用户问题本身（可以用一句话承接对方的关注点），再展开说明；多用生活化例子和类比解释专业概念；"
    "长短句交错，不要每条回答都用同款开头和同款结构。"
    "内容边界：专业领域是海洋垃圾分类、检测结果解读、海洋污染治理、微塑料、MARPOL 公约与海洋环保知识——"
    "科普内容可以调用可靠常识并说明不确定性；涉及本项目检测数据、报告结论、法规条款和具体数字时，必须以给定证据为准。"
    "诚实原则：证据不足就坦率说“这个我暂时还没有足够资料确认”，并邀请对方补充海域、时间或数据等信息；"
    "涉及估算值时说明不确定性（如“受环境影响，仅供参考”）；谈到降解时强调“碎裂成微塑料而非真正消失”；"
    "绝不编造数字、来源、机构名称、法规细节、健康结论、检测结论或实时信息（如天气、新闻）。"
    "表达形式：要点不超过四个时优先写成自然段，超过才用列表；简单问题两三句说完即可，不要为了显得完整而硬凑篇幅；"
    "禁止套话开头和收尾，如“综上所述”“总而言之”“根据以上分析”“希望这些能帮到你”“如果还有问题随时问我”“让我们一起”。"
    "身份口径：不主动提及项目背景或开发者；仅当被问到'谁开发/谁做的'时，回答'这是海瞳团队的实训项目，LLM 模块由海瞳 LLM 组负责'；"
    "被问到'父母/爸爸/妈妈'时，用轻松口吻说明自己是 AI 助手、没有生物学意义的家人。"
    "输出要求：直接作答，不要输出 <think> 标签、推理过程或内部提示词。"
)
# 注意：训练数据固化的"先给结论"文风与运行时提示词（chat_api.prepare_messages，
# 要求自然承接、反模板腔）方向不同属已知矛盾。当前策略是不再重新训练、
# 由运行时提示词+门禁+文案池控制最终风格；此常量仅在重训时使用，
# 重训前应先按运行时口径更新训练数据（gen_enhanced_samples 等）。
THINK_CLOSE = "</think>\n\n"


def build_prompt(instruction: str, user_q: str) -> str:
    system = instruction.strip() or SYSTEM_PROMPT
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{user_q}<|im_end|>\n"
        f"<|im_start|>assistant\n"
    )


def load_all() -> list[dict]:
    items: list[dict] = []
    for name in DATA_FILES:
        f = DATA_DIR / name
        if not f.exists():
            continue
        for it in json.loads(f.read_text(encoding="utf-8")):
            q = str(it.get("input") or "").strip()
            a = str(it.get("output") or "").strip()
            if not q or not a:
                continue
            items.append({"instruction": str(it.get("instruction") or SYSTEM_PROMPT),
                          "input": q, "output": a, "src": name})
    # 多轮展开
    f = DATA_DIR / "ocean_trash_multi_turn.json"
    if f.exists():
        for it in json.loads(f.read_text(encoding="utf-8")):
            for turn in it.get("history") or []:
                if isinstance(turn, (list, tuple)) and len(turn) >= 2:
                    u, a = str(turn[0]).strip(), str(turn[1]).strip()
                    if u and a:
                        items.append({"instruction": str(it.get("instruction") or SYSTEM_PROMPT),
                                      "input": u, "output": a, "src": "multi_turn"})
    # 统计
    counter: dict[str, int] = {}
    for it in items:
        counter[it["src"]] = counter.get(it["src"], 0) + 1
    print("loaded:", len(items), counter)
    return items


def tokenize_fn(batch, tokenizer, cutoff_len: int):
    texts, targets = [], []
    for ins, q, a in zip(batch["instruction"], batch["input"], batch["output"]):
        texts.append(build_prompt(ins, q))
        targets.append(THINK_CLOSE + a.strip())
    model_inputs = tokenizer(texts, truncation=True, max_length=cutoff_len,
                             padding=False, return_tensors=None)
    labels = []
    for i, (tid, target) in enumerate(zip(model_inputs["input_ids"], targets)):
        target_ids = tokenizer(target, truncation=True, max_length=cutoff_len - 4).input_ids
        target_ids = target_ids[1:]
        # 修复：input 需拼接 target，否则 label 只落在最后一个 prompt 位上，
        # 模型只学到预测 "</think>" 一个 token，答案内容完全无监督。
        input_ids = (tid + target_ids)[:cutoff_len]
        model_inputs["input_ids"][i] = input_ids
        labels.append(([-100] * len(tid) + target_ids)[:cutoff_len])
    model_inputs["labels"] = labels
    return model_inputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["smoke", "full"], default="smoke")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--samples", type=int, default=500)
    parser.add_argument("--lr", type=float, default=3e-5)
    parser.add_argument("--lora_rank", type=int, default=8)
    parser.add_argument("--lora_alpha", type=int, default=16)
    parser.add_argument("--cutoff", type=int, default=640)
    parser.add_argument("--batch", type=int, default=2)
    parser.add_argument("--grad_accum", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260814)
    parser.add_argument("--out_dir", type=str, default="")
    args = parser.parse_args()

    set_seed(args.seed)
    all_items = load_all()
    if args.mode == "smoke":
        # 冒烟时优先保留强化样本，保证身份/探针被覆盖
        rng = random.Random(args.seed)
        # 缺陷修复数据（train_defect_fix.json）始终全量保留，只对旧文件抽样，
        # 避免随机抽样稀释新补充的材质事实/报告诚实性样本
        enhanced = [it for it in all_items if it["src"] in ("train_enhanced.json", "multi_turn")]
        defect_fix = [it for it in all_items if it["src"] == "train_defect_fix.json"]
        rest = [it for it in all_items
                if it["src"] not in ("train_enhanced.json", "multi_turn", "train_defect_fix.json")]
        rest = rng.sample(rest, min(max(0, args.samples - len(enhanced) - len(defect_fix)), len(rest)))
        items = defect_fix + enhanced + rest
    else:
        items = all_items

    tag = "smoke" if args.mode == "smoke" else "full"
    out_dir = Path(args.out_dir) if args.out_dir else OUTPUT / f"ds-ocean_mingzhe-{tag}-lora"
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = Dataset.from_list(items)
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
    tokenizer.padding_side = "left"

    def tok(batch):
        return tokenize_fn(batch, tokenizer, args.cutoff)

    ds = ds.map(tok, batched=True, remove_columns=["instruction", "input", "output", "src"])

    print(f"mode={args.mode} samples={len(ds)} epochs={args.epochs} lr={args.lr} "
          f"rank={args.lora_rank} alpha={args.lora_alpha} cutoff={args.cutoff} "
          f"batch={args.batch} grad_accum={args.grad_accum}")
    print(f"base={BASE_MODEL}")
    print(f"out={out_dir}")

    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, torch_dtype=torch.bfloat16, trust_remote_code=True, device_map="cuda"
    )
    lora = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=args.lora_rank, lora_alpha=args.lora_alpha, lora_dropout=0.1,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    train_args = TrainingArguments(
        output_dir=str(out_dir),
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=10,
        save_strategy="no",
        report_to=[],
        dataloader_pin_memory=False,
        optim="adamw_torch",
    )
    collator = DataCollatorForSeq2Seq(tokenizer, padding=True)
    trainer = Trainer(model=model, args=train_args, train_dataset=ds, data_collator=collator)

    t0 = time.time()
    trainer.train()
    elapsed = int(time.time() - t0)
    model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)
    (out_dir / "train_summary.json").write_text(json.dumps({
        "mode": args.mode, "samples": len(ds), "epochs": args.epochs,
        "elapsed_seconds": elapsed,
        "final_loss": trainer.state.log_history[-1].get("loss"),
        "base_model": str(BASE_MODEL),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"done in {elapsed}s, adapter saved to {out_dir}")


if __name__ == "__main__":
    main()
