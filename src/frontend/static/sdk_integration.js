/**
 * ============================================================
 * 魔珐星云 Web SDK 集成模块 (XmovAvatar)
 * ============================================================
 * SDK CDN: https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js
 * 官方文档: https://xingyun3d.com/developers/52-183
 *
 * 使用方法:
 *   1. HTML中引入SDK脚本
 *   2. 创建 OceanDigitalHuman 实例
 *   3. 调用 init() 初始化 → speak() 驱动说话
 *   4. 对话结束调用 idle() 回到待机
 * ============================================================
 */

(function (global) {
  'use strict';

  class OceanDigitalHuman {
    /**
     * @param {Object} config
     * @param {string} config.appId          - 魔珐星云 App ID
     * @param {string} config.appSecret      - 魔珐星云 App Secret (从后端API获取)
     * @param {string} config.containerId    - DOM 容器元素 ID
     * @param {string} [config.gatewayServer] - 网关地址
     */
    constructor(config) {
      this.appId = config.appId;
      this.appSecret = config.appSecret;
      this.containerId = config.containerId;
      this.gatewayServer = config.gatewayServer || 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session';

      this.isReady = false;
      this.isSpeaking = false;
      this.sdk = null;
      this._listeners = {};
      this._speechQueue = [];
    }

    // ======================== 初始化 ========================

    /**
     * 初始化数字人 SDK
     * 确保容器有有效尺寸后再初始化，避免黑屏
     */
    async init() {
      if (typeof XmovAvatar === 'undefined') {
        throw new Error('魔珐星云SDK未加载，请在HTML中引入SDK脚本');
      }

      const container = document.getElementById(this.containerId);
      if (!container) {
        throw new Error('容器元素 #' + this.containerId + ' 不存在');
      }

      // 确保容器有有效尺寸（WebGL 需要 > 0 的宽高）
      await this._waitForSize(container);

      const self = this;

      return new Promise((resolve, reject) => {
        try {
          const rect = container.getBoundingClientRect();
          console.log('[XmovAvatar] 容器尺寸:', rect.width + '×' + rect.height);

          self.sdk = new XmovAvatar({
            containerId: '#' + self.containerId,
            appId: self.appId,
            appSecret: self.appSecret,
            gatewayServer: self.gatewayServer,
            orientation: 'portrait',
            enableDebugger: false,
            // 禁用 SDK 自带字幕弹窗：代理掉 subtitle_on/subtitle_off 事件，只保留语音+动作
            proxyWidget: {
              subtitle_on:  () => {},
              subtitle_off: () => {},
            },

            onMessage(message) {
              const code = message && message.code;
              const msg  = message && message.message;
              console.log('[XmovAvatar] 消息 code=' + code + ':', msg || '');
              // 50001-50004 为网络状态信息（离线/在线/重试/断开），属非致命状态，不触发 error
              // 仅 10001-10005(初始化/会话错误) 与 20001-20003(视频抽帧错误) 视为致命错误
              if (code && code >= 10000 && code < 50000) {
                console.error('[XmovAvatar] SDK错误 ' + code + ':', msg || message);
                self._emit('error', { code, message: msg });
              } else if (code && code >= 50000) {
                console.warn('[XmovAvatar] 网络状态 ' + code + ':', msg || '');
              }
            },

            onVoiceStateChange(status) {
              console.log('[XmovAvatar] 语音状态:', status);
              if (status === 'voice_start' || status === 'start') {
                self.isSpeaking = true;
                self._emit('speakStart');
              } else if (status === 'voice_end' || status === 'end') {
                self.isSpeaking = false;
                self._emit('speakEnd');
                self._processQueue();
              }
            },
          });

          // 带超时的初始化
          const TIMEOUT = 30000; // 30秒
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('SDK初始化超时(' + TIMEOUT/1000 + 's)，请检查网络或appId/appSecret'));
          }, TIMEOUT);

          self.sdk.init({
            onDownloadProgress(progress) {
              console.log('[XmovAvatar] 加载进度:', progress + '%');
              self._emit('progress', progress);
            },
          }).then(() => {
            if (timedOut) return;
            clearTimeout(timer);
            self.isReady = true;
            console.log('[XmovAvatar] 初始化完成，数字人已就绪');
            self._emit('ready');
            resolve();
          }).catch((err) => {
            if (timedOut) return;
            clearTimeout(timer);
            console.error('[XmovAvatar] 初始化失败:', err);
            reject(err);
          });

        } catch (e) {
          reject(e);
        }
      });
    }

    /**
     * 等待容器拥有有效尺寸（WebGL 渲染需要 >0 的宽高）
     * 最多等待 3 秒
     */
    async _waitForSize(container, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) return;
        await new Promise(r => setTimeout(r, 100));
      }
      console.warn('[XmovAvatar] 容器尺寸仍然偏小，尝试强制设置');
      // 强制给容器一个最小尺寸
      if (container.offsetWidth < 100) container.style.width = '360px';
      if (container.offsetHeight < 100) container.style.minHeight = '400px';
    }

    // ======================== 说话 ========================

    /**
     * 驱动数字人说话
     * @param {string} text    - 文本内容 (支持纯文本或SSML)
     * @param {Object} [opts]
     * @param {boolean} [opts.isStart] - 是否为本轮首句 (默认true)
     * @param {boolean} [opts.isEnd]   - 是否为本轮末句 (默认true)
     * @param {boolean} [opts.interrupt] - 是否打断当前播放
     */
    speak(text, opts = {}) {
      if (!this.isReady || !this.sdk) {
        this._speechQueue.push({ text, opts });
        return;
      }

      if (this.isSpeaking && !opts.interrupt) {
        this._speechQueue.push({ text, opts });
        return;
      }

      if (opts.interrupt) {
        this.interactiveIdle();
      }

      const isStart = opts.isStart !== false;
      const isEnd = opts.isEnd !== false;

      console.log('[XmovAvatar] speak:', (text || '(空)').slice(0, 40),
        'isStart=' + isStart, 'isEnd=' + isEnd);
      this.sdk.speak(text, isStart, isEnd);
    }

    /** 处理说话队列 */
    _processQueue() {
      if (this._speechQueue.length === 0) return;
      const { text, opts } = this._speechQueue.shift();
      this.speak(text, opts);
    }

    // ======================== 状态控制 ========================

    /** 待机状态 */
    idle() { this.sdk?.idle(); }

    /** 互动待机 (打断当前播报) */
    interactiveIdle() {
      this.sdk?.interactiveidle();
      this.isSpeaking = false;
    }

    /** 思考状态 */
    think() { this.sdk?.think(); }

    // ======================== 音量控制 ========================

    setVolume(v) { this.sdk?.setVolume(Math.max(0, Math.min(1, v))); }

    // ======================== 事件系统 ========================

    on(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
      return () => this.off(event, fn);
    }

    off(event, fn) {
      const list = this._listeners[event];
      if (list) {
        const i = list.indexOf(fn);
        if (i > -1) list.splice(i, 1);
      }
    }

    _emit(event, data) {
      (this._listeners[event] || []).forEach(fn => {
        try { fn(data); } catch (e) { console.error('[XmovAvatar] 事件回调异常:', e); }
      });
    }

    // ======================== 销毁 ========================

    destroy() {
      this._speechQueue = [];
      this.isReady = false;
      this.isSpeaking = false;
      this._listeners = {};
      this.sdk?.destroy();
      this.sdk = null;
      console.log('[XmovAvatar] 数字人已销毁');
    }
  }

  global.OceanDigitalHuman = OceanDigitalHuman;
})(typeof window !== 'undefined' ? window : globalThis);
