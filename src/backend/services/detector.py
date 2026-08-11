"""
检测服务（YOLO 真推理）
=====================================
调用 src/vision/best.pt（22 类 TrashCan 水下垃圾模型）做目标检测。

- 模型懒加载 + 进程内单例（threading.Lock 防并发初始化竞态）
- ultralytics 延迟导入：不装 ultralytics 也能正常启动后端，首次检测才加载权重
- 只返回/入库垃圾类（YOLO ID 8-21），rov/动植物等 8 个背景类（ID 0-7）被过滤

路由层契约保持不变，替换存根逻辑即可接入真实模型。
"""

import threading
import time
from datetime import datetime

import config

# 14 类垃圾（YOLO ID 8-21）: id -> (英文, 中文, 材质)
GARBAGE_CLASSES = {
    8: ("trash_clothing", "衣物/纺织品", "纺织物"),
    9: ("trash_pipe", "管道", "塑料"),
    10: ("trash_bottle", "瓶子", "塑料"),
    11: ("trash_bag", "塑料袋", "塑料"),
    12: ("trash_snack_wrapper", "零食包装", "塑料"),
    13: ("trash_can", "金属罐", "金属"),
    14: ("trash_cup", "杯子", "塑料"),
    15: ("trash_container", "容器", "塑料"),
    16: ("trash_unknown_instance", "未知垃圾", "未知"),
    17: ("trash_branch", "树枝/木头", "木头"),
    18: ("trash_wreckage", "残骸/碎片", "金属"),
    19: ("trash_tarp", "防水布/篷布", "塑料"),
    20: ("trash_rope", "绳索", "尼龙"),
    21: ("trash_net", "渔网", "尼龙"),
}

# 高危害类别（用于污染等级评估）：塑料袋(11)、渔网(21)、残骸(18)
HIGH_HAZARD_IDS = {11, 21, 18}

# 模型单例
_model = None
_model_lock = threading.Lock()


def _get_model():
    """懒加载 YOLO 模型单例（进程内共享，首次调用才加载权重）"""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from ultralytics import YOLO  # 延迟导入，不影响后端启动

                _model = YOLO(config.YOLO_MODEL_PATH)
    return _model


def _decode_image(image_bytes: bytes):
    """字节 → BGR numpy 数组；返回 (img, height, width)"""
    import cv2
    import numpy as np

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解析图片数据，请确认上传的是有效图片")
    height, width = img.shape[:2]
    return img, height, width


def _filter_and_build(detections: list) -> list[dict]:
    """把 YOLO 目标框过滤为垃圾类（ID 8-21），转成与存根一致的结构"""
    items = []
    for det in detections:
        cls_id = int(det["class_id"])
        if cls_id not in GARBAGE_CLASSES:
            continue  # 忽略 rov/plant/动物等背景类
        x1, y1, x2, y2 = det["xyxy"]
        _, cn_name, material = GARBAGE_CLASSES[cls_id]
        items.append(
            {
                "class_id": cls_id,
                "class_name": cn_name,
                "confidence": round(float(det["confidence"]), 4),
                "bbox_x1": round(float(x1), 2),
                "bbox_y1": round(float(y1), 2),
                "bbox_x2": round(float(x2), 2),
                "bbox_y2": round(float(y2), 2),
                "material_type": material,
            }
        )
    return items


def detect_image(image_bytes: bytes) -> dict:
    """
    对单张图片做目标检测（真推理）。
    返回: {
        "detections": [{"class_id","class_name","confidence",
                        "bbox_x1","bbox_y1","bbox_x2","bbox_y2","material_type"}, ...],
        "width": int,   # 图片真实宽
        "height": int,  # 图片真实高
    }
    """
    img, height, width = _decode_image(image_bytes)
    model = _get_model()
    result = model.predict(
        img, conf=config.YOLO_CONF, device=config.YOLO_DEVICE, verbose=False
    )[0]

    detections = []
    if result.boxes is not None:
        for box in result.boxes:
            detections.append(
                {
                    "class_id": int(box.cls[0]),
                    "class_name": model.names[int(box.cls[0])],
                    "confidence": round(float(box.conf[0]), 4),
                    "xyxy": [round(float(v), 2) for v in box.xyxy[0].tolist()],
                }
            )

    return {"detections": _filter_and_build(detections), "width": width, "height": height}


def compute_pollution_level(class_ids: list[int]) -> str:
    """
    根据检出的垃圾类别评估污染等级。
    返回 PollutionLevel 枚举值字符串。
    """
    total = len(class_ids)
    high_hazard = sum(1 for cid in class_ids if cid in HIGH_HAZARD_IDS)
    if total >= 15 or high_hazard >= 3:
        return "severe"
    if total >= 8 or high_hazard >= 2:
        return "poor"
    if total >= 4:
        return "moderate"
    if total >= 1:
        return "good"
    return "excellent"


def process_video_background(task_id: int, file_path: str):
    """
    视频检测后台任务（真实推理）：pending → processing → completed。
    由 FastAPI BackgroundTasks 调用，独立开数据库会话写库。
    逐帧推理，垃圾类（ID 8-21）目标写入 detection_results。
    """
    # 延迟导入，避免模块加载时依赖数据库
    from database import SessionLocal
    from models import DetectionResult, DetectionTask, TaskStatus

    import cv2

    db = SessionLocal()
    start = time.time()
    garbage_ids: list[int] = []
    try:
        task = db.query(DetectionTask).filter_by(id=task_id).first()
        if not task:
            return

        task.status = TaskStatus.processing
        db.commit()

        model = _get_model()
        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            raise OSError(f"无法打开视频文件: {file_path}")

        frame_index = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                result = model.predict(
                    frame, conf=config.YOLO_CONF, device=config.YOLO_DEVICE, verbose=False
                )[0]
                if result.boxes is not None:
                    for box in result.boxes:
                        cls_id = int(box.cls[0])
                        if cls_id not in GARBAGE_CLASSES:
                            continue
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        _, cn_name, material = GARBAGE_CLASSES[cls_id]
                        db.add(
                            DetectionResult(
                                task_id=task_id,
                                frame_index=frame_index,
                                class_id=cls_id,
                                class_name=cn_name,
                                confidence=round(float(box.conf[0]), 4),
                                bbox_x1=round(float(x1), 2),
                                bbox_y1=round(float(y1), 2),
                                bbox_x2=round(float(x2), 2),
                                bbox_y2=round(float(y2), 2),
                                material_type=material,
                            )
                        )
                        garbage_ids.append(cls_id)
                frame_index += 1
        finally:
            cap.release()

        db.commit()
        task.total_objects = len(garbage_ids)
        task.pollution_level = compute_pollution_level(garbage_ids)
        task.processing_time = round(time.time() - start, 2)
        task.status = TaskStatus.completed
        task.completed_at = datetime.now()
        db.commit()
    except Exception:
        # 异常时标记任务失败，避免卡在 processing
        db.rollback()
        task = db.query(DetectionTask).filter_by(id=task_id).first()
        if task:
            task.status = TaskStatus.failed
            db.commit()
    finally:
        db.close()
