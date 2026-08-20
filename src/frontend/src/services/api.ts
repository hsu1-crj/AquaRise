import { createMockDetection, mockAnalysis, mockRecords, mockReports, mockSummary, mockTrend } from '../data/mock';
import type { ApiErrorShape, DetectionRecord, DetectionResult, DigitalHumanPublicConfig, KnowledgeDocInfo, MarineInfo, MultiImageDetectItem, MultiImageDetectResponse, Report, SeaArea, SiteStat, StatsAnalysis, Summary, TrendPoint, UserInfo, VideoDetectResult, VideoTaskStatus } from '../types';

const API_MODE = (import.meta.env.VITE_API_MODE ?? 'live') as 'mock' | 'live';
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

/** 演示模式标记 key（免认证进入项目演示时写入；随 clearStoredAuth 一并清除） */
export const DEMO_FLAG_KEY = 'aquarise-demo';

/** 是否处于演示模式：免认证进入，全站使用 mock 数据 */
export function isDemoMode(): boolean {
  return window.sessionStorage.getItem(DEMO_FLAG_KEY) === '1';
}

/** 使用 mock 数据：构建期 VITE_API_MODE=mock，或运行时进入演示模式 */
export function isMockMode(): boolean {
  return API_MODE === 'mock' || isDemoMode();
}

/** 进入演示模式：会话级标记，仅当前标签页有效 */
export function enterDemoMode(): void {
  window.sessionStorage.setItem(DEMO_FLAG_KEY, '1');
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
  window.sessionStorage.removeItem(DEMO_FLAG_KEY);
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(REMEMBER_FLAG_KEY);
}

function authHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** 401 说明 token 已失效（被踢下线 / 过期 / 服务端不认）：清空本地会话并回登录页。
 *  演示模式无 token、不请求真实接口，豁免此处理避免被弹回登录页。 */
function handleUnauthorized(response: Response): void {
  if (response.status !== 401 || isDemoMode()) return;
  clearStoredAuth();
  window.location.reload();
}


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...init, headers: authHeaders(init), signal: init?.signal ?? controller.signal });
    if (!response.ok) {
      handleUnauthorized(response);
      let payload: ApiErrorShape | null = null;
      try { payload = await response.json() as ApiErrorShape; } catch { /* non-JSON error */ }
      throw new Error(payload?.detail || payload?.message || payload?.error || `请求失败（${response.status}）`);
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
        sdk_integrity: 'sha384-x6JED2qbmbCu3552Jzvj9Egb2FvDrnE2hoPUxupzkFphjuoGadVjKQupOjL3sWtu',
        message: '演示模式使用全息拟态。',
      };
    }
    return request<DigitalHumanPublicConfig>('/api/v1/digital-human/config');
  },

  async getSummary(): Promise<Summary> {
    if (isMockMode()) { await wait(); return mockSummary; }
    return request<Summary>('/api/v1/stats/summary');
  },

  async getTrend(period = 'month'): Promise<TrendPoint[]> {
    if (isMockMode()) { await wait(560); return mockTrend; }
    const payload = await request<{ items?: TrendPoint[] } | TrendPoint[]>(`/api/v1/stats/trend?period=${encodeURIComponent(period)}`);
    return Array.isArray(payload) ? payload : payload.items ?? [];
  },

  /** 分析页聚合数据：综合污染指数 / 材质分布 / 高频类别排名（Analysis 与 Dashboard 共用）。
   * 后端返回 snake_case，需显式映射为 camelCase（与 getSummary/getVideoStatus 一致）。 */
  async getAnalysis(): Promise<StatsAnalysis> {
    if (isMockMode()) { await wait(500); return mockAnalysis; }
    const response = await request<{
      pollution_index: number; pollution_index_prev: number;
      plastic_percent: number; plastic_percent_prev: number;
      severe_count: number; severe_count_prev: number;
      total_objects: number;
      material_breakdown: Record<string, number>;
      class_ranking: { name: string; count: number }[];
    }>('/api/v1/stats/analysis');
    return {
      pollutionIndex: response.pollution_index,
      pollutionIndexPrev: response.pollution_index_prev,
      plasticPercent: response.plastic_percent,
      plasticPercentPrev: response.plastic_percent_prev,
      severeCount: response.severe_count,
      severeCountPrev: response.severe_count_prev,
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
  /** 真实海况（Open-Meteo 抓取 + 后端缓存, 外网失败返回旧缓存 stale=true） */
  async getMarine(): Promise<MarineInfo> {
    if (isMockMode()) {
      await wait(350);
      return {
        fetchedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        observedAt: new Date(Date.now() - 600000).toTimeString().slice(0, 5),
        waveHeightM: 1.2, waveDirectionDeg: 135, wavePeriodS: 5.4,
        seaTempC: 26.8, windSpeedMs: 5.6, windDirectionDeg: 128, stale: false,
      };
    }
    const r = await request<{
      fetched_at: string; observed_time: string | null;
      wave_height: number | null; wave_direction: number | null;
      wave_period: number | null; sea_surface_temperature: number | null;
      wind_speed: number | null; wind_direction: number | null; stale: boolean;
    }>('/api/v1/stats/marine');
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
  async detectImage(file: File, width: number, height: number, siteId?: number): Promise<DetectionResult> {
    if (isMockMode()) { await wait(1300); return createMockDetection(width, height); }
    const form = new FormData();
    form.append('file', file);
    form.append('width', String(width));
    form.append('height', String(height));
    if (siteId) form.append('site_id', String(siteId));
    return request<DetectionResult>('/api/v1/detect/image', { method: 'POST', body: form });
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
    return request<MultiImageDetectResponse>('/api/v1/detect/images', { method: 'POST', body: form });
  },

  async createVideoTask(file: File, siteId?: number): Promise<{ taskId: string }> {
    if (isMockMode()) { await wait(700); return { taskId: `VID-${Date.now().toString().slice(-8)}` }; }
    const form = new FormData();
    form.append('file', file);
    if (siteId) form.append('site_id', String(siteId));
    const response = await request<{ task_id?: string; taskId?: string }>('/api/v1/detect/video', { method: 'POST', body: form });
    return { taskId: response.taskId ?? response.task_id ?? '' };
  },

  /** 查询视频任务实时进度：轮询返回 progress / previewUrl / 帧数，驱动实时可视化 */
  async getVideoStatus(taskId: string | number): Promise<VideoTaskStatus> {
    if (isMockMode()) {
      await wait(500);
      return { taskId: Number(taskId), status: 'processing', progress: 55, totalObjects: 0 };
    }
    const response = await request<{
      task_id: number; status: string; progress: number; total_objects: number;
      pollution_level?: string | null; processing_time?: number | null;
      preview_url?: string | null; preview_urls?: string[] | null;
      annotated_video_url?: string | null;
      processed_frames?: number | null; total_frames?: number | null;
    }>(`/api/v1/detect/status/${taskId}`);
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
    }>(`/api/v1/detect/result/${taskId}`);
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

  async getCurrentUser(): Promise<UserInfo> {
    if (isMockMode()) { await wait(200); return { id: 1, username: '林海', email: 'linhai@aquarise.local', role: 'admin' }; }
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

export async function streamChat(
  messages: ChatMessagePayload[],
  sessionId: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
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
    body: JSON.stringify({ messages, stream: true, session_id: sessionId }),
    signal,
  });
  if (!response.ok || !response.body) {
    handleUnauthorized(response);
    throw new Error(`对话服务不可用（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as { content?: string; delta?: { content?: string } };
          onChunk(parsed.content ?? parsed.delta?.content ?? '');
        } catch {
          onChunk(data);
        }
      }
    }
  }
}
