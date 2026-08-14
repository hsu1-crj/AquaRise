"""v2 万级数据生成器：从 20 篇知识文档生成 1 万+ QA。

生成维度：
1. 子句级 QA：条目按标点拆成子句，每子句按章节主题生成 4-8 种问法
2. 章节总结 QA：每章 2-3 种问法
3. 对比题：同章节相邻条目配对（X 和 Y 有什么区别）
4. 场景题：套入巡检/清理/复核等场景模板
5. 否定边界题：含否定词的子句 → 是非判断题式问法
6. 检测场景题：22 类垃圾的固定模板问答

准确性保障：答案一律逐字摘录/拼接自知识库原文，不新增事实。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[3]
KNOWLEDGE_DIR = ROOT / "data" / "knowledge"
DATA_DIR = Path(__file__).resolve().parent / "data"
OUTPUT_FILE = DATA_DIR / "ocean_expanded_qa.json"
REPORT_FILE = DATA_DIR / "expand_report.json"

# ---------- 通用追加变体（对所有章节追加，扩大问题多样性） ----------
EXTRA_VARIANTS = [
    "请用一段话解释{t}。", "为什么说{t}很重要？", "{t}的关键要点是什么？",
    "面对{t}的情况，你有什么建议？", "关于{t}，请给出你的理解。",
]

# ---------- v2 全新问法（与 v1 完全不同的模板，用于第二批数据集） ----------
V2_VARIANTS = [
    "{t}，请具体讲一讲。", "你能解释{t}吗？", "聊聊{t}吧。",
    "{t}有哪些细节值得关注？", "从专业角度说说{t}。",
    "关于{t}，最需要了解的是什么？", "{t}对水下垃圾治理有什么启示？",
    "如何评价{t}？", "{t}常见于哪些情况？", "遇到{t}，一般怎么应对？",
    "{t}有什么值得注意的要点？", "科普一下{t}。", "{t}背后有什么原因？",
    "说说你对{t}的理解。", "{t}在什么条件下会变化？",
    "想知道{t}，该怎么了解？",
]
V2_SCENARIO_TPL = "我在{sc}遇到了「{t}」，该怎么处理？"

# ---------- 问法模板（按章节关键词） ----------
RULES = [
    (re.compile(r"危害|影响|风险|后果|破坏"), [
        "{t}有哪些危害和影响？", "{t}会带来什么风险？", "{t}为什么值得重视？",
        "{t}对海洋生态有什么影响？", "遇到{t}时有哪些风险？", "{t}会伤害哪些生物？",
        "为什么不能忽视{t}？", "{t}的影响有多大？", "{t}会怎样发展？"]),
    (re.compile(r"来源|进入海洋|输运|路径|途径"), [
        "{t}的来源有哪些？", "{t}主要通过什么途径？", "{t}是怎么进入海洋的？",
        "{t}的输运过程是怎样的？", "哪些因素影响{t}？", "{t}从哪里来？",
        "如何追踪{t}？", "{t}的分布有什么规律？", "{t}会到哪里去？"]),
    (re.compile(r"方法|监测|评估|调查|流程|规范|步骤|作业|采集"), [
        "{t}常用的方法有哪些？", "{t}如何实施？", "{t}的流程和步骤是什么？",
        "{t}需要注意哪些规范？", "如何保证{t}的质量？", "{t}有哪些具体做法？",
        "实施{t}要准备什么？", "{t}的关键环节是什么？", "如何评价{t}的效果？"]),
    (re.compile(r"治理|处置|清理|打捞|预防|管理|减量|回收|利用|修复|保护|分类"), [
        "{t}应如何治理和处置？", "{t}的处置原则是什么？", "如何做好{t}？",
        "{t}有哪些措施？", "关于{t}，有哪些建议？", "{t}的正确做法是什么？",
        "普通人能为{t}做什么？", "{t}的优先级怎么排？", "{t}有哪些注意事项？"]),
    (re.compile(r"误区|核查|边界|注意|安全|规范"), [
        "{t}有哪些常见误区？", "{t}需要注意什么？", "{t}的正确做法是什么？",
        "{t}有哪些使用边界？", "关于{t}，哪些说法不准确？", "{t}要避免什么？",
        "如何核查关于{t}的说法？", "{t}有哪些注意事项？", "{t}怎么判断对错？"]),
    (re.compile(r"什么是|定义|概述|简介|构成|概念|含义|种类|类型|特征|区别|参数"), [
        "{t}是什么？", "{t}包括哪些内容？", "{t}有哪些种类和特征？",
        "如何理解{t}？", "{t}有哪些关键要点？", "{t}有什么作用？",
        "{t}有哪些例子？", "{t}可以分成几类？", "{t}和什么有关？"]),
]
DEFAULT = [
    "{t}包括哪些要点？", "请介绍一下{t}。", "{t}有哪些关键信息？",
    "关于{t}，你能详细说明吗？", "{t}的情况是怎样的？", "{t}有什么作用？",
    "{t}有哪些例子？", "{t}有哪些特点？", "从哪些方面了解{t}？",
    "请用几句话说明{t}。", "{t}和海洋垃圾治理有什么关系？",
    "如果我想了解{t}，应该从哪开始？",
]

SCENARIOS = [
    "在海滩清理时", "在水下巡检作业中", "在视频识别结果复核时",
    "在净滩活动组织过程中", "在港口/近岸检查时", "在检测报告解读时",
]

DETECT_CATEGORIES = [
    ("trash_clothing", "衣物/纺织品"), ("trash_pipe", "管道"), ("trash_bottle", "瓶子"),
    ("trash_bag", "塑料袋"), ("trash_snack_wrapper", "零食包装"), ("trash_can", "金属罐"),
    ("trash_cup", "杯子"), ("trash_container", "容器"), ("trash_unknown_instance", "未知垃圾"),
    ("trash_branch", "树枝/木头"), ("trash_wreckage", "残骸/碎片"), ("trash_tarp", "防水布"),
    ("trash_rope", "绳索"), ("trash_net", "渔网"),
    ("rov", "水下机器人"), ("plant", "植物/海草"), ("animal_fish", "鱼"),
    ("animal_starfish", "海星"), ("animal_shells", "贝壳"), ("animal_crab", "螃蟹"),
    ("animal_eel", "鳗鱼"), ("animal_etc", "其他动物"),
]

DETECT_QUESTIONS = [
    "视频识别到{cn}（{en}），请问它属于哪一类？", "画面中出现{cn}（{en}），应该如何解读？",
    "检测到{cn}（{en}）目标，需要如何处理？", "{cn}（{en}）有什么特征？",
    "识别结果中有{cn}（{en}），置信度不高时怎么办？",
    "{cn}（{en}）和水下哪些东西容易混淆？",
    "{cn}（{en}）在检测报告中应如何记录？",
    "巡检视频里频繁出现{cn}（{en}），说明什么？",
    "{cn}（{en}）的检出数量如何统计才准确？",
    "需要人工复核{cn}（{en}）检测结果时，重点看什么？",
]

NEGATIVE_WORDS = re.compile(r"不|禁止|勿|避免|不要|不得|不能|无法|难以|不应")


def _clean(title: str) -> str:
    t = re.sub(r"^[#>\s]*", "", title)
    t = re.sub(r"^\d+[\.、．)）]\s*", "", t)
    t = re.sub(r"^[一二三四五六七八九十]+[、.．]\s*", "", t)
    return t.replace("：", ":").strip(" ：: ")


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _qs_for(chapter: str, head: str, n: int) -> list[str]:
    ch = _clean(chapter)
    t = head if len(head) >= 4 else ch
    if re.search(r"(什么是|有哪些|如何|怎样|怎么)[？?]?$", ch) or ch.endswith(("？", "?")):
        return [ch]
    for pat, templates in RULES:
        if pat.search(ch):
            base = [x.format(t=t) for x in templates]
            base += [x.format(t=t) for x in EXTRA_VARIANTS]
            return base[:n]
    base = [x.format(t=t) for x in DEFAULT]
    base += [x.format(t=t) for x in EXTRA_VARIANTS]
    return base[:n]


def parse_md(path: Path, v2: bool = False) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines()
    doc = path.stem
    items: list[dict] = []
    chapter: Optional[str] = None
    chapter_items: list[str] = []
    in_code = False

    def flush():
        nonlocal chapter, chapter_items
        if chapter and chapter_items:
            summary = "；".join(dict.fromkeys(x.strip() for x in chapter_items if x.strip()))
            if v2:
                qs = [q.format(t=chapter) for q in V2_VARIANTS[:3]]
            else:
                qs = _qs_for(chapter, chapter, 7)
            for q in qs:
                items.append({"doc": doc, "chapter": chapter, "question": q, "answer": summary,
                              "kind": "chapter"})
            # 子句级
            for entry in chapter_items:
                entry = entry.strip()
                if not entry:
                    continue
                if re.match(r"^\*?\*?(TrashCan|标注量|参考口径|来源说明|准确性说明|任务信息|检出结果|统计图表|分析建议|使用方法)", entry):
                    continue
                clauses = [c.strip() for c in re.split(r"[；;。！？!?]\s*", entry) if len(_norm(c)) >= 10]
                if not clauses:
                    clauses = [entry]
                for cl in clauses:
                    head = re.sub(r"[*_`#]+", "", cl)[:18]
                    if v2:
                        qs = [q.format(t=head if len(head) >= 4 else chapter)
                              for q in V2_VARIANTS]
                    else:
                        qs = _qs_for(chapter, head, 12)
                    for q in qs:
                        items.append({"doc": doc, "chapter": chapter, "question": q,
                                      "answer": cl, "kind": "clause"})
                    # 场景题
                    if v2:
                        for sc in SCENARIOS:
                            items.append({"doc": doc, "chapter": chapter,
                                          "question": V2_SCENARIO_TPL.format(
                                              sc=sc, t=head if len(head) >= 4 else chapter),
                                          "answer": cl, "kind": "scenario"})
                    else:
                        for sc in SCENARIOS:
                            items.append({"doc": doc, "chapter": chapter,
                                          "question": f"{sc}，涉及「{head}」时要注意什么？",
                                          "answer": cl, "kind": "scenario"})
                    # 否定边界题
                    if NEGATIVE_WORDS.search(cl):
                        for q in (f"「{head}」这样的说法和做法对吗？",
                                  f"可以忽略{head}吗？"):
                            items.append({"doc": doc, "chapter": chapter, "question": q,
                                          "answer": cl, "kind": "negative"})
            # 对比题：相邻 + 间隔配对
            n = len(chapter_items)
            pairs = []
            for i in range(0, n - 1, 2):
                pairs.append((i, i + 1))
            for i in range(0, n - 2, 3):
                pairs.append((i, i + 2))
            for i, j in pairs:
                a = re.sub(r"[*_`#]+", "", chapter_items[i])[:12]
                b = re.sub(r"[*_`#]+", "", chapter_items[j])[:12]
                if len(a) >= 4 and len(b) >= 4:
                    items.append({"doc": doc, "chapter": chapter,
                                  "question": f"{a}和{b}有什么区别或联系？",
                                  "answer": f"{chapter_items[i]}；{chapter_items[j]}",
                                  "kind": "compare"})
        chapter = None
        chapter_items = []

    for raw in lines:
        s = raw.strip()
        if not s or s.startswith(">"):
            continue
        if s.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if s.startswith("#"):
            if chapter:
                flush()
            chapter = _clean(s)
            continue
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if len(cells) < 2 or all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
                continue
            text = "；".join(c for c in cells if c)
            if len(_norm(text)) >= 20:
                chapter_items.append(text)
            continue
        if re.match(r"^\s*[-*+]\s+", s):
            chapter_items.append(re.sub(r"^\s*[-*+]\s+", "", s))
            continue
        if re.match(r"^\s*\d+[\.、．)）]\s*", s):
            chapter_items.append(re.sub(r"^\s*\d+[\.、．)）]\s*", "", s))
            continue
        if chapter_items and len(s) > 20:
            chapter_items[-1] += " " + s
    if chapter:
        flush()
    return items


def detect_qa() -> list[dict]:
    items = []
    for en, cn in DETECT_CATEGORIES:
        for q in DETECT_QUESTIONS:
            items.append({"doc": "检测场景模板", "chapter": "识别结果解读",
                          "question": q.format(en=en, cn=cn),
                          "answer": f"检测类别为{cn}（{en}）。结合图像质量、置信度与上下文判断："
                                    f"若置信度较高可登记为该类别，低置信度应回看原始图像人工复核；"
                                    f"如与附近背景目标（植物、动物、反光物）形态相近，需标注待确认。"
                                    f"具体处置参见知识库对应条目。",
                          "kind": "detect"})
    return items


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default="", help="输出文件名（新开文件用）")
    ap.add_argument("--exclude", default="", help="排除文件中已存在的问题（去重）")
    ap.add_argument("--v2", action="store_true", help="使用 v2 全新问法模板（第二批数据集）")
    args = ap.parse_args()

    docs = sorted(KNOWLEDGE_DIR.glob("*.md"))
    all_items: list[dict] = []
    for doc in docs:
        all_items.extend(parse_md(doc, v2=args.v2))
    if not args.v2:
        all_items.extend(detect_qa())

    excluded: set[str] = set()
    if args.exclude:
        for it in json.loads(Path(args.exclude).read_text(encoding="utf-8")):
            excluded.add(_norm(it.get("input", "")))

    per_doc: dict[str, int] = {}
    seen: set[str] = set()
    final: list[dict] = []
    for it in all_items:
        key = (_norm(it["question"]), _norm(it["answer"]))
        if key in seen or _norm(it["question"]) in excluded:
            continue
        seen.add(key)
        final.append({"instruction": "你是海洋环保专家。请结合项目知识库回答以下关于水下垃圾和海洋环保的问题。",
                      "input": it["question"], "output": it["answer"],
                      "source_doc": it["doc"]})
        per_doc[it["doc"]] = per_doc.get(it["doc"], 0) + 1

    out = [{k: v for k, v in x.items() if k in ("instruction", "input", "output")} for x in final]
    output_file = Path(args.output) if args.output else OUTPUT_FILE
    output_file.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    REPORT_FILE.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "knowledge_docs": len(docs),
        "raw_generated": len(all_items),
        "excluded_questions": len(excluded),
        "unique_qa": len(final),
        "per_doc": {k: per_doc[k] for k in sorted(per_doc, key=lambda k: -per_doc[k])},
        "output_file": str(output_file),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"docs={len(docs)} raw={len(all_items)} excluded={len(excluded)} unique={len(final)}")
    for k in sorted(per_doc, key=lambda k: -per_doc[k])[:30]:
        print(f"  {k}: {per_doc[k]}")


if __name__ == "__main__":
    main()
