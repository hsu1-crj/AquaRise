import test from 'node:test';
import assert from 'node:assert/strict';

import { createPalmWaveTracker, PALM_WAVE_DEFAULTS } from '../src/frontend/public/haitong/assets/js/palm-wave.mjs';

/** 模拟一次连续挥动：from→to 用时 ms，按 stepMs 采样（= 检测帧率）。 */
function sweep({ from, to, ms, stepMs }, t0 = 1000) {
  const frames = [];
  for (let t = 0; t <= ms; t += stepMs) {
    frames.push({ t: t0 + t, x: from + (to - from) * (t / ms) });
  }
  return frames;
}

/** 跑完一串帧，返回所有判定结果。 */
function run(tracker, frames) {
  return frames.map(f => tracker.update(f.x, f.t));
}

test('快速挥动：高帧率机器（12fps）正常触发；x 增大=左挥(+1)/x 减小=右挥(-1)', () => {
  const left = run(createPalmWaveTracker(), sweep({ from: 60, to: 200, ms: 420, stepMs: 84 }));
  assert.ok(left.some(r => r.fired), '左挥（x 增大）应触发翻页');
  assert.equal(left.find(r => r.fired).direction, 1, 'x 增大 = 镜像里向左挥 = 下一物种');

  const right = run(createPalmWaveTracker(), sweep({ from: 200, to: 60, ms: 420, stepMs: 84 }));
  assert.ok(right.some(r => r.fired), '右挥（x 减小）应触发翻页');
  assert.equal(right.find(r => r.fired).direction, -1, 'x 减小 = 镜像里向右挥 = 上一物种');
});

test('回归：同样的挥动，低帧率机器（5fps）也必须触发（本次修复的核心）', () => {
  // 旧实现按帧滤 42%：5fps 时 420ms 的挥动只有 2-3 个采样点，滤波值收敛不足，
  // 28px 阈值攒不够 → 漏检。时间补偿后任意帧率收敛一致。
  const results = run(createPalmWaveTracker(), sweep({ from: 200, to: 60, ms: 420, stepMs: 200 }));
  assert.ok(results.some(r => r.fired), '低帧率下也应触发翻页');
});

test('极低帧率（3.3fps，300ms 一帧）下快速挥动仍可触发', () => {
  const results = run(createPalmWaveTracker(), sweep({ from: 210, to: 50, ms: 640, stepMs: 300 }));
  assert.ok(results.some(r => r.fired), '极低帧率下也应触发翻页');
});

test('抖动不误触：±5px 高频噪声不触发', () => {
  const tracker = createPalmWaveTracker();
  const noise = [3, -4, 5, -3, 4, -5, 2, -2, 4, -4, 5, -5, 3, -3, 4, -4, 2, -2, 5, -5];
  const results = noise.map((d, i) => tracker.update(160 + d, 1000 + i * 84));
  assert.ok(!results.some(r => r.fired), '噪声不应触发翻页');
});

test('慢速漂移不误触：窗口超时重新起算，travel 始终攒不够', () => {
  // 2 秒只漂 30px（0.015px/ms），1400ms 窗口内最多 21px < 28px 阈值。
  const results = run(createPalmWaveTracker(), sweep({ from: 160, to: 190, ms: 2000, stepMs: 100 }));
  assert.ok(!results.some(r => r.fired), '慢漂移不应触发翻页');
});

test('方向提示阈值：位移过 18px 但未到 28px 时进入 pending', () => {
  const results = run(createPalmWaveTracker(), sweep({ from: 200, to: 172, ms: 400, stepMs: 80 }));
  assert.ok(!results.some(r => r.fired), '22px 位移不应触发');
  assert.ok(results.some(r => r.pending !== 0), '过 18px 应出现方向提示');
});
test('触发后锁定：手停在半空不复触（原实现会冷却一过就连翻），回位后重新武装可再触发', () => {
  const tracker = createPalmWaveTracker();
  const first = run(tracker, sweep({ from: 200, to: 60, ms: 420, stepMs: 84 }));
  assert.ok(first.some(r => r.fired), '第一次挥动应触发');
  // 挥完手停在远端（x≈60）不动 —— 位移常驻 >28px，但已锁定，不得再触发
  const parked = [60, 62, 59, 61, 60, 63, 58].map((x, i) => tracker.update(x, 1600 + i * 84));
  assert.ok(!parked.some(r => r.fired), '手停在半空不应连翻页');
  // 手收回基线附近，重新武装
  const back = run(tracker, sweep({ from: 60, to: 196, ms: 400, stepMs: 80 }, 2400));
  assert.ok(!back.some(r => r.fired), '回位途中不应触发');
  // 再次完整左挥（x 增大跨过阈值）应再次触发
  const second = run(tracker, sweep({ from: 196, to: 330, ms: 420, stepMs: 84 }, 3200));
  assert.ok(second.some(r => r.fired && r.direction === 1), '重新武装后反向完整挥动应触发');
});

test('reset 清空状态后重新起算', () => {
  const tracker = createPalmWaveTracker();
  run(tracker, sweep({ from: 200, to: 120, ms: 300, stepMs: 84 }));
  tracker.reset();
  const after = tracker.update(120, 2000);
  assert.equal(Math.abs(after.travel), 0, '重置后 travel 归零');
  assert.equal(after.fired, false);
});

test('默认参数与页面内联实现的历史口径一致（28/18/1400/90ms）+ 2026-09 灵敏度调优值', () => {
  assert.equal(PALM_WAVE_DEFAULTS.travelPx, 28);
  assert.equal(PALM_WAVE_DEFAULTS.pendingPx, 18);
  assert.equal(PALM_WAVE_DEFAULTS.windowMs, 1400);
  assert.equal(PALM_WAVE_DEFAULTS.minWaveMs, 90);
  // 灵敏度二次调优（实测诊断 32/40px·124px/s 不触发）：
  // 速度线 260→200→120（滤波速度≈真实速度一半）；封顶 40→30（大手近距 32px 挥幅可触发）；
  // 手宽比例 0.6→0.5、下限 22→20（中远距离挥掌不必挥满半屏才响应）。
  assert.equal(PALM_WAVE_DEFAULTS.speedPxS, 120);
  assert.equal(PALM_WAVE_DEFAULTS.handRelTravel, 0.5);
  assert.equal(PALM_WAVE_DEFAULTS.travelMinPx, 20);
  assert.equal(PALM_WAVE_DEFAULTS.travelMaxPx, 30);
});

test('手宽自适应阈值：同一挥幅，画面里手越小阈值越低（补偿远距/广角），手过大封顶', () => {
  const sweepTo = (tracker, from, to, handW) => {
    let fired = false;
    for (let i = 0; i <= 5; i++) {
      const r = tracker.update(from + (to - from) * (i / 5), 1000 + i * 84, handW);
      if (r.fired) fired = true;
    }
    return fired;
  };
  // 40px 挥幅：滤波后可用行程≈28px；大手(90px→阈值封顶30)轻微移动不应触发
  const bigHand = createPalmWaveTracker();
  assert.ok(!sweepTo(bigHand, 200, 160, 90), '手大阈值升到30px封顶，滤波后≈28px不应触发');
  // 50px 挥幅（刻意挥动）：滤波后≈35px > 30px 封顶阈值，应触发——大手近距不再迟钝
  const bigHandWave = createPalmWaveTracker();
  assert.ok(sweepTo(bigHandWave, 200, 150, 90), '手大封顶30px，刻意挥动(滤波≈35px)应触发');
  // 典型手宽47px → 阈值 = 47×0.5 = 23.5px（2026-09 调优口径，旧值 47×0.6≈28）
  const typical = createPalmWaveTracker();
  const r = typical.update(200, 1000, 47);
  assert.ok(Math.abs(r.threshold - 23.5) < 0.5, `典型手宽阈值应≈23.5，实际 ${r.threshold}`);
});
