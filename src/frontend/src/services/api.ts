import { createMockDetection, mockRecords, mockReports, mockSummary, mockTrend } from '../data/mock';
import type { ApiErrorShape, DetectionRecord, DetectionResult, Report, Summary, TrendPoint, UserInfo } from '../types';

const API_MODE = (import.meta.env.VITE_API_MODE ?? 'live') as 'mock' | 'live';
const wait = (ms = 450) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export const isMockMode = API_MODE === 'mock';

export const AUTH_TOKEN_KEY = 'aquarise-token';

function authHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const token = window.sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...init, headers: authHeaders(init), signal: init?.signal ?? controller.signal });
    if (!response.ok) {
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
  async getSummary(): Promise<Summary> {
    if (isMockMode) { await wait(); return mockSummary; }
    return request<Summary>('/api/v1/stats/summary');
  },

  async getTrend(period = 'month'): Promise<TrendPoint[]> {
    if (isMockMode) { await wait(560); return mockTrend; }
    const payload = await request<{ items?: TrendPoint[] } | TrendPoint[]>(`/api/v1/stats/trend?period=${encodeURIComponent(period)}`);
    return Array.isArray(payload) ? payload : payload.items ?? [];
  },

  async getHistory(): Promise<DetectionRecord[]> {
    if (isMockMode) { await wait(); return mockRecords; }
    const payload = await request<{ items: DetectionRecord[] }>('/api/v1/detections?page=1&page_size=50');
    return payload.items;
  },

  async getReports(): Promise<Report[]> {
    if (isMockMode) { await wait(); return mockReports; }
    const payload = await request<{ items: Report[] }>('/api/v1/reports/?page=1&page_size=50');
    return payload.items;
  },

  async detectImage(file: File, width: number, height: number): Promise<DetectionResult> {
    if (isMockMode) { await wait(1300); return createMockDetection(width, height); }
    const form = new FormData();
    form.append('file', file);
    form.append('width', String(width));
    form.append('height', String(height));
    return request<DetectionResult>('/api/v1/detect/image', { method: 'POST', body: form });
  },

  async createVideoTask(file: File): Promise<{ taskId: string }> {
    if (isMockMode) { await wait(700); return { taskId: `VID-${Date.now().toString().slice(-8)}` }; }
    const form = new FormData();
    form.append('file', file);
    const response = await request<{ task_id?: string; taskId?: string }>('/api/v1/detect/video', { method: 'POST', body: form });
    return { taskId: response.taskId ?? response.task_id ?? '' };
  },

  async createReport(taskId: string): Promise<Report> {
    if (isMockMode) { await wait(900); return mockReports[0]; }
    return request<Report>('/api/v1/reports/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, format: 'html' }),
    });
  },

  async getCurrentUser(): Promise<UserInfo> {
    if (isMockMode) { await wait(200); return { id: 1, username: '林海', email: 'linhai@aquarise.local', role: 'admin' }; }
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

  async updateProfile(email: string): Promise<UserInfo> {
    return request<UserInfo>('/api/v1/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() || null }),
    });
  },
};

export interface ChatMessagePayload { role: 'system' | 'user' | 'assistant'; content: string }

export async function streamChat(
  messages: ChatMessagePayload[],
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (isMockMode) {
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
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`对话服务不可用（${response.status}）`);

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
