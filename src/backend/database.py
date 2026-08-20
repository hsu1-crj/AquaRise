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
