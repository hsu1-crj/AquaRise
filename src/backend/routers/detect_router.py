"""
检测 API
=====================================
POST /api/v1/detect/image  图片检测（同步存根）
POST /api/v1/detect/video  视频检测（后台任务）
GET  /api/v1/detect/status/{task_id}  任务进度
GET  /api/v1/detect/result/{task_id}  帧级结果 + 汇总
"""

import asyncio
import os
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import or_
from sqlalchemy.orm import Session

import config
from auth import require_permission
from database import get_db
from models import DetectionResult, DetectionTask, PollutionLevel, SeaArea, TaskStatus, TaskType, User
from schemas import (
    DetectionResultItem,
    FrontendDetectionBox,
    FrontendDetectionListResponse,
    FrontendDetectionRecord,
    FrontendDetectionResult,
    MultiImageDetectItem,
    MultiImageDetectResponse,
    ResultResponse,
    TaskStatusResponse,
    VideoDetectResponse,
    POLLUTION_LEVEL_ZH,
    POLLUTION_SCORE,
    TASK_STATUS_ZH,
    TASK_TYPE_ZH,
    pollution_level_zh,
)
from services import detector
from services.detector import GARBAGE_CLASSES
from services.notification_hub import notify

router = APIRouter(prefix="/api/v1", tags=["detection"])

ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
ALLOWED_VIDEO = {".mp4", ".avi", ".mov", ".mkv", ".webm"}

# 一次批量识别最多图片数（限制单次请求体大小）
MAX_BATCH_IMAGES = 50

# 任务状态 → 进度百分比（用于前端进度条）
PROGRESS = {
    TaskStatus.pending: 0,
    TaskStatus.processing: 50,
    TaskStatus.completed: 100,
    TaskStatus.failed: 0,
}


def _validate_sea_area(db: Session, sea_area_id: int | None) -> int | None:
    """软外键校验（契约 v1.1 §1）：sea_area_id 必须存在于 sea_areas，否则 400。
    sea_area_id 缺省（None）合法——历史行为完全不变。"""
    if sea_area_id is None:
        return None
    from models import SeaArea

    if not db.query(SeaArea).filter(SeaArea.id == sea_area_id).first():
        raise HTTPException(status_code=400, detail=f"海域不存在：{sea_area_id}")
    return sea_area_id

def _save_upload(file: UploadFile, subdir: str) -> str:
    """保存上传文件到 uploads/<subdir>/，返回相对路径"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    dir_path = os.path.join(config.UPLOAD_DIR, subdir)
    os.makedirs(dir_path, exist_ok=True)
    file_path = os.path.join(dir_path, f"{uuid.uuid4().hex}{ext}")
    with open(file_path, "wb") as f:
        f.write(file.file.read())
    return file_path


async def _process_single_image(file: UploadFile, current_user: User, db: Session,
                                sea_area_id: int | None = None,
                                notify_task: bool = True) -> FrontendDetectionResult:
    """单张图片：保存 → YOLO 推理 → 建任务/结果 → 返回前端 DetectionResult 形状。
    单图与多图端点共用，保证行为一致。sea_area_id 为任务归属海域（软外键）。
    notify_task=False 时跳过本图通知（批量端点逐图关闭，结束时合并成一条统发）。"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_IMAGE:
        raise HTTPException(status_code=400, detail="不支持的图片格式，支持 jpg/png/webp/bmp")

    file_path = _save_upload(file, "images")
    with open(file_path, "rb") as f:
        image_bytes = f.read()

    # 调用检测服务（真实 YOLO 推理）：CPU/GPU 密集同步调用放进线程池，
    # 避免单帧推理数百 ms、批量最多 50 张时整帧卡死事件循环（登录/聊天/报告全部排队）
    payload = await asyncio.to_thread(detector.detect_image, image_bytes)
    detections = payload["detections"]

    # 创建任务 + 结果
    task = DetectionTask(
        user_id=current_user.id,
        task_type=TaskType.image,
        file_name=file.filename or file_path,
        file_path=file_path,
        status=TaskStatus.processing,
        sea_area_id=sea_area_id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    for d in detections:
        db.add(
            DetectionResult(
                task_id=task.id,
                frame_index=0,
                class_id=d["class_id"],
                class_name=d["class_name"],
                confidence=d["confidence"],
                bbox_x1=d["bbox_x1"],
                bbox_y1=d["bbox_y1"],
                bbox_x2=d["bbox_x2"],
                bbox_y2=d["bbox_y2"],
                material_type=d["material_type"],
            )
        )

    task.total_objects = len(detections)
    level = detector.compute_pollution_level([d["class_id"] for d in detections])
    task.pollution_level = level
    task.status = TaskStatus.completed
    task.completed_at = datetime.now()
    db.commit()

    # 通知：任务完成 + 污染等级告警（poor/severe 时追加）；批量端点传 notify_task=False 由批量合并统发
    if notify_task:
        notify(
            db,
            current_user.id,
            "task_completed",
            f"检测任务 #{task.id} 完成",
            f"「{task.file_name}」检出 {task.total_objects} 个垃圾目标",
            "history",
            task.id,
        )
        if level in (PollutionLevel.poor, PollutionLevel.severe):
            zl = pollution_level_zh(level)
            notify(
                db,
                current_user.id,
                "pollution_warning",
                f"⚠ 污染告警：{zl}污染",
                f"「{task.file_name}」综合污染等级为{zl}，建议及时处理",
                "history",
                task.id,
            )

    objects: list[FrontendDetectionBox] = []
    for index, d in enumerate(detections, start=1):
        class_id = d["class_id"]
        en_label, zh_label, material = GARBAGE_CLASSES.get(class_id, ("trash_unknown", "未知垃圾", "未知"))
        objects.append(
            FrontendDetectionBox(
                id=f"box-{index}",
                label=en_label,
                labelZh=zh_label,
                confidence=d["confidence"],
                bbox=[
                    round(float(d["bbox_x1"]), 1),
                    round(float(d["bbox_y1"]), 1),
                    round(float(d["bbox_x2"] - d["bbox_x1"]), 1),
                    round(float(d["bbox_y2"] - d["bbox_y1"]), 1),
                ],
                material=material,
            )
        )

    return FrontendDetectionResult(
        taskId=str(task.id),
        sourceWidth=payload["width"],
        sourceHeight=payload["height"],
        objects=objects,
        pollutionLevel=pollution_level_zh(level),
        density=round(len(objects) / 10.0, 1),
        # 等级基线 + 数量连续修正: 同等级内检出越多分越低(最多扣9分不越级), 避免"恒定68分"
        qualityScore=round(POLLUTION_SCORE.get(str(level), 68) - min(9, len(objects) * 0.6)),
        processedAt=f"{datetime.now():%Y-%m-%d %H:%M}",
    )


@router.post("/detect/image", response_model=FrontendDetectionResult)
async def detect_image(
    file: UploadFile = File(...),
    width: int = Form(1280),
    height: int = Form(720),
    site_id: int | None = Form(None, description="海域ID（可选，软外键→sea_areas；字段名保持 site_id 兼容）"),
    current_user: User = Depends(require_permission("detection")),
    db: Session = Depends(get_db),
):
    """图片检测：上传 → YOLO 推理 → 结果写库 → 返回前端 DetectionResult 形状
    （sourceWidth/Height 取自图片真实尺寸；width/height 表单参数仅向前端契约保留）"""
    return await _process_single_image(file, current_user, db, _validate_sea_area(db, site_id))


@router.post("/detect/images", response_model=MultiImageDetectResponse)
async def detect_images(
    files: list[UploadFile] = File(...),
    site_id: int | None = Form(None, description="海域ID（可选，整批共用；字段名保持 site_id 兼容）"),
    current_user: User = Depends(require_permission("detection")),
    db: Session = Depends(get_db),
):
    """多图批量识别：每张图独立保存 + 推理 + 建任务，单张失败不影响其余。
    返回每张图的成功/失败结果，前端逐图展示。"""
    if not files:
        raise HTTPException(status_code=400, detail="未收到任何图片")
    if len(files) > MAX_BATCH_IMAGES:
        raise HTTPException(status_code=400, detail=f"一次最多上传 {MAX_BATCH_IMAGES} 张图片")

    items: list[MultiImageDetectItem] = []
    success_count = 0
    fail_count = 0
    total_found = 0
    warn_count = 0
    warn_levels: set[str] = set()
    first_task_id: int | None = None
    valid_sea_area_id = _validate_sea_area(db, site_id)
    for file in files:
        name = file.filename or "未命名图片"
        try:
            # 逐图关闭单图通知，批量结束时合并为一条统发，避免 50 张图刷 50 条通知
            result = await _process_single_image(
                file, current_user, db, valid_sea_area_id, notify_task=False
            )
            items.append(MultiImageDetectItem(success=True, fileName=name, result=result))
            success_count += 1
            total_found += len(result.objects)
            if first_task_id is None:
                first_task_id = int(result.taskId)
            if result.pollutionLevel in ("差", "严重"):
                warn_levels.add(result.pollutionLevel)
                warn_count += 1
        except HTTPException as exc:
            # 单图校验失败（格式/类型）不中断整批
            fail_count += 1
            items.append(MultiImageDetectItem(success=False, fileName=name, error=exc.detail))
        except Exception as exc:
            fail_count += 1
            items.append(MultiImageDetectItem(success=False, fileName=name, error=str(exc)))

    # 批量合并通知：整批一条"完成"汇总 +（有差/严重时）一条污染告警，链接到批内第一张图
    if success_count > 0 and first_task_id is not None:
        batch_body = f"共 {len(files)} 张，成功 {success_count} 张，检出 {total_found} 个垃圾目标"
        if fail_count:
            batch_body += f"，失败 {fail_count} 张"
        notify(
            db,
            current_user.id,
            "task_completed",
            "批量检测完成",
            batch_body,
            "history",
            first_task_id,
        )
        if warn_count:
            notify(
                db,
                current_user.id,
                "pollution_warning",
                f"⚠ 批量检测发现 {warn_count} 张污染图片",
                f"{warn_count} 张图片综合污染等级为{'、'.join(sorted(warn_levels))}，建议优先处理",
                "history",
                first_task_id,
            )

    return MultiImageDetectResponse(
        items=items,
        total=len(files),
        successCount=success_count,
        failCount=fail_count,
    )


@router.get("/detections", response_model=FrontendDetectionListResponse)
async def list_detections(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    level: str = Query("", description="中文污染等级过滤：优/良/中/差/严重，空=全部"),
    query: str = Query("", description="搜索：任务编号（精确）或文件名（模糊）"),
    current_user: User = Depends(require_permission("history")),
    db: Session = Depends(get_db),
):
    """检测历史列表（前端 History 页）：当前用户任务分页，支持等级过滤与编号/文件名搜索"""
    q = db.query(DetectionTask).filter(DetectionTask.user_id == current_user.id)
    # 等级过滤：前端传中文（优/良/…），映射回后端英文枚举
    if level:
        level_key = {v: k for k, v in POLLUTION_LEVEL_ZH.items()}.get(level)
        if level_key:
            q = q.filter(DetectionTask.pollution_level == level_key)
    # 搜索：纯数字按任务编号精确匹配，否则按文件名模糊匹配（点位固定为"近岸监测点"无检索意义）
    if query and query.strip():
        kw = query.strip()
        if kw.isdigit():
            q = q.filter(or_(DetectionTask.id == int(kw), DetectionTask.file_name.contains(kw)))
        else:
            q = q.filter(DetectionTask.file_name.contains(kw))
    total = q.count()
    tasks = (
        q.order_by(DetectionTask.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # 海域 id → 名称映射：任务 location 显示所属海域名（旧任务无 sea_area_id 或无匹配海域时回退默认文案）
    sea_name_map = {a.id: a.name for a in db.query(SeaArea).all()}

    items = [
        FrontendDetectionRecord(
            id=f"DET-{t.id}",
            createdAt=f"{t.created_at:%Y-%m-%d %H:%M}" if t.created_at else "",
            location=sea_name_map.get(t.sea_area_id, "近岸监测点"),
            type=TASK_TYPE_ZH.get(t.task_type.value, "图片"),
            objectCount=t.total_objects or 0,
            level=pollution_level_zh(t.pollution_level),
            status=TASK_STATUS_ZH.get(t.status.value, "处理中"),
        )
        for t in tasks
    ]
    return FrontendDetectionListResponse(items=items, total=total)


@router.post("/detect/video", response_model=VideoDetectResponse)
async def detect_video(
    file: UploadFile = File(...),
    site_id: int | None = Form(None, description="海域ID（可选，软外键→sea_areas；字段名保持 site_id 兼容）"),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    current_user: User = Depends(require_permission("detection")),
    db: Session = Depends(get_db),
):
    """视频检测：上传 → 创建任务 → 后台处理 → 立即返回 task_id"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_VIDEO:
        raise HTTPException(status_code=400, detail="不支持的视频格式，支持 mp4/avi/mov/mkv/webm")

    file_path = _save_upload(file, "videos")
    task = DetectionTask(
        user_id=current_user.id,
        task_type=TaskType.video,
        file_name=file.filename or file_path,
        file_path=file_path,
        status=TaskStatus.pending,
        sea_area_id=_validate_sea_area(db, site_id),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    # 后台任务：模拟逐帧推理并写库
    background_tasks.add_task(detector.process_video_background, task.id, file_path)

    return VideoDetectResponse(
        task_id=task.id,
        status=task.status.value,
        message="视频已提交，正在后台处理，请稍后查询进度",
    )


@router.get("/detect/status/{task_id}", response_model=TaskStatusResponse)
async def task_status(
    task_id: int,
    current_user: User = Depends(require_permission("detection", "history")),
    db: Session = Depends(get_db),
):
    """查询任务进度：DB 任务状态 + 内存实时进度（视频预览帧）合并"""
    task = (
        db.query(DetectionTask)
        .filter(DetectionTask.id == task_id, DetectionTask.user_id == current_user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    # 视频后台任务在内存中实时更新进度/预览帧（进程内有效），优先于静态 PROGRESS 映射
    live = detector.get_video_progress(task.id) if task.task_type == TaskType.video else {}
    progress = live.get("progress", PROGRESS[task.status])
    return TaskStatusResponse(
        task_id=task.id,
        status=task.status.value,
        progress=progress,
        total_objects=task.total_objects,
        pollution_level=task.pollution_level.value if task.pollution_level else None,
        processing_time=task.processing_time,
        preview_url=live.get("preview_url"),
        preview_urls=live.get("preview_urls"),
        annotated_video_url=live.get("annotated_video_url"),
        processed_frames=live.get("processed_frames"),
        total_frames=live.get("total_frames"),
    )


@router.get("/detect/result/{task_id}", response_model=ResultResponse)
async def task_result(
    task_id: int,
    current_user: User = Depends(require_permission("detection", "history")),
    db: Session = Depends(get_db),
):
    """获取检测结果：帧级目标列表 + 材质汇总"""
    task = (
        db.query(DetectionTask)
        .filter(DetectionTask.id == task_id, DetectionTask.user_id == current_user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    rows = db.query(DetectionResult).filter(DetectionResult.task_id == task_id).all()
    items = []
    material_breakdown: dict = {}
    crop_dir = os.path.join(config.UPLOAD_DIR, "video_crops", str(task_id))
    for r in rows:
        # 视频任务：若检测时保存了目标裁剪缩略图，则给出对应 URL（用行 id 命名）
        crop_url = None
        if task.task_type == TaskType.video and os.path.exists(os.path.join(crop_dir, f"{r.id}.jpg")):
            crop_url = f"/uploads/video_crops/{task_id}/{r.id}.jpg"
        items.append(
            DetectionResultItem(
                class_id=r.class_id,
                class_name=r.class_name,
                confidence=r.confidence,
                bbox_x1=r.bbox_x1,
                bbox_y1=r.bbox_y1,
                bbox_x2=r.bbox_x2,
                bbox_y2=r.bbox_y2,
                material_type=r.material_type,
                crop_url=crop_url,
            )
        )
        if r.material_type:
            material_breakdown[r.material_type] = material_breakdown.get(r.material_type, 0) + 1

    # 视频：内存进度里的预览帧（按场景逐张累积）；图片：把已入库检测框画回原图
    live = detector.get_video_progress(task.id) if task.task_type == TaskType.video else {}
    preview_urls = live.get("preview_urls") or None
    media_url = None
    if task.task_type == TaskType.image:
        media_url = detector._annotated_image_url(task.id, task.file_path, rows)

    return ResultResponse(
        task_id=task.id,
        task_type=task.task_type.value,
        file_name=task.file_name,
        status=task.status.value,
        total_objects=task.total_objects,
        pollution_level=task.pollution_level.value if task.pollution_level else None,
        processing_time=task.processing_time,
        results=items,
        material_breakdown=material_breakdown,
        annotated_video_url=live.get("annotated_video_url"),
        preview_urls=preview_urls,
        media_url=media_url,
    )
