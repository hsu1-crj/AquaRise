/**
 * 科普模式数字人导游坞 —— 复用魔珐数字人(OceanDigitalHuman)。
 *
 * - 配置了 VITE_DH_APP_ID / VITE_DH_APP_SECRET 且初始化成功 → 数字人开口播报;
 * - 未配置/失败 → 降级为拟态光核 + 浏览器语音队列(speech.ts), 不阻塞体验;
 * - 订阅场景播报总线(broadcast.ts): 垃圾投放等提示由数字人念出并显示字幕条,
 *   取代会互相遮挡的浮动卡片; 数字人播报自带队列, 不会截断上一条;
 * - SDK 原生字幕一律隐藏(MutationObserver), 字幕统一走本坞字幕条;
 * - 问答走现有 /api/v1/chat(Ollama+RAG)。
 */

import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import { loadXmovSDK, OceanDigitalHuman } from '../services/digitalHuman';
import { streamChat } from '../services/api';
import type { ChatMessagePayload } from '../services/api';
import { speakQueued } from '../services/speech';
import { onBroadcast, type BroadcastMessage } from '../services/broadcast';

interface GuideMessage {
  role: 'user' | 'guide';
  text: string;
}

const SYSTEM_PROMPT: ChatMessagePayload = {
  role: 'system',
  content: '你是3D海洋科普场景里的数字人导游"海瞳", 面向海洋环保志愿者。用口语化中文回答, 每次不超过4句话, 优先用海洋知识库内容, 不确定就直说。当前场景: 用户正在3D海洋世界里探索, 可以投放垃圾观察危害、收集知识漂流瓶。',
};

const QUICK_QUESTIONS = ['渔网沉在海底会怎样？', '微塑料是什么？', '我能为海洋做什么？'];

/** 去掉流式回答中的 Markdown 记号(播报与气泡共用) */
function cleanMarkdown(text: string): string {
  return text.replace(/[*#`_~[\]()]/g, '').replace(/\s+/g, ' ').trim();
}

/** 隐藏 SDK 注入的原生字幕元素(它默认吸在容器底部, 与本坞字幕条重复) */
function hideSdkSubtitles(container: HTMLElement): void {
  const allDivs = container.querySelectorAll('div');
  allDivs.forEach((div) => {
    const el = div as HTMLElement;
    const className = el.className?.toString() ?? '';
    const style = getComputedStyle(el);
    if (
      el.tagName !== 'CANVAS'
      && (className.includes('subtitle')
        || className.includes('caption')
        || (style.position === 'absolute' && parseFloat(style.bottom) < 80)
        || (el.textContent && el.textContent.length > 5 && el.offsetHeight < 80 && el.offsetHeight > 10))
    ) {
      el.style.setProperty('display', 'none', 'important');
    }
  });
}

export function GuideDock({ voiceOn, onClose }: { voiceOn: boolean; onClose: () => void }) {
  const containerIdRef = useRef(`ocean3d-guide-${Math.random().toString(36).slice(2, 8)}`);
  const dhRef = useRef<OceanDigitalHuman | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const voiceRef = useRef(voiceOn);
  const [dhMode, setDhMode] = useState<'boot' | 'ready' | 'offline'>('boot');
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState('');
  const [messages, setMessages] = useState<GuideMessage[]>([
    { role: 'guide', text: '你好，我是数字人导游海瞳🌊 想了解这片海域的海洋知识，随时问我！' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { voiceRef.current = voiceOn; }, [voiceOn]);

  // 数字人初始化(未配置密钥时直接降级, 不报错)
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      const appId = import.meta.env.VITE_DH_APP_ID || '';
      const appSecret = import.meta.env.VITE_DH_APP_SECRET || '';
      if (!appId || !appSecret) {
        if (!cancelled) setDhMode('offline');
        return;
      }
      try {
        await loadXmovSDK();
        if (cancelled) return;
        const dh = new OceanDigitalHuman({ appId, appSecret, containerId: containerIdRef.current });
        dh.on('speakStart', () => setSpeaking(true));
        dh.on('speakEnd', () => setSpeaking(false));
        dh.on('error', () => setDhMode('offline'));
        await dh.init();
        if (cancelled) { dh.destroy(); return; }
        dhRef.current = dh;
        setDhMode('ready');
      } catch {
        if (!cancelled) setDhMode('offline');
      }
    };
    void boot();
    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      dhRef.current?.destroy();
      dhRef.current = null;
    };
  }, []);

  // 隐藏SDK原生字幕(初始化后DOM是异步注入的, 用观察器持续压住)
  useEffect(() => {
    const container = document.getElementById(containerIdRef.current);
    if (!container) return;
    const observer = new MutationObserver(() => hideSdkSubtitles(container));
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    const timer = window.setInterval(() => hideSdkSubtitles(container), 600);
    hideSdkSubtitles(container);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, [dhMode]);

  /** 数字人/降级语音双通道播报: 带字幕条; 数字人与降级语音均走队列, 不截断上一条 */
  const announce = (text: string) => {
    setCaption(text);
    if (!voiceRef.current) return;
    const clean = cleanMarkdown(text);
    if (!clean) return;
    if (dhMode === 'ready' && dhRef.current) {
      dhRef.current.speak(clean.slice(0, 300), { isStart: true, isEnd: true });
      setSpeaking(true);
    } else {
      speakQueued(clean);
      setSpeaking(true);
      window.setTimeout(() => setSpeaking(false), Math.min(12000, clean.length * 230));
    }
  };

  // 订阅场景播报(垃圾投放汇总等): 字幕条显示+播报, 8秒后淡出字幕
  useEffect(() => {
    let captionTimer = 0;
    const off = onBroadcast((message: BroadcastMessage) => {
      announce(message.text);
      window.clearTimeout(captionTimer);
      captionTimer = window.setTimeout(() => setCaption(''), 8000);
    }, 'guide');
    return () => {
      off();
      window.clearTimeout(captionTimer);
    };
  }, [dhMode, voiceOn]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    setMessages((list) => [...list.slice(-5), { role: 'user', text: q }, { role: 'guide', text: '' }]);
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    let answer = '';
    try {
      await streamChat(
        [SYSTEM_PROMPT, { role: 'user', content: q }],
        'ocean3d-guide',
        (chunk) => {
          answer += chunk;
          setMessages((list) => {
            const copy = [...list];
            copy[copy.length - 1] = { role: 'guide', text: answer };
            return copy;
          });
        },
        controller.signal,
      );
      if (answer) announce(answer);
    } catch (reason) {
      if ((reason as DOMException)?.name !== 'AbortError') {
        setMessages((list) => {
          const copy = [...list];
          copy[copy.length - 1] = { role: 'guide', text: answer || '导游暂时不在线，请稍后再试。' };
          return copy;
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ocean3d-guide glass" aria-label="数字人导游">
      <header>
        <span className={`ocean3d-guide-orb ${speaking ? 'speaking' : ''} ${dhMode !== 'boot' ? `mode-${dhMode}` : ''}`} />
        <div className="ocean3d-guide-title">
          <b>数字人导游 · 海瞳</b>
          <em>{dhMode === 'boot' ? '正在上线…' : dhMode === 'ready' ? (speaking ? '正在讲解' : '在线') : '语音模式'}</em>
        </div>
        <button className="ocean3d-close" aria-label="关闭导游" onClick={onClose}><X size={15} /></button>
      </header>

      {/* 数字人舞台: 居中呈现; 降级时显示拟态光核提示 */}
      <div className={`ocean3d-guide-stage ${dhMode === 'ready' ? '' : 'fallback'}`} id={containerIdRef.current}>
        {dhMode !== 'ready' && <span className="ocean3d-guide-fallback-tag">🎤 语音导游模式</span>}
      </div>

      {/* 播报字幕条(投放提示/回答摘要都在这里, 不再弹浮动卡) */}
      {caption && <p className="ocean3d-guide-caption">{caption}</p>}

      <div className="ocean3d-guide-log">
        {messages.map((m, i) => (
          <p key={i} className={m.role === 'user' ? 'from-user' : 'from-guide'}>
            {m.text || (busy && i === messages.length - 1 ? '…' : '')}
          </p>
        ))}
      </div>

      <div className="ocean3d-guide-quick">
        {QUICK_QUESTIONS.map((q) => (
          <button key={q} onClick={() => void ask(q)} disabled={busy}>{q}</button>
        ))}
      </div>

      <form className="ocean3d-guide-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="问导游一个海洋问题…"
          aria-label="向数字人导游提问"
          maxLength={120}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="发送"><Send size={14} /></button>
      </form>
    </section>
  );
}
