/**
 * 语音播报共享服务（Web Speech API, 中文）。
 *
 * speakText:  即时播报(打断旧播报) —— 告警/答题等需要立刻被听到的场景
 * speakQueued: 队列播报(不打断) —— 科普投放提示等可排队的叙事场景,
 *             同文本自动合并计数, 队列超长丢弃最旧, 避免堆积。
 */

const MAX_QUEUE = 3;

let lastImmediate = '';
let lastImmediateAt = 0;
const queue: string[] = [];
let queueRunning = false;

function makeUtterance(text: string): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 300));
  utterance.lang = 'zh-CN';
  utterance.rate = 1.05;
  return utterance;
}

function drainQueue(): void {
  if (queueRunning || queue.length === 0) return;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    queue.length = 0;
    return;
  }
  queueRunning = true;
  const text = queue.shift() as string;
  const utterance = makeUtterance(text);
  const advance = () => {
    queueRunning = false;
    // 部分浏览器 utterance 回调后仍占用合成器, 让出一拍再排下一条
    window.setTimeout(drainQueue, 120);
  };
  utterance.onend = advance;
  utterance.onerror = advance;
  window.speechSynthesis.speak(utterance);
}

/** 即时播报(打断旧播报)；短时间相同文本去重 */
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

/** 队列播报(不打断进行中的语音)；相同文本合并为一条, 队列上限3条 */
export function speakQueued(text: string): void {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const existing = queue.indexOf(clean);
    if (existing >= 0) return; // 同文本已在队列: 不重复
    while (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(clean);
    drainQueue();
  } catch {
    /* 语音不可用时静默 */
  }
}

/** 停止全部播报并清空队列（页面/模式切换时清理） */
export function stopSpeaking(): void {
  try {
    queue.length = 0;
    queueRunning = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    /* 忽略 */
  }
}
