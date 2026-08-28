import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpeciesStarterQuestion,
  buildContextualQuestion,
  clearAtlasChatHistory,
  createSpeciesStarterTracker,
  parseSseEvent,
  renderSafeMarkdown,
  streamAtlasChat,
} from '../src/frontend/public/haitong/assets/js/atlas-chat.mjs';

test('物种问答入口生成可直接发送的当前物种首问', () => {
  const question = buildSpeciesStarterQuestion({ cn: '小头鼠海豚' });

  assert.match(question, /小头鼠海豚/);
  assert.match(question, /生存现状/);
  assert.match(question, /主要威胁/);
  assert.match(question, /保护/);
  assert.match(question, /？$/);
});

test('清空问答会原地移除历史，避免旧上下文继续发给后端', () => {
  const history = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }];

  clearAtlasChatHistory(history);

  assert.deepEqual(history, []);
});

test('物种首问失败后可重试，成功后不重复，清空会重置所有物种', () => {
  const tracker = createSpeciesStarterTracker();

  assert.equal(tracker.begin('vaquita'), true);
  assert.equal(tracker.begin('vaquita'), false);
  tracker.fail('vaquita');
  assert.equal(tracker.begin('vaquita'), true);
  tracker.succeed('vaquita');
  assert.equal(tracker.begin('vaquita'), false);
  assert.equal(tracker.begin('blue-whale'), true);
  tracker.succeed('blue-whale');

  tracker.clear();

  assert.equal(tracker.begin('vaquita'), true);
  assert.equal(tracker.begin('blue-whale'), true);
});

test('安全 Markdown 转义脚本与事件属性，同时保留受支持标记', () => {
  const html = renderSafeMarkdown('**加粗** `<img>` [S1]\n<script>alert(1)</script><img src=x onerror=alert(2)>');

  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<code>&lt;img&gt;<\/code>/);
  assert.match(html, /<span class="source-badge">S1<\/span>/);
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('SSE 事件解析 content、delta、DONE 与后端错误', () => {
  assert.deepEqual(parseSseEvent('data: {"content":"海"}'), { done: false, content: '海' });
  assert.deepEqual(parseSseEvent('data: {"delta":{"content":"瞳"}}'), { done: false, content: '瞳' });
  assert.deepEqual(parseSseEvent('data: [DONE]'), { done: true, content: '' });
  assert.throws(() => parseSseEvent('data: {"error":"模型离线"}'), /模型离线/);
});

test('物种上下文只包装实际请求，不改变用户可见问题', () => {
  const result = buildContextualQuestion('它为什么濒危？', {
    cn: '小头鼠海豚',
    en: 'Vaquita',
    la: 'Phocoena sinus',
    iucn: 'CR',
    iucnTxt: '极危',
    story: '这是一段超过限制也必须被安全截断的简介。'.repeat(20),
  });

  assert.equal(result.display, '它为什么濒危？');
  assert.match(result.request, /^【当前浏览物种】小头鼠海豚 \/ Vaquita \/ Phocoena sinus｜IUCN：CR·极危｜简介：/);
  assert.match(result.request, /\n我的问题：它为什么濒危？$/);
  assert.ok(result.request.length < 260);
});

test('流式请求复刻平台契约并按 SSE 到达顺序输出', async () => {
  const calls = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content":"海"}\n\n'));
        controller.enqueue(encoder.encode('data: {"delta":{"content":"瞳"}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200 });
  };
  const chunks = [];

  await streamAtlasChat({
    messages: [{ role: 'user', content: '你好' }],
    sessionId: 'session-1',
    token: 'token-1',
    signal: new AbortController().signal,
    onChunk: chunk => chunks.push(chunk),
    fetchImpl,
    firstByteTimeoutMs: 100,
  });

  assert.deepEqual(chunks, ['海', '瞳']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/chat');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
    session_id: 'session-1',
  });
});

test('流式请求只有 DONE 而没有正文时按空回答失败，允许首问重试', async () => {
  const encoder = new TextEncoder();

  await assert.rejects(
    streamAtlasChat({
      messages: [{ role: 'user', content: '介绍当前物种' }],
      sessionId: 'session-empty',
      token: 'token-1',
      signal: new AbortController().signal,
      onChunk() {},
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { status: 200 }),
      firstByteTimeoutMs: 100,
    }),
    /未返回有效内容/,
  );
});

test('流式请求将非 200 响应转为带状态码的明确错误', async () => {
  await assert.rejects(
    streamAtlasChat({
      messages: [],
      sessionId: 'session-2',
      token: 'bad-token',
      signal: new AbortController().signal,
      onChunk() {},
      fetchImpl: async () => new Response('', { status: 401 }),
      firstByteTimeoutMs: 100,
    }),
    error => error?.status === 401 && /401/.test(error.message),
  );
});
