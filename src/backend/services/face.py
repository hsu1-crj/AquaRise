"""
人脸识别服务（InsightFace 512维嵌入）
=====================================
检测+对齐+嵌入一条链路由 InsightFace FaceAnalysis 完成（工业级精度，解决自研灰度特征误识率高的问题）。

- 嵌入：FaceAnalysis(buffalo_l) 输出 512 维 L2 归一化的人脸嵌入向量。
- 匹配：对库内每张录入人脸算**欧氏距离**，取最小距离；小于 FACE_EMBEDDING_THRESHOLD 判定为同一人。
  （归一化嵌入的欧氏距离越小越相似；阈值调严可显著降低“不同人误登录”。）

模型懒加载 + 进程内单例（threading.Lock 防并发初始化竞态），与 services/detector.py 一致。
权重包（buffalo_l）首次调用时由 insightface 自动下载到本地模型目录，离线可预先下载。
"""

import threading

import numpy as np

import config
from models import FaceRecord, User

# InsightFace 解析器单例
_app = None
_app_lock = threading.Lock()


def _resolve_ctx_id() -> int:
    """解析 InsightFace 推理设备：环境变量 FACE_CTX_ID 显式指定时优先；
    缺省自动探测——有 CUDA 用 GPU(0)，否则降级 CPU(-1)，避免无 GPU 环境直接 500。"""
    if config.FACE_CTX_ID:
        try:
            return int(config.FACE_CTX_ID)
        except ValueError:
            pass
    try:
        import onnxruntime as ort

        if "CUDAExecutionProvider" in ort.get_available_providers():
            return 0
    except Exception:
        pass
    return -1


def _get_app():
    """懒加载 InsightFace FaceAnalysis 单例（进程内共享，首次调用才下载/加载权重）"""
    global _app
    if _app is None:
        with _app_lock:
            if _app is None:
                from insightface.app import FaceAnalysis

                _app = FaceAnalysis(name=config.FACE_MODEL_PACK)
                _app.prepare(ctx_id=_resolve_ctx_id(), det_size=(640, 640))
    return _app


def _decode_image(image_bytes: bytes):
    """字节 → BGR numpy 数组；返回 (img, height, width)"""
    import cv2

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解析图片数据，请确认上传的是有效图片")
    height, width = img.shape[:2]
    return img, height, width


def _extract_embedding(img_bgr) -> np.ndarray:
    """从图片提取人脸 512 维嵌入；无人脸抛 ValueError（由路由层转 400/401）。"""
    app = _get_app()
    faces = app.get(img_bgr)
    # 取置信度最高的人脸
    best = max(faces, key=lambda f: getattr(f, "det_score", 0), default=None)
    if best is None:
        raise ValueError("未检测到人脸，请正对摄像头拍摄清晰照片")
    emb = getattr(best, "normed_embedding", None)
    if emb is None:
        emb = getattr(best, "embedding", None)
    if emb is None:
        raise ValueError("无法提取人脸特征，请换一张清晰的照片")
    vec = np.asarray(emb, dtype=np.float32)
    # 若拿到的是未归一化嵌入，则自行 L2 归一化，保证距离语义一致
    norm = float(np.linalg.norm(vec))
    if norm < 1e-9:
        raise ValueError("人脸区域过暗，无法提取特征")
    return vec / norm


def _restore_descriptor(blob: bytes) -> np.ndarray:
    """库内二进制特征 → numpy 向量"""
    return np.frombuffer(blob, dtype=np.float32)


def extract_feature(image_bytes: bytes) -> np.ndarray:
    """从图片字节提取人脸 512 维嵌入（解码 + InsightFace 推理，纯计算无 DB）。

    供路由层放入线程池执行，避免重型推理阻塞事件循环。
    解码失败 / 无人脸 / 无法提取特征抛 ValueError（由路由层区分提示）。
    """
    img_bgr, _, _ = _decode_image(image_bytes)
    return _extract_embedding(img_bgr)


def create_face_record(db, user: User, descriptor: np.ndarray, name: str = "人脸") -> FaceRecord:
    """录入人脸：校验数量(≤MAX_FACES_PER_USER) → 入库。仅做 DB 操作，留在事件循环线程。

    descriptor 为已提取的嵌入（由路由层在线程池中调用 extract_feature 得到）。
    数量超限抛 ValueError（由路由层转 400）。
    """
    count = db.query(FaceRecord).filter(FaceRecord.user_id == user.id).count()
    if count >= config.MAX_FACES_PER_USER:
        raise ValueError(f"每个账号最多录入 {config.MAX_FACES_PER_USER} 张人脸，已达上限")

    record = FaceRecord(
        user_id=user.id,
        name=(name or "人脸").strip()[:30] or "人脸",
        descriptor=np.asarray(descriptor, dtype=np.float32).tobytes(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def match_face(db, probe: np.ndarray) -> User | None:
    """根据探针嵌入识别账号：遍历库内所有人脸求最小欧氏距离，小于阈值返回对应用户。仅做 DB 操作。

    probe 为已提取的探针嵌入（由路由层在线程池中调用 extract_feature 得到）。
    无人录入 / 无命中返回 None。
    """
    candidates = db.query(FaceRecord).all()
    if not candidates:
        return None

    best_user: User | None = None
    best_dist = float("inf")
    for rec in candidates:
        stored = _restore_descriptor(rec.descriptor)
        if stored.shape != probe.shape:
            continue
        dist = float(np.linalg.norm(stored - probe))
        if dist < best_dist:
            best_dist = dist
            best_user = db.query(User).filter(User.id == rec.user_id).first()

    if best_user is None or best_dist > config.FACE_EMBEDDING_THRESHOLD:
        return None
    return best_user
