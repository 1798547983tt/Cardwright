import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { test } from 'node:test';
import { ecosystemSearch, fetchWebContent, nativeSearchEndpoint, type SearchGateway } from '../src/runtime/ecosystem-web.ts';

const gateway: SearchGateway = { id: 'fixture', name: 'Fixture', baseUrl: 'https://gateway.example/v1', modelId: 'test-model', protocol: 'openai-responses', reasoning: false, contextWindow: 16000, maxTokens: 2000, hasKey: true };
const auto = { enabled: true, provider: 'auto' as const, baseUrl: '', hasKey: false };
const source = { title: 'Pi docs', url: 'https://pi.dev/', snippet: 'Agent documentation' };
const exaReply = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Title: ${source.title}\nURL: ${source.url}\nText: ${source.snippet}` }] } }), { headers: { 'content-type': 'application/json' } });

test('native routing requires explicit same-origin endpoint for custom gateways', () => {
  assert.equal(nativeSearchEndpoint(gateway), undefined);
  assert.equal(nativeSearchEndpoint({ ...gateway, nativeSearch: { enabled: true } }), undefined);
  assert.throws(() => nativeSearchEndpoint({ ...gateway, nativeSearch: { enabled: true, responsesUrl: 'https://api.openai.com/v1/responses' } }), /same origin/);
  assert.equal(nativeSearchEndpoint({ ...gateway, nativeSearch: { enabled: true, responsesUrl: 'https://gateway.example/v1/responses' } }), 'https://gateway.example/v1/responses');
  assert.equal(nativeSearchEndpoint({ ...gateway, baseUrl: 'https://api.openai.com/v1', nativeSearch: { enabled: true } }), 'https://api.openai.com/v1/responses');
});

test('automatic Exa search invokes actual upstream transport without gateway or global credentials', async () => {
  const originalFetch = globalThis.fetch; const seen: Array<{ url: string; init?: RequestInit }> = [];
  const oldKey = process.env.EXA_API_KEY; process.env.EXA_API_KEY = 'must-not-be-used';
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return exaReply(); };
  try {
    const result = await ecosystemSearch(auto, gateway, 'gateway-secret', 'Pi agent', 3);
    assert.equal(result.provider, 'exa'); assert.deepEqual(result.results, [source]);
    assert.equal(seen.length, 1); assert.match(seen[0].url, /^https:\/\/mcp\.exa\.ai\/mcp\?/);
    assert.equal(new Headers(seen[0].init?.headers).has('authorization'), false);
    assert.equal(JSON.stringify(seen).includes('gateway-secret'), false);
    assert.equal(JSON.stringify(seen).includes('must-not-be-used'), false);
  } finally { globalThis.fetch = originalFetch; if (oldKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = oldKey; }
});

test('native gateway real loopback request returns proven search sources and usage', async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    assert.equal(request.headers.authorization, 'Bearer fixture-key'); assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.store, false);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [source] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Pi is an agent.', annotations: [{ type: 'url_citation', title: source.title, url: source.url }] }] },
    ], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/v1`;
  try {
    const result = await ecosystemSearch(auto, { ...gateway, baseUrl: base, nativeSearch: { enabled: true, responsesUrl: `${base}/responses` } }, 'fixture-key', 'Pi', 3);
    assert.equal(calls, 1); assert.equal(result.provider, 'native'); assert.equal(result.results.length, 1);
    assert.deepEqual(result.nativeUsage, { input: 80, output: 10, cacheRead: 20 });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('automatic native unsupported response falls back, but explicit provider and auth failure do not', async () => {
  const originalFetch = globalThis.fetch; const native = { ...gateway, nativeSearch: { enabled: true, responsesUrl: 'https://gateway.example/v1/responses' } };
  const seen: string[] = []; let status = 400;
  globalThis.fetch = async (url) => { seen.push(String(url)); return String(url).includes('gateway.example') ? new Response('', { status }) : exaReply(); };
  try {
    assert.equal((await ecosystemSearch(auto, native, 'fixture-key', 'Pi')).provider, 'exa'); assert.equal(seen.length, 2);
    seen.length = 0; await assert.rejects(ecosystemSearch({ ...auto, provider: 'native' }, native, 'fixture-key', 'Pi'), /HTTP 400/); assert.equal(seen.length, 1);
    seen.length = 0; status = 401; await assert.rejects(ecosystemSearch(auto, native, 'fixture-key', 'Pi'), /HTTP 401/); assert.equal(seen.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('claims of browsing without web_search_call are rejected; cancellation never falls back', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'I searched the internet.' }] }] })); };
  const native = { ...gateway, nativeSearch: { enabled: true, responsesUrl: 'https://gateway.example/v1/responses' } };
  try {
    await assert.rejects(ecosystemSearch({ ...auto, provider: 'native' }, native, 'fixture-key', 'Pi'), /did not execute/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(ecosystemSearch(auto, native, 'fixture-key', 'Pi', 3, '', cancelled.signal)); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('automatic Exa failure can use saved legacy search settings without sharing model credentials', async () => {
  const originalFetch = globalThis.fetch; const seen: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).includes('mcp.exa.ai')) return new Response('', { status: 429 });
    return new Response(JSON.stringify({ web: { results: [{ title: source.title, url: source.url, description: source.snippet }] } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await ecosystemSearch({ ...auto, hasKey: true }, gateway, 'model-only-secret', 'Pi', 3, 'brave-only-secret');
    assert.equal(result.provider, 'brave'); assert.equal(seen.length, 2);
    assert.equal(seen[0].headers.has('authorization'), false);
    assert.equal(seen[1].headers.get('x-subscription-token'), 'brave-only-secret'); assert.equal(seen[1].headers.has('authorization'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('public reader invokes upstream SSRF rejection before fetch, including localhost and private IPs', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('secret', { headers: { 'content-type': 'text/plain' } }); };
  try {
    for (const url of ['http://127.0.0.1/config', 'http://localhost/config', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'https://name:password@example.com/']) await assert.rejects(fetchWebContent(url));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('public reader extracts HTML locally and bounds bodies without browser or script execution', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('<html><head><title>Sample</title></head><body><article><h1>Sample page</h1><p>A useful public document with details.</p></article><script>globalThis.untrusted = 1</script></body></html>', { headers: { 'content-type': 'text/html' } }); };
  try {
    const result = await fetchWebContent('https://1.1.1.1/document'); assert.match(result.content, /useful public document/); assert.doesNotMatch(result.content, /globalThis/); assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('too big', { headers: { 'content-type': 'text/plain', 'content-length': '2097152' } });
    await assert.rejects(fetchWebContent('https://1.1.1.1/document'), /1 MB/);
  } finally { globalThis.fetch = originalFetch; }
});

test('bundled CJS search loads pinned upstream TypeScript under plain Node without tsx', async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(testDirectory, '.compiled-web-'));
  try {
    await build({ entryPoints: [join(testDirectory, '../src/runtime/ecosystem-web.ts')], outfile: join(directory, 'web.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const runner = join(directory, 'run.cjs');
    await writeFile(runner, `
      const { ecosystemSearch } = require('./web.cjs');
      globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'Title: Pi\\nURL: https://pi.dev/\\nText: Documentation'}]}}));
      ecosystemSearch({enabled:true,provider:'exa',baseUrl:'',hasKey:false},{id:'fixture',name:'fixture',baseUrl:'https://example.com/v1',modelId:'none',protocol:'openai-completions',reasoning:false,contextWindow:1,maxTokens:1,hasKey:false},'', 'Pi', 1)
        .then(result => { if (result.provider !== 'exa' || result.results[0]?.url !== 'https://pi.dev/') throw new Error('Bad search result'); console.log('compiled-cjs-ok'); });
    `);
    const result = await promisify(execFile)(process.execPath, [runner], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 });
    assert.match(result.stdout, /compiled-cjs-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
