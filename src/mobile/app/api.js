/**
 * api.js — AQUARISE 移动端 API 客户端
 * ============================================================
 * 封装全部后端 /api/v1/* 接口调用：
 *   - API 基址可配置（手机端需指向主机局域网 IP，非 localhost）
 *   - JWT Bearer 鉴权令牌自动注入与失效处理
 *   - 统一超时、错误解析与友好提示
 *
 * 不依赖任何第三方库，仅使用原生 fetch。
 */

// ============ 配置存储 ============
const API_BASE_KEY = 'aquarise-api-base';
const TOKEN_KEY = 'aquarise-token';

/**
 * 推测默认 API 基址：
 * 如果移动端页面由主机上的静态服务器提供（如 http://192.168.1.100:8080），
 * 则后端大概率在同一主机的 8000 端口。
 */
function defaultApiBase() {
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:8000`;
}

/**
 * 校验 API 基址：必须为 http/https 开头的合法 URL。
 * @returns {string} 清洗后的 URL（去尾部斜杠）
 * @throws {Error} 如果 URL 不合法
 */
export function validateApiBase(url) {
  const cleaned = (url || '').trim().replace(/\/+$/, '');
  if (!cleaned) throw new Error('服务器地址不能为空');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('服务器地址格式不正确，应类似 http://192.168.1.100:8000');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务器地址必须以 http:// 或 https:// 开头');
  }
  return cleaned;
}

/** 读取 API 基址（未设置时用自动推测的默认值） */
export function getApiBase() {
  return localStorage.getItem(API_BASE_KEY) || defaultApiBase();
}

/** 设置 API 基址（先校验再持久化；校验失败抛异常，不修改已保存的值） */
export function setApiBase(url) {
  const cleaned = validateApiBase(url);
  localStorage.setItem(API_BASE_KEY, cleaned);
  return cleaned;
}

/**
 * 探测指定基址是否可达（不修改当前已保存的基址）。
 * @param {string} base — 待探测的完整 URL
 * @param {number} [timeout=4000]
 * @returns {Promise<boolean>}
 */
export async function pingBase(base, timeout = 4000) {
  const validated = validateApiBase(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(validated + '/', { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.service === '海洋守护者 API';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 重置为自动推测的默认值 */
export function resetApiBase() {
  localStorage.removeItem(API_BASE_KEY);
  return getApiBase();
}

// ============ 令牌管理 ============
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return !!getToken();
}

// ============ 核心请求 ============
const DEFAULT_TIMEOUT = 15000;

/**
 * 统一 fetch 封装：拼接基址、注入鉴权头、超时控制、错误解析。
 * @param {string} path — 相对路径，如 '/api/v1/stats/summary'
 * @param {RequestInit} [init]
 * @param {{ skipAuth?: boolean, timeout?: number, signal?: AbortSignal }} [opts]
 */
async function request(path, init, opts = {}) {
  const base = getApiBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const headers = new Headers(init?.headers);
  if (!opts.skipAuth) {
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  // 统一使用内部 controller 管理超时；外部 signal（如页面卸载）联动中止
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? DEFAULT_TIMEOUT);
  let externalAborted = false;
  if (opts.signal) {
    if (opts.signal.aborted) { externalAborted = true; controller.abort(); }
    else opts.signal.addEventListener('abort', () => { externalAborted = true; controller.abort(); }, { once: true });
  }

  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    if (res.status === 401 && !opts.skipAuth) {
      setToken(null);
      throw new AuthError('登录已过期，请重新登录');
    }
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch { /* 非 JSON 错误体 */ }
      const msg = payload?.detail || payload?.message || payload?.error || `请求失败（${res.status}）`;
      throw new ApiError(msg, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // 外部主动中止（页面卸载）→ 原样抛出，调用方静默处理
      if (externalAborted) throw err;
      throw new ApiError('请求超时，请检查网络或服务器地址');
    }
    if (err.name === 'TypeError') {
      throw new ApiError(`无法连接服务器，请检查 API 地址是否正确（当前：${base}）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============ 自定义错误 ============
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class AuthError extends ApiError {
  constructor(message) {
    super(message, 401);
    this.name = 'AuthError';
  }
}

// ============ 业务接口 ============
export const api = {
  // ---- 认证 ----
  async login(username, password) {
    const data = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, platform: 'mobile' }),
    }, { skipAuth: true });
    setToken(data.access_token);
    return data;
  },

  async register(username, password, email) {
    return request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email }),
    }, { skipAuth: true });
  },

  async getMe() {
    return request('/api/v1/auth/me');
  },

  async changePassword(oldPassword, newPassword) {
    return request('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
  },

  async updateProfile({ email, phoneNum }) {
    return request('/api/v1/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email ?? null, phone_num: phoneNum ?? null }),
    });
  },

  // ---- 统计概览（DTO 归一化：兼容 camelCase / snake_case 后端返回） ----
  async getSummary() {
    const r = await request('/api/v1/stats/summary');
    return {
      totalTasks: r.totalTasks ?? r.total_tasks ?? 0,
      totalObjects: r.totalObjects ?? r.total_objects ?? 0,
      seaAreas: r.seaAreas ?? r.sea_areas ?? 0,
      monthlyGrowth: r.monthlyGrowth ?? r.monthly_growth ?? 0,
      activeAlerts: r.activeAlerts ?? r.active_alerts ?? 0,
      coverageKm2: r.coverageKm2 ?? r.coverage_km2 ?? 0,
    };
  },

  async getTrend(period = 'week') {
    const raw = await request(`/api/v1/stats/trend?period=${period}`);
    // 后端返回裸数组 list[FrontendTrendPoint]；兼容 {period, data} 包装
    const arr = Array.isArray(raw) ? raw : (raw?.data ?? []);
    return arr.map((p) => ({
      date: p.date ?? '',
      count: p.count ?? 0,
      density: p.density ?? 0,
    }));
  },

  // ---- 检测任务 ----
  async getDetections(page = 1, pageSize = 50, opts = {}) {
    return request(`/api/v1/detections?page=${page}&page_size=${pageSize}`, {}, opts);
  },

  /** 图片检测：上传 → 同步推理 → 返回结果 */
  async detectImage(file) {
    const form = new FormData();
    form.append('file', file);
    form.append('width', '1280');
    form.append('height', '720');
    return request('/api/v1/detect/image', { method: 'POST', body: form }, { timeout: 60000 });
  },

  /** 提交视频检测：立即返回 task_id，后台处理 */
  async detectVideo(file) {
    const form = new FormData();
    form.append('file', file);
    return request('/api/v1/detect/video', { method: 'POST', body: form });
  },

  /** 查询任务进度（实时监控核心接口） */
  async getTaskStatus(taskId, opts = {}) {
    return request(`/api/v1/detect/status/${taskId}`, {}, opts);
  },

  /** 获取检测结果详情 */
  async getTaskResult(taskId, opts = {}) {
    return request(`/api/v1/detect/result/${taskId}`, {}, opts);
  },

  // ---- 报告 ----
  async getReports() {
    return request('/api/v1/reports/');
  },

  async createReport(taskId) {
    return request('/api/v1/reports/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: Number(taskId), format: 'html' }),
    });
  },

  // ---- 健康检查 ----
  /** 探测 API 基址是否可达（不鉴权、快速超时） */
  async ping() {
    return request('/', {}, { skipAuth: true, timeout: 4000 });
  },
};
