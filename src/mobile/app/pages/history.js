/**
 * history.js — 检测历史列表
 * ============================================================
 * 用户友好设计：
 *   - 按状态筛选（全部 / 已完成 / 处理中 / 失败）
 *   - 分页加载更多
 *   - 卡片点击进入详情
 *   - 空状态引导
 */

import { api, isLoggedIn } from '../api.js';
import { el, clear, icon, toast, levelBadge, statusBadge, skeletonList, emptyState, errorState, timeAgo } from '../ui.js';

const PAGE_SIZE = 20;

export function renderHistory(container, ctx) {
  const { navigate } = ctx;
  let isMounted = true;
  let currentPage = 1;
  let totalCount = 0;
  let allItems = [];
  let activeFilter = 'all';
  let abortController = new AbortController();

  const page = el('div', { className: 'page-pad' });
  container.append(page);

  // ---- 筛选条 ----
  const filterBar = el('div', { className: 'filter-chips' });
  const filters = [
    { id: 'all', label: '全部' },
    { id: 'done', label: '已完成' },
    { id: 'processing', label: '处理中' },
    { id: 'failed', label: '失败' },
  ];
  for (const f of filters) {
    const chip = el('button', {
      className: `chip${f.id === 'all' ? ' active' : ''}`,
      onClick: () => {
        activeFilter = f.id;
        filterBar.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        renderFiltered();
      },
    }, [f.label]);
    filterBar.append(chip);
  }
  page.append(filterBar);

  // ---- 列表区 ----
  const listWrap = el('div', { className: 'task-list', id: 'history-list' });
  page.append(listWrap);
  listWrap.append(...skeletonList(4));

  // ---- 加载更多 ----
  const loadMoreWrap = el('div', { className: 'load-more-wrap', style: { display: 'none' } });
  page.append(loadMoreWrap);

  async function loadData(pageNum = 1) {
    if (!isLoggedIn()) {
      clear(listWrap);
      listWrap.append(emptyState('history', '演示模式下无历史数据', '请在主机端登录后查看检测记录'));
      return;
    }
    try {
      const data = await api.getDetections(pageNum, PAGE_SIZE, { signal: abortController.signal });
      if (!isMounted) return;
      totalCount = data?.total ?? 0;
      const items = data?.items ?? [];
      if (pageNum === 1) { allItems = items; currentPage = 1; }
      else allItems = allItems.concat(items);
      renderFiltered();
      renderLoadMore();
    } catch (err) {
      if (!isMounted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      clear(listWrap);
      listWrap.append(errorState(err.message || '加载失败', () => loadData(1)));
    }
  }

  function renderFiltered() {
    clear(listWrap);
    let filtered = allItems;
    if (activeFilter === 'done') filtered = allItems.filter((t) => t.status === '已完成');
    else if (activeFilter === 'processing') filtered = allItems.filter((t) => t.status === '处理中');
    else if (activeFilter === 'failed') filtered = allItems.filter((t) => t.status === '失败');

    if (!filtered.length) {
      listWrap.append(emptyState('history', '暂无符合条件的记录', '尝试切换筛选条件或在主机端提交新任务'));
      return;
    }
    for (const task of filtered) listWrap.append(buildCard(task, navigate));
  }

  function renderLoadMore() {
    clear(loadMoreWrap);
    const hasMore = allItems.length < totalCount;
    loadMoreWrap.style.display = hasMore ? 'flex' : 'none';
    if (!hasMore) return;
    const btn = el('button', {
      className: 'btn-ghost btn-full',
      onClick: async () => {
        btn.disabled = true;
        btn.replaceChildren(el('span', { className: 'spinner-mini' }), '加载中…');
        currentPage++;
        await loadData(currentPage);
      },
    }, [icon('chevronDown', 18), '加载更多']);
    loadMoreWrap.append(btn);
  }

  loadData(1);

  return {
    unmount() {
      isMounted = false;
      abortController.abort();
    },
    onShow() {
      if (isMounted && allItems.length) loadData(1);
    },
  };
}

function buildCard(task, navigate) {
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
    el('div', { className: 'task-right' }, [
      levelBadge(task.level || '优'),
      el('span', { className: 'task-chevron' }, [icon('chevronRight', 16)]),
    ]),
  ]);
}
