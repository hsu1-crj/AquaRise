/*
 * hand-gestures.mjs 纯数学分类器的 Node 单测（与模块头注释声明的路径一致）。
 * 运行：node --test tests/hand-gestures.test.mjs
 * 几何约定：归一化坐标 y 轴向下，腕部在画面下方（y≈0.95），手指向上伸展距离变远。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHandGesture, HAND_LM, HAND_RULES } from '../src/frontend/public/haitong/assets/js/hand-gestures.mjs';

const L = HAND_LM;
const WRIST = { x: 0.5, y: 0.95 };

function blankHand() {
  const pts = Array.from({ length: 21 }, () => ({ ...WRIST }));
  pts[L.WRIST] = { ...WRIST };
  // 拇指默认收拢贴掌：指尖比 IP 更靠近腕部
  pts[L.THUMB_MCP] = { x: 0.52, y: 0.88 };
  pts[L.THUMB_IP] = { x: 0.53, y: 0.91 };
  pts[L.THUMB_TIP] = { x: 0.51, y: 0.93 };
  return pts;
}

// 四指完全卷曲：PIP/TIP 都比 MCP 更贴近腕部（沿腕→MCP 方向按比例内收）
function curlFinger(pts, mcpIdx) {
  const w = pts[L.WRIST];
  const mcp = pts[mcpIdx];
  const len = Math.hypot(mcp.x - w.x, mcp.y - w.y) || 1e-6;
  const ux = (mcp.x - w.x) / len;
  const uy = (mcp.y - w.y) / len;
  pts[mcpIdx + 1] = { x: w.x + ux * len * 0.78, y: w.y + uy * len * 0.78 }; // PIP
  pts[mcpIdx + 2] = { x: w.x + ux * len * 0.70, y: w.y + uy * len * 0.70 }; // DIP（未使用）
  pts[mcpIdx + 3] = { x: w.x + ux * len * 0.72, y: w.y + uy * len * 0.72 }; // TIP
}

// 手指伸直：PIP/TIP 沿腕→MCP 方向逐级远离腕部
function extendFinger(pts, mcpIdx) {
  const w = pts[L.WRIST];
  const mcp = pts[mcpIdx];
  const len = Math.hypot(mcp.x - w.x, mcp.y - w.y) || 1e-6;
  const ux = (mcp.x - w.x) / len;
  const uy = (mcp.y - w.y) / len;
  pts[mcpIdx + 1] = { x: w.x + ux * len * 2.1, y: w.y + uy * len * 2.1 };
  pts[mcpIdx + 2] = { x: w.x + ux * len * 2.9, y: w.y + uy * len * 2.9 };
  pts[mcpIdx + 3] = { x: w.x + ux * len * 3.4, y: w.y + uy * len * 3.4 };
}

// 半弯曲：既不满足伸直判据（比值 ≤ 阈值），又保持 curlRatio ≈ 1.01 高于握拳阈值，
// 用于 pinch/ok 这类"四指不全握"的手势。
function semiCurlFinger(pts, mcpIdx) {
  const w = pts[L.WRIST];
  const mcp = pts[mcpIdx];
  const len = Math.hypot(mcp.x - w.x, mcp.y - w.y) || 1e-6;
  const ux = (mcp.x - w.x) / len;
  const uy = (mcp.y - w.y) / len;
  pts[mcpIdx + 1] = { x: w.x + ux * len * 1.005, y: w.y + uy * len * 1.005 };
  pts[mcpIdx + 2] = { x: w.x + ux * len * 1.008, y: w.y + uy * len * 1.008 };
  pts[mcpIdx + 3] = { x: w.x + ux * len * 1.01, y: w.y + uy * len * 1.01 };
}

function palmHand() {
  const pts = blankHand();
  [L.IDX_MCP, L.MID_MCP, L.RNG_MCP, L.PKY_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    extendFinger(pts, i);
  });
  // 拇指外展竖起：指尖高于 IP/MCP 且远离腕部
  pts[L.THUMB_TIP] = { x: 0.63, y: 0.58 };
  pts[L.THUMB_IP] = { x: 0.57, y: 0.74 };
  return pts;
}

test('张开手掌 → palm', () => {
  const r = classifyHandGesture(palmHand());
  assert.equal(r.name, 'palm');
  assert.ok(r.metrics && typeof r.metrics.n4 === 'number');
});

test('四指全收拇指收拢 → fist', () => {
  const pts = blankHand();
  [L.IDX_MCP, L.MID_MCP, L.RNG_MCP, L.PKY_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    curlFinger(pts, i);
  });
  const r = classifyHandGesture(pts);
  assert.equal(r.name, 'fist');
});

test('食指中指伸直 → peace', () => {
  const pts = blankHand();
  [L.IDX_MCP, L.MID_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    extendFinger(pts, i);
  });
  [L.RNG_MCP, L.PKY_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    curlFinger(pts, i);
  });
  const r = classifyHandGesture(pts);
  assert.equal(r.name, 'peace');
});

test('捏合且其余三指收拢 → pinch', () => {
  const pts = blankHand();
  [L.RNG_MCP, L.PKY_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    semiCurlFinger(pts, i);
  });
  pts[L.MID_MCP] = { x: 0.48, y: 0.82 };
  semiCurlFinger(pts, L.MID_MCP);
  pts[L.IDX_MCP] = { x: 0.47, y: 0.80 };
  extendFinger(pts, L.IDX_MCP);
  // 拇指尖与食指尖捏合成圈
  pts[L.THUMB_TIP] = { ...pts[L.IDX_TIP] };
  pts[L.THUMB_IP] = { x: pts[L.IDX_TIP].x + 0.03, y: pts[L.IDX_TIP].y + 0.06 };
  const r = classifyHandGesture(pts);
  assert.equal(r.name, 'pinch');
});

test('捏合并三指伸直 → ok', () => {
  const pts = blankHand();
  [L.IDX_MCP, L.MID_MCP, L.RNG_MCP, L.PKY_MCP].forEach(i => {
    pts[i] = { x: pts[i].x - 0.02, y: 0.82 };
    extendFinger(pts, i);
  });
  pts[L.THUMB_TIP] = { ...pts[L.IDX_TIP] };
  pts[L.THUMB_IP] = { x: pts[L.IDX_TIP].x + 0.02, y: pts[L.IDX_TIP].y + 0.05 };
  const r = classifyHandGesture(pts);
  assert.equal(r.name, 'ok');
});

test('关键点不足 21 个 → unknown', () => {
  const r = classifyHandGesture(blankHand().slice(0, 20));
  assert.equal(r.name, 'unknown');
  assert.equal(r.score, 0);
});

test('坐标含 NaN 的坏帧 → unknown（不得落入 grip）', () => {
  const pts = palmHand();
  pts[8].x = NaN;
  const r = classifyHandGesture(pts);
  assert.equal(r.name, 'unknown');
  assert.equal(r.score, 0);
  assert.equal(r.metrics, null);
});

test('非数组输入 → unknown', () => {
  assert.equal(classifyHandGesture(null).name, 'unknown');
  assert.equal(classifyHandGesture(undefined).name, 'unknown');
});

test('HAND_RULES 暴露可调阈值且取值在合理区间', () => {
  for (const value of Object.values(HAND_RULES)) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value) && value > 0 && value < 5);
  }
});
