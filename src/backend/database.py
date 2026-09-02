"""
数据库引擎与会话
=====================================
engine   ：和 MySQL 的连接池
SessionLocal：创建数据库会话（一次请求一个会话）
Base     ：ORM 模型的基类，models.py 里的 User 继承它
"""

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

from config import DATABASE_URL, DB_NAME

# pool_pre_ping=True：每次从连接池取连接前先探活，避免拿到已断开的连接
engine = create_engine(DATABASE_URL, pool_pre_ping=True)

# 会话工厂：用来在每次请求时创建新的数据库会话
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# 所有 ORM 模型都继承这个 Base
Base = declarative_base()


def ensure_database_exists():
    """
    数据库不存在时自动创建（只建库，不建表）
    create_all 只会建表、不会建库，所以连接前先保证库存在。
    做法：先不带库名连到 MySQL 服务器，执行 CREATE DATABASE IF NOT EXISTS。
    """
    # 去掉连接串里的库名，得到 mysql+pymysql://用户:密码@主机:端口
    server_url = DATABASE_URL.rsplit("/", 1)[0]
    server_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    try:
        with server_engine.connect() as conn:
            conn.execute(
                text(
                    "CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                    "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
                )
            )
    finally:
        server_engine.dispose()


def ensure_login_session_platform_column() -> None:
    """
    幂等迁移：为 login_sessions 增加 platform 列（并发登录按设备类型分组）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列。
    已有行回填为 'pc'（NOT NULL DEFAULT 'pc'），保持向后兼容。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'login_sessions' "
                "AND COLUMN_NAME = 'platform'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(
                text(
                    "ALTER TABLE login_sessions "
                    "ADD COLUMN platform VARCHAR(16) NOT NULL DEFAULT 'pc'"
                )
            )
            conn.execute(
                text("CREATE INDEX ix_login_sessions_platform ON login_sessions (platform)")
            )
            conn.commit()

def get_db():
    """
    FastAPI 依赖：提供数据库会话
    用法：def xxx(db: Session = Depends(get_db)):
    请求结束后会自动关闭会话，归还连接池
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_users_group_column() -> None:
    """
    幂等迁移：为 users 增加 group_id 列（RBAC 用户组软外键 → user_groups.id）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列（MySQL 专用写法，
    information_schema.COLUMNS 查询；本项目仅用 MySQL，可接受）。
    缺省 NULL：随后由 main.py 的播种迁移把存量用户归入内置组。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'users' "
                "AND COLUMN_NAME = 'group_id'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(text("ALTER TABLE users ADD COLUMN group_id INT NULL"))
            conn.execute(text("CREATE INDEX ix_users_group_id ON users (group_id)"))
            conn.commit()

def ensure_monitoring_sites_sea_area_column() -> None:
    """
    幂等迁移：为 monitoring_sites 增加 sea_area_id 列（挂靠到 sea_areas 的软外键）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列（MySQL 专用写法，
    information_schema.COLUMNS 查询；本项目仅用 MySQL，可接受）。
    缺省 NULL：随后由 main.py 的播种回填按站点名前缀绑定海域。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'monitoring_sites' "
                "AND COLUMN_NAME = 'sea_area_id'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(
                text(
                    "ALTER TABLE monitoring_sites "
                    "ADD COLUMN sea_area_id INT NULL"
                )
            )
            conn.commit()


def ensure_detection_tasks_monitoring_site_column() -> None:
    """
    幂等迁移：为 detection_tasks 增加 monitoring_site_id 列（任务真实归属监测站的软外键）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列（MySQL 专用写法，
    information_schema.COLUMNS 查询；本项目仅用 MySQL，可接受）。
    缺省 NULL：旧任务无法可靠反推具体站点，保持不归属，不回填。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'detection_tasks' "
                "AND COLUMN_NAME = 'monitoring_site_id'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(
                text("ALTER TABLE detection_tasks ADD COLUMN monitoring_site_id INT NULL")
            )
            conn.execute(
                text("CREATE INDEX ix_detection_tasks_monitoring_site_id ON detection_tasks (monitoring_site_id)")
            )
            conn.commit()


def ensure_sea_areas_area_km2_column() -> None:
    """
    幂等迁移：为 sea_areas 增加 area_km2 列（监测覆盖面积，静态地理主数据）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列（MySQL 专用写法，
    information_schema.COLUMNS 查询；本项目仅用 MySQL，可接受）。
    缺省 NULL：随后由 main.py 的海域播种按种子值回填。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'sea_areas' "
                "AND COLUMN_NAME = 'area_km2'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(
                text("ALTER TABLE sea_areas ADD COLUMN area_km2 FLOAT NULL")
            )
            conn.commit()


def ensure_notification_type_enum() -> None:
    """
    幂等迁移：为 notifications.type 枚举补充换组申请相关取值
    （group_change_request / group_change_approved / group_change_rejected）。
    create_all 只建新表、不会 ALTER 旧表的 ENUM 定义，因此启动时手动扩枚举
    （MySQL 专用写法，与 models.NotificationType 保持一致——新增类型时两处同改）。
    """
    all_values = (
        "task_completed", "task_failed", "report_ready", "pollution_warning",
        "group_change_request", "group_change_approved", "group_change_rejected",
    )
    with engine.connect() as conn:
        column_type = conn.execute(
            text(
                "SELECT COLUMN_TYPE FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'notifications' "
                "AND COLUMN_NAME = 'type'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not column_type:  # 表不存在（首次启动 create_all 已按新模型建表）无需处理
            return
        if all(f"'{v}'" in column_type for v in all_values):
            return
        enum_sql = ",".join(f"'{v}'" for v in all_values)
        conn.execute(
            text(f"ALTER TABLE notifications MODIFY COLUMN type ENUM({enum_sql}) NOT NULL")
        )
        conn.commit()

def ensure_reports_sea_area_column() -> None:
    """
    幂等迁移：为 reports 增加 sea_area_id 列（报告所属海域，软外键 → sea_areas.id）。
    create_all 只建新表、不会 ALTER 旧表，因此启动时手动补列（MySQL 专用写法，
    information_schema.COLUMNS 查询；本项目仅用 MySQL，可接受）。
    缺省 NULL：历史报告无法可靠反推海域，保持不归属，前端显示「未指定海域」。
    """
    with engine.connect() as conn:
        exists = conn.execute(
            text(
                "SELECT COUNT(*) FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'reports' "
                "AND COLUMN_NAME = 'sea_area_id'"
            ),
            {"db": DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(
                text("ALTER TABLE reports ADD COLUMN sea_area_id INT NULL")
            )
            conn.commit()
