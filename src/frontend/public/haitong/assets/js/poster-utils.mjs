function clamp01(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

export function calculateFocalCoverCrop(imageWidth, imageHeight, destWidth, destHeight, focus = [0.5, 0.5]) {
  const dimensions = [imageWidth, imageHeight, destWidth, destHeight].map(Number);
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("calculateFocalCoverCrop requires positive dimensions");
  }

  const [iw, ih, dw, dh] = dimensions;
  const sourceRatio = iw / ih;
  const destinationRatio = dw / dh;
  let sw;
  let sh;

  if (sourceRatio > destinationRatio) {
    sh = ih;
    sw = sh * destinationRatio;
  } else {
    sw = iw;
    sh = sw / destinationRatio;
  }

  const fx = clamp01(focus?.[0], 0.5);
  const fy = clamp01(focus?.[1], 0.5);
  const sx = Math.min(iw - sw, Math.max(0, iw * fx - sw / 2));
  const sy = Math.min(ih - sh, Math.max(0, ih * fy - sh / 2));

  return { sx, sy, sw, sh };
}
