"""
人脸识别认证路由
=====================================
- 录入（POST /api/v1/auth/face/enroll）    登录后上传人脸照片录入（最多 3 张，照片留存供本人回看）
- 列表（GET  /api/v1/auth/face/list）     当前账号已录入人脸
- 照片（GET  /api/v1/auth/face/{id}/photo）回看某条已录入的人脸照片（仅本人）
- 删除（DELETE /api/v1/auth/face/{id}）   删除某张人脸（校验归属，照片一并清理）
- 登录（POST /api/v1/auth/face/login）    账号（用户名/手机号/邮箱）+ 人脸双因子登录，成功签发 JWT

人脸登录必须先输入账号：一张人脸可录入多个账号，全局刷脸会登进"最近录入的同脸账号"；
账号限定后只在所选账号的人脸库内比对，命中才签发 token。
"""

import asyncio
import base64
import os

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from auth import create_access_token, get_current_user, record_login_session
from database import get_db
from models import FaceRecord, User
from schemas import FaceInfo, FaceListResponse, FaceLoginResponse, MessageResponse
from services import face as face_service

router = APIRouter(prefix="/api/v1/auth/face", tags=["face"])


@router.post("/enroll", response_model=FaceInfo)
async def enroll_face(
    file: UploadFile = File(...),
    name: str = Form(default=""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """登录后录入人脸：multipart 上传照片，最多 3 张；照片落盘供本人回看。"""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="上传的照片不能为空")
    try:
        # InsightFace 推理是 CPU/GPU 密集同步调用，放线程池避免阻塞事件循环；
        # DB 写库（create_face_record）留在事件循环线程
        descriptor = await asyncio.to_thread(face_service.extract_feature, image_bytes)
        record = face_service.create_face_record(db, current_user, descriptor, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 照片落盘：录入成功后保存原始照片，供个人中心回看（失败不阻塞录入本身）
    photo_dir = os.path.join("uploads", "faces")
    os.makedirs(photo_dir, exist_ok=True)
    photo_path = os.path.join(photo_dir, f"{record.id}.jpg")
    try:
        with open(photo_path, "wb") as f:
            f.write(image_bytes)
        record.photo_path = photo_path
        db.commit()
        db.refresh(record)
    except OSError:
        photo_path = None

    return _face_info(record)


@router.get("/list", response_model=FaceListResponse)
async def list_faces(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前账号已录入人脸（不含特征向量）。"""
    records = (
        db.query(FaceRecord)
        .filter(FaceRecord.user_id == current_user.id)
        .order_by(FaceRecord.id.asc())
        .all()
    )
    return FaceListResponse(items=[_face_info(r) for r in records])


@router.get("/{face_id}/photo")
async def get_face_photo(
    face_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """回看已录入的人脸照片（仅本人；返回 data URL，不公开静态目录）。"""
    record = db.query(FaceRecord).filter(FaceRecord.id == face_id).first()
    if not record or record.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="人脸记录不存在")
    if not record.photo_path or not os.path.isfile(record.photo_path):
        raise HTTPException(status_code=404, detail="该记录没有留存照片")
    with open(record.photo_path, "rb") as f:
        return {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()}


@router.delete("/{face_id}", response_model=MessageResponse)
async def delete_face(
    face_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除指定人脸（仅能删自己账号的；照片文件一并清理）。"""
    record = db.query(FaceRecord).filter(FaceRecord.id == face_id).first()
    if not record or record.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="人脸记录不存在")
    if record.photo_path and os.path.isfile(record.photo_path):
        try:
            os.remove(record.photo_path)
        except OSError:
            pass
    db.delete(record)
    db.commit()
    return MessageResponse(message="人脸记录已删除")


@router.post("/login", response_model=FaceLoginResponse)
async def face_login(
    file: UploadFile = File(...),
    account: str = Form(default=""),
    db: Session = Depends(get_db),
):
    """人脸识别登录：账号（用户名/手机号/邮箱）+ 人脸双因子验证，通过后签发 JWT 并记录会话。

    账号必填：一张人脸可录入多个账号，必须先用账号锁定范围，再在该账号的人脸库内比对。
    """
    account = account.strip()
    if not account:
        raise HTTPException(status_code=400, detail="请先输入用户名/手机号/邮箱，再进行人脸识别登录")

    user = db.query(User).filter(User.username == account).first()
    if not user and "@" in account:
        user = db.query(User).filter(User.email == account).first()
    if not user:
        user = db.query(User).filter(User.phone_num == account).first()
    if not user:
        raise HTTPException(status_code=401, detail="账号信息不匹配，请确认后重试")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="上传的照片不能为空")
    try:
        # InsightFace 推理是 CPU/GPU 密集同步调用，放线程池避免阻塞事件循环
        probe = await asyncio.to_thread(face_service.extract_feature, image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not face_service.verify_user_face(db, user, probe):
        raise HTTPException(status_code=401, detail="人脸与该账号不匹配，或该账号未录入人脸")
    token = create_access_token(user)
    record_login_session(db, user, token)
    return FaceLoginResponse(access_token=token, username=user.username)


def _face_info(record: FaceRecord) -> FaceInfo:
    """FaceRecord → FaceInfo（hasPhoto 由照片是否留存推导）"""
    return FaceInfo(
        id=record.id,
        name=record.name,
        created_at=record.created_at,
        hasPhoto=bool(record.photo_path and os.path.isfile(record.photo_path)),
    )
