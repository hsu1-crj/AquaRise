const CACHE_PREFIX = 'haitong-gbif-v1:';
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
      return points.length && Number.isFinite(parsed?.ts) ? { ts: parsed.ts, points } : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response?.ok) throw new Error(`GBIF HTTP ${response?.status ?? 0}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadSpecies({ slug, scientificName, fallbackPoint }) {
    const fallback = normalizeCachedPoints([fallbackPoint]);
    const cached = readCache(slug);
    const currentTime = now();
    if (cached && currentTime - cached.ts <= ttlMs) {
      return { points: cached.points, source: 'cache', stale: false };
    }
    if (cooldown) return { points: fallback, source: 'fallback', stale: false };

    try {
      const matchUrl = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(scientificName)}`;
      const match = await fetchJson(matchUrl);
      if (!match?.usageKey) throw new Error('GBIF 未匹配到物种');
      const occurrenceUrl = 'https://api.gbif.org/v1/occurrence/search'
        + `?taxonKey=${encodeURIComponent(match.usageKey)}&hasCoordinate=true&limit=200&occurrenceStatus=PRESENT`;
      const occurrence = await fetchJson(occurrenceUrl);
      const points = sampleOccurrencePoints(normalizeOccurrencePoints(occurrence?.results), maxPoints, random);
      if (!points.length) throw new Error('GBIF 未返回有效坐标');
      try {
        storage?.setItem(`${CACHE_PREFIX}${slug}`, JSON.stringify({ ts: currentTime, points }));
      } catch (error) {
        // localStorage 满额不影响当前会话显示。
      }
      failures = 0;
      return { points, source: 'gbif', stale: false };
    } catch (error) {
      failures += 1;
      if (failures >= maxFailures) cooldown = true;
      if (cached) return { points: cached.points, source: 'cache', stale: true };
      return { points: fallback, source: 'fallback', stale: false };
    }
  }

  return {
    loadSpecies,
    get cooldown() { return cooldown; },
    get failures() { return failures; },
  };
}
