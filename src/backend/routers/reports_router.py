"""
报告 API
=====================================
GET  /api/v1/reports/          报告列表（前端 FrontendReport 形状）
GET  /api/v1/reports/{id}      报告详情
POST /api/v1/reports           生成报告（JSON，前端 api.createReport）
POST /api/v1/reports/generate  生成报告（表单，兼容旧调用）
"""

import os
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Form, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import DetectionTask, Report, ReportType, User, UserRole
from schemas import (
    CreateBatchReportRequest,
    CreateReportRequest,
    FrontendReport,
    FrontendReportListResponse,
    POLLUTION_SCORE,
    ReportInfo,
    pollution_level_zh,
)

# 污染等级严重度（用于多图批量报告取"综合最差等级"）
LEVEL_SEVERITY = {"excellent": 0, "good": 1, "moderate": 2, "poor": 3, "severe": 4}

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
    # 批量报告（report_type=custom, task_id=None）：聚合信息存放在 summary 中
    if report.report_type == ReportType.custom and not report.task_id:
        m = re.match(
            r"批量报告：共 (\d+) 张图片，检出 (\d+) 个垃圾目标，综合污染等级 (\S+)，质量分 (\d+)",
            report.summary or "",
        )
        if m:
            count, object_count, level, score = int(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4))
            return FrontendReport(
                id=f"RPT-{report.id}",
                title=f"多图批量识别质量报告（{count} 张）",
                area="近岸监测点",
                createdAt=f"{report.created_at:%Y-%m-%d %H:%M}" if report.created_at else "",
                level=level,
                score=score,
                objectCount=object_count,
                status="已生成",
                summary=report.summary or "",
            )

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


def _build_batch_report_html(tasks: list[DetectionTask]) -> str:
    """聚合多张图片的检测结果，生成一份合并 HTML 报告"""
    total_objects = sum(t.total_objects for t in tasks)
    rows = ""
    for i, task in enumerate(tasks, 1):
        level = pollution_level_zh(task.pollution_level)
        rows += (
            f"<tr><td>{i}</td><td>{task.file_name}</td>"
            f"<td>{task.total_objects}</td><td>{level}</td>"
            f"<td>{task.completed_at or '-'}</td></tr>"
        )
    worst = max(
        (t.pollution_level.value for t in tasks if t.pollution_level),
        key=lambda v: LEVEL_SEVERITY.get(v, 0),
        default="excellent",
    )
    level = pollution_level_zh(worst)
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>多图批量识别质量报告</title>
<style>
body{{font-family:'Microsoft YaHei',sans-serif;max-width:820px;margin:24px auto;color:#1c2b36}}
h1{{color:#0b6d8f;border-bottom:2px solid #0b6d8f;padding-bottom:10px}}
table{{width:100%;border-collapse:collapse;margin:18px 0}}
th,td{{border:1px solid #cfe0ea;padding:9px 12px;text-align:left;font-size:14px}}
th{{background:#eaf6fb}}
.summary{{display:flex;gap:22px;flex-wrap:wrap;padding:14px 16px;background:#f2f9fd;border:1px solid #cfe0ea;border-radius:8px}}
.summary div{{flex:1;min-width:130px}}
.summary strong{{display:block;font-size:22px;color:#0b6d8f}}
.summary span{{font-size:12px;color:#5a7385}}
small{{color:#8aa3b3}}
</style></head><body>
<h1>🌊 多图批量识别质量报告</h1>
<p><b>涉及图片：</b>{len(tasks)} 张</p>
<div class="summary">
<div><span>检出垃圾总数</span><strong>{total_objects}</strong></div>
<div><span>综合污染等级</span><strong>{level}</strong></div>
<div><span>质量分</span><strong>{POLLUTION_SCORE.get(worst, 68)}</strong></div>
</div>
<table>
<tr><th>#</th><th>文件名</th><th>检出目标</th><th>污染等级</th><th>完成时间</th></tr>
{rows}
</table>
<hr><p><small>本报告由海洋污染分析系统自动生成（测试版）</small></p>
</body></html>"""


def _generate_batch_report(db: Session, tasks: list[DetectionTask], user_id: int, report_type: str) -> Report:
    """按多张图片聚合生成一份 HTML 报告 + 一条 reports 记录，返回 Report"""
    os.makedirs("reports", exist_ok=True)
    path = f"reports/report_batch_{int(datetime.now().timestamp())}.html"
    with open(path, "w", encoding="utf-8") as f:
        f.write(_build_batch_report_html(tasks))

    total_objects = sum(t.total_objects for t in tasks)
    worst = max(
        (t.pollution_level.value for t in tasks if t.pollution_level),
        key=lambda v: LEVEL_SEVERITY.get(v, 0),
        default="excellent",
    )
    level = pollution_level_zh(worst)
    score = POLLUTION_SCORE.get(str(worst), 68)
    summary = f"批量报告：共 {len(tasks)} 张图片，检出 {total_objects} 个垃圾目标，综合污染等级 {level}，质量分 {score}"

    report = Report(
        task_id=None,
        user_id=user_id,
        report_type=ReportType.custom,
        report_path=path,
        summary=summary,
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


@router.post("/batch", response_model=FrontendReport)
async def create_batch_report(
    body: CreateBatchReportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """多图批量报告：基于多张图片的检测任务聚合生成一份报告"""
    if not body.task_ids:
        raise HTTPException(status_code=400, detail="至少需要一张图片")
    tasks = (
        db.query(DetectionTask)
        .filter(DetectionTask.id.in_(body.task_ids), DetectionTask.user_id == current_user.id)
        .all()
    )
    if len(tasks) != len(set(body.task_ids)):
        raise HTTPException(status_code=404, detail="部分任务不存在或无权访问")
    report = _generate_batch_report(db, tasks, current_user.id, body.format)
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
