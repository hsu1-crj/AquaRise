const DEFAULT_GUIDE_SEEN_KEY = 'haitong-guide-seen-v2';

export function createAtlasGuideVisitTracker(
  storage,
  key = DEFAULT_GUIDE_SEEN_KEY,
  timers = { setTimeout, clearTimeout },
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
