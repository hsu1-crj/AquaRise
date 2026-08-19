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


class TokenResponse(BaseModel):
    """登录成功返回的 JWT"""
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    """用户信息"""
    id: int
    username: str
    email: Optional[str]
    phone_num: Optional[str]
    role: str
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


class ChangePasswordRequest(BaseModel):
    """个人中心修改密码"""
    old_password: str = Field(min_length=1)
    new_password: str = Field(min_length=6)


class ProfileUpdateRequest(BaseModel):
    """个人中心更新资料（电子邮箱 / 手机号）"""
    email: Optional[str] = Field(default=None, max_length=100)
    phone_num: Optional[str] = Field(default=None, max_length=20)


class MessageResponse(BaseModel):
    """通用操作成功消息"""
    message: str


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
    """仪表盘统计卡片（前端 Summary）"""
    totalTasks: int
    totalObjects: int
    seaAreas: int = 28
    monthlyGrowth: float = 18.6
    activeAlerts: int = 3
    coverageKm2: float = 126.8


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
    severe_count: int = 0  # 近 30 天严重污染任务数（高风险监测点）
    severe_count_prev: int = 0
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
