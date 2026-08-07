"""
LoRA 微调训练脚本（独立可运行，不依赖 llamafactory-cli）

支持:
- 本机 CPU 训练（Qwen2-0.5B，约30-60分钟）
- 云 GPU 训练（Qwen2-7B，需≥16GB显存）

用法:
    # 本机 CPU 快速训练（Qwen2-0.5B）
    python src/LLM/fine_tune/train_lora.py --mode local

    # 云 GPU 训练（Qwen2-7B）
    python src/LLM/fine_tune/train_lora.py --mode cloud

    # 自定义参数
    python src/LLM/fine_tune/train_lora.py --model Qwen/Qwen2-1.5B-Instruct --epochs 5 --batch_size 2
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import torch
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
    Trainer,
    DataCollatorForSeq2Seq,
)
from peft import LoraConfig, get_peft_model, TaskType
from datasets import Dataset

# 解决 OpenMP 重复加载（anaconda 常见问题）
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# ============================================================
# 路径与默认配置
# ============================================================
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUTPUT_DIR = BASE_DIR.parent.parent.parent / "models" / "llm" / "ocean-lora"

# 训练模式预设
MODE_PROFILES = {
    "local": {
        # 本机 CPU 训练：Qwen2-0.5B，小 batch，短训练
        "model_name": "Qwen/Qwen2-0.5B-Instruct",
        "epochs": 3,
        "batch_size": 2,
        "grad_accum": 8,  # 等效 batch_size=16
        "lr": 5e-5,
        "cutoff_len": 1024,  # CPU 下缩短以加速
        "use_fp16": False,
        "use_bf16": False,
    },
    "cloud": {
        # 云 GPU 训练：Qwen2-7B，标准参数
        "model_name": "Qwen/Qwen2-7B-Instruct",
        "epochs": 3,
        "batch_size": 4,
        "grad_accum": 4,  # 等效 batch_size=16
        "lr": 5e-5,
        "cutoff_len": 2048,
        "use_fp16": True,
        "use_bf16": False,
    },
}


# ============================================================
# 数据加载与格式化
# ============================================================
SYSTEM_PROMPT = (
    "你是'海洋守护者'，一个专注于水下垃圾识别、海洋污染分析和环保教育的AI助手。"
    "请用专业、准确、积极鼓励的语气回答用户问题。"
    "如果不确定的信息要明确说明，不编造虚假数据。"
)


def load_datasets():
    """加载所有微调数据集并合并"""
    all_samples = []
    files = [
        "ocean_trash_qa.json",
        "ocean_knowledge_qa.json",
        "ocean_trash_recognition_qa.json",
    ]

    for fname in files:
        fpath = DATA_DIR / fname
        if not fpath.exists():
            print(f"[WARN] 数据集不存在，跳过: {fpath}")
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            data = json.load(f)
        for item in data:
            # alpaca 格式: instruction + input + output
            instruction = item.get("instruction", "").strip()
            user_input = item.get("input", "").strip()
            output = item.get("output", "").strip()
            if not output:
                continue

            # 拼接 instruction + input 作为用户输入
            user_text = instruction
            if user_input:
                user_text = f"{instruction}\n{user_input}" if instruction else user_input

            all_samples.append({
                "system": SYSTEM_PROMPT,
                "user": user_text,
                "assistant": output,
            })
        print(f"[INFO] 加载 {fname}: {len(data)} 条")

    # 加载多轮对话数据集（history 字段）
    multi_path = DATA_DIR / "ocean_trash_multi_turn.json"
    if multi_path.exists():
        with open(multi_path, "r", encoding="utf-8") as f:
            multi_data = json.load(f)
        for item in multi_data:
            history = item.get("history", [])
            if not history:
                continue
            # 多轮对话按每轮拆分为独立样本（简化训练）
            for user_msg, ai_msg in history:
                if user_msg.strip() and ai_msg.strip():
                    all_samples.append({
                        "system": SYSTEM_PROMPT,
                        "user": user_msg.strip(),
                        "assistant": ai_msg.strip(),
                    })
        print(f"[INFO] 加载 ocean_trash_multi_turn.json: {len(multi_data)} 段对话")

    print(f"[INFO] 数据集合并完成，总计 {len(all_samples)} 条训练样本")
    return all_samples


def format_to_messages(sample):
    """将样本转换为 Qwen ChatML 格式的 messages"""
    return {
        "messages": [
            {"role": "system", "content": sample["system"]},
            {"role": "user", "content": sample["user"]},
            {"role": "assistant", "content": sample["assistant"]},
        ]
    }


def tokenize_messages(messages, tokenizer, max_len):
    """对 messages 进行 tokenization，构造 input_ids 和 labels"""
    # 使用 tokenizer.apply_chat_template 自动添加特殊token
    full_text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    # 截断
    full_ids = tokenizer(
        full_text,
        truncation=True,
        max_length=max_len,
        return_tensors=None,
    )["input_ids"]

    # 构造 labels：仅对 assistant 部分计算 loss
    # 简化做法：先对 system+user 部分 tokenization，长度之前的 labels 设为 -100
    prefix_messages = messages[:-1]  # system + user
    prefix_text = tokenizer.apply_chat_template(
        prefix_messages, tokenize=False, add_generation_prompt=True
    )
    prefix_ids = tokenizer(
        prefix_text, truncation=True, max_length=max_len, return_tensors=None
    )["input_ids"]
    prefix_len = len(prefix_ids)

    labels = [-100] * prefix_len + full_ids[prefix_len:]
    # 对齐长度
    labels = labels[: len(full_ids)]

    return {
        "input_ids": full_ids,
        "attention_mask": [1] * len(full_ids),
        "labels": labels,
    }


# ============================================================
# 训练主流程
# ============================================================
def train(args):
    profile = MODE_PROFILES[args.mode]
    model_name = args.model or profile["model_name"]
    epochs = args.epochs or profile["epochs"]
    batch_size = args.batch_size or profile["batch_size"]
    grad_accum = args.grad_accum or profile["grad_accum"]
    lr = args.lr or profile["lr"]
    cutoff_len = args.cutoff_len or profile["cutoff_len"]
    use_fp16 = profile["use_fp16"] and torch.cuda.is_available()
    use_bf16 = profile["use_bf16"] and torch.cuda.is_available()

    print("=" * 60)
    print("海洋守护者 LoRA 微调训练")
    print("=" * 60)
    print(f"模式: {args.mode}")
    print(f"基座模型: {model_name}")
    print(f"设备: {'cuda' if torch.cuda.is_available() else 'cpu'}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"显存: {torch.cuda.get_device_properties(0).total_memory/1024**3:.2f} GB")
    print(f"训练轮数: {epochs}")
    print(f"批次大小: {batch_size} × {grad_accum} (等效 {batch_size*grad_accum})")
    print(f"学习率: {lr}")
    print(f"截断长度: {cutoff_len}")
    print(f"FP16: {use_fp16} / BF16: {use_bf16}")
    print(f"输出目录: {args.output_dir}")
    print("=" * 60)

    # 1. 加载数据
    samples = load_datasets()
    if len(samples) == 0:
        print("[ERROR] 没有训练数据，终止")
        sys.exit(1)

    # 2. 加载 tokenizer 和模型
    print("\n[1/5] 加载 tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(
        model_name, trust_remote_code=True, use_fast=True
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print("\n[2/5] 加载基座模型...")
    dtype = torch.float32
    if use_fp16:
        dtype = torch.float16
    elif use_bf16:
        dtype = torch.bfloat16

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        trust_remote_code=True,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    model.config.use_cache = False
    if not torch.cuda.is_available():
        model = model.to("cpu")

    # 3. 应用 LoRA
    print("\n[3/5] 应用 LoRA 配置...")
    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.1,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # 4. 数据预处理
    print("\n[4/5] 数据 tokenization...")
    raw_ds = Dataset.from_list([format_to_messages(s) for s in samples])

    def tokenize_fn(ex):
        return tokenize_messages(ex["messages"], tokenizer, cutoff_len)

    tokenized_ds = raw_ds.map(
        tokenize_fn,
        batched=False,
        remove_columns=["messages"],
        desc="Tokenizing",
    )

    data_collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        padding=True,
        return_tensors="pt",
    )

    # 5. 训练
    print("\n[5/5] 启动训练...")
    training_args = TrainingArguments(
        output_dir=str(args.output_dir),
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        logging_steps=10,
        save_steps=200,
        save_total_limit=3,
        fp16=use_fp16,
        bf16=use_bf16,
        report_to="none",
        save_strategy="steps",
        dataloader_num_workers=0,  # Windows 兼容
        remove_unused_columns=False,
        gradient_checkpointing=False,  # 0.5B 不需要
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_ds,
        data_collator=data_collator,
    )

    start_time = time.time()
    train_result = trainer.train()
    elapsed = time.time() - start_time

    # 保存
    print(f"\n[INFO] 训练完成，耗时 {elapsed/60:.2f} 分钟")
    print(f"[INFO] 训练损失: {train_result.training_loss:.4f}")
    print(f"[INFO] 保存 LoRA 权重到 {args.output_dir}")
    trainer.save_model(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    # 保存训练日志
    log_path = args.output_dir / "train_log.json"
    log_data = {
        "mode": args.mode,
        "model": model_name,
        "samples": len(samples),
        "epochs": epochs,
        "batch_size": batch_size,
        "grad_accum": grad_accum,
        "lr": lr,
        "cutoff_len": cutoff_len,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "train_loss": train_result.training_loss,
        "elapsed_minutes": round(elapsed / 60, 2),
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log_data, f, ensure_ascii=False, indent=2)
    print(f"[INFO] 训练日志保存到 {log_path}")

    return train_result.training_loss


# ============================================================
# 评估生成
# ============================================================
def evaluate(args):
    """加载微调后的模型，生成样例回答用于人工评估"""
    from peft import PeftModel

    profile = MODE_PROFILES[args.mode]
    model_name = args.model or profile["model_name"]

    print("\n" + "=" * 60)
    print("微调效果评估 - 生成样例")
    print("=" * 60)

    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    base_model = AutoModelForCausalLM.from_pretrained(
        model_name,
        trust_remote_code=True,
        torch_dtype=torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    model = PeftModel.from_pretrained(base_model, str(args.output_dir))
    model.eval()

    test_questions = [
        "塑料袋在水下多久能降解？",
        "幽灵渔网对海洋生态有什么危害？",
        "MARPOL公约附则V的主要内容是什么？",
        "如何提高YOLO对水下塑料瓶的检测精度？",
        "普通人能为减少海洋塑料污染做什么？",
    ]

    results = []
    for q in test_questions:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": q},
        ]
        text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = tokenizer(text, return_tensors="pt")
        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=512,
                temperature=0.7,
                top_p=0.9,
                do_sample=True,
                pad_token_id=tokenizer.pad_token_id,
            )
        response = tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        )
        print(f"\n[Q] {q}")
        print(f"[A] {response}")
        results.append({"question": q, "answer": response})

    # 保存评估结果
    eval_path = args.output_dir / "eval_samples.json"
    with open(eval_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n[INFO] 评估样例保存到 {eval_path}")


# ============================================================
# 入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="海洋守护者 LoRA 微调训练")
    parser.add_argument(
        "--mode",
        choices=["local", "cloud"],
        default="local",
        help="训练模式: local=本机CPU(Qwen2-0.5B), cloud=云GPU(Qwen2-7B)",
    )
    parser.add_argument("--model", type=str, default=None, help="覆盖基座模型名")
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--batch_size", type=int, default=None)
    parser.add_argument("--grad_accum", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--cutoff_len", type=int, default=None)
    parser.add_argument("--lora_rank", type=int, default=8)
    parser.add_argument("--lora_alpha", type=int, default=16)
    parser.add_argument(
        "--output_dir",
        type=Path,
        default=OUTPUT_DIR,
        help=f"输出目录 (默认: {OUTPUT_DIR})",
    )
    parser.add_argument(
        "--eval_only",
        action="store_true",
        help="仅做评估（加载已训练的LoRA权重生成样例）",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    if args.eval_only:
        evaluate(args)
    else:
        train(args)
        # 训练完自动跑评估
        try:
            evaluate(args)
        except Exception as e:
            print(f"[WARN] 评估阶段失败: {e}")


if __name__ == "__main__":
    main()
