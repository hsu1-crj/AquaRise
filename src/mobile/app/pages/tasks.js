import { api } from '../api.js';
import { el, clear, icon, toast, levelBadge, statusBadge, progressBar, skeletonList, emptyState, errorState, timeAgo } from '../ui.js';

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const ACTIVE_STATUSES = new Set(['处理中', 'pending', 'processing']);

export function renderTasks(container, ctx) {
  const { navigate, state } = ctx;
  let segment = sessionStorage.getItem('haitong-task-segment') || 'active';
  let timer = null;
  let controller = new AbortController();
  let mounted = true;
  let visible = true;
  let loading = false;
  let loadEpoch = 0;
  let previousStatuses = new Map();
  let searchValue = sessionStorage.getItem('haitong-task-search') || '';
  let levelValue = sessionStorage.getItem('haitong-task-level') || '';

  const page = el('div', { className: 'page-pad tasks-page' });
  const segments = el('div', { className: 'segment-control', role: 'tablist', 'aria-label': '任务中心分类' });
  const body = el('div', { className: 'task-center-body' });
  for (const item of [
    ['active', '进行中'], ['history', '历史'], ['reports', '报告'],
  ]) {
    segments.append(el('button', {
      role: 'tab',
      className: segment === item[0] ? 'active' : '',
      'aria-selected': segment === item[0],
      onClick: () => switchSegment(item[0]),
    }, [item[1]]));
  }
  page.append(segments, body);
  container.append(page);
  renderSegment();

  function switchSegment(next) {
    if (segment === next) return;
    segment = next;
    sessionStorage.setItem('haitong-task-segment', segment);
    for (const button of segments.children) {
      const active = button.textContent === ({ active: '进行中', history: '历史', reports: '报告' }[segment]);
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    stopPolling();
    controller.abort();
    loadEpoch += 1;
    loading = false;
    controller = new AbortController();
    renderSegment();
  }

  function renderSegment() {
    clear(body);
    if (segment === 'active') renderActive();
    else if (segment === 'history') renderHistory();
    else renderReports();
  }

  function renderActive() {
    body.append(...skeletonList(3));
    loadActive();
  }

  async function loadActive(manual = false) {
    if (!mounted || !visible || loading) return;
    loading = true;
    const epoch = ++loadEpoch;
    try {
      const data = await api.getDetections(1, 20, { signal: controller.signal });
      let active = (data?.items || []).filter((task) => ACTIVE_STATUSES.has(task.status) || previousStatuses.has(task.id));
      active = await hydrateStatuses(active);
      if (!mounted || !visible || segment !== 'active' || epoch !== loadEpoch) return;
      notifyStatusChanges(active);
      active = active.filter((task) => !task.live?.status || ['pending', 'processing'].includes(task.live.status));
      clear(body);
      body.append(el('div', { className: 'task-summary-line' }, [
        el('span', {}, [el('strong', { textContent: String(active.length) }), ' 个活跃任务']),
        el('button', { className: 'link-btn', onClick: () => loadActive(true) }, [icon('refresh', 15), manual ? '已同步' : '立即刷新']),
      ]));
      if (!active.length) {
        body.append(emptyState('checkCircle', '当前没有活跃任务', '可以拍照或选择影像开始一次识别'));
        body.append(el('button', { className: 'btn-primary btn-full', onClick: () => navigate('identify') }, [icon('camera', 18), '开始识别']));
      } else {
        const list = el('div', { className: 'active-task-list' });
        for (const task of active) list.append(activeCard(task, navigate));
        body.append(list);
      }
      schedule(active.length ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    } catch (error) {
      if (error?.name !== 'AbortError' && mounted && segment === 'active') {
        clear(body);
        body.append(errorState(error.message || '任务同步失败', () => loadActive(true)));
        schedule(IDLE_POLL_MS);
      }
    } finally {
      if (epoch === loadEpoch) loading = false;
    }
  }

  async function hydrateStatuses(tasks) {
    const result = [];
    for (let offset = 0; offset < tasks.length; offset += 4) {
      const batch = tasks.slice(offset, offset + 4);
      const settled = await Promise.allSettled(batch.map((task) => api.getTaskStatus(taskNumber(task.id), { signal: controller.signal })));
      for (let index = 0; index < batch.length; index += 1) {
        const status = settled[index].status === 'fulfilled' ? settled[index].value : null;
        result.push({ ...batch[index], live: status });
      }
    }
    return result;
  }

  function notifyStatusChanges(tasks) {
    const next = new Map();
    for (const task of tasks) next.set(task.id, task.live?.status || task.status);
    for (const task of tasks) {
      const nextStatus = task.live?.status || task.status;
      const oldStatus = previousStatuses.get(task.id);
      const finished = ['completed', 'failed'].includes(nextStatus);
      if (oldStatus && oldStatus !== nextStatus && finished) {
        const failed = nextStatus === 'failed';
        toast(`${task.id} ${failed ? '处理失败' : '识别已完成'}`, failed ? 'error' : 'success');
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(failed ? '海瞳任务处理失败' : '海瞳任务识别完成', { body: `${task.id} 状态已更新` });
        }
      }
    }
    previousStatuses = new Map([...next].filter(([, status]) => ['pending', 'processing', '处理中'].includes(status)));
  }

  function renderHistory() {
    const search = el('input', { type: 'search', value: searchValue, placeholder: '搜索任务编号或文件名', 'aria-label': '搜索任务' });
    const level = el('select', { className: 'field-select compact', 'aria-label': '污染等级筛选' }, [
      el('option', { value: '', textContent: '全部等级' }),
      ...['优', '良', '中', '差', '严重'].map((item) => el('option', { value: item, textContent: item })),
    ]);
    level.value = levelValue;
    const searchBtn = el('button', { className: 'btn-primary search-submit' }, [icon('search', 17), '搜索']);
    const controls = el('div', { className: 'history-controls' }, [
      el('div', { className: 'search-field' }, [icon('search', 17), search]), level, searchBtn,
    ]);
    const list = el('div', { className: 'history-results' });
    body.append(controls, list);
    const run = () => {
      searchValue = search.value.trim();
      levelValue = level.value;
      sessionStorage.setItem('haitong-task-search', searchValue);
      sessionStorage.setItem('haitong-task-level', levelValue);
      loadHistory(list);
    };
    searchBtn.addEventListener('click', run);
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
    level.addEventListener('change', run);
    loadHistory(list);
  }

  async function loadHistory(list) {
    clear(list);
    list.append(...skeletonList(3));
    try {
      const data = await api.getDetections(1, 20, { query: searchValue, level: levelValue, signal: controller.signal });
      if (!mounted || segment !== 'history') return;
      clear(list);
      const items = data?.items || [];
      if (!items.length) {
        list.append(emptyState('search', '没有匹配任务', '调整搜索词或筛选条件后重试'));
        return;
      }
      list.append(el('p', { className: 'result-count', textContent: `共 ${data.total ?? items.length} 条，当前显示前 ${items.length} 条` }));
      const rows = el('div', { className: 'task-list' });
      for (const task of items) rows.append(historyCard(task, navigate));
      list.append(rows);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        clear(list);
        list.append(errorState(error.message || '历史加载失败', () => loadHistory(list)));
      }
    }
  }

  function renderReports() {
    body.append(...skeletonList(3));
    loadReports();
  }

  async function loadReports() {
    try {
      const data = await api.getReports();
      if (!mounted || segment !== 'reports') return;
      clear(body);
      const items = data?.items || [];
      body.append(el('div', { className: 'report-section-head' }, [
        el('div', {}, [el('strong', { textContent: `${data?.total ?? items.length} 份报告` }), el('small', { textContent: '报告由服务端排版，手机仅负责查看与分享' })]),
        el('button', { className: 'btn-ghost btn-sm', onClick: () => switchSegment('history') }, ['选择任务生成']),
      ]));
      if (!items.length) {
        body.append(emptyState('fileChart', '暂无质量报告', '进入已完成任务详情即可生成报告'));
        return;
      }
      const list = el('div', { className: 'report-list' });
      for (const report of items) list.append(reportCard(report));
      body.append(list);
    } catch (error) {
      if (error?.name !== 'AbortError' && segment === 'reports') {
        clear(body);
        body.append(errorState(error.message || '报告加载失败', loadReports));
      }
    }
  }

  function reportCard(report) {
    const card = el('article', { className: 'report-card' }, [
      el('div', { className: 'report-card-top' }, [
        el('div', {}, [el('strong', { textContent: report.title || report.id }), el('small', { textContent: `${report.area || '未指定海域'} · ${report.createdAt || ''}` })]),
        levelBadge(report.level || '未评估'),
      ]),
      el('div', { className: 'report-metrics' }, [
        el('span', {}, ['质量分 ', el('b', { textContent: report.score ?? '—' })]),
        el('span', {}, ['目标 ', el('b', { textContent: report.objectCount ?? 0 })]),
      ]),
    ]);
    const actions = el('div', { className: 'report-actions' }, [
      el('button', { className: 'btn-primary btn-sm', onClick: () => openReport(report) }, [icon('eye', 15), '查看']),
      el('button', { className: 'btn-ghost btn-sm', onClick: () => shareReport(report) }, [icon('upload', 15), '分享']),
      el('button', { className: 'btn-ghost btn-sm', onClick: () => {
        state.guardianContext = { type: 'report', id: taskNumber(report.id), label: report.title };
        navigate('guardian');
      } }, [icon('message', 15), 'AI 解读']),
      el('button', { className: 'icon-btn danger', 'aria-label': '删除报告', onClick: () => removeReport(report) }, [icon('trash', 16)]),
    ]);
    card.append(actions);
    return card;
  }

  async function openReport(report) {
    const popup = window.open('about:blank', '_blank');
    try {
      const html = await api.getReportPreview(report.id, { signal: controller.signal });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      if (popup) popup.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      popup?.close();
      toast(error.message || '报告打开失败', 'error');
    }
  }

  async function shareReport(report) {
    try {
      const html = await api.getReportPreview(report.id, { signal: controller.signal });
      const file = new File([html], `${report.id}.html`, { type: 'text/html' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: report.title, text: report.summary || '海瞳质量报告', files: [file] });
      } else {
        const url = URL.createObjectURL(file);
        const anchor = el('a', { href: url, download: `${report.id}.html` });
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('当前浏览器不支持文件分享，已下载报告', 'info');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') toast(error.message || '报告分享失败', 'error');
    }
  }

  async function removeReport(report) {
    if (!window.confirm(`确认删除“${report.title || report.id}”？此操作不可撤销。`)) return;
    try {
      await api.deleteReport(report.id);
      toast('报告已删除', 'success');
      loadReports();
    } catch (error) {
      toast(error.message || '删除失败', 'error');
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (mounted && visible && segment === 'active') timer = setTimeout(() => loadActive(), delay);
  }

  function stopPolling() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    unmount() {
      mounted = false;
      stopPolling();
      controller.abort();
    },
    onHide() {
      visible = false;
      stopPolling();
      controller.abort();
      loadEpoch += 1;
      loading = false;
    },
    onShow() {
      if (!mounted) return;
      loading = false;
      controller.abort();
      controller = new AbortController();
      if (segment === 'active') timer = setTimeout(() => loadActive(true), 0);
      else renderSegment();
    },
  };
}

function activeCard(task, navigate) {
  const live = task.live || {};
  const progress = Math.max(0, Math.min(100, live.progress ?? 8));
  return el('button', { className: 'active-task-card', onClick: () => navigate('detail', { id: taskNumber(task.id) }) }, [
    el('div', { className: 'active-task-top' }, [
      el('span', { className: `task-type-badge type-${task.type === '视频' ? 'video' : 'image'}` }, [icon(task.type === '视频' ? 'video' : 'image', 18)]),
      el('div', {}, [el('strong', { textContent: task.id }), el('small', { textContent: `${task.location || '未指定海域'} · ${task.type || '检测'}` })]),
      el('b', { textContent: `${progress}%` }),
    ]),
    progressBar(progress, true),
    el('div', { className: 'active-task-foot' }, [
      el('span', { textContent: stageText(live.status) }),
      el('span', { textContent: live.processing_time != null ? `已耗时 ${Number(live.processing_time).toFixed(1)} 秒` : '服务端处理中' }),
    ]),
  ]);
}

function historyCard(task, navigate) {
  return el('button', { className: 'task-row surface-card', onClick: () => navigate('detail', { id: taskNumber(task.id) }) }, [
    el('span', { className: `task-type-badge type-${task.type === '视频' ? 'video' : 'image'}` }, [icon(task.type === '视频' ? 'video' : 'image', 18)]),
    el('span', { className: 'task-info' }, [
      el('span', { className: 'task-top' }, [el('strong', { textContent: task.id }), statusBadge(task.status)]),
      el('span', { className: 'task-meta' }, [task.location || '未指定海域', ' · ', timeAgo(task.createdAt)]),
    ]),
    task.level ? levelBadge(task.level) : icon('chevronRight', 17),
  ]);
}

function taskNumber(id) {
  const match = String(id ?? '').match(/(\d+)$/);
  return match ? Number(match[1]) : id;
}

function stageText(status) {
  return ({ pending: '等待服务端调度', processing: '正在执行模型识别', completed: '处理完成', failed: '处理失败' }[status] || '正在处理');
}
