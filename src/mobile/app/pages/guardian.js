import { api } from '../api.js';
import { el, clear, icon, toast, emptyState } from '../ui.js';

export function renderGuardian(container, ctx) {
  const { state } = ctx;
  const sessionId = sessionStorage.getItem('haitong-chat-session')
    || crypto.randomUUID?.()
    || `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem('haitong-chat-session', sessionId);
  let messages = [];
  let controller = null;
  let mounted = true;
  const context = state.guardianContext;
  state.guardianContext = null;

  const page = el('div', { className: 'guardian-page' });
  const contextBar = el('div', { className: 'guardian-context', style: { display: context ? '' : 'none' } }, context ? [
    icon(context.type === 'report' ? 'fileChart' : 'target', 16),
    el('span', { textContent: context.type === 'report' ? `正在基于报告：${context.label || `RPT-${context.id}`}` : `已引用任务：${context.label || `DET-${context.id}`}` }),
    el('button', { className: 'icon-btn', 'aria-label': '移除上下文', onClick: () => { contextBar.style.display = 'none'; } }, [icon('x', 15)]),
  ] : []);
  const messageList = el('div', { className: 'chat-messages', 'aria-live': 'polite' });
  const quicks = el('div', { className: 'quick-prompts' });
  for (const question of ['当前污染风险如何判断？', '给出三条现场处置建议', '塑料垃圾应如何溯源？']) {
    quicks.append(el('button', { onClick: () => { input.value = question; send(); } }, [question]));
  }
  const input = el('textarea', { rows: 1, placeholder: '询问海洋污染、识别结果或治理建议', 'aria-label': '发送给海洋守护者的消息' });
  const sendBtn = el('button', { className: 'chat-send', 'aria-label': '发送消息' }, [icon('upload', 19)]);
  const composer = el('div', { className: 'chat-composer' }, [input, sendBtn]);
  page.append(contextBar, el('div', { className: 'guardian-intro' }, [
    el('div', { className: 'guardian-orb' }, [icon('waves', 25)]),
    el('div', {}, [el('strong', { textContent: '海洋守护者' }), el('small', { textContent: '文本模式 · 资源按需加载' })]),
  ]), messageList, quicks, composer);
  container.append(page);

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  loadHistory();

  async function loadHistory() {
    messageList.append(el('div', { className: 'chat-loading' }, [el('span', { className: 'spinner-mini' }), '恢复最近会话…']));
    try {
      const history = await api.getChatHistory(sessionId);
      if (!mounted) return;
      messages = (history || []).slice(-30).map((item) => ({ role: item.role, content: item.content }));
    } catch {
      messages = [];
    }
    renderMessages();
  }

  function renderMessages() {
    clear(messageList);
    if (!messages.length) {
      messageList.append(emptyState('message', '随时向我提问', '可询问污染判断、治理建议，也可从报告中心带入报告上下文'));
      return;
    }
    for (const message of messages) messageList.append(messageBubble(message));
    scrollToBottom();
  }

  function messageBubble(message) {
    const bubble = el('article', { className: `chat-bubble ${message.role}` }, [
      el('div', { className: 'chat-role', textContent: message.role === 'user' ? '你' : '守护者' }),
      el('p', { textContent: message.content }),
    ]);
    if (message.role === 'assistant' && message.content) {
      bubble.append(el('button', {
        className: 'chat-copy',
        'aria-label': '复制回答',
        onClick: async () => {
          await navigator.clipboard.writeText(message.content);
          toast('回答已复制', 'success');
        },
      }, [icon('copy', 14), '复制']));
    }
    return bubble;
  }

  async function send() {
    const content = input.value.trim();
    if (!content || controller) return;
    input.value = '';
    const taskContext = context?.type === 'task' && contextBar.style.display !== 'none'
      ? `关于任务 DET-${context.id}（${context.summary || '移动端识别任务'}）：${content}`
      : content;
    messages.push({ role: 'user', content: taskContext });
    const assistant = { role: 'assistant', content: '' };
    messages.push(assistant);
    renderMessages();
    const assistantBubble = messageList.lastElementChild;
    const answer = assistantBubble.querySelector('p');
    answer.replaceChildren(el('span', { className: 'typing-dots', textContent: '正在思考…' }));

    controller = new AbortController();
    sendBtn.replaceChildren(icon('stop', 18));
    sendBtn.setAttribute('aria-label', '停止生成');
    sendBtn.onclick = () => controller?.abort();
    quicks.style.display = 'none';

    try {
      const reportId = context?.type === 'report' && contextBar.style.display !== 'none' ? context.id : null;
      await api.streamChat(messages.slice(0, -1), {
        sessionId,
        reportId,
        signal: controller.signal,
        onChunk(chunk) {
          assistant.content += chunk;
          answer.textContent = assistant.content;
          scrollToBottom();
        },
      });
      if (!assistant.content) assistant.content = '本次没有生成有效回答，请稍后重试。';
      renderMessages();
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (!assistant.content) messages.pop();
        toast('已停止生成', 'info');
      } else {
        if (!assistant.content) assistant.content = `回答失败：${error.message || '服务暂不可用'}`;
        renderMessages();
      }
    } finally {
      controller = null;
      sendBtn.replaceChildren(icon('upload', 19));
      sendBtn.setAttribute('aria-label', '发送消息');
      sendBtn.onclick = null;
      quicks.style.display = '';
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => messageList.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  }

  return {
    unmount() {
      mounted = false;
      controller?.abort();
    },
    onHide() {
      // 文本流继续；切离路由时 unmount 会终止，符合移动端会话策略。
    },
  };
}
