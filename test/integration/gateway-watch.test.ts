import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';
import { watchedFetch } from '../../src/runtime/gateway-watch.ts';
import { withNetworkPolicy } from '../../src/runtime/network-broker.ts';

async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('a 429 from the gateway is reported with the wait it asked for, and the SDK still gets the response', async () => {
  const relay = await endpoint((request, response) => {
    if (request.url === '/limited') { response.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }).end('{"error":{"message":"Too many requests"}}'); return; }
    if (request.url === '/bare') { response.writeHead(429).end(); return; }
    response.end('ok');
  });
  const elsewhere = await endpoint((_request, response) => response.writeHead(429, { 'retry-after': '9' }).end());
  try {
    const seen: Array<number | undefined> = [];
    const watched = watchedFetch(fetch, { origins: [relay.url], onRateLimited: seconds => seen.push(seconds) });
    const limited = await watched(`${relay.url}/limited`);
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /Too many requests/, 'the SDK still reads the body and raises its own error');
    await (await watched(`${relay.url}/bare`)).arrayBuffer();
    assert.equal(await (await watched(`${relay.url}/fine`)).text(), 'ok');
    await (await watched(`${elsewhere.url}/search`)).arrayBuffer();
    assert.deepEqual(seen, [7, undefined], 'only the gateway’s own 429s count; one without Retry-After reports no wait');
  } finally { await relay.close(); await elsewhere.close(); }
});

test('the network broker hands a task’s gateway requests to its watch', async () => {
  const server = await endpoint((_request, response) => response.writeHead(429, { 'retry-after': '3' }).end());
  try {
    const seen: Array<number | undefined> = [];
    const response = await withNetworkPolicy({ origins: () => [server.url], approve: async () => false, watch: () => ({ origins: [server.url], onRateLimited: seconds => seen.push(seconds) }) }, () => fetch(server.url));
    assert.equal(response.status, 429);
    await response.arrayBuffer();
    assert.deepEqual(seen, [3]);
  } finally { await server.close(); }
});

test('with nothing to watch, the fetch underneath is used as it is', async () => {
  const marker = new Response('marker');
  const native = (async () => marker) as typeof fetch;
  assert.equal(await watchedFetch(native, { origins: ['http://127.0.0.1:9'] })('http://127.0.0.1:9/v1/chat/completions'), marker);
  assert.equal(await watchedFetch(native, { origins: ['http://127.0.0.1:9'], onRateLimited: () => undefined })('http://127.0.0.1:8/v1/chat/completions'), marker, 'another address');
});

const failed = (errorMessage: string): AssistantMessage => ({
  role: 'assistant', content: [], api: 'openai-completions', provider: 'relay', model: 'relay-model',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'error', errorMessage, timestamp: 0,
});

/** Starts a streamed reply, sends one piece, then says nothing more. */
const silentAfterFirst: RequestListener = (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: first\n\n');
};

test('无响应断开 cuts off a reply that goes silent, with an error pi retries', { timeout: 10000 }, async () => {
  const server = await endpoint(silentAfterFirst);
  try {
    const response = await watchedFetch(fetch, { origins: [server.url], stallMs: 200 })(server.url);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    const started = Date.now();
    const error = await reader.read().then(() => undefined, (reason: unknown) => reason as Error);
    assert.ok(error, 'the silent stream must fail, not hang');
    assert.ok(Date.now() - started < 2_000);
    assert.match(error.message, /无响应断开/);
    assert.equal(isRetryableAssistantError(failed(error.message)), true, 'pi retries it');
  } finally { await server.close(); }
});

test('无响应断开 also covers a relay that never starts its response', { timeout: 10000 }, async () => {
  const server = await endpoint(() => { /* takes the request and says nothing */ });
  try {
    const started = Date.now();
    await assert.rejects(watchedFetch(fetch, { origins: [server.url], stallMs: 200 })(server.url), /无响应断开/);
    assert.ok(Date.now() - started < 2_000);
  } finally { await server.close(); }
});

test('a reply that keeps streaming is never cut off, however long it runs', { timeout: 10000 }, async () => {
  const server = await endpoint((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => { response.write(`data: ${sent}\n\n`); if (++sent === 8) { clearInterval(timer); response.end(); } }, 60);
  });
  try {
    const text = await (await watchedFetch(fetch, { origins: [server.url], stallMs: 200 })(server.url)).text();
    assert.equal((text.match(/data:/g) ?? []).length, 8, 'half a second of data, never more than 200 ms apart');
  } finally { await server.close(); }
});

test('the caller can still stop a watched stream after a garbage collection', { timeout: 10000 }, async () => {
  // As in runtime-network.test.ts: an abort must reach the stream even once undici's weakly linked signals are collected.
  v8.setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const server = await endpoint(silentAfterFirst);
  try {
    const controller = new AbortController();
    const response = await watchedFetch(fetch, { origins: [server.url], stallMs: 60_000 })(server.url, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    for (let round = 0; round < 3; round++) { gc(); await new Promise(resolve => setTimeout(resolve, 20)); }
    controller.abort();
    const outcome = await Promise.race([reader.read().then(() => 'still streaming', () => 'stopped'), new Promise(resolve => setTimeout(resolve, 2000, 'still streaming'))]);
    assert.equal(outcome, 'stopped');
  } finally { await server.close(); }
});
