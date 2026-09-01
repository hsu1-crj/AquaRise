"""
认证路由
=====================================
- 验证码（GET /captcha）
- 页面表单登录/注册/退出（POST /login, /register, GET /logout）
- JSON API 登录/注册/当前用户（/api/v1/auth/*）

登录采用 JWT：签发后写入 HttpOnly Cookie（access_token），
页面请求自动携带，外部 API 也可用 Authorization: Bearer。
"""

import re

import config
import captcha as captcha_mod
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy.orm import Session

from auth import (
    create_access_token,
    get_current_user,
    get_user_modules,
    hash_password,
    record_login_session,
    verify_password,
)
from database import get_db
from models import User, UserGroup, UserRole
# Jinja2 templates removed — React SPA handles all page rendering now
from schemas import (
    ChangePasswordRequest,
    LoginRequest,
    MessageResponse,
    ProfileUpdateRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)

router = APIRouter(tags=["auth"])


def _default_group_id(db: Session) -> int | None:
    """自助注册用户的默认用户组（config.DEFAULT_GROUP_CODE，缺省科普访客组 public）。"""
    group = db.query(UserGroup).filter(UserGroup.code == config.DEFAULT_GROUP_CODE).first()
    return group.id if group else None


USERNAME_PATTERN = r"^[A-Za-z0-9_\u4e00-\u9fa5]+$"


def _validate_username(raw: str) -> str:
    """注册用户名规范：与后台创建用户同口径（字母/数字/下划线/中文，不含 - 等符号）。"""
    username = raw.strip()
    if not username or len(username) > 20:
        raise HTTPException(status_code=400, detail="用户名不能为空且不超过 20 个字符")
    if not re.fullmatch(USERNAME_PATTERN, username):
        raise HTTPException(status_code=400, detail="用户名仅支持字母、数字、下划线或中文")
    return username


def user_to_response(db: Session, user: User) -> UserResponse:
    """User ORM → UserResponse：补齐所属用户组与功能模块权限。"""
    group = db.query(UserGroup).filter(UserGroup.id == user.group_id).first() if user.group_id else None
    return UserResponse(
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
    )


def _issue_auth_cookie(response: Response, user: User) -> str:
    """签发 JWT 并写入 HttpOnly Cookie，返回 token"""
    token = create_access_token(user)
    response.set_cookie(
        key="access_token",
        value=token,
        max_age=config.JWT_EXPIRE_HOURS * 3600,
        httponly=True,
    )
    return token


# ============ 验证码 ============
@router.get("/captcha")
async def get_captcha():
    """生成验证码图片，正确答案签名后写入 Cookie"""
    code = captcha_mod.generate_captcha_code()
    img_bytes = captcha_mod.create_captcha_image(code)
    response = Response(content=img_bytes, media_type="image/png")
    response.set_cookie(
        key="captcha",
        value=captcha_mod.sign_captcha(code),
        max_age=captcha_mod.CAPTCHA_MAX_AGE,
        httponly=True,
    )
    return response


# ============ 页面表单登录 / 注册 / 退出（React SPA 接管后改为 JSON 响应） ============
@router.post("/login")
async def login_form(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    captcha: str = Form(default=""),
    db: Session = Depends(get_db),
):
    """表单登录：校验用户密码后签发 JWT，重定向到首页。错误返回 JSON。支持用户名或邮箱登录。"""
    account = username.strip()
    user = db.query(User).filter(User.username == account).first()
    if not user and "@" in account:
        user = db.query(User).filter(User.email == account).first()
    if not user:
        user = db.query(User).filter(User.phone_num == account).first()
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    response = RedirectResponse(url="/", status_code=303)
    token = _issue_auth_cookie(response, user)
    record_login_session(db, user, token)
    return response


@router.post("/register")
async def register_form(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    confirm_password: str = Form(...),
    email: str = Form(default=""),
    db: Session = Depends(get_db),
):
    """表单注册：校验 → 查重 → 写入。错误返回 JSON。"""
    username = _validate_username(username)
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="密码至少需要 6 位")
    if password != confirm_password:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="用户名已存在，请换一个")

    db.add(
        User(
            username=username,
            password_hash=hash_password(password),
            email=email.strip() or None,
            role=UserRole.user,
            group_id=_default_group_id(db),
        )
    )
    db.commit()
    return RedirectResponse(url="/", status_code=303)


@router.get("/logout")
async def logout():
    """退出登录：清除 JWT Cookie 回到首页"""
    response = RedirectResponse(url="/", status_code=303)
    response.delete_cookie("access_token")
    return response


# ============ JSON API（给前端 fetch / 外部调用） ============
@router.post("/api/v1/auth/login", response_model=TokenResponse)
async def api_login(body: LoginRequest, db: Session = Depends(get_db)):
    """API 登录：返回 JWT。支持用户名或邮箱登录。"""
    account = body.username.strip()
    user = db.query(User).filter(User.username == account).first()
    if not user and "@" in account:
        user = db.query(User).filter(User.email == account).first()
    if not user:
        user = db.query(User).filter(User.phone_num == account).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    # 保持登录：签发长有效期 token（30 天），否则用默认 8 小时
    expires_hours = config.JWT_REMEMBER_DAYS * 24 if body.remember_me else None
    token = create_access_token(user, expires_hours=expires_hours)
    record_login_session(db, user, token, platform=body.platform, expires_hours=expires_hours)
    return TokenResponse(access_token=token)


@router.post("/api/v1/auth/register", response_model=UserResponse)
async def api_register(body: RegisterRequest, db: Session = Depends(get_db)):
    username = _validate_username(body.username)
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")
    user = User(
        username=username,
        password_hash=hash_password(body.password),
        email=body.email,
        role=UserRole.user,
        group_id=_default_group_id(db),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user_to_response(db, user)


@router.get("/api/v1/auth/me", response_model=UserResponse)
async def api_me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """返回当前登录用户信息（含用户组与功能模块权限）"""
    return user_to_response(db, current_user)


@router.post("/api/v1/auth/change-password", response_model=MessageResponse)
async def api_change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """个人中心修改密码：校验旧密码 → bcrypt 更新新密码"""
    if not verify_password(body.old_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="当前密码不正确")
    if body.new_password == body.old_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")
    current_user.password_hash = hash_password(body.new_password)
    db.commit()
    return MessageResponse(message="密码修改成功")


@router.post("/api/v1/auth/profile", response_model=UserResponse)
async def api_update_profile(
    body: ProfileUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """个人中心更新资料：更新电子邮箱 / 手机号并返回最新用户信息"""
    if body.email is not None:
        current_user.email = body.email.strip() or None
    if body.phone_num is not None:
        current_user.phone_num = body.phone_num.strip() or None
    db.commit()
    db.refresh(current_user)
    return user_to_response(db, current_user)
