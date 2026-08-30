/*
 * 海瞳声音场管理器
 *
 * 声音文件仍然由项目静态资源提供，模块只负责播放编排与 Web Audio
 * 处理。所有音频条目都保留 type/source/license，避免把合成占位声误称
 * 为真实动物录音。
 */

const DEFAULT_LEVELS = Object.freeze({
  bgm: 0.45,
  ambience: 0.3,
  call: 0.68,
  voice: 0.95,
  sfx: 0.72
});

const DEFAULT_DUCK_LEVEL = 0.14;
const DEFAULT_FADE_MS = 900;

// 静默时的共享零值快照：getLevels 每帧调用，返回新对象会造成稳定的高频小对象分配
const ZERO_LEVELS = Object.freeze({ low: 0, mid: 0, high: 0, pan: 0 });

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
}

function asSources(track) {
  if (!track) return [];
  if (Array.isArray(track.sources)) return track.sources.filter(Boolean);
  if (track.src) return [track.src];
  return [];
}

function audioType(source) {
  const extension = String(source).split("?")[0].split(".").pop().toLowerCase();
  if (extension === "ogg" || extension === "oga") return "audio/ogg";
  if (extension === "wav" || extension === "wave") return "audio/wav";
  return "audio/mpeg";
}

function normalizeTrack(track, kind) {
  if (!track) return null;
  const sources = asSources(track);
  return {
    ...track,
    kind,
    sources,
    type: track.type || kind,
    gain: clamp(track.gain ?? 1),
    pan: clamp(track.pan ?? 0, -1, 1),
    filter: track.filter || null,
    reverb: track.reverb || null
  };
}

function isMediaElement(value) {
  return value && typeof value.play === "function" && typeof value.pause === "function";
}

export class SoundscapeManager {
  constructor({
    documentRef = typeof document !== "undefined" ? document : null,
    onStatus = () => {},
    levels = {},
    fadeMs = DEFAULT_FADE_MS,
    duckLevel = DEFAULT_DUCK_LEVEL
  } = {}) {
    this.document = documentRef;
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    this.mixLevels = { ...DEFAULT_LEVELS, ...levels };
    this.levels = { low: 0, mid: 0, high: 0, pan: 0 };
    this.fadeMs = fadeMs;
    this.duckLevel = duckLevel;
    this.context = null;
    this.masterGain = null;
    this.buses = new Map();
    this.tracks = new Map();
    this.preloadedTracks = new Map();
    this.bgm = null;
    this.bgmTrack = null;
    this.activeSpecies = null;
    this.sequenceId = 0;
    // 每类声音的并发代次：新一轮 playTrack / stopKind 会作废同一类上仍在等待的过期调用，
    // 防止快速连点切物种时，迟到恢复的旧调用杀掉新轨道。
    this._generation = { bgm: 0, ambience: 0, call: 0, voice: 0, sfx: 0 };
    // 独白压低（ducking）代次：只有最新一次独白请求才能在结束时解除压低，
    // 避免"上一条独白自然结束"与"下一条独白开始压低"交错的窄窗口里背景音突增。
    this._voiceGen = 0;
    this._whaleFxResetTimer = null;
    this.voicePlaying = false;
    this.lastStatus = "声音待命 · 点击背景音或开启摄像头解锁音频";
    // 音频资源存在性探测缓存：缺失文件不产生控制台 404 噪音，直接以"未加载"继续运行
    this._probeCache = new Map();
    // 每种声音轨道的可见状态：playing 播放 / paused 暂停 / unloaded 未加载 / blocked 浏览器阻止自动播放
    this.kindState = { bgm: "paused", ambience: "unloaded", call: "unloaded", voice: "unloaded", sfx: "unloaded" };
  }

  getKindState(kind) {
    return this.kindState[kind] || "unloaded";
  }

  /**
   * 声音驱动粒子所需的三频带能量与声像，逐帧调用：
   * - low  ≈ 20-250Hz  低频呼吸
   * - mid  ≈ 250-2kHz  中频亮度
   * - high ≈ 2kHz+     高频闪烁/海雪
   * - pan  当前活跃轨道 StereoPanner 平均位置（-1 左 ~ +1 右），影响粒子流动方向
   * 无音频、自动播放被拦截或分析节点不可用时全部返回 0，粒子系统照常运行。
   */
  getLevels() {
    if (!this.analyser || !this.freqData || this.context?.state !== "running") {
      return ZERO_LEVELS;
    }
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.analyser.frequencyBinCount;
    if (n === 0) return ZERO_LEVELS;
    let lowSum = 0, midSum = 0, highSum = 0;
    const lowEnd = Math.max(1, Math.floor(n * 0.08));   // ~前 8% bin
    const midEnd = Math.max(lowEnd + 1, Math.floor(n * 0.32));
    for (let i = 0; i < n; i++) {
      const v = this.freqData[i] / 255;
      if (i < lowEnd) lowSum += v;
      else if (i < midEnd) midSum += v;
      else highSum += v;
    }
    const low = lowSum / lowEnd;
    const mid = midSum / Math.max(1, midEnd - lowEnd);
    const high = highSum / Math.max(1, n - midEnd);

    let panSum = 0, panCount = 0;
    for (const track of this.tracks.values()) {
      if (track.panNode && !track.element.paused) {
        panSum += track.panNode.pan.value;
        panCount += 1;
      }
    }
    const pan = panCount ? panSum / panCount : 0;

    // 指数平滑：视觉变化连续，不随频谱抖动
    const k = 0.22;
    this.levels.low += (low - this.levels.low) * k;
    this.levels.mid += (mid - this.levels.mid) * k;
    this.levels.high += (high - this.levels.high) * k;
    this.levels.pan += (pan - this.levels.pan) * k;
    // 就地返回共享快照（消费方在当帧内同步读取），不再每次调用新建对象
    return this.levels;
  }

  status(message, detail = {}) {
    this.lastStatus = message;
    try {
      this.onStatus(message, detail);
    } catch (error) {
      console.warn("Soundscape status callback failed:", error);
    }
  }

  async unlock() {
    if (!this.context) this.createGraph();
    if (!this.context) return false; // 浏览器不支持 Web Audio
    if (this.context.state === "suspended") {
      // 同步先发起 resume 再等待：iOS Safari 等严格策略要求 play/resume 贴近用户手势调用栈，
      // 不能等探测/解码等 await 之后再启动。
      const resuming = this.context.resume();
      try {
        await Promise.race([
          resuming,
          new Promise(resolve => globalThis.setTimeout(resolve, 300))
        ]);
      } catch (error) {
        this.status("音频上下文无法启动 · 图片、粒子与手势仍可使用", { type: "context", error });
        return false;
      }
    }
    return this.context.state === "running";
  }

  createGraph() {
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      this.status("当前浏览器不支持 Web Audio · 视觉与手势仍可使用", { type: "unsupported" });
      return false;
    }

    try {
      this.context = new AudioContextCtor();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 1;
      // 分析节点不改变音频通路：masterGain → analyser → destination，
      // 供粒子系统读取低频/中频/高频能量与声像位置。
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.82;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.createBuses();
      return true;
    } catch (error) {
      this.context = null;
      this.analyser = null;
      this.freqData = null;
      this.status("音频初始化失败 · 视觉与手势仍可使用", { type: "context", error });
      return false;
    }
  }

  createBuses() {
    ["bgm", "ambience", "call", "voice", "sfx"].forEach(kind => {
      const gain = this.context.createGain();
      gain.gain.value = clamp(this.mixLevels[kind]);
      gain.connect(this.masterGain);
      this.buses.set(kind, gain);
    });

    this.reverb = this.context.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(1.8, 2.2);
    this.reverbGain = this.context.createGain();
    this.reverbGain.gain.value = 0.16;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.masterGain);
  }

  createImpulseResponse(duration, decay) {
    const length = Math.max(1, Math.floor(this.context.sampleRate * duration));
    const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / data.length, decay);
      }
    }
    return buffer;
  }

  attachBgm(element, metadata = {}) {
    if (!isMediaElement(element)) return false;
    this.bgm = element;
    this.bgmTrackConfig = normalizeTrack({
      src: element.currentSrc || element.src,
      type: "bgm",
      source: metadata.source || "项目现有背景音乐",
      license: metadata.license || "项目资源，授权信息待补充",
      ...metadata
    }, "bgm");
    return true;
  }

  ensureTrack(kind, element, config) {
    let track = this.tracks.get(element);
    if (track) return track;
    const sourceNode = this.context.createMediaElementSource(element);
    const gainNode = this.context.createGain();
    const panNode = this.context.createStereoPanner ? this.context.createStereoPanner() : null;
    const filterConfig = config.filter || {};
    const filterNode = this.context.createBiquadFilter();
    filterNode.type = filterConfig.type || "lowpass";
    filterNode.frequency.value = Number(filterConfig.frequency) || 18000;
    filterNode.Q.value = Number(filterConfig.Q) || 0.7;

    sourceNode.connect(filterNode);
    if (panNode) {
      filterNode.connect(panNode);
      panNode.connect(gainNode);
      panNode.pan.value = clamp(config.pan, -1, 1);
    } else {
      filterNode.connect(gainNode);
    }
    gainNode.connect(this.buses.get(kind));

    const reverbSend = this.context.createGain();
    reverbSend.gain.value = clamp(config.reverb?.amount ?? 0);
    filterNode.connect(reverbSend);
    reverbSend.connect(this.reverb);

    track = { kind, element, config, gainNode, panNode, filterNode, reverbSend, endedHandler: null };
    this.tracks.set(element, track);
    return track;
  }

  createElement(kind, config) {
    if (!this.document) return null;
    const element = this.document.createElement("audio");
    element.preload = "auto";
    element.playsInline = true;
    element.crossOrigin = "anonymous";
    const sources = asSources(config);
    if (sources.length > 1) {
      sources.forEach(source => {
        const child = this.document.createElement("source");
        child.src = source;
        child.type = audioType(source);
        element.appendChild(child);
      });
    } else if (sources[0]) {
      element.src = sources[0];
    }
    element.playbackRate = Math.min(1.2, Math.max(0.82, Number(config.playbackRate) || 1));
    return element;
  }

  rampGain(gainNode, value, durationMs = this.fadeMs) {
    if (!this.context || !gainNode) return;
    const now = this.context.currentTime;
    const target = clamp(value);
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(target, now + Math.max(0.01, durationMs / 1000));
  }

  async _sourceExists(url) {
    if (this._probeCache.has(url)) return this._probeCache.get(url);
    const outcome = await (async () => {
      try {
        const absolute = new URL(url, this.document?.baseURI || globalThis.location?.href);
        const response = await fetch(absolute, { method: "HEAD", cache: "no-store" });
        // 只有"明确缺失/已删除"才缓存为 false；405、5xx 等异常状态视为未知不缓存，便于下次重试
        if (response.ok) return true;
        if (response.status === 404 || response.status === 410) return false;
        return null;
      } catch (_) {
        return null; // 网络瞬断不能永久缓存为"缺失"，否则该音源整个会话都无法恢复
      }
    })();
    if (outcome === null) return false;
    this._probeCache.set(url, outcome);
    return outcome;
  }

  /** 只保留磁盘上真实存在的源：缺失文件不请求、不产生控制台 404。 */
  async resolveExistingSources(trackConfig) {
    const config = normalizeTrack(trackConfig);
    if (!config || !asSources(config).length) return config;
    const kept = [];
    for (const source of asSources(config)) {
      if (await this._sourceExists(source)) kept.push(source);
    }
    return { ...config, sources: kept };
  }

  /** 鼠标悬浮或触摸时只预载，不播放；缓存元素在离开后继续保留。 */
  async preloadTrack(kind, trackConfig) {
    const resolved = await this.resolveExistingSources(trackConfig);
    const config = normalizeTrack(resolved, kind);
    const sources = asSources(config);
    if (!config || !sources.length) return false;
    const key = `${kind}:${sources.join("|")}`;
    if (this.preloadedTracks.has(key)) return true;
    const element = this.createElement(kind, config);
    if (!element) return false;
    element.preload = "auto";
    element.load();
    this.preloadedTracks.set(key, element);
    if (this.kindState[kind] === "unloaded") this.kindState[kind] = "paused";
    return true;
  }

  async playTrack(kind, trackConfig, { loop = false, fadeMs = this.fadeMs, replace = true } = {}) {
    // 并发代次：探测/解锁期间任何外部 stopKind/新播放都会让本次调用作废，
    // 杜绝"迟到的旧调用杀掉新轨道"的竞态。replace 触发的 stopKind 属于同一次
    // 播放的准备工作，必须在上台登记新一代次之后才允许被外部作废——否则每次
    // replace 播放都会在起播前把自己判死，物种独白永远发不出声音。
    const preGen = this._generation[kind];
    const superseded = () => this._generation[kind] !== preGen;
    const duckGen = kind === "voice" ? ++this._voiceGen : null;

    const probed = await this.resolveExistingSources(trackConfig);
    if (superseded()) return { ok: false, interrupted: true };
    const config = normalizeTrack(probed, kind);
    if (!config || !asSources(config).length) {
      this.kindState[kind] = "unloaded";
      this.status(`${this.label(kind)}不可用 · 已继续运行`, { type: "missing", kind, config });
      return { ok: false, missing: true };
    }
    const unlocked = await this.unlock();
    if (superseded()) return { ok: false, interrupted: true };
    if (!unlocked) {
      this.kindState[kind] = "blocked";
      return { ok: false, unavailable: true };
    }

    if (replace) this.stopKind(kind, fadeMs);
    if (kind === "voice") this.setVoiceDucking(true, fadeMs);
    const gen = ++this._generation[kind];
    const stale = () => gen !== this._generation[kind];
    const element = this.createElement(kind, config);
    if (!element) return { ok: false, unavailable: true };
    const track = this.ensureTrack(kind, element, config);
    element.loop = loop;
    const startGain = clamp(config.gain);
    track.gainNode.gain.setValueAtTime(0, this.context.currentTime);
    this.rampGain(track.gainNode, startGain, fadeMs);
    this.tracks.set(element, track);

    const result = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // 被 stopKind / 新一轮播放打断时立即结算等待方，避免 await 永久悬挂。
      track.onInterrupted = () => finish({ ok: false, interrupted: true });
      const fail = error => {
        // 浏览器以 AbortError 中止被打断的 play()：属于正常打断而非文件缺失
        if ((error && error.name === "AbortError") || stale()) {
          finish({ ok: false, interrupted: true });
          return;
        }
        this.kindState[kind] = "unloaded";
        this.status(`${this.label(kind)}文件不存在或无法播放 · 已继续运行`, { type: "missing", kind, config, error });
        finish({ ok: false, missing: true, error });
      };
      track.endedHandler = () => {
        this.kindState[kind] = "paused";
        // 只有仍然最新的独白才能解除压低；旧轨道的 ended 不许提前恢复背景音量。
        if (kind === "voice" && this._voiceGen === duckGen) this.setVoiceDucking(false, fadeMs);
        this.status(`${this.label(kind)}播放结束`, { type: "ended", kind });
        finish({ ok: true, ended: true, element, track });
      };
      element.addEventListener("ended", track.endedHandler, { once: true });
      element.addEventListener("error", fail, { once: true });
      const promise = element.play();
      this.kindState[kind] = "playing";
      if (promise && typeof promise.catch === "function") promise.catch(fail);
      if (loop) finish({ ok: true, element, track });
    });

    if (!result.ok) {
      // 打断场景的淡出与元素回收由打断方（stopKind）负责，这里不重复抢操作。
      if (!result.interrupted) {
        this.rampGain(track.gainNode, 0, Math.min(220, fadeMs));
        try { element.pause(); } catch (_) {}
        if (kind === "voice") this.setVoiceDucking(false, fadeMs);
      }
    } else {
      this.kindState[kind] = result.ended ? "paused" : "playing";
    }
    return result;
  }

  stopKind(kind, fadeMs = this.fadeMs) {
    // 立刻作废该类声音上仍在等待的 playTrack 调用（含起播窗口内的 play() Promise）
    this._generation[kind] += 1;
    [...this.tracks.values()].filter(track => track.kind === kind).forEach(track => {
      if (track.onInterrupted) track.onInterrupted();
      this.rampGain(track.gainNode, 0, fadeMs);
      window.setTimeout(() => {
        try { track.element.pause(); track.element.currentTime = 0; } catch (_) {}
        this.releaseTrack(track);
      }, fadeMs + 40);
    });
    this.kindState[kind] = "paused";
    if (kind === "voice") this.setVoiceDucking(false, fadeMs);
  }

  releaseTrack(track) {
    // 断开节点图并从 tracks 移除，避免反复切换物种/音效时 <audio> 与 Web Audio 节点无限累积。
    try { track.gainNode?.disconnect(); } catch (_) {}
    try { track.filterNode?.disconnect(); } catch (_) {}
    try { track.panNode?.disconnect(); } catch (_) {}
    try { track.reverbSend?.disconnect(); } catch (_) {}
    try { track.element.removeAttribute("src"); track.element.load(); } catch (_) {}
    this.tracks.delete(track.element);
  }

  setVoiceDucking(active, fadeMs = this.fadeMs) {
    this.voicePlaying = active;
    const bgmBus = this.buses.get("bgm");
    const ambienceBus = this.buses.get("ambience");
    if (bgmBus) this.rampGain(bgmBus, active ? this.duckLevel : this.mixLevels.bgm, fadeMs);
    if (ambienceBus) this.rampGain(ambienceBus, active ? 0.07 : this.mixLevels.ambience, fadeMs);
  }

  async playBgm() {
    if (!this.bgm) {
      this.status("背景音乐文件不存在 · 视觉与手势仍可使用", { type: "missing", kind: "bgm" });
      return false;
    }
    const unlocked = await this.unlock();
    if (!unlocked) {
      this.kindState.bgm = "blocked";
      this.status("浏览器阻止自动播放 · 点击背景音按钮重试", { type: "blocked", kind: "bgm" });
      return false;
    }
    if (!this.bgmTrack) this.bgmTrack = this.ensureTrack("bgm", this.bgm, this.bgmTrackConfig || normalizeTrack({ src: this.bgm.currentSrc || this.bgm.src }, "bgm"));
    try {
      this.bgm.loop = true;
      this.bgmTrack.gainNode.gain.setValueAtTime(1, this.context.currentTime);
      await this.bgm.play();
      this.kindState.bgm = "playing";
      this.status("背景音播放中 · 独白时自动降低", { type: "playing", kind: "bgm" });
      return true;
    } catch (error) {
      this.kindState.bgm = "blocked";
      this.status("浏览器阻止自动播放 · 点击背景音按钮重试", { type: "blocked", kind: "bgm", error });
      return false;
    }
  }

  pauseBgm() {
    if (!this.bgm) return;
    this.kindState.bgm = "paused";
    this.rampGain(this.bgmTrack?.gainNode, 0, 220);
    window.setTimeout(() => {
      try { this.bgm.pause(); } catch (_) {}
    }, 240);
    this.status("背景音已暂停", { type: "paused", kind: "bgm" });
  }

  async toggleBgm() {
    if (this.bgm && !this.bgm.paused) {
      this.pauseBgm();
      return false;
    }
    return this.playBgm();
  }

  async enterSpecies(species) {
    // 切换动物：旧音频约 350ms 快速淡出，新环境声慢速淡入形成交叉淡化。
    this.stopAllSpeciesSounds(350);
    const id = ++this.sequenceId;
    this.activeSpecies = species;
    const ambience = species?.soundscape?.ambience;
    await this.playTrack("ambience", ambience, { loop: true, fadeMs: 1100 });
    return id === this.sequenceId;
  }

  async revealComplete(species = this.activeSpecies) {
    if (!species || species !== this.activeSpecies) return false;
    const id = this.sequenceId;
    const call = species.soundscape?.call;
    if (asSources(call).length) {
      const callResult = await this.playTrack("call", call, { loop: false, fadeMs: 650 });
      if (id !== this.sequenceId) return false;
      if (callResult.ok) {
        this.status(`${species.cn} 原声播放中`, { type: "playing", kind: "call", species });
      }
    }
    if (id !== this.sequenceId) return false;

    const voice = normalizeTrack(species.soundscape?.voice, "voice");
    if (!voice || !asSources(voice).length) {
      this.status(`${species.cn} 独白音频不存在 · 声音场景已完成`, { type: "missing", kind: "voice", species });
      return false;
    }
    const voiceResult = await this.playTrack("voice", voice, { loop: false, fadeMs: 550 });
    if (!voiceResult.ok) this.setVoiceDucking(false, 550);
    return voiceResult.ok;
  }

  stopAllSpeciesSounds(fadeMs = this.fadeMs) {
    this.sequenceId += 1;
    ["ambience", "call", "voice"].forEach(kind => this.stopKind(kind, fadeMs));
    this.setVoiceDucking(false, fadeMs);
    this.activeSpecies = null;
  }

  leaveSpecies() {
    this.stopAllSpeciesSounds(750);
  }

  label(kind) {
    return ({ bgm: "背景音乐", ambience: "栖息地环境声", call: "动物原声", voice: "动物独白", sfx: "鲸落音效" })[kind] || "音频";
  }

  /** 鲸落彩蛋全景交响级仪式音效：Web Audio 离线程序化合成
   * 1. 深海次声洋流母体共鸣 (36Hz Deep Hydrophone Drone)
   * 2. 52Hz 蓝鲸多阶共振峰空灵吟唱 (52Hz Multi-Formant Whale Song with Vibrato)
   * 3. 巨鲸入水沉降重低音冲击与水滴泛音 (Sub-bass Shockwave & Water Droplets)
   * 4. 9音阶天籁深海海雪玻璃琴风铃 (9-Tone Celestial Glass Harp Arpeggio)
   * 5. 深海生命绿洲新生心跳微脉冲 (Rebirth Ocean Heartbeat Pulse)
   */
  async playWhaleFallFx(config) {
    if (config && asSources(config).length) {
      const trackResult = await this.playTrack("sfx", config, { loop: false, fadeMs: 320 });
      if (trackResult && trackResult.ok) return trackResult;
    }

    const unlocked = await this.unlock();
    if (!unlocked || !this.context) {
      this.kindState.sfx = "unloaded";
      this.status("静音模式 · 鲸落视觉动画照常进行", { type: "silent", kind: "sfx" });
      return { ok: false, synthesized: false };
    }

    this.stopWhaleFallFx();
    this.kindState.sfx = "playing";
    this.status("一鲸落 · 万物生 · 深海空灵长鸣", { type: "playing", kind: "sfx" });

    const ctx = this.context;
    const sfxBus = this.buses.get("sfx") || this.masterGain;
    const now = ctx.currentTime;
    const synthNodes = [];
    // 先登记再逐段填充：合成中途任一步抛错时，stopWhaleFallFx 也能停掉已 start 的振荡器。
    this._whaleSynthNodes = synthNodes;

    try {
      // ----------------------------------------------------
      // 1. 深海次声洋流母体共鸣 (36Hz Deep Hydrophone Drone, 0s ~ 5.2s)
      // ----------------------------------------------------
      const droneOsc = ctx.createOscillator();
      const droneGain = ctx.createGain();
      const droneFilter = ctx.createBiquadFilter();
      droneOsc.type = "sine";
      droneOsc.frequency.setValueAtTime(36, now);
      droneOsc.frequency.linearRampToValueAtTime(32, now + 5.0);

      droneFilter.type = "lowpass";
      droneFilter.frequency.setValueAtTime(90, now);
      droneFilter.Q.setValueAtTime(2.0, now);

      droneGain.gain.setValueAtTime(0.001, now);
      droneGain.gain.linearRampToValueAtTime(0.32, now + 0.8);
      droneGain.gain.linearRampToValueAtTime(0.28, now + 3.8);
      droneGain.gain.exponentialRampToValueAtTime(0.0001, now + 5.2);

      droneOsc.connect(droneFilter);
      droneFilter.connect(droneGain);
      droneGain.connect(sfxBus);

      droneOsc.start(now);
      droneOsc.stop(now + 5.3);
      synthNodes.push(droneOsc, droneGain);

      // ----------------------------------------------------
      // 2. 52Hz 蓝鲸多阶共振峰空灵吟唱 (52Hz Dual Detuned FM Whale Song, 0.2s ~ 3.8s)
      // ----------------------------------------------------
      const carrierA = ctx.createOscillator();
      const carrierB = ctx.createOscillator();
      const carrierGain = ctx.createGain();
      const modulator = ctx.createOscillator();
      const modGain = ctx.createGain();
      const formantF1 = ctx.createBiquadFilter();
      const formantF2 = ctx.createBiquadFilter();

      // 双载波轻微失谐营造深邃厚重感
      carrierA.type = "sine";
      carrierB.type = "sine";
      carrierA.frequency.setValueAtTime(52, now + 0.2);
      carrierB.frequency.setValueAtTime(52.4, now + 0.2);

      // 优雅哀婉的滑音曲线 (52Hz -> 84Hz -> 64Hz -> 46Hz)
      const pitchCurve = [
        { t: 0.2, f: 52 },
        { t: 1.4, f: 84 },
        { t: 2.3, f: 64 },
        { t: 3.5, f: 46 }
      ];
      pitchCurve.forEach(pt => {
        carrierA.frequency.exponentialRampToValueAtTime(pt.f, now + pt.t);
        carrierB.frequency.exponentialRampToValueAtTime(pt.f * 1.008, now + pt.t);
      });

      // 6.2Hz 呼吸颤音 FM 调制
      modulator.type = "sine";
      modulator.frequency.setValueAtTime(6.2, now + 0.2);
      modGain.gain.setValueAtTime(12, now + 0.2);
      modGain.gain.linearRampToValueAtTime(26, now + 1.4);
      modGain.gain.exponentialRampToValueAtTime(2, now + 3.6);

      modulator.connect(carrierA.frequency);
      modulator.connect(carrierB.frequency);

      // 共振峰滤波模拟巨鲸声腔共鸣 (F1: 70Hz, F2: 180Hz)
      formantF1.type = "bandpass";
      formantF1.frequency.setValueAtTime(70, now + 0.2);
      formantF1.frequency.exponentialRampToValueAtTime(120, now + 1.4);
      formantF1.frequency.exponentialRampToValueAtTime(60, now + 3.5);
      formantF1.Q.setValueAtTime(3.8, now + 0.2);

      formantF2.type = "lowpass";
      formantF2.frequency.setValueAtTime(320, now + 0.2);
      formantF2.Q.setValueAtTime(2.5, now + 0.2);

      carrierGain.gain.setValueAtTime(0.001, now + 0.2);
      carrierGain.gain.linearRampToValueAtTime(0.60, now + 0.8);
      carrierGain.gain.linearRampToValueAtTime(0.50, now + 2.2);
      carrierGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.8);

      carrierA.connect(formantF1);
      carrierB.connect(formantF1);
      formantF1.connect(formantF2);
      formantF2.connect(carrierGain);
      carrierGain.connect(sfxBus);

      if (this.reverb) {
        const reverbSend = ctx.createGain();
        reverbSend.gain.value = 0.55;
        formantF2.connect(reverbSend);
        reverbSend.connect(this.reverb);
      }

      modulator.start(now + 0.2);
      carrierA.start(now + 0.2);
      carrierB.start(now + 0.2);
      modulator.stop(now + 3.9);
      carrierA.stop(now + 3.9);
      carrierB.stop(now + 3.9);
      synthNodes.push(modulator, carrierA, carrierB, carrierGain);

      // ----------------------------------------------------
      // 3. 巨鲸入水沉降重低音冲击与水滴泛音 (Sub-bass Plunge & Water Drops, 1.6s ~ 3.8s)
      // ----------------------------------------------------
      const plungeOsc = ctx.createOscillator();
      const plungeGain = ctx.createGain();
      const plungeFilter = ctx.createBiquadFilter();
      plungeOsc.type = "triangle";
      plungeOsc.frequency.setValueAtTime(68, now + 1.6);
      plungeOsc.frequency.exponentialRampToValueAtTime(30, now + 3.6);

      plungeFilter.type = "lowpass";
      plungeFilter.frequency.setValueAtTime(180, now + 1.6);
      plungeFilter.frequency.exponentialRampToValueAtTime(50, now + 3.6);

      plungeGain.gain.setValueAtTime(0.001, now + 1.6);
      plungeGain.gain.linearRampToValueAtTime(0.42, now + 2.1);
      plungeGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.9);

      plungeOsc.connect(plungeFilter);
      plungeFilter.connect(plungeGain);
      plungeGain.connect(sfxBus);

      plungeOsc.start(now + 1.6);
      plungeOsc.stop(now + 3.9);
      synthNodes.push(plungeOsc, plungeGain);

      // 4 颗空灵深海水泡水滴音 (Droplet Plinks)
      const dropFreqs = [740, 1180, 580, 1420];
      dropFreqs.forEach((df, dIdx) => {
        const dropTime = now + 1.8 + dIdx * 0.24;
        const dOsc = ctx.createOscillator();
        const dGain = ctx.createGain();
        const dPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

        dOsc.type = "sine";
        dOsc.frequency.setValueAtTime(df * 1.3, dropTime);
        dOsc.frequency.exponentialRampToValueAtTime(df, dropTime + 0.08);

        dGain.gain.setValueAtTime(0.001, dropTime);
        dGain.gain.linearRampToValueAtTime(0.09, dropTime + 0.015);
        dGain.gain.exponentialRampToValueAtTime(0.0001, dropTime + 0.35);

        if (dPan) {
          dPan.pan.value = (dIdx % 2 === 0 ? -0.55 : 0.55);
          dOsc.connect(dGain);
          dGain.connect(dPan);
          dPan.connect(sfxBus);
        } else {
          dOsc.connect(dGain);
          dGain.connect(sfxBus);
        }
        dOsc.start(dropTime);
        dOsc.stop(dropTime + 0.4);
        synthNodes.push(dOsc, dGain);
      });

      // ----------------------------------------------------
      // 4. 9 音阶天籁深海海雪玻璃琴风铃 (9-Tone Celestial Glass Harp Arpeggio, 2.5s ~ 5.2s)
      // C#4, E4, G#4, B4, D#5, E5, G#5, B5, E6
      // ----------------------------------------------------
      const harpFreqs = [277.18, 329.63, 415.30, 493.88, 622.25, 659.25, 830.61, 987.77, 1318.51];
      harpFreqs.forEach((freq, idx) => {
        const chimeTime = now + 2.5 + idx * 0.22;
        const chimeOsc = ctx.createOscillator();
        const chimeOvertone = ctx.createOscillator();
        const chimeGain = ctx.createGain();
        const chimePanner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

        chimeOsc.type = "sine";
        chimeOsc.frequency.setValueAtTime(freq, chimeTime);

        // 玻璃琴微晶体二次泛音
        chimeOvertone.type = "sine";
        chimeOvertone.frequency.setValueAtTime(freq * 2.756, chimeTime);

        chimeGain.gain.setValueAtTime(0.001, chimeTime);
        chimeGain.gain.linearRampToValueAtTime(0.13, chimeTime + 0.025);
        chimeGain.gain.exponentialRampToValueAtTime(0.0001, chimeTime + 1.9);

        if (chimePanner) {
          const panProgress = (idx / (harpFreqs.length - 1)) * 1.6 - 0.8; // 从左到右空间扩散
          chimePanner.pan.setValueAtTime(clamp(panProgress, -0.85, 0.85), chimeTime);
          chimeOsc.connect(chimeGain);
          chimeOvertone.connect(chimeGain);
          chimeGain.connect(chimePanner);
          chimePanner.connect(sfxBus);
        } else {
          chimeOsc.connect(chimeGain);
          chimeOvertone.connect(chimeGain);
          chimeGain.connect(sfxBus);
        }

        if (this.reverb) {
          const chimeRev = ctx.createGain();
          chimeRev.gain.value = 0.40;
          chimeGain.connect(chimeRev);
          chimeRev.connect(this.reverb);
        }

        chimeOsc.start(chimeTime);
        chimeOvertone.start(chimeTime);
        chimeOsc.stop(chimeTime + 2.1);
        chimeOvertone.stop(chimeTime + 2.1);
        synthNodes.push(chimeOsc, chimeOvertone, chimeGain);
      });

      // ----------------------------------------------------
      // 5. 深海生命绿洲新生心跳微脉冲 (Rebirth Heartbeat Pulse, 4.1s ~ 5.0s)
      // ----------------------------------------------------
      [4.15, 4.45].forEach((hbTimeOffset, hbIdx) => {
        const hbTime = now + hbTimeOffset;
        const hbOsc = ctx.createOscillator();
        const hbGain = ctx.createGain();
        const hbFilter = ctx.createBiquadFilter();

        hbOsc.type = "sine";
        hbOsc.frequency.setValueAtTime(48, hbTime);
        hbOsc.frequency.exponentialRampToValueAtTime(32, hbTime + 0.18);

        hbFilter.type = "lowpass";
        hbFilter.frequency.setValueAtTime(80, hbTime);

        hbGain.gain.setValueAtTime(0.001, hbTime);
        hbGain.gain.linearRampToValueAtTime(hbIdx === 0 ? 0.35 : 0.24, hbTime + 0.04);
        hbGain.gain.exponentialRampToValueAtTime(0.0001, hbTime + 0.22);

        hbOsc.connect(hbFilter);
        hbFilter.connect(hbGain);
        hbGain.connect(sfxBus);

        hbOsc.start(hbTime);
        hbOsc.stop(hbTime + 0.25);
        synthNodes.push(hbOsc, hbGain);
      });

      if (this._whaleFxResetTimer) clearTimeout(this._whaleFxResetTimer);
      // 玻璃琴末音实际响到约 now+6.4s，旧值 5400ms 会提前翻转状态；保存句柄以便中断撤销，
      // 且校验仍是本次合成的登记节点，避免重叠触发时旧定时器翻转新一次的状态。
      this._whaleFxResetTimer = setTimeout(() => {
        this._whaleFxResetTimer = null;
        if (this._whaleSynthNodes === synthNodes && this.kindState.sfx === "playing") {
          this.kindState.sfx = "paused";
        }
      }, 6500);

      return { ok: true, synthesized: true };
    } catch (e) {
      console.warn("Whale fall synthesis failed:", e);
      return { ok: false, error: e };
    }
  }

  stopWhaleFallFx() {
    if (this._whaleFxResetTimer) {
      clearTimeout(this._whaleFxResetTimer);
      this._whaleFxResetTimer = null;
    }
    if (this._whaleSynthNodes && Array.isArray(this._whaleSynthNodes)) {
      this._whaleSynthNodes.forEach(node => {
        try {
          if (node.stop) node.stop();
          if (node.disconnect) node.disconnect();
        } catch (e) {}
      });
      this._whaleSynthNodes = null;
    }
    this.stopKind("sfx", 300);
  }

  getState() {
    return {
      unlocked: this.context?.state === "running",
      bgmPlaying: Boolean(this.bgm && !this.bgm.paused),
      voicePlaying: this.voicePlaying,
      preloadedCount: this.preloadedTracks.size,
      activeSpecies: this.activeSpecies?.cn || null,
      lastStatus: this.lastStatus,
      levels: this.levels ? { ...this.levels } : { low: 0, mid: 0, high: 0, pan: 0 },
      kinds: { ...this.kindState }
    };
  }
}

export function createSoundscapeManager(options) {
  return new SoundscapeManager(options);
}

export const SOUND_LEVELS = DEFAULT_LEVELS;
