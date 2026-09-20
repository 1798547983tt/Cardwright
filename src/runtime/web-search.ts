import type { SearchConfig, SearchOutput, SearchResult } from '../shared/types.ts';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

class SearchError extends Error {}

function searxEndpoint(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new SearchError('Enter a valid SearXNG instance URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new SearchError('SearXNG needs an HTTP(S) instance URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  return url;
}

/** Configuration is supplied by the desktop, never by a model tool call. */
export function searchConfigurationError(config: SearchConfig | undefined, apiKey?: string): string | undefined {
  if (!config?.enabled) return 'Web search is disabled. Enable it in settings.';
  if (config.provider === 'brave') {
    if (!config.hasKey || (apiKey !== undefined && !apiKey.trim())) return 'Configure a Brave Search API key in settings.';
    return undefined;
  }
  if (config.provider !== 'searxng') return 'Select a supported search provider in settings.';
  try { searxEndpoint(config.baseUrl); } catch (error) { return (error as Error).message; }
  return undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, length: number): string {
  if (typeof value !== 'string') return '';
  const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
    const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
  // These strings stay plain text throughout the renderer and tool output.
  return decode(value)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, length);
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new SearchError('Search response exceeded the 1 MB limit.');
  }
  if (!response.body) throw new SearchError('Search service returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new SearchError('Search response exceeded the 1 MB limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new SearchError('Search service returned invalid JSON. Check the instance API settings.'); }
}

function parseResults(provider: SearchConfig['provider'], body: unknown, count: number): SearchResult[] {
  if (!object(body)) throw new SearchError('Search service returned an invalid response format.');
  let values: unknown;
  if (provider === 'brave') {
    // Brave can omit the web section when a valid query has no web matches.
    values = object(body.web) ? body.web.results : body.web === undefined && object(body.query) ? [] : undefined;
  } else values = body.results;
  if (!Array.isArray(values) || values.some(value => !object(value) || typeof value.url !== 'string')) {
    throw new SearchError('Search service returned an invalid result format.');
  }
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const value of values) {
    if (!object(value)) continue;
    const url = sourceUrl(value.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = plainText(value.title, 300) || new URL(url).hostname;
    const snippet = plainText(provider === 'brave' ? value.description : value.content, 2500);
    const age = plainText(value.age ?? value.page_age ?? value.publishedDate, 100);
    results.push({ title, url, snippet, ...(age ? { age } : {}) });
    if (results.length === count) break;
  }
  return results;
}

/** Search-only: result pages are never automatically fetched or executed. */
export async function searchWeb(
  config: SearchConfig, query: string, count: number, apiKey: string, signal?: AbortSignal,
): Promise<SearchOutput> {
  const configurationError = searchConfigurationError(config, apiKey);
  if (configurationError) throw new SearchError(configurationError);
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) {
    throw new SearchError('Search query must contain between 1 and 500 characters.');
  }
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new SearchError('Search result count must be between 1 and 8.');
  const normalizedQuery = query.trim();
  const url = config.provider === 'brave' ? new URL(BRAVE_ENDPOINT) : searxEndpoint(config.baseUrl);
  url.searchParams.set('q', normalizedQuery);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.provider === 'brave') {
    // REST mapping follows Mario Zechner's MIT-licensed pi-skills/brave-search.
    // Attribution and license: docs/search-sources.md. No shell or scraper is used.
    url.searchParams.set('count', String(count));
    headers['X-Subscription-Token'] = apiKey.trim();
  } else url.searchParams.set('format', 'json');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    requestSignal.throwIfAborted();
    const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: requestSignal });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new SearchError('Search authentication failed (401). Check the search API key.');
      if (response.status === 403) throw new SearchError('Search was refused (403). Check API access; SearXNG must allow JSON results.');
      if (response.status === 429) throw new SearchError('Search rate limit reached (429). Try again later.');
      throw new SearchError(`Search service failed (HTTP ${response.status}). Try again later.`);
    }
    const body = await readJson(response, requestSignal);
    requestSignal.throwIfAborted();
    const secret = apiKey.trim();
    const redact = (value: string) => secret ? value.split(secret).join('[redacted]') : value;
    const results = parseResults(config.provider === 'brave' ? 'brave' : 'searxng', body, count)
      .filter(result => !secret || (!result.url.includes(secret) && !result.url.includes(encodeURIComponent(secret))))
      .map(result => ({ ...result, title: redact(result.title), snippet: redact(result.snippet), ...(result.age ? { age: redact(result.age) } : {}) }));
    return { query: redact(normalizedQuery), provider: config.provider === 'brave' ? 'brave' : 'searxng', results, searchedAt: new Date().toISOString() };
  } catch (error) {
    // Never expose response bodies, headers, endpoint credentials, or raw transport errors.
    if (signal?.aborted) throw new SearchError('Web search was cancelled.');
    if (timeout.aborted) throw new SearchError('Web search timed out after 15 seconds.');
    if (error instanceof SearchError) throw error;
    throw new SearchError('Could not reach the search service. Check the connection and instance URL.');
  }
}
