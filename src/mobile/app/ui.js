/**
 * ui.js — AQUARISE 移动端 UI 基础组件库
 * ============================================================
 * 零依赖原生组件工厂：
 *   - SVG 图标集（与桌面端 lucide-react 风格一致）
 *   - Toast 通知
 *   - 通用 DOM 工具函数
 *   - 状态徽章、进度条、骨架屏
 */

// ============ DOM 工具 ============

/**
 * 创建元素并批量设置属性 / 子节点。
 * @param {string} tag — 标签名
 * @param {object} [props] — className / textContent / dataset / 事件等
 * @param {(Node|string)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'innerHTML') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) {
      try { node[key] = value; } catch { node.setAttribute(key, value); }
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 清空容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ============ SVG 图标（stroke 风格，与桌面 lucide 一致） ============

const ICON_PATHS = {
  waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 12h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M8.106 13.349c-1.115-1.238-1.854-2.575-2.219-3.349a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 2.219-2.933"/><path d="M5 14a1 1 0 0 0-.629.839 10.74 10.74 0 0 0-.571 3.961.988.988 0 0 0 1.014.949 10.473 10.473 0 0 0 3.717-.73.998.998 0 0 0 .61-.783A9 9 0 0 1 12.953 7.4"/><path d="m2 2 20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
  fileChart: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 18v-4"/><path d="M12 18v-7"/><path d="M16 18v-5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  loader: '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  wifiOff: '<path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 0-8.94-2.46"/><path d="M13.82 16.43a5 5 0 0 0-6.05-.34"/><path d="M12 20h.01"/><line x1="2" x2="22" y1="2" y2="22"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
};

/**
 * 创建 SVG 图标。
 * @param {string} name — ICON_PATHS 的 key
 * @param {number} [size=22]
 */
export function icon(name, size = 22) {
  const path = ICON_PATHS[name];
  if (!path) return document.createTextNode('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = path;
  return svg;
}

// ============ Toast 通知 ============

let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = el('div', { className: 'toast-container' });
    document.body.append(toastContainer);
  }
  return toastContainer;
}

/**
 * 显示轻量通知。
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type='info']
 * @param {number} [duration=3000]
 */
export function toast(message, type = 'info', duration = 3000) {
  const container = ensureToastContainer();
  const icons = { info: 'bell', success: 'checkCircle', error: 'alert', warning: 'alert' };
  const item = el('div', { className: `toast toast-${type}` }, [
    el('span', { className: 'toast-icon' }, [icon(icons[type] || 'bell', 18)]),
    el('span', { className: 'toast-msg', textContent: message }),
  ]);
  container.append(item);
  // 入场动画
  requestAnimationFrame(() => item.classList.add('show'));
  if (navigator.vibrate) navigator.vibrate(type === 'error' ? [60, 30, 60] : 30);
  setTimeout(() => {
    item.classList.remove('show');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
    setTimeout(() => item.remove(), 400);
  }, duration);
}

// ============ 状态徽章 ============

const LEVEL_STYLES = {
  '优': 'badge-green',
  '良': 'badge-cyan',
  '中': 'badge-amber',
  '差': 'badge-orange',
  '严重': 'badge-red',
};

const STATUS_STYLES = {
  '已完成': 'badge-green',
  '处理中': 'badge-cyan',
  '失败': 'badge-red',
  '已生成': 'badge-green',
  '生成中': 'badge-cyan',
};

export function levelBadge(text) {
  return el('span', { className: `badge ${LEVEL_STYLES[text] || 'badge-cyan'}`, textContent: text });
}

export function statusBadge(text) {
  const cls = STATUS_STYLES[text] || 'badge-cyan';
  const dot = text === '处理中' || text === '生成中' ? el('i', { className: 'badge-dot pulse' }) : null;
  return el('span', { className: `badge ${cls}` }, [dot, text].filter(Boolean));
}

// ============ 进度条 ============

export function progressBar(percent, animated = false) {
  const bar = el('div', { className: 'progress-track' }, [
    el('div', {
      className: `progress-fill${animated ? ' indeterminate' : ''}`,
      style: animated ? {} : { width: `${Math.min(100, Math.max(0, percent))}%` },
    }),
  ]);
  return bar;
}

// ============ 骨架屏 ============

export function skeletonCard() {
  return el('div', { className: 'skeleton-card' }, [
    el('div', { className: 'skeleton-line w60' }),
    el('div', { className: 'skeleton-line w90' }),
    el('div', { className: 'skeleton-line w40' }),
  ]);
}

export function skeletonList(count = 4) {
  return Array.from({ length: count }, () => skeletonCard());
}

// ============ 空状态 ============

export function emptyState(iconName, title, subtitle) {
  return el('div', { className: 'empty-state' }, [
    el('div', { className: 'empty-icon' }, [icon(iconName, 40)]),
    el('p', { className: 'empty-title', textContent: title }),
    subtitle && el('p', { className: 'empty-sub', textContent: subtitle }),
  ]);
}

// ============ 错误状态 ============

export function errorState(message, onRetry) {
  return el('div', { className: 'empty-state' }, [
    el('div', { className: 'empty-icon error' }, [icon('alert', 40)]),
    el('p', { className: 'empty-title', textContent: message }),
    onRetry && el('button', { className: 'btn-retry', onClick: onRetry }, [
      icon('refresh', 16), '重试',
    ]),
  ]);
}

// ============ 时间格式化 ============

export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr.replace(/-/g, '/'));
  if (isNaN(date)) return dateStr;
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return dateStr.slice(0, 10);
}
