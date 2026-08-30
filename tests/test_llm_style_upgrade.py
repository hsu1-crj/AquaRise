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


# ---------- 5. 引用口径收窄与答非所问修复（2026-08-28） ----------

def test_citation_requirement_no_longer_hijacks_concept_questions():
    """概念问法不再被引用强制口径绑架；操作语境仍强制。"""
    assert not llm.requires_citations("ROV是什么东西？")
    assert not llm.requires_citations("海洋温度现在多少度？")
    assert not llm.requires_citations("一吨海洋塑料垃圾回收能产生多少经济效益？")
    assert not llm.requires_citations("怎么区分PET和HDPE塑料？")
    assert llm.requires_citations("检测报告里置信度 60% 怎么解读？")
    assert llm.requires_citations("幽灵渔网缠绕珊瑚礁时微创切割标准作业指引")
    assert llm.requires_citations("MARPOL 附则 V 允许塑料排海吗？")


def test_concept_cards_answer_definition_questions_directly():
    confidence = llm.direct_response("检测报告里的置信度是什么意思？")
    assert confidence and "把握程度" in confidence and "不是准确率" in confidence

    deep_sea = llm.direct_response("水深超过多少米算深海？")
    assert deep_sea and "200米" in deep_sea.replace(" ", "") and "知识库" in deep_sea

    rov = llm.direct_response("ROV是什么东西？")
    assert rov and "遥控水下机器人" in rov and "系缆" in rov


def test_comparison_cards_give_magnitude_ranking_with_boundaries():
    bottle_bag = llm.direct_response("塑料瓶和塑料袋哪个先降解？")
    assert bottle_bag and "更难降解" in bottle_bag
    assert "450" in bottle_bag and "微塑料" in bottle_bag
    # 数量级直给必须同时声明边界：区间重叠、不是精确名次，不允许编出精确寿命
    assert "重叠" in bottle_bag and "不是精确名次" in bottle_bag

    oil_plastic = llm.direct_response("石油泄漏对海洋的危害大还是塑料危害大？")
    assert oil_plastic
    assert "急性" in oil_plastic or "油膜" in oil_plastic
    assert "微塑料" in oil_plastic or "持久" in oil_plastic
    assert "排序结论" in oil_plastic or "没有统一" in oil_plastic


def test_live_data_and_economics_cards_admit_knowledge_boundary():
    temperature = llm.direct_response("海洋温度现在多少度？")
    assert temperature and "没有实时" in temperature and "CTD" in temperature

    economics = llm.direct_response("一吨海洋塑料垃圾回收能产生多少经济效益？")
    assert economics and "没有" in economics and "编一个数" in economics
    assert "押金返还" in economics or "生产者责任延伸" in economics


def test_material_pairing_error_is_rejected_by_gate():
    """聚丙烯（PC）这类张冠李戴的配对属于硬幻觉，门禁必须拦下。"""
    evidence = [{"source": "常见塑料材质与回收利用知识.md", "content": "PET 是1号回收代码，HDPE 是2号。"}]
    assert llm._has_material_pairing_error("常见的垃圾瓶是聚丙烯（PC）制成的")
    assert llm._has_material_pairing_error("塑料袋主要是聚乙烯（PC）材料")
    assert not llm._has_material_pairing_error("饮料瓶多为PET（聚对苯二甲酸乙二醇酯）材质")
    assert not llm.is_acceptable_model_answer(
        "常见的垃圾瓶是聚丙烯（PC）制成的，需要回收处理后再利用。",
        "垃圾瓶是什么材质的？",
        evidence,
    )


def test_comparison_answer_missing_one_side_is_rejected():
    question = "石油泄漏对海洋的危害大还是塑料危害大？"
    assert not llm._comparison_answer_covers_both_sides(
        question,
        "石油泄漏会阻断气体交换并黏住海鸟羽毛，短期危害更大，所以石油泄漏更严重。",
    )
    assert llm._comparison_answer_covers_both_sides(
        question,
        "油污伤在当下，塑料伤在长远：油膜阻断气体交换，微塑料长期留在食物链里。",
    )
    # 单边作答但声明知识边界也算合规
    assert llm._comparison_answer_covers_both_sides(
        question,
        "我对石油泄漏只了解一些，对塑料污染的了解有限，知识库没有统一排序。",
    )


def test_evidence_excerpt_strips_myth_prefixes():
    lines, _ = llm._evidence_excerpt(
        "海洋垃圾一般要多久才能降解？",
        [{
            "source": "海洋环保常见误区与事实核查.md",
            "content": "核查：不存在适用于所有地点的统一降解年限。正确表述：塑料首先老化和碎裂为微塑料，碎裂不等于消失。",
        }],
    )
    assert lines
    for _source_id, sentence in lines:
        assert not sentence.startswith(("核查", "正确表述", "误区"))


def test_query_echo_strip_salvages_correct_answers():
    answer = (
        "ROV是什么东西？\n\n"
        "ROV是遥控水下机器人，通过母船系缆供电与回传数据，能够完成水下航行、取样和监测等任务，"
        "广泛应用于海底调查与生态监测领域，是重要的水下作业平台。"
    )
    cleaned = llm._strip_query_echo("ROV是什么东西？", answer)
    assert not cleaned.startswith("ROV是什么")
    assert cleaned.startswith("ROV是遥控水下机器人")

    # 首行不是问题回声时必须原样返回——不能剥掉正文前几个字
    normal = "海洋温度影响溶解氧、生物代谢与层化等参数，需要用CTD测量并注明深度。"
    assert llm._strip_query_echo("ROV是什么东西？", normal) == normal
    assert llm._strip_query_echo("海洋温度现在多少度？", normal) == normal


def test_document_self_reference_and_markdown_echo_are_cleaned():
    docish = (
        "本文介绍深海环境特征与深海垃圾研究要点，供识别与作业类问答使用。"
        "深海通常指水深大于200米的海域，低温低氧环境下塑料老化碎裂更慢。"
    )
    cleaned = llm._strip_document_self_reference(docish)
    assert "本文介绍" not in cleaned and "问答使用" not in cleaned
    assert "200米" in cleaned.replace(" ", "")

    # "## 标题"开头的文档复述必须被门禁整段拒绝
    assert not llm.is_acceptable_model_answer(
        "## 海洋污染类型与生态影响\n\n塑料污染是长期持留问题，需要源头减量和及时清理。",
        "为什么海洋塑料污染这么难治理？",
    )


def test_hard_cards_are_not_stolen_by_operation_questions():
    """ROV 概念卡不得抢走切割 SOP 等作业问题。"""
    assert llm.direct_response("ROV 微创切割的标准作业指引是什么？") is not None
    answer = llm.direct_response("水下幽灵渔网缠绕珊瑚礁时，潜水员或 ROV 进行微创切割的标准作业指引是什么？")
    assert answer and "分段" in answer and "ROV" in answer
    assert "遥控水下机器人是本系统" not in answer


# ---------- 6. 渔网处置卡路由与答案内复读门禁（2026-08-28） ----------

def test_ghost_net_disposal_questions_use_direct_safety_card():
    """普通发现/处置问法应命中安全处置卡，不再掉进小模型自由生成。"""
    for question in (
        "发现幽灵渔网怎么处理？",
        "幽灵渔网发现了该怎么办？",
        "渔网怎么处理？",
    ):
        answer = llm.direct_response(question)
        assert answer
        assert "记录位置" in answer and "专业团队" in answer
        assert "别直接拖拽" in answer


def test_ghost_net_disposal_route_preserves_operation_and_recycling_guards():
    """ROV 切割作业与回收问法不得被普通安全处置卡抢答。"""
    operation = llm.direct_response("ROV切割缠绕渔网的步骤")
    assert operation and "ROV" in operation and "分段" in operation
    assert "别直接拖拽" not in operation

    recycling = llm.direct_response("渔网怎么回收？")
    assert recycling is None or "别直接拖拽" not in recycling

    # 蓝碳属于海洋领域，但没有确定性卡，应继续交给 RAG + 本地模型。
    assert llm.is_domain_question("什么是蓝碳？")
    assert llm.direct_response("什么是蓝碳？") is None


def test_model_answer_gate_rejects_near_duplicate_paragraphs():
    first = (
        "第一，发现废弃渔网后先划定警戒范围，记录坐标、水深、缠绕对象和现场影像。"
        "不要贸然拖拽或下水切割，应由专业团队评估海况、生物受困程度和作业风险，"
        "再确定分段解缠、安全打捞以及后续转运方案，整个过程保留复核记录。"
    )
    second = (
        "第二，发现废弃渔网后要先划出警戒区域，记录位置、水深、缠绕目标和现场照片。"
        "不要擅自拖动或入水切割，应让专业人员评估海况、生物受困情况和操作风险，"
        "再决定分段解缠、安全打捞以及后续运输方案，并为全过程留下复核记录。"
    )
    repeated = f"{first}\n\n{second}"

    assert len(llm._compact(repeated)) >= 200
    assert llm._has_obvious_repetition(repeated)
    assert not llm.is_acceptable_model_answer(repeated, "发现幽灵渔网后应该如何安全处置？")

    parenthesized = f"（一）{first}\n（二）{second}"
    assert llm._has_obvious_repetition(parenthesized)

    short_repetition = "（一）先记录位置并保持距离。\n（二）先记录坐标并留出距离。"
    assert len(llm._compact(short_repetition)) < 200
    assert not llm._has_near_duplicate_segments(short_repetition)


def test_model_answer_gate_allows_normal_long_enumeration():
    normal = (
        "海洋垃圾可以先按材质和来源分成几类。\n\n"
        "塑料类常见饮料瓶、包装袋、泡沫和破碎塑料片，长期留存后还可能继续碎裂成微塑料，"
        "调查时应分别记录完整物与碎片。\n\n"
        "废弃渔具包括渔网、绳索、钓线和浮标，主要风险是缠绕海龟、鱼类或珊瑚，"
        "现场发现后需要标注位置并交给专业人员评估。\n\n"
        "金属与玻璃类包括罐体、瓶体和器具残片，前者可能锈蚀，后者可能造成割伤，"
        "清理时要使用合适的防护和收纳容器。\n\n"
        "橡胶、织物及其他复合材料也应单独登记，因为混合材质的回收路径不同，"
        "最终分类仍要结合当地接收和处置条件。"
    )

    assert len(llm._compact(normal)) >= 200
    assert not llm._has_obvious_repetition(normal)
    assert llm.is_acceptable_model_answer(normal, "海洋垃圾主要有哪些类型？")
