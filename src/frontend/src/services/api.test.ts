import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_TOKEN_KEY,
  REMEMBER_FLAG_KEY,
  api,
  authHeaders,
  clearStoredAuth,
  getStoredToken,
  storeToken,
} from './api';

describe('API authentication storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('moves the token between persistent and session storage', () => {
    storeToken('persistent-token', true);

    expect(getStoredToken()).toBe('persistent-token');
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('persistent-token');
    expect(window.localStorage.getItem(REMEMBER_FLAG_KEY)).toBe('1');
    expect(window.sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();

    storeToken('session-token', false);

    expect(getStoredToken()).toBe('session-token');
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_FLAG_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(AUTH_TOKEN_KEY)).toBe('session-token');
  });

  it('builds authorization headers without dropping caller headers', () => {
    window.sessionStorage.setItem(AUTH_TOKEN_KEY, 'session-token');

    const headers = authHeaders({ headers: { 'Content-Type': 'application/json' } });

    expect(headers.get('Authorization')).toBe('Bearer session-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('clears every local authentication artifact', () => {
    window.sessionStorage.setItem('aquarise-session', 'session-id');
    storeToken('persistent-token', true);

    clearStoredAuth();

    expect(window.sessionStorage.getItem('aquarise-session')).toBeNull();
    expect(getStoredToken()).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_FLAG_KEY)).toBeNull();
  });
});

describe('API request behavior', () => {
  it('encodes query parameters, sends auth, and unwraps list payloads', async () => {
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'api-token');
    const payload = { items: [{ date: '2026-08-31', count: 8, density: 0.4 }] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getTrend('month & year')).resolves.toEqual(payload.items);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/stats/trend?period=month%20%26%20year');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer api-token');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces backend validation details as a readable error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      detail: [
        { loc: ['body', 'username'], msg: '用户名格式不正确' },
        { loc: ['body', 'password'], msg: '密码不能为空' },
      ],
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSummary()).rejects.toThrow('username: 用户名格式不正确；password: 密码不能为空');
  });
});
