"""
检测服务（YOLO 存根）
=====================================
真实 YOLO 模型要到项目第 3-4 周才训练完成。本文件是**存根**：

- 接口签名与真实服务保持一致
- 返回模拟的检测结果（使用规划文档里的 14 类垃圾类别）
- 真实模型就绪后，只改本文件即可，路由/模型层不用动

替换点：detect_image / process_video_background 内部逻辑 → 调用 YOLO 推理。
"""

import random
import time
from datetime import datetime

# 规划文档中的 14 类垃圾（YOLO ID 8-21）: id -> (英文, 中文, 材质)
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


def _make_mock_detection(class_id: int) -> dict:
    """生成一个模拟检测目标"""
    _, cn_name, material = GARBAGE_CLASSES[class_id]
    x1 = round(random.uniform(20, 380), 1)
    y1 = round(random.uniform(20, 380), 1)
    return {
        "class_id": class_id,
        "class_name": cn_name,
        "confidence": round(random.uniform(0.65, 0.98), 2),
        "bbox_x1": x1,
        "bbox_y1": y1,
        "bbox_x2": round(x1 + random.uniform(40, 180), 1),
        "bbox_y2": round(y1 + random.uniform(40, 180), 1),
        "material_type": GARBAGE_CLASSES[class_id][2],
    }


def detect_image(image_bytes: bytes) -> list[dict]:
    """
    对单张图片做目标检测（存根）。
    真实现：加载 YOLO 模型 → 推理 → 返回 NMS 后的目标列表。
    """
    # 模拟推理耗时
    time.sleep(random.uniform(0.3, 0.8))
    # 模拟检出 2-6 个目标
    class_ids = random.sample(list(GARBAGE_CLASSES.keys()), k=random.randint(2, 6))
    return [_make_mock_detection(cid) for cid in class_ids]


def detect_video_frames(frame_count: int = 12) -> list[dict]:
    """
    对视频逐帧推理（存根）：返回多帧检测结果的合并列表，
    每帧在结果里带 frame_index。
    """
    results = []
    for frame in range(frame_count):
        # 每帧检出 0-4 个目标
        for cid in random.sample(list(GARBAGE_CLASSES.keys()), k=random.randint(0, 4)):
            det = _make_mock_detection(cid)
            det["frame_index"] = frame
            results.append(det)
    return results


def compute_pollution_level(class_ids: list[int]) -> str:
    """
    根据检出的目标类别评估污染等级（模拟阈值逻辑）。
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
    视频检测后台任务（存根）：模拟从 pending → processing → completed。
    由 FastAPI BackgroundTasks 调用，独立开数据库会话写库。
    真实现：读取视频 → 抽帧 → YOLO 逐帧推理 → 写 detection_results。
    """
    # 延迟导入，避免模块加载时依赖数据库
    from database import SessionLocal
    from models import DetectionResult, DetectionTask, TaskStatus

    db = SessionLocal()
    start = time.time()
    try:
        task = db.query(DetectionTask).filter_by(id=task_id).first()
        if not task:
            return

        task.status = TaskStatus.processing
        db.commit()

        # 模拟逐帧推理耗时
        time.sleep(random.uniform(2, 4))

        frame_results = detect_video_frames(frame_count=12)
        for det in frame_results:
            db.add(
                DetectionResult(
                    task_id=task_id,
                    frame_index=det["frame_index"],
                    class_id=det["class_id"],
                    class_name=det["class_name"],
                    confidence=det["confidence"],
                    bbox_x1=det["bbox_x1"],
                    bbox_y1=det["bbox_y1"],
                    bbox_x2=det["bbox_x2"],
                    bbox_y2=det["bbox_y2"],
                    material_type=det["material_type"],
                )
            )

        task.total_objects = len(frame_results)
        task.pollution_level = compute_pollution_level([d["class_id"] for d in frame_results])
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
