/**
 * dashboard.js — 态势总览首页
 * ============================================================
 * 用户友好设计：
 *   - 个性化欢迎语 + 当前时间
 *   - 核心指标卡片（任务数 / 垃圾总数 / 覆盖面积）
 *   - 近期趋势微缩图（7 天）
 *   - 快捷入口（一键跳转监控 / 识别 / 历史）
 *   - 最近任务摘要（最多 5 条，可点击查看）
 *   - 完善的加载 / 错误 / 空状态
 */

import { api, isLoggedIn } from '../api.js';
import { el, clear, icon, toast, levelBadge, statusBadge, skeletonList, emptyState, errorState, timeAgo } from '../ui.js';

export function renderDashboard(container, ctx) {
  const { navigate, state } = ctx;
  let refreshTimer = null;
  let isMounted = true;

  const page = el('div', { className: 'page-pad' });
  container.append(page);

  // ---- 欢迎区 ----
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const userName = state.user?.username || '海洋守护者';

  const hero = el('div', { className: 'dash-hero glass' }, [
    el('div', { className: 'dash-greeting' }, [
      el('p', { className: 'dash-hello', textContent: `${greeting}，${userName}` }),
      el('p', { className: 'dash-date', textContent: new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }),
    ]),
    el('div', { className: 'dash-hero-icon' }, [icon('droplet', 26)]),
  ]);
  page.append(hero);

  // ---- 指标卡片区 ----
  const statsSection = el('section', { className: 'section-block' });
  const statsGrid = el('div', { className: 'stats-grid' });
  statsSection.append(el('h3', { className: 'section-title' }, ['核心指标']), statsGrid);
  page.append(statsSection);

  // 加载骨架
  statsGrid.append(...skeletonList(2).map(s => el('div', { className: 'skeleton-card-mini' }, [s])));

  // ---- 快捷入口 ----
  const quickActions = el('section', { className: 'section-block' }, [
    el('h3', { className: 'section-title' }, ['快捷操作']),
    el('div', { className: 'quick-grid' }, [
      buildQuickAction('radar', '任务监控', '实时追踪主机端检测', 'monitor', navigate),
      buildQuickAction('history', '检测历史', '查看所有识别记录', 'history', navigate),
      buildQuickAction('fileChart', '检测详情', '浏览识别结果', 'history', navigate),
    ]),
  ]);
  page.append(quickActions);

  // ---- 趋势区 ----
  const trendSection = el('section', { className: 'section-block' });
  page.append(trendSection);

  // ---- 最近任务 ----
  const recentSection = el('section', { className: 'section-block' }, [
    el('div', { className: 'section-header' }, [
      el('h3', { className: 'section-title', textContent: '最近任务' }),
      el('button', {
        className: 'link-btn',
        onClick: () => navigate('history'),
      }, ['查看全部', icon('chevronRight', 14)]),
    ]),
  ]);
  const recentList = el('div', { className: 'task-list' });
  recentSection.append(recentList);
  page.append(recentSection);

  // ---- 数据加载 ----
  async function loadData() {
    if (!isLoggedIn()) return;

    const tasks = [
      // 指标概览
      api.getSummary().then(data => {
        if (!isMounted) return;
        clear(statsGrid);
        statsGrid.append(
          buildStatCard('任务总数', data.totalTasks ?? 0, 'image', 'cyan'),
          buildStatCard('识别目标', data.totalObjects ?? 0, 'target', 'green'),
          buildStatCard('覆盖面积', `${data.coverageKm2 ?? '—'} km²`, 'mapPin', 'violet'),
          buildStatCard('月度增长', `+${data.monthlyGrowth ?? 0}`, 'activity', 'amber'),
        );
      }).catch(() => {
        if (!isMounted) return;
        clear(statsGrid);
        statsGrid.append(
          buildStatCard('任务总数', '—', 'image', 'cyan'),
          buildStatCard('识别目标', '—', 'target', 'green'),
          buildStatCard('覆盖面积', '— km²', 'mapPin', 'violet'),
          buildStatCard('月度增长', '—', 'activity', 'amber'),
        );
      }),

      // 趋势数据
      api.getTrend('week').then(data => {
        if (!isMounted) return;
        renderTrend(trendSection, data || []);
      }).catch(() => {
        if (!isMounted) return;
        trendSection.innerHTML = '';
      }),

      // 最近任务
      api.getDetections(1, 5).then(data => {
        if (!isMounted) return;
        renderRecent(recentList, (data?.items) || [], navigate);
      }).catch(() => {
        if (!isMounted) return;
        clear(recentList);
        recentList.append(emptyState('history', '暂无检测任务', '主机端提交检测后将在此显示'));
      }),
    ];

    await Promise.allSettled(tasks);
  }

  // 首次加载 + 定时刷新（30 秒）
  loadData();
  refreshTimer = setInterval(loadData, 30000);

  return {
    unmount() {
      isMounted = false;
      clearInterval(refreshTimer);
    },
    onShow() { loadData(); },
  };
}

// ============ 子组件 ============

function buildQuickAction(iconName, title, subtitle, route, navigate) {
  return el('button', {
    className: 'quick-card glass',
    onClick: () => navigate(route),
  }, [
    el('div', { className: `quick-icon quick-icon-${iconName}` }, [icon(iconName, 22)]),
    el('div', { className: 'quick-text' }, [
      el('strong', { textContent: title }),
      el('small', { textContent: subtitle }),
    ]),
    el('span', { className: 'quick-arrow' }, [icon('chevronRight', 16)]),
  ]);
}

function buildStatCard(label, value, iconName, color) {
  return el('div', { className: `stat-card stat-${color}` }, [
    el('div', { className: 'stat-icon' }, [icon(iconName, 18)]),
    el('div', { className: 'stat-body' }, [
      el('strong', { textContent: String(value) }),
      el('small', { textContent: label }),
    ]),
  ]);
}

function renderTrend(section, data) {
  section.innerHTML = '';
  section.append(el('h3', { className: 'section-title', textContent: '近 7 天趋势' }));

  if (!data.length) {
    section.append(el('p', { className: 'trend-empty', textContent: '暂无趋势数据' }));
    return;
  }

  const maxCount = Math.max(...data.map(d => d.count), 1);
  const chart = el('div', { className: 'trend-chart' });
  for (const point of data) {
    const heightPct = Math.max(4, (point.count / maxCount) * 100);
    const bar = el('div', { className: 'trend-bar' }, [
      el('div', { className: 'trend-value', textContent: point.count }),
      el('div', { className: 'trend-col' }, [
        el('div', { className: 'trend-fill', style: { height: `${heightPct}%` } }),
      ]),
      el('span', { className: 'trend-label', textContent: point.date.slice(5) }),
    ]);
    chart.append(bar);
  }
  section.append(chart);
}

function renderRecent(listEl, items, navigate) {
  clear(listEl);
  if (!items.length) {
    listEl.append(emptyState('history', '暂无检测任务', '主机端提交检测后将在此显示'));
    return;
  }
  for (const item of items) {
    const taskId = (item.id || '').replace('DET-', '');
    const card = el('div', {
      className: 'task-row glass',
      onClick: () => taskId && navigate(`detail/${taskId}`, { id: taskId, _raw: true }),
    }, [
      el('div', { className: `task-type-badge type-${item.type === '视频' ? 'video' : 'image'}` },
        [icon(item.type === '视频' ? 'video' : 'image', 16)]),
      el('div', { className: 'task-info' }, [
        el('div', { className: 'task-top' }, [
          el('strong', { textContent: `${item.type}检测` }),
          statusBadge(item.status),
        ]),
        el('div', { className: 'task-meta' }, [
          el('span', { textContent: `${item.objectCount} 个目标` }),
          el('span', { className: 'dot-sep' }),
          el('span', { textContent: timeAgo(item.createdAt) }),
        ]),
      ]),
      levelBadge(item.level || '优'),
    ]);
    listEl.append(card);
  }
}
