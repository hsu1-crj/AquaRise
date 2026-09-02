import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_DEG_W,
  MAP_DEG_H,
  MASK_W,
  MASK_H,
  fitView,
  clampView,
  zoomViewAt,
  panView,
  lonLatToProject,
  projectToScreen,
  screenToLonLat,
  formatLatLon,
  findNearestPoint,
  maskHasLand,
} from '../src/frontend/public/haitong/assets/js/gbif-flat-map.mjs';

test('等距圆柱投影把经纬度映射到 360×180 投影空间', () => {
  const topLeft = lonLatToProject(-180, 90);
  assert.deepEqual(topLeft, { x: 0, y: 0 });
  const bottomRight = lonLatToProject(180, -90);
  assert.deepEqual(bottomRight, { x: MAP_DEG_W, y: MAP_DEG_H });
  const center = lonLatToProject(0, 0);
  assert.deepEqual(center, { x: 180, y: 90 });
});

test('投影与屏幕坐标往返一致', () => {
  const view = { scale: 2, offsetX: 40, offsetY: 20 };
  const project = lonLatToProject(114.2, 31);
  const screen = projectToScreen(project, view);
  const roundTrip = screenToLonLat(screen.x, screen.y, view);
  assert.ok(Math.abs(roundTrip.lon - 114.2) < 1e-9);
  assert.ok(Math.abs(roundTrip.lat - 31) < 1e-9);
});

test('初始视图把 2:1 地图完整 contain 进画布', () => {
  const wide = fitView(1000, 400);
  assert.equal(wide.scale, Math.min(940 / 360, 340 / 180));
  assert.ok(wide.offsetX > 0 && wide.offsetY > 0);
  const mapBottom = wide.offsetY + MAP_DEG_H * wide.scale;
  assert.ok(mapBottom <= 400 + 1e-9);
  const mapRight = wide.offsetX + MAP_DEG_W * wide.scale;
  assert.ok(mapRight <= 1000 + 1e-9);
});

test('视图夹紧：小地图居中，大地图不允许拖出边缘', () => {
  const width = 800;
  const height = 400;
  const base = fitView(width, height);
  // 小于画布 → 强制居中
  const small = clampView({ scale: base.scale, offsetX: -999, offsetY: 999 }, width, height);
  assert.equal(small.offsetX, (width - MAP_DEG_W * base.scale) / 2);
  assert.equal(small.offsetY, (height - MAP_DEG_H * base.scale) / 2);
  // 放大后拖出右边 → 被拉回可见范围内
  const zoomed = { scale: base.scale * 6, offsetX: width, offsetY: 0 };
  const clamped = clampView(zoomed, width, height);
  assert.ok(clamped.offsetX <= 14);
  assert.ok(clamped.offsetY >= -(MAP_DEG_H * clamped.scale - height) - 14);
});

test('围绕锚点缩放：锚点处的地图坐标保持不动', () => {
  const width = 960;
  const height = 480;
  const base = fitView(width, height);
  const anchor = { x: 500, y: 260 };
  const zoomed = zoomViewAt(base, 3, anchor.x, anchor.y, base.scale);
  const before = screenToLonLat(anchor.x, anchor.y, base);
  const after = screenToLonLat(anchor.x, anchor.y, zoomed);
  assert.ok(Math.abs(before.lon - after.lon) < 1e-9);
  assert.ok(Math.abs(before.lat - after.lat) < 1e-9);
});

test('缩放倍率被限制在 [1×, 6×]，平移后始终夹紧', () => {
  const width = 960;
  const height = 480;
  const base = fitView(width, height);
  const tooFar = zoomViewAt(base, 100, 480, 240, base.scale);
  assert.ok(Math.abs(tooFar.scale - base.scale * 6) < 1e-9);
  const panned = panView({ scale: base.scale * 9, offsetX: 0, offsetY: 0 }, 5000, 5000, width, height);
  assert.ok(panned.offsetX <= 14 && panned.offsetY <= 14);
});

test('坐标格式化输出 N/S 与 E/W 半球', () => {
  assert.equal(formatLatLon(31.04, 114.2), '31.0°N · 114.2°E');
  assert.equal(formatLatLon(-64.02, -23.5), '64.0°S · 23.5°W');
});

test('命中测试返回最近观测点并尊重距离阈值', () => {
  const view = { scale: 2, offsetX: 0, offsetY: 0 };
  const points = [[114.2, 31], [120, -5]];
  const target = projectToScreen(lonLatToProject(114.2, 31), view);
  const hit = findNearestPoint(points, target.x + 2, target.y + 2, view, 18);
  assert.equal(hit.index, 0);
  assert.equal(hit.lon, 114.2);
  const miss = findNearestPoint(points, 5000, 5000, view, 18);
  assert.equal(miss, null);
});

test('掩码位解码与位序约定一致（字节高bit在前）', () => {
  const bytes = new Uint8Array(MASK_W * MASK_H / 8).fill(0);
  // 手工把 (x=0,y=0) 与 (x=8,y=1) 置 1：idx=0 → 字节0最高位；idx=720+8=728 → 字节91最高位
  bytes[0] |= 0b10000000;
  bytes[(728) >> 3] |= 0b10000000;
  assert.equal(maskHasLand(bytes, 0, 0), true);
  assert.equal(maskHasLand(bytes, 8, 1), true);
  assert.equal(maskHasLand(bytes, 1, 0), false);
  assert.equal(maskHasLand(bytes, -1, 0), false);
  assert.equal(maskHasLand(bytes, MASK_W, 0), false);
});
