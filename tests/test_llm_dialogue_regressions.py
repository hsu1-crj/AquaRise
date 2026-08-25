"""海洋守护者对话链路 A-J 缺陷回归测试。"""

from src.LLM.chat_api import ChatMessage, ChatRequest, ChatService, _build_retrieval_query
from src.LLM.rag.lexical_retriever import LocalKnowledgeRetriever
from src.backend.services import llm


def test_follow_up_retrieval_query_fuses_recent_relevant_turns():
    messages = [
        ChatMessage(role="user", content="先聊聊海岸清理。"),
        ChatMessage(role="assistant", content="可以从评估和分区开始。"),
        ChatMessage(role="user", content="MARPOL公约附则V主要规定什么内容？"),
        ChatMessage(role="assistant", content="附则V主要管船舶垃圾。"),
        ChatMessage(
            role="user",
            content="上面你提到的附则V，除了塑料禁止入海，船舶产生的食物垃圾该怎么处理？",
        ),
    ]

    query = _build_retrieval_query(messages)

    assert "MARPOL公约附则V" in query
    assert "食物垃圾" in query
    assert "海岸清理" not in query


def test_marpol_food_waste_follow_up_is_not_the_generic_first_answer():
    first = llm.direct_response("MARPOL公约附则V主要规定什么内容？")
    follow_up = llm.direct_response(
        "上面你提到的附则V，除了塑料禁止入海，船舶产生的食物垃圾该怎么处理？"
    )

    assert first
    assert follow_up
    assert follow_up != first
    assert "3海里" in follow_up
    assert "12海里" in follow_up
    assert "航行" in follow_up


def test_near_duplicate_answer_detects_verbatim_replay():
    previous = "附则V禁止船舶把塑料垃圾排入海中，其他垃圾要分类管理。"

    assert llm.is_near_duplicate_answer(previous, previous)
    assert not llm.is_near_duplicate_answer(
        "针对食物垃圾，是否粉碎、距岸距离和所在海域都会影响处理要求。",
        previous,
    )


def test_microplastic_human_exposure_follow_up_is_not_hazard_replay():
    first = llm.direct_response("微塑料对人体有什么危害？")
    follow_up = llm.direct_response(
        "刚才第一条回答里提到的微塑料进入人体的主要途径有哪些？"
    )

    assert first
    assert follow_up
    assert follow_up != first
    assert "摄入" in follow_up
    assert "吸入" in follow_up


def test_unverified_named_treaty_never_uses_unrelated_evidence_as_answer():
    question = "请介绍一下《全球海洋清理国际公约》2024年修订版的主要条款。"
    unrelated_evidence = [
        {
            "source": "海岸清理记录模板.md",
            "content": "清理记录应填写日期、点位、垃圾类型、重量和复测结果。",
            "score": 0.91,
        },
        {
            "source": "海洋垃圾降解周期表.md",
            "content": "塑料会长期持留并逐步碎裂成微塑料。",
            "score": 0.72,
        },
    ]

    answer = llm._knowledge_fallback(question, unrelated_evidence)

    assert answer
    assert "没有查到《全球海洋清理国际公约》" in answer
    assert "无法确认" in answer
    assert "清理记录应填写" not in answer

    unquoted = llm._knowledge_fallback(
        "请介绍全球海洋清理国际公约2024年修订版的主要条款。",
        unrelated_evidence,
    )
    assert unquoted
    assert "没有查到《全球海洋清理国际公约》" in unquoted


def test_pet_hdpe_uv_comparison_returns_caveated_common_knowledge():
    question = "PET和HDPE两种塑料，哪种更耐海洋环境中的紫外线老化？为什么？"

    answer = llm.direct_response(question)

    assert llm.is_domain_question(question)
    assert answer
    assert "以下为通识判断" in answer
    assert "PET通常比HDPE" in answer.replace(" ", "")
    assert "添加剂" in answer


def test_plastic_bottle_duration_gives_number_with_uncertainty():
    answer = llm.direct_response("一个塑料瓶在海里降解大概需要多久？")

    assert answer
    assert "450年" in answer
    assert "估算" in answer or "数量级" in answer
    assert "微塑料" in answer


def test_lexical_bottle_evidence_keeps_object_number_and_caveat_together():
    results = LocalKnowledgeRetriever().search("塑料饮料瓶在海里降解需要多久", 5)
    matching = [item["content"] for item in results if "450年" in item["content"]]

    assert matching
    assert any("饮料瓶" in content and "估算" in content for content in matching)
    evidence = [{"content": matching[0], "source": "海洋垃圾降解周期表.md"}]
    answer = "常见科普估算约450年，但这不代表完全矿化。"
    assert not llm._has_unsupported_facts(answer, "塑料瓶需要多久？", evidence)


def test_basic_arithmetic_is_solved_deterministically():
    answer = llm.direct_response("37×23等于多少？")

    assert answer
    assert "851" in answer
    assert "专业范围" in answer


def test_chicken_rabbit_equation_is_solved_deterministically():
    answer = llm.direct_response("鸡兔同笼，共35个头、94只脚，鸡和兔各有多少只？")

    assert answer
    assert "鸡23只" in answer.replace(" ", "")
    assert "兔12只" in answer.replace(" ", "")


def test_abc_cleanup_grid_uses_priority_tiers_not_invented_dimensions():
    answer = llm.direct_response(
        "如何基于垃圾堆积密度、生态脆弱度与潮汐窗口划分 A/B/C 三级清理响应网格？"
    )

    assert answer
    assert "清理优先级" in answer
    assert "A级" in answer and "B级" in answer and "C级" in answer
    assert "面积网格" not in answer
    assert "距离网格" not in answer
    assert "时间网格" not in answer


def test_percentage_word_problem_supports_multiplication_chain_and_chinese_percentages():
    arabic = llm.direct_response(
        "某海域清理出2.5吨垃圾，塑料占60%，其中PET占塑料的30%，PET重多少吨？"
    )
    chinese = llm.direct_response(
        "某海域清理出2.5吨垃圾，塑料占六成，其中PET占塑料的百分之三十，PET重多少吨？"
    )

    assert arabic and "0.45吨" in arabic.replace(" ", "")
    assert chinese and "0.45吨" in chinese.replace(" ", "")
    assert "2.5×60%×30%" in arabic.replace(" ", "")



def test_percentage_word_problem_supports_colloquial_how_many_tons():
    answer = llm.direct_response(
        "清理出10吨垃圾，其中六成是塑料，塑料里百分之三十是PET，PET有几吨？"
    )

    assert answer and "1.8吨" in answer.replace(" ", "")

def test_percentage_statistics_without_calculation_intent_is_not_intercepted():
    question = "监测报告显示塑料占60%，其中PET占30%，请分析形成原因。"

    assert llm._deterministic_percentage_response(question) is None


def test_marine_unit_conversions_use_deterministic_whitelist():
    nautical_mile = llm.direct_response("1海里等于多少公里？")
    knot = llm.direct_response("10节相当于多少公里每小时？")
    mass = llm.direct_response("2吨等于多少千克？")

    assert nautical_mile and "1.852公里" in nautical_mile.replace(" ", "")
    assert knot and "18.52公里/小时" in knot.replace(" ", "")
    assert mass and "2000千克" in mass.replace(" ", "")


def test_counterfactual_question_injects_structured_uncertainty_prompt():
    request = ChatRequest(
        messages=[
            ChatMessage(
                role="user",
                content="如果没有月球潮汐，海滩上垃圾的分布会有什么不同？",
            )
        ],
        enable_rag=False,
    )

    messages, _ = ChatService().prepare_messages(request)
    system_text = "\n".join(item["content"] for item in messages if item["role"] == "system")

    assert "较确定推论" in system_text
    assert "推测" in system_text
    assert "不确定性" in system_text
    assert "材质名称" in system_text and "微塑料" in system_text


def test_counterfactual_quality_gate_rejects_category_confusion_and_weak_uncertainty():
    question = "如果没有月球潮汐，海滩上垃圾的分布会有什么不同？"
    confused = (
        "较确定推论：月球潮汐会变化。推测：PET就是微塑料，所以它会均匀扩散。"
        "不确定性：还要看风浪。"
    )
    weak = "月球潮汐消失以后，海滩垃圾会均匀分散，所有海岸都会出现同样结果。"
    qualified = (
        "较确定推论：月球潮汐作用会减弱，但太阳潮和风浪仍存在。"
        "推测：原有潮线附近的反复搬运可能减弱。"
        "不确定性：实际分布仍取决于岸形、洋流和风浪，不能断定一定更均匀。"
    )

    assert not llm.is_acceptable_model_answer(confused, question)
    assert not llm.is_acceptable_model_answer(weak, question)
    assert llm.is_acceptable_model_answer(qualified, question)


def test_counterfactual_gate_failure_uses_conservative_fallback():
    question = "如果没有月球潮汐，海滩上垃圾的分布会有什么不同？"

    answer = llm.finalize_model_answer(
        question,
        "没有潮汐后垃圾一定会均匀分布，PET就是微塑料。",
    )

    assert "较确定推论" in answer
    assert "太阳" in answer and "风浪" in answer
    assert "不能断定" in answer and "均匀" in answer


def test_marine_safety_rules_cover_rip_current_tide_and_jellyfish():
    rip_current = llm.direct_response("在海边游泳遇到离岸流怎么办？")
    tide_trap = llm.direct_response("在礁石区遇到涨潮被困怎么办？")
    jellyfish = llm.direct_response("在海里被水母蜇伤怎么办？")

    assert rip_current
    assert "不要逆流" in rip_current and "平行" in rip_current
    assert "漂浮" in rip_current and "呼救" in rip_current and "专业救援" in rip_current
    assert tide_trap
    assert "高处" in tide_trap and "不要冒险涉水" in tide_trap
    assert "位置" in tide_trap and "专业救援" in tide_trap
    assert jellyfish
    assert "触手" in jellyfish and "热水" in jellyfish
    assert "不要揉搓" in jellyfish and "紧急" in jellyfish


def test_decimal_confidence_answer_leads_with_direct_conclusion():
    answer = llm.direct_response("检测结果置信度只有0.6，应该怎么处理？")

    assert answer
    assert answer.startswith("0.6属于低置信度")
    assert "人工复核" in answer
    assert "不作为正式统计依据" in answer


def test_false_three_year_degradation_premise_is_corrected():
    answer = llm.direct_response("你刚才说3年就能降解完，对吗？")

    assert answer
    assert answer.startswith("不对")
    assert "450年" in answer
    assert "碎裂成微塑料" in answer
