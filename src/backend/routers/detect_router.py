"""
检测 API
=====================================
POST /api/v1/detect/image  图片检测（同步存根）
POST /api/v1/detect/video  视频检测（后台任务）
GET  /api/v1/detect/status/{task_id}  任务进度
GET  /api/v1/detect/result/{task_id}  帧级结果 + 汇总
"""

import os
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

import config
from auth import get_current_user
from database import get_db
from models import DetectionResult, DetectionTask, TaskStatus, TaskType, User
from schemas import (
    DetectionResultItem,
    FrontendDetectionBox,
    FrontendDetectionListResponse,
    FrontendDetectionRecord,
    FrontendDetectionResult,
    ResultResponse,
    TaskStatusResponse,
    VideoDetectResponse,
    POLLUTION_SCORE,
    TASK_STATUS_ZH,
    TASK_TYPE_ZH,
    pollution_level_zh,
)
from services import detector
from services.detector import GARBAGE_CLASSES

router = APIRouter(prefix="/api/v1", tags=["detection"])

ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
ALLOWED_VIDEO = {".mp4", ".avi", ".mov", ".mkv"}

# 任务状态 → 进度百分比（用于前端进度条）
PROGRESS = {
    TaskStatus.pending: 0,
    TaskStatus.processing: 50,
    TaskStatus.completed: 100,
    TaskStatus.failed: 0,
}


def _save_upload(file: UploadFile, subdir: str) -> str:
    """保存上传文件到 uploads/<subdir>/，返回相对路径"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    dir_path = os.path.join(config.UPLOAD_DIR, subdir)
    os.makedirs(dir_path, exist_ok=True)
    file_path = os.path.join(dir_path, f"{uuid.uuid4().hex}{ext}")
    with open(file_path, "wb") as f:
        f.write(file.file.read())
    return file_path


@router.post("/detect/image", response_model=FrontendDetectionResult)
async def detect_image(
    file: UploadFile = File(...),
    width: int = Form(1280),
    height: int = Form(720),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """图片检测：上传 → 检测（存根）→ 结果写库 → 返回前端 DetectionResult 形状"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_IMAGE:
        raise HTTPException(status_code=400, detail="不支持的图片格式，支持 jpg/png/webp/bmp")

    file_path = _save_upload(file, "images")
    with open(file_path, "rb") as f:
        image_bytes = f.read()

    # 调用检测服务（当前为存根，返回模拟结果）
    detections = detector.detect_image(image_bytes)

    # 创建任务 + 结果
    task = DetectionTask(
        user_id=current_user.id,
        task_type=TaskType.image,
        file_name=file.filename or file_path,
        file_path=file_path,
        status=TaskStatus.processing,
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
        sourceWidth=width,
        sourceHeight=height,
        objects=objects,
        pollutionLevel=pollution_level_zh(level),
        density=round(len(objects) / 10.0, 1),
        qualityScore=POLLUTION_SCORE.get(str(level), 68),
        processedAt=f"{datetime.now():%Y-%m-%d %H:%M}",
    )


@router.get("/detections", response_model=FrontendDetectionListResponse)
async def list_detections(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """检测历史列表（前端 History 页）：当前用户任务分页"""
    query = db.query(DetectionTask).filter(DetectionTask.user_id == current_user.id)
    total = query.count()
    tasks = (
        query.order_by(DetectionTask.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = [
        FrontendDetectionRecord(
            id=f"DET-{t.id}",
            createdAt=f"{t.created_at:%Y-%m-%d %H:%M}" if t.created_at else "",
            location="近岸监测点",
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
    background_tasks: BackgroundTasks = BackgroundTasks(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """视频检测：上传 → 创建任务 → 后台处理 → 立即返回 task_id"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_VIDEO:
        raise HTTPException(status_code=400, detail="不支持的视频格式，支持 mp4/avi/mov/mkv")

    file_path = _save_upload(file, "videos")
    task = DetectionTask(
        user_id=current_user.id,
        task_type=TaskType.video,
        file_name=file.filename or file_path,
        file_path=file_path,
        status=TaskStatus.pending,
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询任务进度"""
    task = (
        db.query(DetectionTask)
        .filter(DetectionTask.id == task_id, DetectionTask.user_id == current_user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TaskStatusResponse(
        task_id=task.id,
        status=task.status.value,
        progress=PROGRESS[task.status],
        total_objects=task.total_objects,
        pollution_level=task.pollution_level.value if task.pollution_level else None,
        processing_time=task.processing_time,
    )


@router.get("/detect/result/{task_id}", response_model=ResultResponse)
async def task_result(
    task_id: int,
    current_user: User = Depends(get_current_user),
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
    for r in rows:
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
            )
        )
        if r.material_type:
            material_breakdown[r.material_type] = material_breakdown.get(r.material_type, 0) + 1

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
    )
