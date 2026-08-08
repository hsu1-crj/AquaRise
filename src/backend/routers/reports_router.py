"""
报告 API
=====================================
GET  /api/v1/reports/          报告列表（前端 FrontendReport 形状）
GET  /api/v1/reports/{id}      报告详情
POST /api/v1/reports           生成报告（JSON，前端 api.createReport）
POST /api/v1/reports/generate  生成报告（表单，兼容旧调用）
"""

import os
from datetime import datetime

from fastapi import APIRouter, Depends, Form, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import DetectionTask, Report, ReportType, User, UserRole
from schemas import (
    CreateReportRequest,
    FrontendReport,
    FrontendReportListResponse,
    POLLUTION_SCORE,
    ReportInfo,
    pollution_level_zh,
)

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


def _build_report_html(task: DetectionTask) -> str:
    """生成一份简单的 HTML 报告"""
    level = pollution_level_zh(task.pollution_level)
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>海域污染评估报告</title></head><body>
<h1>🌊 海域污染评估报告</h1>
<p><b>任务ID：</b>{task.id}</p>
<p><b>文件名：</b>{task.file_name}</p>
<p><b>任务类型：</b>{task.task_type.value}</p>
<p><b>检出垃圾总数：</b>{task.total_objects}</p>
<p><b>污染等级：</b>{level}</p>
<p><b>处理耗时：</b>{task.processing_time or 0}s</p>
<p><b>完成时间：</b>{task.completed_at}</p>
<hr><p><small>本报告由海洋污染分析系统自动生成（测试版）</small></p>
</body></html>"""


def _to_frontend_report(report: Report) -> FrontendReport:
    """Report ORM → 前端 FrontendReport 形状（title/area/score 由关联任务推导）"""
    task = (
        report.task
        if hasattr(report, "task")
        else None
    )
    level_raw = task.pollution_level.value if (task and task.pollution_level) else None
    level = pollution_level_zh(level_raw)
    object_count = task.total_objects if task else 0
    area = "近岸监测点"
    title = f"任务 {report.task_id or '-'} 海域污染质量报告"
    if task and task.file_name:
        base = os.path.splitext(os.path.basename(task.file_name))[0]
        if base:
            title = f"{base} 海域污染质量报告"
    return FrontendReport(
        id=f"RPT-{report.id}",
        title=title,
        area=area,
        createdAt=f"{report.created_at:%Y-%m-%d %H:%M}" if report.created_at else "",
        level=level,
        score=POLLUTION_SCORE.get(str(level_raw), 68),
        objectCount=object_count,
        status="已生成",
        summary=report.summary or "",
    )


@router.get("/", response_model=FrontendReportListResponse)
async def list_reports(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """报告列表：普通用户看自己的，管理员看全部"""
    query = db.query(Report)
    if current_user.role != UserRole.admin:
        query = query.filter(Report.user_id == current_user.id)
    rows = query.order_by(Report.id.desc()).all()
    items = [_to_frontend_report(r) for r in rows]
    return FrontendReportListResponse(items=items, total=len(items))


@router.get("/{report_id}", response_model=ReportInfo)
async def get_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """报告详情"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if current_user.role != UserRole.admin and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限查看该报告")
    return ReportInfo.model_validate(report)


def _resolve_report_type(format_value: str) -> ReportType:
    """前端 format（html 等）→ 合法 ReportType，非法值回退 single"""
    try:
        return ReportType(format_value)
    except ValueError:
        return ReportType.single


def _generate_report_for_task(db: Session, task: DetectionTask, user_id: int, report_type: str) -> Report:
    """生成 HTML 报告文件 + 写 reports 表，返回 Report"""
    os.makedirs("reports", exist_ok=True)
    path = f"reports/report_task{task.id}_{int(datetime.now().timestamp())}.html"
    with open(path, "w", encoding="utf-8") as f:
        f.write(_build_report_html(task))

    report = Report(
        task_id=task.id,
        user_id=user_id,
        report_type=_resolve_report_type(report_type),
        report_path=path,
        summary=f"任务 {task.id}（{task.file_name}）共检出 {task.total_objects} 个垃圾",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


@router.post("/", response_model=FrontendReport)
async def create_report(
    body: CreateReportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为指定检测任务生成报告（JSON，前端 api.createReport 调用）"""
    task = (
        db.query(DetectionTask)
        .filter(DetectionTask.id == body.task_id, DetectionTask.user_id == current_user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    report = _generate_report_for_task(db, task, current_user.id, body.format)
    return _to_frontend_report(report)


@router.post("/generate", response_model=ReportInfo)
async def generate_report(
    task_id: int = Form(...),
    report_type: str = Form("single"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为指定检测任务生成报告（表单，兼容旧调用）"""
    task = (
        db.query(DetectionTask)
        .filter(DetectionTask.id == task_id, DetectionTask.user_id == current_user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    report = _generate_report_for_task(db, task, current_user.id, report_type)
    return ReportInfo.model_validate(report)
