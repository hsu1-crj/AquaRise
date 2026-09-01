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


def test_atlas_species_starter_uses_current_archive_instead_of_generic_rag():
    message = (
        "【当前浏览物种】小头鼠海豚 / Vaquita / Phocoena sinus｜IUCN：CR·极危｜简介："
        "生活在加利福尼亚湾北部，是世界上最稀有的小型鲸豚。非法石首鱼刺网的兼捕让整个物种在灭绝边缘徘徊，野生个体仅存个位数。\n"
        "我的问题：请介绍小头鼠海豚目前的生存现状、主要威胁，以及普通人可以参与的保护行动？"
    )

    answer = llm.direct_response(message)

    assert answer is not None
    assert answer.startswith("小头鼠海豚目前处于 CR·极危")
    assert "非法石首鱼刺网" in answer
    assert "普通人" in answer
    assert "珊瑚" not in answer and "trash_rope" not in answer
    assert "检测数据" not in answer and "报告发我" not in answer


def test_atlas_species_quick_question_stays_grounded_in_current_archive():
    message = (
        "【当前浏览物种】小头鼠海豚 / Vaquita / Phocoena sinus｜IUCN：CR·极危｜简介："
        "生活在加利福尼亚湾北部，是世界上最稀有的小型鲸豚。非法石首鱼刺网的兼捕让整个物种在灭绝边缘徘徊。\n"
        "我的问题：它为什么濒危？"
    )

    answer = llm.direct_response(message)

    assert answer is not None
    assert "非法石首鱼刺网" in answer and "兼捕" in answer
    assert "当前档案" in answer


def test_atlas_protection_actions_follow_each_species_archive_threat():
    vaquita = (
        "【当前浏览物种】小头鼠海豚 / Vaquita / Phocoena sinus｜IUCN：CR·极危｜简介："
        "非法石首鱼刺网兼捕是当前核心威胁。\n我的问题：我能为保护它做什么？"
    )
    whale = (
        "【当前浏览物种】北大西洋露脊鲸 / North Atlantic right whale / Eubalaena glacialis｜"
        "IUCN：CR·极危｜简介：船舶撞击和渔具缠绕持续威胁现存种群。\n我的问题：我能为保护它做什么？"
    )

    vaquita_answer = llm.direct_response(vaquita)
    whale_answer = llm.direct_response(whale)

    assert vaquita_answer and "非法石首鱼刺网" in vaquita_answer
    assert "可追溯" in vaquita_answer or "非法捕捞" in vaquita_answer
    assert whale_answer and "船舶撞击" in whale_answer
    assert "减速" in whale_answer and "安全距离" in whale_answer
    for answer in (vaquita_answer, whale_answer):
        assert "检测报告" not in answer and "知识库" not in answer


def test_atlas_whale_shark_actions_cover_propeller_strike_and_illegal_killing():
    message = (
        "【当前浏览物种】鲸鲨 / Whale shark / Rhincodon typus｜IUCN：EN·濒危｜简介："
        "迁徙途中可能遭货轮螺旋桨重创，也面临非法捕杀威胁。\n"
        "我的问题：普通人能为保护它做什么？"
    )

    answer = llm.direct_response(message)

    assert answer and "货轮螺旋桨重创" in answer and "非法捕杀" in answer
    assert "减速" in answer and "安全距离" in answer
    assert "拒绝购买" in answer and "非法贸易" in answer


def test_microplastic_marine_life_question_answers_observed_effects():
    answer = llm.direct_response("微塑料对海洋生物已经观察到了哪些影响？")

    assert answer
    assert "摄入" in answer and "消化道" in answer
    assert "生长" in answer or "繁殖" in answer
    assert "不能仅凭发现颗粒" in answer


# ==================== 2026-08-29 回归：追问路由 / 报告反编造 / 对比题 ====================


def test_referential_follow_up_detection():
    history = [
        ChatMessage(role="user", content="打捞上来的废弃渔网，应该送去焚烧还是回收利用？"),
        ChatMessage(role="assistant", content="渔网可按隔离-脱盐-分选-破碎-熔融过滤-造粒回收处理。"),
    ]
    assert llm.is_referential_follow_up("那成本呢？", history)
    assert llm.is_referential_follow_up("你说的分段解缠，具体是怎么操作的？", history)
    # 显式指代词不依赖历史也存在
    assert llm.is_referential_follow_up("你说的分段解缠，具体是怎么操作的？")
    assert not llm.is_referential_follow_up("MARPOL公约附则V主要规定什么内容？", history)


def test_short_follow_up_skips_scope_fallback():
    # 无历史时保持旧行为：范围外兜底仍可用
    assert llm.direct_response("那成本呢？")
    # 追问场景：不得被"超出专业范围"抢答，应交回带历史上下文的模型链路
    assert llm.direct_response("那成本呢？", allow_scope_fallback=False) is None


def test_material_comparison_question_gets_direct_ranking():
    answer = llm.direct_response("PET 瓶和普通塑料袋，哪个在海里更难降解？为什么？")
    assert answer
    assert "更难降解" in answer
    assert "450" in answer
    assert "微塑料" in answer
    assert "我不替档案编" not in answer


def test_report_fabrication_blocked_without_report_context():
    fabricated = (
        "根据你的检测报告，污染等级为 [高]。重金属浓度超标：检测结果显示铅、汞和镉均超出标准，评分92分。"
    )
    result = llm.finalize_model_answer(
        "我最近的检测报告结论是什么？污染等级高吗？", fabricated, evidence=[], report_context=None
    )
    assert "重金属" not in result
    assert "[高]" not in result
    assert "92" not in result


def test_report_grounded_answer_kept_with_context():
    context = "报告 ID：RPT-9\n风险等级：中\n评分：68\n目标数量：46"
    answer = "根据当前绑定的报告内容，这份报告的风险等级为中，评分68分，检出46个目标。"
    result = llm.finalize_model_answer(
        "这份报告的污染等级怎么样？", answer, evidence=[], report_context=context
    )
    assert "风险等级为中" in result
    assert "68" in result


def test_report_data_question_detection_boundaries():
    assert llm._is_report_data_question("我最近的检测报告结论是什么？污染等级高吗？")
    assert llm._is_report_data_question("这份报告的评分是多少？")
    assert not llm._is_report_data_question("污染等级是怎么划分的？")
    assert not llm._is_report_data_question("MARPOL公约对塑料垃圾排放有什么规定？")


def test_followup_fallback_keeps_topic_thread():
    # 追问被门禁拦截后落到兜底时，必须承接上文话题，不得像新问题一样答非所问
    answer = llm.finalize_model_answer(
        "那成本呢？",
        "处理成本大概是每吨80到150美元。",
        evidence=[],
        report_context=None,
        allow_scope_fallback=False,
        history_note="打捞上岸的尼龙或聚乙烯渔网可按隔离-脱盐-分选-破碎-熔融过滤-造粒处理。",
    )
    assert "结合刚才聊到" in answer
    assert "渔网" in answer
    assert "80" not in answer and "美元" not in answer
    assert "超出专业范围" not in answer and "不是行家" not in answer


def test_health_concern_card_reassures_and_defers_to_doctor():
    answer = llm.direct_response("我孩子今天在海边玩水时吞了几口海水，担心误食微塑料，要不要去医院？")
    assert answer and "没有证据" in answer and ("就医" in answer or "医生" in answer or "12320" in answer)
    # 不编造医学结论，也不落成知识库科普课文
    assert "知识库中没" not in answer and "碎裂" not in answer[:60]
    # 通用科普问法不得被健康卡抢答
    assert llm._health_concern_response("微塑料对人体的危害有哪些？") is None


def test_realtime_news_claim_refuses_endorsement():
    answer = llm.direct_response("昨天新闻说渤海发现了一条 500 米长的巨型垃圾漂浮带，你怎么看？")
    assert answer and "无法核实" in answer
    assert "500" not in answer and "确认" not in answer.split("既不确认")[0][:40]


def test_bound_report_solution_answer_passes_without_citations():
    # 绑定报告后问"治理解决方案"：模型基于报告事实的分析不需要 [S编号] 引用，
    # 无关的 RAG 证据片段也不应一票否决——否则会被摘录兜底退化成复述。
    context = (
        "报告 ID：RPT-9\n生成时间：2026-08-21 11:40\n检测海域：北戴河\n"
        "风险等级：中\n评分：68\n关键发现：塑料瓶 12 件、废弃渔网 3 件\n处置方案：优先清理废弃渔网"
    )
    answer = (
        "结合当前绑定报告：北戴河这次任务污染等级为中（评分 68），主要垃圾是塑料瓶和废弃渔网。"
        "建议处置上优先清理废弃渔网防止缠绕，其次集中捡拾塑料瓶；针对中的等级，"
        "建议两周后同点位复测对比数量变化，并查漏陆源输入。"
    )
    result = llm.finalize_model_answer(
        "结合这份报告，给我一套治理解决方案？",
        answer,
        evidence=[{"content": "与本问题无关的通用知识片段，讨论的是完全不同的话题内容。"}],
        report_context=context,
    )
    assert "渔网" in result and "68" in result
    assert "复测" in result  # 模型自己的方案内容必须被保留，而不是被摘录兜底替换


def test_bound_report_solution_fallback_composes_briefing():
    # 模型答案被拦时，方案/解读类问题应得到"结论-发现-方案-监测"结构化简报，
    # 全部来自绑定报告实测事实，而不是几行摘录复述
    context = (
        "报告 ID：RPT-9\n生成时间：2026-08-21 11:40\n检测海域：北戴河\n"
        "关联任务：任务 17（acc_baseline_task.jpg）\n"
        "分析摘要：报告显示该任务处于“中”污染等级，检出 46 个目标。\n"
        "风险等级：中\n评分：68\n目标数量：46\n"
        "关键发现：\n- 本次共识别 46 个垃圾目标，污染等级为“中”。\n- 高频类别为：瓶子（12）、渔网（3）。\n"
        "处置方案：\n- 优先清理废弃渔网，防止缠绕。\n- 塑料瓶集中捡拾并增压减量。\n"
        "后续监测：\n- 两周后同点位复测，对比数量变化。"
    )
    result = llm._report_solution_response("结合这份报告，给我一套治理解决方案", context)
    assert result and "北戴河" in result and "68" in result
    assert "处置方案" in result and "后续监测建议" in result and "复测" in result
    assert "不会补写" in result
    # 纯事实问法不触发布报
    assert llm._report_solution_response("这份报告的评分是多少？", context) is None


def test_specific_knowledge_cards_do_not_fall_through_to_generic_answers():
    marpol = llm.direct_response("MARPOL 公约的几个附则分别管什么内容？")
    assert marpol and all(f"附则 {roman}" in marpol for roman in ("I", "II", "III", "IV", "V", "VI"))

    pet = llm.direct_response("PET 塑料有什么特征，常见于哪些海洋垃圾？")
    assert pet and "PET" in pet and "聚对苯二甲酸乙二醇酯" in pet
    assert "人类健康" not in pet

    pp = llm.direct_response("PP（聚丙烯）这类塑料的环境行为是怎样的？")
    assert pp and "聚丙烯" in pp
    assert "PET" not in pp

    assert "聚对苯二甲酸乙二醇酯" in llm.direct_response("PET塑料有什么特征？")
    assert "聚丙烯" in llm.direct_response("PP塑料在海洋环境中表现怎样？")
    assert not llm._contains_special_term("shipping pollution", "pp")


def test_suggestion_questions_are_answerable_or_filtered():
    items = llm._load_suggestion_index()
    assert items
    for entry in items:
        if llm._suggestion_is_answerable(entry):
            direct = llm.direct_response(entry["question"], allow_scope_fallback=False)
            if not direct:
                assert llm._knowledge_fallback(
                    entry["question"], llm._SUGGESTION_DOC_CACHE[entry["sourceDoc"]]
                )
            continue
        # 当前索引中被判定为不可回答的问题不得被建议接口下发。
        assert entry["question"] not in {
            item["question"]
            for item in llm.suggest_adjacent_questions(entry["question"], limit=10)
        }


def test_common_short_questions_use_topic_specific_deterministic_cards():
    blue_carbon = llm.direct_response("蓝碳是什么？")
    assert blue_carbon and "红树林" in blue_carbon and "碳" in blue_carbon

    plastic_governance = llm.direct_response("海洋塑料污染怎么治理？")
    assert plastic_governance
    assert all(term in plastic_governance for term in ("源头减量", "入海前拦截", "复测"))
    assert "海洋塑料治理技术综述" not in plastic_governance

    health = llm.direct_response("重金属对人体健康有什么危害？")
    assert health and "剂量" in health and "食品监管" in health
    assert "海洋垃圾与人类健康知识" not in health


def test_multi_entity_retrieval_and_answer_keep_topics_separate():
    question = "鱼类和 ROV 分别介绍"
    answer = llm.direct_response(question)
    assert answer and "鱼类：" in answer and "ROV：" in answer
    retriever = LocalKnowledgeRetriever()
    sources = [item["metadata"]["source"] for item in retriever.search(question, 8)]
    assert set(sources) <= {
        "海洋生物与生态基础知识.md",
        "水下机器人ROV与海底作业知识.md",
    }
    assert "海洋生物与生态基础知识.md" in sources
    assert "水下机器人ROV与海底作业知识.md" in sources


def test_multi_entity_fallback_keeps_each_named_topic_answerable():
    retriever = LocalKnowledgeRetriever()
    cases = (
        (
            "鱼类和蓝碳分别是什么",
            ("鱼类：", "蓝碳："),
            ("海洋生物与生态基础知识.md", "海洋碳汇与气候变化知识.md"),
        ),
        (
            "重金属和蓝碳分别有什么影响",
            ("重金属：", "蓝碳："),
            ("海洋环境监测与水质参数知识.md", "海洋碳汇与气候变化知识.md"),
        ),
    )
    for question, answer_markers, source_markers in cases:
        answer = llm.direct_response(question, allow_scope_fallback=False)
        assert answer and all(marker in answer for marker in answer_markers)
        selected = llm._select_topic_evidence(question, retriever.search(question, 8))
        selected_sources = {llm._evidence_source_name(item) for item in selected}
        assert set(source_markers) <= selected_sources
