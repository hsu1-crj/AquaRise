"""
统计 API
=====================================
GET /api/v1/stats/summary   统计概览（任务数/垃圾总数/污染分布/材质分布）
GET /api/v1/stats/trend     趋势数据（?period=week|month|year）
"""

import os as _os
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import get_current_user, require_permission
from database import get_db
from models import DetectionResult, DetectionTask, MonitoringSite, PollutionLevel, SeaArea, TaskStatus, User
from schemas import (ClassRankItem, FrontendSummary, FrontendTrendPoint, SeaAreaItem, SiteEvidence,
                    SiteStatItem, StatsAnalysis)
from services import detector as detector_svc

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])

# ============ RBAC 守卫 ============
# 统计数据按消费页面挂对应模块：态势总览 / 污染分析 / 指挥大屏共用趋势与聚合，
# 站点列表还被海洋 3D（双模式）的地球站点消费；海域下拉（sea-areas）是全员侧边栏组件，保持仅登录。
SUMMARY_GUARD = Depends(require_permission("dashboard", "analysis", "screen", "ocean3d_monitor"))
TREND_GUARD = Depends(require_permission("dashboard", "analysis", "screen"))
SITES_GUARD = Depends(require_permission("dashboard", "analysis", "screen", "ocean3d_monitor", "ocean3d_science"))

# 污染等级 → 严重度权重（综合污染指数 = 平均权重 × 2，落在 0-10 区间）
_LEVEL_WEIGHT = {"excellent": 1, "good": 2, "moderate": 3, "poor": 4, "severe": 5}


def _level_weight(level) -> int:
    """等级 → 权重。DB 枚举列返回 (str, Enum) 成员, str() 会带类名前缀
    ('PollutionLevel.moderate') 导致查表恒落默认值——必须取 .value。"""
    return _LEVEL_WEIGHT.get(getattr(level, "value", str(level)), 3)


def _material_bucket(material: str | None) -> str:
    """材质字符串 → 饼图大类桶（未知/空归入"其他/未知"）"""
    if not material:
        return "其他/未知"
    if "塑料" in material:
        return "塑料/轻质"
    if "渔网" in material or "绳索" in material or "尼龙" in material:
        return "渔网/绳索"
    if "金属" in material or "木质" in material or "木头" in material:
        return "金属/木质"
    if "织物" in material or "纺织" in material:
        return "织物/衣物"
    return "其他/未知"


def _task_filter(since, until=None, sea_area_id: int | None = None):
    """已完成任务的时间窗 + 可选海域过滤条件（各聚合查询共用）"""
    conds = [DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= since]
    if until:
        conds.append(DetectionTask.created_at < until)
    if sea_area_id is not None:
        conds.append(DetectionTask.sea_area_id == sea_area_id)
    return conds


def _pollution_index(db: Session, since, until=None, sea_area_id: int | None = None) -> float:
    """某时间窗口的综合污染指数（0-10）。

    连续化公式: 等级权重均值×2（基底, 对齐等级语义） + 数量密度项
    （窗口内平均每任务检出数/12, 封顶+2.0）——修复"单任务站点恒为 4/6/8/10"
    的量化跳变, 同等级下垃圾越多指数越高。
    """
    conds = _task_filter(since, until, sea_area_id)
    rows = (
        db.query(DetectionTask.pollution_level, func.count())
        .filter(*conds)
        .group_by(DetectionTask.pollution_level)
        .all()
    )
    total = sum(c for _, c in rows)
    if not total:
        return 0.0
    avg = (
        sum(_level_weight(level) * c for level, c in rows)
        / total
    )
    objects_per_task = float(
        db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).filter(*conds).scalar() or 0
    ) / total
    return round(min(10.0, avg * 2 + min(2.0, objects_per_task / 12.0)), 1)


def _plastic_percent(db: Session, since, until=None, sea_area_id: int | None = None) -> float:
    """某时间窗口内塑料类目标占已分类目标的比例（%）"""
    conds = _task_filter(since, until, sea_area_id)
    rows = (
        db.query(DetectionResult.material_type, func.count())
        .join(DetectionTask, DetectionResult.task_id == DetectionTask.id)
        .filter(*conds)
        .group_by(DetectionResult.material_type)
        .all()
    )
    total = sum(c for _, c in rows)
    if not total:
        return 0.0
    plastic = sum(c for m, c in rows if m and "塑料" in m)
    return round(plastic / total * 100, 1)


def _severe_count(db: Session, since, until=None, sea_area_id: int | None = None) -> int:
    """某时间窗口内严重污染任务数"""
    return db.query(func.count()).filter(
        *_task_filter(since, until, sea_area_id),
        DetectionTask.pollution_level == PollutionLevel.severe,
    ).scalar() or 0


# 高风险判定阈值：海域近 30 天综合污染指数 ≥ 6.0（对应平均等级「中」偏上且有一定检出密度）
_HIGH_RISK_INDEX = 6.0


def _high_risk_areas(db: Session, since, until=None, sea_area_id: int | None = None) -> int:
    """某时间窗口内高风险监测海域数：综合污染指数 ≥ 阈值的海域个数（海域无任务不计入）。"""
    query = db.query(SeaArea.id)
    if sea_area_id is not None:
        query = query.filter(SeaArea.id == sea_area_id)
    count = 0
    for (area_id,) in query.all():
        index = _pollution_index(db, since, until, area_id)
        if index >= _HIGH_RISK_INDEX:
            count += 1
    return count


@router.get("/summary", response_model=FrontendSummary)
async def stats_summary(
    sea_area_id: int | None = Query(None, description="按海域过滤（侧边栏全局海域选择）；缺省为全部海域"),
    current_user: User = SUMMARY_GUARD,
    db: Session = Depends(get_db),
):
    """统计概览：从数据库聚合真实数据，映射为前端 Summary 形状。

    全部字段均来自真实数据，无硬编码：
    - totalTasks / totalObjects：检测任务累计（可按海域过滤）
    - seaAreas：sea_areas 表实际海域数（当前为 3：北戴河/秦皇岛/渤海湾）
    - coverageKm2：sea_areas.area_km2 主数据求和（过滤时为所选海域面积）
    - monthlyGrowth：本月检出目标数较上月环比（%）
    - activeAlerts（待处置预警）：近 30 天污染等级「差/严重」的已完成任务数
    """
    task_conds = [DetectionTask.sea_area_id == sea_area_id] if sea_area_id is not None else []
    total_tasks = db.query(func.count(DetectionTask.id)).filter(*task_conds).scalar() or 0
    total_objects = db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).filter(*task_conds).scalar()

    # 监测覆盖面积：海域主数据求和（过滤时为所选海域面积；area_km2 为 NULL 的历史行按 0 计）
    area_query = db.query(func.coalesce(func.sum(SeaArea.area_km2), 0.0))
    if sea_area_id is not None:
        area_query = area_query.filter(SeaArea.id == sea_area_id)
    coverage_km2 = area_query.scalar() or 0.0
    # 「覆盖监测海域」始终展示监测网络全域规模（当前为 3：北戴河/秦皇岛/渤海湾）
    sea_areas_total = db.query(func.count(SeaArea.id)).scalar() or 0

    # 月环比：本月（自然月）vs 上月检出目标数
    now = datetime.now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_month_end = month_start
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    cur_objects = db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).filter(
        *task_conds, DetectionTask.created_at >= month_start
    ).scalar() or 0
    prev_objects = db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).filter(
        *task_conds, DetectionTask.created_at >= prev_month_start, DetectionTask.created_at < prev_month_end
    ).scalar() or 0
    monthly_growth = round((int(cur_objects) - int(prev_objects)) / int(prev_objects) * 100, 1) if prev_objects else 0.0

    # 待处置预警：近 30 天污染等级「差/严重」的已完成任务数
    alert_count = db.query(func.count()).filter(
        *_task_filter(now - timedelta(days=30), None, sea_area_id),
        DetectionTask.pollution_level.in_([PollutionLevel.poor, PollutionLevel.severe]),
    ).scalar() or 0

    return FrontendSummary(
        totalTasks=total_tasks,
        totalObjects=int(total_objects),
        seaAreas=sea_areas_total,
        monthlyGrowth=monthly_growth,
        activeAlerts=alert_count,
        coverageKm2=round(float(coverage_km2), 1),
    )


@router.get("/trend", response_model=list[FrontendTrendPoint])
async def stats_trend(
    period: str = Query("month", pattern="^(week|month|year)$"),
    sea_area_id: int | None = Query(None, description="按海域过滤（侧边栏全局海域选择）；缺省为全部海域"),
    current_user: User = TREND_GUARD,
    db: Session = Depends(get_db),
):
    """趋势数据：week/month 按天分组，year 按月分组（只统计已完成任务）"""
    query = db.query(DetectionTask).filter(DetectionTask.status == TaskStatus.completed)
    if sea_area_id is not None:
        query = query.filter(DetectionTask.sea_area_id == sea_area_id)
    if period == "year":
        # 近 12 个月，按月分组
        since = datetime.now() - timedelta(days=365)
        query = query.filter(DetectionTask.created_at >= since)
        bucket = func.date_format(DetectionTask.created_at, "%Y-%m")
    elif period == "month":
        # 近 30 天，按天分组
        since = datetime.now() - timedelta(days=30)
        query = query.filter(DetectionTask.created_at >= since)
        bucket = func.date(DetectionTask.created_at)
    else:
        # 近 7 天，按天分组
        since = datetime.now() - timedelta(days=7)
        query = query.filter(DetectionTask.created_at >= since)
        bucket = func.date(DetectionTask.created_at)

    rows = (
        query.with_entities(bucket, func.count())
        .group_by(bucket)
        .order_by(bucket)
        .all()
    )

    data = [
        FrontendTrendPoint(date=str(d), count=int(c), density=round(int(c) / 60.0, 1))
        for d, c in rows
    ]
    return data


@router.get("/analysis", response_model=StatsAnalysis)
async def stats_analysis(
    sea_area_id: int | None = Query(None, description="按海域过滤（侧边栏全局海域选择）；缺省为全部海域"),
    current_user: User = TREND_GUARD,
    db: Session = Depends(get_db),
):
    """分析页聚合数据（前端 Analysis / Dashboard 共用）：
    当前窗口=近 30 天，环比窗口=前 30 天。全部基于已完成任务。"""
    now = datetime.now()
    cur_start = now - timedelta(days=30)
    prev_start = now - timedelta(days=60)
    cur_conds = _task_filter(cur_start, None, sea_area_id)

    # 近 30 天材质桶分布（数量降序）
    mat_rows = (
        db.query(DetectionResult.material_type, func.count())
        .join(DetectionTask, DetectionResult.task_id == DetectionTask.id)
        .filter(*cur_conds)
        .group_by(DetectionResult.material_type)
        .all()
    )
    buckets: dict = {}
    for material, count in mat_rows:
        bucket = _material_bucket(material)
        buckets[bucket] = buckets.get(bucket, 0) + count
    material_breakdown = dict(sorted(buckets.items(), key=lambda kv: -kv[1]))

    # 近 30 天高频类别 TOP 6
    cls_rows = (
        db.query(DetectionResult.class_name, func.count())
        .join(DetectionTask, DetectionResult.task_id == DetectionTask.id)
        .filter(*cur_conds)
        .group_by(DetectionResult.class_name)
        .order_by(func.count().desc())
        .limit(6)
        .all()
    )
    class_ranking = [ClassRankItem(name=name, count=int(count)) for name, count in cls_rows]

    # 近 30 天检出垃圾总数
    total_objects = (
        db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0))
        .filter(*cur_conds)
        .scalar()
        or 0
    )

    return StatsAnalysis(
        pollution_index=_pollution_index(db, cur_start, None, sea_area_id),
        pollution_index_prev=_pollution_index(db, prev_start, cur_start, sea_area_id),
        plastic_percent=_plastic_percent(db, cur_start, None, sea_area_id),
        plastic_percent_prev=_plastic_percent(db, prev_start, cur_start, sea_area_id),
        severe_count=_severe_count(db, cur_start, None, sea_area_id),
        severe_count_prev=_severe_count(db, prev_start, cur_start, sea_area_id),
        high_risk_areas=_high_risk_areas(db, cur_start, None, sea_area_id),
        high_risk_areas_prev=_high_risk_areas(db, prev_start, cur_start, sea_area_id),
        total_objects=int(total_objects),
        material_breakdown=material_breakdown,
        class_ranking=class_ranking,
    )


@router.get("/sea-areas", response_model=list[SeaAreaItem])
async def stats_sea_areas(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """海域列表（北戴河/秦皇岛/渤海湾）：侧边栏全局海域下拉的数据源。"""
    return db.query(SeaArea).order_by(SeaArea.id).all()


@router.get("/sites", response_model=list[SiteStatItem])
async def stats_sites(
    days: int = Query(30, ge=1, le=365, description="统计窗口（天），默认近 30 天"),
    current_user: User = SITES_GUARD,
    db: Session = Depends(get_db),
):
    """分站点聚合（F0）：所有监测站点 + 各站所在海域近 N 天已完成任务统计。

    无任务的站点照常返回（taskCount=0, pollutionIndex=null），前端据此展示空态。
    任务只存海域 id（detection_tasks.sea_area_id → sea_areas.id），故按海域聚合；
    同一海域下多个站点共享同一聚合值（item 带 seaAreaId，前端据此按海域过滤站点）。"""
    since = datetime.now() - timedelta(days=days)
    rows = (
        db.query(
            DetectionTask.sea_area_id,
            func.count(DetectionTask.id),
            func.coalesce(func.sum(DetectionTask.total_objects), 0),
            func.max(DetectionTask.completed_at),
        )
        .filter(
            DetectionTask.status == TaskStatus.completed,
            DetectionTask.sea_area_id.isnot(None),
            DetectionTask.created_at >= since,
        )
        .group_by(DetectionTask.sea_area_id)
        .all()
    )
    by_sea_area = {int(r[0]): r for r in rows}

    # 污染指数在应用层计算（避免方言相关的 SQL CASE）：各海域等级分布 → 加权平均 + 密度项
    level_rows = (
        db.query(
            DetectionTask.sea_area_id,
            DetectionTask.pollution_level,
            func.count(DetectionTask.id),
        )
        .filter(
            DetectionTask.status == TaskStatus.completed,
            DetectionTask.sea_area_id.isnot(None),
            DetectionTask.created_at >= since,
            DetectionTask.pollution_level.isnot(None),
        )
        .group_by(DetectionTask.sea_area_id, DetectionTask.pollution_level)
        .all()
    )
    weight_sum: dict[int, float] = {}
    for sea_area_id, level, cnt in level_rows:
        weight_sum[int(sea_area_id)] = (
            weight_sum.get(int(sea_area_id), 0.0)
            + _level_weight(level) * int(cnt)
        )

    # 每海域最近6个已完成任务 → 标注图/标注视频+摘要(3D场景浮窗"检测证据")
    from schemas import pollution_level_zh
    recent = (
        db.query(DetectionTask)
        .filter(
            DetectionTask.status == TaskStatus.completed,
            DetectionTask.sea_area_id.isnot(None),
            DetectionTask.created_at >= since,
        )
        .order_by(DetectionTask.id.desc())
        .limit(120)
        .all()
    )
    evidence_by_sea_area: dict[int, list[SiteEvidence]] = {}
    for t in reversed(recent):  # 旧→新, 后者覆盖保持最新在前
        if t.sea_area_id is None:
            continue
        rows = (
            db.query(DetectionResult)
            .filter(DetectionResult.task_id == t.id)
            .order_by(DetectionResult.confidence.desc())
            .all()
        )
        media = None
        video_url = None
        media_kind = "image"
        if t.task_type.value == "image":
            media = detector_svc._annotated_image_url(t.id, t.file_path, rows)
        else:
            media_kind = "video"
            # 标注视频(可回放)优先; 缺失时回退预览帧封面
            ann = _os.path.join("uploads", "video_annotated", str(t.id), "annotated.mp4")
            if _os.path.isfile(ann) and _os.path.getsize(ann) > 0:
                video_url = f"/uploads/video_annotated/{t.id}/annotated.mp4"
            pv_dir = _os.path.join("uploads", "video_preview", str(t.id))
            if _os.path.isdir(pv_dir):
                frames = sorted(f for f in _os.listdir(pv_dir) if f.endswith(".jpg"))
                if frames:
                    media = f"/uploads/video_preview/{t.id}/{frames[-1]}"
        ev = SiteEvidence(
            taskId=t.id,
            mediaUrl=media,
            mediaKind=media_kind,
            videoUrl=video_url,
            className=rows[0].class_name if rows else None,
            objectCount=t.total_objects or 0,
            level=pollution_level_zh(t.pollution_level),
            at=f"{t.completed_at:%m-%d %H:%M}" if t.completed_at else None,
        )
        lst = evidence_by_sea_area.setdefault(int(t.sea_area_id), [])
        lst.insert(0, ev)
        evidence_by_sea_area[int(t.sea_area_id)] = lst[:6]

    # 海域 id → 海域名（北戴河/秦皇岛/渤海湾），供前端按海域聚合/标注
    area_name_by_id = {a.id: a.name for a in db.query(SeaArea).all()}

    items: list[SiteStatItem] = []
    for site in db.query(MonitoringSite).order_by(MonitoringSite.code).all():
        r = by_sea_area.get(site.sea_area_id)
        sea_area_name = area_name_by_id.get(site.sea_area_id)
        if r:
            task_count = int(r[1])
            # 与 _pollution_index 同口径: 等级基底 + 平均每任务检出数量密度项(封顶+2.0)
            avg_objects = int(r[2]) / task_count
            index = round(min(10.0, weight_sum.get(site.sea_area_id, 0.0) / task_count * 2 + min(2.0, avg_objects / 12.0)), 1) if task_count else None
            # 污染指数(越高越脏) → 环境质量评分 1-10 整数(越高越好); 未检测过为 None
            quality = max(1, min(10, 11 - round(index))) if index is not None else None
            items.append(SiteStatItem(
                id=site.id, code=site.code, name=site.name, lat=site.lat, lng=site.lng,
                seaAreaId=site.sea_area_id, seaAreaName=sea_area_name,
                taskCount=task_count, totalObjects=int(r[2]),
                qualityScore=quality,
                lastTaskAt=f"{r[3]:%Y-%m-%d %H:%M}" if r[3] else None,
                evidence=evidence_by_sea_area.get(site.sea_area_id, []),
            ))
        else:
            items.append(SiteStatItem(
                id=site.id, code=site.code, name=site.name, lat=site.lat, lng=site.lng,
                seaAreaId=site.sea_area_id, seaAreaName=sea_area_name,
            ))
    return items
