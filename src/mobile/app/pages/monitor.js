/**
 * monitor.js — 实时任务监控页（移动端核心功能）
 * ============================================================
 * 用户友好设计：
 *   - 每 3 秒轮询 /detections 获取任务列表
 *   - 对进行中任务并发调用 /detect/status/{id} 获取真实进度
 *   - 进行中任务置顶高亮 + 真实进度条 / 耗时
 *   - 任务状态变化时 Toast + 振动提醒
 *   - 页面不可见时自动暂停轮询（省电省流）
 *   - AbortController 保证卸载后不残留请求
 *   - 互斥锁防止慢请求下轮询重叠
 */

import { api, isLoggedIn } from '../api.js';
import { el, clear, icon, toast, levelBadge, statusBadge, progressBar, skeletonList, emptyState, errorState, timeAgo } from '../ui.js';
import { updateConnectionStatus } from '../main.js';

const POLL_INTERVAL = 3000;
// 后端英文枚举 → 前端中文（与 /detections 返回格式一致）
const STATUS_MAP = { pending: '处理中', processing: '处理中', completed: '已完成', failed: '失败' };
const LEVEL_MAP = { excellent: '优', good: '良', moderate: '中', poor: '差', severe: '严重' };

export function renderMonitor(container, ctx) {
  const { navigate } = ctx;
  let pollTimer = null;
  let clockTimer = null;
  let isMounted = true;
  let isVisible = true;
  let isPolling = false;            // 互斥锁：防止轮询重叠
  let lastSync = null;
  let prevTaskStatuses = {};
  let firstLoad = true;
  let abortController = new AbortController();

  const page = el('div', { className: 'page-pad' });
  container.append(page);

  // ---- 标题区 ----
  const header = el('div', { className: 'monitor-header' }, [
    el('div', {}, [
      el('h2', { textContent: '实时任务监控' }),
      el('p', { className: 'monitor-sub', id: 'monitor-sync-time', textContent: '正在同步…' }),
    ]),
    el('button', {
      className: 'btn-icon-circle',
      'aria-label': '手动刷新',
      onClick: () => loadTasks(true),
    }, [icon('refresh', 20)]),
  ]);
  page.append(header);

  // ---- 活跃任务汇总 ----
  page.append(el('div', { className: 'monitor-summary glass' }, [
    el('div', { className: 'summary-item' }, [
      el('span', { className: 'summary-pulse-dot' }),
      el('div', {}, [
        el('strong', { id: 'active-count', textContent: '0' }),
        el('small', { textContent: '进行中' }),
      ]),
    ]),
    el('div', { className: 'summary-divider' }),
    el('div', { className: 'summary-item' }, [
      el('div', { className: 'summary-icon green' }, [icon('checkCircle', 18)]),
      el('div', {}, [
        el('strong', { id: 'done-count', textContent: '0' }),
        el('small', { textContent: '已完成' }),
      ]),
    ]),
    el('div', { className: 'summary-divider' }),
    el('div', { className: 'summary-item' }, [
      el('div', { className: 'summary-icon red' }, [icon('alert', 18)]),
      el('div', {}, [
        el('strong', { id: 'fail-count', textContent: '0' }),
        el('small', { textContent: '失败' }),
      ]),
    ]),
  ]));

  // ---- 进行中任务区 ----
  page.append(el('section', {
    className: 'section-block', id: 'active-section', style: { display: 'none' },
  }, [
    el('h3', { className: 'section-title live-title' }, [
      el('span', { className: 'live-dot pulse' }), '正在处理',
    ]),
    el('div', { className: 'task-list', id: 'active-list' }),
  ]));

  // ---- 全部任务区 ----
  page.append(el('section', { className: 'section-block' }, [
    el('div', { className: 'section-header' }, [
      el('h3', { className: 'section-title', textContent: '任务列表' }),
    ]),
    el('div', { className: 'task-list', id: 'all-list' }),
  ]));

  document.getElementById('all-list').append(...skeletonList(3));

  // ---- 核心轮询 ----
  async function loadTasks(manual = false) {
    if (!isMounted || isPolling) return;
    if (!isLoggedIn()) return;

    isPolling = true;
    try {
      // 1) 拉取任务列表
      const data = await api.getDetections(1, 50, { signal: abortController.signal });
      if (!isMounted) return;
      updateConnectionStatus(true);

      const items = (data?.items ?? []).map((t) => ({ ...t }));

      // 2) 对进行中任务并发查询实时进度
      const activeTasks = items.filter((t) => t.status === '处理中');
      if (activeTasks.length) {
        const statuses = await Promise.allSettled(
          activeTasks.map((t) => {
            const id = (t.id || '').replace('DET-', '');
            return api.getTaskStatus(id, { signal: abortController.signal, timeout: 8000 });
          }),
        );
        activeTasks.forEach((task, i) => {
          const r = statuses[i];
          if (r.status === 'fulfilled' && r.value) {
            task._progress = r.value.progress;
            task._processingTime = r.value.processing_time;
            // 将权威实时状态合并回任务字段，确保 processTasks 分类与通知使用最新值
            const rtZh = STATUS_MAP[r.value.status];
            if (rtZh) task.status = rtZh;
            if (r.value.total_objects != null) task.objectCount = r.value.total_objects;
            if (r.value.pollution_level) task.level = LEVEL_MAP[r.value.pollution_level] || task.level;
          }
        });
      }

      if (!isMounted) return;
      processTasks(items);
      firstLoad = false;
      lastSync = new Date();
      updateSyncTime();
    } catch (err) {
      if (!isMounted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      updateConnectionStatus(false);
      if (manual) toast(err.message || '刷新失败', 'error');
      if (firstLoad) {
        clear(document.getElementById('all-list'));
        document.getElementById('all-list').append(
          errorState(err.message || '加载失败', () => loadTasks(true)),
        );
        firstLoad = false;
      }
    } finally {
      isPolling = false;
    }
  }


  function processTasks(items) {
    const active = items.filter((t) => t.status === '处理中');
    const done = items.filter((t) => t.status === '已完成');
    const failed = items.filter((t) => t.status === '失败');

    document.getElementById('active-count').textContent = active.length;
    document.getElementById('done-count').textContent = done.length;
    document.getElementById('fail-count').textContent = failed.length;

    // 状态变化通知
    for (const task of items) {
      const prev = prevTaskStatuses[task.id];
      if (prev && prev !== task.status) {
        if (task.status === '已完成') {
          toast(`任务完成：${task.type}检测 · ${task.objectCount} 个目标`, 'success', 4000);
        } else if (task.status === '失败') {
          toast(`任务失败：${task.type}检测`, 'error', 4000);
        }
      }
      prevTaskStatuses[task.id] = task.status;
    }

    // 渲染进行中
    const activeList = document.getElementById('active-list');
    const activeSec = document.getElementById('active-section');
    clear(activeList);
    if (active.length) {
      activeSec.style.display = 'block';
      for (const task of active) activeList.append(buildActiveCard(task, navigate));
    } else {
      activeSec.style.display = 'none';
    }

    // 渲染全部
    const allList = document.getElementById('all-list');
    clear(allList);
    if (!items.length) {
      allList.append(emptyState('radar', '暂无检测任务', '在主机端提交图片或视频检测后，这里会实时显示处理进度'));
    } else {
      for (const task of items.slice(0, 30)) allList.append(buildTaskCard(task, navigate));
    }
  }

  function updateSyncTime() {
    const node = document.getElementById('monitor-sync-time');
    if (!node) return;
    if (!lastSync) { node.textContent = '正在同步…'; return; }
    const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    node.textContent = `最后同步：${fmt(lastSync)}`;
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(loadTasks, POLL_INTERVAL);
  }

  loadTasks();
  startPolling();
  clockTimer = setInterval(updateSyncTime, 1000);

  return {
    unmount() {
      isMounted = false;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
      abortController.abort();
    },
    onHide() {
      isVisible = false;
      clearInterval(pollTimer);
      abortController.abort();
    },
    onShow() {
      if (!isVisible) {
        isVisible = true;
        // 新建 AbortController（旧的已被卸载中断）
        abortController = new AbortController();
        loadTasks();
        startPolling();
      }
    },
  };
}

// ============ 子组件 ============

function buildActiveCard(task, navigate) {
  const taskId = (task.id || '').replace('DET-', '');
  const progress = task._progress ?? 0;
  const elapsed = task._processingTime;
  const isPending = task._rtStatus === 'pending';

  // 进度条：pending → 不确定动画；processing → 真实百分比
  const bar = isPending || progress === 0
    ? progressBar(0, true)
    : progressBar(progress, false);

  const hint = el('p', { className: 'active-task-hint' });
  if (isPending) {
    hint.textContent = '排队等待中…';
  } else if (elapsed != null) {
    hint.textContent = `主机端推理中 · 已用时 ${elapsed.toFixed(1)}s`;
  } else {
    hint.textContent = '主机端正在推理中…';
  }

  return el('div', {
    className: 'active-task-card',
    onClick: () => taskId && navigate(`detail/${taskId}`, { id: taskId, _raw: true }),
  }, [
    el('div', { className: 'active-task-top' }, [
      el('div', { className: `task-type-badge type-${task.type === '视频' ? 'video' : 'image'}` },
        [icon(task.type === '视频' ? 'video' : 'image', 16)]),
      el('div', { className: 'active-task-info' }, [
        el('strong', { textContent: `${task.type}检测任务` }),
        el('span', { textContent: timeAgo(task.createdAt) }),
      ]),
      statusBadge(task.status),
    ]),
    bar,
    hint,
  ]);
}

function buildTaskCard(task, navigate) {
  const taskId = (task.id || '').replace('DET-', '');
  return el('div', {
    className: 'task-row glass',
    onClick: () => taskId && navigate(`detail/${taskId}`, { id: taskId, _raw: true }),
  }, [
    el('div', { className: `task-type-badge type-${task.type === '视频' ? 'video' : 'image'}` },
      [icon(task.type === '视频' ? 'video' : 'image', 16)]),
    el('div', { className: 'task-info' }, [
      el('div', { className: 'task-top' }, [
        el('strong', { textContent: `${task.type}检测` }),
        statusBadge(task.status),
      ]),
      el('div', { className: 'task-meta' }, [
        el('span', { textContent: `${task.objectCount} 个目标` }),
        el('span', { className: 'dot-sep' }),
        el('span', { textContent: timeAgo(task.createdAt) }),
      ]),
    ]),
    levelBadge(task.level || '优'),
  ]);
}
