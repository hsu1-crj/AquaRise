"""通知中心 API（铃铛）：
GET  /api/v1/notifications            通知列表（最新 20 条）+ 未读数
GET  /api/v1/notifications/stream     SSE 实时推送（init 快照 + 增量事件）
POST /api/v1/notifications/read-all   全部标记已读
POST /api/v1/notifications/{id}/read  单条标记已读（仅本人可见）

只推给触发者本人（user_id 归属），所有用户都有通知，走 get_current_user 而非模块权限。
"""

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Notification, User
from schemas import NotificationListResponse, to_frontend_notification
from services.notification_hub import hub

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


def _snapshot(db: Session, user_id: int) -> NotificationListResponse:
    """最新 20 条 + 未读数。SSE init 与 GET 列表共用同一口径。"""
    rows = (
        db.query(Notification)
        .filter(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(20)
        .all()
    )
    unread = (
        db.query(Notification.id)
        .filter(Notification.user_id == user_id, Notification.is_read.is_(False))
        .count()
    )
    return NotificationListResponse(
        items=[to_frontend_notification(r) for r in rows], unreadCount=unread
    )


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _snapshot(db, current_user.id)


@router.post("/read-all")
async def mark_all_read(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(Notification).filter(
        Notification.user_id == current_user.id, Notification.is_read.is_(False)
    ).update({Notification.is_read: True})
    db.commit()
    return {"ok": True}


@router.delete("/read-all")
async def delete_read_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除当前用户所有【已读】通知（未读消息保留）。"""
    result = db.query(Notification).filter(
        Notification.user_id == current_user.id, Notification.is_read.is_(True)
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": result or 0}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == current_user.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="通知不存在")
    if not row.is_read:
        row.is_read = True
        db.commit()
    return {"ok": True}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除一条通知（仅本人可见，删除后不可恢复）。"""
    row = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == current_user.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="通知不存在")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/stream")
async def stream_notifications(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE：先发 init 快照（含未读数），再推增量；25s 心跳防代理超时。"""
    user_id = current_user.id
    queue = hub.register(user_id)
    init = _snapshot(db, user_id)

    async def event_stream():
        try:
            yield f"data: {json.dumps({'type': 'init', 'items': [i.model_dump() for i in init.items], 'unreadCount': init.unreadCount}, ensure_ascii=False)}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=25)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        finally:
            hub.unregister(user_id, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )