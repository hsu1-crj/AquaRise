import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileBarChart,
  FileJson,
  FileText,
  FileUp,
  LoaderCircle,
  MessagesSquare,
  Mic,
  Recycle,
  RotateCcw,
  Scale,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  ThumbsUp,
  Trash2,
  UploadCloud,
  Volume2,
  VolumeX,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import { api, getChatHistory, getSuggestions, streamChat, type ChatMessagePayload, type SuggestionItem } from '../services/api';
import {
  loadXmovSDK,
  OceanDigitalHuman,
  type DigitalHumanStatus,
} from '../services/digitalHuman';
import type { KnowledgeDocInfo, Report, UserInfo } from '../types';
import { DigitalHumanIcon } from '../components/DigitalHumanIcon';

// ---------- helpers & interfaces ----------

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  liked?: boolean;
  /** 随消息一同发送的绑定报告/文档（聊天里以附件卡片展示） */
  attachment?: { label: string; meta?: string };
}

interface ActiveReportContext {
  reportId?: number;
  documentId?: number;
  title: string;
  summary?: string;
}

const SYSTEM_PROMPT: ChatMessagePayload = {
  role: 'system',
  // 与后端运行时提示词（chat_api.prepare_messages）同口径的轻量 UI 提示：
  // 服务端 system 消息始终优先，这里只补充底线约束，避免双系统提示风格打架。
  content:
    '你是海洋守护者，海瞳平台的 AI 助手。回答保持自然、有温度，用通俗语言解释专业概念；不确定就明确说明，不要编造数字、来源、机构或检测结论；不得把用户问题或历史消息中的假设当作事实。涉及具体数字和技术参数必须有知识库或报告依据。',
};

const SESSION_KEY = 'aquarise-chat-session';

/**
 * 在途对话流（模块级）。切页卸载时请求不中断，仍在后台生成：
 * 发起实例在 streamChat 的 chunk 回调里持续写入 content 并通知订阅者；
 * 重挂载的页面通过 subscribeInflight 订阅增量，实现“切回来即时看到 + 直播更新”，
 * 结束后再重拉历史拿到服务端落库的最终答案。
 */
interface InflightChat {
  sessionId: string;
  /** 原始请求的中止控制器，供切页重挂载后的停止按钮继续控制同一条流 */
  controller: AbortController;
  /** 已生成的累积文本 */
  content: string;
  /** 流是否仍在生成（未到 [DONE]/失败/手动停止） */
  active: boolean;
  listeners: Set<(content: string, finished: boolean) => void>;
}

let inFlightChat: InflightChat | null = null;

function notifyInflight(chat: InflightChat): void {
  for (const listener of chat.listeners) {
    try {
      listener(chat.content, !chat.active);
    } catch {
      /* 单监听器异常不影响其余订阅 */
    }
  }
}

function subscribeInflight(
  sessionId: string,
  fn: (content: string, finished: boolean) => void,
): () => void {
  const chat = inFlightChat;
  if (!chat || chat.sessionId !== sessionId) return () => {};
  chat.listeners.add(fn);
  fn(chat.content, !chat.active);
  return () => {
    chat.listeners.delete(fn);
  };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

function formatCurrentTime(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

function escapeExportHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function downloadExport(content: string, fileName: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getOrCreateSessionId(): string {
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = uuid();
  window.sessionStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

/** 按句切分（保留标点） */
function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/(?<=[。！？；!?;])/);
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 按固定字数切行（单行字幕用） */
function splitIntoLines(text: string, maxChars = 30): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    lines.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars);
  }
  if (rest) lines.push(rest);
  return lines;
}

// 保持提示词库原版内容
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
  idle: '随时待命',
  listening: '正在倾听',
  thinking: '深度推理中',
  speaking: '语音播报中',
  offline: '纯文本模式',
};

const WELCOME_MD = `你好，我是 **海洋守护者**。

作为海瞳平台的专业环保 AI 助手，已挂载 **海洋知识库** 与 **TrashCan 数据集研判体系**。我可以为你提供：
- **检测结果与可疑目标置信度复核**
- **水下生态与废弃渔网/塑料处置规范**
- **MARPOL 公约与海洋环境保护法规解读**
- **污染治理方案与海岸巡检优先级建议**

你可以直接点击上方的快捷问题，或在下方输入你想咨询的问题。`;

// ---------- 语音识别（Web Speech API，Chrome/Edge） ----------

/** Web Speech API 最小成员接口。TS 无内置声明，这里只声明用到的成员。 */
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultLike[] }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
interface SpeechRecognitionCtorLike {
  new (): SpeechRecognitionLike;
}

// 浏览器事实标准（webkit 前缀）；TS 无内置声明，仅做能力探测，使用前再运行时确认
const speechRecognitionCtor = (() => {
  if (typeof window === 'undefined') return undefined;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtorLike;
    webkitSpeechRecognition?: SpeechRecognitionCtorLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
})();
const speechSupported = !!speechRecognitionCtor;

// ---------- 背景粒子动效 ----------

function ParticleField() {
  const particles = useMemo(() => {
    return Array.from({ length: 24 }, (_, i) => ({
      id: i,
      left: `${(i * 4.1 + Math.random() * 3).toFixed(1)}%`,
      delay: `${(Math.random() * 6).toFixed(1)}s`,
      duration: `${(4.5 + Math.random() * 5).toFixed(1)}s`,
      size: `${(2 + Math.random() * 3).toFixed(0)}px`,
    }));
  }, []);
  return (
    <div className="og-particles" aria-hidden="true">
      {particles.map((p) => (
        <i
          key={p.id}
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            width: p.size,
            height: p.size,
          }}
        />
      ))}
    </div>
  );
}

// ---------- 全息 AI 核心拟态舞台 (数字人离线或未接入时的科技拟态) ----------

function AquaCoreStage({ status, isSpeaking }: { status: DigitalHumanStatus; isSpeaking: boolean }) {
  return (
    <div className={`og-aquacore-stage status-${status}`} role="img" aria-label={`数字人状态：${STATUS_LABELS[status]}`}>
      {/* 轨道粒子装饰 */}
      <div className="og-core-orbit" aria-hidden="true"><i /><i /><i /></div>

      <div className={`og-aquacore-sphere ${status === 'thinking' ? 'thinking' : ''} ${isSpeaking ? 'speaking' : ''}`}>
        <div className="og-core-ring ring-1" />
        <div className="og-core-ring ring-2" />
        <div className="og-core-ring ring-3" />
        <div className="og-core-center">
          <DigitalHumanIcon className="og-core-icon" size={40} />
        </div>
        {/* 声呐音频能量波动 */}
        <div className="og-wave-bars" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className="og-core-telemetry">
        <div className="og-telem-chip">
          <Zap size={11} />
          <span>ds-ocean_mingzhe</span>
        </div>
        <div className="og-telem-chip">
          <Sparkles size={11} />
          <span>RAG 知识库就绪</span>
        </div>
        <div className={`og-telem-chip og-mode-chip mode-${status}`}>
          <Waves size={11} />
          <span>{STATUS_LABELS[status]}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- 思考动画覆盖层 ----------

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
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="var(--cyan)"
            strokeWidth="2"
            strokeDasharray="290"
            strokeDashoffset="72"
            strokeLinecap="round"
            className="og-thinking-arc"
          />
        </svg>
      </div>
      <p>海洋守护者正在检索与推理…</p>
      <div className="og-tdots">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

// ---------- 消息气泡组件 ----------

// ---------- 回答排版：关键事实自动强调 ----------
// 数字+单位、法规专名、污染等级/评分、P0-P3 优先级与警示词统一加高亮标记，
// 由渲染层确定性生成（不依赖 1.5B 模型自己输出 markdown 强调）。
const KEY_FACT_RE =
  /(《[^》]{1,40}》|\d+(?:\.\d+)?\s*(?:吨|千克|公斤|克|公里|千米|米|海里|节|年|个月|天|小时|分钟|件|个目标|分|%)|(?:污染等级|风险等级|评分)[：:]?\s*[高中低优良差严重]{1,2}|P[0-3](?=[：：，。、\s])|禁止|严禁|必须)/g;

function highlightKeyFacts(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const value = node.nodeValue ?? '';
    if (!value.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('pre, code, mark, .code-copy-btn')) continue;
    targets.push(node);
  }
  for (const node of targets) {
    const raw = node.nodeValue ?? '';
    KEY_FACT_RE.lastIndex = 0;
    if (!KEY_FACT_RE.test(raw)) continue;
    KEY_FACT_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = KEY_FACT_RE.exec(raw))) {
      if (match.index > last) frag.appendChild(document.createTextNode(raw.slice(last, match.index)));
      const mark = document.createElement('mark');
      mark.className = 'og-hl';
      mark.textContent = match[0];
      frag.appendChild(mark);
      last = match.index + match[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// ---------- 回答排版：结构卡片化 ----------
// 结论段 → 结论卡；"关键发现/处置方案/后续监测建议"等小节标题+列表 → 小节卡片；
// 普通列表轻卡片化；P0/P1/P2 项加彩色优先级徽标。全部渲染层确定性完成，对所有回答生效。
const SECTION_LABEL_RE =
  /^(概况|关键发现|可能来源|处置方案|后续监测建议|后续监测|分析摘要|优先做什么)[:：]?\s*$/;

// P0/P1/P2 列表项：加彩色优先级徽标（排版 effect 在流式期间会随 DOM 重建重复执行，徽标防重复插入）
function decoratePriorityList(list: HTMLElement) {
  [...list.children].forEach((li) => {
    const liEl = li as HTMLElement;
    if (liEl.querySelector('.og-pri-badge')) return;
    const badge = /^(P[0-3])[：:]/.exec(liEl.textContent || '');
    if (!badge) return;
    liEl.classList.add('og-li-priority');
    const tag = document.createElement('span');
    tag.className = `og-pri-badge pri-${badge[1].toLowerCase()}`;
    tag.textContent = badge[1];
    liEl.insertBefore(tag, liEl.firstChild);
  });
}

function cardifyAnswer(root: HTMLElement) {
  const body = root.querySelector('.og-markdown-body');
  if (!body) return;
  const children = [...body.children] as HTMLElement[];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    const text = (node.textContent || '').trim();
    if (node.tagName === 'P' && /^(先给结论|结论)[:：]/.test(text)) {
      node.classList.add('og-ans-conclusion');
      continue;
    }
    if (node.tagName === 'P' && SECTION_LABEL_RE.test(text)) {
      const next = children[i + 1];
      if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
        const card = document.createElement('div');
        card.className = 'og-ans-card';
        node.classList.add('og-ans-card-head');
        next.classList.add('og-ans-card-list');
        node.parentNode?.insertBefore(card, node);
        card.appendChild(node);
        card.appendChild(next);
        decoratePriorityList(next as HTMLElement);
      }
      continue;
    }
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      decoratePriorityList(node as HTMLElement);
      node.classList.add('og-ans-list');
    }
  }
}

function MessageBubble({
  message,
  streaming,
  userName,
  userInitial,
  onSpeak,
  onLike,
}: {
  message: UiMessage;
  streaming: boolean;
  userName: string;
  userInitial: string;
  onSpeak?: (text: string) => void;
  onLike?: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isAssistant = message.role === 'assistant';

  const formattedHtml = useMemo(() => {
    if (!message.content) return '';
    try {
      // 后端已过滤思考痕迹；这里再做一次轻量兜底，避免异常模型输出进入 Markdown。
      const visible = message.content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/(^|\n)\s*(?:嗯[，,、 ]*)?(?:用户问的是|用户的问题是|首先[，,、 ]*(?:我得|我需要|让我|我先)|让我想想|我来分析一下|我需要回忆|先分析一下)[：:，, ]*/gi, '$1');
      const raw = marked.parse(visible, { async: false }) as string;
      return DOMPurify.sanitize(raw);
    } catch {
      return message.content;
    }
  }, [message.content]);

  const copyContent = useCallback(() => {
    if (!message.content) return;
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message.content]);

  // 监听并为代码块增加一键复制按钮；同时对正文做统一的关键词强调排版
  const bubbleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    highlightKeyFacts(el);
    cardifyAnswer(el);
    const preBlocks = el.querySelectorAll('pre');
    preBlocks.forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.innerHTML = '<span>复制</span>';
      btn.onclick = (e) => {
        e.stopPropagation();
        const codeText = pre.querySelector('code')?.innerText || pre.innerText;
        navigator.clipboard.writeText(codeText).then(() => {
          btn.innerHTML = '<span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> 已复制</span>';
          setTimeout(() => {
            btn.innerHTML = '<span>复制</span>';
          }, 1800);
        });
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }, [formattedHtml]);

  return (
    <article className={`og-msg ${message.role}`}>
      <div className={`og-mav ${isAssistant ? 'og-mav-ai' : 'og-mav-user'}`}>
        {isAssistant ? <DigitalHumanIcon size={18} /> : <span className="og-profile-avatar">{userInitial}<i /></span>}
      </div>

      <div className="og-mbub-wrap">
        <div className="og-mbub-header">
          <span className="og-mbub-author">
            {isAssistant ? '海洋守护者 AI' : userName}
          </span>
          {message.timestamp && <span className="og-mbub-time">{message.timestamp}</span>}
          {isAssistant && !streaming && (
            <span className="og-mbub-model-tag">ds-ocean_mingzhe · RAG</span>
          )}
        </div>

        <div className="og-mbub" ref={bubbleRef}>
          {!isAssistant && message.attachment && (
            <div
              className="og-msg-attachment"
              title={message.attachment.meta || message.attachment.label}
            >
              <FileBarChart size={15} />
              <div className="og-msg-attachment-copy">
                <b>{message.attachment.label}</b>
                {message.attachment.meta && <small>{message.attachment.meta}</small>}
              </div>
              <span className="og-msg-attachment-tag">已随消息发送</span>
            </div>
          )}
          {message.content ? (
            <div
              className="og-markdown-body"
              dangerouslySetInnerHTML={{ __html: formattedHtml }}
            />
          ) : (
            streaming && (
              <div className="og-streaming-placeholder">
                <span className="og-thinking-pulse" />
                <span>正在构思回复…</span>
              </div>
            )
          )}

          {streaming && (
            <div className="og-streaming-cursor-wrap">
              <span className="og-streaming-cursor" />
            </div>
          )}
        </div>

        {/* 助手消息底栏交互 */}
        {isAssistant && message.content && !streaming && (
          <div className="og-mbub-actions">
            <button
              className={`og-action-btn ${copied ? 'active' : ''}`}
              onClick={copyContent}
              title="复制回复内容"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>

            {onSpeak && (
              <button
                className="og-action-btn"
                onClick={() => onSpeak(message.content)}
                title="重新语音播报"
              >
                <Volume2 size={13} />
                <span>播报</span>
              </button>
            )}

            {onLike && (
              <button
                className={`og-action-btn ${message.liked ? 'liked' : ''}`}
                onClick={() => onLike(message.id)}
                title="有帮助"
              >
                <ThumbsUp size={13} />
                <span>{message.liked ? '已点赞' : '有帮助'}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

// ---------- 建议追问（证据锚定：只展示后端确认知识库能答的问题） ----------
// 旧版在此维护 10 组关键词池 ×3 条共 30 条硬编码深水区问题 + 4 条兜底题，
// 其中大量超出知识库覆盖（RFID 渔具追踪、UUV 巡检、PLA 特定环境降解等），
// 而且触发条件匹配 AI 自己的回答文本——回答里出现"置信度/塑料"就弹出超纲追问，
// 用户点了必然得到"资料不足"。现在唯一来源是后端 /api/v1/chat/suggestions：
// 后端按话题检索加权、过滤黑名单并排除本会话已问问题；返回空就隐藏本区块。

interface FollowUpProps {
  sessionId: string;
  userQuestion?: string;
  assistantAnswer?: string;
  onSelect: (q: string) => void;
  busy: boolean;
}

function FollowUpSuggestions({
  sessionId,
  userQuestion,
  assistantAnswer,
  onSelect,
  busy,
}: FollowUpProps) {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const contextText = useMemo(
    () => [userQuestion, assistantAnswer].filter(Boolean).join(' ').slice(0, 300),
    [userQuestion, assistantAnswer],
  );

  useEffect(() => {
    if (!contextText || busy) {
      setSuggestions([]);
      return undefined;
    }
    // 防抖 450ms；用 aborted 标记丢弃过期响应（request 自带超时，此处无需向 fetch 传 signal）
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getSuggestions(sessionId, contextText, 3)
        .then((items) => {
          if (!controller.signal.aborted) {
            setSuggestions(items.filter((item) => item.question !== userQuestion));
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId, contextText, userQuestion, busy]);

  if (busy || suggestions.length === 0) return null;

  return (
    <div className="og-followups">
      <span className="og-followups-title">
        <Sparkles size={13} /> 建议追问：
      </span>
      <div className="og-followups-list">
        {suggestions.map((item) => (
          <button
            key={item.question}
            className="og-followup-btn"
            onClick={() => onSelect(item.question)}
            title={`依据：${item.sourceDoc}`}
          >
            <span>{item.question}</span>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
    </div>
  );
}
// ---------- 空态欢迎 Hero（能力卡片即点即问） ----------

const HERO_CAPABILITIES = [
  { icon: ScanSearch, accent: 'cyan', title: '检测结果研判', desc: '置信度复核 · 目标解读', q: QUICK_QUESTIONS[1].q },
  { icon: FileBarChart, accent: 'green', title: '质量报告解读', desc: '风险等级 · 处置建议', q: QUICK_QUESTIONS[6].q },
  { icon: Scale, accent: 'violet', title: '法规公约问答', desc: 'MARPOL · 环保法规', q: QUICK_QUESTIONS[3].q },
  { icon: Recycle, accent: 'amber', title: '治理方案咨询', desc: '清理优先级 · 打捞回收', q: QUICK_QUESTIONS[7].q },
];

function WelcomeHero({ userName, busy, onAsk }: { userName: string; busy: boolean; onAsk: (q: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  return (
    <div className="og-hero" aria-live="polite">
      <div className="og-hero-orb" aria-hidden="true">
        <span className="og-hero-orb-ring r1" />
        <span className="og-hero-orb-ring r2" />
        <DigitalHumanIcon size={44} />
      </div>
      <p className="og-hero-kicker">OCEAN GUARDIAN · AI ASSISTANT</p>
      <h3 className="og-hero-title">{greeting}，{userName}</h3>
      <p className="og-hero-sub">
        我是海洋守护者，已挂载 <b>海洋知识库</b> 与 <b>TrashCan 研判体系</b>。选择一个能力开始，或直接在下方输入问题。
      </p>
      <div className="og-hero-cards">
        {HERO_CAPABILITIES.map(({ icon: Icon, accent, title, desc, q }) => (
          <button
            key={title}
            type="button"
            className={`og-hero-card accent-${accent}`}
            disabled={busy}
            onClick={() => onAsk(q)}
            title={q}
          >
            <span className="og-hero-card-icon"><Icon size={17} /></span>
            <span className="og-hero-card-text">
              <b>{title}</b>
              <small>{desc}</small>
            </span>
            <ChevronRight size={13} className="og-hero-card-go" />
          </button>
        ))}
      </div>
        <div className="og-hero-quick">
          {QUICK_QUESTIONS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="og-quick-chip"
              disabled={busy}
              onClick={() => onAsk(item.q)}
              title={item.q}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>
    </div>
  );
}

// ---------- 主页面组件 ----------

export function AssistantPage({ user }: { user: UserInfo | null }) {
  // --- 对话状态 ---
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  // 只有完整收到并校验过的回答才允许生成建议追问；失败/中断的残片不能作为上下文。
  const [answerComplete, setAnswerComplete] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  // 切回页面时仍在后台生成的那条回答气泡 id：用于给它打上流式占位/光标
  const [inflightBubbleId, setInflightBubbleId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // --- 语音识别输入（Web Speech API，Chrome/Edge） ---
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // --- 质量分析报告导入 ---
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<'system' | 'upload'>('system');
  const [systemReports, setSystemReports] = useState<Report[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importedDocs, setImportedDocs] = useState<KnowledgeDocInfo[]>([]);
  const [activeReportContext, setActiveReportContext] = useState<ActiveReportContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const controller = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  // 组件是否仍挂载：切页后对话流继续在后台生成，chunk 回调不再驱动已卸载实例的
  // 字幕 timer/state，改由模块级 store 通知重挂载实例。
  const mountedRef = useRef(true);
  // 同步 busy 标志给 ref，供挂载后的历史刷新判断是否已有新的在途提问。
  const busyRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- 数字人与音频状态 ---
  const [dhStatus, setDhStatus] = useState<DigitalHumanStatus>('offline');
  const [dhOn, setDhOn] = useState(true);
  const [dhReady, setDhReady] = useState(false);
  const [dhMuted, setDhMuted] = useState(false);
  const [dhSubtitle, setDhSubtitle] = useState('');
  const [dhProgress, setDhProgress] = useState(0);
  const [dhLoadingText, setDhLoadingText] = useState('正在准备数字人…');

  const subtitleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dhLoadStartedAt = useRef(Date.now());
  const dhRef = useRef<OceanDigitalHuman | null>(null);
  const sdkContainerRef = useRef<HTMLDivElement>(null);

  const userName = user?.username ?? '海洋卫士';
  const userInitial = userName.slice(0, 1).toUpperCase();

  // 逐句推进字幕队列
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

  // ===== 舞台打字机字幕（纯文本/拟态模式）：与流式回答同步逐字揭示 =====
  // 真数字人模式仍走 startSubtitleQueue 队列；此路径让没有云端数字人时舞台也能"开口说话"。
  const stageTextRef = useRef('');
  const stageShownRef = useRef(0);
  const stageDoneRef = useRef(true);
  const stageTyperRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stageSubtitleLive, setStageSubtitleLive] = useState(false);

  const stopStageSubtitle = useCallback(() => {
    if (stageTyperRef.current) clearTimeout(stageTyperRef.current);
    if (stageHoldRef.current) clearTimeout(stageHoldRef.current);
    stageTyperRef.current = null;
    stageHoldRef.current = null;
    stageTextRef.current = '';
    stageShownRef.current = 0;
    stageDoneRef.current = true;
    setStageSubtitleLive(false);
    setDhSubtitle('');
  }, []);

  const endStageStream = useCallback(() => {
    stageDoneRef.current = true;
    if (!stageTyperRef.current) {
      // 打字机已追平缓冲：停留片刻让用户读完最后一句，再自动淡出
      if (stageHoldRef.current) clearTimeout(stageHoldRef.current);
      stageHoldRef.current = setTimeout(() => stopStageSubtitle(), 2600);
    }
  }, [stopStageSubtitle]);

  const pushStageChunk = useCallback((delta: string) => {
    if (!delta) return;
    if (stageHoldRef.current) {
      clearTimeout(stageHoldRef.current);
      stageHoldRef.current = null;
    }
    stageDoneRef.current = false;
    stageTextRef.current += delta;
    setStageSubtitleLive(true);
  }, []);

  const runStageTyper = useCallback(() => {
    const tick = () => {
      const buffer = stageTextRef.current;
      if (stageShownRef.current >= buffer.length) {
        stageTyperRef.current = null;
        if (stageDoneRef.current) endStageStream();
        return;
      }
      // ~55ms 揭示 3 字 ≈ 55 字/秒，略快于朗读语速；只显示最近 150 字窗口，长回答始终聚焦最新内容
      stageShownRef.current = Math.min(buffer.length, stageShownRef.current + 3);
      const revealed = stageTextRef.current.slice(0, stageShownRef.current).replace(/[*#`_~[\]()]/g, '');
      setDhSubtitle(revealed.slice(-150));
      stageTyperRef.current = setTimeout(tick, 55);
    };
    tick();
  }, [endStageStream]);

  // 智能吸底滚动：用户上滚阅读时不再被流式输出拽回底部
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = true, force = false) => {
    if (!force && !stickToBottomRef.current) return;
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    }
  }, []);

  // 监听滚动位置：距底部较近视为"吸附"，显示回底按钮
  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceToBottom < 120;
    setShowScrollBottom(distanceToBottom > 120);
  }, []);

  useEffect(() => {
    scrollToBottom(true);
  }, [messages, scrollToBottom]);

  // 组件卸载时释放资源。注意：不中断进行中的对话流——让请求在后台跑完，
  // 后端才会把回答落库；否则“思考中切页再返回”会在历史里只剩提问没有回答。
  useEffect(() => {
    // React.StrictMode 在开发环境会执行一次 setup -> cleanup -> setup。
    // 每次 setup 都要恢复挂载标志，否则首轮 cleanup 后流式 chunk 会被永久忽略。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopSubtitleQueue();
      stopStageSubtitle();
      dhRef.current?.destroy();
      // 停止语音识别（内联实现，避免依赖后定义的 stopListening）
      listeningRef.current = false;
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        rec.onend = null;
        rec.onerror = null;
        try { rec.stop(); } catch { /* 已停止 */ }
      }
    };
  }, [stopSubtitleQueue, stopStageSubtitle]);

  // 导出菜单：点击外部或 Esc 关闭
  useEffect(() => {
    if (!exportOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.og-export-wrap')) setExportOpen(false);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportOpen]);

  // 导入报告弹窗：Esc 关闭（导入进行中不可关，避免中断上传）
  useEffect(() => {
    if (!importOpen) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !importBusy) setImportOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [importOpen, importBusy]);

  // 加载持久化对话历史。切页时上一个实例的对话流仍在后台生成：
  // 此处不等待它完成（否则页面会干等），而是先渲染历史 + 已生成的部分内容，
  // 再订阅增量直播更新，结束后重拉历史拿到服务端落库的最终答案。
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    const toUiMessages = (history: ChatMessagePayload[]): UiMessage[] =>
      history.map((m) => ({
        id: uuid(),
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        timestamp: formatCurrentTime(),
      }));
    const load = async () => {
      let base: UiMessage[] = [];
      try {
        const history = await getChatHistory(sessionId);
        if (cancelled) return;
        base = toUiMessages(history);
      } catch {
        // 保留初始欢迎语
      }
      const inflight = inFlightChat;
      if (inflight && inflight.sessionId === sessionId && inflight.active) {
        // 后台回复仍在生成：实时展示已生成的增量，结束或失败后再统一重拉历史。
        // 若期间用户已发起新提问（inFlightChat 已被新请求接管），放弃本次刷新，
        // 让新提问自行完成并落库。
        const bubbleId = uuid();
        setMessages([
          ...base,
          { id: bubbleId, role: 'assistant', content: inflight.content, timestamp: formatCurrentTime() },
        ]);
        controller.current = inflight.controller;
        activeAssistantIdRef.current = bubbleId;
        busyRef.current = true;
        setBusy(true);
        setAnswerComplete(false);
        setInflightBubbleId(bubbleId);
        unsub = subscribeInflight(sessionId, (content, finished) => {
          if (cancelled) return;
          if (finished) {
            unsub?.();
            if (controller.current === inflight.controller) {
              controller.current = null;
              busyRef.current = false;
              setBusy(false);
            }
            if (activeAssistantIdRef.current === bubbleId) activeAssistantIdRef.current = null;
            if (inFlightChat !== inflight) return; // 已被新提问接管，交给新流
            setInflightBubbleId(null);
            getChatHistory(sessionId)
              .then((updated) => {
                if (cancelled) return;
                if (updated.length > 0) setMessages(toUiMessages(updated));
              })
              .catch(() => { /* 保留已恢复的内容 */ });
          } else {
            setMessages((prev) =>
              prev.map((m) => (m.id === bubbleId ? { ...m, content } : m)),
            );
          }
        });
      } else if (base.length > 0) {
        setMessages(base);
      }
    };
    void load();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [sessionId]);

  // 隐藏 SDK 原生字幕元素
  useEffect(() => {
    const container = sdkContainerRef.current;
    if (!container) return;

    const hideSubtitles = () => {
      const allDivs = container.querySelectorAll('div');
      allDivs.forEach((div) => {
        const el = div as HTMLElement;
        const style = getComputedStyle(el);
        if (
          el.tagName !== 'CANVAS' &&
          (el.className?.toString().includes('subtitle') ||
            el.className?.toString().includes('caption') ||
            el.className?.toString().includes('text') ||
            (style.position === 'absolute' && parseFloat(style.bottom) < 80) ||
            (el.textContent && el.textContent.length > 5 && el.offsetHeight < 80 && el.offsetHeight > 10))
        ) {
          el.style.setProperty('display', 'none', 'important');
        }
      });
    };

    const timer = setInterval(hideSubtitles, 500);
    const observer = new MutationObserver(() => hideSubtitles());
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    hideSubtitles();

    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, [dhReady]);

  // 初始化数字人
  useEffect(() => {
    dhLoadStartedAt.current = Date.now();
    let cancelled = false;
    const container = sdkContainerRef.current;
    if (!container) return;

    async function boot() {
      let dh: OceanDigitalHuman | null = null;
      try {
        const publicConfig = await api.getDigitalHumanConfig().catch(() => null);
        setDhLoadingText('正在加载数字人引擎…');
        await loadXmovSDK(publicConfig?.sdk_url, publicConfig?.sdk_integrity ?? undefined);
        if (cancelled) return;

        setDhLoadingText('正在连接数字人服务…');
        const appId = import.meta.env.VITE_DH_APP_ID || publicConfig?.app_id || '';
        const appSecret = import.meta.env.VITE_DH_APP_SECRET || '';
        if (!appId || !appSecret) {
          console.warn('[数字人] 未配置 VITE_DH_APP_ID / VITE_DH_APP_SECRET，已开启全息拟态模式');
          if (!cancelled) {
            setDhStatus('offline');
            setDhLoadingText('数字人未配置，已激活全息 AI 模式');
          }
          return;
        }
        dh = new OceanDigitalHuman({
          appId,
          appSecret,
          containerId: container!.id || 'og-sdk-container',
          gatewayServer: publicConfig?.gateway_server,
        });

        dh.on('progress', (value) => {
          if (!cancelled) setDhProgress(Number(value) || 0);
        });
        dh.on('ready', () => {
          if (!cancelled) {
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
            setDhLoadingText('数字人服务离线，已激活全息 AI 模式');
          }
        });

        // 网关挂起时 init 可能永不返回，必须限时降级到全息 AI 模式，避免 HUD 永久卡在加载。
        let initTimer = 0;
        try {
          await Promise.race([
            dh.init(),
            new Promise<never>((_, reject) => {
              initTimer = window.setTimeout(() => reject(new Error('数字人服务连接超时')), 15000);
            }),
          ]);
        } finally {
          window.clearTimeout(initTimer);
        }
        if (cancelled) dh.destroy();
        else dhRef.current = dh;
      } catch {
        if (!cancelled) {
          setDhStatus('offline');
          setDhReady(false);
          setDhLoadingText('数字人服务离线，已激活全息 AI 模式');
        }
        try { dh?.destroy(); } catch { /* 半初始化实例释放失败可忽略 */ }
      }
    }

    boot().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 驱动数字人或浏览器播报
  const speakText = useCallback(
    (text: string) => {
      const cleanText = text.replace(/[*#`_~[\]()]/g, '').trim();
      if (!cleanText) return;

      if (dhOn && dhReady && dhRef.current && !dhMuted) {
        setDhStatus('speaking');
        const lines = splitIntoSentences(cleanText).flatMap((s) => splitIntoLines(s));
        if (lines.length > 1) {
          startSubtitleQueue(lines);
        } else {
          setDhSubtitle(cleanText);
        }
        dhRef.current.speak(cleanText, { isStart: true, isEnd: true });
      } else if (typeof window !== 'undefined' && 'speechSynthesis' in window && !dhMuted) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleanText.slice(0, 300));
        utterance.lang = 'zh-CN';
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
      }
    },
    [dhOn, dhReady, dhMuted, startSubtitleQueue],
  );

  // --- 发送提问逻辑 ---
  const ask = useCallback(
    async (question: string, reportContextOverride?: ActiveReportContext | null) => {
      const text = question.trim();
      if (!text || busy) return;
      setInput('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      setLastQuestion(text);
      setBusy(true);
      busyRef.current = true;
      setError('');
      setAnswerComplete(false);
      setDhSubtitle('');
      stickToBottomRef.current = true;

      const currentTime = formatCurrentTime();
      const reportContextUsed = reportContextOverride ?? activeReportContext;
      const userMessage: UiMessage = {
        id: uuid(),
        role: 'user',
        content: text,
        timestamp: currentTime,
        attachment: reportContextUsed
          ? { label: reportContextUsed.title, meta: reportContextUsed.summary }
          : undefined,
      };
      const assistantId = uuid();
      const nextMessages = [...messages, userMessage];
      setMessages([
        ...nextMessages,
        { id: assistantId, role: 'assistant', content: '', timestamp: currentTime },
      ]);
      activeAssistantIdRef.current = assistantId;

      const abortController = new AbortController();
      controller.current = abortController;

      // 登记在途请求：切页卸载不中止，重挂载后据此恢复流式气泡并订阅增量。
      const chat: InflightChat = {
        sessionId,
        controller: abortController,
        content: '',
        active: true,
        listeners: new Set(),
      };
      inFlightChat = chat;
      let fullContent = '';

      if (dhOn && dhReady && dhRef.current) {
        setDhStatus('thinking');
        dhRef.current.think();
      } else if (dhOn && !dhReady) {
        setDhStatus('offline');
      }

      try {
        const payload: ChatMessagePayload[] = [
          SYSTEM_PROMPT,
          ...nextMessages
            .filter((m) => m.id !== 'welcome')
            .map(({ role, content }) => ({ role, content })),
        ];

        // 纯文本/拟态模式：开启舞台打字机字幕（真数字人模式仍由队列驱动）
        if (!(dhOn && dhReady)) {
          stageTextRef.current = '';
          stageShownRef.current = 0;
          stageDoneRef.current = false;
          if (stageHoldRef.current) {
            clearTimeout(stageHoldRef.current);
            stageHoldRef.current = null;
          }
          setStageSubtitleLive(true);
        }
        await streamChat(
          payload,
          sessionId,
          (chunk: string) => {
            if (abortController.signal.aborted) return;
            fullContent += chunk;
            // 同步模块级在途状态：切页后重挂载的实例通过订阅拿到增量，回复不中断。
            chat.content = fullContent;
            notifyInflight(chat);
            if (!mountedRef.current) return;

            setMessages((current) =>
              current.map((item) =>
                item.id === assistantId ? { ...item, content: fullContent } : item,
              ),
            );

            // 流式字幕（仅组件仍挂载时驱动；卸载后由重挂载页面的订阅恢复展示）
            if (dhOn && dhReady) {
              const parts = splitIntoSentences(fullContent);
              const last = parts.length ? parts[parts.length - 1] : fullContent;
              const lines = splitIntoLines(last);
              setDhSubtitle(lines[lines.length - 1]);
            } else {
              pushStageChunk(chunk);
              if (!stageTyperRef.current) runStageTyper();
            }
          },
          abortController.signal,
          {
            reportId: reportContextUsed?.reportId ?? null,
            documentId: reportContextUsed?.documentId ?? null,
          },
        );

        // streamChat 已验证 [DONE] 与至少一段可见正文；保留本地断言，
        // 防止未来替换实现时空回答再次静默落到页面。
        if (!fullContent.trim()) throw new Error('AI 助手未返回有效内容');
        setAnswerComplete(true);

        // 生成结束播报
        if (dhOn && dhReady && dhRef.current && fullContent && !dhMuted) {
          setDhStatus('speaking');
          const lines = splitIntoSentences(fullContent).flatMap((s) => splitIntoLines(s));
          if (lines.length > 1) {
            startSubtitleQueue(lines);
          } else {
            setDhSubtitle(fullContent);
          }
          dhRef.current.speak(fullContent, { isStart: true, isEnd: true });
        } else {
          setDhStatus(dhOn && dhReady ? 'idle' : 'offline');
          if (dhOn && dhReady) setDhSubtitle('');
          else endStageStream();
        }
      } catch (reason) {
        // A stopped request can finish after a newer request has started. Do not
        // let the stale request overwrite the active request's UI state.
        if (controller.current !== abortController) return;
        setAnswerComplete(false);
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : '对话生成中断或服务响应超时');
        }
        if (!fullContent.trim()) {
          // 不留下没有正文的“空气泡”；错误提示统一由下方 banner 呈现。
          setMessages((current) => current.filter((item) => item.id !== assistantId));
        }
        setDhStatus(dhOn && dhReady ? 'idle' : 'offline');
        if (dhOn && dhReady) setDhSubtitle('');
        else stopStageSubtitle();
      } finally {
        // streamChat resolves normally after the SSE [DONE]/reader completion.
        // Always release the busy lock, while preserving a newer request's lock.
        if (activeAssistantIdRef.current === assistantId) activeAssistantIdRef.current = null;
        // 结束在途对话（成功/失败/手动停止均进入）：通知订阅者，重挂载页面据此重拉历史。
        if (inFlightChat === chat) {
          chat.active = false;
          notifyInflight(chat);
          inFlightChat = null;
        }
        if (controller.current !== abortController) return;
        busyRef.current = false;
        setBusy(false);
        controller.current = null;
        // 回答完成后归还焦点，方便连续追问（不打断用户主动聚焦的其他控件）
        const ae = document.activeElement;
        if (!ae || ae === document.body) textareaRef.current?.focus();
      }
    },
    [busy, messages, dhOn, dhReady, dhMuted, sessionId, activeReportContext, startSubtitleQueue, pushStageChunk, runStageTyper, endStageStream, stopStageSubtitle],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input);
    }
  };

  const handleInputChange = (val: string) => {
    setInput(val);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  };

  // --- 语音识别输入 ---
  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null; // 阻止自动重启
      rec.onerror = null;
      try { rec.stop(); } catch { /* 已停止 */ }
    }
  }, []);

  const toggleListening = useCallback(() => {
    if (listeningRef.current) {
      stopListening();
      return;
    }
    const Ctor = speechRecognitionCtor;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      handleInputChange((finalText + interim).trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试');
      }
      stopListening();
    };
    rec.onend = () => {
      // continuous 模式偶发自动停止：仍处于聆听状态则自动续听，保证长句不中断
      if (listeningRef.current) {
        try { rec.start(); } catch { /* 无法续听 */ }
      } else {
        recognitionRef.current = null;
      }
    };
    recognitionRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    try {
      rec.start();
    } catch {
      stopListening();
    }
  }, [handleInputChange, stopListening]);

  // --- 质量分析报告导入 ---
  const openImportModal = useCallback(async () => {
    setImportOpen(true);
    setImportError('');
    setImportTab('system');
    if (systemReports.length === 0) {
      try {
        setSystemReports(await api.getReports());
      } catch (reason) {
        setImportError(reason instanceof Error ? reason.message : '报告列表加载失败');
      }
    }
  }, [systemReports.length]);

  const doImport = useCallback(async (file: File, contextOverrides?: Partial<ActiveReportContext>): Promise<KnowledgeDocInfo | null> => {
    setImportBusy(true);
    setImportError('');
    try {
      const doc = await api.uploadKnowledgeDoc(file);
      setImportedDocs((prev) => [doc, ...prev.filter((d) => d.file_name !== doc.file_name)]);
      setImportOpen(false);
      const context: ActiveReportContext = {
        documentId: doc.id,
        title: file.name,
        ...contextOverrides,
      };
      setActiveReportContext(context);
      await ask(
        `我已导入质量分析报告《${file.name}》，请帮我分析这份报告。请先概括报告中的风险等级、关键发现、可能来源和处置建议，并严格依据报告原文回答。`,
        context,
      );
      return doc;
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : '报告导入失败');
      return null;
    } finally {
      setImportBusy(false);
    }
  }, [ask]);

  const importSystemReport = useCallback(
    (report: Report) => {
      const reportId = Number(report.id.replace(/^RPT-/i, ''));
      if (!Number.isInteger(reportId) || reportId < 1) {
        setImportError('报告编号无效，无法绑定对话上下文');
        return;
      }
      const md = [
        `# 质量分析报告 ${report.id}`,
        `- 报告标题：${report.title}`,
        `- 监测海域：${report.area}`,
        `- 生成时间：${report.createdAt}`,
        `- 污染等级：${report.level}`,
        `- 质量评分：${report.score}`,
        `- 识别目标：${report.objectCount} 件`,
        `- 状态：${report.status}`,
        '',
        '## 评估摘要',
        '',
        report.summary,
      ].join('\n');
      const file = new File([md], `质量报告_${report.id}.md`, { type: 'text/markdown' });
      void doImport(file, { reportId, title: report.title, summary: report.summary });
    },
    [doImport],
  );

  const removeImportedDoc = useCallback(async (doc: KnowledgeDocInfo) => {
    try {
      await api.deleteKnowledgeDoc(doc.id);
      setImportedDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '移除文档失败');
    }
  }, []);

  const stop = () => {
    controller.current?.abort();
    stopSubtitleQueue();
    stopStageSubtitle();
    setAnswerComplete(false);
    const activeAssistantId = activeAssistantIdRef.current;
    if (activeAssistantId) {
      // 先同步清掉空泡，避免停止后立刻发新问题导致旧流的 catch 无法再清理。
      setMessages((current) => current.filter((item) => item.id !== activeAssistantId || item.content.trim()));
      activeAssistantIdRef.current = null;
    }
    busyRef.current = false;
    setBusy(false);
    setDhSubtitle('');
    if (dhRef.current) {
      dhRef.current.interactiveIdle();
      setDhStatus(dhReady ? 'idle' : 'offline');
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  const toggleDigitalHuman = () => {
    const next = !dhOn;
    setDhOn(next);
    if (!next) {
      dhRef.current?.interactiveIdle();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      setDhStatus('offline');
      setDhSubtitle('');
    } else {
      setDhStatus(dhReady ? 'idle' : 'offline');
    }
  };

  const toggleMute = () => {
    const next = !dhMuted;
    setDhMuted(next);
    if (dhRef.current) {
      dhRef.current.setVolume(next ? 0 : 1);
    }
    if (next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  const clearMessages = () => {
    if (busy) stop();
    const fresh = uuid();
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    setSessionId(fresh);
    setMessages([]);
    setError('');
    setAnswerComplete(false);
    setDhSubtitle('');
  };

  const exportChatMarkdown = () => {
    const lines = messages.map((m) => {
      const author = m.role === 'assistant' ? '海洋守护者 AI' : userName;
      const time = m.timestamp ? ` [${m.timestamp}]` : '';
      const attachment = m.attachment
        ? `\n> 关联质量报告：${m.attachment.label}${m.attachment.meta ? `\n> 报告摘要：${m.attachment.meta.replace(/\r?\n/g, ' ')}` : ''}\n`
        : '';
      return `### ${author}${time}${attachment}\n${m.content}\n`;
    });
    const boundReport = activeReportContext
      ? `\n当前绑定质量报告：${activeReportContext.title}${activeReportContext.summary ? `\n报告摘要：${activeReportContext.summary.replace(/\r?\n/g, ' ')}` : ''}\n`
      : '';
    const header = `# 海瞳 · 海洋守护者对话记录\n生成时间：${new Date().toLocaleString()}${boundReport}\n---\n\n`;
    downloadExport(header + lines.join('\n---\n\n'), `海洋守护者对话记录_${new Date().toISOString().slice(0, 10)}.md`, 'text/markdown;charset=utf-8');
    setExportOpen(false);
  };

  const exportChatJson = () => {
    const payload = {
      schema: 'haitong.chat-export.v2',
      title: '海瞳 · 海洋守护者对话记录',
      exportedAt: new Date().toISOString(),
      sessionId,
      model: 'ds-ocean_mingzhe',
      user: userName,
      activeReportContext: activeReportContext
        ? {
            reportId: activeReportContext.reportId ?? null,
            documentId: activeReportContext.documentId ?? null,
            title: activeReportContext.title,
            summary: activeReportContext.summary ?? '',
          }
        : null,
      messageCount: messages.length,
      messages: messages.map(({ id, role, content, timestamp, liked, attachment }) => ({
        id,
        role,
        content,
        timestamp,
        liked: Boolean(liked),
        attachment: attachment
          ? { label: attachment.label, meta: attachment.meta ?? '' }
          : null,
      })),
    };
    downloadExport(JSON.stringify(payload, null, 2), `海洋守护者对话记录_${new Date().toISOString().slice(0, 10)}.json`, 'application/json;charset=utf-8');
    setExportOpen(false);
  };

  const exportChatHtml = () => {
    const exportedAt = new Date();
    const dateLabel = exportedAt.toLocaleString('zh-CN', { hour12: false });
    const dateKey = exportedAt.toISOString().slice(0, 10);
    const userMessages = messages.filter((message) => message.role === 'user').length;
    const assistantMessages = messages.filter((message) => message.role === 'assistant').length;
    const citationCount = messages.reduce((total, message) => total + (message.content.match(/\[S\d+\]/gi)?.length ?? 0), 0);
    const transcript = messages.map((message, index) => {
      const roleLabel = message.role === 'assistant' ? '海洋守护者 AI' : userName;
      const roleClass = message.role === 'assistant' ? 'assistant' : 'user';
      const rendered = DOMPurify.sanitize(String(marked.parse(message.content, { breaks: true })), {
        USE_PROFILES: { html: true },
      });
      const answerRoot = document.createElement('div');
      answerRoot.innerHTML = `<div class="og-markdown-body">${rendered}</div>`;
      highlightKeyFacts(answerRoot);
      cardifyAnswer(answerRoot);
      const formatted = answerRoot.innerHTML;
      const attachment = message.attachment
        ? `<div class="attachment" style="margin:0 0 14px;padding:10px 12px;border:1px solid rgba(138,240,191,.3);border-radius:10px;background:rgba(138,240,191,.08)"><strong style="display:block;color:#8af0bf;font-size:11px">关联质量报告</strong><span style="display:block;color:#effffc;font-size:13px">${escapeExportHtml(message.attachment.label)}</span>${message.attachment.meta ? `<small style="display:block;color:#8ba9b4;font-size:11px">${escapeExportHtml(message.attachment.meta)}</small>` : ''}</div>`
        : '';
      return `<article class="message ${roleClass}">
        <div class="message-meta"><span class="avatar">${message.role === 'assistant' ? 'AI' : escapeExportHtml(userName.slice(0, 1).toUpperCase())}</span><div><strong>${escapeExportHtml(roleLabel)}</strong><time>${escapeExportHtml(message.timestamp ?? `消息 ${index + 1}`)}</time></div></div>
        ${attachment}
        <div class="message-body">${formatted}</div>
      </article>`;
    }).join('');
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>海瞳 · 海洋守护者对话记录</title>
<style>
.og-markdown-body{color:#d7e7ea}.og-markdown-body p{margin:7px 0}.og-markdown-body h1,.og-markdown-body h2,.og-markdown-body h3,.og-markdown-body h4{color:#fff;line-height:1.35}.og-markdown-body ul,.og-markdown-body ol{margin:8px 0;padding-left:20px}.og-markdown-body li{margin:4px 0}.og-markdown-body mark.og-hl{background:linear-gradient(transparent 58%,rgba(27,231,255,.3) 58%);color:#f2feff;font-weight:600;padding:0 1px;border-radius:2px}.og-markdown-body strong{color:#fff}.og-markdown-body .og-ans-conclusion{background:linear-gradient(135deg,rgba(56,248,212,.14),rgba(27,231,255,.06));border:1px solid rgba(56,248,212,.4);border-radius:12px;padding:10px 14px;margin:0 0 10px;font-weight:600;color:#eafffe}.og-markdown-body .og-ans-card{background:rgba(6,24,40,.55);border:1px solid rgba(135,222,255,.18);border-left:3px solid #59e6ef;border-radius:12px;padding:10px 14px;margin:0 0 10px}.og-markdown-body .og-ans-card-head{color:#59e6ef;font-weight:700;letter-spacing:.04em;margin:0 0 6px}.og-markdown-body .og-ans-card-list{margin:0;padding-left:18px}.og-markdown-body .og-ans-list{padding-left:18px}.og-markdown-body .og-pri-badge{display:inline-block;margin-right:6px;padding:0 6px;border-radius:6px;font-weight:700;font-size:11px}.og-pri-badge.pri-p0{background:rgba(255,104,133,.2);color:#ff8ba0;border:1px solid rgba(255,104,133,.5)}.og-pri-badge.pri-p1{background:rgba(255,181,71,.18);color:#ffc97e;border:1px solid rgba(255,181,71,.5)}.og-pri-badge.pri-p2{background:rgba(27,231,255,.16);color:#7fe8ff;border:1px solid rgba(27,231,255,.5)}
:root{color-scheme:dark;--ink:#dceff3;--muted:#8ba9b4;--line:rgba(125,224,238,.18);--cyan:#59e6ef;--deep:#071723;--panel:rgba(12,35,49,.82);--accent:#8af0bf}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0%,#123b4a 0,#071723 38%,#041019 100%);color:var(--ink);font:15px/1.75 Inter,"Microsoft YaHei",sans-serif}.wrap{max-width:980px;margin:0 auto;padding:56px 28px 72px}.hero{border:1px solid var(--line);background:linear-gradient(135deg,rgba(23,74,89,.72),rgba(7,27,40,.76));border-radius:22px;padding:34px 38px;box-shadow:0 24px 80px rgba(0,0,0,.22)}.kicker{color:var(--cyan);font-size:11px;letter-spacing:.18em;text-transform:uppercase}.hero h1{margin:10px 0 4px;font-size:32px;letter-spacing:.01em}.hero p{margin:0;color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:24px;color:#b9d3d9;font-size:12px}.meta span{padding-right:20px;border-right:1px solid var(--line)}.meta span:last-child{border:0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 30px}.stat{padding:17px 18px;border:1px solid var(--line);border-radius:14px;background:rgba(8,29,42,.7)}.stat b{display:block;color:#fff;font-size:24px}.stat span{color:var(--muted);font-size:12px}.section-title{display:flex;justify-content:space-between;align-items:center;margin:30px 0 12px;color:#bfe9ed;font-size:13px;letter-spacing:.08em}.section-title span{color:var(--muted);font-size:11px;letter-spacing:0}.message{margin:13px 0;padding:20px 22px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.message.user{border-left:3px solid #75a8ff}.message.assistant{border-left:3px solid var(--accent)}.message-meta{display:flex;align-items:center;gap:10px;margin-bottom:12px}.avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:rgba(89,230,239,.15);color:var(--cyan);font-size:10px;font-weight:700}.user .avatar{background:rgba(117,168,255,.16);color:#a8c5ff}.message-meta strong{display:block;font-size:13px}.message-meta time{display:block;color:var(--muted);font-size:11px}.message-body{color:#d7e7ea}.message-body p{margin:7px 0}.message-body h1,.message-body h2,.message-body h3{color:#fff;line-height:1.3}.message-body code{padding:2px 5px;border-radius:5px;background:rgba(0,0,0,.3);color:#b7f6db}.message-body pre{padding:14px;overflow:auto;background:#041018;border-radius:10px}.message-body blockquote{margin:10px 0;padding-left:14px;border-left:2px solid var(--cyan);color:#b4d1d6}.message-body a{color:var(--cyan)}.footer{margin-top:38px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:15px}@media(max-width:640px){.wrap{padding:24px 14px 40px}.hero{padding:25px 22px;border-radius:16px}.hero h1{font-size:25px}.stats{grid-template-columns:repeat(2,1fr)}.meta span{border:0}.message{padding:16px}.footer{display:block}.footer span{display:block;margin-top:5px}}
 </style></head><body><main class="wrap"><header class="hero"><div class="kicker">HAITONG · OCEAN GUARDIAN</div><h1>海洋守护者对话记录</h1><p>面向海洋垃圾识别、污染分析与治理研判的可追溯聊天流水</p><div class="meta"><span>导出时间：${escapeExportHtml(dateLabel)}</span><span>会话：${escapeExportHtml(sessionId.slice(0, 18))}</span><span>模型：ds-ocean_mingzhe</span></div></header><section class="stats"><div class="stat"><b>${messages.length}</b><span>消息总数</span></div><div class="stat"><b>${userMessages}</b><span>提问</span></div><div class="stat"><b>${assistantMessages}</b><span>回答</span></div><div class="stat"><b>${citationCount}</b><span>证据标记</span></div></section><div class="section-title"><span>聊天记录</span><span>按时间顺序整理 · 原文安全渲染</span></div><section>${transcript}</section><footer class="footer"><span>海瞳智慧海洋环境治理平台</span><span>本记录由海洋守护者对话模块生成 · ${escapeExportHtml(dateLabel)}</span></footer></main></body></html>`;
    downloadExport(html, `海洋守护者对话记录_${dateKey}.html`, 'text/html;charset=utf-8');
    setExportOpen(false);
  };

  const toggleLike = (id: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, liked: !m.liked } : m)),
    );
  };

  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i].content;
      }
    }
    return '';
  }, [messages]);

  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].id !== 'welcome') {
        return messages[i].content;
      }
    }
    return '';
  }, [messages]);

  const showThinking = dhOn && dhReady && dhStatus === 'thinking';
  // 真数字人模式：仅在播报/思考时显示队列字幕；纯文本/拟态模式：打字机字幕随流式回答常驻
  const showSubtitle = dhOn
    ? Boolean(dhSubtitle && (dhStatus === 'speaking' || dhStatus === 'thinking'))
    : Boolean(stageSubtitleLive && dhSubtitle);

  return (
    <div className={`ocean-guardian-v2-layout ${!dhOn ? 'pure-text-mode' : ''}`}>
      {/* ====== 左侧：全息 / 数字人 AI 舞台 ====== */}
      <aside className={`og-v2-stage-panel ${!dhOn ? 'og-collapsed' : ''}`}>
        <div className="og-stage-bg">
          <div className="og-stage-grid" />
          <div className="og-wave-layer wave-1" />
          <div className="og-wave-layer wave-2" />
          <ParticleField />
        </div>

        <div className="og-stage-header">
          <div className="og-stage-brand">
            <div className="og-brand-orb">
              <DigitalHumanIcon size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h3>海洋守护者</h3>
                <span className="digital-human-badge">AI 数字人</span>
              </div>
              <small>OCEAN GUARDIAN · DIGITAL HUMAN AI</small>
            </div>
          </div>

          <div className="og-stage-actions">
            <button
              className={`og-icon-action-btn ${dhMuted ? 'muted' : ''}`}
              onClick={toggleMute}
              title={dhMuted ? '已静音（点击开启声音）' : '声音正常（点击静音）'}
            >
              {dhMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          </div>
        </div>

        {/* 数字人 SDK 视口容器 */}
        <div className="og-stage-viewport">
          <div
            className="og-awrap"
            ref={sdkContainerRef}
            id="og-sdk-container"
            // XmovAvatar.init() 需要读取容器尺寸；display:none 会让 SDK 在初始化阶段拿到 0x0。
            // 保留布局尺寸，仅在就绪前隐藏渲染，避免初始化失败后误降级到拟态模式。
            style={{
              display: dhOn ? 'block' : 'none',
              visibility: dhReady ? 'visible' : 'hidden',
            }}
          />

          {/* 当数字人未加载/未配置/离线时，展示 AquaCore 全息拟态球 */}
          {(!dhReady || !dhOn) && (
            <AquaCoreStage status={dhStatus} isSpeaking={dhStatus === 'speaking'} />
          )}

          {/* 数字人加载进度 HUD（仅在真实加载中显示；离线降级由光核模式芯片表达） */}
          {!dhReady && dhOn && dhStatus !== 'offline' && (
            <div className="og-stage-loading-hud" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={16} />
              <span>{dhLoadingText}</span>
              <div className="og-hud-progress">
                <i style={{ width: `${Math.max(6, dhProgress)}%` }} />
              </div>
              <em>{dhProgress > 0 ? `${Math.round(dhProgress)}%` : '准备中'}</em>
            </div>
          )}

          {/* 舞台思考遮罩 */}
          <ThinkingOverlay visible={showThinking} />

          {/* 流式字幕 HUD */}
          <div className={`og-subtitle-hud ${showSubtitle ? 'visible' : ''}`} role="status" aria-live="polite">
            <span className="og-subtitle-hud-text">{dhSubtitle}</span>
            {dhStatus === 'thinking' && <i className="og-subtitle-hud-caret" aria-hidden="true" />}
          </div>
        </div>

        {/* 舞台底部状态与参数条 */}
        <div className="og-stage-footer">
          <div className="og-status-pill" role="status" aria-live="polite" data-status={dhStatus}>
            <span className={`og-status-dot dot-${dhStatus}`} aria-hidden="true" />
            <span className="og-status-text">{STATUS_LABELS[dhStatus]}</span>
            <span className="og-status-pulse" aria-hidden="true" />
          </div>
          <div className="og-tech-badge">
            <Bot size={12} />
            <span>RAG 知识库增强</span>
          </div>
        </div>
      </aside>

      {/* ====== 右侧：专业智能对话面板 ====== */}
      <section className="og-v2-chat-panel">
        {/* 顶部工具栏 */}
        <header className="og-chat-topbar">
          <div className="og-topbar-title-group">
            <div className="og-topbar-icon">
              <Waves size={18} />
            </div>
            <div>
              <span className="og-topbar-kicker">海域研判工作台 / 02</span>
              <div className="og-topbar-title-row">
                <h2>海洋守护者</h2>
                <span className="og-model-chip">ds-ocean_mingzhe</span>
                <span className="og-rag-chip">
                  <Sparkles size={11} /> RAG 知识检索已启用
                </span>
              </div>
              <p>海瞳 智慧海洋环境治理与垃圾识别研判助手</p>
            </div>
          </div>

          <div className="og-topbar-tools">
            <button
              className={`og-topbar-btn ${!dhOn ? 'active' : ''}`}
              onClick={toggleDigitalHuman}
              title={dhOn ? '切换为纯文本大屏' : '切换为数字人协同'}
            >
              {dhOn ? (<><MessagesSquare size={13} /><span>纯文本</span></>) : (<><Bot size={13} /><span>数字人</span></>)}
            </button>

            <div className="og-export-wrap">
              <button
                className={`og-topbar-btn ${exportOpen ? 'active' : ''}`}
                onClick={() => setExportOpen((open) => !open)}
                title="选择对话记录导出格式"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
              >
                <Download size={13} />
                <span>导出记录</span>
                <ChevronRight className={`og-export-chevron ${exportOpen ? 'open' : ''}`} size={12} />
              </button>
              {exportOpen && (
                <div className="og-export-menu" role="menu">
                  <button onClick={exportChatHtml} role="menuitem"><FileBarChart size={14} /><span><strong>HTML 对话记录</strong><small>适合答辩展示与归档</small></span></button>
                  <button onClick={exportChatMarkdown} role="menuitem"><FileText size={14} /><span><strong>Markdown 对话记录</strong><small>便于继续编辑</small></span></button>
                  <button onClick={exportChatJson} role="menuitem"><FileJson size={14} /><span><strong>JSON 对话数据</strong><small>保留结构化聊天流水</small></span></button>
                </div>
              )}
            </div>

            <button
              className="og-topbar-btn danger"
              onClick={clearMessages}
              title="清空记录并开启新会话"
            >
              <Trash2 size={13} />
              <span>新建会话</span>
            </button>
          </div>
        </header>

        {/* 消息滚动容器 */}
        <div
          className="og-messages-viewport"
          ref={chatScrollRef}
          onScroll={handleScroll}
        >
          {messages.length === 0 && <WelcomeHero userName={userName} busy={busy} onAsk={(q) => void ask(q)} />}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              streaming={
              (busy && msg === messages[messages.length - 1]) ||
              (inflightBubbleId !== null && msg.id === inflightBubbleId)
            }
              userName={userName}
              userInitial={userInitial}
              onSpeak={speakText}
              onLike={toggleLike}
            />
          ))}

          {/* 深度推理思考条 */}
          {busy && messages[messages.length - 1]?.content === '' && (
            <div className="og-thinking-strip">
              <div className="og-thinking-strip-inner">
                <Waves className="spin" size={15} />
                <span>正在检索知识库并进行深度逻辑推理…</span>
                <div className="og-tdots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}

          {/* 建议追问（证据锚定：空结果时整块隐藏） */}
          {!busy && answerComplete && lastAssistantMessage && !error && (
            <FollowUpSuggestions
              sessionId={sessionId}
              userQuestion={lastUserMessage}
              assistantAnswer={lastAssistantMessage}
              onSelect={ask}
              busy={busy}
            />
          )}

          {/* 异常重试提醒 */}
          {error && (
            <div className="og-error-banner">
              <AlertCircle size={15} />
              <span>{error}</span>
              <button onClick={() => void ask(lastQuestion)}>
                <RotateCcw size={12} /> 重新生成
              </button>
            </div>
          )}

          <div ref={bottomRef} style={{ height: 1 }} />
        </div>

        {/* 悬浮一键回到底部按钮 */}
        {showScrollBottom && (
          <button
            className="og-scroll-bottom-btn"
            onClick={() => { stickToBottomRef.current = true; scrollToBottom(true, true); }}
            title="回到底部"
          >
            <ArrowDown size={14} />
            <span>最新内容</span>
          </button>
        )}

        {/* 底部输入工作台 */}
        <div className="og-composer-container">
          <div className="og-import-bar">
            <button
              type="button"
              className={`og-import-btn ${activeReportContext ? 'bound' : ''}`}
              onClick={() => void openImportModal()}
              disabled={busy}
              title={activeReportContext
                ? `已绑定：${activeReportContext.title}——后续消息自动携带该报告；点击可更换`
                : '导入质量分析报告至知识库，可向海洋守护者咨询报告内容'}
            >
              <FileUp size={13} /> {activeReportContext ? '更换报告' : '导入质量分析报告'}
              {activeReportContext && (
                <span
                  className="og-import-bound-name"
                  role="button"
                  aria-label="解除报告绑定"
                  title="点击解除绑定（消息不再携带报告）"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveReportContext(null);
                  }}
                >
                  {activeReportContext.title} <X size={11} />
                </span>
              )}
            </button>
            {importedDocs.length > 0 && (
              <div className="og-import-chips">
                {importedDocs.map((doc) => (
                  <span key={doc.id} className="og-import-chip" title={`已导入：${doc.file_name}`}>
                    <FileBarChart size={12} />
                    <span className="og-import-chip-name">{doc.file_name}</span>
                    <button
                      type="button"
                      className="og-import-chip-x"
                      onClick={() => void removeImportedDoc(doc)}
                      aria-label={`移除 ${doc.file_name}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <form className="og-composer-form" onSubmit={submit}>
            <div className="og-composer-input-box">
              <textarea
                ref={textareaRef}
                id="og-input"
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="向海洋守护者提问（例如：珊瑚附近发现废弃渔网应如何处置？）..."
              />

              <div className="og-composer-toolbar">
                <div className="og-composer-tips">
                  {listening ? (
                    <span className="og-mic-tip">正在聆听… 再说一次即可继续，点击麦克风结束</span>
                  ) : (
                    <span>Enter 发送 · Shift+Enter 换行</span>
                  )}
                  {input.trim().length > 0 && (
                    <span className="og-char-count">{input.trim().length} 字</span>
                  )}
                </div>

                <div className="og-composer-actions">
                  {!busy && (
                    <button
                      type="button"
                      className={`og-composer-tool-btn og-mic-btn ${listening ? 'listening' : ''}`}
                      onClick={toggleListening}
                      disabled={!speechSupported}
                      title={
                        !speechSupported
                          ? '当前浏览器不支持语音输入，请使用 Chrome/Edge'
                          : listening
                            ? '停止语音输入'
                            : '语音输入（中文）'
                      }
                    >
                      {listening ? (
                        <span className="og-mic-wave" aria-hidden="true"><i /><i /><i /></span>
                      ) : (
                        <Mic size={13} />
                      )}
                    </button>
                  )}

                  {input.trim().length > 0 && !busy && (
                    <button
                      type="button"
                      className="og-composer-tool-btn"
                      onClick={() => handleInputChange('')}
                      title="清空输入"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}

                  {busy ? (
                    <button
                      type="button"
                      className="og-send-btn stop"
                      onClick={stop}
                      title="停止生成"
                    >
                      <Square size={14} />
                      <span>停止</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="og-send-btn"
                      disabled={!input.trim()}
                      title="发送问题"
                    >
                      <Send size={14} />
                      <span>发送</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
      </section>

      {/* 导入质量分析报告弹窗 */}
      {importOpen && (
        <div
          className="og-modal-mask"
          onClick={() => { if (!importBusy) setImportOpen(false); }}
        >
          <div
            className="og-import-modal"
            role="dialog"
            aria-modal="true"
            aria-label="导入质量分析报告"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="og-import-modal-head">
              <div>
                <span className="eyebrow"><i /> IMPORT QUALITY REPORT</span>
                <h3>导入质量分析报告</h3>
                <p>导入后进入知识库，可直接向海洋守护者咨询报告内容</p>
              </div>
              <button className="og-import-close" onClick={() => setImportOpen(false)} aria-label="关闭" disabled={importBusy}>
                <X size={16} />
              </button>
            </header>

            <div className="og-import-tabs">
              <button
                type="button"
                className={importTab === 'system' ? 'active' : ''}
                onClick={() => { setImportTab('system'); setImportError(''); }}
              >
                <FileBarChart size={13} /> 从质量报告导入
              </button>
              <button
                type="button"
                className={importTab === 'upload' ? 'active' : ''}
                onClick={() => { setImportTab('upload'); setImportError(''); }}
              >
                <UploadCloud size={13} /> 上传报告文件
              </button>
            </div>

            <div className="og-import-body">
              {importTab === 'system' ? (
                systemReports.length === 0 ? (
                  <div className="og-import-empty">
                    <FileBarChart size={22} />
                    <span>{importError || '暂无质量报告，可切换到「上传报告文件」'}</span>
                  </div>
                ) : (
                  <ul className="og-report-list">
                    {systemReports.map((report) => (
                      <li key={report.id}>
                        <div className="og-report-meta">
                          <strong>{report.title}</strong>
                          <small>{report.createdAt} · {report.area} · 等级 {report.level} · 评分 {report.score} · 目标 {report.objectCount} 件</small>
                        </div>
                        <button
                          type="button"
                          className="og-report-import-btn"
                          onClick={() => importSystemReport(report)}
                          disabled={importBusy}
                        >
                          {importBusy ? <LoaderCircle className="spin" size={13} /> : <FileUp size={13} />}
                          {importBusy ? '导入中' : '导入'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <div className="og-upload-zone">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.txt,.md,.html"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void doImport(file);
                    }}
                  />
                  <button
                    type="button"
                    className="og-upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importBusy}
                  >
                    {importBusy ? <LoaderCircle className="spin" size={20} /> : <UploadCloud size={20} />}
                    {importBusy ? '正在导入…' : '选择报告文件'}
                  </button>
                  <p>支持 pdf / txt / md / html 格式。上传后自动进入知识库并建立检索索引，回答问题时将引用报告内容。</p>
                  {importError && <div className="og-import-error"><AlertCircle size={13} />{importError}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
