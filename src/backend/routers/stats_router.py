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
from models import DetectionTask, TaskStatus, User
from schemas import FrontendSummary, FrontendTrendPoint

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])


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
