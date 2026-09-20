import { AsyncLocalStorage } from 'node:async_hooks';

export interface NetworkPolicy {
  approve: (request: { url: string; method: string }, signal: AbortSignal) => Promise<boolean>;
  origins: () => readonly string[];
}

const policies = new AsyncLocalStorage<NetworkPolicy>();
let installed = false;

function permitted(url: URL, policy: NetworkPolicy): boolean {
  return policy.origins().some(origin => {
    try { return new URL(origin).origin === url.origin; } catch { return false; }
  });
}

/** Redirects are new egress decisions, even when the first origin was configured. */
export async function brokeredFetch(native: typeof fetch, policy: NetworkPolicy, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  let request = new Request(input, init);
  const redirectMode = request.redirect;
  for (let hop = 0; hop <= 5; hop++) {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Network requests require an HTTP(S) URL without embedded credentials.');
    request.signal.throwIfAborted();
    if (!permitted(url, policy) && !await policy.approve({ url: url.origin + url.pathname, method: request.method }, request.signal)) throw new Error(`Network access denied: ${url.origin}`);
    request.signal.throwIfAborted();
    const response = await native(request.clone(), { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location') || redirectMode === 'manual') return response;
    await response.body?.cancel();
    if (redirectMode === 'error') throw new Error('The endpoint redirected a request that forbids redirects.');
    if (hop === 5) throw new Error('The endpoint exceeded the redirect limit.');
    const next = new URL(response.headers.get('location')!, url);
    const method = response.status === 303 && request.method !== 'HEAD' || [301, 302].includes(response.status) && request.method === 'POST' ? 'GET' : request.method;
    const headers = new Headers(request.headers);
    if (next.origin !== url.origin) {
      // Custom authentication headers are also credentials. Only public
      // representation headers survive a cross-origin redirect.
      for (const name of [...headers.keys()]) if (!['accept', 'accept-language', 'content-type'].includes(name.toLowerCase())) headers.delete(name);
    }
    if (method === 'GET' || method === 'HEAD') { headers.delete('content-type'); headers.delete('content-length'); }
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
    request = new Request(next, { method, headers, body, signal: request.signal, redirect: redirectMode, credentials: next.origin === url.origin ? request.credentials : 'omit' });
  }
  throw new Error('Unexpected redirect state.');
}

/** One wrapper, task-local policy. Detached work retains its originating async scope. */
export function withNetworkPolicy<T>(policy: NetworkPolicy, action: () => T): T {
  if (!installed) {
    installed = true;
    const native = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const active = policies.getStore();
      return active ? brokeredFetch(native, active, input, init) : native(input, init);
    };
  }
  return policies.run(policy, action);
}
