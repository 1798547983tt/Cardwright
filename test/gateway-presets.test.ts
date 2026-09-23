import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as presets from '../src/shared/gateway-presets.ts';
import { Harness } from '../src/main/harness.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
const codec: SecretCodec = { encrypt: value => Buffer.from(`fixture-codec:${value}`), decrypt: value => value.toString().slice('fixture-codec:'.length) };

test('two gateway presets, both the user’s own services on this computer: local models and a local proxy', () => {
  assert.deepEqual(presets.GATEWAY_PRESETS.map(preset => [preset.id, preset.protocol, preset.keyOptional]), [['local-model', 'openai-completions', true], ['local-proxy', 'openai-completions', false]]);
  assert.deepEqual(presets.GATEWAY_PRESETS[0].addresses.map(item => [item.label, item.url]), [['Ollama', 'http://127.0.0.1:11434/v1'], ['llama.cpp', 'http://127.0.0.1:8080/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']]);
  assert.deepEqual(presets.GATEWAY_PRESETS[1].addresses.map(item => item.url), ['http://127.0.0.1:8317/v1']);
  for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:8080', 'http://[::1]:1234/v1']) assert.equal(presets.isLoopback(url), true, url);
  for (const url of ['https://api.example.com/v1', 'http://192.168.1.2:11434/v1', 'http://127.0.0.1.example.com/v1', 'not a url']) assert.equal(presets.isLoopback(url), false, url);
});

async function fake(handler: (request: IncomingMessage, body: string) => { status: number; json: unknown }) {
  const seen: Array<{ method: string; url: string; body: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: request.method ?? '', url: request.url ?? '', body, authorization: request.headers.authorization });
    const result = handler(request, body);
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result.json));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}/v1`, seen, close: () => new Promise<void>(done => server.close(() => done())) };
}

test('the self-test lists the models, then sends one completion of a single token, and reports each step', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-selftest-'));
  const harness = new Harness(join(root, 'data'), fakeWorker, new Vault(join(root, 'data'), codec));
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  const server = await fake((request, body) => request.method === 'GET'
    ? { status: 200, json: { data: [{ id: 'qwen3:8b' }, { id: 'llama3.2' }] } }
    : { status: 200, json: { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: JSON.parse(body).max_tokens === 1 ? '好' : 'too long' }, finish_reason: 'length' }] } });
  t.after(server.close);
  const passed = await harness.selfTestGateway({ baseUrl: server.base, protocol: 'openai-completions', modelId: 'qwen3:8b' }, 'local');
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.steps.map(step => [step.step, step.ok]), [['models', true], ['completion', true]]);
  assert.match(passed.steps[0].detail, /2/);
  const completion = JSON.parse(server.seen.find(item => item.method === 'POST')!.body);
  assert.deepEqual([completion.model, completion.max_tokens, completion.stream], ['qwen3:8b', 1, false], 'one token, not streamed');
  assert.equal(server.seen.find(item => item.method === 'POST')!.url, '/v1/chat/completions');
  assert.equal(server.seen[0].authorization, 'Bearer local');

  const broken = await fake(() => ({ status: 401, json: { error: { message: 'invalid key sk-should-not-echo' } } }));
  t.after(broken.close);
  const failed = await harness.selfTestGateway({ baseUrl: broken.base, protocol: 'openai-completions', modelId: 'm' }, 'sk-should-not-echo');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.steps.map(step => [step.step, step.ok]), [['models', false], ['completion', false]], 'the completion is still tried, so both answers show');
  assert.match(failed.steps[1].detail, /401/);
  assert.ok(failed.steps.every(step => !step.detail.includes('sk-should-not-echo')), 'the key never comes back in a message');
  await assert.rejects(harness.selfTestGateway({ baseUrl: 'file:///etc/passwd', protocol: 'openai-completions', modelId: 'm' }), /http/i);
});
