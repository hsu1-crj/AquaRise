"""
报告 API
=====================================
GET  /api/v1/reports/          报告列表（前端 FrontendReport 形状）
GET  /api/v1/reports/{id}      报告详情
POST /api/v1/reports           生成报告（JSON，前端 api.createReport）
POST /api/v1/reports/generate  生成报告（表单，兼容旧调用）
"""

import html
import json
import os
import re
from collections import Counter
from datetime import datetime

from fastapi import APIRouter, Depends, Form, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from auth import is_privileged, require_permission
from database import get_db
from models import DetectionResult, DetectionTask, Report, ReportAnalysis, ReportType, SeaArea, User
from schemas import (
    CreateBatchReportRequest,
    CreateComprehensiveReportRequest,
    CreateReportRequest,
    FrontendReport,
    FrontendReportListResponse,
    POLLUTION_SCORE,
    ReportInfo,
    ReportAnalysisResponse,
    ReportSolution,
    pollution_level_zh,
)
from services.notification_hub import notify

# 污染等级严重度（用于多图批量报告取"综合最差等级"）
LEVEL_SEVERITY = {"excellent": 0, "good": 1, "moderate": 2, "poor": 3, "severe": 4}

# 污染等级 → 文字说明与治理建议（用于报告正文）
LEVEL_SUMMARY = {
    "excellent": "本监测范围内未检出或极少垃圾目标，海域整体处于优良状态，近岸水质与生态保持健康。",
    "good": "本监测范围检出少量垃圾目标，污染程度轻微，对海洋生态影响有限，建议继续保持常态化监测。",
    "moderate": "本监测范围检出处于中等水平的垃圾目标，存在一定污染风险，建议针对高频类别开展重点清理与溯源。",
    "poor": "本监测范围垃圾目标密度偏高，污染状况已较为明显，建议列为重点巡查区域并安排专项清理作业。",
    "severe": "本监测范围检出大量垃圾目标，污染严重，已构成对海洋生态的直接威胁，建议立即启动应急清理与全面整治。",
}
# 污染等级 → 治理建议（逐条，用于报告给出可执行动作）
LEVEL_ADVICE = {
    "excellent": ["继续保持现有监测频率，定期抽样复核", "对识别到的零星垃圾安排随巡清理"],
    "good": ["维持月度巡检，关注垃圾密度变化趋势", "对高频出现的垃圾类别加强源头管控"],
    "moderate": ["提高监测频次至半月一次", "针对高频垃圾类别制定专项打捞计划", "结合水文条件排查可能的陆源输入通道"],
    "poor": ["将本海域列为重点巡查区域，每周巡检", "组织专项清理，优先处置高密度类别", "向上游与沿岸排放点溯源并推动整改"],
    "severe": ["立即启动应急清理并设置临时拦截装置", "协调多部门联合整治与水域封控评估", "建立每日监测与整改跟踪机制，直至等级回落"],
}

# 报告页共用的内联样式（海洋主题，离线可用，不依赖外部资源）
_PAGE_STYLE = """
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Microsoft YaHei','PingFang SC',sans-serif;background:#eef6fb;color:#1c2b36;padding:24px 12px;line-height:1.6}
.page{max-width:900px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(11,109,143,.12);overflow:hidden}
.hero{background:linear-gradient(135deg,#0b6d8f 0%,#1a9bb5 60%,#3fbfc9 100%);color:#fff;padding:26px 30px}
.hero h1{font-size:23px;font-weight:700;letter-spacing:1px}
.hero .sub{font-size:13px;opacity:.85;margin-top:6px}
.hero .meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px}
.hero .chip{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);padding:3px 10px;border-radius:20px}
.body{padding:26px 30px 30px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:14px;margin-bottom:26px}
.card{background:#f4fafd;border:1px solid #d7eaf4;border-radius:10px;padding:16px 14px;text-align:center}
.card .num{font-size:26px;font-weight:700;color:#0b6d8f}
.card .lbl{font-size:12px;color:#5a7385;margin-top:4px}
.card .lvl{font-size:17px;font-weight:700;padding:4px 12px;border-radius:16px;display:inline-block;color:#fff}
.lvl-excellent{background:#2ea86b}.lvl-good{background:#4cae4c}.lvl-moderate{background:#e8a23d}.lvl-poor{background:#e0763a}.lvl-severe{background:#d6453d}
section{margin-bottom:26px}
section h2{font-size:16px;color:#0b6d8f;border-left:4px solid #1a9bb5;padding-left:10px;margin-bottom:14px}
.hbar-row{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.hbar-lbl{width:150px;font-size:13px;text-align:right;flex-shrink:0;color:#33475a}
.hbar-track{flex:1;background:#eaf3f9;border-radius:6px;height:18px;overflow:hidden}
.hbar-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,#1a9bb5,#3fbfc9);transition:width .4s}
.hbar-val{width:96px;font-size:12px;color:#5a7385;flex-shrink:0}
table{width:100%;border-collapse:collapse;margin:6px 0}
th,td{border:1px solid #d7eaf4;padding:9px 11px;text-align:left;font-size:13px}
th{background:#eaf6fb;color:#0b6d8f;white-space:nowrap}
tr:nth-child(even){background:#f7fbfd}
.conf{min-width:150px}
.conf .bar{height:8px;background:#eaf3f9;border-radius:5px;overflow:hidden;width:100%}
.conf .bar i{display:block;height:100%;background:linear-gradient(90deg,#2ea86b,#3fbfc9)}
.notice{background:#fff8ec;border:1px solid #f0d9a8;border-left:4px solid #e8a23d;border-radius:8px;padding:14px 16px;font-size:13px;margin-top:14px}
.notice b{color:#b0781a}
.notice ul{margin:8px 0 0 18px}
.notice li{margin-bottom:4px}
.empty{color:#8aa3b3;font-size:13px;padding:14px;text-align:center;background:#f8fbfd;border:1px dashed #cfe0ea;border-radius:8px}
.foot{background:#f4fafd;border-top:1px solid #d7eaf4;padding:14px 30px;font-size:11px;color:#8aa3b3;text-align:center}
"""

# 移动端窄屏适配：收敛固定宽度/内边距，明细表改表内横向滚动，
# 避免整页宽度溢出（360px 手机上 6 列明细表最小宽度约 460px，会撑破页面导致缩放异常）。
_MOBILE_CSS = """
/*mobile-adapt*/
@media (max-width:600px){
  body{padding:12px 4px}
  .page{border-radius:10px;box-shadow:none}
  .hero{padding:20px 16px}
  .hero h1{font-size:20px}
  .hero .sub{font-size:12px}
  .body{padding:20px 14px}
  .cards{grid-template-columns:repeat(auto-fit,minmax(106px,1fr));gap:10px}
  .card{padding:14px 8px}
  .card .num{font-size:22px}
  section h2{font-size:15px}
  .hbar-lbl{width:96px;font-size:12px}
  .hbar-val{width:78px;font-size:11px}
  th,td{padding:7px 6px;font-size:12px}
  th{white-space:normal}
  .conf{min-width:80px}
  table{display:block;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .foot{padding:12px 16px}
}
"""

# 检测报告是否已内嵌移动端样式（注入时用，避免对同一份 HTML 重复插入）
_MOBILE_MARKER = "/*mobile-adapt*/"


def _with_mobile_override(content: str) -> str:
    """旧报告文件落盘时不含窄屏适配样式，返回前补注入，保证手机端不整页横向溢出。"""
    if _MOBILE_MARKER in content or "</head>" not in content:
        return content
    return content.replace("</head>", f"<style>{_MOBILE_CSS}</style></head>", 1)


router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


def _level_class(level_raw: str | None) -> str:
    """英文污染等级 → 徽标 CSS 类名"""
    v = getattr(level_raw, "value", level_raw)
    return f"lvl-{v}" if v in LEVEL_SEVERITY else "lvl-good"


def _result_stats(task: DetectionTask) -> dict:
    """从任务的逐目标检测结果汇总出：类别分布、材质分布、置信度统计"""
    results = list(task.results or [])
    class_counter: Counter = Counter()
    material_counter: Counter = Counter()
    confs: list[float] = []
    for r in results:
        class_counter[r.class_name or "未知"] += 1
        if r.material_type:
            material_counter[r.material_type] += 1
        if r.confidence is not None:
            confs.append(r.confidence)
    total = sum(class_counter.values()) or 1
    return {
        "results": results,
        "class_counter": class_counter,
        "class_total": total,
        "material_counter": material_counter,
        "confs": confs,
    }


def _build_category_bars(counter: Counter, color: str = "linear-gradient(90deg,#1a9bb5,#3fbfc9)") -> str:
    """类别/材质分布 → CSS 横向条形图 HTML"""
    if not counter:
        return '<div class="empty">暂无明细数据</div>'
    total = sum(counter.values()) or 1
    rows = ""
    for name, count in counter.most_common():
        pct = count / total * 100
        rows += (
            f'<div class="hbar-row"><div class="hbar-lbl">{html.escape(str(name))}</div>'
            f'<div class="hbar-track"><div class="hbar-fill" style="width:{pct:.1f}%;'
            f'background:{color}"></div></div>'
            f'<div class="hbar-val">{count} 个 · {pct:.1f}%</div></div>'
        )
    return rows


def _build_result_table(results) -> str:
    """逐目标明细表的行"""
    rows = ""
    for i, r in enumerate(results, 1):
        conf = r.confidence or 0
        pct = round(conf * 100)
        pos = ""
        if r.bbox_x1 is not None and r.bbox_y1 is not None:
            pos = f"x:{r.bbox_x1:.0f},y:{r.bbox_y1:.0f}"
        rows += (
            f"<tr><td>{i}</td><td>{html.escape(str(r.class_name or '-'))}</td>"
            f'<td><div class="conf"><div class="bar"><i style="width:{pct}%"></i></div></div>'
            f'{pct:.0f}%</td>'
            f"<td>{html.escape(str(r.material_type or '-'))}</td>"
            f"<td>{html.escape(pos or '-')}</td>"
            f"<td>{r.frame_index}</td></tr>"
        )
    return rows


def _build_level_notice(level_raw: str | None) -> str:
    """污染等级说明 + 治理建议块"""
    v = getattr(level_raw, "value", level_raw)
    summary = LEVEL_SUMMARY.get(str(v), LEVEL_SUMMARY["good"])
    advice = LEVEL_ADVICE.get(str(v), LEVEL_ADVICE["good"])
    items = "".join(f"<li>{html.escape(str(a))}</li>" for a in advice)
    return (
        f'<div class="notice"><b>评定说明：</b>{html.escape(str(summary))}'
        f"<ul>{items}</ul></div>"
    )


def _build_report_html(task: DetectionTask, sea_area_name: str = "近岸监测点") -> str:
    """生成一份信息丰富的 HTML 检测报告"""
    level_raw = task.pollution_level.value if task.pollution_level else None
    level = pollution_level_zh(level_raw)
    score = POLLUTION_SCORE.get(str(level_raw), 68)
    stats = _result_stats(task)
    class_total = stats["class_total"]
    category_count = len(stats["class_counter"])

    avg_conf = sum(stats["confs"]) / len(stats["confs"]) if stats["confs"] else 0
    max_conf = max(stats["confs"]) if stats["confs"] else 0

    material_bars = _build_category_bars(
        stats["material_counter"], "linear-gradient(90deg,#c0782e,#e0a04a)"
    )
    conf_bins = (
        ("≥80%", sum(1 for c in stats["confs"] if c >= 0.8)),
        ("60%~80%", sum(1 for c in stats["confs"] if 0.6 <= c < 0.8)),
        ("&lt;60%", sum(1 for c in stats["confs"] if c < 0.6)),
    )

    # 类别分布（无结果时给占位）
    if stats["results"]:
        category_section = _build_category_bars(stats["class_counter"])
        table_section = (
            "<table><tr><th>#</th><th>目标类别</th><th>置信度</th>"
            "<th>材质</th><th>位置(x,y)</th><th>帧号</th></tr>"
            f"{_build_result_table(stats['results'])}</table>"
        )
        conf_rows = "".join(
            f"<tr><td>{lb}</td><td>{cnt}</td></tr>" for lb, cnt in conf_bins
        )
        conf_table = (
            "<table><tr><th>置信度区间</th><th>目标数量</th></tr>"
            f"{conf_rows}</table>"
        )
    else:
        category_section = '<div class="empty">该任务没有逐目标明细数据</div>'
        table_section = '<div class="empty">无明细数据</div>'
        conf_table = '<div class="empty">无置信度数据</div>'

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>海域污染评估报告 - {html.escape(str(task.file_name or "未命名任务"))}</title>
<style>{_PAGE_STYLE}
{_MOBILE_CSS}</style></head><body>
<div class="page">
<div class="hero">
<h1>🌊 海域污染评估报告</h1>
<div class="sub">水下垃圾自动识别 · 海洋污染分析系统</div>
<div class="meta">
<span class="chip">任务ID：{task.id}</span>
<span class="chip">监测海域：{html.escape(str(sea_area_name))}</span>
<span class="chip">类型：{'视频' if task.task_type.value == 'video' else '图片'}</span>
</div>
</div>
<div class="body">
<div class="cards">
<div class="card"><div class="num">{task.total_objects}</div><div class="lbl">检出垃圾总数</div></div>
<div class="card"><div class="lvl {_level_class(level_raw)}">{level}</div><div class="lbl" style="margin-top:8px">污染等级</div></div>
<div class="card"><div class="num">{score}</div><div class="lbl">环境质量分</div></div>
<div class="card"><div class="num">{avg_conf*100:.0f}%</div><div class="lbl">平均置信度</div></div>
<div class="card"><div class="num">{category_count}</div><div class="lbl">检出类别数</div></div>
<div class="card"><div class="num">{task.processing_time or 0}s</div><div class="lbl">处理耗时</div></div>
</div>

<section>
<h2>📊 垃圾类别分布</h2>
{category_section}
</section>

<section>
<h2>🧱 材质构成</h2>
{material_bars}
</section>

<section>
<h2>🎯 置信度统计</h2>
{conf_table}
</section>

<section>
<h2>🔍 目标明细</h2>
{table_section}
</section>

<section>
<h2>📝 评估结论与治理建议</h2>
{_build_level_notice(level_raw)}
</section>

<section>
<h2>ℹ️ 基本信息</h2>
<table>
<tr><th>源文件</th><td>{html.escape(str(task.file_name or "-"))}</td></tr>
<tr><th>任务类型</th><td>{html.escape(str(task.task_type.value if task.task_type else "-"))}</td></tr>
<tr><th>检测目标数</th><td>{class_total}（逐目标明细）/ {task.total_objects}（任务计数）</td></tr>
<tr><th>最高置信度</th><td>{max_conf*100:.0f}%</td></tr>
<tr><th>处理耗时</th><td>{task.processing_time or 0}s</td></tr>
<tr><th>完成时间</th><td>{html.escape(str(task.completed_at or "-"))}</td></tr>
</table>
</section>
</div>
<div class="foot">本报告由水下垃圾自动识别与海洋污染分析系统自动生成</div>
</div>
</body></html>"""


def _to_frontend_report(report: Report, area_names: dict[int, str] | None = None) -> FrontendReport:
    """Report ORM → 前端 FrontendReport 形状（title/area/score 由关联任务推导，海域按归属数据填充）"""
    names = area_names or {}
    sea_area_id = report.sea_area_id or (report.task.sea_area_id if report.task else None)
    sea_area_name = names.get(sea_area_id) if sea_area_id else None
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
                area=sea_area_name or "近岸监测点",
                createdAt=f"{report.created_at:%Y-%m-%d %H:%M}" if report.created_at else "",
                level=level,
                score=score,
                objectCount=object_count,
                status="已生成",
                summary=report.summary or "",
                reportUrl=f"/api/v1/reports/{report.id}/preview",
                seaAreaId=sea_area_id,
                seaAreaName=sea_area_name,
            )
        m2 = re.match(
            r"综合报告：汇总 (\d+) 份报告，检出 (\d+) 个垃圾目标，综合污染等级 (\S+)，平均质量分 (\d+)",
            report.summary or "",
        )
        if m2:
            count, object_count, level, score = int(m2.group(1)), int(m2.group(2)), m2.group(3), int(m2.group(4))
            return FrontendReport(
                id=f"RPT-{report.id}",
                title=f"综合质量评估报告（{count} 份）",
                area=sea_area_name or "多区汇总",
                createdAt=f"{report.created_at:%Y-%m-%d %H:%M}" if report.created_at else "",
                level=level,
                score=score,
                objectCount=object_count,
                status="已生成",
                summary=report.summary or "",
                reportUrl=f"/api/v1/reports/{report.id}/preview",
                seaAreaId=sea_area_id,
                seaAreaName=sea_area_name,
            )

    task = (
        report.task
        if hasattr(report, "task")
        else None
    )
    level_raw = task.pollution_level.value if (task and task.pollution_level) else None
    level = pollution_level_zh(level_raw)
    object_count = task.total_objects if task else 0
    area = sea_area_name or "近岸监测点"
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
        reportUrl=f"/api/v1/reports/{report.id}/preview",
        seaAreaId=sea_area_id,
        seaAreaName=sea_area_name,
    )



@router.get("/", response_model=FrontendReportListResponse)
async def list_reports(
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """报告列表：普通用户看自己的，管理员看全部"""
    query = db.query(Report)
    if not is_privileged(db, current_user):
        query = query.filter(Report.user_id == current_user.id)
    rows = query.order_by(Report.id.desc()).all()
    area_names = {a.id: a.name for a in db.query(SeaArea).all()}
    items = [_to_frontend_report(r, area_names) for r in rows]
    return FrontendReportListResponse(items=items, total=len(items))


@router.get("/{report_id}", response_model=ReportInfo)
async def get_report(
    report_id: int,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """报告详情"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if not is_privileged(db, current_user) and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限查看该报告")
    return ReportInfo.model_validate(report)


@router.get("/{report_id}/preview", response_class=HTMLResponse)
async def preview_report(
    report_id: int,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """在线预览：返回与该报告对应的 HTML 报告文件内容。"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if not is_privileged(db, current_user) and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限查看该报告")
    if not report.report_path:
        raise HTTPException(status_code=404, detail="报告文件缺失")
    html_path = os.path.abspath(report.report_path)
    if not os.path.isfile(html_path):
        raise HTTPException(status_code=404, detail="报告文件不存在")
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()
    return HTMLResponse(content=_with_mobile_override(content))


@router.delete("/{report_id}")
async def delete_report(
    report_id: int,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """删除报告：同时删除数据库记录与磁盘上的 HTML 报告文件。"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if not is_privileged(db, current_user) and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限删除该报告")
    if report.report_path:
        html_path = os.path.abspath(report.report_path)
        if os.path.isfile(html_path):
            try:
                os.remove(html_path)
            except OSError:
                pass
    db.delete(report)
    db.commit()
    return {"detail": "报告已删除", "id": report_id}


def _analysis_for_task(task: DetectionTask, results: list[DetectionResult]) -> dict:
    """从检测事实生成结构化分析；不让模型改写数量、等级和置信度。"""
    level_raw = getattr(task.pollution_level, "value", task.pollution_level) or "excellent"
    level = pollution_level_zh(level_raw)
    risk = {"优": "低", "良": "低", "中": "中", "差": "高", "严重": "极高"}.get(level, "中")
    low_conf = [r for r in results if float(r.confidence or 0) < 0.7]
    by_class: dict[str, int] = {}
    by_material: dict[str, int] = {}
    for row in results:
        by_class[row.class_name] = by_class.get(row.class_name, 0) + 1
        material = row.material_type or "未知"
        by_material[material] = by_material.get(material, 0) + 1
    top = sorted(by_class.items(), key=lambda item: (-item[1], item[0]))[:3]
    findings = [
        f"本次共识别 {int(task.total_objects or 0)} 个垃圾目标，污染等级为“{level}”，风险级别为“{risk}”。",
    ]
    if top:
        findings.append("高频类别为：" + "、".join(f"{name}（{count}）" for name, count in top) + "。")
    if low_conf:
        findings.append(f"有 {len(low_conf)} 个目标置信度低于 70%，不宜直接作为正式统计结论。")
    causes = []
    if any("渔网" in name or "绳" in name for name in by_class):
        causes.append("可能存在废弃渔具或缠绕类垃圾持续输入，应结合渔业活动和潮流方向排查。")
    if any("塑料" in (material or "") for material in by_material) or any("塑料" in name for name in by_class):
        causes.append("塑料类目标占比明显，建议核查沿岸生活垃圾、河流输入和港口作业源。")
    if not causes:
        causes.append("仅凭单次检测不能确认唯一污染来源，建议结合连续监测、潮汐和现场记录判断。")
    solutions = [
        ReportSolution(priority="P0", action="复核低置信度目标，确认类别、目标框和原始图像，再决定是否纳入正式统计。", owner="检测复核人员", deadline="24小时内", validation="复核后置信度与类别记录完整，形成复核清单"),
        ReportSolution(priority="P1", action="按高频类别和高风险目标分区清理；渔网、绳索及大型缠绕物由专业人员分段解缠，避免直接拖拽。", owner="现场治理团队", deadline="72小时内" if risk in {"高", "极高"} else "7天内", validation="记录清理数量、重量、位置和前后影像"),
        ReportSolution(priority="P2", action="沿同一路线复测，并把本次结果与治理后结果纳入连续趋势分析，必要时加密监测频次。", owner="监测管理人员", deadline="治理后7天内", validation="比较目标数量、密度、等级和高风险类别变化"),
    ]
    return {
        "summary": f"报告显示该任务处于“{level}”污染等级，检出 {int(task.total_objects or 0)} 个目标。建议先完成结果复核，再按风险优先级治理并复测。",
        "risk_level": risk,
        "key_findings": findings,
        "possible_causes": causes,
        "solutions": [solution.model_dump() for solution in solutions],
        "follow_up_monitoring": ["治理前后使用相同路线和近似采样条件复测", "连续记录垃圾数量、密度、类别和置信度", "高风险点位根据趋势结果调整复测周期"],
        "evidence": [
            {"id": f"R{row.id}", "class_name": row.class_name, "confidence": round(float(row.confidence or 0), 4), "material": row.material_type or "未知", "source": f"检测结果 #{row.id}"}
            for row in results[:30]
        ],
    }


@router.post("/{report_id}/analyze", response_model=ReportAnalysisResponse)
async def analyze_report(
    report_id: int,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """报告导入后的结构化分析与处置方案。事实由后端统计，结果可重复查看。"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if not is_privileged(db, current_user) and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限分析该报告")
    if not report.task_id:
        # 批量报告没有单一 task_id，但 summary 已包含批次数量、目标数、综合等级和质量分，
        # 仍可完成可追溯的宏观分析，证据明确标记为报告摘要而不是伪造逐目标结果。
        match = re.match(
            r"批量报告：共 (\d+) 张图片，检出 (\d+) 个垃圾目标，综合污染等级 (\S+)，质量分 (\d+)",
            report.summary or "",
        )
        if not match:
            raise HTTPException(status_code=422, detail="批量报告摘要字段不完整，无法分析")
        image_count, object_count, level, score = match.groups()
        risk = {"优": "低", "良": "低", "中": "中", "差": "高", "严重": "极高"}.get(level, "中")
        payload = {
            "summary": f"本批次包含 {image_count} 张图片，共检出 {object_count} 个垃圾目标，综合污染等级为“{level}”，质量分为 {score}。建议结合原始图片复核类别和空间分布后制定治理计划。",
            "risk_level": risk,
            "key_findings": [f"批次规模：{image_count} 张图片。", f"综合检出 {object_count} 个垃圾目标，等级为“{level}”。", f"质量分为 {score}，需结合原始证据判断治理优先级。"],
            "possible_causes": ["批量摘要未包含类别、点位和时间序列，暂不能据此确认单一污染来源。"],
            "solutions": [
                ReportSolution(priority="P0", action="抽查本批次原始图片，复核高风险或低置信度目标，并补齐点位与采样时间。", owner="报告审核人员", deadline="24小时内", validation="形成抽查记录和字段补全清单").model_dump(),
                ReportSolution(priority="P1", action="按点位和类别汇总后安排分区清理，缠绕类和大型目标优先处置。", owner="现场治理团队", deadline="72小时内", validation="记录清理前后数量和影像").model_dump(),
                ReportSolution(priority="P2", action="治理后使用同等条件复测，比较批次目标数量、密度和等级变化。", owner="监测管理人员", deadline="治理后7天内", validation="形成治理前后对比报告").model_dump(),
            ],
            "follow_up_monitoring": ["补充各图片对应的海域、点位和采样时间", "按相同采样路线复测", "建立批次前后对比趋势"],
            "evidence": [{"id": f"RPT-{report.id}", "class_name": "批量报告摘要", "confidence": 1.0, "material": "汇总字段", "source": f"报告 RPT-{report.id}"}],
        }
        analysis = ReportAnalysis(report_id=report.id, user_id=current_user.id, status="completed", result_json=json.dumps(payload, ensure_ascii=False), model_name="ds-ocean_mingzhe")
        db.add(analysis); db.commit(); db.refresh(analysis)
        return ReportAnalysisResponse(id=analysis.id, report_id=report.id, status=analysis.status, model_name=analysis.model_name, created_at=f"{analysis.created_at:%Y-%m-%d %H:%M}", **payload)
    task = db.query(DetectionTask).filter(DetectionTask.id == report.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="报告关联任务不存在")
    rows = db.query(DetectionResult).filter(DetectionResult.task_id == task.id).order_by(DetectionResult.id.asc()).all()
    payload = _analysis_for_task(task, rows)
    analysis = ReportAnalysis(
        report_id=report.id,
        user_id=current_user.id,
        status="completed",
        result_json=json.dumps(payload, ensure_ascii=False),
        model_name="ds-ocean_mingzhe",
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)
    return ReportAnalysisResponse(
        id=analysis.id, report_id=report.id, status=analysis.status,
        model_name=analysis.model_name, created_at=f"{analysis.created_at:%Y-%m-%d %H:%M}", **payload,
    )


@router.get("/{report_id}/analysis", response_model=ReportAnalysisResponse)
async def get_report_analysis(
    report_id: int,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """读取报告最近一次结构化分析。"""
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="报告不存在")
    if not is_privileged(db, current_user) and report.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权限查看该报告分析")
    analysis = db.query(ReportAnalysis).filter(ReportAnalysis.report_id == report_id).order_by(ReportAnalysis.id.desc()).first()
    if not analysis:
        raise HTTPException(status_code=404, detail="该报告尚未分析")
    payload = json.loads(analysis.result_json)
    return ReportAnalysisResponse(
        id=analysis.id, report_id=report_id, status=analysis.status,
        model_name=analysis.model_name, created_at=f"{analysis.created_at:%Y-%m-%d %H:%M}", **payload,
    )


def _resolve_report_type(format_value: str) -> ReportType:
    """前端 format（html 等）→ 合法 ReportType，非法值回退 single"""
    try:
        return ReportType(format_value)
    except ValueError:
        return ReportType.single


def _generate_report_for_task(db: Session, task: DetectionTask, user_id: int, report_type: str) -> Report:
    """生成 HTML 报告文件 + 写 reports 表，返回 Report"""
    sea_name = "近岸监测点"
    if task.sea_area_id:
        area = db.query(SeaArea).filter(SeaArea.id == task.sea_area_id).first()
        sea_name = area.name if area else sea_name
    os.makedirs("reports", exist_ok=True)
    path = f"reports/report_task{task.id}_{int(datetime.now().timestamp())}.html"
    with open(path, "w", encoding="utf-8") as f:
        f.write(_build_report_html(task, sea_area_name=sea_name))

    report = Report(
        task_id=task.id,
        user_id=user_id,
        report_type=_resolve_report_type(report_type),
        report_path=path,
        summary=f"任务 {task.id}（{task.file_name}）共检出 {task.total_objects} 个垃圾",
        sea_area_id=task.sea_area_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    notify(db, user_id, "report_ready", "质量报告已生成", (report.summary or "")[:200], "reports", report.id)
    return report


def _build_batch_report_html(tasks: list[DetectionTask], sea_area_name: str = "近岸监测点") -> str:
    """聚合多张图片的检测结果，生成一份信息丰富的合并 HTML 报告"""
    total_objects = sum(t.total_objects for t in tasks)

    # 跨所有任务汇总类别 / 材质分布
    class_counter: Counter = Counter()
    material_counter: Counter = Counter()
    all_confs: list[float] = []
    for t in tasks:
        for r in t.results or []:
            class_counter[r.class_name or "未知"] += 1
            if r.material_type:
                material_counter[r.material_type] += 1
            if r.confidence is not None:
                all_confs.append(r.confidence)
    avg_conf = sum(all_confs) / len(all_confs) if all_confs else 0

    worst = max(
        (t.pollution_level.value for t in tasks if t.pollution_level),
        key=lambda v: LEVEL_SEVERITY.get(v, 0),
        default="excellent",
    )
    level = pollution_level_zh(worst)
    score = POLLUTION_SCORE.get(str(worst), 68)

    # 逐图明细表
    rows = ""
    for i, task in enumerate(tasks, 1):
        lvl = pollution_level_zh(task.pollution_level)
        rows += (
            f"<tr><td>{i}</td><td>{task.file_name}</td>"
            f"<td>{task.total_objects}</td>"
            f'<td><span class="lvl {_level_class(task.pollution_level.value if task.pollution_level else None)}">{lvl}</span></td>'
            f"<td>{task.completed_at or '-'}</td></tr>"
        )

    category_section = _build_category_bars(class_counter)
    material_section = _build_category_bars(
        material_counter, "linear-gradient(90deg,#c0782e,#e0a04a)"
    )
    is_single_area = len(set(t.sea_area_id for t in tasks)) == 1

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>多图批量识别质量报告</title>
<style>{_PAGE_STYLE}
{_MOBILE_CSS}</style></head><body>
<div class="page">
<div class="hero">
<h1>🌊 多图批量识别质量报告</h1>
<div class="sub">水下垃圾自动识别 · 海洋污染分析系统</div>
<div class="meta">
<span class="chip">涉及图片：{len(tasks)} 张</span>
<span class="chip">监测海域：{sea_area_name if is_single_area else '多个海域'}</span>
<span class="chip">生成时间：{datetime.now():%Y-%m-%d %H:%M}</span>
</div>
</div>
<div class="body">
<div class="cards">
<div class="card"><div class="num">{total_objects}</div><div class="lbl">检出垃圾总数</div></div>
<div class="card"><div class="lvl {_level_class(worst)}">{level}</div><div class="lbl" style="margin-top:8px">综合污染等级</div></div>
<div class="card"><div class="num">{score}</div><div class="lbl">环境质量分</div></div>
<div class="card"><div class="num">{avg_conf*100:.0f}%</div><div class="lbl">平均置信度</div></div>
<div class="card"><div class="num">{len(class_counter)}</div><div class="lbl">涉及类别数</div></div>
</div>

<section>
<h2>📋 逐图检测结果</h2>
<table>
<tr><th>#</th><th>文件名</th><th>检出目标</th><th>污染等级</th><th>完成时间</th></tr>
{rows}
</table>
</section>

<section>
<h2>📊 垃圾类别分布（汇总）</h2>
{category_section}
</section>

<section>
<h2>🧱 材质构成（汇总）</h2>
{material_section}
</section>

<section>
<h2>📝 综合评估结论与治理建议</h2>
{_build_level_notice(worst)}
</section>
</div>
<div class="foot">本报告由水下垃圾自动识别与海洋污染分析系统自动生成</div>
</div>
</body></html>"""


def _generate_batch_report(db: Session, tasks: list[DetectionTask], user_id: int, report_type: str) -> Report:
    """按多张图片聚合生成一份 HTML 报告 + 一条 reports 记录，返回 Report"""
    sea_name = "近岸监测点"
    area_ids = {t.sea_area_id for t in tasks if t.sea_area_id}
    if area_ids:
        area = db.query(SeaArea).filter(SeaArea.id.in_(area_ids)).first()
        sea_name = area.name if area else sea_name
    os.makedirs("reports", exist_ok=True)
    path = f"reports/report_batch_{int(datetime.now().timestamp())}.html"
    with open(path, "w", encoding="utf-8") as f:
        f.write(_build_batch_report_html(tasks, sea_area_name=sea_name))

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
        # 批次内任务同海域时记录归属（混域批量保持 NULL，前端显示「未指定海域」）
        sea_area_id=next(iter(area_ids)) if len(area_ids) == 1 else None,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    notify(db, user_id, "report_ready", "批量质量报告已生成", (report.summary or "")[:200], "reports", report.id)
    return report


# ---- 综合报告（基于已生成报告的聚合） ----

_ZH_LEVEL_TO_KEY = {"优": "excellent", "良": "good", "中": "moderate", "差": "poor", "严重": "severe"}


def _report_datetime(report: Report) -> str:
    return f"{report.created_at:%Y-%m-%d %H:%M}" if report.created_at else "-"


def _report_level_key(report: Report) -> str | None:
    """单份报告的英文污染等级 key：优先任务，其次解析 summary（批量/综合报告无 task）。"""
    if report.task and report.task.pollution_level:
        return report.task.pollution_level.value
    match = re.search(r"综合污染等级 (\S+)", report.summary or "")
    if match:
        return _ZH_LEVEL_TO_KEY.get(match.group(1))
    return None


def _report_object_count(report: Report) -> int:
    if report.task:
        return report.task.total_objects or 0
    match = re.search(r"检出 (\d+) 个垃圾目标", report.summary or "")
    return int(match.group(1)) if match else 0


def _report_score(report: Report) -> int:
    key = _report_level_key(report)
    if key:
        return POLLUTION_SCORE.get(key, 68)
    match = re.search(r"(?:质量分|平均质量分) (\d+)", report.summary or "")
    return int(match.group(1)) if match else 68


def _report_display_name(report: Report) -> str:
    if report.task and report.task.file_name:
        base = os.path.splitext(os.path.basename(report.task.file_name))[0]
        if base:
            return base
    base = os.path.splitext(os.path.basename(report.report_path or ""))[0]
    return base or f"报告 RPT-{report.id}"


def _build_comprehensive_report_html(reports: list[Report], sea_area_name: str = "近岸监测点") -> str:
    """把多份已生成的质量报告聚合为一份综合报告 HTML。"""
    total_objects = sum(_report_object_count(r) for r in reports)
    level_keys = [k for r in reports if (k := _report_level_key(r))]
    worst = max(level_keys, key=lambda v: LEVEL_SEVERITY.get(v, 0), default="excellent")
    avg_score = round(sum(_report_score(r) for r in reports) / len(reports))

    # 污染等级分布
    level_section = ""
    if level_keys:
        level_counter = Counter(pollution_level_zh(k) for k in level_keys)
        parts = "".join(
            f'<div class="hbar-row"><div class="hbar-lbl">{lv}</div>'
            f'<div class="hbar-track"><div class="hbar-fill" style="width:{cnt / len(level_keys) * 100:.1f}%"></div></div>'
            f'<div class="hbar-val">{cnt} 份</div></div>'
            for lv, cnt in level_counter.most_common()
        )
        level_section = f"<section><h2>📊 污染等级分布</h2>{parts}</section>"

    # 垃圾类别分布（来自包含逐目标结果的报告）
    class_counter: Counter = Counter()
    for r in reports:
        if r.task and (stats := _result_stats(r.task)):
            class_counter.update(stats["class_counter"])

    rows = ""
    for i, r in enumerate(reports, 1):
        key = _report_level_key(r)
        lvl = pollution_level_zh(key)
        rows += (
            f"<tr><td>{i}</td><td>RPT-{r.id}</td>"
            f"<td>{html.escape(_report_display_name(r))}</td>"
            f"<td>{_report_object_count(r)}</td>"
            f'<td><span class="lvl {_level_class(key)}">{lvl}</span></td>'
            f"<td>{_report_score(r)}</td>"
            f"<td>{_report_datetime(r)}</td></tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>综合质量评估报告</title>
<style>{_PAGE_STYLE}
{_MOBILE_CSS}</style></head><body>
<div class="page">
<div class="hero">
<h1>🌊 综合质量评估报告</h1>
<div class="sub">水下垃圾自动识别 · 海洋污染分析系统 · 多报告汇总</div>
<div class="meta">
<span class="chip">汇总报告：{len(reports)} 份</span>
<span class="chip">监测海域：{sea_area_name}</span>
<span class="chip">生成时间：{datetime.now():%Y-%m-%d %H:%M}</span>
</div>
</div>
<div class="body">
<div class="cards">
<div class="card"><div class="num">{len(reports)}</div><div class="lbl">汇总报告数</div></div>
<div class="card"><div class="num">{total_objects}</div><div class="lbl">检出目标总数</div></div>
<div class="card"><div class="lvl {_level_class(worst)}">{pollution_level_zh(worst)}</div><div class="lbl" style="margin-top:8px">综合污染等级</div></div>
<div class="card"><div class="num">{avg_score}</div><div class="lbl">平均质量分</div></div>
</div>

<section>
<h2>📋 汇总报告明细</h2>
<table>
<tr><th>#</th><th>报告编号</th><th>报告名称</th><th>检出目标</th><th>污染等级</th><th>质量分</th><th>生成时间</th></tr>
{rows}
</table>
</section>

{level_section}

<section>
<h2>🧱 垃圾类别分布（汇总）</h2>
{_build_category_bars(class_counter)}
</section>

<section>
<h2>📝 综合评估结论与治理建议</h2>
{_build_level_notice(worst)}
</section>
</div>
<div class="foot">本报告由水下垃圾自动识别与海洋污染分析系统自动生成</div>
</div></body></html>"""


def _report_sea_area_id(report: Report) -> int | None:
    """报告的海域归属：优先报告自身记录（批量/综合报告无 task），否则取关联任务的海域"""
    return report.sea_area_id or (report.task.sea_area_id if report.task else None)


def _generate_comprehensive_report(db: Session, reports: list[Report], user_id: int, report_type: str) -> Report:
    """把多份报告聚合保存为一条综合报告记录，返回 Report。
    综合报告限定同一海域（端点已校验）：海域名取该统一海域，而非任意第一份。"""
    sea_area_ids = {sid for r in reports if (sid := _report_sea_area_id(r)) is not None}
    sea_name = "近岸监测点"
    if len(sea_area_ids) == 1:
        area = db.query(SeaArea).filter(SeaArea.id == next(iter(sea_area_ids))).first()
        sea_name = area.name if area else sea_name

    os.makedirs("reports", exist_ok=True)
    path = f"reports/report_comprehensive_{int(datetime.now().timestamp())}.html"
    with open(path, "w", encoding="utf-8") as f:
        f.write(_build_comprehensive_report_html(reports, sea_area_name=sea_name))

    total_objects = sum(_report_object_count(r) for r in reports)
    level_keys = [k for r in reports if (k := _report_level_key(r))]
    worst = max(level_keys, key=lambda v: LEVEL_SEVERITY.get(v, 0), default="excellent")
    avg_score = round(sum(_report_score(r) for r in reports) / len(reports))
    summary = (
        f"综合报告：汇总 {len(reports)} 份报告，检出 {total_objects} 个垃圾目标，"
        f"综合污染等级 {pollution_level_zh(worst)}，平均质量分 {avg_score}"
    )
    report = Report(
        task_id=None,
        user_id=user_id,
        report_type=ReportType.custom,
        report_path=path,
        summary=summary,
        sea_area_id=next(iter(sea_area_ids)) if len(sea_area_ids) == 1 else None,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    notify(db, user_id, "report_ready", "综合质量报告已生成", (report.summary or "")[:200], "reports", report.id)
    return report


@router.post("/", response_model=FrontendReport)
async def create_report(
    body: CreateReportRequest,
    current_user: User = Depends(require_permission("reports")),
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
    return _to_frontend_report(report, {a.id: a.name for a in db.query(SeaArea).all()})


@router.post("/batch", response_model=FrontendReport)
async def create_batch_report(
    body: CreateBatchReportRequest,
    current_user: User = Depends(require_permission("reports")),
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
    return _to_frontend_report(report, {a.id: a.name for a in db.query(SeaArea).all()})


@router.post("/comprehensive", response_model=FrontendReport)
async def create_comprehensive_report(
    body: CreateComprehensiveReportRequest,
    current_user: User = Depends(require_permission("reports")),
    db: Session = Depends(get_db),
):
    """基于用户勾选的已有报告聚合生成一份综合报告（Reports 页「创建综合报告」）。
    综合报告限定同一海域：勾选跨海域报告直接 400，避免聚合出错误的海域名。"""
    if not body.report_ids:
        raise HTTPException(status_code=400, detail="请先勾选至少一份报告")
    reports = (
        db.query(Report)
        .filter(Report.id.in_(body.report_ids), Report.user_id == current_user.id)
        .all()
    )
    if len(reports) != len(set(body.report_ids)):
        raise HTTPException(status_code=404, detail="部分报告不存在或无权访问")
    # 同海域约束：综合报告只能汇总同一海域的报告（None=历史报告未记录海域，自为一组）
    area_keys = {_report_sea_area_id(r) for r in reports}
    if len(area_keys) > 1:
        raise HTTPException(status_code=400, detail="综合报告只能汇总同一海域的报告，请取消勾选其他海域的报告")
    report = _generate_comprehensive_report(db, reports, current_user.id, body.format)
    return _to_frontend_report(report, {a.id: a.name for a in db.query(SeaArea).all()})


@router.post("/generate", response_model=ReportInfo)
async def generate_report(
    task_id: int = Form(...),
    report_type: str = Form("single"),
    current_user: User = Depends(require_permission("reports")),
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
