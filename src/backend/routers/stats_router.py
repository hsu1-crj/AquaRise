"""
统计 API
=====================================
GET /api/v1/stats/summary   统计概览（任务数/垃圾总数/污染分布/材质分布）
GET /api/v1/stats/trend     趋势数据（?period=week|month|year）
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import DetectionResult, DetectionTask, MonitoringSite, PollutionLevel, TaskStatus, User
from schemas import (ClassRankItem, FrontendSummary, FrontendTrendPoint, SiteEvidence,
                    SiteStatItem, StatsAnalysis)
from services import detector as detector_svc

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])

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


def _pollution_index(db: Session, since, until=None) -> float:
    """某时间窗口的综合污染指数（0-10）。

    连续化公式: 等级权重均值×2（基底, 对齐等级语义） + 数量密度项
    （窗口内平均每任务检出数/12, 封顶+2.0）——修复"单任务站点恒为 4/6/8/10"
    的量化跳变, 同等级下垃圾越多指数越高。
    """
    q = (
        db.query(DetectionTask.pollution_level, func.count())
        .filter(DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= since)
    )
    if until:
        q = q.filter(DetectionTask.created_at < until)
    rows = q.group_by(DetectionTask.pollution_level).all()
    total = sum(c for _, c in rows)
    if not total:
        return 0.0
    avg = (
        sum(_level_weight(level) * c for level, c in rows)
        / total
    )
    obj_q = db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).filter(
        DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= since
    )
    if until:
        obj_q = obj_q.filter(DetectionTask.created_at < until)
    objects_per_task = float(obj_q.scalar() or 0) / total
    return round(min(10.0, avg * 2 + min(2.0, objects_per_task / 12.0)), 1)


def _plastic_percent(db: Session, since, until=None) -> float:
    """某时间窗口内塑料类目标占已分类目标的比例（%）"""
    q = (
        db.query(DetectionResult.material_type, func.count())
        .join(DetectionTask, DetectionResult.task_id == DetectionTask.id)
        .filter(DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= since)
    )
    if until:
        q = q.filter(DetectionTask.created_at < until)
    rows = q.group_by(DetectionResult.material_type).all()
    total = sum(c for _, c in rows)
    if not total:
        return 0.0
    plastic = sum(c for m, c in rows if m and "塑料" in m)
    return round(plastic / total * 100, 1)


def _severe_count(db: Session, since, until=None) -> int:
    """某时间窗口内严重污染任务数"""
    q = db.query(func.count()).filter(
        DetectionTask.status == TaskStatus.completed,
        DetectionTask.pollution_level == PollutionLevel.severe,
        DetectionTask.created_at >= since,
    )
    if until:
        q = q.filter(DetectionTask.created_at < until)
    return q.scalar() or 0


@router.get("/summary", response_model=FrontendSummary)
async def stats_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """统计概览：从数据库聚合真实数据，映射为前端 Summary 形状"""
    total_tasks = db.query(func.count(DetectionTask.id)).scalar() or 0
    total_objects = db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0)).scalar()

    return FrontendSummary(
        totalTasks=total_tasks,
        totalObjects=int(total_objects),
    )


@router.get("/trend", response_model=list[FrontendTrendPoint])
async def stats_trend(
    period: str = Query("week", pattern="^(week|month|year)$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """趋势数据：week/month 按天分组，year 按月分组（只统计已完成任务）"""
    query = db.query(DetectionTask).filter(DetectionTask.status == TaskStatus.completed)

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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """分析页聚合数据（前端 Analysis / Dashboard 共用）：
    当前窗口=近 30 天，环比窗口=前 30 天。全部基于已完成任务。"""
    now = datetime.now()
    cur_start = now - timedelta(days=30)
    prev_start = now - timedelta(days=60)

    # 近 30 天材质桶分布（数量降序）
    mat_rows = (
        db.query(DetectionResult.material_type, func.count())
        .join(DetectionTask, DetectionResult.task_id == DetectionTask.id)
        .filter(DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= cur_start)
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
        .filter(DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= cur_start)
        .group_by(DetectionResult.class_name)
        .order_by(func.count().desc())
        .limit(6)
        .all()
    )
    class_ranking = [ClassRankItem(name=name, count=int(count)) for name, count in cls_rows]

    # 近 30 天检出垃圾总数
    total_objects = (
        db.query(func.coalesce(func.sum(DetectionTask.total_objects), 0))
        .filter(DetectionTask.status == TaskStatus.completed, DetectionTask.created_at >= cur_start)
        .scalar()
        or 0
    )

    return StatsAnalysis(
        pollution_index=_pollution_index(db, cur_start),
        pollution_index_prev=_pollution_index(db, prev_start, cur_start),
        plastic_percent=_plastic_percent(db, cur_start),
        plastic_percent_prev=_plastic_percent(db, prev_start, cur_start),
        severe_count=_severe_count(db, cur_start),
        severe_count_prev=_severe_count(db, prev_start, cur_start),
        total_objects=int(total_objects),
        material_breakdown=material_breakdown,
        class_ranking=class_ranking,
    )


@router.get("/sites", response_model=list[SiteStatItem])
async def stats_sites(
    days: int = Query(30, ge=1, le=365, description="统计窗口（天），默认近 30 天"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """分站点聚合（F0）：所有监测站点 + 各站近 N 天已完成任务统计。

    无任务的站点照常返回（taskCount=0, pollutionIndex=null），前端据此展示空态。
    detection_tasks.sea_area_id 为软外键，此处在应用层按站点分组。"""
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
    by_site = {int(r[0]): r for r in rows}

    # 污染指数在应用层计算（避免方言相关的 SQL CASE）：各站点等级分布 → 加权平均 × 2
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
    for site_id, level, cnt in level_rows:
        weight_sum[int(site_id)] = (
            weight_sum.get(int(site_id), 0.0)
            + _level_weight(level) * int(cnt)
        )

    # 每站点最近3个已完成任务 → 标注图URL+摘要(3D场景浮窗"检测证据")
    from schemas import pollution_level_zh
    recent = (
        db.query(DetectionTask)
        .filter(
            DetectionTask.status == TaskStatus.completed,
            DetectionTask.sea_area_id.isnot(None),
            DetectionTask.created_at >= since,
        )
        .order_by(DetectionTask.id.desc())
        .limit(60)
        .all()
    )
    evidence_by_site: dict[int, list[SiteEvidence]] = {}
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
        if t.task_type.value == "image":
            media = detector_svc._annotated_image_url(t.id, t.file_path, rows)
        else:
            import os as _os
            pv_dir = _os.path.join("uploads", "video_preview", str(t.id))
            if _os.path.isdir(pv_dir):
                frames = sorted(f for f in _os.listdir(pv_dir) if f.endswith(".jpg"))
                if frames:
                    media = f"/uploads/video_preview/{t.id}/{frames[-1]}"
        ev = SiteEvidence(
            taskId=t.id,
            mediaUrl=media,
            className=rows[0].class_name if rows else None,
            objectCount=t.total_objects or 0,
            level=pollution_level_zh(t.pollution_level),
            at=f"{t.completed_at:%m-%d %H:%M}" if t.completed_at else None,
        )
        lst = evidence_by_site.setdefault(int(t.sea_area_id), [])
        lst.insert(0, ev)
        evidence_by_site[int(t.sea_area_id)] = lst[:3]

    items: list[SiteStatItem] = []
    for site in db.query(MonitoringSite).order_by(MonitoringSite.code).all():
        r = by_site.get(site.id)
        if r:
            task_count = int(r[1])
            # 与 _pollution_index 同口径: 等级基底 + 平均每任务检出数量密度项(封顶+2.0)
            avg_objects = int(r[2]) / task_count
            index = round(min(10.0, weight_sum.get(site.id, 0.0) / task_count * 2 + min(2.0, avg_objects / 12.0)), 1) if task_count else None
            items.append(SiteStatItem(
                id=site.id, code=site.code, name=site.name, lat=site.lat, lng=site.lng,
                taskCount=task_count, totalObjects=int(r[2]),
                pollutionIndex=index,
                lastTaskAt=f"{r[3]:%Y-%m-%d %H:%M}" if r[3] else None,
                evidence=evidence_by_site.get(site.id, []),
            ))
        else:
            items.append(SiteStatItem(
                id=site.id, code=site.code, name=site.name, lat=site.lat, lng=site.lng,
            ))
    return items
