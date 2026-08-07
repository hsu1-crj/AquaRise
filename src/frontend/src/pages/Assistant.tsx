import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Bot, CircleStop, FileText, Leaf, LifeBuoy, LoaderCircle, Send, Sparkles, Trash2, UserRound, Waves } from 'lucide-react';
import { streamChat, type ChatMessagePayload } from '../services/api';

interface UiMessage { id: string; role: 'user' | 'assistant'; content: string }
const systemMessage: ChatMessagePayload = { role: 'system', content: '你是 AQUARISE 海洋环保助手，专注水下垃圾识别、海洋污染分析和治理建议。回答应准确、简洁，不确定时明确说明。' };

export function AssistantPage() {
  const [messages, setMessages] = useState<UiMessage[]>([{ id: 'welcome', role: 'assistant', content: '你好，我是 **AQUA 智能助手**。我可以解读检测结果、分析污染报告，也可以回答海洋垃圾治理问题。' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const controller = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => () => controller.current?.abort(), []);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setInput(''); setLastQuestion(text); setBusy(true); setError('');
    const userMessage: UiMessage = { id: crypto.randomUUID(), role: 'user', content: text };
    const assistantId = crypto.randomUUID();
    const nextMessages = [...messages, userMessage];
    setMessages([...nextMessages, { id: assistantId, role: 'assistant', content: '' }]);
    const abortController = new AbortController(); controller.current = abortController;
    try {
      const payload: ChatMessagePayload[] = [systemMessage, ...nextMessages.map(({ role, content }) => ({ role, content }))];
      await streamChat(payload, (chunk) => setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content + chunk } : item)), abortController.signal);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '对话生成失败');
    } finally {
      setBusy(false); controller.current = null;
    }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void ask(input); };
  const stop = () => { controller.current?.abort(); setBusy(false); };
  const quickQuestions = [
    { icon: FileText, title: '解读污染报告', text: '如何解读海域污染质量报告中的垃圾密度和质量评分？' },
    { icon: LifeBuoy, title: '制定打捞方案', text: '发现大面积废弃渔网后，应该如何制定安全打捞方案？' },
    { icon: Leaf, title: '环保治理建议', text: '塑料垃圾占比持续升高时，可以采取哪些治理措施？' },
  ];

  return <div className="assistant-layout"><aside className="assistant-context panel glass"><div className="aqua-avatar"><div><Waves /></div><span><i />在线</span></div><h2>AQUA</h2><p>海洋环境智能分析助手</p><div className="assistant-capabilities"><span>能力范围</span><ul><li><Sparkles />检测结果解读</li><li><FileText />质量报告分析</li><li><LifeBuoy />治理方案建议</li><li><Leaf />海洋环保知识</li></ul></div><div className="context-card"><small>当前项目</small><strong>渤海近岸监测</strong><span>已接入 28 个监测点</span></div><button className="secondary-button" onClick={() => { controller.current?.abort(); setMessages([]); }}><Trash2 />清空对话</button></aside><section className="chat-panel panel glass"><header><div><span className="assistant-icon"><Bot /></span><div><h1>海洋小助手</h1><p><i />领域模型与项目知识库已连接</p></div></div><span className="model-chip">Ocean-Qwen · RAG</span></header><div className="chat-messages">{messages.length === 0 && <div className="chat-empty"><Waves /><h2>开始一次新的海洋对话</h2><p>选择建议问题，或在下方输入你的问题。</p></div>}{messages.map((message) => <MessageBubble key={message.id} message={message} streaming={busy && message === messages[messages.length - 1]} />)}{error && <div className="chat-error">{error}<button onClick={() => void ask(lastQuestion)}>重新发送</button></div>}<div ref={bottomRef} /></div><div className="quick-prompts">{quickQuestions.map(({ icon: Icon, title, text }) => <button key={title} onClick={() => void ask(text)} disabled={busy}><Icon /><span><strong>{title}</strong><small>{text.slice(0, 20)}…</small></span></button>)}</div><form className="chat-composer" onSubmit={submit}><textarea aria-label="向海洋小助手提问" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(input); } }} placeholder="输入关于检测结果、污染分析或治理方案的问题…" rows={2} /><div><span>Enter 发送 · Shift + Enter 换行</span>{busy ? <button type="button" className="stop-button" onClick={stop}><CircleStop />停止生成</button> : <button type="submit" className="primary-button" disabled={!input.trim()}><Send />发送</button>}</div></form></section></div>;
}

function MessageBubble({ message, streaming }: { message: UiMessage; streaming: boolean }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(message.content, { async: false }) as string), [message.content]);
  return <article className={`chat-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <Waves /> : <UserRound />}</div><div><span>{message.role === 'assistant' ? 'AQUA 智能助手' : '林海'}</span><div className="message-content" dangerouslySetInnerHTML={{ __html: html }} />{streaming && <LoaderCircle className="spin streaming-cursor" />}</div></article>;
}
