import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Model } from '@earendil-works/pi-ai/compat';
import { detectUpstream, resolveUpstream, upstreamCompat, isGatewayUpstream, GATEWAY_UPSTREAMS } from '../../src/shared/gateway-upstream.ts';

/**
 * A stand-in for a strict service such as NVIDIA NIM: it validates the request
 * body and answers an unknown field with HTTP 400 and no body at all, which is
 * what turns into "400 status code (no body)" once a relay drops the detail.
 */
function strictServer(allowed: string[]): Promise<{ server: Server; baseUrl: string; seen: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* an unparsable body is a rejection below */ }
      seen.push(body);
      const unsupported = Object.keys(body).filter(key => !allowed.includes(key));
      if (unsupported.length) { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: String(body.model ?? 'm'), choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      response.write(chunk({ role: 'assistant', content: 'OK' }, null));
      response.write(chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
      response.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen });
  }));
}

/** The fields NVIDIA NIM accepts on chat completions; everything else is a 400. */
const NVIDIA_ALLOWED = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'temperature', 'top_p', 'n', 'stop', 'tools', 'tool_choice', 'frequency_penalty', 'presence_penalty', 'seed'];
/** A generic strict service: modern OpenAI shape, but no OpenAI-proprietary caching or storage fields. */
const GENERIC_ALLOWED = [...NVIDIA_ALLOWED, 'max_completion_tokens', 'reasoning_effort'];

async function runRequest(baseUrl: string, compat: Record<string, unknown>) {
  const { streamSimple } = await import('@earendil-works/pi-ai/compat');
  const model: Model<any> = {
    id: 'test-model', name: 'test-model', provider: 'cardwright-upstream-test', api: 'openai-completions',
    baseUrl, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: compat as any,
  };
  // A real task always carries a session id; it is what the cache key is derived from.
  const stream = streamSimple(model, { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] }, { apiKey: 'test-only-key', maxTokens: 64, sessionId: 'cardwright-upstream-test-session' });
  for await (const event of stream) void event;
  return await stream.result();
}

test('an address names its upstream, and an explicit choice outranks the address', () => {
  assert.equal(detectUpstream('https://api.openai.com/v1'), 'openai');
  assert.equal(detectUpstream('https://integrate.api.nvidia.com/v1'), 'nvidia');
  assert.equal(detectUpstream('https://api.deepseek.com'), 'deepseek');
  assert.equal(detectUpstream('http://127.0.0.1:8080/v1'), undefined);
  assert.equal(detectUpstream(''), undefined);
  // A local relay in front of NVIDIA cannot be recognised, which is the whole bug.
  assert.equal(resolveUpstream({ baseUrl: 'http://127.0.0.1:8080/v1' }), 'generic');
  assert.equal(resolveUpstream({ baseUrl: 'http://127.0.0.1:8080/v1', upstream: 'nvidia' }), 'nvidia');
  assert.equal(resolveUpstream({ baseUrl: 'https://api.openai.com/v1', upstream: 'auto' }), 'openai');
  assert.ok(GATEWAY_UPSTREAMS.every(isGatewayUpstream));
  assert.equal(isGatewayUpstream('nonsense'), false);
});

test('only OpenAI keeps the fields that produced the 400; Anthropic Messages is untouched', () => {
  const openai = upstreamCompat({ baseUrl: 'https://api.openai.com/v1', protocol: 'openai-completions', modelId: 'gpt-x' });
  assert.equal(openai.supportsLongCacheRetention, true);
  assert.equal(openai.supportsStore, true);
  assert.equal(openai.supportsDeveloperRole, true);

  const relay = upstreamCompat({ baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai-completions', modelId: 'any' });
  assert.equal(relay.supportsLongCacheRetention, false, 'an unrecognised address must not receive prompt_cache_key');
  assert.equal(relay.supportsStore, false);
  assert.equal(relay.supportsDeveloperRole, false);

  const nvidia = upstreamCompat({ baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai-completions', modelId: 'any', upstream: 'nvidia' });
  assert.equal(nvidia.supportsLongCacheRetention, false);
  assert.equal(nvidia.supportsReasoningEffort, false);
  assert.equal(nvidia.maxTokensField, 'max_tokens');
  assert.equal(nvidia.supportsStrictMode, false);

  // OpenRouter passes the developer role through only for the vendors that take it.
  assert.equal(upstreamCompat({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions', modelId: 'meta/llama' }).supportsDeveloperRole, false);
  assert.equal(upstreamCompat({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions', modelId: 'openai/gpt-x' }).supportsDeveloperRole, true);
  assert.equal(upstreamCompat({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions', modelId: 'anthropic/claude-x' }).cacheControlFormat, 'anthropic');

  assert.deepEqual(upstreamCompat({ baseUrl: 'https://any.example/v1', protocol: 'anthropic-messages', modelId: 'claude-x' }), {});
});

test('a relayed NVIDIA service answers 400 with no body under the old settings and succeeds once its upstream is named', async () => {
  const { server, baseUrl, seen } = await strictServer(NVIDIA_ALLOWED);
  // The cache optimizer asks for long retention process-wide; that is what pulls prompt_cache_key in.
  const saved = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = 'long';
  try {
    // Before: permissive defaults for an address the runtime cannot place.
    const broken = await runRequest(baseUrl, { supportsLongCacheRetention: true, supportsStore: true });
    assert.equal(broken.stopReason, 'error');
    assert.match(String(broken.errorMessage), /400/);
    assert.ok(Object.prototype.hasOwnProperty.call(seen[0], 'prompt_cache_key'), 'the old path sent prompt_cache_key');

    // After: the gateway names NVIDIA NIM behind the relay.
    const fixed = await runRequest(baseUrl, upstreamCompat({ baseUrl, protocol: 'openai-completions', modelId: 'test-model', upstream: 'nvidia' }) as Record<string, unknown>);
    assert.equal(fixed.stopReason, 'stop');
    const sent = seen[seen.length - 1];
    for (const field of ['prompt_cache_key', 'prompt_cache_retention', 'store', 'reasoning_effort', 'max_completion_tokens']) {
      assert.equal(Object.prototype.hasOwnProperty.call(sent, field), false, `${field} must not be sent to NVIDIA`);
    }
    assert.equal(sent.max_tokens, 64);
  } finally {
    if (saved === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = saved;
    server.close();
  }
});

test('an unrecognised address falls back to fields a strict compatible service accepts', async () => {
  const { server, baseUrl, seen } = await strictServer(GENERIC_ALLOWED);
  const saved = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = 'long';
  try {
    const result = await runRequest(baseUrl, upstreamCompat({ baseUrl, protocol: 'openai-completions', modelId: 'test-model' }) as Record<string, unknown>);
    assert.equal(result.stopReason, 'stop');
    const sent = seen[seen.length - 1];
    for (const field of ['prompt_cache_key', 'prompt_cache_retention', 'store']) {
      assert.equal(Object.prototype.hasOwnProperty.call(sent, field), false, `${field} must not be sent to an unrecognised address`);
    }
  } finally {
    if (saved === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = saved;
    server.close();
  }
});
