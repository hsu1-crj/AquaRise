/**
 * ============================================================
 * 魔珐星云 Web SDK 集成模块 (XmovAvatar)
 * ============================================================
 * SDK CDN: https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js
 * 官方文档: https://xingyun3d.com/developers/52-183
 *
 * 使用方法:
 *   1. 调用 loadXmovSDK() 动态加载SDK脚本
 *   2. 创建 OceanDigitalHuman 实例
 *   3. 调用 init() 初始化 → speak() 驱动说话
 *   4. 对话结束调用 idle() 回到待机
 * ============================================================
 */

declare global {
  interface Window {
    XmovAvatar?: new (config: XmovConfig) => XmovInstance;
  }
}

interface XmovConfig {
  containerId: string;
  appId: string;
  appSecret: string;
  gatewayServer: string;
  onMessage?: (message: XmovMessage) => void;
  onVoiceStateChange?: (status: string) => void;
}

interface XmovMessage {
  code?: number;
  message?: string;
}

interface XmovInstance {
  init(options: { onDownloadProgress?: (progress: number) => void }): Promise<void>;
  speak(text: string, isStart: boolean, isEnd: boolean): void;
  idle(): void;
  interactiveIdle(): void;
  think(): void;
  setVolume(v: number): void;
  destroy(): void;
}

export type DigitalHumanStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline';

type EventType = 'ready' | 'speakStart' | 'speakEnd' | 'error' | 'progress';
type EventCallback = (data?: unknown) => void;

export interface DigitalHumanConfig {
  appId: string;
  appSecret: string;
  containerId: string;
  gatewayServer?: string;
}

export const DEFAULT_XMOV_SDK_URL =
  'https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js';
// 魔珐 CDN 的 @latest 文件会随版本更新, 固定校验和会失效并拦截脚本; 默认不启用SRI,
// 后端如返回新的 sdk_integrity 则按后端为准。
export const DEFAULT_XMOV_SDK_INTEGRITY = '';

/** 动态加载魔珐星云 SDK 脚本 */
export function loadXmovSDK(
  sdkUrl = DEFAULT_XMOV_SDK_URL,
  integrity = DEFAULT_XMOV_SDK_INTEGRITY,
): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('仅浏览器环境可用'));
  if (window.XmovAvatar) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdkUrl;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('魔珐星云SDK加载失败'));
    document.head.appendChild(script);
  });
}

export class OceanDigitalHuman {
  private appId: string;
  private appSecret: string;
  private containerId: string;
  private gatewayServer: string;

  public isReady = false;
  public isSpeaking = false;
  private sdk: XmovInstance | null = null;
  private listeners: Record<string, EventCallback[]> = {};
  private speechQueue: Array<{ text: string; opts: SpeakOptions }> = [];
  /** 首条语音已发出但还没收到 voice_start：期间续传片段必须排队，防止被 SDK 当作新会话打断 */
  private awaitingVoiceStart = false;
  /** 用户主动静音：SDK 的 visibilitychange 会无条件恢复音量，这里强制覆盖回 0 */
  private userMuted = false;

  constructor(config: DigitalHumanConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.containerId = config.containerId;
    this.gatewayServer =
      config.gatewayServer || 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session';
  }

  /** 初始化数字人 SDK，必须先调用此方法 */
  async init(): Promise<void> {
    const XmovAvatar = window.XmovAvatar;
    if (!XmovAvatar) {
      throw new Error(
        '魔珐星云SDK未加载，请先调用 loadXmovSDK()'
      );
    }

        const self = this;
        return new Promise((resolve, reject) => {
          try {
            const avatar = new XmovAvatar({
              containerId: '#' + self.containerId,
              appId: self.appId,
              appSecret: self.appSecret,
              gatewayServer: self.gatewayServer,

              onMessage(message: XmovMessage) {
                console.log('[XmovAvatar] 消息:', message);
                if (message && message.code && message.code >= 10000) {
                  console.error('[XmovAvatar] SDK错误 ' + message.code + ':', message.message || message);
                  self.emit('error', message);
                }
              },

              onVoiceStateChange(status: string) {
                if (status === 'voice_start' || status === 'start') {
                  self.isSpeaking = true;
                  self.awaitingVoiceStart = false;
                  self.emit('speakStart');
                  // 首句等待出声期间缓存的续传片段，此刻立即补发，保证流式语音不断档
                  self.processQueue();
                } else if (status === 'voice_end' || status === 'end') {
                  self.isSpeaking = false;
                  self.awaitingVoiceStart = false;
                  self.emit('speakEnd');
                  self.processQueue();
                }
              },
            });

            // SDK 在切回前台时会无条件 setVolume(1)（visibilitychange 处理），
            // 包一层强制用户静音优先，避免静音状态被 SDK 内部逻辑悄悄解除。
            const sdkRecord = avatar as unknown as Record<string, unknown>;
            if (typeof sdkRecord.setVolume === 'function') {
              const originalSetVolume = (sdkRecord.setVolume as (v: number) => void).bind(avatar);
              sdkRecord.setVolume = (v: number) => originalSetVolume(self.userMuted ? Math.min(v, 0) : v);
            }
            self.sdk = avatar;

        (self.sdk as XmovInstance)
          .init({
            onDownloadProgress(progress: number) {
              console.log('[XmovAvatar] 加载进度:', progress + '%');
              self.emit('progress', progress);
            },
          })
          .then(() => {
            self.isReady = true;
            console.log('[XmovAvatar] 初始化完成');
            self.emit('ready');
            resolve();
          })
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 当前是否有语音会话（已出声或已发出首句等待出声） */
  get speechActive(): boolean {
    return this.isSpeaking || this.awaitingVoiceStart;
  }

  /** 驱动数字人说话。isStart=false 的续传片段在会话内直接追加，不排队不打断 */
  speak(text: string, opts: SpeakOptions = {}): void {
    if (!this.isReady || !this.sdk) {
      this.speechQueue.push({ text, opts });
      return;
    }

    const wantsNewSession = opts.isStart !== false;
    const active = this.isSpeaking || this.awaitingVoiceStart;
    if (wantsNewSession && active && !opts.interrupt) {
      this.speechQueue.push({ text, opts });
      return;
    }
    if (wantsNewSession && opts.interrupt && active) {
      this.stopSpeaking();
    }
    // 续传片段到达时会话已结束（如句间被云端提前收尾）：升级为新会话起点，避免被 SDK 丢弃
    const isStart = wantsNewSession || !active;
    if (isStart) this.awaitingVoiceStart = true;
    const isEnd = opts.isEnd !== false;
    try {
      this.sdk.speak(text, isStart, isEnd);
    } catch {
      // 瞬时播报失败(打断竞态等)不致命: 复位状态, 后续播报照常
      this.isSpeaking = false;
      this.awaitingVoiceStart = false;
    }
  }

  /** 处理说话队列 */
  private processQueue(): void {
    if (this.speechQueue.length === 0) return;
    const { text, opts } = this.speechQueue.shift()!;
    this.speak(text, opts);
  }

  /** 立刻打断当前播报并清空队列。优先用 SDK 的 interrupt（掐断已缓冲音频），再退 interactiveidle/idle */
  stopSpeaking(): void {
    try {
      const sdk = this.sdk as unknown as Record<string, unknown> | null;
      if (typeof sdk?.interrupt === 'function') {
        // "new_speak_start" 是 SDK 内部打断当前语音时使用的标准 reason 值，
        // 会清空音频缓存队列并暂停渲染器，立即掐断已缓冲语音。
        (sdk.interrupt as (reason?: string) => void).call(sdk, 'new_speak_start');
      } else if (typeof sdk?.interactiveidle === 'function') {
        (sdk.interactiveidle as () => void).call(sdk);
      } else if (typeof sdk?.interactiveIdle === 'function') {
        (sdk.interactiveIdle as () => void).call(sdk);
      } else if (typeof sdk?.idle === 'function') {
        (sdk.idle as () => void).call(sdk);
      }
    } catch { /* SDK 不支持打断时忽略 */ }
    this.isSpeaking = false;
    this.awaitingVoiceStart = false;
    this.speechQueue.length = 0;
  }

  /** 待机状态 */
  idle(): void {
    try { this.sdk?.idle?.(); } catch { /* SDK 版本不支持时忽略, 不影响页面 */ }
  }

  /** 互动待机（可打断当前播报）; 兼容 SDK 小写 interactiveidle 与旧版 idle */
  interactiveIdle(): void {
    try {
      const sdk = this.sdk as unknown as Record<string, unknown> | null;
      if (typeof sdk?.interactiveidle === 'function') (sdk.interactiveidle as () => void).call(sdk);
      else if (typeof sdk?.interactiveIdle === 'function') (sdk.interactiveIdle as () => void).call(sdk);
      else if (typeof sdk?.idle === 'function') (sdk.idle as () => void).call(sdk);
    } catch { /* SDK 不支持打断时忽略, 浏览器语音已由 stopSpeaking 清空 */ }
    this.isSpeaking = false;
    this.awaitingVoiceStart = false;
    this.speechQueue.length = 0;
  }

  /** 思考状态 */
  think(): void {
    try { this.sdk?.think?.(); } catch { /* SDK 版本不支持时忽略 */ }
  }

  /** 用户静音开关：静音期间 SDK 内部的音量恢复（如切回前台）也会被强制压回 0 */
  setMuted(muted: boolean): void {
    this.userMuted = muted;
    this.setVolume(muted ? 0 : 1);
  }

  /** 设置音量 0-1 */
  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    const forced = this.userMuted ? Math.min(clamped, 0) : clamped;
    try { this.sdk?.setVolume(forced); } catch { /* SDK 版本不支持时忽略 */ }
  }

  // ======================== 事件系统 ========================

  on(event: EventType, fn: EventCallback): () => void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return () => this.off(event, fn);
  }

  off(event: EventType, fn: EventCallback): void {
    const list = this.listeners[event];
    if (list) {
      const i = list.indexOf(fn);
      if (i > -1) list.splice(i, 1);
    }
  }

  private emit(event: EventType, data?: unknown): void {
    (this.listeners[event] || []).forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error('[XmovAvatar] 事件回调异常:', e);
      }
    });
  }

  /** 销毁数字人实例，释放资源 */
  destroy(): void {
    this.speechQueue = [];
    this.isReady = false;
    this.isSpeaking = false;
    this.awaitingVoiceStart = false;
    this.userMuted = false;
    this.listeners = {};
    this.sdk?.destroy();
    this.sdk = null;
    console.log('[XmovAvatar] 数字人已销毁');
  }
}

interface SpeakOptions {
  isStart?: boolean;
  isEnd?: boolean;
  interrupt?: boolean;
}
