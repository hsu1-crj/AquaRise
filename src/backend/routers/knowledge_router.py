"""
知识库 API（RAG 文档管理）
=====================================
POST /api/v1/knowledge/upload    上传文档 → 保存 + 增量向量化入库
GET  /api/v1/knowledge/          文档列表
DELETE /api/v1/knowledge/{id}    删除文档（含磁盘文件与向量库分片）

文件保存到 RAG 源目录（data/knowledge），上传后立即调用
src/LLM/rag/knowledge_base.py 的 add_document() 做增量向量化，
因此对话（enable_rag=true）即可检索到刚上传的知识。
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

# 允许上传的文件类型（doc/docx 仅保存、暂不支持向量化）
ALLOWED_DOC = {".pdf", ".doc", ".docx", ".txt", ".md"}
# 能被 RAG 向量化的类型（对应 knowledge_base 的 loaders）
VECTORIZABLE_DOC = {".pdf", ".txt", ".md"}

# 惰性复用的知识库实例（避免每次上传重复加载嵌入模型）
_kb = None


def _get_kb():
    """返回 OceanKnowledgeBase 单例（目录来自 config / .env）"""
    global _kb
    if _kb is None:
        from src.LLM.rag.knowledge_base import OceanKnowledgeBase

        _kb = OceanKnowledgeBase(
            knowledge_dir=config.KNOWLEDGE_DIR,
            persist_dir=config.CHROMA_DIR,
        )
    return _kb


def _vectorize_file(file_path: str) -> int:
    """把单个文件增量加入向量库，返回分片数（失败抛异常）"""
    try:
        return _get_kb().add_document(file_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"向量化失败：{e}") from e


@router.post("/upload", response_model=KnowledgeDocInfo)
async def upload_doc(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传知识库文档：保存到 RAG 源目录 + 增量向量化 + 写库"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_DOC:
        raise HTTPException(status_code=400, detail="不支持的文件类型，支持 pdf/doc/docx/txt/md")

    # 保存到 RAG 源目录（data/knowledge），与离线构建共用同一目录
    os.makedirs(config.KNOWLEDGE_DIR, exist_ok=True)
    file_path = os.path.join(config.KNOWLEDGE_DIR, f"{uuid.uuid4().hex}{ext}")
    with open(file_path, "wb") as f:
        f.write(file.file.read())

    # 增量向量化：支持的类型即时入库；doc/docx 仅保存、不可检索
    chunk_count = 0
    if ext in VECTORIZABLE_DOC:
        chunk_count = _vectorize_file(file_path)

    doc = KnowledgeDoc(
        file_name=file.filename,
        file_type=ext.lstrip("."),
        file_path=file_path,
        file_size=os.path.getsize(file_path),
        chunk_count=chunk_count,
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
    """删除文档（连同磁盘文件与向量库分片）"""
    doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")

    # 从向量库删除该文档的分片
    try:
        _get_kb().remove_document(doc.file_path)
    except Exception:
        pass  # 向量库删除失败不阻塞，数据库记录照常删除

    # 删除磁盘文件
    if os.path.exists(doc.file_path):
        try:
            os.remove(doc.file_path)
        except OSError:
            pass

    db.delete(doc)
    db.commit()
    return {"message": "已删除", "id": doc_id}
