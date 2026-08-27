#!/usr/bin/env python3
"""建议追问索引的构建与校验工具。

背景：前端"建议追问"过去由硬编码池生成，包含大量知识库覆盖不到的问题，
用户点过去必然得到"资料不足"。现在唯一允许的追问来源是
data/knowledge/suggestion_index.json —— 每条问题必须标注来源文档，
并通过本工具校验其关键词确实存在于该文档正文中（证据锚定）。

用法：
    python tools/build_suggestion_index.py                 # 校验现有索引（CI/提交前必跑）
    python tools/build_suggestion_index.py --draft         # 从文档标题生成候选草稿（人工筛选后再入库）
    python tools/build_suggestion_index.py --report        # 校验并输出每条详情

校验规则：
1. 索引为非空列表，条数 ≤ 90；
2. 每条字段齐全：question(8~60字)/sourceDoc/keywords；
3. sourceDoc 必须真实存在于 data/knowledge/；
4. 关键词至少 80% 出现在该文档正文（大小写不敏感），且至少命中 1 个——
   保证建议问题可在对应文档中被高分检索到；
5. 问题文本不得命中超纲黑名单（与 services.llm._SUGGESTION_BLACKLIST_RE 同口径）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX = ROOT / "data" / "knowledge" / "suggestion_index.json"
KNOWLEDGE_DIR = ROOT / "data" / "knowledge"

BLACKLIST_RE = re.compile(
    r"rfid|uuv|全天候|数值(?:模拟|同化|模式)|电化学|老化衰减|碎裂模型"
    r"|光谱[^。]{0,8}(?:定性|定量)|(?:pla|pha)\s*/|(?:低温高盐|缺氧)"
    r"|毒性权重|评分[^。]{0,6}算法|荧光检测法|内分泌干扰|实名制|减塑激励",
    re.I,
)

HEADING_RE = re.compile(r"^#{1,3}\s+(.+)$", re.M)


def load_index(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise SystemExit("索引根节点必须是数组")
    return payload


def doc_contents() -> dict[str, str]:
    contents: dict[str, str] = {}
    for path in KNOWLEDGE_DIR.glob("*.md"):
        try:
            contents[path.name] = path.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"[warn] 无法读取 {path.name}: {exc}")
    return contents


def cmd_draft() -> None:
    """按文档标题产出候选问题草稿；正式入库前必须人工改写并精选关键词。"""
    drafts: list[dict] = []
    for name, content in sorted(doc_contents().items()):
        headings = [h.strip() for h in HEADING_RE.findall(content) if len(h.strip()) >= 4]
        title = headings[0] if headings else Path(name).stem
        tail = re.sub(r"\.(md)$", "", name)
        drafts.append({
            "question": f"{tail}的核心内容是什么？（占位草稿，请人工改写）",
            "sourceDoc": name,
            "keywords": [w.lower() for w in re.findall(r"[\u4e00-\u9fffA-Za-z]{2,8}", title)[:4]],
            "_headings": headings[:8],
        })
    print(json.dumps(drafts, ensure_ascii=False, indent=2))


def cmd_validate(index_path: Path, report: bool) -> int:
    errors: list[str] = []
    entries = load_index(index_path)
    if not entries:
        print("[fail] 索引为空")
        return 1
    if len(entries) > 90:
        errors.append(f"条目过多：{len(entries)} > 90")

    docs = doc_contents()
    seen_questions: set[str] = set()
    valid_entries = 0
    for idx, entry in enumerate(entries):
        tag = f"#{idx}"
        question = str(entry.get("question") or "").strip()
        doc_name = str(entry.get("sourceDoc") or "").strip()
        keywords = [str(k).strip().lower() for k in entry.get("keywords") or [] if str(k).strip()]
        if not (8 <= len(question) <= 60):
            errors.append(f"{tag} 问题长度不合规({len(question)}字)：{question}")
            continue
        if question in seen_questions:
            errors.append(f"{tag} 问题重复：{question}")
            continue
        seen_questions.add(question)
        if BLACKLIST_RE.search(question):
            errors.append(f"{tag} 命中超纲黑名单：{question}")
            continue
        if doc_name not in docs:
            errors.append(f"{tag} sourceDoc 不存在：{doc_name}")
            continue
        if not keywords:
            errors.append(f"{tag} 缺少关键词：{question}")
            continue
        body_lower = docs[doc_name].lower()
        hits = sum(1 for k in keywords if k.lower() in body_lower)
        ratio = hits / len(keywords)
        if hits < 1 or ratio < 0.8:
            missing = [k for k in keywords if k.lower() not in body_lower]
            errors.append(
                f"{tag} 关键词锚定不足({hits}/{len(keywords)}) missing={missing}：{question} -> {doc_name}"
            )
            continue
        valid_entries += 1
        if report:
            print(f"[ok] {tag} {question}  <- {doc_name}")

    print(f"\n校验结果：{valid_entries}/{len(entries)} 条通过")
    if errors:
        for line in errors:
            print("[fail]", line)
        return 1
    print("全部通过 ✔")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draft", action="store_true", help="输出候选草稿（人工筛选用）")
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--report", action="store_true", help="逐条打印校验详情")
    args = parser.parse_args()

    if args.draft:
        cmd_draft()
        return 0
    if not args.index.exists():
        print(f"[fail] 索引文件不存在：{args.index}")
        return 1
    return cmd_validate(args.index, args.report)


if __name__ == "__main__":
    sys.exit(main())
