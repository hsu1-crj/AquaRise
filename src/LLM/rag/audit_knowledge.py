"""知识库静态审计：拦截容易误导模型的绝对化/伪精确表述。"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
KNOWLEDGE = ROOT / "data" / "knowledge"

FORBIDDEN_PATTERNS = [
    (r"平均每人每周摄入约5克|一张信用卡的重量", "微塑料摄入量的流行说法，必须标注为不确定，不能当作事实"),
    (r"逐级放大趋势（生物富集效应）", "不能把所有食物链场景概括为必然逐级放大"),
    (r"计划2024年底前完成谈判", "过时的时间承诺"),
    (r"降解周期.*20-1000年", "单一精确年限会误导，改用环境持留和不确定性"),
]
REQUIRED_PHRASES = {
    "海洋微塑料污染知识.md": ["不能笼统断言", "仍在研究"],
    "海洋垃圾降解周期表.md": ["降解不等于消失", "不要用单一"],
    "MARPOL公约概要.md": ["附则 V", "不替代海事法律意见"],
}

def audit() -> list[str]:
    errors=[]
    for path in sorted(KNOWLEDGE.glob("*.md")):
        text=path.read_text(encoding="utf-8")
        for pattern, why in FORBIDDEN_PATTERNS:
            if re.search(pattern,text): errors.append(f"{path.name}: {why}")
        for phrase in REQUIRED_PHRASES.get(path.name,[]):
            if phrase not in text: errors.append(f"{path.name}: 缺少边界说明：{phrase}")
    return errors

if __name__ == "__main__":
    errors=audit()
    if errors:
        print("知识库审计失败")
        print("\n".join(f"- {e}" for e in errors))
        raise SystemExit(1)
    print(f"知识库静态审计通过：{len(list(KNOWLEDGE.glob('*.md')))} 个 Markdown 文档")
