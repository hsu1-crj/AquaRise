import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGbifClient,
  normalizeOccurrencePoints,
  sampleOccurrencePoints,
} from '../src/frontend/public/haitong/assets/js/gbif-client.mjs';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

test('观测记录只保留合法经纬度并去除重复点', () => {
  const points = normalizeOccurrencePoints([
    { decimalLongitude: 120.5, decimalLatitude: -5.2 },
    { decimalLongitude: '120.5', decimalLatitude: '-5.2' },
    { decimalLongitude: 181, decimalLatitude: 0 },
    { decimalLongitude: 10, decimalLatitude: -91 },
    { decimalLongitude: null, decimalLatitude: 30 },
    { decimalLongitude: 0, decimalLatitude: 0 },
  ]);

  assert.deepEqual(points, [[120.5, -5.2], [0, 0]]);
});

test('随机抽样不修改原数组并严格限制点数', () => {
  const source = [[1, 1], [2, 2], [3, 3], [4, 4]];
  const sampled = sampleOccurrencePoints(source, 2, () => 0);

  assert.deepEqual(sampled, [[1, 1], [2, 2]]);
  assert.deepEqual(source, [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

test('七天内缓存直接返回且不访问网络', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v1:vaquita', JSON.stringify({ ts: 1_000, points: [[-114.2, 31]] }));
  let fetchCalls = 0;
  const client = createGbifClient({
    storage,
    now: () => 2_000,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('不应访问网络'); },
  });

  const result = await client.loadSpecies({ slug: 'vaquita', scientificName: 'Phocoena sinus', fallbackPoint: [-114.2, 31] });

  assert.deepEqual(result, { points: [[-114.2, 31]], source: 'cache', stale: false });
  assert.equal(fetchCalls, 0);
});

test('过期缓存会刷新为清洗和抽样后的 GBIF 数据', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v1:vaquita', JSON.stringify({ ts: 1, points: [[-114.2, 31]] }));
  const urls = [];
  const responses = [
    { usageKey: 2440223 },
    { results: [
      { decimalLongitude: -114.5, decimalLatitude: 30.8 },
      { decimalLongitude: -114.1, decimalLatitude: 31.2 },
    ] },
  ];
  const client = createGbifClient({
    storage,
    now: () => 700_000_000,
    maxPoints: 1,
    random: () => 0,
    fetchImpl: async url => {
      urls.push(url);
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await client.loadSpecies({ slug: 'vaquita', scientificName: 'Phocoena sinus', fallbackPoint: [-114.2, 31] });

  assert.deepEqual(result, { points: [[-114.5, 30.8]], source: 'gbif', stale: false });
  assert.match(urls[0], /species\/match\?name=Phocoena%20sinus/);
  assert.match(urls[1], /occurrence\/search\?taxonKey=2440223&hasCoordinate=true&limit=100&occurrenceStatus=PRESENT/);
  const cached = JSON.parse(storage.getItem('haitong-gbif-v1:vaquita'));
  assert.deepEqual(cached, { ts: 700_000_000, points: [[-114.5, 30.8]] });
});

test('连续两次网络失败后本会话静默回退且不再发请求', async () => {
  let fetchCalls = 0;
  const client = createGbifClient({
    storage: new MemoryStorage(),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('offline'); },
  });
  const request = { slug: 'vaquita', scientificName: 'Phocoena sinus', fallbackPoint: [-114.2, 31] };

  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], source: 'fallback', stale: false });
  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], source: 'fallback', stale: false });
  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], source: 'fallback', stale: false });
  assert.equal(fetchCalls, 2);
  assert.equal(client.cooldown, true);
});

test('刷新失败时可使用过期缓存并明确标记 stale', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v1:blue-whale', JSON.stringify({ ts: 1, points: [[-65, -64]] }));
  const client = createGbifClient({
    storage,
    now: () => 700_000_000,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const result = await client.loadSpecies({ slug: 'blue-whale', scientificName: 'Balaenoptera musculus', fallbackPoint: [-65, -64] });

  assert.deepEqual(result, { points: [[-65, -64]], source: 'cache', stale: true });
});
