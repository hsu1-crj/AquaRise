"""
Pydantic 模型：API 请求 / 响应结构
=====================================
用于请求体校验和响应序列化（OpenAPI 文档也会据此生成）。
"""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ============ 认证 ============
class LoginRequest(BaseModel):
    """API JSON 登录请求"""
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1)
    platform: Literal["pc", "mobile"] = Field(default="pc", description="设备类型：pc=主机端 / mobile=移动端，并发登录按此分组")
    remember_me: bool = Field(default=False, description="保持登录：签发长有效期 token（30 天），跨浏览器重启自动登录直到退出")


class RegisterRequest(BaseModel):
    """API JSON 注册请求"""
    username: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=6)
    email: Optional[str] = Field(default=None, max_length=100)
    phone_num: Optional[str] = Field(default=None, max_length=20)


class ResetPasswordRequest(BaseModel):
    """忘记密码：用户名 + 邮箱 双要素验证通过后重置密码（无需登录）。
    注册仅强制绑定邮箱，手机号为选填，故不参与校验；phone 字段保留兼容旧客户端。"""
    username: str = Field(min_length=1, max_length=50)
    email: str = Field(min_length=1, max_length=100)
    phone: str = Field(default="", max_length=20)  # 已不参与校验，保留字段兼容
    new_password: str = Field(min_length=6, max_length=64)
    confirm_password: str = Field(min_length=6)


class TokenResponse(BaseModel):
    """登录成功返回的 JWT"""
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    """用户信息（含所属用户组与功能模块权限，前端据此过滤导航与页面）"""
    id: int
    username: str
    email: Optional[str]
    phone_num: Optional[str]
    role: str
    group_id: Optional[int] = None
    group_code: Optional[str] = None
    group_name: Optional[str] = None
    permissions: list[str] = []
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ============ 后台管理（RBAC 用户/用户组） ============
class AdminUserItem(BaseModel):
    """后台用户列表行"""
    id: int
    username: str
    email: Optional[str] = None
    phone_num: Optional[str] = None
    role: str
    group_id: Optional[int] = None
    group_code: Optional[str] = None
    group_name: Optional[str] = None
    permissions: list[str] = []
    created_at: Optional[datetime] = None
    is_super_admin: bool = False  # 最高管理员：后台不可注销、不可调组


class AdminUserCreateRequest(BaseModel):
    """后台创建用户"""
    username: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_\u4e00-\u9fa5]+$")
    password: str = Field(min_length=6, max_length=64)
    email: Optional[str] = Field(default=None, max_length=100)
    phone_num: Optional[str] = Field(default=None, max_length=20)
    group_id: int = Field(ge=1, description="所属用户组（必选，决定可用功能）")


class AdminUserUpdateRequest(BaseModel):
    """后台更新用户（分组/联系方式；均为可选字段，未传不改）"""
    group_id: Optional[int] = Field(default=None, ge=1)
    email: Optional[str] = Field(default=None, max_length=100)
    phone_num: Optional[str] = Field(default=None, max_length=20)


class AdminResetPasswordRequest(BaseModel):
    """后台重置用户密码"""
    new_password: str = Field(min_length=6, max_length=64)


class AdminGroupItem(BaseModel):
    """后台用户组（含功能模块集合与成员数）"""
    id: int
    code: str
    name: str
    description: Optional[str] = None
    is_system: bool = False
    modules: list[str] = []
    member_count: int = 0
    created_at: Optional[datetime] = None


class AdminGroupCreateRequest(BaseModel):
    """后台创建用户组"""
    name: str = Field(min_length=2, max_length=50)
    code: Optional[str] = Field(default=None, pattern=r"^[a-z][a-z0-9_]{1,29}$")
    description: Optional[str] = Field(default=None, max_length=200)
    modules: list[str] = Field(default_factory=list, description="勾选的功能模块 key 集合")


class AdminGroupUpdateRequest(BaseModel):
    """后台更新用户组（名称/描述/模块集合）"""
    name: Optional[str] = Field(default=None, min_length=2, max_length=50)
    description: Optional[str] = Field(default=None, max_length=200)
    modules: Optional[list[str]] = None


class AdminOverview(BaseModel):
    """后台概览"""
    user_count: int
    group_count: int
    task_count: int
    completed_task_count: int
    report_count: int
    group_members: list[AdminGroupItem] = []  # 各组规模（概览分布图用）
    recent_users: list[AdminUserItem] = []    # 最近注册用户


class ChangePasswordRequest(BaseModel):
    """个人中心修改密码"""
    old_password: str = Field(min_length=1)
    new_password: str = Field(min_length=6)


class ProfileUpdateRequest(BaseModel):
    """个人中心更新资料（电子邮箱 / 手机号）"""
    email: Optional[str] = Field(default=None, max_length=100)
    phone_num: Optional[str] = Field(default=None, max_length=20)
class UserStatsResponse(BaseModel):
    """个人中心头像卡三项统计：参与项目（去重海域数）/ 创建任务 / 生成报告"""
    project_count: int
    task_count: int
    report_count: int


class GroupOptionItem(BaseModel):
    """个人中心「申请换组」可见的用户组（排除超级管理员组），含模块中文名"""
    id: int
    code: str
    name: str
    description: Optional[str] = None
    modules: list[str] = []        # 功能模块 key
    module_names: list[str] = []   # 功能模块中文名（与 modules 同序）


class GroupSwitchRequestCreate(BaseModel):
    """提交换组申请"""
    group_id: int = Field(ge=1, description="目标用户组 id")
    reason: Optional[str] = Field(default=None, max_length=200)


class GroupSwitchRequestItem(BaseModel):
    """换组申请记录（个人中心看自己的；后台管理看全部待审批）"""
    id: int
    username: Optional[str] = None        # 申请人（后台列表用）
    from_group_name: Optional[str] = None
    to_group_id: int
    to_group_name: Optional[str] = None
    reason: Optional[str] = None
    status: str                            # pending / approved / rejected
    created_at: Optional[datetime] = None
    handled_at: Optional[datetime] = None


class MessageResponse(BaseModel):
    """通用操作成功消息"""
    message: str


# ============ 人脸识别 ============
class FaceInfo(BaseModel):
    """账号已录入的人脸信息（不含特征向量）"""
    id: int
    name: str
    created_at: Optional[datetime]
    hasPhoto: bool = False  # 是否有可回看的录入照片（历史记录为 False）

    model_config = {"from_attributes": True}


class FaceListResponse(BaseModel):
    """当前账号已录入的人脸列表"""
    items: list[FaceInfo]


class FaceLoginResponse(BaseModel):
    """人脸识别登录成功返回：JWT + 识别到的用户名"""
    access_token: str
    username: str
    token_type: str = "bearer"


# ============ 检测 ============
class DetectionResultItem(BaseModel):
    """检测到的单个目标"""
    class_id: int
    class_name: str
    confidence: float
    bbox_x1: Optional[float] = None
    bbox_y1: Optional[float] = None
    bbox_x2: Optional[float] = None
    bbox_y2: Optional[float] = None
    material_type: Optional[str] = None
    crop_url: Optional[str] = None  # 视频目标裁剪缩略图 URL（视频任务才有）


class ImageDetectResponse(BaseModel):
    """图片检测返回"""
    task_id: int
    total_objects: int
    pollution_level: str
    results: list[DetectionResultItem] = []


class VideoDetectResponse(BaseModel):
    """视频检测提交返回"""
    task_id: int
    status: str
    message: str


class TaskStatusResponse(BaseModel):
    """任务进度查询返回"""
    task_id: int
    status: str
    progress: float  # 0-100
    total_objects: int
    pollution_level: Optional[str] = None
    processing_time: Optional[float] = None
    preview_url: Optional[str] = None  # 视频实时预览帧（标注图）URL，非视频任务为 None
    preview_urls: Optional[list[str]] = None  # 视频已累积的全部预览帧 URL（按场景逐张）
    annotated_video_url: Optional[str] = None  # 逐帧画框后的标注视频（可回放）URL
    processed_frames: Optional[int] = None  # 已处理帧数
    total_frames: Optional[int] = None  # 视频总帧数


class ResultResponse(BaseModel):
    """检测结果返回：任务信息 + 帧级结果 + 汇总"""
    task_id: int
    task_type: str
    file_name: str
    status: str
    total_objects: int
    pollution_level: Optional[str]
    processing_time: Optional[float]
    results: list[DetectionResultItem] = []
    material_breakdown: dict = {}  # {"塑料": N, "金属": N, ...}
    annotated_video_url: Optional[str] = None  # 逐帧画框后的标注视频（可回放）URL
    preview_urls: Optional[list[str]] = None  # 视频：场景预览帧（按场景逐张累积）
    media_url: Optional[str] = None  # 图片：把已入库检测框画回原图的标注图 URL


# ============ 聊天 ============
class ChatRequest(BaseModel):
    """对话请求"""
    session_id: Optional[str] = None  # 不传则服务端新建
    message: str = Field(min_length=1)


class ChatMessage(BaseModel):
    """单条对话记录"""
    role: str
    content: str


# ============ 统计 ============
class StatsSummary(BaseModel):
    """统计概览"""
    total_tasks: int
    total_objects: int
    total_users: int
    pollution_breakdown: dict = {}  # {"excellent": N, ...}
    material_breakdown: dict = {}   # {"塑料": N, ...}


class TrendPoint(BaseModel):
    """趋势数据点"""
    date: str
    count: int
    level: Optional[str] = None


class TrendResponse(BaseModel):
    """趋势数据"""
    period: str
    data: list[TrendPoint] = []


# ============ 报告 / 知识库 ============
class ReportInfo(BaseModel):
    """报告信息"""
    id: int
    report_type: str
    report_path: str
    summary: Optional[str]
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


class KnowledgeDocInfo(BaseModel):
    """知识库文档信息"""
    id: int
    file_name: str
    file_type: str
    file_size: Optional[int]
    chunk_count: int
    status: str
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


class DigitalHumanConfig(BaseModel):
    """数字人 SDK 公开运行配置（不含 appSecret）"""
    enabled: bool
    configured: bool
    provider: str
    app_id: Optional[str] = None
    avatar_id: str
    voice_id: str
    sdk_mode: str
    gateway_server: str
    sdk_url: str
    sdk_integrity: Optional[str] = None
    message: Optional[str] = None


# ============ 前端 SPA 契约模型（src/frontend/src/types.ts） ============

POLLUTION_LEVEL_ZH = {
    "excellent": "优",
    "good": "良",
    "moderate": "中",
    "poor": "差",
    "severe": "严重",
}

TASK_STATUS_ZH = {
    "pending": "处理中",
    "processing": "处理中",
    "completed": "已完成",
    "failed": "失败",
}

TASK_TYPE_ZH = {
    "image": "图片",
    "video": "视频",
}

REPORT_STATUS_ZH = {
    "completed": "已生成",
    "pending": "生成中",
    "processing": "生成中",
    "failed": "失败",
}

# 污染等级 → 环境质量分（演示用推导值）
POLLUTION_SCORE = {
    "excellent": 92,
    "good": 82,
    "moderate": 68,
    "poor": 48,
    "severe": 28,
}


def pollution_level_zh(level: str | None) -> str:
    """英文等级（枚举或字符串）→ 前端中文等级；空值给默认 '优'"""
    if not level:
        return "优"
    value = getattr(level, "value", level)
    return POLLUTION_LEVEL_ZH.get(str(value), str(value))


class FrontendSummary(BaseModel):
    """仪表盘统计卡片（前端 Summary），全部由 /stats/summary 从数据库聚合，无硬编码默认值"""
    totalTasks: int
    totalObjects: int
    seaAreas: int          # 监测海域数（sea_areas 表实际行数）
    monthlyGrowth: float   # 本月检出目标数较上月环比（%），上月无数据时为 0
    activeAlerts: int      # 待处置预警：近 30 天污染等级为「差/严重」的已完成任务数
    coverageKm2: float     # 监测覆盖面积 km²（sea_areas.area_km2 主数据求和）


class FrontendTrendPoint(BaseModel):
    """趋势点（前端 TrendPoint）"""
    date: str
    count: int
    density: float = 0.0


class ClassRankItem(BaseModel):
    """类别排名单项（前端 ClassRankItem）"""
    name: str  # 中文类别名
    count: int


class StatsAnalysis(BaseModel):
    """分析页聚合（前端 api.getAnalysis，全部基于已完成任务）：
    当前窗口为近 30 天，*_prev 为前 30 天（用于"较上月"环比）；材质/类别分布按近 30 天汇总。"""
    pollution_index: float = 0.0  # 综合污染指数 0-10（污染等级加权 ×2）
    pollution_index_prev: float = 0.0
    plastic_percent: float = 0.0  # 塑料类目标占已分类目标比例（%）
    plastic_percent_prev: float = 0.0
    severe_count: int = 0  # 近 30 天严重污染任务数
    severe_count_prev: int = 0
    high_risk_areas: int = 0  # 高风险监测海域数：近 30 天综合污染指数 ≥ 6 的海域个数
    high_risk_areas_prev: int = 0
    total_objects: int = 0  # 近 30 天检出垃圾总数
    material_breakdown: dict = {}  # {材质桶: 数量}，按数量降序
    class_ranking: list[ClassRankItem] = []  # 近 30 天高频类别 TOP 6


class FrontendDetectionRecord(BaseModel):
    """检测历史行（前端 DetectionRecord）"""
    id: str
    createdAt: str
    location: str
    type: str          # 图片 / 视频
    objectCount: int
    level: str         # 优/良/中/差/严重
    status: str        # 已完成 / 处理中 / 失败


class FrontendDetectionListResponse(BaseModel):
    """检测历史列表（前端 api.getHistory）"""
    items: list[FrontendDetectionRecord]
    total: int = 0


class SiteItem(BaseModel):
    """监测站点（前端 SiteInfo，GET /api/v1/sites）"""
    id: int
    code: str
    name: str
    lat: float
    lng: float
    depthM: float | None = None
    note: str | None = None


class SiteEvidence(BaseModel):
    """单条检测证据(3D场景浮窗用)"""
    taskId: int
    mediaUrl: str | None = None    # 封面: 标注图(/uploads/image_detail/..)或视频预览帧
    mediaKind: str = "image"       # image | video
    videoUrl: str | None = None    # 视频任务专属: 标注视频回放地址(逐帧画框后的 MP4)
    className: str | None = None   # 主要垃圾类别
    objectCount: int = 0
    level: str | None = None       # 优/良/中/差/严重
    at: str | None = None


class SiteStatItem(BaseModel):
    """单站点聚合（GET /api/v1/stats/sites，近 30 天已完成任务）"""
    id: int
    code: str
    name: str
    lat: float
    lng: float
    seaAreaId: int | None = None  # 所属海域 id（前端据此按海域过滤站点）
    seaAreaName: str | None = None  # 所属海域名（北戴河/秦皇岛/渤海湾）
    taskCount: int = 0
    totalObjects: int = 0
    qualityScore: int | None = None  # 水质评分 1-10 整数, 越高水质越好; 未检测过为 null(前端显示"未检测")
    lastTaskAt: str | None = None
    evidence: list[SiteEvidence] = []  # 站点最近检测证据(标注图/视频+摘要), 3D场景展示


class SeaAreaItem(BaseModel):
    """海域（GET /api/v1/stats/sea-areas）"""
    id: int
    name: str
    code: str | None = None


class FrontendDetectionBox(BaseModel):
    """单个目标框（前端 DetectionBox）"""
    id: str
    label: str          # 英文标签 trash_bottle
    labelZh: str        # 中文标签 瓶子
    confidence: float
    bbox: list[float]   # [x, y, w, h]
    material: str


class FrontendDetectionResult(BaseModel):
    """图片检测返回（前端 DetectionResult）"""
    taskId: str
    sourceWidth: int
    sourceHeight: int
    objects: list[FrontendDetectionBox]
    pollutionLevel: str  # 优/良/中/差/严重
    density: float
    qualityScore: int
    processedAt: str


class MultiImageDetectItem(BaseModel):
    """多图批量识别中的单张图片结果项"""
    success: bool
    fileName: str
    result: Optional[FrontendDetectionResult] = None
    error: Optional[str] = None


class MultiImageDetectResponse(BaseModel):
    """多图批量识别返回：每张图独立成功/失败"""
    items: list[MultiImageDetectItem]
    total: int
    successCount: int
    failCount: int


class FrontendReport(BaseModel):
    """报告卡片（前端 Report）"""
    id: str
    title: str
    area: str
    createdAt: str
    level: str           # 优/良/中/差/严重
    score: int
    objectCount: int
    status: str          # 已生成 / 生成中
    summary: str
    reportUrl: str = ""  # 可打开的 HTML 报告预览地址（GET /api/v1/reports/{id}/preview）
    seaAreaId: int | None = None    # 所属海域 id（综合报告要求同海域汇总，前端据此约束勾选）
    seaAreaName: str | None = None  # 所属海域名（北戴河/秦皇岛/渤海湾；历史报告为空）


class FrontendReportListResponse(BaseModel):
    """报告列表（前端 api.getReports）"""
    items: list[FrontendReport]
    total: int = 0


class CreateReportRequest(BaseModel):
    """前端 api.createReport：POST /api/v1/reports JSON body"""
    task_id: int
    format: str = "html"


class CreateBatchReportRequest(BaseModel):
    """前端多图批量报告：POST /api/v1/reports/batch JSON body"""
    task_ids: list[int]
    format: str = "html"


class CreateComprehensiveReportRequest(BaseModel):
    """前端综合报告：POST /api/v1/reports/comprehensive JSON body（基于勾选的报告聚合）"""
    report_ids: list[int]
    format: str = "html"


class ReportSolution(BaseModel):
    priority: str
    action: str
    owner: str
    deadline: str
    validation: str


class ReportAnalysisResponse(BaseModel):
    id: int
    report_id: int
    status: str
    summary: str
    risk_level: str
    key_findings: list[str]
    possible_causes: list[str]
    solutions: list[ReportSolution]
    follow_up_monitoring: list[str]
    evidence: list[dict]
    model_name: str | None = None
    created_at: str


class DocumentAnalysisResponse(ReportAnalysisResponse):
    doc_id: int


# ============ 前端 SPA 对话契约（api.ts streamChat） ============
class SpaChatMessage(BaseModel):
    """前端发送的单条消息"""
    role: str
    content: str


class SpaChatRequest(BaseModel):
    """前端 /api/v1/chat 请求体：{messages, stream}；兼容旧 {message, session_id}"""
    messages: list[SpaChatMessage] = []
    stream: bool = True
    session_id: Optional[str] = None
    message: Optional[str] = None  # 旧格式兼容
    report_id: Optional[int] = Field(default=None, ge=1, description="当前追问绑定的系统质量报告 ID")
    document_id: Optional[int] = Field(default=None, ge=1, description="当前追问绑定的导入知识库文档 ID")


# ============ 通知中心（铃铛） ============
class FrontendNotification(BaseModel):
    """单条通知（camelCase，与 api.ts 前端契约一致）"""
    id: int
    type: str
    title: str
    body: Optional[str] = None
    linkPage: Optional[str] = None  # history / reports
    refId: Optional[int] = None
    isRead: bool = False
    createdAt: str


class NotificationListResponse(BaseModel):
    """通知列表 + 未读数（供 SSE init 快照与 GET 列表复用）"""
    items: list[FrontendNotification]
    unreadCount: int


def to_frontend_notification(row) -> FrontendNotification:
    """把 ORM Notification 行转成前端形状（created_at 序列化为字符串）。"""
    return FrontendNotification(
        id=row.id,
        type=row.type.value if hasattr(row.type, "value") else str(row.type),
        title=row.title,
        body=row.body,
        linkPage=row.link_page,
        refId=row.ref_id,
        isRead=row.is_read,
        createdAt=row.created_at.strftime("%Y-%m-%d %H:%M:%S") if row.created_at else "",
    )
