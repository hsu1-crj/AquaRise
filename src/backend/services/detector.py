"""
检测服务（YOLO 真推理）
=====================================
调用 src/vision/best.pt（22 类 TrashCan 模型）做目标检测。

- 模型懒加载 + 进程内单例（threading.Lock 防并发初始化竞态）
- ultralytics 延迟导入：不装 ultralytics 也能正常启动后端，首次检测才加载权重
- 只返回/入库垃圾类（YOLO ID 8-21），rov(0)/plant(1)/animal_*(2-7) 8 个背景类被过滤

路由层契约保持不变，替换存根逻辑即可接入真实模型。
"""

import os
import threading
import time
from datetime import datetime

import config

# 14 类垃圾（YOLO ID 8-21）: id -> (英文, 中文, 材质)
# 英文标签 = 模型 names；中文/材质参考 CLAUDE.md 类别说明
GARBAGE_CLASSES = {
    8: ("trash_clothing", "衣物", "织物"),
    9: ("trash_pipe", "管道", "金属/塑料"),
    10: ("trash_bottle", "瓶子", "塑料/玻璃"),
    11: ("trash_bag", "塑料袋", "塑料"),
    12: ("trash_snack_wrapper", "零食包装", "塑料"),
    13: ("trash_can", "金属罐", "金属"),
    14: ("trash_cup", "杯子", "塑料"),
    15: ("trash_container", "容器", "塑料/金属"),
    16: ("trash_unknown_instance", "未知垃圾", "未知"),
    17: ("trash_branch", "树枝/木头", "木质"),
    18: ("trash_wreckage", "残骸/碎片", "金属/混合"),
    19: ("trash_tarp", "防水布", "塑料/布料"),
    20: ("trash_rope", "绳索", "尼龙/纤维"),
    21: ("trash_net", "渔网", "尼龙"),
}

# 高危害类别（用于污染等级评估）：残骸(18) 大型碎片 + 绳索(20)/渔网(21) 缠绕危害
HIGH_HAZARD_IDS = {18, 20, 21}

# 跨帧去重阈值：同一类别、位置高度重叠(IoU>0.5)视为同一目标，避免静态/拼接视频逐帧重复计数
IOU_DEDUP_THRESHOLD = 0.5

# 场景切换阈值：帧平均绝对差超过该值视为"出现新画面"，据此追加一张预览帧。
# 实测拼接视频段内噪声 ~0.02、段间边界 ~4-5，取 2.5 可清晰分离；真视频运动帧差一般 < 2.5，
# 由 MAX_PREVIEWS 兜底防止无限累积。
SCENE_CHANGE_THRESHOLD = 2.5
# 单个视频最多保存的预览帧数（防长视频无限累积）
MAX_PREVIEWS = 30


def _iou(box_a: list, box_b: list) -> float:
    """计算两个 [x1, y1, x2, y2] 边界框的交并比(IoU)。"""
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, box_a[2] - box_a[0]) * max(0.0, box_a[3] - box_a[1])
    area_b = max(0.0, box_b[2] - box_b[0]) * max(0.0, box_b[3] - box_b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


# 视频任务实时进度（内存态）：task_id -> {"progress", "processed_frames", "total_frames", "preview_url"}
# 供 /detect/status 轮询返回，实现前端实时可视化；进程重启即清空，仅影响进行中任务
VIDEO_PROGRESS: dict[int, dict] = {}


def get_video_progress(task_id: int) -> dict:
    """读取视频任务实时进度（无则返回空 dict）。"""
    return VIDEO_PROGRESS.get(task_id, {})


def restore_video_indexes() -> None:
    """后端重启后重建视频媒体索引。

    预览帧 / 标注视频文件已落盘（uploads/video_preview、uploads/video_annotated），
    但它们的 URL 索引存在内存 VIDEO_PROGRESS，进程重启即丢。启动时扫描磁盘目录，
    把已完成视频任务的媒体 URL 恢复回去，保证重启后「查看详情」仍可预览/回放。
    """
    preview_root = os.path.join(config.UPLOAD_DIR, "video_preview")
    ann_root = os.path.join(config.UPLOAD_DIR, "video_annotated")
    restored = 0

    def _entry(task_id: int) -> dict:
        return VIDEO_PROGRESS.setdefault(
            task_id,
            {
                "progress": 100.0,
                "processed_frames": 0,
                "total_frames": 0,
                "preview_url": None,
                "preview_urls": [],
                "annotated_video_url": None,
            },
        )

    if os.path.isdir(preview_root):
        for name in os.listdir(preview_root):
            task_dir = os.path.join(preview_root, name)
            if not os.path.isdir(task_dir):
                continue
            try:
                task_id = int(name)
            except ValueError:
                continue
            # 帧文件为 {index}.jpg，需按数字排序（"10.jpg" 应在 "2.jpg" 之后）
            urls = sorted(
                (
                    f"/uploads/video_preview/{task_id}/{f}"
                    for f in os.listdir(task_dir)
                    if f.lower().endswith(".jpg") and f.rsplit(".", 1)[0].isdigit()
                ),
                key=lambda url: int(url.rsplit("/", 1)[1].split(".")[0]),
            )
            if not urls:
                continue
            entry = _entry(task_id)
            entry["preview_urls"] = urls
            entry["preview_url"] = urls[-1]  # 最新一帧作封面
            restored += 1

    if os.path.isdir(ann_root):
        for name in os.listdir(ann_root):
            mp4 = os.path.join(ann_root, name, "annotated.mp4")
            if not (os.path.isfile(mp4) and os.path.getsize(mp4) > 0):
                continue
            try:
                task_id = int(name)
            except ValueError:
                continue
            _entry(task_id)["annotated_video_url"] = f"/uploads/video_annotated/{task_id}/annotated.mp4"
            restored += 1

    print(f"[detector] restored {restored} video media index entries from disk")


# 中文字体缓存（按字号懒加载，标注视频逐帧绘制时避免重复加载字体）
_CHINESE_FONT_CACHE: dict[int, object] = {}


def _get_chinese_font(size: int = 16):
    """加载微软雅黑字体（带缓存）；缺失时回退 PIL 默认字体。"""
    from PIL import ImageFont

    if size not in _CHINESE_FONT_CACHE:
        try:
            _CHINESE_FONT_CACHE[size] = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", size)
        except Exception:
            _CHINESE_FONT_CACHE[size] = ImageFont.load_default()  # 兜底：字体缺失时不至于崩溃
    return _CHINESE_FONT_CACHE[size]


def _draw_preview(frame, result):
    """在帧副本上画垃圾检测框（中文标签+置信度百分比，与多图识别一致），返回标注帧 BGR。

    供预览帧与标注视频共用：每个检测框画黄色边框，框上方画中文标签。
    """
    import cv2
    import numpy as np

    img = frame.copy()
    if result is None or result.boxes is None:
        return img

    labels: list[tuple[int, int, str]] = []
    for box in result.boxes:
        cls_id = int(box.cls[0])
        if cls_id not in GARBAGE_CLASSES:
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
        conf = float(box.conf[0])
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 200, 255), 2)
        # 与多图识别一致：中文类别 + 置信度百分比（如 瓶子 93%）
        _, cn_name, _ = GARBAGE_CLASSES[cls_id]
        labels.append((x1, max(y1 - 18, 0), f"{cn_name} {conf * 100:.0f}%"))

    if not labels:
        return img
    # OpenCV putText 不支持中文，改用 PIL + 微软雅黑一次性绘制全部标签
    from PIL import Image, ImageDraw

    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil_img)
    font = _get_chinese_font(16)
    for x, y, text in labels:
        # 注意：cv2 的 (0,200,255) 是 BGR=黄色；PIL ImageDraw 是 RGB，
        # 需转成 (255,200,0)，否则文字会画成青色、与黄色框不一致
        draw.text((x, y), text, fill=(255, 200, 0), font=font)
    return cv2.cvtColor(np.asarray(pil_img), cv2.COLOR_RGB2BGR)


def _save_preview(task_id: int, index: int, img) -> str | None:
    """保存标注预览帧到 uploads/video_preview/{task_id}/{index}.jpg，返回可访问 URL。"""
    import cv2

    dir_path = os.path.join(config.UPLOAD_DIR, "video_preview", str(task_id))
    os.makedirs(dir_path, exist_ok=True)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if not ok:
        return None
    file_path = os.path.join(dir_path, f"{index}.jpg")
    with open(file_path, "wb") as f:
        f.write(buf.tobytes())
    return f"/uploads/video_preview/{task_id}/{index}.jpg"


def _annotated_image_url(task_id: int, file_path: str, rows) -> str | None:
    """图片任务：把已入库的检测框+中文标签画回原图，存 uploads/image_detail/{task_id}.jpg。

    供检测历史「查看详情」使用（内存 VIDEO_PROGRESS 在重启后丢失，无法拿到实时标注图）。
    复用 _draw_preview 的画框/中文标签逻辑；文件已生成则直接复用缓存。失败返回 None。
    """
    import cv2
    import numpy as np

    try:
        dir_path = os.path.join(config.UPLOAD_DIR, "image_detail")
        os.makedirs(dir_path, exist_ok=True)
        out_path = os.path.join(dir_path, f"{task_id}.jpg")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return f"/uploads/image_detail/{task_id}.jpg"

        img = cv2.imread(file_path)
        if img is None:
            return None
        labels: list[tuple[int, int, str]] = []
        for r in rows:
            bbox = (r.bbox_x1, r.bbox_y1, r.bbox_x2, r.bbox_y2)
            if any(v is None for v in bbox):
                continue
            x1, y1, x2, y2 = (int(v) for v in bbox)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 200, 255), 2)
            labels.append((x1, max(y1 - 18, 0), f"{r.class_name} {r.confidence * 100:.0f}%"))

        if labels:
            from PIL import Image, ImageDraw

            pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
            draw = ImageDraw.Draw(pil_img)
            font = _get_chinese_font(16)
            for x, y, text in labels:
                draw.text((x, y), text, fill=(255, 200, 0), font=font)
            img = cv2.cvtColor(np.asarray(pil_img), cv2.COLOR_RGB2BGR)

        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            return None
        with open(out_path, "wb") as f:
            f.write(buf.tobytes())
        return f"/uploads/image_detail/{task_id}.jpg"
    except Exception:
        return None


def _scene_changed(frame, last_preview, threshold: float = SCENE_CHANGE_THRESHOLD) -> bool:
    """场景切换检测：当前帧与最近一张已保存预览的缩小图平均绝对差超过阈值即视为新画面。

    用于"拼接/静态视频按内容变化追加预览图"：每出现一张新的画面就新增一帧预览。
    """
    import cv2

    small_a = cv2.resize(frame, (160, 90))
    small_b = cv2.resize(last_preview, (160, 90))
    diff = cv2.absdiff(small_a, small_b)
    return float(diff.mean()) > threshold


def _save_crop(task_id: int, row_id: int, frame, box) -> str | None:
    """按检测框裁剪目标缩略图，保存到 uploads/video_crops/{task_id}/{row_id}.jpg。

    外扩 20%（最小 5px）留白、超过 320px 降采样，供前端目标列表展示小图。
    row_id 用 DetectionResult 行 id，结果接口据此拼 URL，无需新增数据库字段。
    """
    import cv2

    h, w = frame.shape[:2]
    x1 = max(0, int(box[0])); y1 = max(0, int(box[1]))
    x2 = min(w - 1, int(box[2])); y2 = min(h - 1, int(box[3]))
    pad_x = max(5, int((x2 - x1) * 0.2))
    pad_y = max(5, int((y2 - y1) * 0.2))
    cx1, cy1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    cx2, cy2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
    if cx2 <= cx1 or cy2 <= cy1:
        return None
    crop = frame[cy1:cy2, cx1:cx2]
    ch, cw = crop.shape[:2]
    if max(ch, cw) > 320:
        scale = 320 / max(ch, cw)
        crop = cv2.resize(
            crop, (int(cw * scale), int(ch * scale)), interpolation=cv2.INTER_AREA
        )
    dir_path = os.path.join(config.UPLOAD_DIR, "video_crops", str(task_id))
    os.makedirs(dir_path, exist_ok=True)
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        return None
    file_path = os.path.join(dir_path, f"{row_id}.jpg")
    with open(file_path, "wb") as f:
        f.write(buf.tobytes())
    return f"/uploads/video_crops/{task_id}/{row_id}.jpg"


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
            continue  # 忽略 rov(0)/plant(1)/animal_*(2-7) 等背景类
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


def _annotated_video_writer(path: str, width: int, height: int, fps: float):
    """返回标注视频写入器（H.264/MP4，浏览器可直接播放）。

    基于 imageio_ffmpeg 自带 ffmpeg 的 libx264 编码（本机 OpenCV 无 H.264 编码器，
    只能输出浏览器不认的 mp4v）。返回生成器：`send(None)` 启动后逐帧 `send(BGR 字节)`，
    结束 `close()`；失败返回 None（不阻塞视频任务）。
    """
    try:
        import imageio_ffmpeg

        gen = imageio_ffmpeg.write_frames(
            path,
            (width, height),
            fps=fps,
            pix_fmt_in="bgr24",
            pix_fmt_out="yuv420p",  # 4:2:0，浏览器/QuickTime 兼容
            codec="libx264",
            macro_block_size=2,  # yuv420p 要求宽高为偶数，2 保证偶数且几乎不缩放
        )
        gen.send(None)  # 启动 ffmpeg 子进程
        return gen
    except Exception:
        return None


def process_video_background(task_id: int, file_path: str):
    """
    视频检测后台任务（真实推理）：pending → processing → completed。
    由 FastAPI BackgroundTasks 调用，独立开数据库会话写库。
    逐帧推理，垃圾类（ID 8-21）目标写入 detection_results。
    跨帧 IoU 去重：同一类别、与已见目标高度重叠(IoU>0.5)的检测视为同一物体，只计一次，
    避免三张图片拼接等静态/重复场景在每一帧重复计数。
    """
    # 延迟导入，避免模块加载时依赖数据库
    from database import SessionLocal
    from models import DetectionResult, DetectionTask, TaskStatus

    import cv2

    db = SessionLocal()
    start = time.time()
    garbage_ids: list[int] = []
    seen_objects: list[dict] = []  # 已入账目标：{"class_id", "box":[x1,y1,x2,y2]}
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

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        VIDEO_PROGRESS[task_id] = {
            "progress": 0,
            "processed_frames": 0,
            "total_frames": total_frames,
            "preview_url": None,
            "preview_urls": [],
            "annotated_video_url": None,
        }

        # 标注视频写入器：逐帧把检测框/中文标签画到副本上，输出可回放的 MP4
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        out_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
        out_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
        ann_dir = os.path.join(config.UPLOAD_DIR, "video_annotated", str(task_id))
        os.makedirs(ann_dir, exist_ok=True)
        ann_path = os.path.join(ann_dir, "annotated.mp4")
        writer = _annotated_video_writer(ann_path, out_w, out_h, fps)

        frame_index = 0
        preview_urls: list[str] = []  # 已保存的预览帧 URL（按场景逐张累积）
        last_preview = None  # 最近一张已保存预览帧，用于场景切换判断
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
                        # 跨帧去重：同一类别、与已见目标 IoU>阈值 → 同一物体，跳过
                        cur_box = [x1, y1, x2, y2]
                        if any(
                            s["class_id"] == cls_id and _iou(s["box"], cur_box) > IOU_DEDUP_THRESHOLD
                            for s in seen_objects
                        ):
                            continue
                        seen_objects.append({"class_id": cls_id, "box": cur_box})
                        _, cn_name, material = GARBAGE_CLASSES[cls_id]
                        row = DetectionResult(
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
                        db.add(row)
                        db.flush()  # 拿到行 id，用于裁剪缩略图命名
                        _save_crop(task_id, row.id, frame, cur_box)
                        garbage_ids.append(cls_id)

                # 场景切换 → 追加一张标注预览帧：拼接/静态视频按内容变化逐张累积
                # （每检测到"新画面"放一张，3 张图片拼成的视频即累积出 3 张预览）
                if last_preview is None or (
                    len(preview_urls) < MAX_PREVIEWS and _scene_changed(frame, last_preview)
                ):
                    preview_img = _draw_preview(frame, result)
                    url = _save_preview(task_id, len(preview_urls), preview_img)
                    if url:
                        preview_urls.append(url)
                        last_preview = frame.copy()
                        VIDEO_PROGRESS[task_id]["preview_urls"] = list(preview_urls)
                        VIDEO_PROGRESS[task_id]["preview_url"] = url
                # 标注视频：把带框画面写入回放视频（每帧都写，H.264 编码）
                if writer is not None:
                    writer.send(_draw_preview(frame, result).tobytes())
                frame_index += 1
                processed = frame_index
                progress = min(100.0, processed / total_frames * 100) if total_frames else 100.0
                VIDEO_PROGRESS[task_id].update(
                    {"progress": round(progress, 1), "processed_frames": processed}
                )
        finally:
            cap.release()
            if writer is not None:
                try:
                    writer.close()  # 结束 stdin 并等待 ffmpeg 完成收尾
                except Exception:
                    pass

        # 标注视频写好后挂到进度上，前端完成态据此播放
        if writer is not None and os.path.exists(ann_path) and os.path.getsize(ann_path) > 0:
            VIDEO_PROGRESS[task_id]["annotated_video_url"] = f"/uploads/video_annotated/{task_id}/annotated.mp4"

        VIDEO_PROGRESS[task_id]["progress"] = 100.0
        VIDEO_PROGRESS[task_id]["processed_frames"] = frame_index
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
