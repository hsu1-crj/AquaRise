"""
认证模块：bcrypt 密码哈希 + JWT 签发校验
=====================================
- hash_password / verify_password   bcrypt 哈希（不用明文存密码）
- create_access_token / decode      签发 / 校验 JWT
- get_current_user                  FastAPI 依赖：从 Cookie 或 Authorization 头取当前用户
- require_permission / get_user_modules  RBAC 依赖工厂：按用户组的功能模块守卫接口

JWT 同时写入 HttpOnly Cookie（access_token）和返回给 API 调用方，
页面请求用 Cookie，外部 API 调用用 Authorization: Bearer。
"""

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

import config
from database import get_db
from models import MODULE_KEYS, GroupModule, LoginSession, User, UserGroup, UserRole

# ============ bcrypt 密码哈希 ============
def hash_password(raw: str) -> str:
    """把明文密码哈希为 bcrypt 字符串"""
    return bcrypt.hashpw(raw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(raw: str, hashed: str) -> bool:
    """校验明文密码与哈希是否匹配"""
    try:
        return bcrypt.checkpw(raw.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False  # 哈希格式不合法（如旧数据），视为不匹配


# ============ JWT 签发与校验 ============
def create_access_token(user: User, expires_hours: int | None = None) -> str:
    """为用户签发 JWT，含 id / username / role。

    expires_hours 覆盖默认有效期（保持登录时传更长值，如 30 天）。
    """
    now = datetime.now(timezone.utc)
    payload = {
        # jti 保证每次签发的 token 全局唯一（同秒内多次登录也不会撞 token_hash）
        "jti": uuid4().hex,
        "sub": str(user.id),
        "username": user.username,
        "role": user.role.value,
        "iat": now,
        "exp": now + timedelta(hours=expires_hours or config.JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET_KEY, algorithm=config.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """校验 JWT 签名与有效期，成功返回载荷，失败返回 None"""
    try:
        return jwt.decode(token, config.JWT_SECRET_KEY, algorithms=[config.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


# ============ 并发登录会话控制 ============
def _token_hash(token: str) -> str:
    """对 JWT 做 SHA-256，避免明文 token 落库"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def record_login_session(
    db: Session, user: User, token: str, platform: str = "pc", expires_hours: int | None = None
) -> None:
    """
    登录成功后记录会话，并执行「同一账号在同一平台(platform)的并发数」控制：
      - admin 账号每个平台最多 config.MAX_CONCURRENT_SESSIONS["admin"] 个会话
      - user  账号每个平台最多 config.MAX_CONCURRENT_SESSIONS["user"]  个会话
    超限时踢掉该平台最早建立的会话；跨平台(PC ↔ 移动端)互不影响，保证新登录始终成功。
    对 User 行加 for update 行锁串行化同账号登录，避免并发读-踢-写竞态突破上限。

    expires_hours 覆盖会话有效期（保持登录时与 JWT 同步给更长值）。
    """
    now = datetime.now()
    limit = config.MAX_CONCURRENT_SESSIONS.get(user.role.value, 1)
    expires = now + timedelta(hours=expires_hours or config.JWT_EXPIRE_HOURS)
    # 0. 锁定用户行(行级锁，持有至下方 commit)，串行化同账号并发登录，杜绝读-踢-写竞态
    db.query(User).filter(User.id == user.id).with_for_update().first()

    # 1. 清理该账号已过期的会话（被动失效）
    db.query(LoginSession).filter(
        LoginSession.user_id == user.id,
        LoginSession.expires_at <= now,
    ).delete()

    # 2. 统计该账号【同 platform】的有效会话(锁定读)：FOR UPDATE 做“当前读”，
    #    绕过 REPEATABLE READ 旧快照，确保看到并发事务刚提交的会话，上限判定才可靠
    sessions = (
        db.query(LoginSession)
        .filter(LoginSession.user_id == user.id, LoginSession.platform == platform)
        .order_by(LoginSession.created_at.asc())
        .with_for_update()
        .all()
    )

    # 3. 超限则逐条踢掉最早会话，直到剩 limit-1 个
    while len(sessions) >= limit:
        oldest = sessions.pop(0)
        db.delete(oldest)

    # 4. 写入本次会话
    db.add(
        LoginSession(
            user_id=user.id,
            token_hash=_token_hash(token),
            expires_at=expires,
            platform=platform,
        )
    )
    db.commit()


def _session_is_active(db: Session, token: str, user_id: int) -> bool:
    """会话是否仍有效：JWT 对应的会话记录存在且未过期（被踢即失效）"""
    row = (
        db.query(LoginSession)
        .filter(
            LoginSession.user_id == user_id,
            LoginSession.token_hash == _token_hash(token),
        )
        .first()
    )
    if not row:
        return False
    return row.expires_at > datetime.now()


def _get_token_from_request(request: Request) -> str | None:
    """依次尝试：Authorization: Bearer <token> → Cookie(access_token) → URL 查询参数 token
    （query 参数主要是给"新窗口打开 HTML 报告预览"这类无法携带请求头的场景用）。"""
    # 1. Authorization 头（API 调用方）：必须最优先——Cookie 不按端口隔离，
    #    浏览器可能残留其他端口/旧版本签发的过期 access_token，若 Cookie 优先
    #    会遮蔽刚签发的有效 token，导致"登录成功即被踢回登录页"。
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    # 2. Cookie（SSR 页面登录后自动携带）
    token = request.cookies.get("access_token")
    if token:
        return token
    # 3. URL 查询参数（window.open 预览等无法带头的场景）
    token = request.query_params.get("token") or request.query_params.get("access_token")
    if token:
        return token
    return None


# ============ FastAPI 依赖 ============
def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """
    认证依赖：解析 JWT → 查库 → 返回 User。
    未认证或用户不存在时抛 401。
    用法：def xxx(current_user: User = Depends(get_current_user)):
    """
    token = _get_token_from_request(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录，请先登录")

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录已过期，请重新登录")

    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    # 会话校验：被「踢下线」或已过期的 token 在此失效
    if not _session_is_active(db, token, user.id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="该账号已有更晚的登录，当前会话已失效，请重新登录",
        )
    return user


def get_current_user_optional(
    request: Request, db: Session = Depends(get_db)
) -> User | None:
    """
    可选认证依赖：登录了就返回 User，没登录返回 None。
    用于登录页等未登录也可访问的页面。
    """
    token = _get_token_from_request(request)
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user or not _session_is_active(db, token, user.id):
        return None
    return user


# ============ RBAC：功能模块权限 ============
def get_user_modules(db: Session, user: User) -> list[str]:
    """
    用户拥有的功能模块（权限）：
      - role=admin（最高管理员）恒为全部模块，兜底保证超管不被组数据锁死；
      - 其余用户取所属用户组的模块集合；未归组（历史数据未迁移）则视为无业务模块。
    每次请求实时查库，后台改组后立即生效，无需重签 JWT。
    """
    if user.role == UserRole.admin:
        return list(MODULE_KEYS)
    if not user.group_id:
        return []
    rows = db.query(GroupModule).filter(GroupModule.group_id == user.group_id).all()
    return [row.module for row in rows]


def require_permission(*modules: str):
    """
    依赖工厂：要求当前用户拥有任一指定功能模块（任一命中即放行）。
    用法：def xxx(current_user: User = Depends(require_permission("detection"))):
    """
    allowed = set(modules)

    def _checker(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        owned = set(get_user_modules(db, current_user))
        if not owned & allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="当前用户组未开放该功能模块，请联系管理员调整分组",
            )
        return current_user

    return _checker


def is_privileged(db: Session, user: User) -> bool:
    """是否拥有全局数据视野（可查看/分析所有用户的报告与任务上下文）：
    最高管理员或拥有后台管理模块的用户组。"""
    return user.role == UserRole.admin or "admin" in get_user_modules(db, user)
def super_admin_ids(db: Session) -> list[int]:
    """全部最高管理员的用户 id：role=admin（种子账号）∪ super_admin 组成员。
    用于换组申请等需要通知全体最高管理员的场景。"""
    ids = {uid for (uid,) in db.query(User.id).filter(User.role == UserRole.admin).all()}
    group = db.query(UserGroup).filter(UserGroup.code == "super_admin").first()
    if group:
        ids.update(
            uid for (uid,) in db.query(User.id).filter(User.group_id == group.id).all()
        )
    return sorted(ids)
def is_super_admin(db: Session, user: User) -> bool:
    """最高管理员：role=admin（种子账号），或被归入 super_admin 组的成员（实质拥有全量权限）。"""
    if user.role == UserRole.admin:
        return True
    if not user.group_id:
        return False
    group = db.query(UserGroup).filter(UserGroup.id == user.group_id).first()
    return bool(group and group.code == "super_admin")


def group_request_item(db: Session, req) -> "GroupSwitchRequestItem":
    """GroupSwitchRequest ORM → 契约（补申请人用户名与两侧组名，软外键容忍组已删除）。
    个人中心（看自己的申请）与后台管理（审批列表）共用。"""
    from schemas import GroupSwitchRequestItem

    from_group = (
        db.query(UserGroup).filter(UserGroup.id == req.from_group_id).first()
        if req.from_group_id else None
    )
    to_group = db.query(UserGroup).filter(UserGroup.id == req.to_group_id).first()
    return GroupSwitchRequestItem(
        id=req.id,
        username=req.user.username if req.user else None,
        from_group_name=from_group.name if from_group else None,
        to_group_id=req.to_group_id,
        to_group_name=to_group.name if to_group else None,
        reason=req.reason,
        status=req.status,
        created_at=req.created_at,
        handled_at=req.handled_at,
    )
