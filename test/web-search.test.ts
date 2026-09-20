import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { decidePermission } from '../src/runtime/permissions.ts';
import { searchConfigurationError, searchWeb } from '../src/runtime/web-search.ts';
import type { SearchConfig } from '../src/shared/types.ts';

const brave: SearchConfig = { enabled: true, provider: 'brave', baseUrl: 'https://ignored.invalid/', hasKey: true };
const fixtureKey = 'search-fixture-secret';

async function localSearch(handler: (url: URL, response: ServerResponse, headers: Record<string, unknown>) => void) {
  const server = createServer((request, response) => handler(new URL(request.url ?? '/', 'http://localhost'), response, request.headers));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing search fixture address');
  return {
    config: { enabled: true, provider: 'searxng', baseUrl: `http://127.0.0.1:${address.port}/instance/`, hasKey: false } as SearchConfig,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('Brave uses the fixed official endpoint, bounded parameters and dedicated auth', async context => {
  context.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(input.origin + input.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(input.searchParams.get('q'), 'agent docs 中文');
    assert.equal(input.searchParams.get('count'), '3');
    assert.equal(new Headers(options.headers).get('x-subscription-token'), fixtureKey);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return Response.json({ web: { results: [{ title: '<b>Pi &amp; Agents</b>', url: 'https://example.com/pi', description: '<script>bad()</script> Read <strong>documentation</strong> &lt;i&gt;now&lt;/i&gt;', age: '2 days ago' }] } });
  });
  const result = await searchWeb(brave, '  agent docs 中文  ', 3, fixtureKey);
  assert.equal(result.provider, 'brave');
  assert.equal(result.query, 'agent docs 中文');
  assert.deepEqual(result.results, [{ title: 'Pi & Agents', url: 'https://example.com/pi', snippet: 'Read documentation now', age: '2 days ago' }]);
  assert.ok(Number.isFinite(Date.parse(result.searchedAt)));
});

test('SearXNG uses the configured local instance path and JSON protocol without a Brave key', async () => {
  const server = await localSearch((url, response, headers) => {
    assert.equal(url.pathname, '/instance/search');
    assert.equal(url.searchParams.get('q'), 'official docs');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(headers['x-subscription-token'], undefined);
    assert.equal(headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com/source', content: 'Primary source' }] }));
  });
  try {
    const result = await searchWeb(server.config, 'official docs', 1, fixtureKey);
    assert.deepEqual(result.results, [{ title: 'Result', url: 'https://example.com/source', snippet: 'Primary source' }]);
  } finally { await server.close(); }
});

test('unsafe and duplicate source URLs are omitted and successful result count stays bounded', async context => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ web: { results: [
    { title: 'script', url: 'javascript:alert(1)' },
    { title: 'file', url: 'file:///c:/secret' },
    { title: 'credentials', url: 'https://user:pass@example.com/' },
    { title: 'newline', url: 'https://example.com/\nattack' },
    { title: 'first', url: 'https://example.com/1', description: 'a'.repeat(5000) },
    { title: 'duplicate', url: 'https://example.com/1' },
    { title: 'second', url: 'http://example.com/2' },
    { title: 'third', url: 'https://example.com/3' },
  ] } }));
  const result = await searchWeb(brave, 'source', 2, fixtureKey);
  assert.deepEqual(result.results.map(item => item.title), ['first', 'second']);
  assert.equal(result.results[0]?.snippet.length, 2500);
});

test('disabled or invalid config and invalid model arguments never send HTTP requests', async context => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Should not fetch'); });
  for (const config of [
    { ...brave, enabled: false }, { ...brave, hasKey: false },
    { ...brave, provider: 'searxng' as const, baseUrl: '' },
    { ...brave, provider: 'searxng' as const, baseUrl: 'file:///tmp/' },
    { ...brave, provider: 'searxng' as const, baseUrl: 'https://user:pass@example.com' },
    { ...brave, provider: 'searxng' as const, baseUrl: 'https://example.com?token=value' },
  ]) await assert.rejects(searchWeb(config, 'query', 5, fixtureKey));
  await assert.rejects(searchWeb(brave, 'query', 5, ''), /API key/);
  for (const query of ['', ' ', 'q'.repeat(501), 'contains\0null']) await assert.rejects(searchWeb(brave, query, 5, fixtureKey), /query/);
  for (const count of [0, 9, 1.5, NaN]) await assert.rejects(searchWeb(brave, 'query', count, fixtureKey), /count/);
  assert.equal(mocked.mock.callCount(), 0);
  assert.match(searchConfigurationError(undefined) ?? '', /disabled/);
});

test('empty search results are genuine successful empty results, not fabricated references', async context => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => Response.json({ web: { results: [] } }));
  assert.deepEqual((await searchWeb(brave, 'no result', 5, fixtureKey)).results, []);
  mocked.mock.mockImplementation(async () => Response.json({ query: { original: 'no result' } }));
  assert.deepEqual((await searchWeb(brave, 'no result', 5, fixtureKey)).results, []);
});

test('HTTP errors are actionable and do not echo remote error bodies or secrets', async context => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => new Response(''));
  for (const [status, message] of [[401, /authentication/], [403, /JSON/], [429, /rate limit/], [500, /HTTP 500/]] as const) {
    mocked.mock.mockImplementation(async () => new Response(`secret: ${fixtureKey}`, { status }));
    await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /search-fixture-secret/);
      return true;
    });
  }
  mocked.mock.mockImplementation(async () => { throw new Error(`transport includes ${fixtureKey}`); });
  await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey), error => error instanceof Error && /Could not reach/.test(error.message) && !error.message.includes(fixtureKey));
});

test('reflected search credentials are removed from successful text and source URLs', async context => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ web: { results: [
    { title: fixtureKey, url: `https://example.com/?secret=${fixtureKey}`, description: 'credential-bearing link' },
    { title: `Echo ${fixtureKey}`, url: 'https://example.com/safe', description: fixtureKey, age: fixtureKey },
  ] } }));
  const result = await searchWeb(brave, `accidental ${fixtureKey}`, 5, fixtureKey);
  assert.doesNotMatch(JSON.stringify(result), /search-fixture-secret/);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.title, 'Echo [redacted]');
});

test('malformed JSON, wrong schema and excessive streaming bodies fail explicitly', async context => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => new Response(''));
  for (const body of ['<html>not json</html>', 'null', '{}', '{"web":{"results":{}}}', '{"web":{"results":[null]}}']) {
    mocked.mock.mockImplementation(async () => new Response(body));
    await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey), /invalid/);
  }
  mocked.mock.mockImplementation(async () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }));
  await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey), /1 MB/);
  let cancelled = false;
  mocked.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey), /1 MB/);
  assert.equal(cancelled, true);
});

test('cancellation before fetch performs no HTTP; in-flight cancellation stops a loopback request', async context => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  const mocked = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Should not fetch'); });
  await assert.rejects(searchWeb(brave, 'query', 5, fixtureKey, alreadyCancelled.signal), /cancelled/);
  assert.equal(mocked.mock.callCount(), 0);
  mocked.mock.restore();
  const controller = new AbortController();
  const server = await localSearch((_url, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"results":[');
    controller.abort();
  });
  try { await assert.rejects(searchWeb(server.config, 'query', 5, '', controller.signal), /cancelled/); }
  finally { await server.close(); }
});

test('15 second deadline is applied to a stalled response including body reads', async context => {
  const nativeTimeout = AbortSignal.timeout;
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15000);
    return nativeTimeout(25);
  });
  const server = await localSearch((_url, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"results":[');
  });
  try { await assert.rejects(searchWeb(server.config, 'query', 5, ''), /timed out/); }
  finally { await server.close(); }
});

test('web search requires its own approval in ask/edit modes and follows full access', async () => {
  for (const mode of ['ask', 'edit'] as const) {
    const decision = await decidePermission('.', mode, 'web_search', { query: 'public docs' });
    assert.equal(decision.approvedAutomatically, false);
    assert.match(decision.reason, /public docs/);
    assert.match(decision.reason, /search service/);
  }
  assert.equal((await decidePermission('.', 'full', 'web_search', { query: 'docs' })).approvedAutomatically, true);
});
