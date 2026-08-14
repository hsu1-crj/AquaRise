import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Brain, LoaderCircle, Send, Trash2 } from 'lucide-react';
import { getChatHistory, streamChat, type ChatMessagePayload } from '../services/api';
import {
  loadXmovSDK,
  OceanDigitalHuman,
  type DigitalHumanStatus,
} from '../services/digitalHuman';
import type { UserInfo } from '../types';

// ---------- helpers ----------

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT: ChatMessagePayload = {
  role: 'system',
  content:
    '你是海洋守护者，AquaRise 海洋垃圾识别与海洋环保平台的专业 AI 助手。请结合项目知识库直接回答海洋垃圾、污染治理和检测结果问题；先给结论，再给依据和行动建议，不确定就明确说明，不要编造。不要在介绍中主动提及项目背景或开发者信息；只有当用户问到开发者、作者或“谁做的”时，回答“这是一个实训项目成果；海瞳 LLM 组是本项目 LLM 部分负责人，负责模型微调与对话能力升级。”；当用户问父母、爸爸或妈妈时，说明你是 AI 助手，没有家庭关系，并补充海瞳 LLM 组的 LLM 负责人身份。',
};

// 对话会话 id 持久化：同一用户在同一浏览器标签页内复用同一个会话，
// 重新进入海洋小助手页面时能看到自己的历史对话；"清空"则新建会话。
const SESSION_KEY = 'aquarise-chat-session';

// 生成会话/消息 id。crypto.randomUUID 仅在安全上下文（HTTPS 或 localhost）可用；
// 通过局域网 IP 访问（如 http://192.0.2.10:5173）时不满足，会抛 TypeError 导致白屏。
// 这里优先用 randomUUID，不可用时退化到 crypto.getRandomValues（非安全上下文同样可用）。
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    // 极端情况下 crypto 不可用，退回 Math.random（仅用于会话/消息 id，非安全敏感）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

function getOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = uuid();
  window.sessionStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

/** 按句切分（保留标点），空输入返回空数组 */
function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/(?<=[。！？；!?;])/);
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const QUICK_QUESTIONS = [
  { label: '海瞳平台', q: '海瞳平台是做什么的？' },
  { label: '识别复核', q: '识别结果置信度较低时，为什么不能直接纳入正式统计？' },
  { label: '珊瑚渔网处置', q: '珊瑚附近发现废弃渔网，现场处置应注意什么？' },
  { label: '船舶塑料管理', q: 'MARPOL 附则 V 是否允许把塑料垃圾排入海里？' },
  { label: '微塑料风险', q: '微塑料是什么？它的风险应该怎样科学解读？' },
  { label: '塑料袋降解', q: '塑料袋在水下多久能真正降解？' },
  { label: '检测报告解读', q: '检测报告里 trash_net 置信度不高，应该怎么解读？' },
  { label: '海岸清理优先级', q: '如何制定海岸垃圾清理的优先级和复测流程？' },
];

const STATUS_LABELS: Record<DigitalHumanStatus, string> = {
  idle: '空闲',
  listening: '正在倾听',
  thinking: '思考中',
  speaking: '播报中',
  offline: '纯文本模式',
};

const WELCOME_MD =
  '你好，我是 **海洋守护者** 🌊。我会优先检索项目知识库，帮你解读检测结果、分析污染风险，并给出可执行的海洋垃圾治理建议。';

// ---------- particle background ----------

function ParticleField() {
  const particles = useMemo(() => {
    return Array.from({ length: 20 }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      delay: `${(Math.random() * 8).toFixed(1)}s`,
      duration: `${(4 + Math.random() * 6).toFixed(1)}s`,
    }));
  }, []);
  return (
    <div className="og-particles" aria-hidden="true">
      {particles.map((p) => (
        <i key={p.id} style={{ left: p.left, animationDelay: p.delay, animationDuration: p.duration }} />
      ))}
    </div>
  );
}

// ---------- thinking overlay on avatar stage ----------

function ThinkingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="og-thinking-overlay">
      <div className="og-thinking-ring">
        <div className="og-thinking-ring-inner">
          <Brain size={28} />
        </div>
        <svg className="og-thinking-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(34,184,230,.15)" strokeWidth="2" />
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--cyan)" strokeWidth="2"
            strokeDasharray="290" strokeDashoffset="72" strokeLinecap="round"
            className="og-thinking-arc" />
        </svg>
      </div>
      <p>海洋守护者思考中…</p>
      <div className="og-tdots"><span /><span /><span /></div>
    </div>
  );
}

// ---------- message bubble ----------

function MessageBubble({
  message,
  streaming,
  userName,
  userInitial,
}: {
  message: UiMessage;
  streaming: boolean;
  userName: string;
  userInitial: string;
}) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(message.content, { async: false }) as string),
    [message.content],
  );
  return (
    <article className={`og-msg ${message.role}`}>
      <div className={`og-mav${message.role === 'user' ? ' og-mav-user' : ''}`}>
        {message.role === 'assistant' ? '🌊' : userInitial}
      </div>
      <div className="og-mbub">
        <span className="og-mbub-author">
          {message.role === 'assistant' ? '海洋守护者' : userName}
        </span>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {streaming && <LoaderCircle className="spin" size={14} />}
      </div>
    </article>
  );
}

// ---------- main page ----------

export function AssistantPage({ user }: { user: UserInfo | null }) {
  // --- chat state ---
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [messages, setMessages] = useState<UiMessage[]>([
    { id: 'welcome', role: 'assistant', content: WELCOME_MD },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const controller = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // --- digital human state ---
  const [dhStatus, setDhStatus] = useState<DigitalHumanStatus>('offline');
  const [dhOn, setDhOn] = useState(true);
  const [dhReady, setDhReady] = useState(false);
  const [dhSubtitle, setDhSubtitle] = useState('');
  const [dhProgress, setDhProgress] = useState(0);
  const subtitleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 逐句推进字幕队列：按每句字数估算播报时长，配合数字人口型节奏 */
  const startSubtitleQueue = useCallback((sentences: string[]) => {
    if (subtitleTimer.current) clearTimeout(subtitleTimer.current);
    let index = 0;
    setDhSubtitle(sentences[0] || '');
    const step = () => {
      if (index >= sentences.length - 1) {
        subtitleTimer.current = null;
        return;
      }
      const current = sentences[index];
      const duration = Math.max(900, Math.min(6000, current.length * 230));
      subtitleTimer.current = setTimeout(() => {
        index += 1;
        setDhSubtitle(sentences[index] || '');
        step();
      }, duration);
    };
    step();
  }, []);

  const stopSubtitleQueue = useCallback(() => {
    if (subtitleTimer.current) {
      clearTimeout(subtitleTimer.current);
      subtitleTimer.current = null;
    }
  }, []);
  const [dhLoadingText, setDhLoadingText] = useState('正在准备数字人…');
  const dhLoadStartedAt = useRef(Date.now());
  const dhRef = useRef<OceanDigitalHuman | null>(null);
  const sdkContainerRef = useRef<HTMLDivElement>(null);

  const userName = user?.username ?? '海洋卫士';
  const userInitial = userName.slice(0, 1).toUpperCase();

  // scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // abort on unmount
  useEffect(() => {
    return () => {
      controller.current?.abort();
      stopSubtitleQueue();
      dhRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- load persisted chat history for this session (re-fetch on session change) ---
  // 注意：开发模式下 React.StrictMode 会 setup→cleanup→setup 执行两次 effect。
  // 不能用 ref 守卫提前 return（会把第二次拉取短路掉），只依赖 cancelled 标记即可，
  // 第一次请求的 cleanup 会让它被丢弃，第二次请求正常生效。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await getChatHistory(sessionId);
        if (cancelled) return;
        if (history.length > 0) {
          setMessages(
            history.map((m) => ({
              id: uuid(),
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content,
            })),
          );
        }
      } catch {
        // 历史加载失败不阻塞聊天，保留欢迎语
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // --- aggressively hide SDK's built-in subtitle ---
  useEffect(() => {
    const container = sdkContainerRef.current;
    if (!container) return;

    // Hide any existing subtitle elements immediately
    const hideSubtitles = () => {
      const allDivs = container.querySelectorAll('div');
      allDivs.forEach((div) => {
        const el = div as HTMLElement;
        // The SDK subtitle is typically a positioned div at the bottom
        const style = getComputedStyle(el);
        if (
          el.tagName !== 'CANVAS' &&
          (el.className?.toString().includes('subtitle') ||
            el.className?.toString().includes('caption') ||
            el.className?.toString().includes('text') ||
            (style.position === 'absolute' && parseFloat(style.bottom) < 80) ||
            el.textContent && el.textContent.length > 5 && el.offsetHeight < 80 && el.offsetHeight > 10)
        ) {
          el.style.setProperty('display', 'none', 'important');
        }
      });
    };

    // Run after each paint cycle
    const timer = setInterval(hideSubtitles, 500);

    // Also use MutationObserver for newly added elements
    const observer = new MutationObserver(() => hideSubtitles());
    observer.observe(container, { childList: true, subtree: true, attributes: true });

    hideSubtitles();

    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, [dhReady]); // re-run when SDK initializes

  // --- init digital human ---
  useEffect(() => {
    dhLoadStartedAt.current = Date.now();
    let cancelled = false;
    const container = sdkContainerRef.current;
    if (!container) return;

    async function boot() {
      try {
        setDhLoadingText('正在加载数字人引擎…');
        await loadXmovSDK();
        if (cancelled) return;

        setDhLoadingText('正在连接数字人服务…');
        const appId = import.meta.env.VITE_DH_APP_ID || '';
        const appSecret = import.meta.env.VITE_DH_APP_SECRET || '';
        if (!appId || !appSecret) {
          console.warn('[数字人] 未配置 VITE_DH_APP_ID / VITE_DH_APP_SECRET，数字人功能不可用');
          if (!cancelled) {
            setDhStatus('offline');
            setDhLoadingText('数字人暂未配置，已切换纯文本模式');
          }
          return;
        }
        const dh = new OceanDigitalHuman({
          appId,
          appSecret,
          containerId: container!.id || 'og-sdk-container',
        });

        dh.on('progress', (value) => {
          if (!cancelled) setDhProgress(Number(value) || 0);
        });
        dh.on('ready', () => {
          if (!cancelled) {
            // 确保加载提示至少可见一小段时间，避免“闪一下”造成突兀感。
            const remaining = Math.max(0, 420 - (Date.now() - dhLoadStartedAt.current));
            window.setTimeout(() => {
              if (cancelled) return;
              setDhReady(true);
              setDhProgress(100);
              setDhLoadingText('数字人已就绪');
              setDhStatus('idle');
            }, remaining);
          }
        });
        dh.on('speakStart', () => {
          if (!cancelled) setDhStatus('speaking');
        });
        dh.on('speakEnd', () => {
          if (!cancelled) {
            setDhStatus('idle');
            stopSubtitleQueue();
            setDhSubtitle('');
          }
        });
        dh.on('error', () => {
          if (!cancelled) {
            setDhStatus('offline');
            setDhReady(false);
            setDhLoadingText('数字人暂不可用，已切换纯文本模式');
          }
        });

        await dh.init();
        if (!cancelled) {
          dhRef.current = dh;
        }
      } catch {
        if (!cancelled) {
          setDhStatus('offline');
          setDhReady(false);
          setDhLoadingText('数字人暂不可用，已切换纯文本模式');
        }
      }
    }

    boot().catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- chat logic ---

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      setInput('');
      setLastQuestion(text);
      setBusy(true);
      setError('');
      setDhSubtitle('');

      const userMessage: UiMessage = { id: uuid(), role: 'user', content: text };
      const assistantId = uuid();
      const nextMessages = [...messages, userMessage];
      setMessages([...nextMessages, { id: assistantId, role: 'assistant', content: '' }]);

      const abortController = new AbortController();
      controller.current = abortController;

      // Show thinking on stage
      if (dhOn && dhReady && dhRef.current) {
        setDhStatus('thinking');
        dhRef.current.think();
      } else if (dhOn && !dhReady) {
        // 数字人还在加载时不冒充“思考中”，保持加载态，回答仍正常显示在聊天区。
        setDhStatus('offline');
      }

      try {
        const payload: ChatMessagePayload[] = [
          SYSTEM_PROMPT,
          ...nextMessages
            .filter((m) => m.id !== 'welcome')
            .map(({ role, content }) => ({ role, content })),
        ];

        let fullContent = '';
        await streamChat(payload, sessionId, (chunk: string) => {
          if (abortController.signal.aborted) return;
          fullContent += chunk;
          // Update chat message
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, content: fullContent } : item,
            ),
          );
          // 流式字幕：按句实时显示（完整句 + 正在生成的尾部）
          if (dhOn && dhReady) {
            const parts = splitIntoSentences(fullContent);
            setDhSubtitle(parts.length ? parts[parts.length - 1] : fullContent);
          }
        }, abortController.signal);

        // After streaming done, drive digital human to speak（逐句推进字幕，配合播报节奏）
        if (dhOn && dhReady && dhRef.current && fullContent) {
          setDhStatus('speaking');
          const sentences = splitIntoSentences(fullContent);
          if (sentences.length > 1) {
            startSubtitleQueue(sentences);
          } else {
            setDhSubtitle(fullContent);
          }
          dhRef.current.speak(fullContent, { isStart: true, isEnd: true });
        } else {
          setDhSubtitle('');
          if (!dhOn || !dhReady) {
            setDhStatus(dhOn ? 'offline' : 'offline');
          }
        }
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : '对话生成失败');
        }
        setDhStatus(dhOn && dhReady ? 'idle' : 'offline');
        setDhSubtitle('');
      } finally {
        setBusy(false);
        controller.current = null;
      }
    },
    [busy, messages, dhOn, dhReady, sessionId],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(input);
  };

  const stop = () => {
    controller.current?.abort();
    stopSubtitleQueue();
    setBusy(false);
    setDhSubtitle('');
    if (dhRef.current) {
      setDhStatus(dhReady ? 'idle' : 'offline');
    }
  };

  const toggleDigitalHuman = () => {
    const next = !dhOn;
    setDhOn(next);
    if (!next) {
      setDhStatus('offline');
      setDhSubtitle('');
    } else {
      setDhStatus(dhReady ? 'idle' : 'offline');
    }
  };

  const clearMessages = () => {
    controller.current?.abort();
    stopSubtitleQueue();
    // 新建会话：旧记录保留在数据库，但本页重新开始一段新的对话
    const fresh = uuid();
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    setSessionId(fresh);
    setMessages([{ id: 'welcome', role: 'assistant', content: WELCOME_MD }]);
    setError('');
    setDhSubtitle('');
  };

  // computed: show thinking overlay or subtitle on stage
  const showThinking = dhOn && dhReady && dhStatus === 'thinking';
  const showSubtitle = dhOn && dhSubtitle && (dhStatus === 'speaking' || dhStatus === 'thinking');

  return (
    <div className="ocean-guardian-layout">
      {/* ====== Left: Avatar Panel ====== */}
      <aside className={`og-avatar-panel${!dhOn ? ' og-avatar-collapsed' : ''}`}>
        <div className="og-bg">
          <div className="og-wave" />
          <div className="og-wave" />
          <ParticleField />
        </div>

        <div className="og-atitle">海洋守护者</div>
        <div className="og-asub">Ocean Guardian</div>

        <div className="og-awrap" ref={sdkContainerRef} id="og-sdk-container" />
        {!dhReady && dhOn && (
          <div className="og-avatar-loading" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <span>{dhLoadingText}</span>
            <div className="og-avatar-progress" aria-hidden="true"><i style={{ width: `${Math.max(6, dhProgress)}%` }} /></div>
            <em>{dhProgress > 0 ? `${Math.round(dhProgress)}%` : '准备中'}</em>
          </div>
        )}

        {/* Thinking overlay on the stage */}
        <ThinkingOverlay visible={showThinking} />

        {/* Custom streaming subtitle */}
        <div className={`og-subtitle${showSubtitle ? ' og-subtitle-visible' : ''}`}>
          <span className="og-subtitle-text">{dhSubtitle}</span>
          {dhStatus === 'thinking' && <i className="og-subtitle-caret" aria-hidden="true" />}
        </div>

        <div className="og-stl">
          <div className={`og-sd og-sd-${dhStatus}`} />
          <span>{STATUS_LABELS[dhStatus]}</span>
        </div>
      </aside>

      {/* ====== Right: Chat Panel ====== */}
      <section className="og-chat-panel">
        <header className="og-topbar">
          <h3>海洋守护者</h3>
          <button className="og-tbtn" onClick={toggleDigitalHuman}>
            {dhOn ? '◧ 纯文本' : '◲ 数字人'}
          </button>
        </header>

        {/* Quick questions */}
        <div className="og-quick">
          {QUICK_QUESTIONS.map((item) => (
            <button
              key={item.label}
              className="og-qbtn"
              disabled={busy}
              onClick={() => ask(item.q)}
            >
              {item.label}
            </button>
          ))}
          <button className="og-qbtn og-clear-btn" onClick={clearMessages}>
            <Trash2 size={12} /> 清空
          </button>
        </div>

        {/* Messages */}
        <div className="og-msgs">
          {messages.length === 0 && (
            <div className="og-empty">
              <span className="og-empty-icon">🌊</span>
              <h2>开始一次新的海洋对话</h2>
              <p>选择快捷问题，或在下方输入你的问题。</p>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              streaming={busy && msg === messages[messages.length - 1]}
              userName={userName}
              userInitial={userInitial}
            />
          ))}
          {busy && messages[messages.length - 1]?.content === '' && (
            <div className="og-thinking">
              🌊 海洋守护者正在思考…
              <div className="og-tdots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {error && (
            <div className="og-error">
              {error}
              <button onClick={() => void ask(lastQuestion)}>重新发送</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <form className="og-input-row" onSubmit={submit}>
          <textarea
            id="og-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            rows={1}
            placeholder="输入你的问题..."
            disabled={busy}
          />
          {busy ? (
            <button type="button" className="og-send-btn og-stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button type="submit" className="og-send-btn" disabled={!input.trim()}>
              <Send size={16} /> 发送
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
