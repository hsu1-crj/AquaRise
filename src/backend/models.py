"""
ORM 模型层：全部 10 张 MySQL 表
=====================================
users               用户表（JWT + bcrypt，group_id 软外键 → user_groups）
user_groups         用户组表（RBAC：一组 = 一批功能模块）
group_modules       组-模块关联表（用户组拥有哪些功能模块）
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
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    Boolean,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from database import Base



# ============ 枚举（对应规划文档的 ENUM 字段） ============
class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


# ============ 功能模块注册表（RBAC 权限粒度 = 前端导航页面） ============
# key 同时是前端 PageKey（ocean3d 页除外，见下）与后端 require_permission 的权限名；
# 前端导航、后台管理页的模块矩阵、后端 API 守卫共用这一份口径。
# 海洋 3D 态势页按模式拆分两个权限键：ocean3d_monitor（监测模式）/ ocean3d_science（科普模式），
# 页面入口 = 拥有任一模式键；组内勾选即按职能锁定可用模式。
MODULE_REGISTRY: list[dict] = [
    {"key": "dashboard", "name": "态势总览", "desc": "海域污染态势仪表盘"},
    {"key": "ocean3d_monitor", "name": "海洋 3D · 监测模式", "desc": "3D 态势监测：真实站点数据 + 实时检测联动 + 扩散推演"},
    {"key": "ocean3d_science", "name": "海洋 3D · 科普模式", "desc": "3D 科普体验：垃圾沉降演示 + 知识漂流瓶 + 数字人导游"},
    {"key": "detection", "name": "智能识别", "desc": "水下垃圾图片/视频识别检测"},
    {"key": "history", "name": "检测历史", "desc": "历史检测任务查询与详情"},
    {"key": "analysis", "name": "污染分析", "desc": "污染指数与材质分布研判"},
    {"key": "screen", "name": "指挥大屏", "desc": "全屏指挥调度大屏"},
    {"key": "reports", "name": "质量报告", "desc": "海域污染质量报告生成与管理"},
    {"key": "assistant", "name": "海洋守护者", "desc": "数字人智能问答助手"},
    {"key": "atlas", "name": "海瞳 · 生命图谱", "desc": "灭绝海洋生物 3D 知识库"},
    {"key": "admin", "name": "后台管理", "desc": "用户/用户组与权限管理"},
]
MODULE_KEYS = [m["key"] for m in MODULE_REGISTRY]


# 内置用户组（启动播种；super_admin 权限不可修改、账号不可注销）。
# 模式锁定口径：超管双模式；监测/决策组锁监测模式；科普组锁科普模式。
SYSTEM_GROUP_SEEDS: list[dict] = [
    {"code": "super_admin", "name": "超级管理员", "desc": "拥有全部功能模块与后台管理权限（系统内置，权限不可修改）",
     "modules": MODULE_KEYS},
    {"code": "analyst", "name": "监测分析组", "desc": "一线监测与识别检测：垃圾识别、历史回溯、污染分析、报告产出（3D 锁监测模式）",
     "modules": ["dashboard", "ocean3d_monitor", "detection", "history", "analysis", "reports", "assistant"]},
    {"code": "commander", "name": "指挥决策组", "desc": "管理决策视角：态势研判、指挥大屏与质量报告（3D 锁监测模式）",
     "modules": ["dashboard", "ocean3d_monitor", "analysis", "screen", "reports", "assistant"]},
    {"code": "public", "name": "科普访客组", "desc": "公众科普视角：3D 海洋科普与灭绝生物知识库（3D 锁科普模式；自助注册默认组）",
     "modules": ["ocean3d_science", "atlas", "assistant"]},
]


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


class NotificationType(str, enum.Enum):
    task_completed = "task_completed"      # 检测任务完成
    task_failed = "task_failed"            # 检测任务失败
    report_ready = "report_ready"          # 质量报告生成完成
    pollution_warning = "pollution_warning"  # 污染等级告警（poor/severe）
    group_change_request = "group_change_request"    # 用户换组申请（推给最高管理员）
    group_change_approved = "group_change_approved"  # 换组申请已批准（推给申请人）
    group_change_rejected = "group_change_rejected"  # 换组申请已驳回（推给申请人）


# ============ 1. 用户表 ============
class User(Base):
    """用户：username 唯一，密码存 bcrypt 哈希；group_id 软外键 → user_groups.id"""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)  # bcrypt 哈希
    email = Column(String(100), nullable=True)
    phone_num = Column(String(20), nullable=True)  # 手机号，可作为登录凭据
    role = Column(SAEnum(UserRole), default=UserRole.user, nullable=False)
    group_id = Column(Integer, nullable=True, index=True)  # 软外键 → user_groups.id（组删除前须先移走成员）
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    def __repr__(self):
        return f"<User id={self.id} username={self.username!r} role={self.role.value}>"


# ============ 1b. 用户组表 + 组-模块关联表（RBAC） ============
class UserGroup(Base):
    """用户组：一个组 = 一批功能模块的集合。用户归入组即获得组内全部功能。
    内置组（is_system=True）不可删除；super_admin 组权限不可修改。"""

    __tablename__ = "user_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(30), unique=True, index=True, nullable=False)  # super_admin / analyst / ...
    name = Column(String(50), nullable=False)
    description = Column(String(200), nullable=True)
    is_system = Column(Boolean, default=False, nullable=False)  # 内置职能组：不可删除
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    modules = relationship(
        "GroupModule", cascade="all, delete-orphan", lazy="selectin",
        order_by="GroupModule.module", passive_deletes=True,
    )

    def __repr__(self):
        return f"<UserGroup id={self.id} code={self.code!r} name={self.name!r}>"


class GroupModule(Base):
    """组拥有的功能模块（module 取值见 MODULE_KEYS）"""

    __tablename__ = "group_modules"
    __table_args__ = (UniqueConstraint("group_id", "module", name="uq_group_module"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    module = Column(String(50), nullable=False)

    def __repr__(self):
        return f"<GroupModule group={self.group_id} module={self.module!r}>"


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


# ============ 2b. 人脸记录表（人脸识别登录/注册） ============
class FaceRecord(Base):
    """账号已录入的人脸特征。一个账号最多 config.MAX_FACES_PER_USER(3) 张。

    descriptor 存 np.float32 归一化特征向量的 tobytes()（二进制，不落盘图片文件），
    识别时 np.frombuffer 还原后与待识别向量做余弦相似度匹配。
    create_all 会自动创建新表；已在库则忽略。
    """

    __tablename__ = "face_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(30), nullable=False, default="人脸")  # 展示名
    descriptor = Column(LargeBinary, nullable=False)  # np.float32 归一化特征向量 tobytes()
    photo_path = Column(String(500), nullable=True)  # 录入照片路径（uploads/faces/，供本人回看）
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<FaceRecord id={self.id} user_id={self.user_id}>"


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
    sea_area_id = Column(Integer, nullable=True)  # 软外键 → sea_areas.id（海域归属，检测时按所选海域写入）
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


# ============ 3b. 海域表 + 监测站点表（F0） ============
class SeaArea(Base):
    """海域（北戴河 / 秦皇岛 / 渤海湾）：全局海域维度的主数据。

    检测任务的软外键归属（detection_tasks.sea_area_id 指向本表 id）；
    监测站点（monitoring_sites.sea_area_id）挂靠到海域之下，用于按海域过滤站点。"""

    __tablename__ = "sea_areas"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(32), unique=True, nullable=False)     # 北戴河 / 秦皇岛 / 渤海湾
    code = Column(String(16), unique=True, nullable=False)     # 如 "BDH" / "QHD" / "BHB"
    note = Column(String(255), nullable=True)
    area_km2 = Column(Float, nullable=True)                    # 监测覆盖面积 km²（静态地理主数据，由种子回填）

    def __repr__(self):
        return f"<SeaArea id={self.id} name={self.name!r}>"


class MonitoringSite(Base):
    """监测站点：挂靠到海域（monitoring_sites.sea_area_id 软外键 → sea_areas.id）。

    设计说明（契约 v1.1 §1）：故意不在 detection_tasks 上建物理外键——
    该表已存在且 create_all 不会 ALTER 旧表，物理 FK 需手工 ALTER 现网表（风险最高的一步），
    而应用行为只依赖 API 层校验 sea_area_id 合法性（detect_router._validate_sea_area）。
    """

    __tablename__ = "monitoring_sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(16), unique=True, nullable=False)   # 如 "A-01"
    name = Column(String(64), nullable=False)                # 如 "北戴河·滨海近岸监测点"
    lat = Column(Float, nullable=False)                      # WGS84 纬度
    lng = Column(Float, nullable=False)                      # WGS84 经度
    depth_m = Column(Float, nullable=True)                   # 平均水深（米）
    note = Column(String(255), nullable=True)
    sea_area_id = Column(Integer, nullable=True)             # 软外键 → sea_areas.id

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
    sea_area_id = Column(Integer, nullable=True)  # 报告所属海域（软外键 → sea_areas.id；批量/综合报告为统一海域，混域为 NULL）
    created_at = Column(DateTime, default=datetime.now)

    task = relationship("DetectionTask")
    user = relationship("User")

    def __repr__(self):
        return f"<Report id={self.id} type={self.report_type.value}>"


# ============ 8. 报告结构化分析表 ============
class ReportAnalysis(Base):
    """报告分析快照：事实统计由后端计算，result_json 保存可追溯的分析与方案。"""

    __tablename__ = "report_analyses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("reports.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="completed")
    result_json = Column(Text, nullable=False)
    model_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    report = relationship("Report")
    user = relationship("User")

    def __repr__(self):
        return f"<ReportAnalysis id={self.id} report={self.report_id} status={self.status}>"


# ============ 9. 通知表（铃铛通知中心） ============
class Notification(Base):
    """用户通知：检测任务完成/失败、报告生成完成、污染等级告警。

    只推给触发者本人（user_id 归属）；link_page 供前端跳转到 history/reports 页，
    ref_id 指回对应任务/报告 id。复合索引(user_id, is_read, created_at)
    同时服务「未读数 COUNT」与「最新 20 条」两类查询。"""

    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_read", "user_id", "is_read", "created_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    type = Column(SAEnum(NotificationType), nullable=False)
    title = Column(String(120), nullable=False)
    body = Column(String(255), nullable=True)
    link_page = Column(String(16), nullable=True)  # history / reports
    ref_id = Column(Integer, nullable=True)         # 关联任务/报告 id
    is_read = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<Notification id={self.id} user={self.user_id} type={self.type.value} read={self.is_read}>"
# ============ 10. 换组申请表（个人中心申请 → 最高管理员审批） ============
class GroupSwitchRequest(Base):
    """用户换组申请：申请人在个人中心提交，最高管理员在后台管理批准/驳回。

    status 流转：pending → approved / rejected（终态，不可再变更）。
    申请人同一时刻只允许一条 pending 申请（路由层校验）。
    批准后由审批接口直接改 users.group_id 并广播权限变更；handled_by 为软外键
    （审批人账号后续不可注销——最高管理员保护规则保证其恒在，无需级联）。"""

    __tablename__ = "group_switch_requests"
    __table_args__ = (
        Index("ix_group_switch_requests_status", "status", "created_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)  # 申请人
    from_group_id = Column(Integer, nullable=True)   # 申请时所在组（软外键，组可能后被删除）
    to_group_id = Column(Integer, nullable=False)    # 目标组（软外键，审批时再校验仍存在）
    reason = Column(String(255), nullable=True)      # 申请理由（选填）
    status = Column(String(16), nullable=False, default="pending")  # pending/approved/rejected
    handled_by = Column(Integer, nullable=True)      # 审批人 user id（软外键）
    handled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("User")

    def __repr__(self):
        return f"<GroupSwitchRequest id={self.id} user={self.user_id} status={self.status}>"
