/**
 * Web Audio 合成音效（无需素材文件）。
 * Ocean3D 页投放/告警/答对提示与导游共用一个懒加载 AudioContext。
 */

let audioCtx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      // Safari 旧版将 AudioContext 挂在 webkit 前缀, 与标准字段并存
      const legacyWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
      const Ctor = legacyWindow.AudioContext ?? legacyWindow.webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, ctx.currentTime + start);
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

/** 投放垃圾入水声（低频噗通 + 水花噪声） */
export function playSplashSound(): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  try {
    tone(ctx, 180, 0, 0.28, 0.16);
    tone(ctx, 90, 0.05, 0.4, 0.1);
    const len = Math.floor(ctx.sampleRate * 0.25);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const amp = ctx.createGain();
    amp.gain.value = 0.12;
    src.connect(hp).connect(amp).connect(ctx.destination);
    src.start();
  } catch { /* 音频不可用时静默 */ }
}

/** 污染告警声（急促双音, 重复两遍） */
export function playAlertSound(): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  try {
    for (const base of [0, 0.28]) {
      tone(ctx, 880, base, 0.12, 0.12, 'square');
      tone(ctx, 660, base + 0.14, 0.12, 0.12, 'square');
    }
  } catch { /* 音频不可用时静默 */ }
}

/** 答对知识题提示音（上行双音） */
export function playChime(): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  try {
    tone(ctx, 660, 0, 0.16, 0.1, 'triangle');
    tone(ctx, 990, 0.12, 0.28, 0.1, 'triangle');
  } catch { /* 音频不可用时静默 */ }
}
