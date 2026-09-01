"""后台管理与用户分组（RBAC）测试
=====================================
覆盖：
- require_permission 守卫：无「后台管理」模块的用户组被拒（403）
- 权限计算：最高管理员恒为全量模块；普通用户按组的模块集合
- 3D 模式锁定：ocean3d 拆分为 ocean3d_monitor / ocean3d_science 两个模式键，
  监测/决策组仅监测模式、科普组仅科普模式、超管双模式
- 用户管理：创建/调组/重置密码/注销
- 保护规则（产品要求：只有最高管理员不能注销账号，其他均可注销）：
  * 最高管理员（role=admin 或 super_admin 组成员）不可被注销、不可被调组、密码不可被代改
  * 其余账号（包括操作者自己）均可注销
- 用户组管理：内置组不可删、super_admin 组不可改、有成员的组不可删、
  自定义组的模块矩阵校验与保存
- 自助注册默认归入科普访客组（public）

用 SQLite 内存库 + 依赖覆盖，不依赖 MySQL。
"""

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend"))

from auth import get_current_user, get_user_modules, is_privileged  # noqa: E402
from database import Base, get_db  # noqa: E402
from models import (  # noqa: E402
    MODULE_KEYS,
    SYSTEM_GROUP_SEEDS,
    GroupModule,
    User,
    UserGroup,
    UserRole,
)
from routers import admin_router, auth_router  # noqa: E402


@pytest.fixture()
def db_session():
    """SQLite 内存库：建全表 + 播种内置用户组（与 main.py 同一数据源 SYSTEM_GROUP_SEEDS）"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = Session()
    for seed in SYSTEM_GROUP_SEEDS:
        group = UserGroup(code=seed["code"], name=seed["name"], description=seed["desc"], is_system=True)
        db.add(group)
        db.flush()
        for key in seed["modules"]:
            db.add(GroupModule(group_id=group.id, module=key))
    db.commit()
    yield db
    db.close()


@pytest.fixture()
def db_override(db_session):
    def _get_db():
        yield db_session

    return _get_db


def _make_user(db, username: str, *, role: UserRole = UserRole.user, group_code: str | None = "analyst") -> User:
    group = db.query(UserGroup).filter(UserGroup.code == group_code).first() if group_code else None
    user = User(username=username, password_hash="x" * 6, role=role, group_id=group.id if group else None)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture()
def users(db_session):
    """三类用户：最高管理员 / 监测分析组 / 科普访客组"""
    return {
        "admin": _make_user(db_session, "admin", role=UserRole.admin, group_code="super_admin"),
        "analyst": _make_user(db_session, "analyst01", group_code="analyst"),
        "public": _make_user(db_session, "guest01", group_code="public"),
    }


def make_client(db_override, current: User | None) -> TestClient:
    """构建只挂 admin + auth 路由的测试应用，并固定当前登录用户"""
    app = FastAPI()
    app.include_router(admin_router.router)
    app.include_router(auth_router.router)
    app.dependency_overrides[get_db] = db_override
    if current is not None:
        app.dependency_overrides[get_current_user] = lambda: current
    return TestClient(app)


# ============ 权限计算 ============
def test_super_admin_has_all_modules(db_session, users):
    assert get_user_modules(db_session, users["admin"]) == MODULE_KEYS


def test_group_modules_drive_permissions(db_session, users):
    analyst_modules = get_user_modules(db_session, users["analyst"])
    assert "detection" in analyst_modules and "admin" not in analyst_modules
    public_modules = get_user_modules(db_session, users["public"])
    assert set(public_modules) == {"ocean3d_science", "atlas", "assistant"}


def test_ocean3d_mode_keys_per_group(db_session, users):
    """3D 模式按组锁定：监测/决策组仅监测模式，科普组仅科普模式，超管双模式"""
    assert get_user_modules(db_session, users["admin"]).count("ocean3d_monitor") == 1
    assert "ocean3d_science" in get_user_modules(db_session, users["admin"])
    analyst = get_user_modules(db_session, users["analyst"])
    assert "ocean3d_monitor" in analyst and "ocean3d_science" not in analyst
    public = get_user_modules(db_session, users["public"])
    assert "ocean3d_science" in public and "ocean3d_monitor" not in public


def test_ungrouped_user_has_no_business_modules(db_session):
    loner = _make_user(db_session, "loner", group_code=None)
    assert get_user_modules(db_session, loner) == []


def test_is_privileged(db_session, users):
    assert is_privileged(db_session, users["admin"]) is True
    assert is_privileged(db_session, users["analyst"]) is False


# ============ 后台接口守卫 ============
def test_admin_api_rejects_non_admin_groups(db_override, users):
    for name in ("analyst", "public"):
        client = make_client(db_override, users[name])
        resp = client.get("/api/v1/admin/users")
        assert resp.status_code == 403, name


def test_admin_api_allows_super_admin(db_override, users):
    client = make_client(db_override, users["admin"])
    resp = client.get("/api/v1/admin/users")
    assert resp.status_code == 200
    assert resp.json()["total"] == 3


def test_unauthenticated_admin_api_rejected(db_override):
    client = make_client(db_override, None)
    assert client.get("/api/v1/admin/users").status_code == 401


# ============ 概览 ============
def test_overview_counts(db_override, users):
    client = make_client(db_override, users["admin"])
    body = client.get("/api/v1/admin/overview").json()
    assert body["user_count"] == 3
    assert body["group_count"] == len(SYSTEM_GROUP_SEEDS)
    codes = {g["code"] for g in body["group_members"]}
    assert codes == {s["code"] for s in SYSTEM_GROUP_SEEDS}


# ============ 用户管理 ============
def test_create_user_with_group(db_override, users, db_session):
    client = make_client(db_override, users["admin"])
    commander = db_session.query(UserGroup).filter(UserGroup.code == "commander").first()
    resp = client.post("/api/v1/admin/users", json={
        "username": "commander01", "password": "123456", "group_id": commander.id,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["group_code"] == "commander"
    assert "screen" in body["permissions"] and "detection" not in body["permissions"]


def test_create_user_duplicate_name_rejected(db_override, users):
    client = make_client(db_override, users["admin"])
    group_id = client.get("/api/v1/admin/groups").json()["items"][1]["id"]
    resp = client.post("/api/v1/admin/users", json={
        "username": "analyst01", "password": "123456", "group_id": group_id,
    })
    assert resp.status_code == 400


def test_change_group_updates_permissions(db_override, users, db_session):
    client = make_client(db_override, users["admin"])
    public_group = db_session.query(UserGroup).filter(UserGroup.code == "public").first()
    resp = client.patch(f"/api/v1/admin/users/{users['analyst'].id}", json={"group_id": public_group.id})
    assert resp.status_code == 200
    assert resp.json()["group_code"] == "public"
    # 权限随组实时变化
    assert "atlas" in get_user_modules(db_session, users["analyst"])


# ============ 注销保护（核心产品要求：只有最高管理员不能注销账号） ============
def test_super_admin_cannot_delete_self(db_override, users):
    """最高管理员注销自己 → 403"""
    client = make_client(db_override, users["admin"])
    resp = client.delete(f"/api/v1/admin/users/{users['admin'].id}")
    assert resp.status_code == 403
    assert "最高管理员账号不可注销" in resp.json()["detail"]


def test_super_admin_account_undeletable(db_override, users, db_session):
    """其他拥有后台权限的用户也不能注销最高管理员"""
    helper = _make_user(db_session, "ops", group_code="super_admin")
    client = make_client(db_override, helper)
    resp = client.delete(f"/api/v1/admin/users/{users['admin'].id}")
    assert resp.status_code == 403


def test_super_group_member_also_protected(db_override, db_session):
    """super_admin 组成员即使 role=user 也视为最高管理员：不可被注销"""
    member = _make_user(db_session, "groupadmin", group_code="super_admin")
    operator = _make_user(db_session, "op2", group_code="super_admin")
    client = make_client(db_override, operator)
    resp = client.delete(f"/api/v1/admin/users/{member.id}")
    assert resp.status_code == 403


def test_non_super_user_can_delete_self(db_override, db_session):
    """非最高管理员的用户可以注销自己的账号（新规则：其余均可销号）"""
    creator = _make_user(db_session, "creator", role=UserRole.admin, group_code="super_admin")
    client = make_client(db_override, creator)
    created = client.post("/api/v1/admin/groups", json={"name": "后台运营组", "modules": ["admin"]}).json()
    operator = _make_user(db_session, "selfkiller", group_code=None)
    client.patch(f"/api/v1/admin/users/{operator.id}", json={"group_id": created["id"]})
    resp = client.delete(f"/api/v1/admin/users/{operator.id}")
    assert resp.status_code == 200
    assert db_session.query(User).filter(User.id == operator.id).count() == 0


def test_super_admin_group_immutable(db_override, users, db_session):
    client = make_client(db_override, users["admin"])
    super_group = next(g for g in client.get("/api/v1/admin/groups").json()["items"] if g["code"] == "super_admin")
    # 调组被拒
    resp = client.patch(f"/api/v1/admin/users/{users['admin'].id}", json={"group_id": super_group["id"] + 1})
    # 组本身也不可改模块/名称
    assert resp.status_code in (400, 403)
    resp2 = client.patch(f"/api/v1/admin/groups/{super_group['id']}", json={"modules": ["dashboard"]})
    assert resp2.status_code == 403


def test_reset_password_protections(db_override, users):
    client = make_client(db_override, users["admin"])
    # 不能重置自己的密码（走个人中心）
    assert client.post(f"/api/v1/admin/users/{users['admin'].id}/reset-password",
                       json={"new_password": "654321"}).status_code == 400
    # 正常重置普通用户成功
    resp = client.post(f"/api/v1/admin/users/{users['analyst'].id}/reset-password",
                       json={"new_password": "654321"})
    assert resp.status_code == 200


def test_delete_user_cleans_up(db_override, users, db_session):
    client = make_client(db_override, users["admin"])
    resp = client.delete(f"/api/v1/admin/users/{users['public'].id}")
    assert resp.status_code == 200
    assert db_session.query(User).filter(User.id == users["public"].id).count() == 0


# ============ 用户组管理 ============
def test_system_group_undeletable(db_override, users):
    client = make_client(db_override, users["admin"])
    groups = client.get("/api/v1/admin/groups").json()["items"]
    for group in groups:
        assert client.delete(f"/api/v1/admin/groups/{group['id']}").status_code == 400


def test_group_with_members_undeletable(db_override, users, db_session):
    client = make_client(db_override, users["admin"])
    created = client.post("/api/v1/admin/groups", json={"name": "临时巡查组", "modules": ["detection", "history"]})
    assert created.status_code == 200
    group_id = created.json()["id"]
    client.patch(f"/api/v1/admin/users/{users['analyst'].id}", json={"group_id": group_id})
    resp = client.delete(f"/api/v1/admin/groups/{group_id}")
    assert resp.status_code == 400
    assert "成员" in resp.json()["detail"]


def test_create_group_validates_modules(db_override, users):
    client = make_client(db_override, users["admin"])
    resp = client.post("/api/v1/admin/groups", json={"name": "坏模块组", "modules": ["not_a_module"]})
    assert resp.status_code == 400


def test_custom_group_crud(db_override, users):
    client = make_client(db_override, users["admin"])
    created = client.post("/api/v1/admin/groups", json={
        "name": "沿岸巡查组", "description": "近岸巡查采集", "modules": ["detection", "history"],
    })
    assert created.status_code == 200
    body = created.json()
    assert body["is_system"] is False and body["member_count"] == 0
    updated = client.patch(f"/api/v1/admin/groups/{body['id']}", json={"modules": ["detection"]})
    assert updated.json()["modules"] == ["detection"]
    assert client.delete(f"/api/v1/admin/groups/{body['id']}").status_code == 200


# ============ 注册默认组 ============
def test_register_lands_in_default_public_group(db_override, db_session):
    client = make_client(db_override, None)
    resp = client.post("/api/v1/auth/register", json={"username": "newguest", "password": "123456"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["group_code"] == "public"
    assert set(body["permissions"]) == {"ocean3d_science", "atlas", "assistant"}


def _stats_client(db_override, current: User | None):
    """只挂 stats 路由的测试应用（验证统计接口的模块门控）"""
    from routers import stats_router

    app = FastAPI()
    app.include_router(stats_router.router)
    app.dependency_overrides[get_db] = db_override
    if current is not None:
        app.dependency_overrides[get_current_user] = lambda: current
    return TestClient(app)


# ============ 统计接口模块门控 ============
def test_stats_reject_public_group(db_override, users):
    """科普访客组（无 dashboard/analysis/screen）不可读全局统计；
    站点列表因 3D 科普模式地球需要而放行；海域下拉是全员侧边栏组件仅要求登录。"""
    client = _stats_client(db_override, users["public"])
    assert client.get("/api/v1/stats/summary").status_code == 403
    assert client.get("/api/v1/stats/trend").status_code == 403
    assert client.get("/api/v1/stats/analysis").status_code == 403
    assert client.get("/api/v1/stats/sites").status_code == 200
    assert client.get("/api/v1/stats/sea-areas").status_code == 200


def test_stats_allow_analyst(db_override, users):
    """监测分析组拥有 dashboard/analysis 模块：统计接口全部放行"""
    client = _stats_client(db_override, users["analyst"])
    for ep in ("summary", "trend", "analysis", "sites", "sea-areas"):
        assert client.get(f"/api/v1/stats/{ep}").status_code == 200, ep


def test_stats_reject_unauthenticated(db_override):
    client = _stats_client(db_override, None)
    assert client.get("/api/v1/stats/summary").status_code == 401


# ============ 注册用户名规范（与后台创建用户同口径） ============
def test_register_rejects_symbol_username(db_override):
    """自助注册用户名含 - 等符号 → 400 中文提示（与后台建号 pattern 一致）"""
    client = make_client(db_override, None)
    resp = client.post("/api/v1/auth/register", json={"username": "bad-name", "password": "123456"})
    assert resp.status_code == 400
    assert "字母" in resp.json()["detail"]


def test_register_accepts_valid_username(db_override):
    client = make_client(db_override, None)
    resp = client.post("/api/v1/auth/register", json={"username": "海瞳_01", "password": "123456"})
    assert resp.status_code == 200

# ============ 换组申请（个人中心申请 → 后台审批 → 双方收铃铛通知） ============
def _group_id(db, code: str) -> int:
    return db.query(UserGroup).filter(UserGroup.code == code).first().id


def test_public_groups_exclude_super_admin(db_override, users):
    """个人中心可见的用户组列表不含超级管理员组"""
    client = make_client(db_override, users["public"])
    resp = client.get("/api/v1/auth/groups")
    assert resp.status_code == 200
    codes = {g["code"] for g in resp.json()["items"]}
    assert "super_admin" not in codes and "analyst" in codes


def test_my_stats_counts_own_records(db_override, users, db_session):
    """个人中心三项统计按账号统计：新用户为 0，产生任务/报告后对应增长"""
    from models import DetectionTask, Report, TaskType

    client = make_client(db_override, users["public"])
    assert client.get("/api/v1/auth/stats").json() == {
        "project_count": 0, "task_count": 0, "report_count": 0,
    }
    db_session.add(DetectionTask(
        user_id=users["public"].id, task_type=TaskType.image,
        file_name="a.jpg", file_path="x/a.jpg", sea_area_id=1,
    ))
    db_session.add(Report(
        user_id=users["public"].id, report_type="single", report_path="r/1.html",
    ))
    db_session.commit()
    assert client.get("/api/v1/auth/stats").json() == {
        "project_count": 1, "task_count": 1, "report_count": 1,
    }


def test_group_request_submit_and_duplicate_rejected(db_override, users):
    """普通用户可提交换组申请；重复提交待审批申请被拒"""
    client = make_client(db_override, users["public"])
    target = None  # 从公开组列表取目标，避免硬编码 id
    for g in client.get("/api/v1/auth/groups").json()["items"]:
        if g["code"] == "analyst":
            target = g["id"]
    resp = client.post("/api/v1/auth/group-requests", json={"group_id": target, "reason": "需要做检测"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending" and body["to_group_name"] == "监测分析组"
    assert client.post("/api/v1/auth/group-requests", json={"group_id": target}).status_code == 400


def test_group_request_guards(db_override, users, db_session):
    """超管无需申请；不能申请 super_admin 组；不能申请当前所在组"""
    admin_client = make_client(db_override, users["admin"])
    assert admin_client.post(
        "/api/v1/auth/group-requests", json={"group_id": _group_id(db_session, "analyst")}
    ).status_code == 403
    client = make_client(db_override, users["public"])
    assert client.post(
        "/api/v1/auth/group-requests", json={"group_id": _group_id(db_session, "super_admin")}
    ).status_code == 400
    assert client.post(
        "/api/v1/auth/group-requests", json={"group_id": _group_id(db_session, "public")}
    ).status_code == 400


def test_group_request_approve_switches_group_and_notifies(db_override, users, db_session):
    """批准：申请人调入目标组（权限即时变化），双方各收到一条铃铛通知"""
    from models import GroupSwitchRequest, Notification

    client = make_client(db_override, users["public"])
    req_id = client.post(
        "/api/v1/auth/group-requests", json={"group_id": _group_id(db_session, "analyst")}
    ).json()["id"]
    admin_client = make_client(db_override, users["admin"])
    pending = admin_client.get("/api/v1/admin/group-requests").json()["items"]
    assert [r["id"] for r in pending] == [req_id]
    assert admin_client.post(f"/api/v1/admin/group-requests/{req_id}/approve").status_code == 200
    db_session.refresh(users["public"])
    assert users["public"].group_id == _group_id(db_session, "analyst")
    assert "detection" in get_user_modules(db_session, users["public"])
    req = db_session.query(GroupSwitchRequest).filter(GroupSwitchRequest.id == req_id).first()
    assert req.status == "approved" and req.handled_by == users["admin"].id
    # 审批结果不可二次变更
    assert admin_client.post(f"/api/v1/admin/group-requests/{req_id}/reject").status_code == 400
    # 通知：申请人收到 approved；最高管理员收到 request
    types_by_user = {
        uid: {n.type.value for n in db_session.query(Notification).filter(Notification.user_id == uid)}
        for uid in (users["public"].id, users["admin"].id)
    }
    assert "group_change_approved" in types_by_user[users["public"].id]
    assert "group_change_request" in types_by_user[users["admin"].id]


def test_group_request_reject_keeps_group(db_override, users, db_session):
    """驳回：申请人分组不变并收到 rejected 通知"""
    from models import Notification

    client = make_client(db_override, users["analyst"])
    req_id = client.post(
        "/api/v1/auth/group-requests", json={"group_id": _group_id(db_session, "commander")}
    ).json()["id"]
    admin_client = make_client(db_override, users["admin"])
    assert admin_client.post(f"/api/v1/admin/group-requests/{req_id}/reject").status_code == 200
    db_session.refresh(users["analyst"])
    assert users["analyst"].group_id == _group_id(db_session, "analyst")
    types = {
        n.type.value
        for n in db_session.query(Notification).filter(Notification.user_id == users["analyst"].id)
    }
    assert "group_change_rejected" in types


def test_group_requests_require_admin(db_override, users):
    """审批列表与操作走后台守卫：无 admin 模块的用户 403"""
    client = make_client(db_override, users["public"])
    assert client.get("/api/v1/admin/group-requests").status_code == 403
