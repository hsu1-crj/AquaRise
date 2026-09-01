/**
 * 语音播报共享服务（Web Speech API, 中文）。
 *
 * speakText: 即时播报(打断旧播报) —— 场景事件(投放/到站/告警/答题/导游)都以"最新消息
 *            立刻被听到"为准则, 不排队续播旧消息, 避免语音与画面事件错位。
 */

let lastImmediate = '';
let lastImmediateAt = 0;

function makeUtterance(text: string): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 300));
  utterance.lang = 'zh-CN';
  utterance.rate = 1.05;
  return utterance;
}

/** 即时播报(打断旧播报)；短时间相同文本去重（force 跳过） */
export function speakText(text: string, opts: { force?: boolean } = {}): void {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const now = Date.now();
    if (!opts.force && clean === lastImmediate && now - lastImmediateAt < 4000) return;
    lastImmediate = clean;
    lastImmediateAt = now;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(makeUtterance(clean));
  } catch {
    /* 语音不可用时静默 */
  }
}

/** 停止全部播报（页面/模式切换、关闭语音开关时清理） */
export function stopSpeaking(): void {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    /* 忽略 */
  }
}
