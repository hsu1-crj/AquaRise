const DEFAULT_GUIDE_SEEN_KEY = 'haitong-guide-seen-v2';

export function resolveAtlasShortcut({ key, typing = false, ctrlKey = false, metaKey = false } = {}) {
  if (typing) return null;
  const normalized = String(key ?? '').toLowerCase();
  if (normalized === 'f') return 'toggle-fullscreen';
  if (normalized === '/' || (normalized === 'k' && (ctrlKey || metaKey))) return 'open-search';
  return null;
}

export function getExplorationGuidance({ lifeMode = 'planet', uiState = 'planet' } = {}) {
  if (uiState === 'returning') {
    return {
      step: 1,
      title: '正在返回地球',
      detail: '稍后即可重新选择物种',
      action: null,
      actionLabel: '返回中…',
    };
  }
  if (lifeMode === 'species' || uiState === 'species') {
    return {
      step: 3,
      title: '阅读物种档案',
      detail: '听讲述、问助手或查看全球观测',
      action: 'return',
      actionLabel: '返回地球',
    };
  }
  if (uiState === 'diving') {
    return {
      step: 2,
      title: '正在下潜观察',
      detail: '继续滚动，等待物种完成显影',
      action: null,
      actionLabel: '下潜中…',
    };
  }
  return {
    step: 1,
    title: '选择一个物种',
    detail: '搜索名称、学名或保护等级',
    action: 'search',
    actionLabel: '开始探索',
  };
}

export function getSoundControlCopy({ playing = false, blocked = false } = {}) {
  if (playing) return '暂停声音';
  if (blocked) return '开启声音';
  return '声音';
}

export function getDemoControlCopy({ active = false } = {}) {
  return active ? '停止导览' : '自动导览';
}

const DEMO_NARRATION_FAST_MS = 3200;
const DEMO_NARRATION_FULL_MS = 45000;

export function resolveDemoNarrationBudget({ kinds = {} } = {}) {
  // 任一物种声道真的在响，就等独白完整播完再切换物种；
  // 全部被浏览器拦截或资源缺失时，沿用短超时保住导览节奏。
  const playing = ['ambience', 'call', 'voice'].some(kind => kinds[kind] === 'playing');
  return playing ? DEMO_NARRATION_FULL_MS : DEMO_NARRATION_FAST_MS;
}

export function createAtlasGuideVisitTracker(
  storage,
  key = DEFAULT_GUIDE_SEEN_KEY,
  // 必须绑定到全局：shorthand 裸引用在调用时 this 变成 timers 对象，
  // 新版 Chrome 对未绑定的 window.setTimeout 抛 "Illegal invocation"，
  // 导致首次进入自动弹出指南失效。
  timers = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) },
) {
  let pendingAutoOpen = null;
  const shouldAutoOpen = () => {
    try {
      return storage?.getItem(key) !== '1';
    } catch {
      return true;
    }
  };
  const cancelAutoOpen = () => {
    if (pendingAutoOpen === null) return;
    timers.clearTimeout(pendingAutoOpen);
    pendingAutoOpen = null;
  };

  return {
    shouldAutoOpen,
    scheduleAutoOpen(callback, delayMs) {
      if (!shouldAutoOpen()) return false;
      cancelAutoOpen();
      pendingAutoOpen = timers.setTimeout(() => {
        pendingAutoOpen = null;
        if (shouldAutoOpen()) callback();
      }, delayMs);
      return true;
    },
    cancelAutoOpen,
    markSeen() {
      cancelAutoOpen();
      try {
        storage?.setItem(key, '1');
      } catch {
        // 隐私模式或禁用存储时不阻断指南关闭。
      }
    },
  };
}
