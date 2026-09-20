import { readFile, stat } from 'node:fs/promises';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AttachmentInfo } from '../shared/studio-types.ts';
import { canonicalPath, isWithinRoot } from './permissions.ts';

/** The main process stages selected content immutably; model history reuses those bytes. */
export async function prepareAttachments(items: Array<AttachmentInfo & { storedPath: string }>, root: string | undefined, cwd: string, authorizeRead: (path: string) => void): Promise<{ text: string; images: ImageContent[] }> {
  if (!items.length) return { text: '', images: [] };
  if (!root || items.length > 16) throw new Error('Attachments are unavailable or exceed the per-message limit.');
  const actualRoot = await canonicalPath(root, cwd);
  const images: ImageContent[] = []; const references: Array<{ name: string; path: string; kind: string }> = [];
  let bytes = 0;
  for (const item of items) {
    const path = await canonicalPath(item.storedPath, actualRoot);
    if (!isWithinRoot(actualRoot, path)) throw new Error('Attachment is outside the staged attachment directory.');
    const info = await stat(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || (bytes += info.size) > 64 * 1024 * 1024) throw new Error('Attachments exceed the size limit.');
    if (item.kind === 'image') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType)) throw new Error('Unsupported attachment image type.');
      images.push({ type: 'image', mimeType: item.mimeType, data: (await readFile(path)).toString('base64') });
    }
    authorizeRead(path);
    references.push({ name: item.name, path, kind: item.kind });
  }
  return { text: '\n\nUser-selected attachments (read-only copies):\n' + JSON.stringify(references), images };
}
