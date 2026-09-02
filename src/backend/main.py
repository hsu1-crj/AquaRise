"""
海洋守护者 FastAPI 后端主入口
=====================================
由 test/ 的完整后端迁移而来，作为 React 前端（src/frontend）的真实后端。
SSR 管理页面由 React SPA 取代，故不再挂载 pages_router / templates。

启动方式（二选一）：
    cd src/backend && uvicorn main:app --reload --port 8000
    或 从项目根  uvicorn src.backend.main:app --reload --port 8000

浏览器：
    http://127.0.0.1:8000/docs   Swagger API 文档
    http://127.0.0.1:5173        React 前端（npm run dev，/api 代理到 8000）
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# 将项目根与后端目录加入 Python 路径：
#   - 项目根  → 允许 `from src.LLM.chat_api import ...`（Ollama 对话混合模式）
#   - 后端目录 → 允许平铺导入 `import config / from models import ...`
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
for _p in (str(PROJECT_ROOT), str(BACKEND_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
import config  # noqa: E402
import models  # noqa: F401  E402  导入全部模型，注册到 Base.metadata 才能建表
from auth import hash_password  # noqa: E402
from database import (  # noqa: E402
    Base,
    SessionLocal,
    engine,
    ensure_database_exists,
    ensure_login_session_platform_column,
    ensure_monitoring_sites_sea_area_column,
    ensure_notification_type_enum,
    ensure_sea_areas_area_km2_column,
    ensure_reports_sea_area_column,
    ensure_users_group_column,
)
from routers import (  # noqa: E402
    admin_router,
    auth_router,
    chat_router,
    detect_router,
    digital_human_router,
    face_router,
    knowledge_router,
    marine_router,
    notifications_router,
    reports_router,
    stats_router,
)


def _ensure_user_groups(db) -> dict[str, int]:
    """播种内置用户组（幂等）：不存在则建组并写入模块集合；已存在不覆盖后台的改动。
    返回 {组 code: 组 id} 供存量用户迁移使用。"""
    id_by_code: dict[str, int] = {}
    for seed in models.SYSTEM_GROUP_SEEDS:
        group = db.query(models.UserGroup).filter(models.UserGroup.code == seed["code"]).first()
        if group is None:
            group = models.UserGroup(
                code=seed["code"],
                name=seed["name"],
                description=seed["desc"],
                is_system=True,
            )
            db.add(group)
            db.flush()
            for key in seed["modules"]:
                db.add(models.GroupModule(group_id=group.id, module=key))
        else:  # 已存在的内置组：只回填标记，不动名称与模块（保留后台的自定义调整）
            group.is_system = True
        id_by_code[seed["code"]] = group.id
    db.commit()
    _migrate_ocean3d_module_keys(db)
    return id_by_code


def _migrate_ocean3d_module_keys(db) -> None:
    """旧版 ocean3d 单键拆分为 ocean3d_monitor / ocean3d_science 两个模式键后的存量迁移（幂等）：
    - 内置组：按新种子的模式口径回填（public→仅科普，analyst/commander→仅监测，super_admin→双模式）；
    - 自定义组：旧键曾代表完整 3D 页面权限，保守地回填双模式，管理员可在后台按需收紧。"""
    seed_by_code = {seed["code"]: seed for seed in models.SYSTEM_GROUP_SEEDS}
    groups = db.query(models.UserGroup).all()
    for group in groups:
        existing = {
            row.module
            for row in db.query(models.GroupModule).filter(models.GroupModule.group_id == group.id)
        }
        if "ocean3d" not in existing:
            continue
        seed = seed_by_code.get(group.code)
        if seed:
            new_keys = [k for k in seed["modules"] if k in ("ocean3d_monitor", "ocean3d_science")]
        else:
            new_keys = ["ocean3d_monitor", "ocean3d_science"]
        db.query(models.GroupModule).filter(
            models.GroupModule.group_id == group.id, models.GroupModule.module == "ocean3d"
        ).delete(synchronize_session=False)
        for key in new_keys:
            if key not in existing:
                db.add(models.GroupModule(group_id=group.id, module=key))
    db.commit()


def _migrate_users_into_groups(db, group_ids: dict[str, int]) -> None:
    """存量用户归组（幂等，仅补 group_id 为空的行）：
    - role=admin（最高管理员）→ 超级管理员组；
    - 其余历史用户 → 监测分析组，保持原有核心业务能力不回退。"""
    admin_group = group_ids.get("super_admin")
    analyst_group = group_ids.get("analyst")
    if not admin_group or not analyst_group:
        return
    for user in db.query(models.User).filter(models.User.group_id.is_(None)).all():
        user.group_id = admin_group if user.role == models.UserRole.admin else analyst_group
    db.commit()


def _migrate_legacy_users(db):
    """兼容旧版 users 表：补齐新列并迁移明文密码 → bcrypt 哈希。"""
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("users")}
    if "password" in cols and "password_hash" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL"))
    if "email" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(100) NULL"))
    if "phone_num" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN phone_num VARCHAR(20) NULL"))
    if "role" not in cols:
        db.execute(
            text("ALTER TABLE users ADD COLUMN role ENUM('admin','user') NOT NULL DEFAULT 'user'")
        )
    if "created_at" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN created_at DATETIME NULL"))
    if "updated_at" not in cols:
        db.execute(text("ALTER TABLE users ADD COLUMN updated_at DATETIME NULL"))

    if "password" in cols:
        rows = db.execute(
            text("SELECT id, password FROM users WHERE password_hash IS NULL")
        ).fetchall()
        for uid, raw in rows:
            if raw and not raw.startswith("$2"):
                db.execute(
                    text("UPDATE users SET password_hash = :h WHERE id = :i"),
                    {"h": hash_password(raw), "i": uid},
                )
        db.execute(text("ALTER TABLE users DROP COLUMN password"))

    db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动：建目录 → 建库建表 → 迁移旧数据 → 播种 admin → 预热 Ollama"""
    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    os.makedirs("reports", exist_ok=True)

    ensure_database_exists()
    Base.metadata.create_all(bind=engine)
    ensure_login_session_platform_column()
    ensure_monitoring_sites_sea_area_column()
    ensure_sea_areas_area_km2_column()
    ensure_reports_sea_area_column()
    ensure_users_group_column()
    ensure_notification_type_enum()

    db = SessionLocal()
    try:
        _migrate_legacy_users(db)
        admin = db.query(models.User).filter(models.User.username == "admin").first()
        if admin is None:
            db.add(
                models.User(
                    username="admin",
                    password_hash=hash_password("123456"),
                    role=models.UserRole.admin,
                )
            )
            db.commit()
        else:
            if not admin.password_hash or admin.role != models.UserRole.admin:
                admin.password_hash = admin.password_hash or hash_password("123456")
                admin.role = models.UserRole.admin
                db.commit()
        sea_ids = _ensure_sea_areas(db)
        _ensure_monitoring_sites(db, sea_ids)
        # RBAC：播种内置用户组 → 存量用户归组（admin→超管组，历史用户→监测分析组）
        group_ids = _ensure_user_groups(db)
        _migrate_users_into_groups(db, group_ids)
    finally:
        db.close()

    # 重建视频媒体索引：预览帧/标注视频文件已落盘，从磁盘恢复 URL（进程重启不丢）
    from services import detector
    from services.notification_hub import hub

    # 通知发布中枢绑定主事件循环：视频 worker 等线程池线程借此 call_soon_threadsafe 投递 SSE
    hub.set_loop(
        asyncio.get_running_loop())

    try:
        detector.restore_video_indexes()
    except Exception:
        pass

    # 预热 Ollama 对话服务（不可用则回退存根，不影响启动）
    try:
        chat_router._get_ollama_service()
    except Exception:
        pass

    yield


# 旧演示种子站点（舟山/深圳/珠海/青岛等），用于迁移替换为渤海站点。
# 注意：_LEGACY_SITE_CODES 中的代号 A-01~C-01 与当前真实种子站点代号重合，
# 故迁移删除前必须过滤掉属于 _BOHAI_SITE_SEEDS 的站点，避免误删真实站点。
_LEGACY_SITE_CODES = {"A-01", "A-02", "B-01", "B-02", "C-01"}
_LEGACY_SITE_NAMES = ("舟山", "大鹏湾", "万山群岛", "胶州湾")

# 渤海海域：北戴河 / 秦皇岛 / 渤海湾（全局海域维度主数据，检测任务的 sea_area_id 归属）
# area_km2 为各海域监测覆盖范围的静态地理主数据（合计 126.8 km²）
_SEA_AREA_SEEDS = [
    ("北戴河", "BDH", "渤海辽东湾西南沿岸，旅游景区近岸", 16.8),
    ("秦皇岛", "QHD", "秦皇岛港及山海关老龙头一带沿岸", 34.0),
    ("渤海湾", "BHB", "渤海湾北缘与西端（曹妃甸 / 塘沽）沿岸", 76.0),
]

# 渤海近岸监测站点：覆盖北戴河 / 秦皇岛 / 渤海湾三个海域（本项目全部检测行为的归属点位）
_BOHAI_SITE_SEEDS = [
    ("A-01", "北戴河·滨海近岸监测点", 39.82, 119.52, 8, "渤海辽东湾西南，旅游景区近岸"),
    ("A-02", "北戴河·浅水湾监测点", 39.80, 119.47, 6, "浅水湾防潮堤外，休闲海滩"),
    ("B-01", "秦皇岛·海港区近岸监测点", 39.93, 119.60, 12, "秦皇岛港出港航道附近"),
    ("B-02", "秦皇岛·山海关近岸监测点", 39.99, 119.76, 15, "山海关老龙头海域"),
    ("C-01", "渤海湾·曹妃甸近岸监测点", 39.27, 118.46, 14, "渤海湾北缘，曹妃甸工业区近岸"),
    ("C-02", "渤海湾·塘沽近岸监测点", 39.00, 117.72, 10, "渤海湾西端，天津港近岸"),
]


def _is_legacy_site(site) -> bool:
    """判断是否为旧演示种子站点（舟山/大鹏湾/万山群岛/胶州湾等），用于迁移替换。"""
    name = site.name or ""
    return site.code in _LEGACY_SITE_CODES or any(k in name for k in _LEGACY_SITE_NAMES)


def _ensure_sea_areas(db) -> dict[str, int]:
    """播种渤海海域（幂等），返回 {海域名: id} 映射供站点回填使用。"""
    id_by_name: dict[str, int] = {}
    for name, code, note, area_km2 in _SEA_AREA_SEEDS:
        area = db.query(models.SeaArea).filter(models.SeaArea.name == name).first()
        if area is None:
            area = models.SeaArea(name=name, code=code, note=note, area_km2=area_km2)
            db.add(area)
            db.flush()
        elif area.code != code or area.note != note or area.area_km2 != area_km2:
            area.code = code
            area.note = note
            area.area_km2 = area_km2
        id_by_name[name] = area.id
    db.commit()
    return id_by_name


def _site_sea_area_name(name: str) -> str | None:
    """按站点名前缀（'北戴河·…' → 北戴河）解析所属海域名；无前导海域名返回 None。"""
    return name.split("·", 1)[0] if name else None


def _ensure_monitoring_sites(db, sea_ids: dict[str, int]) -> None:
    """播种渤海监测站点（幂等 + 迁移），并按站点名前缀回填 sea_area_id 挂靠海域。

    monitoring_sites 是新表，由 create_all 直接创建，无需 ALTER 旧表；
    sea_area_id 列由 database.ensure_monitoring_sites_sea_area_column() 幂等补充，
    检测任务的软外键见 models.MonitoringSite 设计说明。
    历史版本曾播种舟山/深圳/珠海/青岛等演示站点，此处将这些旧种子站点替换为
    渤海三地站点（北戴河/秦皇岛/渤海湾）。用户手工新增的非种子站点不做删除。

    幂等性按 site.code 判重：只删除「不在 _BOHAI_SITE_SEEDS 中的旧种子站点」
    （_LEGACY_SITE_CODES 与真实种子代号重合，不能按代号误删），
    并只插入 code 尚不存在的真实种子站点 —— 重启多次不报 Duplicate entry。"""
    seed_codes = {seed[0] for seed in _BOHAI_SITE_SEEDS}
    seed_name_by_code = {seed[0]: seed[1] for seed in _BOHAI_SITE_SEEDS}
    # 迁移：删除旧演示站点。代号与真实种子重合（A-01等）时，必须再按名称判断——
    # 名称与当前渤海种子不一致的（如"舟山·朱家尖"占着A-01）才是待替换的旧站点。
    legacy = db.query(models.MonitoringSite).filter(
        models.MonitoringSite.code.in_(_LEGACY_SITE_CODES)
    ).all()
    for site in legacy:
        if site.code not in seed_codes or site.name != seed_name_by_code.get(site.code):
            db.delete(site)
    # 幂等播种：code 已存在的站点跳过，避免 duplicate
    existing = set(
        code for (code,) in db.query(models.MonitoringSite.code).all()
    )
    for code, name, lat, lng, depth, note in _BOHAI_SITE_SEEDS:
        if code in existing:
            continue
        sea_name = _site_sea_area_name(name)
        db.add(models.MonitoringSite(code=code, name=name, lat=lat, lng=lng,
                                     depth_m=depth, note=note,
                                     sea_area_id=sea_ids.get(sea_name) if sea_name else None))
        existing.add(code)
    db.commit()
    # 为新播种的种子站点回填一次海域 id；也覆盖旧站点替换后残留的 NULL（幂等）
    _backfill_site_sea_area(db, sea_ids)


def _backfill_site_sea_area(db, sea_ids: dict[str, int]) -> None:
    """为 monitoring_sites 中 sea_area_id 为 NULL 的站点，按名称前缀回填海域 id（幂等）。"""
    for site in db.query(models.MonitoringSite).filter(
        models.MonitoringSite.sea_area_id.is_(None)
    ).all():
        sea_name = _site_sea_area_name(site.name)
        if sea_name and sea_name in sea_ids:
            site.sea_area_id = sea_ids[sea_name]
    db.commit()


# ============ 创建应用 ============
app = FastAPI(
    title="海洋守护者 API（水下垃圾自动识别与海洋污染分析系统）",
    description="认证 / 检测 / 统计 / 对话 / 报告 / 知识库 / 数字人",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS：开发环境前端经 Vite 代理（同源）无需跨域，放开便于绕过代理直连 / 本地调试
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ 挂载 API 路由 ============
app.include_router(auth_router.router)           # /login /register /logout /captcha /api/v1/auth/*
app.include_router(face_router.router)           # /api/v1/auth/face/*（人脸识别登录/注册）
app.include_router(detect_router.router)         # /api/v1/detect/* + /api/v1/detections
app.include_router(chat_router.router)           # /api/v1/chat (SSE) /api/v1/chat/history
app.include_router(stats_router.router)          # /api/v1/stats/*
app.include_router(marine_router.router)         # /api/v1/stats/marine (真实海况, 缓存+降级)
app.include_router(reports_router.router)        # /api/v1/reports/*
app.include_router(knowledge_router.router)      # /api/v1/knowledge/*
app.include_router(digital_human_router.router)  # /api/v1/digital-human/*
app.include_router(admin_router.router)          # /api/v1/admin/*（后台管理：用户/用户组/概览）
app.include_router(notifications_router.router)  # /api/v1/notifications/*（铃铛通知中心，SSE）

# ============ 静态文件：上传产物（图片/视频/视频预览帧）同源访问 ============
# 挂载 /uploads → config.UPLOAD_DIR（默认 uploads/，相对 cwd=src/backend），
# 使 /uploads/video_preview/{task_id}.jpg 等 URL 可直接被 <img> 加载。
_UPLOADS_ABS = os.path.abspath(config.UPLOAD_DIR)
os.makedirs(_UPLOADS_ABS, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_UPLOADS_ABS), name="uploads")


@app.get("/")
async def root():
    return {
        "service": "海洋守护者 API",
        "version": "0.1.0",
        "docs": "/docs",
        "frontend": "http://localhost:5173 (npm run dev)",
    }


# ============ 入口 ============
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
