"""
人脸识别认证路由
=====================================
- 录入（POST /api/v1/auth/face/enroll）    登录后上传人脸照片录入（最多 3 张）
- 列表（GET  /api/v1/auth/face/list）     当前账号已录入人脸
- 删除（DELETE /api/v1/auth/face/{id}）   删除某张人脸（校验归属）
- 登录（POST /api/v1/auth/face/login）    摄像头照片识别登录，成功签发 JWT

人脸登录成功后与密码登录一致：签 JWT + 记录会话，前端接入现有 storeToken/onLogin 流程。
"""

import asyncio

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
    """登录后录入人脸：multipart 上传照片，最多 3 张。"""
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
    return record


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
    return FaceListResponse(items=[FaceInfo.model_validate(r) for r in records])


@router.delete("/{face_id}", response_model=MessageResponse)
async def delete_face(
    face_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除指定人脸（仅能删自己账号的）。"""
    record = db.query(FaceRecord).filter(FaceRecord.id == face_id).first()
    if not record or record.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="人脸记录不存在")
    db.delete(record)
    db.commit()
    return MessageResponse(message="人脸记录已删除")


@router.post("/login", response_model=FaceLoginResponse)
async def face_login(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """人脸识别登录：multipart 上传照片，识别账号后签发 JWT 并记录会话。"""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="上传的照片不能为空")
    try:
        # InsightFace 推理是 CPU/GPU 密集同步调用，放线程池避免阻塞事件循环；
        # 库内匹配（match_face）留在事件循环线程
        probe = await asyncio.to_thread(face_service.extract_feature, image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    user = face_service.match_face(db, probe)
    if user is None:
        raise HTTPException(status_code=401, detail="未识别到已注册人脸，请先登录后在人脸注册中录入")
    token = create_access_token(user)
    record_login_session(db, user, token)
    return FaceLoginResponse(access_token=token, username=user.username)
