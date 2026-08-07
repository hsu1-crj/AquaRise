#!/usr/bin/env python3
"""
RAG 知识库构建与验证脚本

功能:
  1. 加载 data/knowledge/ 的 .md 文档
  2. 文档分块 + BAAI/bge-small-zh-v1.5 向量化
  3. 持久化到 data/chroma_db/
  4. 执行验证查询，确认检索正常

用法:
  python src/LLM/rag/build_knowledge_base.py
  python src/LLM/rag/build_knowledge_base.py --rebuild   # 强制重建
  python src/LLM/rag/build_knowledge_base.py --query "塑料袋在水下多久降解"
"""

import os
import sys
import argparse
from pathlib import Path

# 防止 OpenMP 多副本警告
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

# 验证查询列表（用于构建后自动验证）
VERIFY_QUERIES = [
    "塑料袋在水下多久能降解",
    "MARPOL 公约对船舶废弃物的规定",
    "微塑料对海洋生物的危害",
    "海洋垃圾治理技术有哪些",
    "蓝碳是什么",
]


def build(force_rebuild: bool = False) -> "OceanKnowledgeBase":
    """构建或加载向量知识库"""
    from src.LLM.rag.knowledge_base import OceanKnowledgeBase

    knowledge_dir = ROOT / "data" / "knowledge"
    persist_dir   = ROOT / "data" / "chroma_db"

    print("=" * 60)
    print("  RAG 知识库构建")
    print("=" * 60)
    print(f"  知识文档目录: {knowledge_dir}")
    print(f"  向量库目录  : {persist_dir}")
    print(f"  强制重建    : {force_rebuild}")
    print()

    # 列出知识文档
    docs = list(knowledge_dir.glob("*.md")) + list(knowledge_dir.glob("*.txt")) + list(knowledge_dir.glob("*.pdf"))
    if not docs:
        raise FileNotFoundError(f"知识文档目录为空: {knowledge_dir}")
    print(f"发现 {len(docs)} 个知识文档:")
    for d in sorted(docs):
        size_kb = d.stat().st_size / 1024
        print(f"  - {d.name}  ({size_kb:.1f} KB)")
    print()

    kb = OceanKnowledgeBase(
        knowledge_dir=str(knowledge_dir),
        persist_dir=str(persist_dir),
    )

    # 如果需要重建，删除已有向量库
    if force_rebuild and persist_dir.exists():
        import shutil
        shutil.rmtree(persist_dir)
        print("已删除旧向量库，准备重建...\n")

    kb.build(force_rebuild=force_rebuild)
    return kb


def verify(kb, queries: list[str] | None = None) -> bool:
    """验证知识库检索功能"""
    from src.LLM.rag.retriever import OceanRetriever

    queries = queries or VERIFY_QUERIES
    retriever = OceanRetriever(kb)

    print("\n" + "=" * 60)
    print("  知识库检索验证")
    print("=" * 60)

    all_passed = True
    for i, query in enumerate(queries, 1):
        results = retriever.search(query, k=2)
        status = "✅" if results else "❌"
        print(f"\n[{i}] {status} 查询: {query}")
        if results:
            snippet = results[0]["content"][:80].replace("\n", " ")
            source  = Path(results[0]["metadata"].get("source", "未知")).name
            print(f"     命中: [{source}] {snippet}...")
        else:
            print("     ⚠ 未找到相关文档，请检查知识库内容")
            all_passed = False

    return all_passed


def main():
    parser = argparse.ArgumentParser(description="RAG 知识库构建与验证")
    parser.add_argument("--rebuild", action="store_true", help="强制重建向量库")
    parser.add_argument("--query",   help="单独执行一条查询（不重建）")
    args = parser.parse_args()

    if args.query:
        # 仅执行检索验证
        kb = build(force_rebuild=False)
        verify(kb, queries=[args.query])
        return

    # 完整构建 + 验证流程
    kb = build(force_rebuild=args.rebuild)
    passed = verify(kb)

    print("\n" + "=" * 60)
    if passed:
        print("  ✅ RAG 知识库构建并验证成功")
        print(f"     向量库位置: {ROOT / 'data' / 'chroma_db'}")
        print("     可通过 enable_rag=true 在对话 API 中启用检索增强")
    else:
        print("  ⚠ 部分查询未返回结果，请检查知识文档格式")
    print("=" * 60)


if __name__ == "__main__":
    main()
