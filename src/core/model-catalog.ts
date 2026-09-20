import type { Gateway } from '../shared/types.ts';

export function modelCatalogUrl(baseUrl: string, protocol: Gateway['protocol']): URL {
  const url = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) gateway URL without credentials or query parameters.');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) throw new Error('Unknown model protocol.');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages|models)$/, '');
  if (protocol === 'anthropic-messages' && !path.endsWith('/v1')) path += '/v1';
  url.pathname = `${path}/models`;
  return url;
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
