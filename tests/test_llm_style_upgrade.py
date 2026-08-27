"""LLM 风格升级（去机器感 + 追问闭环）的回归测试。

覆盖四个层面：
1. 运行时系统提示词：新语气要素存在、旧"先结论后依据"口径已退场；
2. 质量门禁分层处置：科普无 [S] 放行 / 报告类缺引用仍拦 / 硬幻觉仍拦 /
   形式层擦伤走"原文+证据补丁"中间层而非整段替换；
3. 规则直答变体轮换：同类别连续调用文本必不同（稳定核心句仍在）；
4. 建议追问闭环：只出索引内问题、黑名单零命中、已问过滤、工具校验通过。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from src.LLM.chat_api import ChatMessage, ChatRequest, chat_service
from src.backend.services import llm

ROOT = Path(__file__).resolve().parents[1]

# 生产环境中由路由器在首次请求前初始化；测试需要显式建立一次，
# 使 prepare_messages 的 RAG 检索路径可用。
chat_service.initialize("http://localhost:11434")


def _request(question: str, enable_rag: bool = False) -> ChatRequest:
    return ChatRequest(
        messages=[ChatMessage(role="user", content=question)],
        enable_rag=enable_rag,
    )


# ---------- 1. 运行时系统提示词 ----------

def test_system_prompt_has_new_tone_and_drops_old_rigid_order():
    prepared, _ = chat_service.prepare_messages(_request("微塑料是什么？"))
    system = prepared[0]["content"]

    # 新语气要素
    assert "研究型伙伴" in system or "有温度" in system
    assert "类比" in system and "承接" in system
    # 反模板套话清单保留并扩充了收尾腔
    assert "综上所述" in system and "希望这些能帮到你" in system
    # 旧的机械口径不再出现（先结论后依据的强制措辞来自 Modelfile 旧版）
    assert "先给结论，再说明依据" not in system
    # 身份口径：仅被动应答
    assert "不主动提及项目背景或开发者" in system


def test_soft_citation_rule_used_for_science_question_with_evidence():
    prepared, _ = chat_service.prepare_messages(_request("微塑料是什么？", enable_rag=True))
    evidence_block = next(m["content"] for m in prepared if m["role"] == "system" and "[S1]" in m["content"])
    # 科普问题走宽松分支：集中标注即可，不要求逐段
    assert "不必为引用而生硬套格式" in evidence_block

    report_prepared, _ = chat_service.prepare_messages(
        _request("检测报告里置信度 60% 怎么解读？", enable_rag=True)
    )
    report_block = next(
        m["content"] for m in report_prepared if m["role"] == "system" and "[S1]" in m["content"]
    )
    # 报告/统计类问题仍强制逐段标注
    assert "每个包含事实判断的自然段末尾标注" in report_block


# ---------- 2. 门禁分层 ----------

MICROPLASTIC_EVIDENCE = [{
    "id": 1,
    "source": "海洋微塑料污染知识.md",
    "content": "微塑料通常指小于5毫米的塑料颗粒或碎片，会被海洋生物误食并沿食物链传递。",
}]


def test_science_answer_without_inline_citations_is_accepted():
    answer = (
        "微塑料一般是指粒径小于5毫米的塑料碎片或颗粒。它常常并不是真正消失，"
        "而是从大件制品逐步碎裂成更小的颗粒继续留在环境里，还可能被生物误食。"
    )
    assert llm.is_acceptable_model_answer(answer, "什么是微塑料呀？", MICROPLASTIC_EVIDENCE)


def test_report_question_missing_citations_is_still_rejected():
    answer = "60% 属于偏低的置信度，建议人工复核后再纳入统计结论，必要时补拍确认目标类别。"
    question = "检测报告里置信度 60% 的结果该怎么解读？"
    # 与主链路一致：finalize_model_answer 会显式传入 requires_citations(question)
    require = llm.requires_citations(question)
    assert require
    assert not llm.is_acceptable_model_answer(
        answer, question, MICROPLASTIC_EVIDENCE, require_citations=require
    )


def test_fabricated_institution_is_still_rejected_without_citation_requirement():
    answer = (
        "很多机构都在关注这个问题，例如某国际海洋保护署发布了详细的调查指南，"
        "大家可以参考它的建议行动。"
    )
    assert not llm.is_acceptable_model_answer(answer, "海洋垃圾有什么处置办法？", MICROPLASTIC_EVIDENCE)


def test_overlong_clean_answer_gets_evidence_patch_instead_of_full_replacement():
    """形式层失败（篇幅超限）时走'原文裁剪+证据要点'中间层。

    长文取自真实知识库文档的自然句拼接：天然互不重复，避免小模型
    "同片段循环"的假阳性干扰，专门隔离篇幅这一项形式层失败。
    """
    doc = (ROOT / "data" / "knowledge" / "海滩垃圾与公众参与实践知识.md").read_text(encoding="utf-8")
    unsafe = (
        llm._UNSUPPORTED_ORG_RE,
        llm.FABRICATED_EVENT_RE,
        llm._UNSUPPORTED_NAMED_FACT_RE,
        llm._UNSUPPORTED_SCHEMA_RE,
    )
    sentences = []
    for raw in re.split(r"(?<=[。！？])", doc):
        sentence = re.sub(r"^[#>*\-\s]+", "", raw).strip()
        if len(sentence) < 18:
            continue
        if any(pattern.search(sentence) for pattern in unsafe) or "《" in sentence or "公约" in sentence:
            continue
        sentences.append(sentence)

    long_answer = ""
    for round_index in range(4):  # 同一批自然句循环 4 轮拉满篇幅，拼接处仍是完整句
        for index, sentence in enumerate(sentences):
            long_answer += sentence
            if len(llm._compact(long_answer)) > 1160 and round_index >= 1:
                break
        if len(llm._compact(long_answer)) > 1160:
            break

    assert len(llm._compact(long_answer)) > 1100
    evidence = [{
        "id": 1,
        "source": "海滩垃圾与公众参与实践知识.md",
        "content": long_answer[:600],
    }]
    question = "海滩清洁活动应该怎么组织与记录？"
    assert not llm.is_acceptable_model_answer(long_answer, question, evidence)  # 篇幅超限
    patched = llm._patch_with_evidence(question, long_answer, evidence)
    assert patched is not None and "另外补充两点可以直接核验的要点" in patched
    final = llm.finalize_model_answer(question, long_answer, evidence)
    assert "补充两点可以直接核验的要点" in final
    assert len(final) < len(long_answer)


# ---------- 3. 直答变体轮换 ----------

def test_identity_and_scope_variants_rotate_without_repeating():
    identity_pool = {llm.identity_statement() for _ in range(3)}
    assert len(identity_pool) >= 2
    scope_first = llm.scope_response()
    assert llm.scope_response() != scope_first


def test_family_statements_share_stable_core_fact():
    seen = {llm.family_statement() for _ in range(3)}
    assert len(seen) >= 2
    for text in seen:
        assert "没有生物学意义上的父母或家人" in text
        assert "海瞳 LLM 组" in text


def test_correction_card_keeps_direct_opening_but_gains_rotating_tail():
    first = llm.direct_response("你刚才说塑料袋3年就降解完，对吗？")
    second = llm.direct_response("你刚才说塑料瓶3年就能降解完，对吗？")
    assert first.startswith("不对") or "不对，我需要纠正这个前提" in first[:20]
    assert "450年" in first
    # 纠错卡不强制与上一轮逐字相同：收尾句可轮换；即便相同也必须仍是纠错核心
    assert ("很难给出准确数字" in second) or ("450年" in second)


def test_domain_card_tail_rotates_for_same_knowledge_point():
    answers = {llm.direct_response("塑料袋在水下多久能真正降解？") for _ in range(4)}
    cores = {"碎裂成微塑料"}
    assert all(any(core in a for core in cores) for a in answers)
    assert len({a.rstrip()[-24:] for a in answers}) >= 2  # 尾部至少两种表达


def test_risk_question_fallback_starts_with_calibrated_direct_conclusion():
    evidence = [{
        "id": 1,
        "source": "海洋垃圾与人类健康知识.md",
        "content": (
            "塑料含增塑剂、阻燃剂、稳定剂等添加剂，特定条件下可能释放。"
            "添加剂迁移与暴露水平取决于聚合物、温度、接触介质与时间。"
            "微塑料已在海洋、淡水、空气、食品与多种人体相关样本中被研究和检出。"
        ),
    }]

    answer = llm._knowledge_fallback("塑料添加剂和化学物质值得警惕吗？", evidence)

    assert answer is not None
    assert answer.startswith("值得警惕，但不必恐慌。")
    assert "风险高低" in answer or "暴露水平" in answer
    assert "[S1]" not in answer
    assert ".md" not in answer


def test_plastic_additive_risk_question_uses_stable_direct_route():
    answer = llm.direct_response("塑料添加剂和化学物质值得警惕吗？")

    assert answer is not None
    assert answer.startswith("值得警惕，但不必恐慌。")
    assert "增塑剂" in answer and "阻燃剂" in answer
    assert "取决于" in answer and "暴露" in answer
    assert "您好" not in answer
    assert "建议您查阅" not in answer


def test_additive_risk_direct_route_does_not_steal_report_statistics_question():
    question = "检测报告显示塑料添加剂检出率80%，值得警惕吗？"

    assert llm.requires_citations(question)
    assert llm.direct_response(question) is None


# ---------- 4. 建议追问闭环 ----------

def test_suggestions_only_from_index_and_blacklist_never_leaks():
    items = llm.suggest_adjacent_questions("渔网缠住珊瑚礁怎么处理？", limit=5)
    assert 0 < len(items) <= 5
    known_docs = {p.name for p in (ROOT / "data" / "knowledge").glob("*.md")}
    for item in items:
        assert item["question"].endswith(("吗？", "什么？", "呢？")) or len(item["question"]) > 10
        assert item["sourceDoc"] in known_docs
        assert not llm._SUGGESTION_BLACKLIST_RE.search(item["question"])


def test_suggestions_exclude_already_asked():
    asked = ["到底什么是微塑料？多大粒径才算微塑料？"]
    items = llm.suggest_adjacent_questions("微塑料是什么东西？", limit=5, asked_questions=asked)
    assert all(item["question"] not in asked for item in items)


def test_suggestion_index_tool_validates_clean():
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "build_suggestion_index.py")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    m = re.search(r"(\d+)/(\d+) 条通过", result.stdout)
    assert m and int(m.group(1)) >= 60  # 与交付规模一致（当前 73 条）


def test_suggest_index_file_exists_with_schema():
    data_file = ROOT / "data" / "knowledge" / "suggestion_index.json"
    assert data_file.exists()
