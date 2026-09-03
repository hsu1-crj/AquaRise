// v2：缓存携带悬停元数据（日期/记录类型/地点）；v1 缓存无 meta，升级前缀自然失效
const CACHE_PREFIX = 'haitong-gbif-v2:';
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

export function normalizeOccurrencePoints(results) {
  const seen = new Set();
  const points = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (item?.decimalLongitude === null || item?.decimalLatitude === null) continue;
    const lon = Number(item?.decimalLongitude);
    const lat = Number(item?.decimalLatitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    const key = `${lon},${lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push([lon, lat]);
  }
  return points;
}

/** 清洗 GBIF 记录并保留悬停提示所需元数据（坐标去重规则与 normalizeOccurrencePoints 一致） */
export function normalizeOccurrenceRecords(results) {
  const seen = new Set();
  const records = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (item?.decimalLongitude === null || item?.decimalLatitude === null) continue;
    const lon = Number(item?.decimalLongitude);
    const lat = Number(item?.decimalLatitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    const key = `${lon},${lat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      lon,
      lat,
      date: typeof item?.eventDate === "string" ? item.eventDate.slice(0, 10) : "",
      basis: typeof item?.basisOfRecord === "string" ? item.basisOfRecord : "",
      locality: typeof item?.locality === "string" ? item.locality.slice(0, 60) : "",
      country: typeof item?.country === "string" ? item.country.slice(0, 40) : "",
    });
  }
  return records;
}

export function sampleOccurrenceRecords(records, limit = 100, random = Math.random) {
  if (!Array.isArray(records) || records.length <= limit) {
    return Array.isArray(records) ? records.map(record => ({ ...record })) : [];
  }
  return records
    .map((record, index) => ({ record, index, score: random() }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => ({ ...entry.record }));
}

/** GBIF basisOfRecord 枚举 → 中文展示（未识别时返回空串，由调用方省略） */
export function translateBasisOfRecord(basis) {
  const map = {
    HUMAN_OBSERVATION: "人工观测",
    MACHINE_OBSERVATION: "机器观测",
    OBSERVATION: "观测",
    PRESERVED_SPECIMEN: "标本记录",
    FOSSIL_SPECIMEN: "化石记录",
    LITERATURE: "文献记录",
    LIVING_SPECIMEN: "活体记录",
  };
  return map[(basis || "").toUpperCase()] || "";
}

export function sampleOccurrencePoints(points, limit = 100, random = Math.random) {
  if (!Array.isArray(points) || points.length <= limit) return Array.isArray(points) ? points.map(point => [...point]) : [];
  return points
    .map((point, index) => ({ point, index, score: random() }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => [...entry.point]);
}

function normalizeCachedPoints(points) {
  return (Array.isArray(points) ? points : []).filter(point => {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
  }).map(point => [Number(point[0]), Number(point[1])]);
}

export function createGbifClient({
  fetchImpl = fetch,
  storage = localStorage,
  now = Date.now,
  random = Math.random,
  timeoutMs = 8000,
  retryCount = 0,
  retryDelayMs = 180,
  ttlMs = DEFAULT_TTL,
  maxPoints = 100,
  maxFailures = 2,
} = {}) {
  let failures = 0;
  let cooldown = false;

  function readCache(slug) {
    try {
      const parsed = JSON.parse(storage?.getItem(`${CACHE_PREFIX}${slug}`) || 'null');
      const points = normalizeCachedPoints(parsed?.points);
      // 旧缓存可能没有 meta 字段：容忍缺失，悬停提示退化为仅坐标
      const meta = Array.isArray(parsed?.meta) ? parsed.meta : null;
      return points.length && Number.isFinite(parsed?.ts) ? { ts: parsed.ts, points, meta } : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchJson(url) {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response?.ok) throw new Error(`GBIF HTTP ${response?.status ?? 0}`);
        return await response.json();
      } catch (error) {
        const status = Number(error?.message?.match(/GBIF HTTP (\d+)/)?.[1] || 0);
        const transient = !status || status === 408 || status === 425 || status === 429 || status >= 500;
        if (!transient || attempt >= retryCount) throw error;
        attempt += 1;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function loadSpecies({ slug, scientificName, fallbackPoint }) {
    const fallback = normalizeCachedPoints([fallbackPoint]);
    const cached = readCache(slug);
    const currentTime = now();
    if (cached && currentTime - cached.ts <= ttlMs) {
      return { points: cached.points, meta: cached.meta, source: 'cache', stale: false };
    }
    if (cooldown) return { points: fallback, meta: null, source: 'fallback', stale: false };

    try {
      const matchUrl = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(scientificName)}`;
      const match = await fetchJson(matchUrl);
      if (!match?.usageKey) throw new Error('GBIF 未匹配到物种');
      const occurrenceUrl = 'https://api.gbif.org/v1/occurrence/search'
        + `?taxonKey=${encodeURIComponent(match.usageKey)}&hasCoordinate=true&limit=100&occurrenceStatus=PRESENT`;
      const occurrence = await fetchJson(occurrenceUrl);
      // 先抽样记录再映射坐标，保证 points 与 meta 逐条对齐
      const records = sampleOccurrenceRecords(normalizeOccurrenceRecords(occurrence?.results), maxPoints, random);
      const points = records.map(record => [record.lon, record.lat]);
      const meta = records.map(record => ({ date: record.date, basis: record.basis, locality: record.locality, country: record.country }));
      if (!points.length) throw new Error('GBIF 未返回有效坐标');
      try {
        storage?.setItem(`${CACHE_PREFIX}${slug}`, JSON.stringify({ ts: currentTime, points, meta }));
      } catch (error) {
        // localStorage 满额不影响当前会话显示。
      }
      failures = 0;
      return { points, meta, source: 'gbif', stale: false };
    } catch (error) {
      failures += 1;
      if (failures >= maxFailures) cooldown = true;
      if (cached) return { points: cached.points, meta: cached.meta, source: 'cache', stale: true };
      return { points: fallback, meta: null, source: 'fallback', stale: false };
    }
  }

  return {
    loadSpecies,
    get cooldown() { return cooldown; },
    get failures() { return failures; },
  };
}
