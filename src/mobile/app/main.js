/** 海瞳移动端入口：独立路由、五栏导航与页面生命周期。 */
import { api, isLoggedIn, setToken, AuthError } from './api.js';
import { el, clear, icon, toast } from './ui.js';
import { applyPreferences, getSelectedSeaArea } from './preferences.js';

const state = {
  user: null,
  currentPage: null,
  online: true,
  selectedSeaArea: getSelectedSeaArea(),
  guardianContext: null,
};

const PAGE_LOADERS = {
  login: () => import('./pages/login.js').then((module) => module.renderLogin),
  dashboard: () => import('./pages/dashboard.js').then((module) => module.renderDashboard),
  identify: () => import('./pages/identify.js').then((module) => module.renderIdentify),
  tasks: () => import('./pages/tasks.js').then((module) => module.renderTasks),
  guardian: () => import('./pages/guardian.js').then((module) => module.renderGuardian),
  profile: () => import('./pages/profile.js').then((module) => module.renderProfile),
  detail: () => import('./pages/detail.js').then((module) => module.renderDetail),
  analysis: () => import('./pages/analysis.js').then((module) => module.renderAnalysis),
  monitor: () => import('./pages/monitor.js').then((module) => module.renderMonitor),
  history: () => import('./pages/history.js').then((module) => module.renderHistory),
};

const TABS = [
  { id: 'dashboard', label: '首页', icon: 'dashboard' },
  { id: 'identify', label: '识别', icon: 'camera' },
  { id: 'tasks', label: '任务', icon: 'history' },
  { id: 'guardian', label: '守护者', icon: 'message' },
  { id: 'profile', label: '我的', icon: 'user' },
];

let visibilityHandler = null;
let renderEpoch = 0;

function navigate(route, params = {}) {
  const suffix = params.id != null ? `/${encodeURIComponent(params.id)}` : '';
  const hash = params._raw ? route : `#/${route}${suffix}`;
  if (window.location.hash !== hash) window.location.hash = hash;
  else renderRoute(route, params);
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { route: 'dashboard', params: {} };
  const [route, ...rest] = raw.split('/');
  return { route, params: { id: rest[0] ? decodeURIComponent(rest[0]) : undefined } };
}

async function renderRoute(route, params = {}) {
  if (!isLoggedIn() && route !== 'login') route = 'login';
  if (isLoggedIn() && route === 'login') {
    navigate('dashboard');
    return;
  }
  if (!PAGE_LOADERS[route]) route = 'dashboard';
  await renderAppShell(route, params);
}

async function renderAppShell(route, params) {
  const epoch = ++renderEpoch;
  state.currentPage?.unmount?.();
  state.currentPage = null;
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }

  const root = document.getElementById('app');
  clear(root);
  const isFullscreen = route === 'login' || route === 'detail';
  const content = el('div', { className: 'page-content', id: 'page-content' });
  const shell = el('div', { className: `app-shell${isFullscreen ? ' fullscreen' : ''}` }, [
    el('div', { className: 'ocean-ambient', 'aria-hidden': 'true' }, [el('i'), el('i')]),
  ]);
  if (route !== 'login' && route !== 'detail') shell.append(buildTopbar(route));
  const main = el('main', { className: 'main-scroll' }, [content]);
  if (!isFullscreen) main.append(buildTabbar(route));
  shell.append(main);
  root.append(shell);
  content.append(el('div', { className: 'route-loader', role: 'status' }, [
    el('span', { className: 'spinner-mini' }),
    el('span', { textContent: '正在打开…' }),
  ]));

  try {
    const renderer = await PAGE_LOADERS[route]();
    if (epoch !== renderEpoch) return;
    clear(content);
    const page = renderer(content, { ...params, navigate, state, toast, refreshUser }) || {};
    state.currentPage = page;
    main.scrollTop = 0;
    visibilityHandler = () => {
      if (document.hidden) page.onHide?.();
      else page.onShow?.();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  } catch (error) {
    if (epoch !== renderEpoch) return;
    clear(content);
    content.append(el('div', { className: 'route-error' }, [
      icon('alert', 28),
      el('strong', { textContent: '页面加载失败' }),
      el('p', { textContent: error?.message || '请检查网络后重试' }),
      el('button', { className: 'btn-primary', onClick: () => renderRoute(route, params) }, ['重新加载']),
    ]));
  }
}

function buildTopbar(route) {
  const titles = {
    dashboard: '随身监测', identify: '发起识别', tasks: '任务中心', guardian: '海洋守护者',
    profile: '个人中心', analysis: '分析简报', monitor: '任务监控', history: '检测历史',
  };
  return el('header', { className: 'app-topbar' }, [
    el('div', { className: 'topbar-brand' }, [
      el('div', { className: 'topbar-logo' }, [icon('waves', 20)]),
      el('div', {}, [
        el('strong', { textContent: '海瞳 HAITONG' }),
        el('small', { textContent: titles[route] || '海洋全域智守平台' }),
      ]),
    ]),
    el('button', {
      className: 'topbar-notice',
      'aria-label': '查看任务提醒',
      onClick: () => navigate('tasks'),
    }, [icon('bell', 19)]),
  ]);
}

function buildTabbar(activeRoute) {
  const bar = el('nav', { className: 'tabbar', 'aria-label': '主要导航' });
  for (const tab of TABS) {
    const active = activeRoute === tab.id;
    bar.append(el('button', {
      className: `tab-item${active ? ' active' : ''}`,
      'aria-label': tab.label,
      'aria-current': active ? 'page' : false,
      onClick: () => navigate(tab.id),
    }, [
      el('span', { className: 'tab-icon' }, [icon(tab.icon, 22)]),
      el('span', { className: 'tab-label', textContent: tab.label }),
    ]));
  }
  return bar;
}

export function updateConnectionStatus(online) {
  state.online = online;
  document.documentElement.classList.toggle('backend-offline', !online);
}

async function refreshUser() {
  if (!isLoggedIn()) return null;
  try {
    state.user = await api.getMe();
    return state.user;
  } catch (error) {
    if (error instanceof AuthError) {
      setToken(null);
      navigate('login');
    }
    return null;
  }
}

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof AuthError) {
    event.preventDefault();
    setToken(null);
    navigate('login');
    toast('登录已过期，请重新登录', 'warning');
  }
});

async function boot() {
  applyPreferences();
  if (isLoggedIn()) await refreshUser();
  const { route, params } = parseHash();
  renderRoute(route, params);
}

window.addEventListener('hashchange', () => {
  const { route, params } = parseHash();
  renderRoute(route, params);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
