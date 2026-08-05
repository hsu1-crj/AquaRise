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
     * @param {string} config.appSecret      - 魔珐星云 App Secret (生产环境应从后端API获取)
     * @param {string} config.containerId    - DOM 容器元素 ID (如 'sdk')
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
     * 必须先调用此方法，等待 ready 事件后再调用 speak()
     */
    async init() {
      if (typeof XmovAvatar === 'undefined') {
        throw new Error('魔珐星云SDK未加载，请在HTML中引入: <script src="https://media.xingyun3d.com/xingyun3d/general/litesdk/xmovAvatar@latest.js"></script>');
      }

      const self = this;

      return new Promise((resolve, reject) => {
        try {
          self.sdk = new XmovAvatar({
            containerId: '#' + self.containerId,
            appId: self.appId,
            appSecret: self.appSecret,
            gatewayServer: self.gatewayServer,

            onMessage(message) {
              console.log('[XmovAvatar] 消息:', message);
              // 仅将真正错误码(>=10000)当作error，忽略info/warning级别消息
              if (message && message.code && message.code >= 10000) {
                console.error('[XmovAvatar] SDK错误 ' + message.code + ':', message.message || message);
                self._emit('error', message);
              }
            },

            onVoiceStateChange(status) {
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

          self.sdk.init({
            onDownloadProgress(progress) {
              console.log('[XmovAvatar] 加载进度:', progress + '%');
              self._emit('progress', progress);
            },
          }).then(() => {
            self.isReady = true;
            console.log('[XmovAvatar] 初始化完成');
            self._emit('ready');
            resolve();
          }).catch(reject);

        } catch (e) {
          reject(e);
        }
      });
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

      this.sdk.speak(text, isStart, isEnd);
    }

    /** 处理说话队列 */
    _processQueue() {
      if (this._speechQueue.length === 0) return;
      const { text, opts } = this._speechQueue.shift();
      this.speak(text, opts);
    }

    // ======================== 状态控制 ========================

    /** 待机状态 (长时间无交互) */
    idle() { this.sdk?.idle(); }

    /** 互动待机 (可打断当前播报) */
    interactiveIdle() { this.sdk?.interactiveidle(); this.isSpeaking = false; }

    /** 思考状态 (等待LLM回复时) */
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

    /** 销毁数字人实例，释放资源 */
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
