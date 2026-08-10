"""
Pydantic 模型：API 请求 / 响应结构
=====================================
用于请求体校验和响应序列化（OpenAPI 文档也会据此生成）。
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ============ 认证 ============
class LoginRequest(BaseModel):
    """API JSON 登录请求"""
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1)


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
    """数字人 SDK 公开配置（不含 appSecret）"""
    enabled: bool
    avatar_id: str
    voice_id: str
    sdk_mode: str
    api_endpoint: str
    auth_token: str


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
    labelZh: str        # 中文标签 塑料瓶
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
