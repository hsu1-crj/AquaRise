export class AtlasChatError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'AtlasChatError';
    this.status = status;
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderSafeMarkdown(value) {
  const code = [];
  let safe = escapeHtml(value).replace(/`([^`\n]+)`/g, (_, text) => {
    code.push(`<code>${text}</code>`);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  safe = safe
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[S(\d+)\]/g, '<span class="source-badge">S$1</span>')
    .split(/\n{2,}/)
    .map(block => `<p>${block.replaceAll('\n', '<br>')}</p>`)
    .join('');
  return safe.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)] ?? '');
}

export function parseSseEvent(block) {
  const payload = String(block ?? '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n');
  if (!payload) return { done: false, content: '' };
  if (payload === '[DONE]') return { done: true, content: '' };
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.error) throw new AtlasChatError(String(parsed.error));
    return { done: false, content: parsed?.content ?? parsed?.delta?.content ?? '' };
  } catch (error) {
    if (error instanceof AtlasChatError) throw error;
    return { done: false, content: payload };
  }
}

export function buildContextualQuestion(question, species) {
  const display = String(question ?? '').trim();
  const story = String(species?.story ?? '').trim().slice(0, 120);
  const prefix = `【当前浏览物种】${species?.cn ?? ''} / ${species?.en ?? ''} / ${species?.la ?? ''}`
    + `｜IUCN：${species?.iucn ?? ''}·${species?.iucnTxt ?? ''}｜简介：${story}`;
  return { display, request: `${prefix}\n我的问题：${display}` };
}

export function buildSpeciesStarterQuestion(species) {
  const name = String(species?.cn ?? '').trim() || '这个物种';
  return `请介绍${name}目前的生存现状、主要威胁，以及普通人可以参与的保护行动？`;
}

export function clearAtlasChatHistory(history) {
  if (Array.isArray(history)) history.length = 0;
}

export function createSpeciesStarterTracker() {
  const asked = new Set();
  const inFlight = new Set();
  return {
    begin(key) {
      if (!key || asked.has(key) || inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    succeed(key) {
      if (!key) return;
      inFlight.delete(key);
      asked.add(key);
    },
    fail(key) {
      if (key) inFlight.delete(key);
    },
    clear() {
      asked.clear();
      inFlight.clear();
    },
  };
}

export async function streamAtlasChat({
  messages,
  sessionId,
  token,
  signal,
  onChunk,
  fetchImpl = fetch,
  firstByteTimeoutMs = 15000,
}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AtlasChatError('等待 AI 助手响应超时'));
    }, firstByteTimeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl('/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages, stream: true, session_id: sessionId }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!response?.ok || !response.body) {
      throw new AtlasChatError(`对话服务不可用（${response?.status ?? 0}）`, response?.status ?? 0);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedContent = false;
    while (true) {
      const result = receivedContent ? await reader.read() : await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const parsed = parseSseEvent(event);
        if (parsed.done) return;
        if (!parsed.content) continue;
        if (!receivedContent) {
          receivedContent = true;
          clearTimeout(timer);
        }
        onChunk(parsed.content);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseEvent(buffer);
      if (parsed.content) onChunk(parsed.content);
    }
    if (!receivedContent) throw new AtlasChatError('AI 助手未返回有效内容');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
