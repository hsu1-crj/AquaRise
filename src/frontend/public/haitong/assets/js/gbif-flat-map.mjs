/* =========================================================================
 * 观测分布 · 平面世界地图（GBIF Flat Observation Map）
 * =========================================================================
 * 等距圆柱投影（equirectangular）：经度 → x，纬度 → y，整图 360×180 度。
 * 陆地底图来自离线内置的 720×360 世界陆地掩码（EARTH_MASK_720 位图，
 * 1bit/像素），不依赖任何在线瓦片服务；观测点由 index.html 传入
 * （GBIF 实时 / 本地缓存 / 档案参考点）。
 *
 * 纯函数（投影 / 视图变换 / 命中测试 / 掩码解码）可在 Node 单测
 * （tests/gbif-flat-map.test.mjs）；createGbifFlatMap 控制器仅浏览器使用。
 * ========================================================================= */

export const MAP_DEG_W = 360;
export const MAP_DEG_H = 180;
export const MASK_W = 720;
export const MASK_H = 360;
export const MAX_ZOOM_FACTOR = 6;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** 经纬度 → 投影坐标（0..360 / 0..180；投影原点 = (−180°, 90°)，即左上角） */
export function lonLatToProject(lon, lat) {
  return { x: lon + 180, y: 90 - lat };
}

/** 投影坐标 → 屏幕坐标（view = { scale, offsetX, offsetY }） */
export function projectToScreen(p, view) {
  return { x: view.offsetX + p.x * view.scale, y: view.offsetY + p.y * view.scale };
}

/** 屏幕坐标 → 经纬度（拖拽/悬停反查用） */
export function screenToLonLat(x, y, view) {
  return {
    lon: (x - view.offsetX) / view.scale - 180,
    lat: 90 - (y - view.offsetY) / view.scale,
  };
}

/** 初始适配视图：把 2:1 地图 contain 进画布并居中，作为 1× 基准 */
export function fitView(width, height, padding = 30) {
  const availW = Math.max(40, width - padding * 2);
  const availH = Math.max(24, height - padding * 2);
  const scale = Math.min(availW / MAP_DEG_W, availH / MAP_DEG_H);
  return {
    scale,
    offsetX: (width - MAP_DEG_W * scale) / 2,
    offsetY: (height - MAP_DEG_H * scale) / 2,
  };
}

/** 视图夹紧：地图小于画布时居中，大于画布时不允许拖出边缘 */
export function clampView(view, width, height, margin = 14) {
  const w = MAP_DEG_W * view.scale;
  const h = MAP_DEG_H * view.scale;
  const offsetX = w <= width ? (width - w) / 2 : clamp(view.offsetX, width - w - margin, margin);
  const offsetY = h <= height ? (height - h) / 2 : clamp(view.offsetY, height - h - margin, margin);
  return { scale: view.scale, offsetX, offsetY };
}

/** 围绕屏幕点 (anchorX, anchorY) 缩放，缩放范围约束在 [baseScale, baseScale × maxFactor] */
export function zoomViewAt(view, factor, anchorX, anchorY, baseScale, maxFactor = MAX_ZOOM_FACTOR) {
  const nextScale = clamp(view.scale * factor, baseScale, baseScale * maxFactor);
  const applied = nextScale / view.scale;
  return {
    scale: nextScale,
    offsetX: anchorX - (anchorX - view.offsetX) * applied,
    offsetY: anchorY - (anchorY - view.offsetY) * applied,
  };
}

/** 平移后夹紧（拖拽用） */
export function panView(view, dx, dy, width, height, margin = 14) {
  return clampView(
    { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy },
    width, height, margin,
  );
}

/** 坐标格式化：31.2°N · 114.5°W */
export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} · ${Math.abs(lon).toFixed(1)}°${ew}`;
}

/** 命中测试：返回 maxDist 屏幕像素内最近的观测点，找不到返回 null */
export function findNearestPoint(points, x, y, view, maxDist = 18) {
  let best = null;
  let bestDist = maxDist;
  const list = Array.isArray(points) ? points : [];
  for (let index = 0; index < list.length; index++) {
    const lon = Number(list[index]?.[0]);
    const lat = Number(list[index]?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const s = projectToScreen(lonLatToProject(lon, lat), view);
    const dist = Math.hypot(s.x - x, s.y - y);
    if (dist <= bestDist) {
      bestDist = dist;
      best = { index, lon, lat, x: s.x, y: s.y };
    }
  }
  return best;
}

/** 掩码位解码：与 index.html isLandAt 的 (idx >> 3, 7 - (idx & 7)) 口径完全一致 */
export function maskHasLand(maskBytes, maskX, maskY) {
  if (!maskBytes || maskX < 0 || maskX >= MASK_W || maskY < 0 || maskY >= MASK_H) return false;
  const idx = maskY * MASK_W + maskX;
  return ((maskBytes[idx >> 3] >> (7 - (idx & 7))) & 1) === 1;
}

/**
 * 一次性把 720×360 位图渲染成离线陆地画布：陆地内部与海岸双色。
 * 经度方向环绕采样（白令海峡/日界线邻域不塌陷），仅浏览器可用；
 * 失败返回 null，调用方退化为纯经纬网底图。
 */
export function buildLandCanvas(maskBytes, palette = {}) {
  if (typeof document === "undefined" || !maskBytes) return null;
  const canvas = document.createElement("canvas");
  canvas.width = MASK_W;
  canvas.height = MASK_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const landRgb = palette.land || [26, 98, 118];
  const coastRgb = palette.coast || [64, 200, 214];
  const image = ctx.createImageData(MASK_W, MASK_H);
  const pixels = image.data;
  const isLand = (x, y) => maskHasLand(maskBytes, ((x % MASK_W) + MASK_W) % MASK_W, clamp(y, 0, MASK_H - 1));
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) {
      if (!isLand(x, y)) continue;
      const coast = !isLand(x + 1, y) || !isLand(x - 1, y) || !isLand(x, y + 1) || !isLand(x, y - 1);
      const rgb = coast ? coastRgb : landRgb;
      const o = (y * MASK_W + x) * 4;
      pixels[o] = rgb[0];
      pixels[o + 1] = rgb[1];
      pixels[o + 2] = rgb[2];
      pixels[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * 平面观测地图控制器：打开/关闭、数据推送、拖拽平移、滚轮缩放、悬停坐标。
 * 数据由 index.html 推送（setData），渲染循环仅在面板打开期间运行。
 */
export function createGbifFlatMap({
  root,
  canvas,
  tooltip,
  loadingEl,
  emptyEl,
  speciesEl,
  sourceEl,
  statsEl,
  closeBtn,
  getMaskBytes,
  onOpen,
  onClose,
} = {}) {
  if (!root || !canvas) throw new Error("gbif-flat-map: root 与 canvas 为必填项");
  const ctx = canvas.getContext("2d");
  let landCanvas = null;
  try {
    landCanvas = buildLandCanvas(typeof getMaskBytes === "function" ? getMaskBytes() : null);
  } catch {
    landCanvas = null;
  }
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let active = false;
  let rafId = 0;
  let width = 0;
  let height = 0;
  let baseView = fitView(960, 480);
  let view = baseView;
  let points = [];
  let hover = null;
  let dragging = false;
  let dragPointerId = null;
  let lastPointer = null;
  let meta = { species: "当前物种", source: "", loading: false, count: 0, clusterCount: 0 };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 窗口尺寸变化时保持缩放倍率，把地图重新居中
    const prevFactor = baseView.scale ? view.scale / baseView.scale : 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseView = fitView(width, height);
    const nextScale = baseView.scale * prevFactor;
    view = clampView({
      scale: nextScale,
      offsetX: (width - MAP_DEG_W * nextScale) / 2,
      offsetY: (height - MAP_DEG_H * nextScale) / 2,
    }, width, height);
  }

  function syncMeta() {
    if (speciesEl) speciesEl.textContent = meta.loading ? "正在读取观测记录…" : meta.species;
    if (sourceEl) {
      sourceEl.textContent = meta.loading ? "读取中…" : (meta.source || "—");
      sourceEl.classList.toggle("is-fallback", !meta.loading && meta.source.includes("档案"));
    }
    if (statsEl) {
      statsEl.innerHTML = meta.loading
        ? "正在聚合位置…"
        : `<b>${meta.count}</b> 个位置 · <b>${meta.clusterCount}</b> 个聚集区`;
    }
    if (loadingEl) loadingEl.hidden = !meta.loading;
    if (emptyEl) emptyEl.hidden = meta.loading || points.length > 0;
  }

  function render(timeMs) {
    if (!ctx || !width || !height) return;
    ctx.clearRect(0, 0, width, height);
    // 深海底色
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#02101f");
    bg.addColorStop(0.55, "#031a2e");
    bg.addColorStop(1, "#02101d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const mapW = MAP_DEG_W * view.scale;
    const mapH = MAP_DEG_H * view.scale;

    // 陆地底图：低分辨率掩码放大会出现台阶感，
    // 先画一层轻微模糊的生物荧光辉光再叠原始陆地，弱化像素边缘。
    if (landCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.filter = "blur(3px)";
      ctx.globalAlpha = 0.55;
      ctx.drawImage(landCanvas, view.offsetX, view.offsetY, mapW, mapH);
      ctx.restore();
      ctx.drawImage(landCanvas, view.offsetX, view.offsetY, mapW, mapH);
    }

    // 经纬网（30° 间隔；赤道与本初子午线略亮）
    ctx.lineWidth = 1;
    for (let lon = -150; lon <= 180; lon += 30) {
      const x = view.offsetX + (lon + 180) * view.scale;
      ctx.strokeStyle = lon === 0 ? "rgba(126,231,255,.20)" : "rgba(126,231,255,.08)";
      ctx.beginPath();
      ctx.moveTo(x, view.offsetY);
      ctx.lineTo(x, view.offsetY + mapH);
      ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      const y = view.offsetY + (90 - lat) * view.scale;
      ctx.strokeStyle = lat === 0 ? "rgba(126,231,255,.20)" : "rgba(126,231,255,.08)";
      ctx.beginPath();
      ctx.moveTo(view.offsetX, y);
      ctx.lineTo(view.offsetX + mapW, y);
      ctx.stroke();
    }
    // 地图边框辉光
    ctx.strokeStyle = "rgba(56,248,212,.38)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(view.offsetX - 0.5, view.offsetY - 0.5, mapW + 1, mapH + 1);

    // 观测点：橙色荧光 + 呼吸脉动（reduced-motion 时静态）
    const pulse = reducedMotion ? 0.5 : Math.sin(timeMs / 480) * 0.5 + 0.5;
    for (const record of points) {
      const lon = Number(record?.[0]);
      const lat = Number(record?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const s = projectToScreen(lonLatToProject(lon, lat), view);
      if (
        s.x < view.offsetX - 8 || s.x > view.offsetX + mapW + 8 ||
        s.y < view.offsetY - 8 || s.y > view.offsetY + mapH + 8
      ) continue;
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,181,71,.22)";
      ctx.arc(s.x, s.y, 6.5 + pulse * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "#ffd166";
      ctx.arc(s.x, s.y, 2.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,246,214,.95)";
      ctx.arc(s.x, s.y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // 悬停高亮环
    if (hover) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,246,214,.95)";
      ctx.lineWidth = 1.6;
      ctx.arc(hover.x, hover.y, 8.5 + pulse * 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function placeTooltip(hit) {
    if (!tooltip) return;
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = `<strong>观测记录</strong>${formatLatLon(hit.lat, hit.lon)}`;
    tooltip.hidden = false;
    const margin = 12;
    const tw = tooltip.offsetWidth || 150;
    const th = tooltip.offsetHeight || 42;
    let tx = hit.x + 14;
    let ty = hit.y + 14;
    if (tx + tw > width - margin) tx = hit.x - tw - 14;
    if (ty + th > height - margin) ty = hit.y - th - 14;
    tooltip.style.left = `${Math.max(margin, tx)}px`;
    tooltip.style.top = `${Math.max(margin, ty)}px`;
  }

  function loop(timeMs) {
    if (!active) return;
    render(timeMs);
    rafId = requestAnimationFrame(loop);
  }

  function screenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handleMove(event) {
    if (!active) return;
    const p = screenPoint(event);
    if (dragging) {
      view = panView(view, p.x - lastPointer.x, p.y - lastPointer.y, width, height);
      lastPointer = p;
      if (tooltip && !tooltip.hidden) tooltip.hidden = true;
      return;
    }
    const hit = findNearestPoint(points, p.x, p.y, view);
    hover = hit;
    placeTooltip(hit);
    canvas.style.cursor = hit ? "pointer" : "grab";
  }

  function bindEvents() {
    canvas.addEventListener("pointerdown", event => {
      if (!active) return;
      dragging = true;
      dragPointerId = event.pointerId;
      lastPointer = screenPoint(event);
      canvas.setPointerCapture?.(event.pointerId);
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", handleMove);
    canvas.addEventListener("pointerup", event => {
      if (dragPointerId !== null && event.pointerId !== dragPointerId) return;
      dragging = false;
      dragPointerId = null;
      canvas.classList.remove("dragging");
    });
    canvas.addEventListener("pointercancel", () => {
      dragging = false;
      dragPointerId = null;
      canvas.classList.remove("dragging");
    });
    canvas.addEventListener("pointerleave", () => {
      if (dragging) return;
      hover = null;
      placeTooltip(null);
    });
    canvas.addEventListener("wheel", event => {
      if (!active) return;
      event.preventDefault();
      // 地图缩放不应继续冒泡到页面级滚轮监听，避免驱动背后地球的 targetZoom。
      event.stopPropagation();
      const p = screenPoint(event);
      const factor = Math.exp(-event.deltaY * 0.0016);
      view = clampView(zoomViewAt(view, factor, p.x, p.y, baseView.scale), width, height);
      const hit = findNearestPoint(points, p.x, p.y, view);
      hover = hit;
      placeTooltip(hit);
    }, { passive: false });
    canvas.addEventListener("dblclick", () => resetView());
    closeBtn?.addEventListener("click", () => close());
  }

  function resetView() {
    view = baseView;
  }

  function open() {
    if (active) return;
    active = true;
    root.classList.add("open");
    root.setAttribute("aria-hidden", "false");
    // 揭幕动画进行中布局尚未稳定，等下一帧再量尺寸
    requestAnimationFrame(() => {
      resize();
      syncMeta();
    });
    rafId = requestAnimationFrame(loop);
    onOpen?.();
  }

  function close() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    root.classList.remove("open");
    root.setAttribute("aria-hidden", "true");
    hover = null;
    if (tooltip) tooltip.hidden = true;
    onClose?.();
  }

  function setData(next = {}) {
    if (Array.isArray(next.points)) {
      points = next.points.filter(
        p => Number.isFinite(Number(p?.[0])) && Number.isFinite(Number(p?.[1])),
      );
      hover = null;
    }
    if (next.species !== undefined) meta.species = next.species;
    if (next.source !== undefined) meta.source = next.source;
    if (next.loading !== undefined) meta.loading = next.loading;
    if (next.count !== undefined) meta.count = next.count;
    if (next.clusterCount !== undefined) meta.clusterCount = next.clusterCount;
    if (active) syncMeta();
  }

  bindEvents();
  root.setAttribute("aria-hidden", "true");

  return {
    open,
    close,
    setData,
    resetView,
    get isActive() { return active; },
    get view() { return view; },
  };
}
