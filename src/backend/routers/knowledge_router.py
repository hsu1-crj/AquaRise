"""
知识库 API（RAG 文档管理）
=====================================
POST /api/v1/knowledge/upload   上传文档（真实 RAG 向量化后续接入）
GET  /api/v1/knowledge/         文档列表
DELETE /api/v1/knowledge/{id}   删除文档
"""

import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

import config
from auth import get_current_user
from database import get_db
from models import DocStatus, KnowledgeDoc, User
from schemas import KnowledgeDocInfo

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

ALLOWED_DOC = {".pdf", ".doc", ".docx", ".txt", ".md"}


@router.post("/upload", response_model=KnowledgeDocInfo)
async def upload_doc(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传知识库文档：保存文件 + 写库（向量化待 RAG 模块就绪后接入）"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_DOC:
        raise HTTPException(status_code=400, detail="不支持的文件类型，支持 pdf/doc/docx/txt/md")

    dir_path = os.path.join(config.UPLOAD_DIR, "knowledge")
    os.makedirs(dir_path, exist_ok=True)
    file_path = os.path.join(dir_path, f"{uuid.uuid4().hex}{ext}")
    with open(file_path, "wb") as f:
        f.write(file.file.read())

    doc = KnowledgeDoc(
        file_name=file.filename,
        file_type=ext.lstrip("."),
        file_path=file_path,
        file_size=os.path.getsize(file_path),
        chunk_count=0,  # 分片数量，向量化后填写
        status=DocStatus.completed,
        uploaded_by=current_user.id,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/", response_model=list[KnowledgeDocInfo])
async def list_docs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """文档列表"""
    rows = db.query(KnowledgeDoc).order_by(KnowledgeDoc.id.desc()).all()
    return rows


@router.delete("/{doc_id}")
async def delete_doc(
    doc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除文档（连同磁盘文件）"""
    doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    if os.path.exists(doc.file_path):
        try:
            os.remove(doc.file_path)
        except OSError:
            pass
    db.delete(doc)
    db.commit()
    return {"message": "已删除", "id": doc_id}
