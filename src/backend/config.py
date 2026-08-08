"""
数据库连接配置
=====================================
接入 MySQL 前，把下面几项改成你自己 MySQL 的信息即可。
（可以对照 Navicat 里能连通的那个连接来填。）
"""

# MySQL 服务器地址（本机通常为 localhost / 127.0.0.1）
DB_HOST = "localhost"

# MySQL 端口，默认 3306
DB_PORT = 3306

# 登录 MySQL 的用户名
DB_USER = "root"

# 登录 MySQL 的密码（没有密码就留空字符串 ""）
DB_PASSWORD = "123456"

# 数据库名：本项目用到的库，运行时会自动创建
DB_NAME = "fastapi_login"

# SQLAlchemy 连接串（一般不用改）
DATABASE_URL = (
    f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
)

# ============ JWT 配置 ============
# 生产环境务必改成随机长字符串！可用：python -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET_KEY = "fastapi-learning-jwt-secret-change-me"
# JWT 签名算法与有效期（小时）
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 8

# ============ 文件上传 ============
# 上传文件（检测图片/视频、知识库文档）存放目录
UPLOAD_DIR = "uploads"
