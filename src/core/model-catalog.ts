import type { Gateway } from '../shared/types.ts';

/** An endpoint under the gateway's API root: `models`, `chat/completions`, `responses` or `messages`. */
function gatewayUrl(baseUrl: string, protocol: Gateway['protocol'], endpoint: string): URL {
  const url = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) gateway URL without credentials or query parameters.');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) throw new Error('Unknown model protocol.');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages|models)$/, '');
  if (protocol === 'anthropic-messages' && !path.endsWith('/v1')) path += '/v1';
  url.pathname = `${path}/${endpoint}`;
  return url;
}

export function modelCatalogUrl(baseUrl: string, protocol: Gateway['protocol']): URL {
  return gatewayUrl(baseUrl, protocol, 'models');
}

/**
 * 一键自检's second step: one request that may produce a single token (sixteen for the Responses API, which has that
 * floor), not streamed, to the model the user picked on the gateway the user entered. The reply text is returned.
 */
export async function tinyCompletion(input: { baseUrl: string; protocol: Gateway['protocol'] }, key: string, model: string): Promise<{ text: string }> {
  const anthropic = input.protocol === 'anthropic-messages';
  const url = gatewayUrl(input.baseUrl, input.protocol, input.protocol === 'openai-completions' ? 'chat/completions' : input.protocol === 'openai-responses' ? 'responses' : 'messages');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : key ? { Authorization: `Bearer ${key}` } : {}) };
  const body = input.protocol === 'openai-completions' ? { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }
    : input.protocol === 'openai-responses' ? { model, input: 'ping', max_output_tokens: 16, stream: false }
    : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const raw = (await response.text()).slice(0, 4000);
  if (!response.ok) throw new Error(`HTTP ${response.status}${raw ? `: ${raw.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch { throw new Error('The gateway did not answer with JSON.'); }
  const part = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => part((item as { text?: unknown; content?: unknown })?.text ?? (item as { content?: unknown })?.content)).join('') : '';
  const choice = Array.isArray(payload.choices) ? (payload.choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
  const text = choice ? part(choice.message?.content) : typeof payload.output_text === 'string' ? payload.output_text : part(payload.output ?? payload.content);
  return { text };
}

/** User-selected gateway only. Credentials never follow a redirect. */
export async function fetchModelCatalog(input: { baseUrl: string; protocol: Gateway['protocol'] }, key: string): Promise<Array<{ id: string; name?: string }>> {
  const headers: Record<string, string> = input.protocol === 'anthropic-messages'
    ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(modelCatalogUrl(input.baseUrl, input.protocol), { headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}. Check the connection or enter a model ID manually.`);
  if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('Model list is too large.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('The gateway returned an empty model list.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Model list is too large.'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  let payload: unknown; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The model list endpoint did not return JSON. Enter a model ID manually.'); }
  const raw = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  if (!Array.isArray(raw)) throw new Error('The gateway does not expose a supported model list. Enter a model ID manually.');
  const models = new Map<string, { id: string; name?: string }>();
  for (const entry of raw.slice(0, 5000)) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f]/.test(id)) continue;
    const name = typeof entry?.display_name === 'string' ? entry.display_name : typeof entry?.name === 'string' ? entry.name : undefined;
    models.set(id, { id, ...(name ? { name: name.slice(0, 200) } : {}) });
  }
  if (!models.size) throw new Error('The gateway returned no available model IDs. You can still enter one manually.');
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
