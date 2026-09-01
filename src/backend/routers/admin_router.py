"""
后台管理路由（RBAC 用户 / 用户组 / 概览）
=====================================
全部接口要求当前用户拥有「后台管理」功能模块（require_permission("admin")）。

保护规则（产品要求：只有最高管理员不能注销账号，其他账号均可注销）：
- 最高管理员（role=admin 种子账号，或 super_admin 组成员）不可被注销、不可被改组、密码仅可由本人修改；
- 其余账号（包括操作者自己）均可注销；注销自己的账号后前端会清除登录态返回登录页；
- 超级管理员组（code=super_admin）为系统内置：不可删除、模块集合不可修改。
"""

import os
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from auth import get_user_modules, group_request_item, hash_password, is_super_admin, require_permission
from database import get_db
from models import (
    MODULE_KEYS,
    MODULE_REGISTRY,
    ChatHistory,
    DetectionResult,
    DetectionTask,
    DigitalHumanSession,
    FaceRecord,
    GroupModule,
    GroupSwitchRequest,
    KnowledgeDoc,
    LoginSession,
    Notification,
    Report,
    ReportAnalysis,
    TaskStatus,
    User,
    UserGroup,
    UserRole,
)
from schemas import (
    AdminGroupCreateRequest,
    AdminGroupItem,
    AdminGroupUpdateRequest,
    AdminOverview,
    AdminResetPasswordRequest,
    AdminUserCreateRequest,
    AdminUserItem,
    AdminUserUpdateRequest,
    MessageResponse,
)
from services.notification_hub import hub, notify

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

# 所有后台接口统一守卫：拥有「后台管理」功能模块
AdminGuard = Depends(require_permission("admin"))

SUPER_ADMIN_CODE = "super_admin"


# ============ 工具 ============
_is_super_admin = is_super_admin  # 共享口径见 auth.py（role=admin 或 super_admin 组成员）


def _group_item(db: Session, group: UserGroup) -> AdminGroupItem:
    """UserGroup ORM → AdminGroupItem（补成员数）"""
    member_count = db.query(User).filter(User.group_id == group.id).count()
    return AdminGroupItem(
        id=group.id,
        code=group.code,
        name=group.name,
        description=group.description,
        is_system=group.is_system,
        modules=[m.module for m in group.modules],
        member_count=member_count,
        created_at=group.created_at,
    )


def _user_item(db: Session, user: User) -> AdminUserItem:
    """User ORM → AdminUserItem（补所属组与权限）"""
    group = db.query(UserGroup).filter(UserGroup.id == user.group_id).first() if user.group_id else None
    return AdminUserItem(
        id=user.id,
        username=user.username,
        email=user.email,
        phone_num=user.phone_num,
        role=user.role.value if isinstance(user.role, UserRole) else str(user.role),
        group_id=user.group_id,
        group_code=group.code if group else None,
        group_name=group.name if group else None,
        permissions=get_user_modules(db, user),
        created_at=user.created_at,
        is_super_admin=_is_super_admin(db, user),
    )


def _validate_modules(modules: list[str]) -> list[str]:
    """校验模块集合合法（去重、保序、必须在注册表内）"""
    invalid = [m for m in modules if m not in MODULE_KEYS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"未知功能模块：{', '.join(invalid)}")
    return list(dict.fromkeys(modules))


def _sync_group_modules(db: Session, group: UserGroup, modules: list[str]) -> None:
    """把组的模块集合整体覆盖为 modules（先删后插，幂等）"""
    db.query(GroupModule).filter(GroupModule.group_id == group.id).delete()
    for key in modules:
        db.add(GroupModule(group_id=group.id, module=key))


def _broadcast_permissions_changed(*user_ids: int) -> None:
    """向指定在线用户推送权限变更瞬时事件（SSE 直推，不落库、不进铃铛）。
    前端收到后重拉 /auth/me 刷新功能入口；目标不在线时为 no-op（刷新/回焦时兜底重拉）。"""
    for uid in user_ids:
        hub.publish(uid, {"type": "permissions_changed"})


def _remove_file_quietly(path: str | None) -> None:
    """尽力删除磁盘文件（上传产物 / HTML 报告）；失败不阻塞注销"""
    if not path:
        return
    try:
        abs_path = os.path.abspath(path)
        if os.path.isfile(abs_path):
            os.remove(abs_path)
    except OSError:
        pass


# ============ 模块注册表 ============
@router.get("/modules")
async def list_modules(current_user: User = AdminGuard):
    """功能模块注册表：后台「用户组-模块矩阵」勾选项的数据源"""
    return {"items": MODULE_REGISTRY}


# ============ 概览 ============
@router.get("/overview", response_model=AdminOverview)
async def admin_overview(current_user: User = AdminGuard, db: Session = Depends(get_db)):
    """后台概览：用户/组/任务/报告规模 + 各组成员分布 + 最近注册"""
    groups = db.query(UserGroup).order_by(UserGroup.id).all()
    task_count = db.query(DetectionTask).count()
    completed = db.query(DetectionTask).filter(DetectionTask.status == TaskStatus.completed).count()
    recent_users = (
        db.query(User).order_by(User.created_at.desc(), User.id.desc()).limit(5).all()
    )
    return AdminOverview(
        user_count=db.query(User).count(),
        group_count=len(groups),
        task_count=task_count,
        completed_task_count=completed,
        report_count=db.query(Report).count(),
        group_members=[_group_item(db, g) for g in groups],
        recent_users=[_user_item(db, u) for u in recent_users],
    )


# ============ 用户管理 ============
@router.get("/users")
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    query: str = Query("", description="按用户名/邮箱模糊搜索"),
    group_id: int | None = Query(None, description="按用户组过滤"),
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """后台用户列表（分页 + 搜索 + 组过滤）"""
    q = db.query(User)
    keyword = query.strip()
    if keyword:
        like = f"%{keyword}%"
        q = q.filter((User.username.like(like)) | (User.email.like(like)))
    if group_id:
        q = q.filter(User.group_id == group_id)
    total = q.count()
    rows = q.order_by(User.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {"items": [_user_item(db, u) for u in rows], "total": total, "page": page, "page_size": page_size}


@router.post("/users", response_model=AdminUserItem)
async def create_user(
    body: AdminUserCreateRequest,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """后台创建用户：指定用户组，账号即获得该组功能"""
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    group = db.query(UserGroup).filter(UserGroup.id == body.group_id).first()
    if not group:
        raise HTTPException(status_code=400, detail="指定的用户组不存在")
    user = User(
        username=body.username.strip(),
        password_hash=hash_password(body.password),
        email=body.email,
        phone_num=body.phone_num,
        role=UserRole.user,
        group_id=group.id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _user_item(db, user)


@router.patch("/users/{user_id}", response_model=AdminUserItem)
async def update_user(
    user_id: int,
    body: AdminUserUpdateRequest,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """后台更新用户：调整分组（功能随组变化）/ 联系方式"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if _is_super_admin(db, user) and body.group_id is not None and body.group_id != user.group_id:
        raise HTTPException(status_code=403, detail="最高管理员不可调整用户组")
    previous_group_id = user.group_id
    if body.group_id is not None:
        group = db.query(UserGroup).filter(UserGroup.id == body.group_id).first()
        if not group:
            raise HTTPException(status_code=400, detail="指定的用户组不存在")
        user.group_id = group.id
    if body.email is not None:
        user.email = body.email.strip() or None
    if body.phone_num is not None:
        user.phone_num = body.phone_num.strip() or None
    db.commit()
    db.refresh(user)
    # 被划组用户的权限快照实时失效：SSE 通知其客户端重拉 /auth/me
    if body.group_id is not None and body.group_id != previous_group_id:
        _broadcast_permissions_changed(user.id)
    return _user_item(db, user)


@router.post("/users/{user_id}/reset-password", response_model=MessageResponse)
async def reset_user_password(
    user_id: int,
    body: AdminResetPasswordRequest,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """后台重置指定用户密码（最高管理员与本人除外：本人走个人中心，超管密码不可代改）"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="不能在此重置自己的密码，请前往个人中心修改")
    if _is_super_admin(db, user):
        raise HTTPException(status_code=403, detail="最高管理员密码仅可由本人在个人中心修改")
    user.password_hash = hash_password(body.new_password)
    # 密码被重置后踢掉该账号全部在线会话，强制重新登录
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.commit()
    return MessageResponse(message=f"已重置 {user.username} 的密码")


@router.delete("/users/{user_id}", response_model=MessageResponse)
async def delete_user(
    user_id: int,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """注销用户账号：除最高管理员外均可注销（含注销自己的账号，前端会随即登出）；
    连带清理会话/人脸/对话/任务/报告等全部数据（审计文件尽力删除）"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if _is_super_admin(db, user):
        raise HTTPException(status_code=403, detail="最高管理员账号不可注销")

    username = user.username
    # 1) 会话与人脸（登录凭据）
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.query(FaceRecord).filter(FaceRecord.user_id == user.id).delete()
    # 2) 对话与数字人记录
    db.query(ChatHistory).filter(ChatHistory.user_id == user.id).delete()
    db.query(DigitalHumanSession).filter(DigitalHumanSession.user_id == user.id).delete()
    # 通知（notifications.user_id 外键无级联，需显式删除，否则注销有通知的账号会 500）
    db.query(Notification).filter(Notification.user_id == user.id).delete()
    # 换组申请（group_switch_requests.user_id 外键无级联，同通知一并显式删除）
    db.query(GroupSwitchRequest).filter(GroupSwitchRequest.user_id == user.id).delete()
    # 知识库文档属共享资源：不随账号删除，仅清空归属（uploaded_by 可空外键）
    db.query(KnowledgeDoc).filter(KnowledgeDoc.uploaded_by == user.id).update({KnowledgeDoc.uploaded_by: None})
    # 3) 报告与结构化分析（HTML 文件尽力清理）——reports.task_id 外键引用检测任务，
    #    必须先删报告再删任务，否则注销生成过报告的账号会触发外键约束冲突（500）
    reports = db.query(Report).filter(Report.user_id == user.id).all()
    for report in reports:
        db.query(ReportAnalysis).filter(ReportAnalysis.report_id == report.id).delete()
        _remove_file_quietly(report.report_path)
    db.query(Report).filter(Report.user_id == user.id).delete()
    # 4) 检测任务（含逐帧结果；上传产物尽力清理）
    tasks = db.query(DetectionTask).filter(DetectionTask.user_id == user.id).all()
    for task in tasks:
        db.query(DetectionResult).filter(DetectionResult.task_id == task.id).delete()
        _remove_file_quietly(task.file_path)
    db.query(DetectionTask).filter(DetectionTask.user_id == user.id).delete()
    # 5) 用户本体
    db.delete(user)
    db.commit()
    return MessageResponse(message=f"已注销账号 {username}")


# ============ 用户组管理 ============
@router.get("/groups")
async def list_groups(current_user: User = AdminGuard, db: Session = Depends(get_db)):
    """用户组列表（含模块集合与成员数）"""
    groups = db.query(UserGroup).order_by(UserGroup.id).all()
    return {"items": [_group_item(db, g) for g in groups]}


@router.post("/groups", response_model=AdminGroupItem)
async def create_group(
    body: AdminGroupCreateRequest,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """创建用户组：勾选功能模块即成组，之后可在用户管理中把用户划入"""
    modules = _validate_modules(body.modules)
    code = (body.code or f"g_{uuid4().hex[:8]}").strip().lower()
    if db.query(UserGroup).filter(UserGroup.code == code).first():
        raise HTTPException(status_code=400, detail=f"组标识 {code} 已存在")
    if db.query(UserGroup).filter(UserGroup.name == body.name.strip()).first():
        raise HTTPException(status_code=400, detail="同名用户组已存在")
    group = UserGroup(
        code=code,
        name=body.name.strip(),
        description=body.description,
        is_system=False,
    )
    db.add(group)
    db.flush()  # 拿到 group.id 再写模块关联
    _sync_group_modules(db, group, modules)
    db.commit()
    db.refresh(group)
    return _group_item(db, group)


@router.patch("/groups/{group_id}", response_model=AdminGroupItem)
async def update_group(
    group_id: int,
    body: AdminGroupUpdateRequest,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """更新用户组：名称/描述/模块集合（super_admin 组不可改；组内成员权限实时生效）"""
    group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="用户组不存在")
    if group.code == SUPER_ADMIN_CODE:
        raise HTTPException(status_code=403, detail="超级管理员组为系统内置，不可修改")
    if body.name is not None:
        name = body.name.strip()
        dup = db.query(UserGroup).filter(UserGroup.name == name, UserGroup.id != group.id).first()
        if dup:
            raise HTTPException(status_code=400, detail="同名用户组已存在")
        group.name = name
    if body.description is not None:
        group.description = body.description
    if body.modules is not None:
        old_modules = {m.module for m in group.modules}
        _sync_group_modules(db, group, _validate_modules(body.modules))
    else:
        old_modules = None
    db.commit()
    db.refresh(group)
    # 功能勾选有实质变化 → 组内在线成员实时刷新权限快照（SSE 瞬时事件，不落库不进铃铛）
    if old_modules is not None and old_modules != {m.module for m in group.modules}:
        member_ids = [uid for (uid,) in db.query(User.id).filter(User.group_id == group.id).all()]
        _broadcast_permissions_changed(*member_ids)
    return _group_item(db, group)


@router.delete("/groups/{group_id}", response_model=MessageResponse)
async def delete_group(
    group_id: int,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """删除自定义用户组：内置组不可删；组内仍有成员时不可删（先把成员移出）"""
    group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="用户组不存在")
    if group.is_system:
        raise HTTPException(status_code=400, detail="系统内置用户组不可删除")
    member_count = db.query(User).filter(User.group_id == group.id).count()
    if member_count:
        raise HTTPException(status_code=400, detail=f"组内仍有 {member_count} 名成员，请先移出后再删除")
    db.delete(group)  # group_modules 由 cascade=all, delete-orphan 连带清理
    db.commit()
    return MessageResponse(message=f"已删除用户组 {group.name}")

# ============ 换组申请审批（个人中心申请 → 此处处理） ============
@router.get("/group-requests")
async def list_group_requests(
    status: str = Query("pending", description="按状态过滤：pending / approved / rejected / all"),
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """换组申请列表：默认待审批，最新在前"""
    q = db.query(GroupSwitchRequest)
    if status != "all":
        q = q.filter(GroupSwitchRequest.status == status)
    rows = q.order_by(GroupSwitchRequest.created_at.desc(), GroupSwitchRequest.id.desc()).limit(50).all()
    return {"items": [group_request_item(db, r) for r in rows]}


def _load_pending_request(db: Session, request_id: int) -> GroupSwitchRequest:
    req = db.query(GroupSwitchRequest).filter(GroupSwitchRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="换组申请不存在")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理，不能重复审批")
    return req


@router.post("/group-requests/{request_id}/approve", response_model=MessageResponse)
async def approve_group_request(
    request_id: int,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """批准换组申请：申请人即刻调入目标组（权限实时生效），并收到铃铛通知"""
    req = _load_pending_request(db, request_id)
    user = db.query(User).filter(User.id == req.user_id).first()
    if not user:
        raise HTTPException(status_code=400, detail="申请人账号已注销，无法批准")
    group = db.query(UserGroup).filter(UserGroup.id == req.to_group_id).first()
    if not group:
        raise HTTPException(status_code=400, detail="目标用户组已不存在，无法批准")
    if group.code == SUPER_ADMIN_CODE:
        raise HTTPException(status_code=400, detail="不能通过申请把用户调入超级管理员组")
    user.group_id = group.id
    req.status = "approved"
    req.handled_by = current_user.id
    req.handled_at = datetime.now()
    db.commit()
    # 申请人在线时即时刷新权限快照（SSE 瞬时事件，不落库）
    _broadcast_permissions_changed(user.id)
    notify(
        db, user.id, "group_change_approved",
        "换组申请已批准",
        f"你已加入「{group.name}」，可用功能已即时更新",
        "profile",
        req.id,
    )
    return MessageResponse(message=f"已批准 {user.username} 加入「{group.name}」")


@router.post("/group-requests/{request_id}/reject", response_model=MessageResponse)
async def reject_group_request(
    request_id: int,
    current_user: User = AdminGuard,
    db: Session = Depends(get_db),
):
    """驳回换组申请：分组不变，申请人收到铃铛通知"""
    req = _load_pending_request(db, request_id)
    user = db.query(User).filter(User.id == req.user_id).first()
    group = db.query(UserGroup).filter(UserGroup.id == req.to_group_id).first()
    req.status = "rejected"
    req.handled_by = current_user.id
    req.handled_at = datetime.now()
    db.commit()
    if user:
        notify(
            db, user.id, "group_change_rejected",
            "换组申请未通过",
            f"申请加入「{group.name if group else '目标用户组'}」未获批准，如有疑问请联系管理员",
            "profile",
            req.id,
        )
    return MessageResponse(message="已驳回该换组申请")
