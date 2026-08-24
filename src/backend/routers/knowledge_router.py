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

import logging
import os
import re
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

import config
from auth import get_current_user
from database import get_db
from models import DocStatus, KnowledgeDoc, User
from schemas import DocumentAnalysisResponse, KnowledgeDocInfo, ReportSolution

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])

# 允许上传的文件类型（doc/docx 仅保存、暂不支持向量化）
ALLOWED_DOC = {".pdf", ".doc", ".docx", ".txt", ".md", ".html"}
# 能被 RAG 向量化的类型（对应 knowledge_base 的 loaders）
VECTORIZABLE_DOC = {".pdf", ".txt", ".md", ".html"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_MIME = {
    ".pdf": {"application/pdf", "application/octet-stream"},
    ".doc": {"application/msword", "application/octet-stream"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"},
    ".txt": {"text/plain", "application/octet-stream"},
    ".md": {"text/markdown", "text/plain", "application/octet-stream"},
    ".html": {"text/html", "application/xhtml+xml", "application/octet-stream"},
}

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
    """把单个文件增量加入向量库，返回分片数。

    向量链路（Chroma/嵌入模型）不可用时降级返回 0：文件已保存到 RAG 源目录，
    上传后调用 reload_knowledge_retriever() 让词法回退检索立即感知，对话仍可检索。
    """
    try:
        return _get_kb().add_document(file_path)
    except Exception as e:
        logger.warning("向量化不可用，降级为词法检索（%s）", e)
        return 0


@router.post("/upload", response_model=KnowledgeDocInfo)
async def upload_doc(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传知识库文档：保存到 RAG 源目录 + 增量向量化 + 写库"""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_DOC:
        raise HTTPException(status_code=400, detail="不支持的文件类型，支持 pdf/doc/docx/txt/md/html")
    if file.content_type and file.content_type.lower() not in ALLOWED_MIME.get(ext, set()):
        raise HTTPException(status_code=400, detail=f"文件 MIME 类型与扩展名不匹配：{file.content_type}")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="不能上传空文件")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="报告文件不能超过 20 MB")

    # 保存到 RAG 源目录（data/knowledge），与离线构建共用同一目录
    os.makedirs(config.KNOWLEDGE_DIR, exist_ok=True)
    file_path = os.path.join(config.KNOWLEDGE_DIR, f"{uuid.uuid4().hex}{ext}")
    with open(file_path, "wb") as f:
        f.write(raw)

    # 增量向量化：支持的类型即时入库；doc/docx 仅保存、不可检索
    chunk_count = 0
    if ext in VECTORIZABLE_DOC:
        chunk_count = _vectorize_file(file_path)

    # 让对话检索链路感知新文档（词法回退需重建索引；向量链路无需操作）
    try:
        from src.LLM.chat_api import reload_knowledge_retriever

        reload_knowledge_retriever()
    except Exception as exc:
        logger.warning("知识库检索重载失败: %s", exc)

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


@router.post("/{doc_id}/analyze", response_model=DocumentAnalysisResponse)
async def analyze_knowledge_doc(
    doc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """对上传的外部质量报告做轻量结构化分析，供聊天页直接展示和追问。"""
    doc = db.query(KnowledgeDoc).filter(KnowledgeDoc.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="知识库文档不存在")
    if current_user.role.value != "admin" and doc.uploaded_by not in {None, current_user.id}:
        raise HTTPException(status_code=403, detail="无权限分析该文档")
    try:
        if doc.file_type.lower() == "pdf":
            try:
                from pypdf import PdfReader
                pages = PdfReader(doc.file_path).pages
                content = "\n".join((page.extract_text() or "") for page in pages)[:300_000]
            except Exception:
                content = open(doc.file_path, "rb").read(300_000).decode("utf-8", errors="ignore")
        else:
            content = open(doc.file_path, "r", encoding="utf-8", errors="ignore").read(300_000)
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"无法读取报告内容：{exc}") from exc
    compact = re.sub(r"\s+", " ", content)
    level_match = re.search(r"污染等级[：: ]*(优|良|中|差|严重)", compact)
    count_match = re.search(r"(?:检出垃圾总数|识别目标|垃圾目标)[：: ]*(\d+)", compact)
    score_match = re.search(r"质量评分?[：: ]*(\d+(?:\.\d+)?)", compact)
    level = level_match.group(1) if level_match else "待确认"
    count = int(count_match.group(1)) if count_match else None
    score = score_match.group(1) if score_match else None
    risk = {"优": "低", "良": "低", "中": "中", "差": "高", "严重": "极高"}.get(level, "待确认")
    findings = [
        f"报告来源：{doc.file_name}。",
        f"识别到污染等级“{level}”。" if level != "待确认" else "报告未提供可直接识别的污染等级，需要人工确认。",
    ]
    if count is not None:
        findings.append(f"报告记录的目标数量为 {count} 个。")
    if score is not None:
        findings.append(f"报告质量评分为 {score}。")
    payload = {
        "id": doc.id,
        "report_id": 0,
        "doc_id": doc.id,
        "status": "completed",
        "summary": f"已完成对“{doc.file_name}”的结构化扫描。当前风险级别为“{risk}”，建议核对原始报告后执行分级治理。",
        "risk_level": risk,
        "key_findings": findings,
        "possible_causes": ["外部报告未提供完整的污染来源证据，建议补充监测点位、时间、潮汐和垃圾类别信息。"],
        "solutions": [
            ReportSolution(priority="P0", action="核对报告原文、原始影像和关键统计字段，确认等级、数量和评分没有录入偏差。", owner="报告审核人员", deadline="24小时内", validation="形成字段核对清单并标记缺失项").model_dump(),
            ReportSolution(priority="P1", action="针对报告中的高风险类别安排现场复核与分区清理，疑似缠绕物由专业人员处置。", owner="现场治理团队", deadline="72小时内", validation="保存治理前后影像、数量和位置记录"),
            ReportSolution(priority="P2", action="治理后按相同采样条件复测，并将结果与本报告建立前后对比。", owner="监测管理人员", deadline="治理后7天内", validation="比较数量、密度、污染等级和高风险类别"),
        ],
        "follow_up_monitoring": ["补充报告缺少的海域、点位、时间和采样条件", "治理后使用同路线复测", "连续观察高风险类别变化"],
        "evidence": [{"id": f"DOC-{doc.id}", "class_name": "报告原文", "confidence": 1.0, "material": "报告字段", "source": doc.file_name}],
        "model_name": "ds-ocean_mingzhe",
        "created_at": f"{doc.created_at:%Y-%m-%d %H:%M}",
    }
    return DocumentAnalysisResponse(**payload)
