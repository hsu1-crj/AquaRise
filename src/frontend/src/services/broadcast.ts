/**
 * 场景播报总线 —— 页面各处产生"要说给人听/要显示"的提示, 统一经此发布;
 * 数字人导游(GuideDock)订阅后用自己的嗓门+字幕条呈现, 没有数字人时
 * 由订阅方自行降级到语音队列。
 *
 * 投放合并: 短时间窗口(1.6s)内同类型投放自动合并计数, 只发一条汇总,
 * 解决"连投三个塑料袋被念三遍"的观感问题。
 */

export interface BroadcastMessage {
  text: string;
  /** 来源标识(订阅方可按需过滤/染色) */
  kind: 'drop' | 'notice';
}

type Listener = (message: BroadcastMessage) => void;
interface ListenerEntry { fn: Listener; owner: 'guide' | 'page'; }

const listeners = new Set<ListenerEntry>();

/** 数字人导游是否在线订阅(在线时投放提示由数字人念, 页面不再双声道兜底) */
export function hasGuideListener(): boolean {
  for (const entry of listeners) if (entry.owner === 'guide') return true;
  return false;
}

/** 订阅播报流; 返回取消订阅函数。owner='guide' 的订阅者接管播报声道 */
export function onBroadcast(listener: Listener, owner: 'guide' | 'page' = 'page'): () => void {
  const entry: ListenerEntry = { fn: listener, owner };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

export function emitBroadcast(message: BroadcastMessage): void {
  for (const entry of listeners) {
    try {
      entry.fn(message);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

// ---------- 投放合并器 ----------
interface PendingDrop {
  name: string;
  harm: string;
  count: number;
}

let pendingDrops = new Map<string, PendingDrop>();
let flushTimer: number | null = null;
const FLUSH_AFTER_MS = 1600;

/**
 * 登记一次垃圾投放: 同类型在合并窗口内只累计, 窗口静默后汇总播报一条。
 * harm 只取同类型第一条(同种垃圾危害链相同)。
 */
export function reportGarbageDrop(name: string, harm: string): void {
  const existing = pendingDrops.get(name);
  if (existing) {
    existing.count += 1;
  } else {
    pendingDrops.set(name, { name, harm, count: 1 });
  }
  if (flushTimer != null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flushDrops, FLUSH_AFTER_MS);
}

/** 立即清空合并窗口(模式切换时调用, 避免悬空计时器在离开页面后触发) */
export function flushDropsNow(): void {
  if (flushTimer != null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDrops();
}

function flushDrops(): void {
  flushTimer = null;
  if (pendingDrops.size === 0) return;
  const drops = Array.from(pendingDrops.values());
  pendingDrops = new Map();
  const total = drops.reduce((sum, d) => sum + d.count, 0);
  const listText = drops.map((d) => (d.count > 1 ? `${d.name}×${d.count}` : d.name)).join('、');
  const harms = drops.map((d) => `${d.name}: ${d.harm}`).join('；');
  emitBroadcast({
    kind: 'drop',
    text: `已投放${listText}，共${total}处污染源。${harms}。`,
  });
}
