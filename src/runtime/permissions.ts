import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PermissionMode } from '../shared/types.ts';

export interface PermissionDecision {
  approvedAutomatically: boolean;
  reason: string;
  resolvedPath?: string;
}

/** Resolve existing ancestors as well as the leaf; new files inherit the real parent. */
export async function canonicalPath(input: string, cwd: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('A valid file path is required.');
  const expanded = input === '~' ? homedir() : /^~[/\\]/.test(input) ? join(homedir(), input.slice(2)) : input;
  // Drive-relative paths and device/alternate-stream paths have surprising Win32 semantics.
  if (process.platform === 'win32') {
    if (/^[a-z]:[^/\\]/i.test(expanded) || /^[/\\]{2}[?.][/\\]/.test(expanded)) {
      throw new Error('Use a normal absolute path or a path relative to the project.');
    }
    if (expanded.replace(/^[a-z]:/i, '').includes(':')) throw new Error('Alternate data stream paths are unsupported.');
  }
  let candidate = resolve(cwd, expanded);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missing);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // A dangling link must not be treated as a new directory underneath cwd.
      try {
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink()) throw new Error(`Cannot resolve symbolic link: ${candidate}`);
      } catch (statError) {
        if (!(statError instanceof Error) || !('code' in statError) || statError.code !== 'ENOENT') throw statError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`Cannot resolve path: ${input}`);
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

const readTools = new Set(['read', 'ls', 'grep', 'find']);
const writeTools = new Set(['write', 'edit']);

/** Tool approval policy. The command runner separately enforces OS isolation. */
export async function decidePermission(
  cwd: string,
  mode: PermissionMode,
  toolName: string,
  args: Record<string, unknown>,
  options: { readRoots?: string[] } = {},
): Promise<PermissionDecision> {
  const reads = readTools.has(toolName);
  const writes = writeTools.has(toolName);
  let resolvedPath: string | undefined;
  let inside = false;
  if (reads || writes) {
    const input = args.path ?? (toolName === 'ls' || toolName === 'grep' || toolName === 'find' ? '.' : undefined);
    if (typeof input !== 'string') throw new Error(`${toolName} requires a file path.`);
    const root = await realpath(cwd);
    resolvedPath = await canonicalPath(input, cwd);
    inside = isWithinRoot(root, resolvedPath);
  }
  if (mode === 'full') return { approvedAutomatically: true, reason: 'Full access is enabled.', resolvedPath };
  if (toolName === 'web_search') {
    return { approvedAutomatically: false, reason: `Send this query to the configured web search service: ${String(args.query ?? '').slice(0, 500)}` };
  }
  if (reads && !inside && resolvedPath) {
    // Built-in, application-owned references (the card studio knowledge base) are readable without approval.
    for (const readRoot of options.readRoots ?? []) {
      const canonicalRoot = await realpath(readRoot).catch(() => undefined);
      if (canonicalRoot && isWithinRoot(canonicalRoot, resolvedPath)) return { approvedAutomatically: true, reason: 'Read built-in card studio resources.', resolvedPath };
    }
  }
  if ((reads || writes) && !inside) {
    return { approvedAutomatically: false, reason: 'This path resolves outside the project.', resolvedPath };
  }
  if (reads) return { approvedAutomatically: true, reason: 'Read within the project.', resolvedPath };
  if (writes && mode === 'edit') {
    return { approvedAutomatically: true, reason: 'Project edits are enabled.', resolvedPath };
  }
  return {
    approvedAutomatically: false,
    reason: writes ? 'File changes require approval.' : toolName === 'host_command' ? 'Run this command directly on the host, outside restricted execution.' : 'Approve this tool operation; command isolation follows the selected execution mode.',
    resolvedPath,
  };
}
