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

test('F 键在非输入状态触发全屏，输入框内不抢占按键', () => {
  assert.equal(
    guideModule.resolveAtlasShortcut?.({ key: 'f', typing: false, ctrlKey: false, metaKey: false }),
    'toggle-fullscreen',
  );
  assert.equal(
    guideModule.resolveAtlasShortcut?.({ key: 'F', typing: true, ctrlKey: false, metaKey: false }),
    null,
  );
});

test('探索导航根据地球、下潜和档案状态给出下一步', () => {
  assert.deepEqual(
    guideModule.getExplorationGuidance?.({ lifeMode: 'planet', uiState: 'planet' }),
    {
      step: 1,
      title: '选择一个物种',
      detail: '搜索名称、学名或保护等级',
      action: 'search',
      actionLabel: '开始探索',
    },
  );
  assert.deepEqual(
    guideModule.getExplorationGuidance?.({ lifeMode: 'planet', uiState: 'diving' }),
    {
      step: 2,
      title: '正在下潜观察',
      detail: '继续滚动，等待物种完成显影',
      action: null,
      actionLabel: '下潜中…',
    },
  );
  assert.deepEqual(
    guideModule.getExplorationGuidance?.({ lifeMode: 'species', uiState: 'species' }),
    {
      step: 3,
      title: '阅读物种档案',
      detail: '听讲述、问助手或查看全球观测',
      action: 'return',
      actionLabel: '返回地球',
    },
  );
  assert.deepEqual(
    guideModule.getExplorationGuidance?.({ lifeMode: 'planet', uiState: 'returning' }),
    {
      step: 1,
      title: '正在返回地球',
      detail: '稍后即可重新选择物种',
      action: null,
      actionLabel: '返回中…',
    },
  );
});

test('声音按钮使用面向用户的状态文案', () => {
  assert.equal(guideModule.getSoundControlCopy?.({ playing: false, blocked: false }), '声音');
  assert.equal(guideModule.getSoundControlCopy?.({ playing: true, blocked: false }), '暂停声音');
  assert.equal(guideModule.getSoundControlCopy?.({ playing: false, blocked: true }), '开启声音');
});

test('自动导览按钮明确显示未开始和可停止状态', () => {
  assert.equal(guideModule.getDemoControlCopy?.({ active: false }), '自动导览');
  assert.equal(guideModule.getDemoControlCopy?.({ active: true }), '停止导览');
});

test('音频真实在播时自动导览等待独白完整结束再切换', () => {
  assert.equal(
    guideModule.resolveDemoNarrationBudget?.({
      kinds: { ambience: 'playing', call: 'unloaded', voice: 'unloaded' },
    }),
    45000,
  );
  assert.equal(
    guideModule.resolveDemoNarrationBudget?.({
      kinds: { ambience: 'playing', call: 'paused', voice: 'playing' },
    }),
    45000,
  );
});

test('音频被浏览器拦截或资源缺失时自动导览保持快速切换', () => {
  assert.equal(
    guideModule.resolveDemoNarrationBudget?.({
      kinds: { ambience: 'blocked', call: 'blocked', voice: 'blocked' },
    }),
    3200,
  );
  assert.equal(
    guideModule.resolveDemoNarrationBudget?.({
      kinds: { ambience: 'unloaded', call: 'unloaded', voice: 'unloaded' },
    }),
    3200,
  );
  assert.equal(guideModule.resolveDemoNarrationBudget?.({}), 3200);
});
