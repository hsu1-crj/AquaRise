/**
 * main.js — AQUARISE 移动端应用入口
 * ============================================================
 * 职责：
 *   1. 应用引导与全局状态（登录态 / 用户信息）
 *   2. Hash 路由分发
 *   3. 导航外壳渲染（顶栏 + 底部 Tab + 内容区）
 *   4. 页面生命周期管理（mount / unmount）
 */

import { api, isLoggedIn, getToken, setToken, AuthError } from './api.js';
import { el, clear, icon, toast } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderMonitor } from './pages/monitor.js';
import { renderHistory } from './pages/history.js';
import { renderDetail } from './pages/detail.js';
import { renderProfile } from './pages/profile.js';

// ============ 全局状态 ============
const state = {
  user: null,          // 当前用户信息
  currentPage: null,   // 当前页面对象（含 unmount）
  online: true,        // 后端连通状态
};

// ============ 路由表 ============
// 底部 Tab 页面
const TAB_PAGES = ['dashboard', 'monitor', 'history', 'profile'];

const TABS = [
  { id: 'dashboard', label: '首页', icon: 'dashboard' },
  { id: 'monitor', label: '监控', icon: 'radar' },
  { id: 'history', label: '历史', icon: 'history' },
  { id: 'profile', label: '我的', icon: 'user' },
];

// ============ 导航 ============

function navigate(route, params = {}) {
  const hash = params._raw ? route : `#/${route}`;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  } else {
    renderRoute(route, params);
  }
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { route: 'dashboard', params: {} };
  const [route, ...rest] = raw.split('/');
  return { route, params: { id: rest[0] } };
}

// ============ 页面注册 ============

const PAGE_RENDERERS = {
  login: renderLogin,
  dashboard: renderDashboard,
  monitor: renderMonitor,
  history: renderHistory,
  detail: renderDetail,
  profile: renderProfile,
};

// ============ 渲染入口 ============

function renderRoute(route, params = {}) {
  // 未登录 → 强制登录页
  if (!isLoggedIn() && route !== 'login') {
    return renderAppShell('login', params);
  }
  // 已登录但停留在登录页 → 跳转首页
  if (isLoggedIn() && route === 'login') {
    return navigate('dashboard');
  }
  renderAppShell(route, params);
}

// ============ 应用外壳 ============

function renderAppShell(route, params) {
  const root = document.getElementById('app');
  clear(root);

  const isLogin = route === 'login';
  const isDetail = route === 'detail';
  const isFullscreen = isLogin || isDetail;

  // ---- 卸载上一页 ----
  if (state.currentPage?.unmount) state.currentPage.unmount();
  state.currentPage = null;

  // ---- 内容容器 ----
  const content = el('div', { className: 'page-content', id: 'page-content' });

  // ---- 顶栏 ----
  const topbar = isLogin ? null : buildTopbar(route);

  // ---- 底部导航 ----
  const tabbar = (isLogin || isDetail) ? null : buildTabbar(route);

  // ---- 组装 ----
  const shell = el('div', { className: `app-shell${isFullscreen ? ' fullscreen' : ''}` });
  const ambient = el('div', { className: 'ocean-ambient', 'aria-hidden': 'true' }, [
    el('i'), el('i'), el('i'),
  ]);
  shell.append(ambient);
  if (topbar) shell.append(topbar);

  const main = el('main', { className: 'main-scroll' });
  main.append(content);
  if (tabbar) main.append(tabbar);
  shell.append(main);
  root.append(shell);

  // ---- 渲染页面内容 ----
  const renderer = PAGE_RENDERERS[route] || PAGE_RENDERERS.dashboard;
  const ctx = { navigate, state, toast, refreshUser };
  const page = renderer(content, { ...params, ...ctx }) || {};
  state.currentPage = page;

  // 滚动到顶部
  main.scrollTop = 0;

  // 页面可见性 → 暂停/恢复轮询
  setupVisibilityHandler(page);
}

// ============ 顶栏 ============

function buildTopbar(route) {
  const titles = {
    dashboard: '态势总览',
    monitor: '任务监控',
    history: '检测历史',
    profile: '个人中心',
  };
  const header = el('header', { className: 'app-topbar glass' }, [
    el('div', { className: 'topbar-brand' }, [
      el('div', { className: 'topbar-logo' }, [icon('waves', 20)]),
      el('div', {}, [
        el('strong', { textContent: 'AQUARISE' }),
        el('small', { textContent: titles[route] || '海洋智守' }),
      ]),
    ]),
    el('div', { className: 'topbar-actions' }, [
      el('div', { className: 'conn-indicator', id: 'conn-indicator', title: '服务器连接状态' }, [
        el('i', { className: 'conn-dot' }),
        el('span', { textContent: '在线', className: 'conn-text' }),
      ]),
    ]),
  ]);
  return header;
}

/** 更新连接状态指示器 */
export function updateConnectionStatus(online) {
  state.online = online;
  const ind = document.getElementById('conn-indicator');
  if (!ind) return;
  ind.className = `conn-indicator ${online ? 'online' : 'offline'}`;
  const dot = ind.querySelector('.conn-dot');
  const text = ind.querySelector('.conn-text');
  if (dot) dot.className = `conn-dot ${online ? '' : 'offline'}`;
  if (text) text.textContent = online ? '在线' : '离线';
}

// ============ 底部导航 ============

function buildTabbar(activeRoute) {
  const bar = el('nav', { className: 'tabbar' });
  for (const tab of TABS) {
    const active = activeRoute === tab.id;
    const btn = el('button', {
      className: `tab-item${active ? ' active' : ''}`,
      'aria-label': tab.label,
      'aria-current': active ? 'page' : false,
      onClick: () => navigate(tab.id),
    }, [
      el('span', { className: 'tab-icon' }, [icon(tab.icon, 23)]),
      el('span', { className: 'tab-label', textContent: tab.label }),
    ]);
    bar.append(btn);
  }
  return bar;
}

// ============ 用户信息刷新 ============

async function refreshUser() {
  if (!isLoggedIn()) return null;
  try {
    state.user = await api.getMe();
    return state.user;
  } catch (err) {
    if (err instanceof AuthError) {
      setToken(null);
      navigate('login');
    }
    return null;
  }
}

// ============ 页面可见性管理 ============

let visibilityHandler = null;

function setupVisibilityHandler(page) {
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = () => {
    if (document.hidden && page?.onHide) page.onHide();
    else if (!document.hidden && page?.onShow) page.onShow();
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

// ============ 全局错误拦截 ============

window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  if (err instanceof AuthError) {
    setToken(null);
    navigate('login');
    toast('登录已过期，请重新登录', 'warning');
  }
});

// ============ 启动 ============

async function boot() {
  if (isLoggedIn()) {
    await refreshUser();
  }
  const { route, params } = parseHash();
  renderRoute(route, params);
}

// Hash 变化 → 重新渲染
window.addEventListener('hashchange', () => {
  const { route, params } = parseHash();
  renderRoute(route, params);
});

// DOM 就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
