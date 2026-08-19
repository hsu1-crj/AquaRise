/**
 * 语音播报共享服务（Web Speech API, 中文）。
 * Ocean3D 页(检测联动/告警/科普)与数字人导游降级路径共用同一实现,
 * 避免各处重复创建 utterance 或互相抢占。
 */

let lastText = '';
let lastAt = 0;

/** 播报一段中文文本；短时间相同文本去重，避免轮询场景重复朗读 */
export function speakText(text: string, opts: { force?: boolean } = {}): void {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const now = Date.now();
    if (!opts.force && clean === lastText && now - lastAt < 4000) return;
    lastText = clean;
    lastAt = now;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 300));
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* 语音不可用时静默 */
  }
}

/** 停止当前播报（页面切换/模式切换时清理） */
export function stopSpeaking(): void {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    /* 忽略 */
  }
}
