/**
 * <资料目录>/logs/renderer.log (0.9.1): one diagnostic record per interface error, UTF-8, a blank line after each.
 * Past 1 MB the log moves to renderer.log.1, replacing the one before, so at most two files ever exist.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { needsRotation } from '../shared/diagnostics.ts';

export const LOG_FOLDER = 'logs';
export const RENDERER_LOG = 'renderer.log';

// Records arriving together are written one after another, so a rotation never races an append.
let queue: Promise<unknown> = Promise.resolve();

export function appendRendererLog(directory: string, text: string): Promise<void> {
  const next = queue.then(() => append(directory, text));
  queue = next.catch(() => undefined);
  return next;
}

async function append(directory: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, RENDERER_LOG);
  const record = `${text.trimEnd()}\n\n`;
  const size = await stat(file).then(info => info.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
  // A log that cannot be moved (open elsewhere) keeps growing rather than losing the record.
  if (needsRotation(size, Buffer.byteLength(record))) await rename(file, `${file}.1`).catch(() => undefined);
  await appendFile(file, record, 'utf8');
}
