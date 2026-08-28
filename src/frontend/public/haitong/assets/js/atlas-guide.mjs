const DEFAULT_GUIDE_SEEN_KEY = 'haitong-guide-seen-v2';

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
