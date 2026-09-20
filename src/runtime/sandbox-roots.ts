import { resolve } from 'node:path';
import { isWithinRoot } from './permissions.ts';

/** The command host accepts at most this many read roots and write roots per command. */
export const SANDBOX_ROOT_LIMIT = 16;

const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/**
 * Read roots for one isolated command, most important first: the project, built-in resources, attached copies, then the
 * files of skills in use. Duplicates and files already inside a directory root are dropped; the rest is cut at `limit`,
 * which leaves one slot for the bundled tools directory the runner adds.
 */
export function sandboxReadRoots(input: { project: string; builtIn?: string[]; attachments?: string[]; skills?: string[] }, limit = SANDBOX_ROOT_LIMIT - 1): string[] {
  const directories: string[] = [];
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (path: string, directory: boolean) => {
    if (roots.length >= limit) return;
    const id = key(path);
    if (seen.has(id) || directories.some(root => isWithinRoot(key(root), id))) return;
    seen.add(id); roots.push(path);
    if (directory) directories.push(path);
  };
  add(input.project, true);
  for (const path of input.builtIn ?? []) add(path, true);
  for (const path of input.attachments ?? []) add(path, false);
  for (const path of input.skills ?? []) add(path, false);
  return roots;
}
