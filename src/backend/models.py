"""
ORM 模型层：全部 8 张 MySQL 表
=====================================
users               用户表（JWT + bcrypt）
login_sessions      登录会话表（并发登录控制）
detection_tasks     检测任务表（图片/视频）
detection_results   检测结果表（逐帧逐目标）
chat_history        对话历史表
digital_human_sessions  数字人交互记录表
knowledge_docs      RAG 知识库文档表
reports             报告表

所有表由 Base.metadata.create_all() 在启动时自动创建。
"""

import enum
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Boolean,
)
from sqlalchemy.orm import relationship

from database import Base


# ============ 枚举（对应规划文档的 ENUM 字段） ============
class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class TaskType(str, enum.Enum):
    image = "image"
    video = "video"


class TaskStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class PollutionLevel(str, enum.Enum):
    excellent = "excellent"  # 优
    good = "good"            # 良
    moderate = "moderate"    # 中
    poor = "poor"            # 差
    severe = "severe"        # 严重


class ChatRole(str, enum.Enum):
    user = "user"
    assistant = "assistant"


class DocStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class ReportType(str, enum.Enum):
    single = "single"
    weekly = "weekly"
    monthly = "monthly"
    custom = "custom"


class DHStatus(str, enum.Enum):
    pending = "pending"
    speaking = "speaking"
    completed = "completed"
    failed = "failed"


# ============ 1. 用户表 ============
class User(Base):
    """用户：username 唯一，密码存 bcrypt 哈希"""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)  # bcrypt 哈希
    email = Column(String(100), nullable=True)
    phone_num = Column(String(20), nullable=True)  # 手机号，可作为登录凭据
    role = Column(SAEnum(UserRole), default=UserRole.user, nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    def __repr__(self):
        return f"<User id={self.id} username={self.username!r} role={self.role.value}>"


# ============ 2. 登录会话表（并发登录控制） ============
class LoginSession(Base):
    """
    登录会话：每个 JWT 对应一条记录。
    用于「同一账号在同一平台(设备类型)的并发登录数」限制：
      - admin 账号每个平台最多 3 个会话
      - user  账号每个平台最多 1 个会话
    同平台超限则踢掉最早建立的会话；跨平台(PC ↔ 移动端)互不挤占。
    被踢的 token 在 get_current_user 中失效。
    """

    __tablename__ = "login_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, nullable=False)  # JWT 的 SHA-256，避免明文落库
    created_at = Column(DateTime, default=datetime.now)
    expires_at = Column(DateTime, nullable=False)  # 与 JWT 过期时间一致
    platform = Column(String(16), nullable=False, default="pc", server_default="pc", index=True)  # 设备类型：pc / mobile，并发按此分组

    user = relationship("User")

    def __repr__(self):
        return f"<LoginSession id={self.id} user_id={self.user_id} expires_at={self.expires_at}>"


# ============ 3. 检测任务表 ============
class DetectionTask(Base):
    """一次图片/视频检测任务"""

    __tablename__ = "detection_tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    task_type = Column(SAEnum(TaskType), nullable=False)  # image / video
    file_name = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    status = Column(SAEnum(TaskStatus), default=TaskStatus.pending, nullable=False)
    sea_area_id = Column(Integer, nullable=True)  # 海域编号（本期留空）
    total_objects = Column(Integer, default=0, nullable=False)  # 检出垃圾总数
    pollution_level = Column(SAEnum(PollutionLevel), nullable=True)
    processing_time = Column(Float, nullable=True)  # 处理耗时（秒）
    created_at = Column(DateTime, default=datetime.now)
    completed_at = Column(DateTime, nullable=True)

    user = relationship("User")
    results = relationship(
        "DetectionResult", cascade="all, delete-orphan", back_populates="task"
    )

    def __repr__(self):
        return f"<DetectionTask id={self.id} type={self.task_type.value} status={self.status.value}>"


# ============ 3. 检测结果表（逐帧逐目标） ============
class DetectionResult(Base):
    """检测到的每一个目标框"""

    __tablename__ = "detection_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("detection_tasks.id", ondelete="CASCADE"), nullable=False)
    frame_index = Column(Integer, default=0, nullable=False)  # 视频帧号，图片恒为 0
    class_id = Column(Integer, nullable=False)  # YOLO 类别 ID
    class_name = Column(String(50), nullable=False)  # 中文类别名
    confidence = Column(Float, nullable=False)  # 置信度
    bbox_x1 = Column(Float, nullable=True)
    bbox_y1 = Column(Float, nullable=True)
    bbox_x2 = Column(Float, nullable=True)
    bbox_y2 = Column(Float, nullable=True)
    material_type = Column(String(30), nullable=True)  # 材质：塑料/金属/尼龙...
    created_at = Column(DateTime, default=datetime.now)

    task = relationship("DetectionTask", back_populates="results")

    def __repr__(self):
        return f"<DetectionResult id={self.id} class={self.class_name} conf={self.confidence}>"


# ============ 3b. 监测站点表（F0） ============
class MonitoringSite(Base):
    """监测站点：检测任务的软外键归属（detection_tasks.sea_area_id 指向本表 id）。

    设计说明（契约 v1.1 §1）：故意不在 detection_tasks 上建物理外键——
    该表已存在且 create_all 不会 ALTER 旧表，物理 FK 需手工 ALTER 现网表（风险最高的一步），
    而应用行为只依赖 API 层校验 site_id 合法性（detect_router._validate_site）。
    """

    __tablename__ = "monitoring_sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(16), unique=True, nullable=False)   # 如 "A-01"
    name = Column(String(64), nullable=False)                # 如 "舟山-朱家尖近岸监测点"
    lat = Column(Float, nullable=False)                      # WGS84 纬度
    lng = Column(Float, nullable=False)                      # WGS84 经度
    depth_m = Column(Float, nullable=True)                   # 平均水深（米）
    note = Column(String(255), nullable=True)

    def __repr__(self):
        return f"<MonitoringSite id={self.id} code={self.code!r} name={self.name!r}>"


# ============ 4. 对话历史表 ============
class ChatHistory(Base):
    """海洋小助手对话记录"""

    __tablename__ = "chat_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(String(100), nullable=False, index=True)
    role = Column(SAEnum(ChatRole), nullable=False)  # user / assistant
    content = Column(Text, nullable=False)
    has_image = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<ChatHistory id={self.id} role={self.role.value}>"


# ============ 5. 数字人交互记录表 ============
class DigitalHumanSession(Base):
    """数字人交互记录（扩展功能）"""

    __tablename__ = "digital_human_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(String(100), nullable=False)
    input_type = Column(String(20), default="text", nullable=False)
    input_text = Column(Text, nullable=True)
    llm_response = Column(Text, nullable=True)
    avatar_id = Column(String(50), nullable=True)
    voice_id = Column(String(50), nullable=True)
    sdk_mode = Column(String(20), default="realtime", nullable=False)
    status = Column(SAEnum(DHStatus), default=DHStatus.pending, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<DigitalHumanSession id={self.id} status={self.status.value}>"


# ============ 6. 知识库文档表 ============
class KnowledgeDoc(Base):
    """RAG 知识库上传的文档"""

    __tablename__ = "knowledge_docs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_name = Column(String(255), nullable=False)
    file_type = Column(String(20), nullable=False)  # pdf/word/txt
    file_path = Column(String(500), nullable=False)
    file_size = Column(Integer, nullable=True)  # 字节
    chunk_count = Column(Integer, default=0, nullable=False)  # 分片数
    status = Column(SAEnum(DocStatus), default=DocStatus.pending, nullable=False)
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<KnowledgeDoc id={self.id} file={self.file_name} status={self.status.value}>"


# ============ 7. 报告表 ============
class Report(Base):
    """海域污染评估报告"""

    __tablename__ = "reports"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("detection_tasks.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    report_type = Column(SAEnum(ReportType), nullable=False)
    report_path = Column(String(500), nullable=False)
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.now)

    task = relationship("DetectionTask")
    user = relationship("User")

    def __repr__(self):
        return f"<Report id={self.id} type={self.report_type.value}>"
