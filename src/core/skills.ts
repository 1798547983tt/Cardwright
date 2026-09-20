import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { SkillInfo } from '../shared/types.ts';

const maxFileBytes = 256 * 1024;
const maxMetadataBytes = 16 * 1024;
const maxFiles = 500;
const maxDirectories = 2_000;
const rootNames = ['.agents', '.codex', '.claude'];
type Source = 'project' | 'custom' | 'user' | 'bundled';
type DiscoveredSkill = SkillInfo & { id: string; source: Source; enabled: boolean; disableModelInvocation: boolean; projectId?: string; shadowedBy?: string };
type Root = { path: string; source: Source; projectId?: string };
const priority: Record<Source, number> = { project: 0, custom: 1, user: 2, bundled: 3 };

function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** IDs identify the actual file, including when multiple configured roots point to it. */
export function skillId(path: string): string {
  return createHash('sha256').update(pathKey(realpathSync(path))).digest('hex');
}

function metadata(path: string): { name: string; description: string; disableModelInvocation: boolean } | undefined {
  let fd: number | undefined;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxFileBytes) return;
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(stats.size, maxMetadataBytes));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(prefix);
    if (!match) return;
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length) return;
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const fields = value as Record<string, unknown>;
    const name = typeof fields.name === 'string' ? fields.name.trim() : basename(dirname(path));
    const description = typeof fields.description === 'string' ? fields.description.trim() : '';
    if (!name || name.length > 128 || /[\s/:\\<>\0]/.test(name) || !description || description.length > 4_096) return;
    return { name, description, disableModelInvocation: fields['disable-model-invocation'] === true };
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Read only bounded SKILL.md metadata below explicit skill roots; never load code or package manifests. */
export function discoverSkills(options: {
  projects: Array<{ id: string; path: string }>;
  customPaths: string[];
  disabledIds: string[];
  homeDir?: string;
  bundledPaths?: string[];
}): SkillInfo[] {
  const roots: Root[] = [
    ...options.projects.flatMap(project => rootNames.map(name => ({ path: join(project.path, name, 'skills'), source: 'project' as const, projectId: project.id }))),
    ...options.customPaths.map(path => ({ path, source: 'custom' as const })),
    ...rootNames.map(name => ({ path: join(options.homeDir ?? homedir(), name, 'skills'), source: 'user' as const })),
    ...(options.bundledPaths || []).map(path => ({ path, source: 'bundled' as const })),
  ];
  const disabled = new Set(options.disabledIds);
  const found: DiscoveredSkill[] = [];
  const seenSkills = new Set<string>();
  const visited = new Set<string>();
  let directoryCount = 0;
  for (const selected of roots) {
    if (found.length >= maxFiles || directoryCount >= maxDirectories) break;
    let selectedPath: string;
    let root: string;
    try {
      selectedPath = realpathSync(resolve(selected.path));
      root = statSync(selectedPath).isDirectory() ? selectedPath : dirname(selectedPath);
    } catch { continue; }
    const pending = [selectedPath];
    while (pending.length && found.length < maxFiles && directoryCount < maxDirectories) {
      const candidate = pending.pop()!;
      try {
        const path = realpathSync(candidate);
        if (!inside(root, path)) continue;
        // Scope is retained when the same physical skill is also explicitly shared globally.
        const visitKey = `${selected.projectId ?? 'global'}:${pathKey(path)}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);
        const stats = statSync(path);
        if (stats.isFile()) {
          if (basename(path).toLowerCase() !== 'skill.md') continue;
          const meta = metadata(path);
          if (!meta) continue;
          const id = skillId(path);
          const identity = `${selected.projectId ?? 'global'}:${id}`;
          if (seenSkills.has(identity)) continue;
          seenSkills.add(identity);
          found.push({ ...meta, id, path, source: selected.source, enabled: !disabled.has(id), ...(selected.projectId ? { projectId: selected.projectId } : {}) });
          continue;
        }
        if (!stats.isDirectory()) continue;
        directoryCount++;
        const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        const entry = entries.find(item => item.name.toLowerCase() === 'skill.md');
        if (entry) { pending.push(join(path, entry.name)); continue; }
        for (const child of entries.reverse()) {
          if ((child.name.startsWith('.') && child.name !== '.system') || child.name === 'node_modules') continue;
          if (child.isDirectory() || child.isSymbolicLink()) pending.push(join(path, child.name));
        }
      } catch { /* Unreadable, broken, or escaped links do not become available skills. */ }
    }
  }
  // A global skill cannot be labelled globally shadowed by a project-only skill.
  for (const item of found) {
    const winner = skillsForProject(found, item.projectId).find(candidate => candidate.name === item.name);
    if (item.enabled && winner?.id !== item.id && winner?.id) item.shadowedBy = winner.id;
  }
  return found;
}

/** Only one enabled skill with each command name enters a worker or its slash menu. */
export function skillsForProject(all: SkillInfo[], projectId?: string): SkillInfo[] {
  const candidates = (all as DiscoveredSkill[]).filter(item => item.enabled !== false && (!item.projectId || item.projectId === projectId));
  candidates.sort((a, b) => (priority[a.source] ?? 2) - (priority[b.source] ?? 2));
  const names = new Set<string>();
  return candidates.filter(item => { if (names.has(item.name)) return false; names.add(item.name); return true; }).map(item => {
    const { shadowedBy: _shadowedBy, ...effective } = item;
    return effective;
  });
}
