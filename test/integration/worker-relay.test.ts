import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntime } from '../../src/runtime/worker.ts';
import type { FromWorker, Gateway, WorkerInit } from '../../src/shared/types.ts';

/** One streamed reply, the way an OpenAI-compatible relay sends it. */
function reply(response: ServerResponse, text = 'Finished.') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'relay-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' }); chunk({ content: text }); chunk({}, 'stop');
  response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'relay-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/**
 * A relay in front of the model: `answer` decides what the n-th request gets. The worker runs in this process and
 * the test plays the desktop process: it grants every rate slot at once and records what the worker reports.
 */
async function relay(answer: (call: number, response: ServerResponse) => void, gateway: Partial<Gateway> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-relay-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  let calls = 0;
  const server = createServer(async (request, response) => { for await (const chunk of request) void chunk; answer(calls++, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const messages: FromWorker[] = [];
  const asked: Array<{ method: string; args: Record<string, unknown> }> = [];
  const worker = new WorkerRuntime(message => {
    messages.push(message);
    if (message.type !== 'request' || (message.method !== 'rate-slot' && message.method !== 'rate-cooldown')) return;
    asked.push({ method: message.method, args: message.args });
    queueMicrotask(() => void worker.handle({ type: 'response', id: message.id, result: true }));
  });
  const init: WorkerInit = {
    type: 'init', taskId: 'relay-task', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), rateSlots: true,
    gateway: { id: 'relay', name: 'Relay', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'relay-model', protocol: 'openai-completions', reasoning: false, contextWindow: 32000, maxTokens: 1024, hasKey: true, retry: { maxRetries: 1 }, ...gateway },
    apiKey: 'relay-test-key', thinking: 'off', permission: 'ask', instructions: '', skillPaths: [], canDelegate: false,
  };
  return {
    worker, init, messages, asked, calls: () => calls,
    events: (type: string) => messages.flatMap(message => message.type === 'event' && message.event.type === type ? [message.event] : []),
    errors: () => messages.filter(message => message.type === 'error'),
    async cleanup() { await worker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}

test('a 429 from the relay reaches the gateway cooldown with the wait the service asked for', { timeout: 30000 }, async () => {
  const f = await relay((call, response) => {
    if (call === 0) { response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }); response.end(JSON.stringify({ error: { message: 'Too many requests', type: 'rate_limit' } })); return; }
    reply(response);
  });
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Say hello', messageId: 'user-1' });
    assert.deepEqual(f.asked.filter(item => item.method === 'rate-cooldown').map(item => item.args.seconds), [7], 'the SDK threw on the 429 before any response hook; the fetch layer saw it');
    assert.ok(f.events('workflow_notice').some(event => /429/.test(String(event.message)) && /7 秒/.test(String(event.message))));
    assert.equal(f.asked.filter(item => item.method === 'rate-slot').length, 2, 'the first request and the retry each asked for a slot');
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.errors(), []);
  } finally { await f.cleanup(); }
});

test('a relay’s own wording for a temporary failure is retried like the ones pi knows', { timeout: 30000 }, async () => {
  const f = await relay((call, response) => {
    if (call === 0) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ error: { message: '上游服务繁忙，请稍后重试', type: 'upstream_error' } })}\n\n`); return; }
    reply(response);
  });
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Say hello', messageId: 'user-1' });
    assert.equal(f.calls(), 2, 'one retry after the relay said it was busy');
    const retry = f.events('auto_retry_start')[0];
    assert.ok(retry, JSON.stringify(f.messages.map(message => message.type === 'event' ? message.event.type : message.type)));
    assert.match(String(retry.errorMessage), /上游服务繁忙/);
    assert.deepEqual(f.errors(), []);
  } finally { await f.cleanup(); }
});

// The desktop process only saves 15–300 seconds; the worker takes what it is given, so the test uses a fraction of one.
test('无响应断开 cuts off a relay that goes silent mid-reply, and pi retries it', { timeout: 30000 }, async () => {
  const f = await relay((call, response) => {
    if (call === 0) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'relay-model', choices: [{ index: 0, delta: { role: 'assistant', content: '写到一半' }, finish_reason: null }] })}\n\n`);
      return; // and then nothing, ever
    }
    reply(response);
  }, { stall: { seconds: 0.3 } });
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Say hello', messageId: 'user-1' });
    assert.equal(f.calls(), 2);
    assert.match(String(f.events('auto_retry_start')[0]?.errorMessage), /无响应断开/);
    assert.deepEqual(f.errors(), []);
  } finally { await f.cleanup(); }
});
