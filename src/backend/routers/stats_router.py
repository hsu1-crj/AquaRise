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
from models import DetectionResult, DetectionTask, PollutionLevel, TaskStatus, User
from schemas import ClassRankItem, FrontendSummary, FrontendTrendPoint, StatsAnalysis

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])

# 污染等级 → 严重度权重（综合污染指数 = 平均权重 × 2，落在 0-10 区间）
_LEVEL_WEIGHT = {"excellent": 1, "good": 2, "moderate": 3, "poor": 4, "severe": 5}


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
    """某时间窗口内已完成任务的综合污染指数（平均严重度权重 × 2，0-10）"""
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
        sum(_LEVEL_WEIGHT.get(getattr(level, "value", str(level)), 3) * c for level, c in rows)
        / total
    )
    return round(avg * 2, 2)


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
