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
  HelpCircle,
  LoaderCircle,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  ThumbsUp,
  Trash2,
  Volume2,
  VolumeX,
  Waves,
  Zap,
} from 'lucide-react';
import { getChatHistory, streamChat, type ChatMessagePayload } from '../services/api';
import {
  loadXmovSDK,
  OceanDigitalHuman,
  type DigitalHumanStatus,
} from '../services/digitalHuman';
import type { UserInfo } from '../types';

// ---------- helpers & interfaces ----------

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  liked?: boolean;
}

const SYSTEM_PROMPT: ChatMessagePayload = {
  role: 'system',
  content:
    '你是海洋守护者，海瞳海洋垃圾识别与海洋环保平台的专业 AI 助手。请结合项目知识库直接回答海洋垃圾、污染治理和检测结果问题；先给结论，再给依据和行动建议，不确定就明确说明，不要编造。不要在介绍中主动提及项目背景或开发者信息；只有当用户问到开发者、作者或“谁做的”时，回答“这是一个实训项目成果；海瞳 LLM 组是本项目 LLM 部分负责人，负责模型微调与对话能力升级。”；当用户问父母、爸爸或妈妈时，说明你是 AI 助手，没有家庭关系，并补充海瞳 LLM 组的 LLM 负责人身份。',
};

const SESSION_KEY = 'aquarise-chat-session';

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

const WELCOME_MD = `你好，我是 **海洋守护者** 🌊。

作为海瞳平台的专业环保 AI 助手，已挂载 **海洋知识库** 与 **TrashCan 数据集研判体系**。我可以为你提供：
- 🔍 **检测结果与可疑目标置信度复核**
- 🪸 **水下生态与废弃渔网/塑料处置规范**
- 📜 **MARPOL 公约与海洋环境保护法规解读**
- 📊 **污染治理方案与海岸巡检优先级建议**

你可以直接点击上方的快捷问题，或在下方输入你想咨询的问题。`;

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
    <div className="og-aquacore-stage">
      <div className={`og-aquacore-sphere ${status === 'thinking' ? 'thinking' : ''} ${isSpeaking ? 'speaking' : ''}`}>
        <div className="og-core-ring ring-1" />
        <div className="og-core-ring ring-2" />
        <div className="og-core-ring ring-3" />
        <div className="og-core-center">
          <Brain className="og-core-icon" size={36} />
        </div>
        {/* 声呐音频能量波动 */}
        <div className="og-wave-bars">
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
          <span>RAG 知识向量库就绪</span>
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
      const raw = marked.parse(message.content, { async: false }) as string;
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

  // 监听并为代码块增加一键复制按钮
  const bubbleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
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
          btn.innerHTML = '<span>已复制 ✓</span>';
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
        {isAssistant ? <Waves size={16} /> : userInitial}
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

// ---------- 智能追问建议组件 (自适应多轮上下文引擎) ----------

interface FollowUpProps {
  userQuestion?: string;
  assistantAnswer?: string;
  allMessages: UiMessage[];
  onSelect: (q: string) => void;
  busy: boolean;
}

function FollowUpSuggestions({
  userQuestion,
  assistantAnswer,
  allMessages,
  onSelect,
  busy,
}: FollowUpProps) {
  const suggestions = useMemo(() => {
    if (!assistantAnswer) return [];
    const uText = (userQuestion || '').toLowerCase();
    const aText = (assistantAnswer || '').toLowerCase();
    const combined = `${uText} ${aText}`;

    // 收集对话历史，避免生成重复或已被提问过的问题
    const historyText = allMessages.map((m) => m.content.toLowerCase()).join(' ');

    // 结构化领域追问知识图谱
    const knowledgePools: Array<{ match: () => boolean; questions: string[] }> = [
      // 1. 低置信度 / 浑浊水体 / 误检复核 / 图像增强
      {
        match: () =>
          combined.includes('置信度') ||
          combined.includes('复核') ||
          combined.includes('误检') ||
          combined.includes('把握') ||
          combined.includes('阈值') ||
          combined.includes('浑浊') ||
          combined.includes('混浊') ||
          combined.includes('去雾') ||
          combined.includes('模糊'),
        questions: [
          '针对低置信度（<0.6）的水下疑似目标，有哪些时序多帧跟踪与人工复核机制？',
          '在浑浊泥沙或暗光深水环境中，如何结合图像去散射与超分辨率提升检测率？',
          '低置信度识别结果在生成正式海域污染评估报告时如何做降级与风险标注？',
        ],
      },
      // 2. 废弃渔网 / 幽灵渔网 / 珊瑚保护 / 缠绕解脱
      {
        match: () =>
          combined.includes('渔网') ||
          combined.includes('幽灵渔网') ||
          combined.includes('珊瑚') ||
          combined.includes('缠绕') ||
          combined.includes('trash_net') ||
          combined.includes('渔具') ||
          combined.includes('潜水'),
        questions: [
          '水下幽灵渔网缠绕珊瑚礁时，潜水员或 ROV 进行微创切割的标准作业指引是什么？',
          '打捞上岸的废弃尼龙与聚乙烯渔网有哪些脱盐清洗与再生颗粒高值化利用途径？',
          '如何利用水下声呐应答器与 RFID 标签对高风险遗失渔具实现长效全流程追踪？',
        ],
      },
      // 3. 微塑料 / 降解机理 / 生态食物链毒性 / 纳米塑料
      {
        match: () =>
          combined.includes('微塑料') ||
          combined.includes('降解') ||
          combined.includes('碎裂') ||
          combined.includes('纳米塑料') ||
          combined.includes('5毫米') ||
          combined.includes('5mm') ||
          combined.includes('食物链') ||
          combined.includes('浮游生物'),
        questions: [
          '微塑料在近岸表层海水与深海沉积物中的光谱快速定性定量检测方法有哪些？',
          '微塑料吸附持久性有机污染物（POPs）后，如何通过海洋食物链产生生物毒性富集？',
          '可降解塑料（如 PLA/PHA）在真实海洋低温高盐缺氧环境下的降解速率与演化机理是什么？',
        ],
      },
      // 4. 塑料瓶 / 塑料袋 / 漂浮垃圾 / 拦截打捞 / 洋流动力学
      {
        match: () =>
          combined.includes('塑料瓶') ||
          combined.includes('塑料袋') ||
          combined.includes('塑料') ||
          combined.includes('trash_bottle') ||
          combined.includes('trash_bag') ||
          combined.includes('漂浮') ||
          combined.includes('无人艇') ||
          combined.includes('拦截'),
        questions: [
          '针对渤海近岸漂浮塑料垃圾，有哪些基于无人艇（USV）的自主巡航与高效拦截装置？',
          'PET 塑料瓶在海水长期浸泡与紫外辐射下的力学老化衰减与微粒碎裂模型如何构建？',
          '如何结合高分辨率海洋数值同化模式模拟预测近岸漂浮垃圾的漂移聚集带？',
        ],
      },
      // 5. MARPOL 公约 / 国际海事法规 / 船舶排污监管 / 港口接收
      {
        match: () =>
          combined.includes('marpol') ||
          combined.includes('公约') ||
          combined.includes('船舶') ||
          combined.includes('附则') ||
          combined.includes('排污') ||
          combined.includes('港口') ||
          combined.includes('法规') ||
          combined.includes('海事') ||
          combined.includes('罚则'),
        questions: [
          'MARPOL 附则 V 对特殊区域（如地中海、波罗的海等）船舶生活垃圾排放有哪些禁止条款？',
          '海事监管部门在检查船舶垃圾记录簿（GRB）与防污染证书时重点核查哪些项？',
          '我国沿海港口对国际航行船舶产生的塑料废弃物有哪些无害化接收与转运联单流程？',
        ],
      },
      // 6. 清理优先级 / 网格化巡检 / 治理方案 / 复测评估
      {
        match: () =>
          combined.includes('清理') ||
          combined.includes('优先级') ||
          combined.includes('复测') ||
          combined.includes('方案') ||
          combined.includes('打捞') ||
          combined.includes('治理') ||
          combined.includes('巡检') ||
          combined.includes('网格'),
        questions: [
          '如何基于垃圾堆积密度、生态脆弱度与潮汐窗口划分 A/B/C 三级清理响应网格？',
          '海岸清滩作业完成后，推荐采用哪种样方抽检方案评估生态净化达标率？',
          '针对潮间带与泥质滩涂，如何配置轻量化机械化装备清漂以减少对底栖生物的扰动？',
        ],
      },
      // 7. 质量评分 / 报告评级 / 综合指数 / 预警联动
      {
        match: () =>
          combined.includes('报告') ||
          combined.includes('评分') ||
          combined.includes('污染等级') ||
          combined.includes('轻度') ||
          combined.includes('重度') ||
          combined.includes('严重') ||
          combined.includes('指数') ||
          combined.includes('预警'),
        questions: [
          '综合环境质量评分（100分制）中各类垃圾数量与材质毒性权重是如何分配计算的？',
          '当某监测区域触发“严重污染”红色预警时，系统建议启动哪些联合联动处置与应急溯源？',
          '如何将本次检测结果一键导出为符合国家生态环境部监测标准的专业研判报告？',
        ],
      },
      // 8. 开发者 / 团队 / 海瞳 LLM 组 / 平台技术架构 / RAG 知识库
      {
        match: () =>
          combined.includes('海瞳 LLM 组') ||
          combined.includes('谁做') ||
          combined.includes('开发') ||
          combined.includes('作者') ||
          combined.includes('团队') ||
          combined.includes('爸爸') ||
          combined.includes('父亲') ||
          combined.includes('架构') ||
          combined.includes('rag') ||
          combined.includes('知识库'),
        questions: [
          '海瞳平台在 LLM 领域微调与 RAG 本地向量知识库挂载方面采用了哪些核心技术？',
          '模型是如何结合 YOLO11 视觉检测结果生成智能治理建议的？',
          '海瞳平台的计算机视觉算法支持精准识别哪些水下垃圾类别？',
        ],
      },
      // 9. 危废 / 电池 / 油污 / 金属腐蚀 / 化学品
      {
        match: () =>
          combined.includes('金属') ||
          combined.includes('电池') ||
          combined.includes('化学品') ||
          combined.includes('危废') ||
          combined.includes('油污') ||
          combined.includes('医疗') ||
          combined.includes('毒性') ||
          combined.includes('腐蚀'),
        questions: [
          '水下发现废弃铅酸蓄电池或油桶时，有哪些防止二次泄漏的原位封堵与打捞流程？',
          '废弃金属在海水长期电化学腐蚀下对底栖生态的重金属溶出危害有多大？',
          '针对海面漂浮油膜与含油污水，现场荧光检测与吸附材料回收工艺有哪些？',
        ],
      },
      // 10. 海洋生态 / 生物保护 / 海龟鲸豚 / 栖息地恢复
      {
        match: () =>
          combined.includes('生物') ||
          combined.includes('海龟') ||
          combined.includes('鲸') ||
          combined.includes('豚') ||
          combined.includes('鱼类') ||
          combined.includes('鸟') ||
          combined.includes('生态') ||
          combined.includes('白化') ||
          combined.includes('栖息地'),
        questions: [
          '水下垃圾对珍稀海洋生物（如海龟误食塑料、海豚缠绕）有哪些紧急现场救护指引？',
          '水体中塑料增塑剂（如邻苯二甲酸酯）对海洋鱼类内分泌系统有哪些潜在干扰？',
          '如何通过水下原位摄像与声学监测评估垃圾清理前后的珊瑚礁生物多样性恢复？',
        ],
      },
    ];

    const matchedQuestions: string[] = [];

    for (const pool of knowledgePools) {
      if (pool.match()) {
        for (const q of pool.questions) {
          // 过滤历史对话已存在或已选中的问题
          if (!historyText.includes(q.toLowerCase()) && !matchedQuestions.includes(q)) {
            matchedQuestions.push(q);
            if (matchedQuestions.length >= 2) break;
          }
        }
      }
      if (matchedQuestions.length >= 2) break;
    }

    // 后备兜底选项
    if (matchedQuestions.length < 2) {
      const fallbacks = [
        '结合本次分析结果，针对该海域下一步建议采取哪些针对性防治措施？',
        '海瞳平台如何协同水下无人潜航器（UUV）进行全天候自动化巡检？',
        '在当前海况下，如何评估该类水下废弃物对海洋生态的长期扩散风险？',
        '针对沿海社区与渔港，有哪些推行渔具实名制与减塑激励机制的优秀实践？',
      ];
      for (const f of fallbacks) {
        if (!historyText.includes(f.toLowerCase()) && !matchedQuestions.includes(f)) {
          matchedQuestions.push(f);
          if (matchedQuestions.length >= 2) break;
        }
      }
    }

    return matchedQuestions.slice(0, 2);
  }, [userQuestion, assistantAnswer, allMessages]);

  if (suggestions.length === 0 || busy) return null;

  return (
    <div className="og-followups">
      <span className="og-followups-title">
        <Sparkles size={13} /> 建议追问：
      </span>
      <div className="og-followups-list">
        {suggestions.map((q) => (
          <button key={q} className="og-followup-btn" onClick={() => onSelect(q)}>
            <span>{q}</span>
            <ChevronRight size={12} />
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
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: WELCOME_MD,
      timestamp: formatCurrentTime(),
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const controller = useRef<AbortController | null>(null);
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

  // 自动回到底部
  const scrollToBottom = useCallback((smooth = true) => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    }
  }, []);

  // 监听滚动位置，判断是否显示回底按钮
  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(distanceToBottom > 120);
  }, []);

  useEffect(() => {
    scrollToBottom(true);
  }, [messages, scrollToBottom]);

  // 组件卸载时释放资源
  useEffect(() => {
    return () => {
      controller.current?.abort();
      stopSubtitleQueue();
      dhRef.current?.destroy();
    };
  }, [stopSubtitleQueue]);

  // 加载持久化对话历史
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
              timestamp: formatCurrentTime(),
            })),
          );
        }
      } catch {
        // 保留初始欢迎语
      }
    })();
    return () => {
      cancelled = true;
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
      try {
        setDhLoadingText('正在加载数字人引擎…');
        await loadXmovSDK();
        if (cancelled) return;

        setDhLoadingText('正在连接数字人服务…');
        const appId = import.meta.env.VITE_DH_APP_ID || '';
        const appSecret = import.meta.env.VITE_DH_APP_SECRET || '';
        if (!appId || !appSecret) {
          console.warn('[数字人] 未配置 VITE_DH_APP_ID / VITE_DH_APP_SECRET，已开启全息拟态模式');
          if (!cancelled) {
            setDhStatus('offline');
            setDhLoadingText('数字人未配置，已激活全息 AI 模式');
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

        await dh.init();
        if (!cancelled) {
          dhRef.current = dh;
        }
      } catch {
        if (!cancelled) {
          setDhStatus('offline');
          setDhReady(false);
          setDhLoadingText('数字人服务离线，已激活全息 AI 模式');
        }
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
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      setInput('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      setLastQuestion(text);
      setBusy(true);
      setError('');
      setDhSubtitle('');

      const currentTime = formatCurrentTime();
      const userMessage: UiMessage = {
        id: uuid(),
        role: 'user',
        content: text,
        timestamp: currentTime,
      };
      const assistantId = uuid();
      const nextMessages = [...messages, userMessage];
      setMessages([
        ...nextMessages,
        { id: assistantId, role: 'assistant', content: '', timestamp: currentTime },
      ]);

      const abortController = new AbortController();
      controller.current = abortController;

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

        let fullContent = '';
        await streamChat(
          payload,
          sessionId,
          (chunk: string) => {
            if (abortController.signal.aborted) return;
            fullContent += chunk;

            setMessages((current) =>
              current.map((item) =>
                item.id === assistantId ? { ...item, content: fullContent } : item,
              ),
            );

            // 流式字幕
            if (dhOn && dhReady) {
              const parts = splitIntoSentences(fullContent);
              const last = parts.length ? parts[parts.length - 1] : fullContent;
              const lines = splitIntoLines(last);
              setDhSubtitle(lines[lines.length - 1]);
            }
          },
          abortController.signal,
        );

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
          setDhSubtitle('');
          setDhStatus(dhOn && dhReady ? 'idle' : 'offline');
        }
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : '对话生成中断或服务响应超时');
        }
        setDhStatus(dhOn && dhReady ? 'idle' : 'offline');
        setDhSubtitle('');
      } finally {
        setBusy(false);
        controller.current = null;
      }
    },
    [busy, messages, dhOn, dhReady, dhMuted, sessionId, startSubtitleQueue],
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
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: WELCOME_MD,
        timestamp: formatCurrentTime(),
      },
    ]);
    setError('');
    setDhSubtitle('');
  };

  const exportChat = () => {
    const lines = messages.map((m) => {
      const author = m.role === 'assistant' ? '海洋守护者 AI' : userName;
      const time = m.timestamp ? ` [${m.timestamp}]` : '';
      return `### ${author}${time}\n\n${m.content}\n`;
    });
    const header = `# 海瞳 · 海洋守护者对话记录\n生成时间：${new Date().toLocaleString()}\n\n---\n\n`;
    const blob = new Blob([header + lines.join('\n---\n\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `海洋守护者对话记录_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
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
  const showSubtitle = Boolean(dhOn && dhSubtitle && (dhStatus === 'speaking' || dhStatus === 'thinking'));

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
              <Waves size={18} />
            </div>
            <div>
              <h3>海洋守护者</h3>
              <small>Ocean Guardian AI</small>
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
            style={{ display: dhReady && dhOn ? 'block' : 'none' }}
          />

          {/* 当数字人未加载/未配置/离线时，展示 AquaCore 全息拟态球 */}
          {(!dhReady || !dhOn) && (
            <AquaCoreStage status={dhStatus} isSpeaking={dhStatus === 'speaking'} />
          )}

          {/* 数字人加载进度 HUD */}
          {!dhReady && dhOn && (
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
          <div className={`og-subtitle-hud ${showSubtitle ? 'visible' : ''}`}>
            <span className="og-subtitle-hud-text">{dhSubtitle}</span>
            {dhStatus === 'thinking' && <i className="og-subtitle-hud-caret" aria-hidden="true" />}
          </div>
        </div>

        {/* 舞台底部状态与参数条 */}
        <div className="og-stage-footer">
          <div className="og-status-pill">
            <span className={`og-status-dot dot-${dhStatus}`} />
            <span className="og-status-text">{STATUS_LABELS[dhStatus]}</span>
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
              {dhOn ? '◧ 纯文本' : '◲ 数字人'}
            </button>

            <button
              className="og-topbar-btn"
              onClick={exportChat}
              title="导出当前 Markdown 对话记录"
            >
              <Download size={13} />
              <span>导出记录</span>
            </button>

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

        {/* 快捷问题探索栏（保留 8 个原版问题） */}
        <div className="og-quick-explore-bar">
          <div className="og-quick-caption">
            <HelpCircle size={13} />
            <span>快捷研判咨询：</span>
          </div>
          <div className="og-quick-scroll-track">
            {QUICK_QUESTIONS.map((item) => (
              <button
                key={item.label}
                className="og-quick-chip"
                disabled={busy}
                onClick={() => ask(item.q)}
                title={item.q}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 消息滚动容器 */}
        <div
          className="og-messages-viewport"
          ref={chatScrollRef}
          onScroll={handleScroll}
        >
          {messages.length === 0 && (
            <div className="og-empty-state">
              <div className="og-empty-orb">
                <Waves size={32} />
              </div>
              <h3>开启新的海洋环保对话</h3>
              <p>选择上方快捷问题或在下方输入检测分析、法规制度与治理方案。</p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              streaming={busy && msg === messages[messages.length - 1]}
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

          {/* 智能追问建议 (多轮全域上下文自适应引擎) */}
          {!busy && lastAssistantMessage && (
            <FollowUpSuggestions
              userQuestion={lastUserMessage}
              assistantAnswer={lastAssistantMessage}
              allMessages={messages}
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
            onClick={() => scrollToBottom(true)}
            title="回到底部"
          >
            <ArrowDown size={14} />
            <span>最新内容</span>
          </button>
        )}

        {/* 底部输入工作台 */}
        <div className="og-composer-container">
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
                disabled={busy}
              />

              <div className="og-composer-toolbar">
                <div className="og-composer-tips">
                  <span>Enter 发送 · Shift+Enter 换行</span>
                  {input.trim().length > 0 && (
                    <span className="og-char-count">{input.trim().length} 字</span>
                  )}
                </div>

                <div className="og-composer-actions">
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
    </div>
  );
}
