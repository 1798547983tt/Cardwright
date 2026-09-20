import { createJiti } from 'jiti/static';
import { dirname, join } from 'node:path';
import type { Gateway, SearchConfig, SearchResult } from '../shared/types.ts';
import { searchWeb } from './web-search.ts';
import { resolveEcosystemPackage } from './ecosystem-skills.ts';

/** Pinned upstream transport/SSRF primitives, loaded without running the Pi extension entrypoint. */
function loadUpstream<T>(module: string): Promise<T> {
  const manifest = resolveEcosystemPackage('pi-web-access');
  const loader = createJiti(manifest, { fsCache: false, interopDefault: false });
  return loader.import<T>(join(dirname(manifest), module));
}
type SearchProvider = 'auto' | 'native' | 'exa' | 'brave' | 'searxng';
export type EcosystemSearchConfig = Omit<SearchConfig, 'provider'> & { provider: SearchProvider };
export type SearchGateway = Gateway & { nativeSearch?: { enabled: boolean; responsesUrl?: string } };
export interface EcosystemSearchOutput {
  query: string; provider: Exclude<SearchProvider, 'auto'>; results: SearchResult[]; searchedAt: string;
  answer?: string;
  /** Provider-reported nested model usage, never estimated. */
  nativeUsage?: { input: number; output: number; cacheRead: number };
}
interface ExaModule { callExaMcp(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> }
interface SsrfModule { fetchRemoteUrl(url: string, init: RequestInit, options: { trustEnvProxy: false; maxRedirects: number }): Promise<Response> }
let exaModule: Promise<ExaModule> | undefined;
let ssrfModule: Promise<SsrfModule> | undefined;
const MAX_BODY = 1024 * 1024;
const MAX_CONTENT = 24_000;

class WebError extends Error {
  constructor(message: string, readonly fallback = false) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function publicLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid source. */ }
}
function clean(value: unknown, length = 2000): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, length) : '';
}
function combineSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
}
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BODY) { await response.body?.cancel(); throw new WebError('Web response exceeded the 1 MB limit.', true); }
  if (!response.body) throw new WebError('Web service returned no content.', true);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > MAX_BODY) throw new WebError('Web response exceeded the 1 MB limit.', true);
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only desktop-saved endpoint configuration can authorize reusing a gateway credential. */
export function nativeSearchEndpoint(gateway: SearchGateway): string | undefined {
  if (!gateway.nativeSearch?.enabled) return;
  const base = new URL(gateway.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new WebError('The model gateway URL is invalid.');
  const explicit = gateway.nativeSearch.responsesUrl?.trim();
  if (!explicit) {
    if (gateway.protocol === 'openai-responses' && base.origin === 'https://api.openai.com' && base.pathname.replace(/\/+$/, '') === '/v1') return 'https://api.openai.com/v1/responses';
    return;
  }
  let target: URL;
  try { target = new URL(explicit); } catch { throw new WebError('Native search needs a full Responses endpoint.'); }
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash || !/\/responses\/?$/.test(target.pathname)) {
    throw new WebError('Native search must use an explicit Responses endpoint on the same origin as the model gateway.');
  }
  return target.href;
}

function sourceResults(values: unknown[], count: number): SearchResult[] {
  const results: SearchResult[] = []; const seen = new Set<string>();
  for (const value of values) {
    if (!record(value)) continue; const url = publicLink(value.url); if (!url || seen.has(url)) continue;
    seen.add(url); results.push({ url, title: clean(value.title, 300) || new URL(url).hostname, snippet: clean(value.snippet ?? value.text ?? value.content) });
    if (results.length >= count) break;
  }
  return results;
}

/** Responses hosted-search protocol follows pi-web-access/openai-search.ts; app config owns auth routing. */
async function nativeSearch(gateway: SearchGateway, key: string, query: string, count: number, signal: AbortSignal): Promise<EcosystemSearchOutput> {
  const endpoint = nativeSearchEndpoint(gateway);
  if (!endpoint) throw new WebError('Native search is not enabled for a verified Responses endpoint.', true);
  if (!key.trim()) throw new WebError('Configure the model gateway credential before using native search.');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: gateway.modelId, input: query, instructions: `Search the web. Return a concise answer with around ${count} source citations.`,
      tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'], store: false, stream: false, max_output_tokens: Math.min(gateway.maxTokens || 2000, 2000) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new WebError(`Native web search failed (HTTP ${response.status}).`, ![401, 403].includes(response.status));
  }
  let body: unknown;
  try {
    const text = await boundedText(response, signal);
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const frames = text.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)) as unknown; } catch { return null; } });
      const done = frames.find(frame => record(frame) && frame.type === 'response.completed');
      body = record(done) ? done.response : undefined;
    } else body = JSON.parse(text);
  } catch (error) { if (error instanceof WebError) throw error; throw new WebError('Native search returned invalid data.', true); }
  if (!record(body) || !Array.isArray(body.output)) throw new WebError('Native search returned an invalid response.', true);
  const output = body.output.filter(record);
  if (!output.some(item => item.type === 'web_search_call' && item.status === 'completed')) throw new WebError('The gateway did not execute hosted web search.', true);
  const sources: unknown[] = []; const answers: string[] = [];
  for (const item of output) {
    if (record(item.action) && Array.isArray(item.action.sources)) sources.push(...item.action.sources);
    if (Array.isArray(item.content)) for (const part of item.content) {
      if (!record(part)) continue;
      if (part.type === 'output_text') answers.push(clean(part.text, 16_000));
      if (Array.isArray(part.annotations)) sources.push(...part.annotations);
    }
  }
  const results = sourceResults(sources, count);
  if (!results.length) throw new WebError('Hosted search returned no usable source URLs.', true);
  const usage = record(body.usage) ? body.usage : undefined;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const cacheRead = usage && record(usage.input_tokens_details) ? number(usage.input_tokens_details.cached_tokens) : 0;
  return { query, provider: 'native', results, answer: answers.join('\n\n'), searchedAt: new Date().toISOString(),
    ...(usage ? { nativeUsage: { input: Math.max(0, number(usage.input_tokens) - cacheRead), output: number(usage.output_tokens), cacheRead } } : {}) };
}

async function exaSearch(query: string, count: number, signal: AbortSignal): Promise<EcosystemSearchOutput> {
  const upstream = await (exaModule ??= loadUpstream<ExaModule>('exa.ts'));
  signal.throwIfAborted();
  // The keyless entrypoint never consults an environment key or the user's Pi config.
  const text = await upstream.callExaMcp('web_search_exa', { query, numResults: count, type: 'auto', contextMaxCharacters: 16_000 }, signal);
  if (text.length > MAX_BODY) throw new WebError('Search result exceeded the 1 MB limit.', true);
  const blocks = text.split(/(?=^Title: )/m).map(block => ({ title: block.match(/^Title: (.+)/m)?.[1], url: block.match(/^URL: (.+)/m)?.[1],
    snippet: block.match(/\n(?:Text: |Highlights:\s*\n)([\s\S]*)/)?.[1] }));
  const results = sourceResults(blocks, count);
  if (!results.length) throw new WebError('Exa returned no usable source URLs.', true);
  return { query, provider: 'exa', results, searchedAt: new Date().toISOString() };
}

/** Routes one approved query; provider fallbacks never receive the model API key. */
export async function ecosystemSearch(config: EcosystemSearchConfig, gateway: SearchGateway | undefined, modelKey: string, query: string, count = 5, searchKey = '', signal?: AbortSignal): Promise<EcosystemSearchOutput> {
  if (!config.enabled) throw new WebError('Web search is disabled.');
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) throw new WebError('Search query must contain between 1 and 500 characters.');
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new WebError('Search result count must be between 1 and 8.');
  const normalized = query.trim(); const requestSignal = combineSignal(signal);
  requestSignal.throwIfAborted();
  const redact = (value: string) => [modelKey, searchKey].filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  const fallbackSearch = async (): Promise<EcosystemSearchOutput> => {
    try { return await exaSearch(normalized, count, requestSignal); }
    catch (error) {
      if (requestSignal.aborted) throw error;
      // These are only previously saved desktop settings; a model cannot nominate a service/key.
      const savedFallback = config.baseUrl.trim() ? 'searxng' : config.hasKey && searchKey.trim() ? 'brave' : undefined;
      if (!savedFallback) throw error;
      return searchWeb({ ...config, provider: savedFallback }, normalized, count, searchKey, requestSignal) as Promise<EcosystemSearchOutput>;
    }
  };
  try {
    let result: EcosystemSearchOutput;
    if (config.provider === 'brave' || config.provider === 'searxng') result = await searchWeb(config as SearchConfig, normalized, count, searchKey, requestSignal) as EcosystemSearchOutput;
    else if (config.provider === 'native') { if (!gateway) throw new WebError('Select a model gateway before testing native search.'); result = await nativeSearch(gateway, modelKey, normalized, count, requestSignal); }
    else if (config.provider === 'exa') result = await exaSearch(normalized, count, requestSignal);
    else if (config.provider === 'auto') {
      if (gateway && nativeSearchEndpoint(gateway)) {
        try { result = await nativeSearch(gateway, modelKey, normalized, count, requestSignal); }
        catch (error) { if (requestSignal.aborted || (error instanceof WebError && !error.fallback)) throw error; result = await fallbackSearch(); }
      } else result = await fallbackSearch();
    } else throw new WebError('Unknown web search provider.');
    return { ...result, query: redact(result.query), answer: result.answer ? redact(result.answer) : undefined,
      results: result.results.filter(item => ![modelKey, searchKey].filter(Boolean).some(secret => item.url.includes(secret) || item.url.includes(encodeURIComponent(secret))))
        .map(item => ({ ...item, title: redact(item.title), snippet: redact(item.snippet) })) };
  } catch (error) {
    if (signal?.aborted) throw new WebError('Web search was cancelled.');
    if (requestSignal.aborted) throw new WebError('Web search timed out.');
    if (error instanceof WebError) throw new WebError(redact(error.message));
    // Upstream transport errors may include response bodies. Do not surface those or credentials.
    throw new WebError('Could not complete web search. Check the provider connection or try another provider.');
  }
}

/** Public text URLs only: upstream SSRF validation, local HTML extraction, no browser/clone/video dispatch. */
export async function fetchWebContent(rawUrl: string, signal?: AbortSignal): Promise<{ url: string; title: string; content: string; truncated: boolean }> {
  const url = publicLink(rawUrl); if (!url) throw new WebError('Enter an HTTP(S) URL without credentials.');
  const requestSignal = combineSignal(signal); requestSignal.throwIfAborted();
  const upstream = await (ssrfModule ??= loadUpstream<SsrfModule>('ssrf-protection.ts'));
  try {
    const response = await upstream.fetchRemoteUrl(url, { headers: { Accept: 'text/html,text/plain,application/json,text/markdown' }, signal: requestSignal }, { trustEnvProxy: false, maxRedirects: 4 });
    if (!response.ok) { await response.body?.cancel(); throw new WebError(`Page request failed (HTTP ${response.status}).`); }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!(mime.startsWith('text/') || ['application/json', 'application/xhtml+xml', 'application/xml'].includes(mime))) { await response.body?.cancel(); throw new WebError('This reader supports text and HTML pages only.'); }
    const text = await boundedText(response, requestSignal); let title = new URL(url).hostname; let content = text;
    if (mime.includes('html')) {
      const { parseHTML } = await import('linkedom'); const { Readability } = await import('@mozilla/readability');
      const { document } = parseHTML(text);
      document.querySelectorAll('script,style,noscript,iframe,object,embed,form').forEach(node => node.remove());
      const article = new Readability(document as unknown as Document).parse();
      title = clean(article?.title || document.title, 300) || title;
      content = article?.textContent || document.body?.textContent || '';
    }
    requestSignal.throwIfAborted(); const cleaned = clean(content, MAX_BODY);
    return { url: response.url || url, title, content: cleaned.slice(0, MAX_CONTENT), truncated: cleaned.length > MAX_CONTENT };
  } catch (error) {
    if (signal?.aborted) throw new WebError('Page reading was cancelled.');
    if (requestSignal.aborted) throw new WebError('Page reading timed out.');
    if (error instanceof WebError) throw error;
    throw new WebError('Could not read this public page. Private/local addresses and unsupported redirects are blocked.');
  }
}
