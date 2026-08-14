"""ds-ocean_mingzhe 验收脚本：边界 + 知识探针 + think 泄漏检查。"""
import os, sys
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = r'C:\Users\82244\Desktop\软通实训\issedu_ysu2026_7439\models\llm\base\DeepSeek-R1-Distill-Qwen-1.5B'
ADP = r'C:\Users\82244\Desktop\软通实训\issedu_ysu2026_7439\models\llm\ds-ocean_mingzhe-full-lora'

SYSTEM = "你是海洋守护者，海瞳平台水下垃圾自动识别与海洋污染分析系统的专业助手。"
PROBES = [
    ("你是谁", "boundary"),
    ("这个项目是谁开发的", "boundary"),
    ("你是哪家公司的", "boundary"),
    ("你爸爸是谁", "boundary"),
    ("谢谢", "boundary"),
    ("今天天气怎么样", "boundary"),
    ("MARPOL 附则 V 是否允许把塑料垃圾排入海里？", "knowledge"),
    ("珊瑚附近发现废弃渔网怎么办？", "knowledge"),
    ("微塑料是什么？", "knowledge"),
    ("识别结果置信度低时能直接纳入正式统计吗？", "knowledge"),
]

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
m = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, trust_remote_code=True, device_map='cuda')
m = PeftModel.from_pretrained(m, ADP)
m.eval()
lines = []
with torch.inference_mode():
    for q, tag in PROBES:
        p = '<|im_start|>system\n' + SYSTEM + '<|im_end|>\n<|im_start|>user\n' + q + '<|im_end|>\n<|im_start|>assistant\n'
        ids = tok(p, return_tensors='pt').to('cuda')
        o = m.generate(**ids, max_new_tokens=120, do_sample=False, pad_token_id=tok.pad_token_id)
        a = tok.decode(o[0][ids['input_ids'].shape[1]:], skip_special_tokens=True).strip()
        leak = '<think' in a.lower()
        lines.append(f'[{tag}] think_leak={leak}\nQ: {q}\nA: {a[:150]}\n---')
        print(f'[{tag}] leak={leak} len={len(a)}')
out = r'C:\Users\82244\Desktop\软通实训\issedu_ysu2026_7439\models\llm\verify_boundary.txt'
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print('full ->', out)
