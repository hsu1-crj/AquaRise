import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGbifClient,
  normalizeOccurrencePoints,
  normalizeOccurrenceRecords,
  sampleOccurrenceRecords,
  translateBasisOfRecord,
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

test('记录清洗保留悬停元数据并按坐标去重', () => {
  const records = normalizeOccurrenceRecords([
    { decimalLongitude: 120.5, decimalLatitude: -5.2, eventDate: '2021-04-18T08:00:00', basisOfRecord: 'HUMAN_OBSERVATION', locality: 'Raja Ampat', country: 'Indonesia' },
    { decimalLongitude: 120.5, decimalLatitude: '-5.2', eventDate: '2022-01-01', basisOfRecord: 'PRESERVED_SPECIMEN' },
    { decimalLongitude: 181, decimalLatitude: 0, eventDate: '2020-01-01', basisOfRecord: 'OBSERVATION' },
    { decimalLongitude: 10, decimalLatitude: 20, eventDate: null, basisOfRecord: 'UNKNOWN', locality: 'Nowhere' },
  ]);

  assert.deepEqual(records, [
    { lon: 120.5, lat: -5.2, date: '2021-04-18', basis: 'HUMAN_OBSERVATION', locality: 'Raja Ampat', country: 'Indonesia' },
    { lon: 10, lat: 20, date: '', basis: 'UNKNOWN', locality: 'Nowhere', country: '' },
  ]);
});

test('记录随机抽样与坐标抽样保持同序同规则', () => {
  const records = normalizeOccurrenceRecords([
    { decimalLongitude: 1, decimalLatitude: 1 },
    { decimalLongitude: 2, decimalLatitude: 2 },
    { decimalLongitude: 3, decimalLatitude: 3 },
    { decimalLongitude: 4, decimalLatitude: 4 },
  ]);
  const sampled = sampleOccurrenceRecords(records, 2, () => 0);

  assert.deepEqual(sampled, [
    { lon: 1, lat: 1, date: '', basis: '', locality: '', country: '' },
    { lon: 2, lat: 2, date: '', basis: '', locality: '', country: '' },
  ]);
});

test('basisOfRecord 枚举翻译为中文且未知值返回空串', () => {
  assert.equal(translateBasisOfRecord('HUMAN_OBSERVATION'), '人工观测');
  assert.equal(translateBasisOfRecord('PRESERVED_SPECIMEN'), '标本记录');
  assert.equal(translateBasisOfRecord('SOME_NEW_ENUM'), '');
  assert.equal(translateBasisOfRecord(null), '');
});

test('随机抽样不修改原数组并严格限制点数', () => {
  const source = [[1, 1], [2, 2], [3, 3], [4, 4]];
  const sampled = sampleOccurrencePoints(source, 2, () => 0);

  assert.deepEqual(sampled, [[1, 1], [2, 2]]);
  assert.deepEqual(source, [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

test('七天内缓存直接返回且不访问网络', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v2:vaquita', JSON.stringify({ ts: 1_000, points: [[-114.2, 31]] }));
  let fetchCalls = 0;
  const client = createGbifClient({
    storage,
    now: () => 2_000,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('不应访问网络'); },
  });

  const result = await client.loadSpecies({ slug: 'vaquita', scientificName: 'Phocoena sinus', fallbackPoint: [-114.2, 31] });

  // 旧格式缓存没有 meta：容忍缺失，悬停提示退化为仅坐标
  assert.deepEqual(result, { points: [[-114.2, 31]], meta: null, source: 'cache', stale: false });
  assert.equal(fetchCalls, 0);
});

test('过期缓存会刷新为清洗和抽样后的 GBIF 数据并附带元数据', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v2:vaquita', JSON.stringify({ ts: 1, points: [[-114.2, 31]] }));
  const urls = [];
  const responses = [
    { usageKey: 2440223 },
    { results: [
      { decimalLongitude: -114.5, decimalLatitude: 30.8, eventDate: '2023-05-01T10:00:00', basisOfRecord: 'HUMAN_OBSERVATION', locality: 'Gulf of California', country: 'Mexico' },
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

  assert.deepEqual(result, {
    points: [[-114.5, 30.8]],
    meta: [{ date: '2023-05-01', basis: 'HUMAN_OBSERVATION', locality: 'Gulf of California', country: 'Mexico' }],
    source: 'gbif',
    stale: false,
  });
  assert.match(urls[0], /species\/match\?name=Phocoena%20sinus/);
  assert.match(urls[1], /occurrence\/search\?taxonKey=2440223&hasCoordinate=true&limit=100&occurrenceStatus=PRESENT/);
  const cached = JSON.parse(storage.getItem('haitong-gbif-v2:vaquita'));
  assert.deepEqual(cached, {
    ts: 700_000_000,
    points: [[-114.5, 30.8]],
    meta: [{ date: '2023-05-01', basis: 'HUMAN_OBSERVATION', locality: 'Gulf of California', country: 'Mexico' }],
  });
});

test('连续两次网络失败后本会话静默回退且不再发请求', async () => {
  let fetchCalls = 0;
  const client = createGbifClient({
    storage: new MemoryStorage(),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('offline'); },
  });
  const request = { slug: 'vaquita', scientificName: 'Phocoena sinus', fallbackPoint: [-114.2, 31] };

  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], meta: null, source: 'fallback', stale: false });
  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], meta: null, source: 'fallback', stale: false });
  assert.deepEqual(await client.loadSpecies(request), { points: [[-114.2, 31]], meta: null, source: 'fallback', stale: false });
  assert.equal(fetchCalls, 2);
  assert.equal(client.cooldown, true);
});

test('刷新失败时可使用过期缓存并明确标记 stale', async () => {
  const storage = new MemoryStorage();
  storage.setItem('haitong-gbif-v2:blue-whale', JSON.stringify({ ts: 1, points: [[-65, -64]] }));
  const client = createGbifClient({
    storage,
    now: () => 700_000_000,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const result = await client.loadSpecies({ slug: 'blue-whale', scientificName: 'Balaenoptera musculus', fallbackPoint: [-65, -64] });

  assert.deepEqual(result, { points: [[-65, -64]], meta: null, source: 'cache', stale: true });
});
