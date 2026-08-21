/**
 * F3 扩散推演内核 —— 浏览器端 TypeScript 移植（与 src/vision/diffusion.py 同口径）。
 *
 * 模型: 位移 = (流速 + 风致漂移)·dt + N(0, sqrt(2·K·dt))
 *   - 风致漂移 = windFactor × 风速（Leeway 经验值 3%），方向为风作用去向
 *   - 随机游走近似水平涡扩散（无剪切/分层）
 *   - 简化拉格朗日示意模型，非预报产品（参照 OpenDrift 框架的极简版）
 * 坐标: 本地米制（x=东, y=北），与后端契约一致；场景侧再做米→场景单位缩放。
 */

export interface DiffusionParams {
  durationH: number;
  nParticles: number;
  dtS: number;
  currentU: number;   // m/s 东向
  currentV: number;   // m/s 北向
  windSpeed: number;  // m/s
  windDirDeg: number; // 风作用去向方位角（0=北, 顺时针）
  windFactor: number; // 3%
  diffusivity: number; // m²/s
  seed: number;
}

export interface DiffusionResult {
  steps: number;
  dtS: number;
  durationH: number;
  nParticles: number;
  /** nParticles × (steps+1) 个 [x, y, t]，扁平存储 */
  tracks: Float32Array;
  /** 每步 95% 粒子半径（米），供信息面板展示 */
  radius95: Float32Array;
}

/** 与 Python 侧一致的确定性伪随机（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function simulate(p: DiffusionParams): DiffusionResult {
  const steps = Math.max(1, Math.round((p.durationH * 3600) / p.dtS));
  const rand = mulberry32(p.seed);
  const theta = (p.windDirDeg * Math.PI) / 180;
  const drift = p.windFactor * p.windSpeed;
  const velU = p.currentU + drift * Math.sin(theta);
  const velV = p.currentV + drift * Math.cos(theta);
  const advU = velU * p.dtS;
  const advV = velV * p.dtS;
  const sigma = Math.sqrt(2 * p.diffusivity * p.dtS);

  const tracks = new Float32Array(p.nParticles * (steps + 1) * 3);
  const xs = new Float32Array(p.nParticles);
  const ys = new Float32Array(p.nParticles);
  // t=0 全部在原点
  for (let i = 0; i < p.nParticles; i++) {
    const k = i * 3;
    tracks[k] = 0; tracks[k + 1] = 0; tracks[k + 2] = 0;
  }
  const radius95 = new Float32Array(steps + 1);
  const dists = new Float32Array(p.nParticles);

  for (let s = 1; s <= steps; s++) {
    let cx = 0, cy = 0;
    for (let i = 0; i < p.nParticles; i++) {
      xs[i] += advU + (sigma > 0 ? gauss(rand) * sigma : 0);
      ys[i] += advV + (sigma > 0 ? gauss(rand) * sigma : 0);
      cx += xs[i]; cy += ys[i];
    }
    cx /= p.nParticles; cy /= p.nParticles;
    for (let i = 0; i < p.nParticles; i++) {
      const dx = xs[i] - cx, dy = ys[i] - cy;
      dists[i] = Math.sqrt(dx * dx + dy * dy);
      const k = (i * (steps + 1) + s) * 3;
      tracks[k] = xs[i]; tracks[k + 1] = ys[i]; tracks[k + 2] = s * p.dtS;
    }
    const sorted = Array.from(dists).sort((a, b) => a - b);
    radius95[s] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return { steps, dtS: p.dtS, durationH: p.durationH, nParticles: p.nParticles, tracks, radius95 };
}
