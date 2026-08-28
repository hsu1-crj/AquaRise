"""通知发布中枢：内存态 SSE 事件分发（行数据持久化在 notify()，此处只做实时推送）。

- 每用户每连接一个 asyncio.Queue（多标签页 = 多队列，各自消费，发布时向全部副本广播）。
- publish() 通过历险时捕获的主事件循环 call_soon_threadsafe 投递，保证：
    1) 同步 worker 线程（视频检测 BackgroundTasks 在线程池跑）可安全推送；
    2) 图片检测/报告生成（请求处理期间仍可能在 loop 线程）同样安全。
- 用户无队列 / loop 未启动 / 已关闭时发布为 no-op —— 行已落库，SSE 重连快照兜底。
"""

import asyncio
from typing import Any


class NotificationHub:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: dict[int, set[asyncio.Queue]] = {}

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def register(self, user_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._queues.setdefault(user_id, set()).add(q)
        return q

    def unregister(self, user_id: int, q: asyncio.Queue) -> None:
        coll = self._queues.get(user_id)
        if not coll:
            return
        coll.discard(q)
        if not coll:
            self._queues.pop(user_id, None)

    def publish(self, user_id: int, payload: Any) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        coll = self._queues.get(user_id)
        if not coll:
            return
        for q in list(coll):
            loop.call_soon_threadsafe(q.put_nowait, payload)


hub = NotificationHub()


def notify(
    db,
    user_id: int,
    ntype,
    title: str,
    body: str | None = None,
    link_page: str | None = None,
    ref_id: int | None = None,
) -> None:
    """写入一条通知 + 实时推送（前端形状的 dict，含 unreadCount）。

    设计约束：调用点必须在主业务 commit 之后调用（本函数内部会 commit 并可能 rollback，
    不能吞掉调用方未提交的变更）。通知环节任何失败都不影响主业务流程。
    """
    try:
        from models import Notification, NotificationType

        if isinstance(ntype, str):
            ntype = NotificationType(ntype)
        row = Notification(
            user_id=user_id,
            type=ntype,
            title=title,
            body=body,
            link_page=link_page,
            ref_id=ref_id,
        )
        db.add(row)
        db.flush()
        unread = (
            db.query(Notification.id)
            .filter(Notification.user_id == user_id, Notification.is_read.is_(False))
            .count()
        )
        db.commit()
        db.refresh(row)
    except Exception:
        db.rollback()
        return

    hub.publish(
        user_id,
        {
            "type": "notification",
            "item": {
                "id": row.id,
                "type": row.type.value,
                "title": row.title,
                "body": row.body,
                "linkPage": row.link_page,
                "refId": row.ref_id,
                "isRead": row.is_read,
                "createdAt": row.created_at.isoformat() if row.created_at else None,
            },
            "unreadCount": unread,
        },
    )