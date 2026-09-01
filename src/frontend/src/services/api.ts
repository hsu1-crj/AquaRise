import { createMockDetection, mockAnalysis, mockRecords, mockReports, mockSummary, mockTrend } from '../data/mock';
import type { AdminGroup, AdminOverview, AdminUserRow, ApiErrorShape, DetectionRecord, DetectionResult, DigitalHumanCredential, DigitalHumanPublicConfig, FaceInfo, FaceLoginResult, GroupOption, GroupSwitchRequestInfo, KnowledgeDocInfo, MarineInfo, ModuleMeta, MultiImageDetectItem, MultiImageDetectResponse, ProfileStats, Report, ReportAnalysis, SeaArea, SiteStat, StatsAnalysis, Summary, TrendPoint, UserInfo, VideoDetectResult, VideoTaskStatus } from '../types';

const API_MODE = (import.meta.env.VITE_API_MODE ?? 'live') as 'mock' | 'live';
/** mock 模式视频任务的模拟进度（taskId → 已推进百分比），getVideoStatus 轮询递增 */
const mockVideoProgress = new Map<string, number>();
const wait = (ms = 450) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** 读取图片文件真实尺寸（mock 模式生成检测框需要）；失败回退默认值 */
function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth || 1280, height: img.naturalHeight || 720 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 1280, height: 720 });
    };
    img.src = url;
  });
}

/** 使用 mock 数据：构建期 VITE_API_MODE=mock */
export function isMockMode(): boolean {
  return API_MODE === 'mock';
}

export const AUTH_TOKEN_KEY = 'aquarise-token';
/** 「保持登录」勾选时 token 存 localStorage（跨浏览器重启自动登录），否则存 sessionStorage */
export const REMEMBER_FLAG_KEY = 'aquarise-remember';

/** 读取已存 token：优先「保持登录」的 localStorage，其次本次会话的 sessionStorage */
export function getStoredToken(): string | null {
  return window.localStorage.getItem(AUTH_TOKEN_KEY) ?? window.sessionStorage.getItem(AUTH_TOKEN_KEY);
}

/** 登录成功按「保持登录」选择落位 token 存储 */
export function storeToken(token: string, remember: boolean): void {
  if (remember) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    window.localStorage.setItem(REMEMBER_FLAG_KEY, '1');
    window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  } else {
    window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    window.localStorage.removeItem(REMEMBER_FLAG_KEY);
  }
}

/** 清空全部本地登录态（退出登录 / token 失效时调用） */
export function clearStoredAuth(): void {
  window.sessionStorage.removeItem('aquarise-session');
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(REMEMBER_FLAG_KEY);
}

/** 鉴权头构造：普通请求与 SSE 流式读取共用（EventSource 无法带 Authorization 头，故统一用 fetch）。 */
export function authHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** 401 说明 token 已失效（被踢下线 / 过期 / 服务端不认）：清空本地会话并回登录页。 */
function handleUnauthorized(response: Response): void {
  if (response.status !== 401) return;
  clearStoredAuth();
  window.location.reload();
}

/** 把后端错误载荷转成可读消息：HTTPException 的 detail 是字符串，
 *  pydantic 422 校验失败时是数组（如用户名格式不符），需逐项取 msg 拼接 */
function errorMessage(payload: ApiErrorShape | null, status: number): string {
  const detail = payload?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((item) => {
        const field = item.loc?.filter((part) => part !== 'body').join('.') ?? '';
        return field ? `${field}: ${item.msg ?? '格式不正确'}` : (item.msg ?? '格式不正确');
      })
      .join('；');
  }
  return payload?.message || payload?.error || `请求失败（${status}）`;
}
type RequestInitWithTimeout = RequestInit & { timeoutMs?: number };

async function request<T>(path: string, init?: RequestInitWithTimeout): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 15000);
  try {
    const response = await fetch(path, { ...init, headers: authHeaders(init), signal: init?.signal ?? controller.signal });
    if (!response.ok) {
      handleUnauthorized(response);
      let payload: ApiErrorShape | null = null;
      try { payload = await response.json() as ApiErrorShape; } catch { /* non-JSON error */ }
      throw new Error(errorMessage(payload, response.status));
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  async getDigitalHumanConfig(): Promise<DigitalHumanPublicConfig> {
    if (isMockMode()) {
      return {
        enabled: false,
        configured: false,
        provider: 'xmov',
        avatar_id: 'ocean_guardian_01',
        voice_id: 'zh_female_ocean',
        sdk_mode: 'realtime',
        gateway_server: 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session',
        sdk_url: 'https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js',
        message: '演示模式使用全息拟态。',
      };
    }
    return request<DigitalHumanPublicConfig>('/api/v1/digital-human/config');
  },

  async getDigitalHumanCredential(): Promise<DigitalHumanCredential> {
    if (isMockMode()) throw new Error('演示模式不签发数字人凭证');
    return request<DigitalHumanCredential>('/api/v1/digital-human/credential', { method: 'POST' });
  },

  async getSummary(seaAreaId?: number): Promise<Summary> {
    if (isMockMode()) { await wait(); return mockSummary; }
    const qs = seaAreaId ? `?sea_area_id=${seaAreaId}` : '';
    return request<Summary>(`/api/v1/stats/summary${qs}`);
  },

  async getTrend(period = 'month', seaAreaId?: number): Promise<TrendPoint[]> {
    if (isMockMode()) { await wait(560); return mockTrend; }
    const qs = `period=${encodeURIComponent(period)}${seaAreaId ? `&sea_area_id=${seaAreaId}` : ''}`;
    const payload = await request<{ items?: TrendPoint[] } | TrendPoint[]>(`/api/v1/stats/trend?${qs}`);
    return Array.isArray(payload) ? payload : payload.items ?? [];
  },
  /** 分析页聚合数据：综合污染指数 / 材质分布 / 高频类别排名（Analysis 与 Dashboard 共用）。
   * 后端返回 snake_case，需显式映射为 camelCase（与 getSummary/getVideoStatus 一致）。 */
  async getAnalysis(seaAreaId?: number): Promise<StatsAnalysis> {
    if (isMockMode()) { await wait(500); return mockAnalysis; }
    const qs = seaAreaId ? `?sea_area_id=${seaAreaId}` : '';
    const response = await request<{
      pollution_index: number; pollution_index_prev: number;
      plastic_percent: number; plastic_percent_prev: number;
      severe_count: number; severe_count_prev: number;
      high_risk_areas: number; high_risk_areas_prev: number;
      total_objects: number;
      material_breakdown: Record<string, number>;
      class_ranking: { name: string; count: number }[];
    }>(`/api/v1/stats/analysis${qs}`);
    return {
      pollutionIndex: response.pollution_index,
      pollutionIndexPrev: response.pollution_index_prev,
      plasticPercent: response.plastic_percent,
      plasticPercentPrev: response.plastic_percent_prev,
      severeCount: response.severe_count,
      severeCountPrev: response.severe_count_prev,
      highRiskAreas: response.high_risk_areas,
      highRiskAreasPrev: response.high_risk_areas_prev,
      totalObjects: response.total_objects,
      materialBreakdown: response.material_breakdown ?? {},
      classRanking: response.class_ranking ?? [],
    };
  },

  async getHistory(page = 1, pageSize = 50, filters?: { level?: string; query?: string }): Promise<{ items: DetectionRecord[]; total: number }> {
    if (isMockMode()) { await wait(); return { items: mockRecords, total: mockRecords.length }; }
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (filters?.level && filters.level !== '全部等级') params.set('level', filters.level);
    if (filters?.query?.trim()) params.set('query', filters.query.trim());
    return request<{ items: DetectionRecord[]; total: number }>(`/api/v1/detections?${params.toString()}`);
  },
  /** 海域列表（北戴河/秦皇岛/渤海湾）：侧边栏全局海域下拉的数据源 */
  async getSeaAreas(): Promise<SeaArea[]> {
    if (isMockMode()) { await wait(300); return [
      { id: 1, name: '北戴河', code: 'BDH' },
      { id: 2, name: '秦皇岛', code: 'QHD' },
      { id: 3, name: '渤海湾', code: 'BHB' },
    ]; }
    return request<SeaArea[]>('/api/v1/stats/sea-areas');
  },
  /** 监测站点列表（含近30天聚合；上传下拉与海域对比图共用同一端点） */
  async getSiteStats(): Promise<SiteStat[]> {
    if (isMockMode()) { await wait(400); return []; }
    return request<SiteStat[]>('/api/v1/stats/sites');
  },
  /** 真实海况（Open-Meteo 抓取 + 后端缓存, 外网失败返回旧缓存 stale=true）; 带坐标按站点取数 */
  async getMarine(lat?: number, lng?: number): Promise<MarineInfo> {
    if (isMockMode()) {
      await wait(350);
      return {
        fetchedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        observedAt: new Date(Date.now() - 600000).toTimeString().slice(0, 5),
        waveHeightM: 1.2, waveDirectionDeg: 135, wavePeriodS: 5.4,
        seaTempC: 26.8, windSpeedMs: 5.6, windDirectionDeg: 128, stale: false,
      };
    }
    const qs = lat != null && lng != null ? `?lat=${lat}&lng=${lng}` : '';
    const r = await request<{
      fetched_at: string; observed_time: string | null;
      wave_height: number | null; wave_direction: number | null;
      wave_period: number | null; sea_surface_temperature: number | null;
      wind_speed: number | null; wind_direction: number | null; stale: boolean;
    }>(`/api/v1/stats/marine${qs}`);
    return {
      fetchedAt: r.fetched_at,
      observedAt: r.observed_time,
      waveHeightM: r.wave_height,
      waveDirectionDeg: r.wave_direction,
      wavePeriodS: r.wave_period,
      seaTempC: r.sea_surface_temperature,
      windSpeedMs: r.wind_speed,
      windDirectionDeg: r.wind_direction,
      stale: r.stale,
    };
  },

  async getReports(): Promise<Report[]> {
    if (isMockMode()) { await wait(); return mockReports; }
    const payload = await request<{ items: Report[] }>('/api/v1/reports/?page=1&page_size=50');
    return payload.items;
  },
  async deleteReport(reportId: string): Promise<void> {
    if (isMockMode()) { await wait(); return; }
    // reportId 形如 RPT-<id>，转为纯数字路径参数
    const numId = reportId.replace(/^RPT-/i, '');
    await request(`/api/v1/reports/${numId}`, { method: 'DELETE' });
  },
  async analyzeReport(reportId: string | number): Promise<ReportAnalysis> {
    const id = String(reportId).replace(/^RPT-/, '');
    return request<ReportAnalysis>(`/api/v1/reports/${encodeURIComponent(id)}/analyze`, { method: 'POST' });
  },
  async getReportAnalysis(reportId: string | number): Promise<ReportAnalysis> {
    const id = String(reportId).replace(/^RPT-/, '');
    return request<ReportAnalysis>(`/api/v1/reports/${encodeURIComponent(id)}/analysis`);
  },
  /** 拉取报告的完整 HTML 内容（对应报告 preview 接口，用于下载成 .html 文件） */
  async getReportHtml(reportId: string): Promise<string> {
    if (isMockMode()) { return ''; }
    const numId = reportId.replace(/^RPT-/i, '');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/v1/reports/${numId}/preview`, { headers: authHeaders(), signal: controller.signal });
      if (!response.ok) {
        handleUnauthorized(response);
        throw new Error(`报告内容获取失败（${response.status}）`);
      }
      return await response.text();
    } finally {
      window.clearTimeout(timeout);
    }
  },
  async detectImage(file: File, width: number, height: number, siteId?: number): Promise<DetectionResult> {
    if (isMockMode()) { await wait(1300); return createMockDetection(width, height); }
    const form = new FormData();
    form.append('file', file);
    form.append('width', String(width));
    form.append('height', String(height));
    if (siteId) form.append('site_id', String(siteId));
    return request<DetectionResult>('/api/v1/detect/image', { method: 'POST', body: form, timeoutMs: 300000 });
  },

  /** 批量识别多张图片：每张图独立返回结果（单张失败不影响其余）；siteId 整批共用 */
  async detectImages(files: File[], onProgress?: (current: number, total: number) => void, siteId?: number): Promise<MultiImageDetectResponse> {
    if (isMockMode()) {
      const items: MultiImageDetectItem[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const size = await readImageSize(files[i]);
        await wait(600);
        items.push({ success: true, fileName: files[i].name, result: createMockDetection(size.width, size.height) });
        onProgress?.(i + 1, files.length);
      }
      return { items, total: files.length, successCount: items.length, failCount: 0 };
    }
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    if (siteId) form.append('site_id', String(siteId));
    return request<MultiImageDetectResponse>('/api/v1/detect/images', { method: 'POST', body: form, timeoutMs: 600000 });
  },

  async createVideoTask(file: File, siteId?: number): Promise<{ taskId: string }> {
    if (isMockMode()) { await wait(700); return { taskId: `VID-${Date.now().toString().slice(-8)}` }; }
    const form = new FormData();
    form.append('file', file);
    if (siteId) form.append('site_id', String(siteId));
    const response = await request<{ task_id?: string; taskId?: string }>('/api/v1/detect/video', { method: 'POST', body: form, timeoutMs: 600000 });
    return { taskId: response.taskId ?? response.task_id ?? '' };
  },

  /** 查询视频任务实时进度：轮询返回 progress / previewUrl / 帧数，驱动实时可视化 */
  async getVideoStatus(taskId: string | number): Promise<VideoTaskStatus> {
    if (isMockMode()) {
      await wait(500);
      // 模拟后台逐帧处理：按轮询推进进度直至完成（修复恒卡 55% 永不完成）
      const key = String(taskId);
      const progress = Math.min(100, (mockVideoProgress.get(key) ?? 0) + 15);
      mockVideoProgress.set(key, progress);
      const done = progress >= 100;
      return { taskId: Number(taskId), status: done ? 'completed' : 'processing', progress, totalObjects: 0 };
    }
    const response = await request<{
      task_id: number; status: string; progress: number; total_objects: number;
      pollution_level?: string | null; processing_time?: number | null;
      preview_url?: string | null; preview_urls?: string[] | null;
      annotated_video_url?: string | null;
      processed_frames?: number | null; total_frames?: number | null;
    }>(`/api/v1/detect/status/${taskId}`, { timeoutMs: 60000 });
    return {
      taskId: response.task_id,
      status: response.status as VideoTaskStatus['status'],
      progress: response.progress,
      totalObjects: response.total_objects,
      pollutionLevel: response.pollution_level,
      processingTime: response.processing_time,
      previewUrl: response.preview_url,
      previewUrls: response.preview_urls ?? [],
      annotatedVideoUrl: response.annotated_video_url ?? null,
      processedFrames: response.processed_frames,
      totalFrames: response.total_frames,
    };
  },

  /** 查询视频检测结果：去重后的垃圾目标列表 + 材质汇总（/detect/result） */
  async getVideoResult(taskId: string | number): Promise<VideoDetectResult> {
    if (isMockMode()) {
      await wait(400);
      return { taskId: Number(taskId), taskType: 'video', fileName: '', status: 'completed', totalObjects: 0, results: [], materialBreakdown: {} };
    }
    const response = await request<{
      task_id: number; task_type: string; file_name: string; status: string; total_objects: number;
      pollution_level?: string | null; processing_time?: number | null; material_breakdown: Record<string, number>;
      annotated_video_url?: string | null; preview_urls?: string[] | null; media_url?: string | null;
      results: {
        class_id: number; class_name: string; confidence: number;
        bbox_x1?: number | null; bbox_y1?: number | null; bbox_x2?: number | null; bbox_y2?: number | null;
        material_type?: string | null; crop_url?: string | null;
      }[];
    }>(`/api/v1/detect/result/${taskId}`, { timeoutMs: 60000 });
    return {
      taskId: response.task_id,
      taskType: response.task_type,
      fileName: response.file_name,
      status: response.status,
      totalObjects: response.total_objects,
      pollutionLevel: response.pollution_level,
      processingTime: response.processing_time,
      materialBreakdown: response.material_breakdown ?? {},
      previewUrls: response.preview_urls ?? null,
      annotatedVideoUrl: response.annotated_video_url ?? null,
      mediaUrl: response.media_url ?? null,
      results: (response.results ?? []).map((r) => ({
        classId: r.class_id,
        className: r.class_name,
        confidence: r.confidence,
        materialType: r.material_type ?? null,
        cropUrl: r.crop_url ?? null,
      })),
    };
  },

  async createReport(taskId: string): Promise<Report> {
    if (isMockMode()) { await wait(900); return mockReports[0]; }
    return request<Report>('/api/v1/reports/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, format: 'html' }),
    });
  },

  /** 多图批量报告：基于多张图片的检测任务聚合生成一份报告 */
  async createBatchReport(taskIds: string[]): Promise<Report> {
    if (isMockMode()) { await wait(900); return mockReports[0]; }
    return request<Report>('/api/v1/reports/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: taskIds.map(Number), format: 'html' }),
    });
  },

  /** 综合报告：基于勾选的若干份已有报告，聚合生成一份综合质量评估报告 */
  async createComprehensiveReport(reportIds: number[]): Promise<Report> {
    if (isMockMode()) { await wait(900); return mockReports[0]; }
    return request<Report>('/api/v1/reports/comprehensive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_ids: reportIds, format: 'html' }),
    });
  },

  async getCurrentUser(): Promise<UserInfo> {
    if (isMockMode()) {
      await wait(200);
      // 演示模式：以超级管理员身份进入（全量模块），便于展示全部页面与后台
      return {
        id: 1, username: '林海', email: 'linhai@aquarise.local', role: 'admin',
        permissions: ['dashboard', 'ocean3d_monitor', 'ocean3d_science', 'detection', 'history', 'analysis', 'screen', 'reports', 'assistant', 'atlas', 'admin'],
      };
    }
    return request<UserInfo>('/api/v1/auth/me');
  },

  async changePassword(oldPassword: string, newPassword: string): Promise<string> {
    const payload = await request<{ message: string }>('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    return payload.message;
  },

  async updateProfile(data: { email?: string | null; phoneNum?: string | null }): Promise<UserInfo> {
    return request<UserInfo>('/api/v1/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: data.email?.trim() || null,
        phone_num: data.phoneNum?.trim() || null,
      }),
    });
  },
  /** 个人中心头像卡三项统计（参与项目/创建任务/生成报告，按当前账号真实统计） */
  async getProfileStats(): Promise<ProfileStats> {
    if (isMockMode()) { await wait(200); return { project_count: 2, task_count: mockRecords.length, report_count: mockReports.length }; }
    return request<ProfileStats>('/api/v1/auth/stats');
  },

  /** 可申请的用户组列表（含各组功能模块中文名；排除超级管理员组） */
  async getPublicGroups(): Promise<GroupOption[]> {
    if (isMockMode()) {
      await wait(200);
      return MOCK_GROUPS.filter((g) => g.code !== 'super_admin').map((g) => ({
        id: g.id, code: g.code, name: g.name, description: g.description ?? null,
        modules: g.modules,
        module_names: g.modules.map((key) => MOCK_MODULES.find((m) => m.key === key)?.name ?? key),
      }));
    }
    const payload = await request<{ items: GroupOption[] }>('/api/v1/auth/groups');
    return payload.items;
  },

  /** 我的换组申请（最新 5 条，个人中心展示审批进度） */
  async getMyGroupRequests(): Promise<GroupSwitchRequestInfo[]> {
    if (isMockMode()) { await wait(200); return []; }
    const payload = await request<{ items: GroupSwitchRequestInfo[] }>('/api/v1/auth/group-requests/mine');
    return payload.items;
  },

  /** 提交换组申请（普通用户；最高管理员审批后生效） */
  async requestGroupSwitch(groupId: number, reason: string): Promise<GroupSwitchRequestInfo> {
    if (isMockMode()) {
      await wait(400);
      const group = MOCK_GROUPS.find((g) => g.id === groupId) ?? MOCK_GROUPS[3];
      return { id: Date.now(), to_group_id: group.id, to_group_name: group.name, reason: reason || null, status: 'pending', created_at: new Date().toISOString() };
    }
    return request<GroupSwitchRequestInfo>('/api/v1/auth/group-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, reason: reason.trim() || null }),
    });
  },

  /** 录入人脸（个人中心）：multipart 上传照片，一个账号最多 3 张。
   * 超时放宽到 120s：服务端 InsightFace 首次调用含模型加载（可达数十秒），
   * 15s 默认超时会在"实际已录入成功"后误报请求超时。 */
  async enrollFace(file: File, name?: string): Promise<FaceInfo> {
    const form = new FormData();
    form.append('file', file);
    if (name?.trim()) form.append('name', name.trim());
    return request<FaceInfo>('/api/v1/auth/face/enroll', { method: 'POST', body: form, timeoutMs: 120000 });
  },

  /** 当前账号已录入人脸列表 */
  async listFaces(): Promise<FaceInfo[]> {
    const payload = await request<{ items: FaceInfo[] }>('/api/v1/auth/face/list');
    return payload.items;
  },

  /** 删除某条已录入人脸 */
  async deleteFace(id: number): Promise<{ message: string }> {
    return request<{ message: string }>(`/api/v1/auth/face/${id}`, { method: 'DELETE' });
  },

  /** 回看已录入的人脸照片（仅本人，返回 data URL） */
  async getFacePhoto(faceId: number): Promise<string> {
    const payload = await request<{ dataUrl: string }>(`/api/v1/auth/face/${faceId}/photo`);
    return payload.dataUrl;
  },

  /** 人脸识别登录：账号（用户名/手机号/邮箱）+ 人脸双因子；超时同录入放宽 */
  async faceLogin(file: File, account: string): Promise<FaceLoginResult> {
    const form = new FormData();
    form.append('file', file);
    form.append('account', account.trim());
    return request<FaceLoginResult>('/api/v1/auth/face/login', { method: 'POST', body: form, timeoutMs: 120000 });
  },

  /** 上传文档到 RAG 知识库（海洋守护者「导入质量分析报告」），返回入库后的文档记录 */
  async uploadKnowledgeDoc(file: File): Promise<KnowledgeDocInfo> {
    const form = new FormData();
    form.append('file', file);
    return request<KnowledgeDocInfo>('/api/v1/knowledge/upload', { method: 'POST', body: form });
  },

  /** 删除知识库文档（磁盘文件与向量分片一并移除） */
  async deleteKnowledgeDoc(docId: number): Promise<{ message: string }> {
    return request<{ message: string }>(`/api/v1/knowledge/${docId}`, { method: 'DELETE' });
  },
  async analyzeKnowledgeDoc(docId: number): Promise<ReportAnalysis> {
    return request<ReportAnalysis>(`/api/v1/knowledge/${docId}/analyze`, { method: 'POST' });
  },
};

export interface ChatMessagePayload { role: 'system' | 'user' | 'assistant'; content: string }

/** 拉取指定会话的对话历史（同一用户自己的记录，按时间正序） */
export async function getChatHistory(sessionId: string): Promise<ChatMessagePayload[]> {
  if (isMockMode()) { await wait(220); return []; }
  const payload = await request<ChatMessagePayload[]>(
    `/api/v1/chat/history?session_id=${encodeURIComponent(sessionId)}`,
  );
  return Array.isArray(payload) ? payload : [];
}

export interface SuggestionItem {
  /** 建议的问题文本（后端已保证知识库可答） */
  question: string;
  /** 证据来源文档名，用于悬浮提示 */
  sourceDoc: string;
}

/**
 * 证据锚定的"建议追问"：只展示知识库确实能答的问题。
 * 后端会按当前话题检索加权、过滤超纲黑名单并排除本会话已问过的问题；
 * 返回空数组表示本轮不展示追问区（宁缺毋滥，绝不用旧静态池凑数）。
 */
export async function getSuggestions(sessionId: string, context: string, limit = 3): Promise<SuggestionItem[]> {
  // 演示/离线模式没有对话链路，直接不展示追问区
  if (isMockMode()) return [];
  const params = new URLSearchParams({
    session_id: sessionId,
    context: context.slice(0, 400),
    limit: String(limit),
  });
  const payload = await request<SuggestionItem[]>(`/api/v1/chat/suggestions?${params.toString()}`, { timeoutMs: 8000 });
  return Array.isArray(payload) ? payload : [];
}

export async function streamChat(
  messages: ChatMessagePayload[],
  sessionId: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
  context?: { reportId?: number | null; documentId?: number | null },
): Promise<void> {
  if (isMockMode()) {
    const reply = '从监测数据看，建议优先处理废弃渔网与大型塑料制品：它们会造成持续缠绕风险，并进一步碎化为微塑料。可先由 ROV 标记坐标和深度，再制定分区打捞路线；作业后复测垃圾密度，并将前后数据纳入质量报告。';
    for (const char of reply) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await wait(18);
      onChunk(char);
    }
    return;
  }

  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: authHeaders({ headers: { 'Content-Type': 'application/json' } }),
    body: JSON.stringify({
      messages,
      stream: true,
      session_id: sessionId,
      report_id: context?.reportId ?? undefined,
      document_id: context?.documentId ?? undefined,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    handleUnauthorized(response);
    throw new Error(`对话服务不可用（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;
  let receivedContent = false;

  // SSE 事件可能以 LF 或 CRLF 分隔。只接受后端约定的 JSON data 事件，
  // 协议注释/未知 payload 不能悄悄变成用户可见正文。
  const consumeEvent = (event: string): void => {
    if (doneSeen) return;
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') {
      doneSeen = true;
      if (!receivedContent) throw new Error('AI 助手未返回有效内容');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error('AI 助手返回了无效的流式数据');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AI 助手返回了无效的流式数据');
    }

    const record = parsed as {
      content?: unknown;
      delta?: { content?: unknown } | null;
      thinking?: unknown;
      error?: unknown;
    };
    if (record.error) throw new Error(String(record.error));

    const hasContent = Object.prototype.hasOwnProperty.call(record, 'content');
    const hasDeltaContent = Boolean(
      record.delta &&
      typeof record.delta === 'object' &&
      Object.prototype.hasOwnProperty.call(record.delta, 'content'),
    );
    const hasThinking = Object.prototype.hasOwnProperty.call(record, 'thinking');
    if (!hasContent && !hasDeltaContent && !hasThinking) {
      throw new Error('AI 助手返回了无效的流式数据');
    }

    let part = '';
    if (hasContent) {
      if (typeof record.content !== 'string') throw new Error('AI 助手返回了无效的流式数据');
      part = record.content;
    } else if (hasDeltaContent) {
      if (typeof record.delta?.content !== 'string') throw new Error('AI 助手返回了无效的流式数据');
      part = record.delta.content;
    }
    // thinking 字段只作为“无可见正文”的合法事件处理，绝不展示思维内容。
    if (!part.trim()) return;
    receivedContent = true;
    onChunk(part);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      consumeEvent(event);
      if (doneSeen) return;
    }
  }

  // TextDecoder(stream=true) 会保留未完成的 UTF-8 字节；必须 flush，
  // 同时处理没有以空行结尾的最后一个 SSE 事件。
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  if (!doneSeen) throw new Error('AI 助手流式响应未正常结束');
  if (!receivedContent) throw new Error('AI 助手未返回有效内容');
}

// ============ 后台管理 API（/api/v1/admin/*，要求「后台管理」模块权限） ============

const MOCK_GROUPS: AdminGroup[] = [
  { id: 1, code: 'super_admin', name: '超级管理员', description: '拥有全部功能模块与后台管理权限（系统内置，权限不可修改）', is_system: true, member_count: 1, modules: ['dashboard', 'ocean3d_monitor', 'ocean3d_science', 'detection', 'history', 'analysis', 'screen', 'reports', 'assistant', 'atlas', 'admin'] },
  { id: 2, code: 'analyst', name: '监测分析组', description: '一线监测与识别检测：垃圾识别、历史回溯、污染分析、报告产出（3D 锁监测模式）', is_system: true, member_count: 2, modules: ['dashboard', 'ocean3d_monitor', 'detection', 'history', 'analysis', 'reports', 'assistant'] },
  { id: 3, code: 'commander', name: '指挥决策组', description: '管理决策视角：态势研判、指挥大屏与质量报告（3D 锁监测模式）', is_system: true, member_count: 1, modules: ['dashboard', 'ocean3d_monitor', 'analysis', 'screen', 'reports', 'assistant'] },
  { id: 4, code: 'public', name: '科普访客组', description: '公众科普视角：3D 海洋科普与灭绝生物知识库（3D 锁科普模式；自助注册默认组）', is_system: true, member_count: 3, modules: ['ocean3d_science', 'atlas', 'assistant'] },
];

const MOCK_ADMIN_USERS: AdminUserRow[] = [
  { id: 1, username: 'admin', email: 'admin@aquarise.local', phone_num: null, role: 'admin', group_id: 1, group_code: 'super_admin', group_name: '超级管理员', permissions: MOCK_GROUPS[0].modules, created_at: '2026-07-01 09:00:00', is_super_admin: true },
  { id: 2, username: '监测员小赵', email: 'zhao@aquarise.local', phone_num: '13800000002', role: 'user', group_id: 2, group_code: 'analyst', group_name: '监测分析组', permissions: MOCK_GROUPS[1].modules, created_at: '2026-08-02 14:20:00', is_super_admin: false },
  { id: 3, username: '决策员老钱', email: null, phone_num: '13800000003', role: 'user', group_id: 3, group_code: 'commander', group_name: '指挥决策组', permissions: MOCK_GROUPS[2].modules, created_at: '2026-08-20 10:12:00', is_super_admin: false },
  { id: 4, username: '访客小孙', email: 'sun@example.com', phone_num: null, role: 'user', group_id: 4, group_code: 'public', group_name: '科普访客组', permissions: MOCK_GROUPS[3].modules, created_at: '2026-08-26 19:40:00', is_super_admin: false },
];

const MOCK_MODULES: ModuleMeta[] = [
  { key: 'dashboard', name: '态势总览', desc: '海域污染态势仪表盘' },
  { key: 'ocean3d_monitor', name: '海洋 3D · 监测模式', desc: '3D 态势监测：真实站点数据 + 实时检测联动 + 扩散推演' },
  { key: 'ocean3d_science', name: '海洋 3D · 科普模式', desc: '3D 科普体验：垃圾沉降演示 + 知识漂流瓶 + 数字人导游' },
  { key: 'detection', name: '智能识别', desc: '水下垃圾图片/视频识别检测' },
  { key: 'history', name: '检测历史', desc: '历史检测任务查询与详情' },
  { key: 'analysis', name: '污染分析', desc: '污染指数与材质分布研判' },
  { key: 'screen', name: '指挥大屏', desc: '全屏指挥调度大屏' },
  { key: 'reports', name: '质量报告', desc: '海域污染质量报告生成与管理' },
  { key: 'assistant', name: '海洋守护者', desc: '数字人智能问答助手' },
  { key: 'atlas', name: '海瞳 · 生命图谱', desc: '灭绝海洋生物 3D 知识库' },
  { key: 'admin', name: '后台管理', desc: '用户/用户组与权限管理' },
];

export const adminApi = {
  /** 功能模块注册表（用户组编辑页的矩阵数据源） */
  async getModules(): Promise<ModuleMeta[]> {
    if (isMockMode()) { await wait(120); return MOCK_MODULES; }
    const payload = await request<{ items: ModuleMeta[] }>('/api/v1/admin/modules');
    return payload.items;
  },
  async getOverview(): Promise<AdminOverview> {
    if (isMockMode()) {
      await wait(300);
      return {
        user_count: MOCK_ADMIN_USERS.length, group_count: MOCK_GROUPS.length,
        task_count: 46, completed_task_count: 42, report_count: 12,
        group_members: MOCK_GROUPS, recent_users: MOCK_ADMIN_USERS.slice().reverse(),
      };
    }
    return request<AdminOverview>('/api/v1/admin/overview');
  },

  async getUsers(params: { page?: number; pageSize?: number; query?: string; groupId?: number } = {}): Promise<{ items: AdminUserRow[]; total: number }> {
    if (isMockMode()) {
      await wait(250);
      const kw = (params.query ?? '').trim().toLowerCase();
      const items = MOCK_ADMIN_USERS.filter((u) =>
        (!kw || u.username.toLowerCase().includes(kw) || (u.email ?? '').toLowerCase().includes(kw))
        && (!params.groupId || u.group_id === params.groupId));
      return { items, total: items.length };
    }
    const qs = new URLSearchParams({ page: String(params.page ?? 1), page_size: String(params.pageSize ?? 20) });
    if (params.query?.trim()) qs.set('query', params.query.trim());
    if (params.groupId) qs.set('group_id', String(params.groupId));
    return request<{ items: AdminUserRow[]; total: number }>(`/api/v1/admin/users?${qs.toString()}`);
  },

  async createUser(payload: { username: string; password: string; email?: string | null; phone_num?: string | null; group_id: number }): Promise<AdminUserRow> {
    if (isMockMode()) {
      await wait(400);
      const group = MOCK_GROUPS.find((g) => g.id === payload.group_id) ?? MOCK_GROUPS[3];
      return { id: Date.now(), username: payload.username, email: payload.email ?? null, phone_num: payload.phone_num ?? null, role: 'user', group_id: group.id, group_code: group.code, group_name: group.name, permissions: group.modules, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), is_super_admin: false };
    }
    return request<AdminUserRow>('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async updateUser(userId: number, payload: { group_id?: number; email?: string | null; phone_num?: string | null }): Promise<AdminUserRow> {
    if (isMockMode()) { await wait(300); const u = MOCK_ADMIN_USERS.find((x) => x.id === userId); if (!u) throw new Error('用户不存在'); Object.assign(u, payload); return u; }
    return request<AdminUserRow>(`/api/v1/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async resetPassword(userId: number, newPassword: string): Promise<{ message: string }> {
    if (isMockMode()) { await wait(350); return { message: '已重置密码（演示）' }; }
    return request<{ message: string }>(`/api/v1/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPassword }),
    });
  },

  /** 注销账号（后端保护：不能注销自己；最高管理员账号不可注销） */
  async deleteUser(userId: number): Promise<{ message: string }> {
    if (isMockMode()) { await wait(350); return { message: '已注销（演示）' }; }
    return request<{ message: string }>(`/api/v1/admin/users/${userId}`, { method: 'DELETE' });
  },

  async getGroups(): Promise<AdminGroup[]> {
    if (isMockMode()) { await wait(250); return MOCK_GROUPS; }
    const payload = await request<{ items: AdminGroup[] }>('/api/v1/admin/groups');
    return payload.items;
  },

  async createGroup(payload: { name: string; code?: string; description?: string | null; modules: string[] }): Promise<AdminGroup> {
    if (isMockMode()) { await wait(400); return { id: Date.now(), code: payload.code ?? `g_${Date.now().toString(36)}`, name: payload.name, description: payload.description ?? null, is_system: false, modules: payload.modules, member_count: 0 }; }
    return request<AdminGroup>('/api/v1/admin/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async updateGroup(groupId: number, payload: { name?: string; description?: string | null; modules?: string[] }): Promise<AdminGroup> {
    if (isMockMode()) { await wait(300); const g = MOCK_GROUPS.find((x) => x.id === groupId); if (!g) throw new Error('用户组不存在'); Object.assign(g, payload); return g; }
    return request<AdminGroup>(`/api/v1/admin/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async deleteGroup(groupId: number): Promise<{ message: string }> {
    if (isMockMode()) { await wait(300); return { message: '已删除（演示）' }; }
    return request<{ message: string }>(`/api/v1/admin/groups/${groupId}`, { method: 'DELETE' });
  },
  /** 换组申请列表（默认待审批；status=all 取全部） */
  async getGroupRequests(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending'): Promise<GroupSwitchRequestInfo[]> {
    if (isMockMode()) { await wait(250); return []; }
    const payload = await request<{ items: GroupSwitchRequestInfo[] }>(`/api/v1/admin/group-requests?status=${status}`);
    return payload.items;
  },

  /** 批准换组申请：申请人即刻调入目标组 */
  async approveGroupRequest(requestId: number): Promise<{ message: string }> {
    if (isMockMode()) { await wait(300); return { message: '已批准（演示）' }; }
    return request<{ message: string }>(`/api/v1/admin/group-requests/${requestId}/approve`, { method: 'POST' });
  },

  /** 驳回换组申请：申请人分组不变 */
  async rejectGroupRequest(requestId: number): Promise<{ message: string }> {
    if (isMockMode()) { await wait(300); return { message: '已驳回（演示）' }; }
    return request<{ message: string }>(`/api/v1/admin/group-requests/${requestId}/reject`, { method: 'POST' });
  },
};
