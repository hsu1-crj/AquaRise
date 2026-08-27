import test from 'node:test';
import assert from 'node:assert/strict';

import { createFpsFuse } from '../src/frontend/public/haitong/assets/js/bloom-policy.mjs';

test('单个慢帧不会触发 Bloom 性能降级', () => {
  let trips = 0;
  const fuse = createFpsFuse({ windowSize: 4, threshold: 30, sustainedWindows: 2, onTrip: () => { trips += 1; } });

  [60, 60, 5, 60, 60].forEach(fps => fuse.push(fps));

  assert.equal(fuse.tripped, false);
  assert.equal(trips, 0);
});

test('连续低于阈值的滑动平均只触发一次降级', () => {
  let trips = 0;
  const fuse = createFpsFuse({ windowSize: 4, threshold: 30, sustainedWindows: 2, onTrip: () => { trips += 1; } });

  [20, 20, 20, 20, 20, 20].forEach(fps => fuse.push(fps));

  assert.equal(fuse.tripped, true);
  assert.equal(trips, 1);
  assert.equal(fuse.average, 20);
});

test('健康平均帧率会清除尚未达标的低帧率连续计数', () => {
  let trips = 0;
  const fuse = createFpsFuse({ windowSize: 3, threshold: 30, sustainedWindows: 3, onTrip: () => { trips += 1; } });

  [20, 20, 20, 60, 60, 20, 20, 20].forEach(fps => fuse.push(fps));

  assert.equal(fuse.tripped, false);
  assert.equal(trips, 0);
});

test('保险丝触发后保持锁定，reset 才恢复采样', () => {
  let trips = 0;
  const fuse = createFpsFuse({ windowSize: 2, threshold: 30, sustainedWindows: 1, onTrip: () => { trips += 1; } });

  fuse.push(10);
  fuse.push(10);
  fuse.push(60);
  assert.equal(fuse.tripped, true);
  assert.equal(trips, 1);

  fuse.reset();
  assert.equal(fuse.tripped, false);
  assert.equal(fuse.average, 0);
  fuse.push(60);
  fuse.push(60);
  assert.equal(fuse.tripped, false);
});
