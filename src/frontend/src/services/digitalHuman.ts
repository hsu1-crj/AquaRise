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
export const DEFAULT_XMOV_SDK_INTEGRITY =
  'sha384-krYu4ZHwmSNtXwXO81hJ8Ec0SEHTHXqM4Ypzvs7rv8cahg7+oCMcMSYwyxuTaqDA';

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
        self.sdk = new XmovAvatar({
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
              self.emit('speakStart');
            } else if (status === 'voice_end' || status === 'end') {
              self.isSpeaking = false;
              self.emit('speakEnd');
              self.processQueue();
            }
          },
        });

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

  /** 驱动数字人说话 */
  speak(text: string, opts: SpeakOptions = {}): void {
    if (!this.isReady || !this.sdk) {
      this.speechQueue.push({ text, opts });
      return;
    }

    if (this.isSpeaking && !opts.interrupt) {
      this.speechQueue.push({ text, opts });
      return;
    }

    if (opts.interrupt) {
      this.interactiveIdle();
    }

    const isStart = opts.isStart !== false;
    const isEnd = opts.isEnd !== false;
    this.sdk.speak(text, isStart, isEnd);
  }

  /** 处理说话队列 */
  private processQueue(): void {
    if (this.speechQueue.length === 0) return;
    const { text, opts } = this.speechQueue.shift()!;
    this.speak(text, opts);
  }

  /** 待机状态 */
  idle(): void {
    this.sdk?.idle();
  }

  /** 互动待机（可打断当前播报） */
  interactiveIdle(): void {
    this.sdk?.interactiveIdle();
    this.isSpeaking = false;
  }

  /** 思考状态 */
  think(): void {
    this.sdk?.think();
  }

  /** 设置音量 0-1 */
  setVolume(v: number): void {
    this.sdk?.setVolume(Math.max(0, Math.min(1, v)));
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
