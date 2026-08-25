import { api, isLoggedIn } from '../api.js';
import { el, clear, icon, statusBadge, skeletonList, emptyState, timeAgo } from '../ui.js';
import { getSelectedSeaArea, setSelectedSeaArea } from '../preferences.js';

const ACTIVE_STATUSES = new Set(['处理中', 'pending', 'processing']);

export function renderDashboard(container, ctx) {
  const { navigate, state, toast } = ctx;
  let timer = null;
  let mounted = true;
  let visible = true;
  let loading = false;
  let loadEpoch = 0;
  let controller = new AbortController();

  const page = el('div', { className: 'page-pad dashboard-mobile' });
  const seaSelect = el('select', { className: 'sea-switch', 'aria-label': '选择任务海域' }, [el('option', { textContent: '加载海域…' })]);
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const heroStatus = el('p', { className: 'hero-status', textContent: '正在同步全域态势…' });
  const hero = el('section', { className: 'dash-hero mobile-hero glass' }, [
    el('div', { className: 'hero-toolbar' }, [
      el('span', { className: 'eyebrow', textContent: '随身监测终端' }), seaSelect,
    ]),
    el('h1', { textContent: `${greeting}，${state.user?.username || '海洋守护者'}` }),
    heroStatus,
  ]);
  const overview = el('section', { className: 'overview-grid' }, skeletonList(3));
  const activeSection = el('section', { className: 'section-block active-home' });
  const trendSection = el('section', { className: 'section-block' });
  const latestSection = el('section', { className: 'section-block' });
  page.append(hero, overview, activeSection, trendSection, latestSection, moreAbilities(navigate, toast));
  container.append(page);

  seaSelect.addEventListener('change', () => {
    const option = seaSelect.selectedOptions[0];
    const selected = { id: option.value ? Number(option.value) : null, name: option.textContent };
    setSelectedSeaArea(selected);
    state.selectedSeaArea = selected;
    loadData(true);
  });
  loadSeaAreas();
  loadData();

  async function loadSeaAreas() {
    try {
      const areas = await api.getSeaAreas();
      if (!mounted) return;
      clear(seaSelect);
      seaSelect.append(el('option', { value: '', textContent: '全域态势' }));
      for (const area of areas || []) seaSelect.append(el('option', { value: String(area.id), textContent: area.name }));
      const selected = getSelectedSeaArea();
      seaSelect.value = selected.id ? String(selected.id) : '';
    } catch {
      clear(seaSelect);
      seaSelect.append(el('option', { value: '', textContent: '全域态势' }));
    }
  }

  async function loadData(manual = false) {
    if (!mounted || !visible || loading || !isLoggedIn()) return;
    loading = true;
    const epoch = ++loadEpoch;
    if (manual) heroStatus.textContent = '正在刷新态势…';
    try {
      const [summaryResult, trendResult, tasksResult] = await Promise.allSettled([
        api.getSummary(), api.getTrend('week'), api.getDetections(1, 20, { signal: controller.signal }),
      ]);
      if (!mounted || !visible || epoch !== loadEpoch) return;
      const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
      const trend = trendResult.status === 'fulfilled' ? trendResult.value : [];
      const allTasks = tasksResult.status === 'fulfilled' ? (tasksResult.value?.items || []) : [];
      const selected = getSelectedSeaArea();
      const scopedTasks = selected.id ? allTasks.filter((task) => task.location === selected.name) : allTasks;
      const active = scopedTasks.filter((task) => ACTIVE_STATUSES.has(task.status));

      heroStatus.textContent = `${selected.name} · ${summary.seaAreas ?? '—'} 个海域接入 · ${active.length ? `${active.length} 个活跃任务` : '当前稳定'}`;
      renderOverview(summary, active.length);
      renderActive(active);
      renderTrend(trend);
      renderLatest(scopedTasks.filter((task) => !ACTIVE_STATUSES.has(task.status)).slice(0, 4));
      clearTimeout(timer);
      timer = setTimeout(() => loadData(), active.length ? 3000 : 15000);
    } finally {
      if (epoch === loadEpoch) loading = false;
    }
  }

  function renderOverview(summary, activeCount) {
    clear(overview);
    overview.append(
      metric('活跃任务', activeCount, 'activity', 'cyan'),
      metric('今日/累计任务', summary.totalTasks ?? 0, 'target', 'blue'),
      metric('预警', summary.activeAlerts ?? 0, 'bell', (summary.activeAlerts ?? 0) ? 'amber' : 'green'),
    );
  }

  function renderActive(tasks) {
    clear(activeSection);
    activeSection.append(sectionHead('正在识别', el('button', { className: 'link-btn', onClick: () => navigate('tasks') }, ['任务中心', icon('chevronRight', 14)])));
    if (!tasks.length) {
      activeSection.append(el('button', { className: 'empty-action-card', onClick: () => navigate('identify') }, [
        icon('camera', 21), el('span', {}, [el('strong', { textContent: '没有正在处理的任务' }), el('small', { textContent: '拍照或选择图片开始识别' })]), icon('chevronRight', 17),
      ]));
      return;
    }
    for (const task of tasks.slice(0, 2)) {
      activeSection.append(el('button', { className: 'home-active-card', onClick: () => navigate('detail', { id: taskNumber(task.id) }) }, [
        el('div', {}, [el('strong', { textContent: task.id }), statusBadge(task.status)]),
        el('small', { textContent: `${task.location} · ${task.type} · 服务端处理中` }),
        el('div', { className: 'indeterminate-track' }, [el('i')]),
      ]));
    }
  }

  function renderTrend(points) {
    clear(trendSection);
    trendSection.append(sectionHead('近 7 日污染趋势', el('button', { className: 'link-btn', onClick: () => navigate('analysis') }, ['查看分析', icon('chevronRight', 14)])));
    if (!points.length) {
      trendSection.append(emptyState('activity', '暂无趋势数据', '完成任务后生成轻量趋势'));
      return;
    }
    const max = Math.max(...points.map((point) => Number(point.count || 0)), 1);
    const bars = el('div', { className: 'mini-trend', 'aria-label': '近七日检测任务趋势' });
    for (const point of points.slice(-7)) {
      bars.append(el('div', {}, [
        el('i', { style: { transform: `scaleY(${Number(point.count || 0) / max})` } }),
        el('small', { textContent: String(point.date || '').slice(-5) }),
      ]));
    }
    trendSection.append(bars);
  }

  function renderLatest(tasks) {
    clear(latestSection);
    latestSection.append(sectionHead('最近完成', el('button', { className: 'link-btn', onClick: () => navigate('tasks') }, ['查看全部', icon('chevronRight', 14)])));
    if (!tasks.length) {
      latestSection.append(emptyState('history', '暂无最近任务', '新完成的识别会显示在这里'));
      return;
    }
    const list = el('div', { className: 'task-list' });
    for (const task of tasks) list.append(el('button', { className: 'task-row surface-card', onClick: () => navigate('detail', { id: taskNumber(task.id) }) }, [
      el('span', { className: `task-type-badge type-${task.type === '视频' ? 'video' : 'image'}` }, [icon(task.type === '视频' ? 'video' : 'image', 18)]),
      el('span', { className: 'task-info' }, [el('span', { className: 'task-top' }, [el('strong', { textContent: task.id }), statusBadge(task.status)]), el('span', { className: 'task-meta' }, [task.location, ' · ', timeAgo(task.createdAt)])]),
      icon('chevronRight', 17),
    ]));
    latestSection.append(list);
  }

  return {
    unmount() { mounted = false; loadEpoch += 1; clearTimeout(timer); controller.abort(); },
    onHide() { visible = false; loadEpoch += 1; loading = false; clearTimeout(timer); controller.abort(); },
    onShow() {
      visible = true;
      controller = new AbortController();
      timer = setTimeout(() => loadData(true), 0);
    },
  };
}

function sectionHead(title, action) {
  return el('div', { className: 'section-header' }, [el('h2', { className: 'section-title', textContent: title }), action]);
}

function metric(label, value, iconName, color) {
  return el('article', { className: `overview-card ${color}` }, [icon(iconName, 19), el('strong', { textContent: value }), el('span', { textContent: label })]);
}

function moreAbilities(navigate, toast) {
  return el('section', { className: 'section-block' }, [
    el('h2', { className: 'section-title', textContent: '更多能力' }),
    el('div', { className: 'more-grid' }, [
      el('button', { onClick: () => navigate('analysis') }, [icon('activity', 19), el('span', {}, [el('strong', { textContent: '分析简报' }), el('small', { textContent: '趋势、材质与站点' })])]),
      el('button', { onClick: () => toast('3D 海洋态势为 PC 专属，手机端提供 2D 站点摘要', 'info') }, [icon('mapPin', 19), el('span', {}, [el('strong', { textContent: '海域态势' }), el('small', { textContent: '移动 2D 轻量版' })])]),
      el('button', { onClick: () => toast('指挥大屏为 PC 专属能力', 'info') }, [icon('dashboard', 19), el('span', {}, [el('strong', { textContent: '指挥大屏' }), el('small', { textContent: '请在 PC 端查看' })])]),
    ]),
  ]);
}

function taskNumber(id) {
  const match = String(id ?? '').match(/(\d+)$/);
  return match ? Number(match[1]) : id;
}
