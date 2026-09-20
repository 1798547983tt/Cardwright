import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import type { FromWorker, WorkerInit } from '../src/shared/types.ts';

/** Mirrors the captured DeepSeek failure: reasoning only, finish_reason "length", output equal to max_tokens. */
function reasoningOnly(response: ServerResponse, outputTokens: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' });
  chunk({ reasoning_content: 'Computing wheel geometry step by step...' });
  chunk({}, 'length');
  response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 50, completion_tokens: outputTokens, total_tokens: 50 + outputTokens } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function fixture(maxTokens: number) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-trunc-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls++;
    reasoningOnly(response, maxTokens);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const messages: FromWorker[] = [];
  const worker = new WorkerRuntime(message => messages.push(message));
  const init: WorkerInit = {
    type: 'init', taskId: 'trunc-task', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
    gateway: { id: 'test', name: 'Test', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'test-model', protocol: 'openai-completions', reasoning: true, contextWindow: 32000, maxTokens, hasKey: true },
    apiKey: 'cardwright-test-secret', thinking: 'high', permission: 'ask', instructions: '', skillPaths: [], canDelegate: false,
  };
  return {
    worker, init, messages, calls: () => calls,
    async cleanup() { await worker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}

test('a response that spends the whole output limit on reasoning is reported as truncated, never as a silent completion', { timeout: 30000 }, async () => {
  const f = await fixture(2000);
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Create pelican.html' });
    const truncated = f.messages.find(message => message.type === 'event' && message.event.type === 'output_truncated');
    assert.ok(truncated && truncated.type === 'event', JSON.stringify(f.messages.map(message => message.type === 'event' ? message.event.type : message.type)));
    assert.equal(truncated.event.outputTokens, 2000);
    assert.equal(truncated.event.maxTokens, 2000);
    assert.equal(truncated.event.model, 'test-model');
    const errorIndex = f.messages.findIndex(message => message.type === 'error');
    const doneIndex = f.messages.findIndex(message => message.type === 'done');
    assert.ok(errorIndex >= 0 && doneIndex > errorIndex, 'truncation must fail the run before done');
    assert.equal(f.calls(), 1, 'no automatic resend');
    assert.equal(JSON.stringify(f.messages).includes('cardwright-test-secret'), false);
  } finally { await f.cleanup(); }
});
