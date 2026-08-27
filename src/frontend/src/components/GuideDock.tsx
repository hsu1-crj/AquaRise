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
import { CircleStop, Play, Send, X } from 'lucide-react';
import { DigitalHumanIcon } from './DigitalHumanIcon';
import { loadXmovSDK, OceanDigitalHuman } from '../services/digitalHuman';
import { api, streamChat } from '../services/api';
import type { ChatMessagePayload } from '../services/api';
import { speakQueued, stopSpeaking } from '../services/speech';
import { onBroadcast, type BroadcastMessage } from '../services/broadcast';

interface GuideMessage {
  /** 稳定自增id: 流式回答按id定位更新, 防止播报插进来后改错消息 */
  id: number;
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

 /** 按句边界截断到 maxChars 以内, 避免 slice 拦腰截断句子 */
 function clipBySentence(text: string, maxChars = 300): string {
   if (text.length <= maxChars) return text;
   const sentences = text.split(/(?<=[。！？；!?;])/);
   let out = '';
   for (const s of sentences) {
     if (out.length + s.length > maxChars) break;
     out += s;
   }
   return out || text.slice(0, maxChars);
 }

 /** 隐藏 SDK 注入的原生字幕元素(它默认吸在容器底部, 与本坞字幕条重复;
  *  覆盖 div/p/span, 否则数字人朗读时字幕和聊天区出现两遍同样的话) */
function hideSdkSubtitles(container: HTMLElement): void {
  const nodes = container.querySelectorAll('div, p, span');
  nodes.forEach((node) => {
    const el = node as HTMLElement;
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
  const msgIdRef = useRef(1);
  const [messages, setMessages] = useState<GuideMessage[]>([
    { id: 0, role: 'guide', text: '你好，我是数字人导游海瞳🌊 想了解这片海域的海洋知识，随时问我！' },
  ]);
  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  /** 播报开关: 停止后保持停止态(按钮变"开始播报"), 再次点击恢复并重播最近一条 */
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const setMutedBoth = (v: boolean) => { mutedRef.current = v; setMuted(v); };

  /** 追加一条消息并返回其id */
  const pushMessage = (role: GuideMessage['role'], text: string): number => {
    const id = msgIdRef.current++;
    setMessages((list) => [...list.slice(-30), { id, role, text }]);
    return id;
  };
  /** 按id更新消息内容(流式回答期间播报可能插队, 不能按"最后一条"定位) */
  const patchMessage = (id: number, text: string): void => {
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, text } : m)));
  };

  useEffect(() => { voiceRef.current = voiceOn; }, [voiceOn]);

  // 新消息/流式输出时自动滚到最新一条
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // 优先读取后端公开配置；演示模式无密钥时保留语音导游，不让SDK异常阻断组件。
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const publicConfig = await api.getDigitalHumanConfig().catch(() => null);
        const appId = import.meta.env.VITE_DH_APP_ID || publicConfig?.app_id || '';
        const appSecret = import.meta.env.VITE_DH_APP_SECRET || '';
        // 后端 enabled 只报告服务端凭证状态; 前端本地密钥可用时仍应加载真实SDK。
        if (!appId || !appSecret) {
          if (!cancelled) setDhMode('offline');
          return;
        }
        // 后端缓存的 sdk_integrity 是旧版本哈希, @latest 文件更新后必然拦截; 不传SRI。
        await loadXmovSDK(publicConfig?.sdk_url);
        if (cancelled) return;
        const dh = new OceanDigitalHuman({ appId, appSecret, containerId: containerIdRef.current, gatewayServer: publicConfig?.gateway_server });
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

  // 隐藏SDK原生字幕 + 强制画布居中(初始化后DOM异步注入且SDK会反复写内联样式,
  // 均用观察器+定时器持续压住)
  useEffect(() => {
    const container = document.getElementById(containerIdRef.current);
    if (!container) return;
    const centerCanvas = () => {
      const canvas = container.querySelector<HTMLCanvasElement>(':scope > canvas');
      if (!canvas) return;
      canvas.style.setProperty('position', 'absolute', 'important');
      canvas.style.setProperty('left', '50%', 'important');
      canvas.style.setProperty('top', '50%', 'important');
      canvas.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
    };
    const observer = new MutationObserver(() => { hideSdkSubtitles(container); centerCanvas(); });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    const timer = window.setInterval(() => { hideSdkSubtitles(container); centerCanvas(); }, 600);
    hideSdkSubtitles(container);
    centerCanvas();
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, [dhMode]);

  /** 停止播报: 立即打断数字人+浏览器语音并清空队列, 按钮切换为"开始播报" */
  const stopAll = () => {
    stopSpeaking();
    if (dhRef.current) {
      dhRef.current.interactiveIdle();
    }
    setSpeaking(false);
    setMutedBoth(true);
  };
  /** 恢复播报: 解除停止态, 并重播最近一条导游消息作为确认 */
  const resumeAll = () => {
    setMutedBoth(false);
    const last = [...messages].reverse().find((m) => m.role === 'guide' && m.text.trim());
    if (last) speakOnly(last.text);
  };
  // 关闭语音开关时同步停掉进行中的播报; 重新打开语音时恢复播报
  useEffect(() => {
    if (!voiceOn) stopAll();
    else setMutedBoth(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOn]);

  /** 仅语音播报(回答已在消息区展示, 不再叠加字幕造成"回答两次") */
  const speakOnly = (text: string) => {
    if (!voiceRef.current || mutedRef.current) return;
    const clean = cleanMarkdown(text);
    if (!clean) return;
    if (dhMode === 'ready' && dhRef.current) {
      dhRef.current.speak(clipBySentence(clean), { isStart: true, isEnd: true });
      setSpeaking(true);
    } else {
      speakQueued(clean);
      setSpeaking(true);
      window.setTimeout(() => setSpeaking(false), Math.min(12000, clean.length * 230));
    }
  };

  /** 场景事件播报: 语音 + 消息区按时间顺序追加留档(不再用顶部字幕条, 避免新内容出现在聊天框最上面的错觉) */
  const announce = (text: string) => {
    pushMessage('guide', text);
    speakOnly(text);
  };

  // 订阅场景播报: 不做内容去重——同类垃圾的每次投放都应照常播报(连投合并已在 broadcast.ts 处理)
  useEffect(() => {
    const off = onBroadcast((message: BroadcastMessage) => {
      announce(message.text);
    }, 'guide');
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dhMode, voiceOn]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    // 追加到完整对话历史(不再整段替换, 用户可回看上下文)
    pushMessage('user', q);
    const answerId = pushMessage('guide', '');
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    let answer = '';
    // 后端 LLM 链路可能长时间无响应; 超时自动中止, 输入框不再永久卡死
    const watchdog = window.setTimeout(() => controller.abort(), 45000);
    try {
      await streamChat(
        [SYSTEM_PROMPT, { role: 'user', content: q }],
        'ocean3d-guide',
        (chunk) => {
          answer += chunk;
          // 按answerId更新: 流式期间若有场景播报插入, 也不会改错消息
          patchMessage(answerId, answer);
        },
        controller.signal,
      );
      if (answer.trim()) {
        speakOnly(answer);
      } else {
        patchMessage(answerId, '导游暂时没答上来，换个问法试试？');
      }
    } catch (reason) {
      if ((reason as DOMException)?.name !== 'AbortError') {
        patchMessage(answerId, answer || '导游暂时不在线，请稍后再试。');
      } else if (!answer) {
        patchMessage(answerId, '回答超时了，请稍后再试。');
      }
    } finally {
      window.clearTimeout(watchdog);
      setBusy(false);
    }
  };

  return (
    <section className="ocean3d-guide glass" aria-label="数字人导游">
      <header>
        <span
          className={`ocean3d-guide-orb ${speaking ? 'speaking' : ''} ${dhMode !== 'boot' ? `mode-${dhMode}` : ''}`}
          role="img"
          aria-label={dhMode === 'ready' ? (speaking ? '数字人正在讲解' : '数字人在线') : '语音导游模式'}
        />
        <div className="ocean3d-guide-title">
          <b>数字人导游 · 海瞳</b>
          <em data-mode={dhMode} aria-live="polite">
            {dhMode === 'boot' ? '正在上线…' : dhMode === 'ready' ? (speaking ? '正在讲解' : '在线') : '语音模式'}
          </em>
        </div>
        <button
          className={`ocean3d-guide-stop${speaking && !muted ? ' speaking' : ''}${muted ? ' stopped' : ''}`}
          aria-label={muted ? '开始播报' : '停止播报'} aria-pressed={muted}
          title={muted ? '开始播报（重播最近一条）' : speaking ? '停止当前播报' : '停止播报（当前没有进行中的播报）'}
          onClick={muted ? resumeAll : stopAll}>
          {muted ? <><Play size={14} />开始播报</> : <><CircleStop size={15} />停止播报</>}
        </button>
        <button className="ocean3d-close" aria-label="关闭导游" onClick={onClose}><X size={15} /></button>
      </header>
      {/* 左形象右对话(对齐海洋守护者页布局): 舞台占左列全高, 右列为聊天记录+快捷提问+输入 */}
      <div className="ocean3d-guide-body">
        <div className={`ocean3d-guide-stage ${dhMode === 'ready' ? 'live' : 'fallback'}`} id={containerIdRef.current}>
          {dhMode !== 'ready' && <><DigitalHumanIcon size={54} className="ocean3d-guide-fallback-icon" /><span className="ocean3d-guide-fallback-tag">{dhMode === 'boot' ? '数字人正在上线…' : '语音导游模式'}</span></>}
        </div>
        <div className="ocean3d-guide-chat">
          <div className="ocean3d-guide-log" ref={logRef}>
            {messages.map((m) => (
              <div key={m.id} className={`guide-msg ${m.role === 'user' ? 'from-user' : 'from-guide'}`}>
                <span className="guide-msg-author">{m.role === 'user' ? '我' : '海瞳'}</span>
                <p>{m.text || (busy ? '…' : '')}</p>
              </div>
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
        </div>
      </div>
    </section>
  );
}
