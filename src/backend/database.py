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
                    f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                    "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
                )
            )
    finally:
        server_engine.dispose()


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
