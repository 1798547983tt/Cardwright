/**
 * The card studio's preview documents, served from memory on cardwright-preview://. Each document has its own policy:
 * nothing reaches the network, and scripts run only where SillyTavern would run them. The studio shows them in
 * iframes sandboxed without allow-same-origin, so they get an opaque origin and no bridge. A srcdoc frame would not
 * do: it inherits the window's policy, which runs no inline script (probed in Electron 44).
 */
import { randomUUID } from 'node:crypto';
import { protocol } from 'electron';
import { previewDocument, type PreviewSegment } from '../shared/card-studio/preview.ts';

export const PREVIEW_SCHEME = 'cardwright-preview';
const documents = new Map<string, { html: string; csp: string }>();
const owners = new Map<string, string[]>();

/** Before the app is ready. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } }]);
}

export function handlePreviewScheme(): void {
  protocol.handle(PREVIEW_SCHEME, request => {
    const found = documents.get(new URL(request.url).pathname.replace(/^\//, ''));
    if (!found) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(found.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': found.csp, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });
}

/** Replaces what `owner` published before; one address per segment. */
export function publishPreview(owner: string, segments: PreviewSegment[]): string[] {
  for (const id of owners.get(owner) ?? []) documents.delete(id);
  const ids = segments.map(segment => {
    const id = randomUUID();
    documents.set(id, previewDocument(segment, randomUUID().replace(/-/g, '')));
    return id;
  });
  owners.set(owner, ids);
  return ids.map(id => `${PREVIEW_SCHEME}://doc/${id}`);
}
