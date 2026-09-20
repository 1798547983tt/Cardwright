import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { brokeredFetch, withNetworkPolicy } from '../src/runtime/network-broker.ts';

async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('network broker requires each new redirect origin and removes cross-origin credentials', async () => {
  let requests = 0; let authorization: string | undefined; let apiKey: string | undefined;
  const target = await endpoint((request, response) => { requests++; authorization = request.headers.authorization; apiKey = String(request.headers['x-custom-token'] ?? ''); response.end('ok'); });
  const start = await endpoint((_request, response) => response.writeHead(302, { location: target.url + '/destination?not-for-dialog=1' }).end());
  try {
    const decisions: Array<{ url: string; method: string }> = [];
    const policy = { origins: () => [start.url], approve: async (args: { url: string; method: string }) => { decisions.push(args); return false; } };
    await assert.rejects(brokeredFetch(fetch, policy, start.url, { headers: { authorization: 'fixture-secret', 'x-custom-token': 'fixture-token' } }), /denied/);
    assert.equal(requests, 0);
    assert.deepEqual(decisions, [{ url: target.url + '/destination', method: 'GET' }]);
    const response = await brokeredFetch(fetch, { ...policy, approve: async () => true }, start.url, { headers: { authorization: 'fixture-secret', 'x-custom-token': 'fixture-token' } });
    assert.equal(await response.text(), 'ok'); assert.equal(authorization, undefined); assert.equal(apiKey, '');
    await assert.rejects(brokeredFetch(fetch, policy, start.url, { redirect: 'error' }), /forbids redirects/);
    assert.equal(requests, 1);
  } finally { await start.close(); await target.close(); }
});

test('network broker preserves same-origin POST retry bodies and abort prevents egress', async () => {
  let body = ''; let requests = 0;
  const server = await endpoint(async (request, response) => {
    requests++;
    if (request.url === '/first') { response.writeHead(307, { location: '/second' }).end(); return; }
    for await (const chunk of request) body += chunk; response.end('done');
  });
  try {
    const policy = { origins: () => [server.url], approve: async () => false };
    const result = await brokeredFetch(fetch, policy, server.url + '/first', { method: 'POST', body: 'unchanged body' });
    assert.equal(await result.text(), 'done'); assert.equal(body, 'unchanged body');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(brokeredFetch(fetch, policy, server.url, { signal: controller.signal }));
    assert.equal(requests, 2);
  } finally { await server.close(); }
});

test('concurrent worker policies remain isolated in async scopes', async () => {
  const server = await endpoint((_request, response) => response.end('isolated'));
  try {
    const native = fetch;
    const [allowed, denied] = await Promise.allSettled([
      withNetworkPolicy({ origins: () => [server.url], approve: async () => false }, () => fetch(server.url)),
      withNetworkPolicy({ origins: () => [], approve: async () => false }, () => fetch(server.url)),
    ]);
    assert.equal(allowed.status, 'fulfilled'); assert.equal(denied.status, 'rejected');
    if (allowed.status === 'fulfilled') assert.equal(await allowed.value.text(), 'isolated');
    assert.equal(await (await native(server.url)).text(), 'isolated');
  } finally { await server.close(); }
});
