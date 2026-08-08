"""
认证模块：bcrypt 密码哈希 + JWT 签发校验
=====================================
- hash_password / verify_password   bcrypt 哈希（不用明文存密码）
- create_access_token / decode      签发 / 校验 JWT
- get_current_user                  FastAPI 依赖：从 Cookie 或 Authorization 头取当前用户
- require_role                      依赖工厂：限制管理员接口

JWT 同时写入 HttpOnly Cookie（access_token）和返回给 API 调用方，
页面请求用 Cookie，外部 API 调用用 Authorization: Bearer。
"""

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

import config
from database import get_db
from models import User, UserRole

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
def create_access_token(user: User) -> str:
    """为用户签发 JWT，含 id / username / role"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role.value,
        "iat": now,
        "exp": now + timedelta(hours=config.JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET_KEY, algorithm=config.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """校验 JWT 签名与有效期，成功返回载荷，失败返回 None"""
    try:
        return jwt.decode(token, config.JWT_SECRET_KEY, algorithms=[config.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def _get_token_from_request(request: Request) -> str | None:
    """依次尝试：Cookie(access_token) → Authorization: Bearer <token>"""
    # 1. Cookie（SSR 页面登录后自动携带）
    token = request.cookies.get("access_token")
    if token:
        return token
    # 2. Authorization 头（API 调用方）
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
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
    return db.query(User).filter(User.id == int(payload["sub"])).first()


def require_role(role: UserRole):
    """
    依赖工厂：限制只有指定角色能访问。
    用法：def xxx(current_user: User = Depends(require_role(UserRole.admin))):
    """
    def _checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role != role:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问")
        return current_user

    return _checker
