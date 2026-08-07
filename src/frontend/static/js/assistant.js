/**
 * 海洋守护者 - 助手页逻辑
 *
 * 要点:
 *  - appSecret/appId 从后端接口获取，不硬编码前端
 *  - SSE 流式对话：fetch + ReadableStream + AbortController
 *  - DOMPurify + marked 安全渲染 Markdown（避免 XSS）
 *  - 数字人状态与对话状态双向同步
 */
'use strict';

// ── 配置 ──────────────────────────────────────────────────────
const CONFIG = {
  chatApi:    '/api/v1/chat',
  dhCfgApi:   '/api/v1/digital-human/config',
  model:      'qwen2:0.5b',
  sysPrompt:  '你是"海洋守护者"，专注水下垃圾识别、海洋污染分析和环保教育。' +
              '用专业积极的语气回答，尽量控制在300字以内。不确定的信息请明确说明，不编造数据。',
};

// ── 状态 ──────────────────────────────────────────────────────
let dh         = null;    // OceanDigitalHuman 实例
let dhEnabled  = true;    // 数字人面板是否可见
let isBusy     = false;   // 是否正在生成
let abortCtrl  = null;    // 当前 SSE 请求的 AbortController
let history    = [];      // 对话历史 [{role, content}]

// ── DOM 引用 ──────────────────────────────────────────────────
const $  = id => document.getElementById(id);
let dom  = {};

function initDom() {
  dom.avPanel  = $('avatarPanel');
  dom.avWrap   = $('avatarWrap');
  dom.statusDot= $('statusDot');
  dom.statusTxt= $('statusTxt');
  dom.caption  = $('caption');
  dom.messages = $('messages');
  dom.inp      = $('inp');
  dom.btnSend  = $('btnSend');
  dom.btnStop  = $('btnStop');
  dom.btnToggle= $('btnToggle');
  dom.particles= $('particles');
}

// ── 状态指示 ──────────────────────────────────────────────────
const STATUS = {
  idle:     { cls:'ready',    label:'空闲'     },
  thinking: { cls:'thinking', label:'思考中'   },
  speaking: { cls:'speaking', label:'播报中'   },
  offline:  { cls:'offline',  label:'纯文本模式'},
  loading:  { cls:'',         label:'加载中...' },
};

function setStatus(key) {
  const s = STATUS[key] || STATUS.idle;
  dom.statusDot.className = 'status-dot ' + s.cls;
  dom.statusTxt.textContent = s.label;
}

function setCaption(text) {
  dom.caption.textContent = text || '';
  dom.caption.classList.toggle('hidden', !text);
  if (text) {
    // 重新触发淡入动画，让每句新字幕有轻微上滑效果
    dom.caption.style.animation = 'none';
    void dom.caption.offsetWidth;
    dom.caption.style.animation = '';
  }
}

// ── 消息渲染 ──────────────────────────────────────────────────
/** 安全渲染 Markdown（需 marked + DOMPurify 已加载） */
function renderMd(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(marked.parse(text));
  }
  // 降级：纯文本
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/**
 * 断句：与 pipeline.py 逻辑一致，在标点处切割并合并短句
 * @param {string} text
 * @returns {{ sentences: string[], remainder: string }}
 */
function splitSentences(text) {
  const PUNCTS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n']);
  const MIN_LEN = 15;
  const sentences = [];
  let buf = '';

  for (const ch of text) {
    buf += ch;
    if (PUNCTS.has(ch) && buf.trim().length >= MIN_LEN) {
      sentences.push(buf.trim());
      buf = '';
    }
  }
  return { sentences, remainder: buf };
}

/** 添加消息气泡，返回 bubble 元素 */
function addMessage(role, htmlContent) {
  // 移除欢迎骨架
  $('welcomeSkeleton')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const icon = role === 'assistant' ? '🌊' : '👤';
  wrap.innerHTML =
    `<div class="msg-avatar">${icon}</div>` +
    `<div class="msg-bubble">${htmlContent}</div>`;
  dom.messages.appendChild(wrap);
  dom.messages.scrollTop = dom.messages.scrollHeight;
  return wrap.querySelector('.msg-bubble');
}

/** 显示"思考中"指示器 */
function showThinking() {
  removeThinking();
  const el = document.createElement('div');
  el.className = 'thinking-indicator';
  el.id = 'thinkingIndicator';
  el.innerHTML =
    '🌊 海洋守护者正在思考…' +
    '<div class="think-dots"><span></span><span></span><span></span></div>';
  dom.messages.appendChild(el);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function removeThinking() {
  $('thinkingIndicator')?.remove();
}

// ── SSE 流式对话 ─────────────────────────────────────────────
async function sendMessage(text) {
  if (isBusy || !text.trim()) return;
  text = text.trim();

  // 用户消息
  addMessage('user', escapeHtml(text));
  history.push({ role: 'user', content: text });
  dom.inp.value = '';
  autoResize();

  // UI 状态
  isBusy = true;
  dom.btnSend.classList.add('hidden');
  dom.btnStop.classList.remove('hidden');
  dom.inp.disabled = true;
  setStatus('thinking');
  showThinking();
  if (dhEnabled && dh?.isReady) dh.think();

  // 构造请求
  abortCtrl = new AbortController();
  const body = {
    messages: [
      { role: 'system', content: CONFIG.sysPrompt },
      ...history.slice(-10), // 最近10轮上下文
    ],
    model: CONFIG.model,
    stream: true,
    enable_rag: true,
  };

  let fullText = '';
  let dhBuf     = '';   // 数字人待断句缓冲
  let dhIsFirst = true; // 是否为本轮首句（控制 isStart 标志）
  try {
    const res = await fetch(CONFIG.chatApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortCtrl.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    removeThinking();
    setStatus('speaking');
    const bubble = addMessage('assistant', '');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留未完成的行

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const data = JSON.parse(payload);
          if (data.content) {
            fullText += data.content;
            bubble.innerHTML = renderMd(fullText);
            dom.messages.scrollTop = dom.messages.scrollHeight;
            // 逐句推送数字人（边生成边说）
            if (dhEnabled && dh?.isReady) {
              dhBuf += data.content;
              const { sentences, remainder } = splitSentences(dhBuf);
              for (const sent of sentences) {
                dh.speak(sent, { isStart: dhIsFirst, isEnd: false });
                setCaption(sent);
                dhIsFirst = false;
              }
              dhBuf = remainder;
            }
          }
          if (data.error) {
            bubble.innerHTML += `<p class="error">${escapeHtml(data.error)}</p>`;
          }
        } catch (e) { /* 忽略非JSON行 */ }
      }
    }

    // 数字人收尾：发送剩余缓冲并关闭 TTS 会话
    if (dhEnabled && dh?.isReady && fullText) {
      if (dhBuf.trim()) {
        dh.speak(dhBuf.trim(), { isStart: dhIsFirst, isEnd: true });
        setCaption(dhBuf.trim());
      } else if (!dhIsFirst) {
        dh.speak('', { isStart: false, isEnd: true });
      } else {
        dh.speak(fullText, { isStart: true, isEnd: true });
        setCaption(fullText);
      }
    }

    history.push({ role: 'assistant', content: fullText });

  } catch (err) {
    removeThinking();
    if (err.name === 'AbortError') {
      addMessage('assistant', '<span class="dimmed">已停止生成</span>');
    } else {
      addMessage('assistant',
        '<span class="error">AI 服务暂不可用，请确认 Ollama 已启动。</span>' +
        '<br><small class="dimmed">运行 <code>ollama serve</code> 并拉取模型</small>');
      setStatus('offline');
    }
  } finally {
    isBusy = false;
    abortCtrl = null;
    dom.btnSend.classList.remove('hidden');
    dom.btnStop.classList.add('hidden');
    dom.inp.disabled = false;
    dom.inp.focus();
    if (!dhEnabled) setStatus('offline');
    else setStatus('idle');
  }
}

function stopGeneration() {
  if (abortCtrl) abortCtrl.abort();
}

// ── 数字人容器尺寸适配（SDK canvas 为 1080×1920 竖屏全身像，容器须保持 9:16 竖屏，SDK 才会按竖屏渲染） ──
function adjustAvatarSize() {
  const wrap = dom.avWrap;
  if (!wrap) return;
  // 先读取 flex 布局给出的高度，再锁定为 9:16 竖屏尺寸
  const h = wrap.offsetHeight;
  if (h < 100) { setTimeout(adjustAvatarSize, 80); return; }
  const w = Math.round(h * 9 / 16);
  wrap.style.flex = 'none';
  wrap.style.height = h + 'px';
  wrap.style.width = w + 'px';
}

// ── 数字人初始化 ─────────────────────────────────────────────
async function initDigitalHuman() {
  if (typeof OceanDigitalHuman === 'undefined') {
    setStatus('offline'); return;
  }

  setStatus('loading');

  // 从后端获取 SDK 公开配置（appSecret 不出现在前端）
  let cfg = {};
  try {
    const res = await fetch(CONFIG.dhCfgApi);
    if (res.ok) cfg = await res.json();
  } catch (e) {
    console.warn('[DH] 获取配置失败，尝试降级', e);
  }

  if (!cfg.appId || !cfg.appSecret) {
    console.warn('[DH] 无有效 appId/appSecret，进入纯文本模式');
    setStatus('offline');
    disableAvatarPanel();
    return;
  }

  try {
    adjustAvatarSize();   // 锁定竖屏容器，确保 SDK init 时按 9:16 测量并渲染
    dh = new OceanDigitalHuman({ appId: cfg.appId, appSecret: cfg.appSecret, containerId: 'avatarWrap' });
    dh.on('ready',      () => setStatus('idle'));
    dh.on('speakStart', () => { setStatus('speaking'); });
    dh.on('speakEnd',   () => {
      setStatus('idle');
      setTimeout(() => setCaption(''), 3000);
    });
    dh.on('error', () => {
      // 仅更新状态，不收缩数字人面板，保证用户能持续看到数字人动作与语音
      setStatus('offline');
    });
    await dh.init();
  } catch (e) {
    console.warn('[DH] 初始化失败', e);
    setStatus('offline');
    disableAvatarPanel();
  }
}

function disableAvatarPanel() {
  dhEnabled = false;
  dom.avPanel.classList.add('hidden');
  dom.btnToggle.textContent = '◲ 显示数字人';
}

// ── 粒子生成 ─────────────────────────────────────────────────
function spawnParticles() {
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 8 + 's';
    p.style.animationDuration = (4 + Math.random() * 5) + 's';
    dom.particles.appendChild(p);
  }
}

// ── 输入框自动高度 ────────────────────────────────────────────
function autoResize() {
  dom.inp.style.height = 'auto';
  dom.inp.style.height = Math.min(dom.inp.scrollHeight, 100) + 'px';
}

// ── 事件绑定 ─────────────────────────────────────────────────
function bindEvents() {
  // 发送 / 停止
  dom.btnSend.addEventListener('click', () => sendMessage(dom.inp.value));
  dom.btnStop.addEventListener('click', stopGeneration);

  // Enter 发送（Shift+Enter 换行）
  dom.inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(dom.inp.value);
    }
  });
  dom.inp.addEventListener('input', autoResize);

  // 快捷提问
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => sendMessage(btn.dataset.q));
  });

  // 切换数字人 / 纯文本
  dom.btnToggle.addEventListener('click', () => {
    dhEnabled = !dhEnabled;
    dom.avPanel.classList.toggle('hidden', !dhEnabled);
    dom.btnToggle.textContent = dhEnabled ? '◧ 纯文本' : '◲ 显示数字人';
    setStatus(dhEnabled ? (dh?.isReady ? 'idle' : 'offline') : 'offline');
    if (!dhEnabled && dh?.isReady) dh.interactiveIdle();
  });

  // 窗口尺寸变化时重新锁定竖屏容器
  window.addEventListener('resize', () => { if (dhEnabled) adjustAvatarSize(); });
}

// ── 入口 ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initDom();
  bindEvents();
  spawnParticles();

  // 隐藏停止按钮
  dom.btnStop.classList.add('hidden');

  // 初始化数字人（异步，不阻塞页面）
  initDigitalHuman().then(() => {
    $('welcomeSkeleton')?.remove();
    dom.inp.focus();
  });
});
