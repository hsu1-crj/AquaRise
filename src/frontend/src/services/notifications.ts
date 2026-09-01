/** 通知中心 API + SSE 实时订阅（铃铛）。SSE 用 fetch+ReadableStream 消费，以便携带 Authorization 头。 */

import { authHeaders } from './api';

export interface NotifItem {
  id: number;
  type: string; // task_completed / task_failed / report_ready / pollution_warning
  title: string;
  body?: string | null;
  linkPage?: string | null; // history / reports
  refId?: number | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotifPayload<T = NotifItem> {
  type: 'init' | 'notification' | 'permissions_changed';
  items?: NotifItem[];
  unreadCount: number;
  item?: T;
}

/** 用户组权限被管理员调整时，铃铛的 SSE 订阅把瞬时事件转成 window 事件，App 监听后重拉 /auth/me */
export const PERMISSIONS_CHANGED_EVENT = 'auth:permissions-changed';

/** 检测任务完成/失败时，铃铛的 SSE 订阅把瞬时事件转成 window 事件，检测历史页监听后实时刷新列表 */
export const DETECTION_REFRESH_EVENT = 'detection:refresh';

export interface NotifSnapshot {
  items: NotifItem[];
  unreadCount: number;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...init, headers: authHeaders(init), signal: init?.signal ?? controller.signal });
    if (!response.ok) {
      // 401 由全局登录态处理接管；这里只抛错供调用方展示
      throw new Error(`请求失败（${response.status}）`);
    }
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function getNotifications(): Promise<NotifSnapshot> {
  return apiFetch<NotifSnapshot>('/api/v1/notifications');
}

export async function markNotifRead(id: number): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/v1/notifications/${id}/read`, { method: 'POST' });
}

export async function markAllNotifRead(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/v1/notifications/read-all', { method: 'POST' });
}

export async function deleteNotif(id: number): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/v1/notifications/${id}`, { method: 'DELETE' });
}

export async function deleteReadNotifs(): Promise<void> {
  await apiFetch<{ ok: boolean; deleted?: number }>('/api/v1/notifications/read-all', { method: 'DELETE' });
}

/**
 * 订阅通知 SSE。返回解除订阅函数；断线自动指数退避重连（1s→2s→4s→…上限 30s），401 停止。
 * onEvent 收到已解析的事件：init 快照或增量通知（均带 unreadCount）。
 */
export function subscribeNotifications(
  onEvent: (payload: NotifPayload) => void,
  onError: (message: string) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = 0;
  let timer: number | null = null;
  const BASE = 1000;
  const MAX = 30000;

  const stop = () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    controller?.abort();
  };

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await fetch('/api/v1/notifications/stream', {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401) { stop(); return; }
        throw new Error(`连接被中断（${response.status}）`);
      }
      if (!response.body) throw new Error('当前浏览器不支持流式读取');

      retry = 0; // 建立连接成功即复位退避
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line || line.startsWith(':')) continue; // 空行 / 心跳注释
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as NotifPayload;
            onEvent(parsed);
          } catch {
            // 丢弃非法帧，不中断订阅
          }
        }
      }
    } catch (error) {
      if (stopped) return;
      if ((error instanceof DOMException && error.name === 'AbortError') || stopped) return;
      onError(error instanceof Error ? error.message : '连接已断开');
    }
    if (stopped) return;
    const delay = Math.min(BASE * 2 ** retry, MAX);
    retry += 1;
    timer = window.setTimeout(() => void connect(), delay);
  };

  void connect();
  return stop;
}