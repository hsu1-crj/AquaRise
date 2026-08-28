import test from 'node:test';
import assert from 'node:assert/strict';

const guideModule = await import('../src/frontend/public/haitong/assets/js/atlas-guide.mjs')
  .catch(() => ({}));

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test('首次进入生命图谱时自动显示使用指南', () => {
  const tracker = guideModule.createAtlasGuideVisitTracker?.(createMemoryStorage());

  assert.equal(tracker?.shouldAutoOpen(), true);
});

test('主动完成指南后不在下次进入时重复弹出', () => {
  const storage = createMemoryStorage();
  const tracker = guideModule.createAtlasGuideVisitTracker?.(storage);

  tracker?.markSeen();

  assert.equal(tracker?.shouldAutoOpen(), false);
});

test('存储不可用时仍优先向新用户展示指南', () => {
  const unavailableStorage = {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('storage unavailable');
    },
  };
  const tracker = guideModule.createAtlasGuideVisitTracker?.(unavailableStorage);

  assert.equal(tracker?.shouldAutoOpen(), true);
  assert.doesNotThrow(() => tracker?.markSeen());
});

test('自动弹出等待期间已手动看完指南时不再二次弹出', () => {
  const scheduled = [];
  const timers = {
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout() {},
  };
  const tracker = guideModule.createAtlasGuideVisitTracker?.(createMemoryStorage(), undefined, timers);
  let openCount = 0;

  const wasScheduled = tracker?.scheduleAutoOpen?.(() => { openCount += 1; }, 2600);
  tracker?.markSeen();
  scheduled[0]?.();

  assert.equal(wasScheduled, true);
  assert.equal(openCount, 0);
});
