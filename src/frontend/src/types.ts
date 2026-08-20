export type PageKey =
  | 'dashboard'
  | 'detection'
  | 'history'
  | 'ocean3d'
  | 'analysis'
  | 'screen'
  | 'reports'
  | 'assistant'
  | 'knowledge'
  | 'atlas'
  | 'profile';

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

/** 监测站点分维度统计（后端 /stats/sites；无任务的站点 taskCount=0、pollutionIndex=null） */
export interface SiteStat {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  seaAreaId?: number | null;
  taskCount: number;
  totalObjects: number;
  pollutionIndex: number | null;
  lastTaskAt: string | null;
  evidence?: SiteEvidence[];
}

/** 站点检测证据（标注图/预览帧, 3D场景浮窗用） */
export interface SiteEvidence {
  taskId: number;
  mediaUrl: string | null;
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

export interface ApiErrorShape {
  detail?: string;
  message?: string;
  error?: string;
}

export interface UserInfo {
  id: number;
  username: string;
  email?: string | null;
  phone_num?: string | null;
  role: 'admin' | 'user';
  created_at?: string;
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
