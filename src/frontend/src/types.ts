export type PageKey =
  | 'dashboard'
  | 'detection'
  | 'history'
  | 'ocean3d'
  | 'analysis'
  | 'screen'
  | 'reports'
  | 'assistant'
  | 'atlas'
  | 'admin'
  | 'profile';

/** 全部业务功能模块 key（与后端 MODULE_REGISTRY 一致；profile 为全员可见的个人中心）。
 *  海洋 3D 态势按模式拆两个权限键：ocean3d_monitor（监测）/ ocean3d_science（科普），
 *  页面入口 = 拥有任一模式键（见 OCEAN3D_PAGE_KEYS）。 */
export const ALL_MODULE_KEYS = [
  'dashboard', 'ocean3d_monitor', 'ocean3d_science', 'detection', 'history', 'analysis',
  'screen', 'reports', 'assistant', 'atlas', 'admin',
] as const;

/** 海洋 3D 页面的入场权限：任一模式键即可进入该页 */
export const OCEAN3D_PAGE_KEYS = ['ocean3d_monitor', 'ocean3d_science'];

export type PollutionLevel = '优' | '良' | '中' | '差' | '严重';

export interface Summary {
  totalTasks: number;
  totalObjects: number;
  seaAreas: number;
  monthlyGrowth: number;
  activeAlerts: number;
  coverageKm2: number;
}

export interface TrendPoint {
  date: string;
  count: number;
  density: number;
}

export interface ClassRankItem {
  name: string; // 中文类别名
  count: number;
}


/** 海域（北戴河 / 秦皇岛 / 渤海湾），侧边栏全局海域下拉的数据源 */
export interface SeaArea {
  id: number;
  name: string;
  code?: string | null;
}

/** 监测站点分维度统计（后端 /stats/sites；无任务的站点 taskCount=0、qualityScore=null） */
export interface SiteStat {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  seaAreaId?: number | null;
  taskCount: number;
  totalObjects: number;
  /** 环境质量评分 1-10 整数（越高越好）；未检测过为 null（显示"未检测"） */
  qualityScore: number | null;
  lastTaskAt: string | null;
  evidence?: SiteEvidence[];
}

/** 站点检测证据（标注图/标注视频, 3D场景浮窗"检测历史"用） */
export interface SiteEvidence {
  taskId: number;
  /** 封面: 标注图或视频预览帧 */
  mediaUrl: string | null;
  /** 媒体类型: 图片任务 / 视频任务 */
  mediaKind?: 'image' | 'video';
  /** 识别后的标注视频(可回放), 无标注视频时为 null */
  videoUrl?: string | null;
  className: string | null;
  objectCount: number;
  level: string | null;
  at: string | null;
}
/** 分析页聚合数据（后端 /stats/analysis；近 30 天 vs 前 30 天环比） */
export interface StatsAnalysis {
  pollutionIndex: number; // 综合污染指数 0-10
  pollutionIndexPrev: number;
  plasticPercent: number; // 塑料类目标占比 %
  plasticPercentPrev: number;
  severeCount: number; // 高风险（严重）任务数
  severeCountPrev: number;
  totalObjects: number; // 近 30 天检出垃圾总数
  materialBreakdown: Record<string, number>; // 材质桶 → 数量
  classRanking: ClassRankItem[]; // 高频类别 TOP N
}

/** 真实海况快照（GET /api/v1/stats/marine; Open-Meteo + 后端缓存降级） */
export interface MarineInfo {
  fetchedAt: string;
  observedAt?: string | null; // 数据源观测时间(Open-Meteo本地时间, 展示用)
  waveHeightM: number | null;
  waveDirectionDeg: number | null; // 浪向来向方位角°
  wavePeriodS: number | null;
  seaTempC: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null; // 风向来向方位角°
  stale: boolean; // true=外网失败返回的旧缓存
}

export interface DetectionBox {
  id: string;
  label: string;
  labelZh: string;
  confidence: number;
  bbox: [number, number, number, number];
  material: string;
}

export interface DetectionResult {
  taskId: string;
  sourceWidth: number;
  sourceHeight: number;
  objects: DetectionBox[];
  pollutionLevel: PollutionLevel;
  density: number;
  qualityScore: number;
  processedAt: string;
}

export interface VideoTaskStatus {
  taskId: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  totalObjects: number;
  pollutionLevel?: string | null;
  processingTime?: number | null;
  previewUrl?: string | null; // 视频实时预览帧（标注图）URL
  previewUrls?: string[] | null; // 已累积的全部预览帧 URL（按场景逐张追加）
  annotatedVideoUrl?: string | null; // 逐帧画框后的标注视频（可回放）URL
  processedFrames?: number | null;
  totalFrames?: number | null;
}

export interface VideoObjectItem {
  classId: number;
  className: string; // 中文类别名
  confidence: number;
  materialType?: string | null;
  cropUrl?: string | null; // 目标裁剪缩略图 URL（视频任务才有）
}

export interface VideoDetectResult {
  taskId: number;
  taskType: string;
  fileName: string;
  status: string;
  totalObjects: number;
  pollutionLevel?: string | null;
  processingTime?: number | null;
  results: VideoObjectItem[];
  materialBreakdown: Record<string, number>;
  previewUrls?: string[] | null; // 视频：场景预览帧 URL（检测历史详情直接以 result 为准）
  annotatedVideoUrl?: string | null; // 视频：标注视频回放 URL
  mediaUrl?: string | null; // 图片：把已入库检测框画回原图的标注图 URL
}

export interface MultiImageDetectItem {
  success: boolean;
  fileName: string;
  result?: DetectionResult | null;
  error?: string | null;
}

export interface MultiImageDetectResponse {
  items: MultiImageDetectItem[];
  total: number;
  successCount: number;
  failCount: number;
}

export interface DetectionRecord {
  id: string;
  createdAt: string;
  location: string;
  type: '图片' | '视频';
  objectCount: number;
  level: PollutionLevel;
  status: '已完成' | '处理中' | '失败';
}

export interface Report {
  id: string;
  title: string;
  area: string;
  createdAt: string;
  level: PollutionLevel;
  score: number;
  objectCount: number;
  status: '已生成' | '生成中';
  summary: string;
  reportUrl?: string; // HTML 报告预览地址（GET /api/v1/reports/{id}/preview）
}

export interface ReportSolution {
  priority: string;
  action: string;
  owner: string;
  deadline: string;
  validation: string;
}

export interface ReportAnalysis {
  id: number;
  report_id: number;
  status: string;
  summary: string;
  risk_level: string;
  key_findings: string[];
  possible_causes: string[];
  solutions: ReportSolution[];
  follow_up_monitoring: string[];
  evidence: Array<{ id: string; class_name: string; confidence: number; material: string; source: string }>;
  model_name?: string | null;
  created_at: string;
  doc_id?: number;
}

/** RAG 知识库文档（后端 /api/v1/knowledge 返回形状） */
export interface KnowledgeDocInfo {
  id: number;
  file_name: string;
  file_type: string;
  file_size?: number | null;
  chunk_count: number;
  status: string;
  created_at?: string | null;
}

export interface DigitalHumanPublicConfig {
  enabled: boolean;
  configured: boolean;
  provider: string;
  app_id?: string | null;
  avatar_id: string;
  voice_id: string;
  sdk_mode: string;
  gateway_server: string;
  sdk_url: string;
  sdk_integrity?: string | null;
  message?: string | null;
}

export interface DigitalHumanCredential {
  app_id: string;
  credential: string;
  expires_in: number;
  gateway_server: string;
}
export interface ApiValidationError {
  type?: string;
  loc?: Array<string | number>;
  msg?: string;
}

export interface ApiErrorShape {
  /** FastAPI HTTPException 的 detail 是字符串；pydantic 422 校验失败时是错误数组 */
  detail?: string | ApiValidationError[];
  message?: string;
  error?: string;
}

export interface UserInfo {
  id: number;
  username: string;
  email?: string | null;
  phone_num?: string | null;
  role: 'admin' | 'user';
  group_id?: number | null;
  group_code?: string | null;
  group_name?: string | null;
  /** 拥有的功能模块 key 集合（后端按用户组实时计算） */
  permissions?: string[];
  created_at?: string;
}


// ============ 后台管理契约（/api/v1/admin/*） ============
export interface AdminUserRow {
  id: number;
  username: string;
  email?: string | null;
  phone_num?: string | null;
  role: 'admin' | 'user';
  group_id?: number | null;
  group_code?: string | null;
  group_name?: string | null;
  permissions: string[];
  created_at?: string | null;
  is_super_admin: boolean;
}

export interface AdminGroup {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  modules: string[];
  member_count: number;
  created_at?: string | null;
}

export interface AdminOverview {
  user_count: number;
  group_count: number;
  task_count: number;
  completed_task_count: number;
  report_count: number;
  group_members: AdminGroup[];
  recent_users: AdminUserRow[];
}

export interface ModuleMeta {
  key: string;
  name: string;
  desc: string;
}

export interface FaceInfo {
  id: number;
  name: string;
  created_at?: string;
}

export interface FaceLoginResult {
  access_token: string;
  username: string;
}
