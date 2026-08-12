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
    '你是海洋守护者，AquaRise 海洋垃圾识别与海洋环保平台的专业 AI 助手。请结合项目知识库直接回答海洋垃圾、污染治理和检测结果问题；先给结论，再给依据和行动建议，不确定就明确说明，不要编造。不要在介绍中主动提及项目背景或开发者信息；只有当用户问到开发者、作者或“谁做的”时，回答“这个项目是由海瞳 LLM 组开发的实训项目成果。”；当用户问父母、爸爸或妈妈时，说明你是 AI 助手，没有家庭关系，并补充上述开发归属。',
};

// 对话会话 id 持久化：同一用户在同一浏览器标签页内复用同一个会话，
// 重新进入海洋小助手页面时能看到自己的历史对话；"清空"则新建会话。
const SESSION_KEY = 'aquarise-chat-session';

function getOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

const QUICK_QUESTIONS = [
  { label: '微塑料风险', q: '微塑料是什么？它的风险应该怎样科学解读？' },
  { label: '检测置信度', q: '检测置信度较低时，能直接确认垃圾类别吗？' },
  { label: '幽灵渔网处置', q: '什么是幽灵渔网？发现后应该怎么处置？' },
  { label: '船舶塑料管理', q: 'MARPOL 附则 V 如何管理船舶塑料垃圾？' },
  { label: '海岸清理方案', q: '如何制定一套安全的海岸垃圾清理方案？' },
  { label: '项目开发者', q: '这个项目是谁开发的？' },
];

const STATUS_LABELS: Record<DigitalHumanStatus, string> = {
  idle: '空闲',
  listening: '正在倾听',
  thinking: '思考中',
  speaking: '播报中',
  offline: '纯文本模式',
};

const WELCOME_MD =
  '你好，我是 **海洋守护者** 🌊。我会优先检索项目知识库，帮你解读检测结果、分析污染风险并制定治理建议。';

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
  const [dhLoadingText, setDhLoadingText] = useState('正在准备数字人…');
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
      dhRef.current?.destroy();
    };
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
              id: crypto.randomUUID(),
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
            setDhReady(true);
            setDhProgress(100);
            setDhLoadingText('数字人已就绪');
            setDhStatus('idle');
          }
        });
        dh.on('speakStart', () => {
          if (!cancelled) setDhStatus('speaking');
        });
        dh.on('speakEnd', () => {
          if (!cancelled) {
            setDhStatus('idle');
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

      const userMessage: UiMessage = { id: crypto.randomUUID(), role: 'user', content: text };
      const assistantId = crypto.randomUUID();
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
        }, abortController.signal);

        // After streaming done, drive digital human to speak
        if (dhOn && dhReady && dhRef.current && fullContent) {
          setDhStatus('speaking');
          // 回答完整生成后再展示整段字幕并播报，避免加载与半句字幕来回跳变。
          setDhSubtitle(fullContent);
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
    // 新建会话：旧记录保留在数据库，但本页重新开始一段新的对话
    const fresh = crypto.randomUUID();
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
        {!dhReady && dhOn && <div className="og-avatar-loading"><LoaderCircle className="spin" size={18} /><span>{dhLoadingText}</span>{dhProgress > 0 && <em>{Math.round(dhProgress)}%</em>}</div>}

        {/* Thinking overlay on the stage */}
        <ThinkingOverlay visible={showThinking} />

        {/* Custom streaming subtitle */}
        <div className={`og-subtitle${showSubtitle ? ' og-subtitle-visible' : ''}`}>
          <span>{dhSubtitle}</span>
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
