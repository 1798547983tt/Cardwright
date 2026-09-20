import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { DiscoveredAgent } from '../shared/agents.ts';
export type { DiscoveredAgent } from '../shared/agents.ts';

const MAX_BYTES = 128 * 1024;
const ROOT_NAMES = ['.claude', '.agents'];
/** Tools that can change this computer; an agent without any of them is a read-only subagent. */
const WRITING = /^(write|edit|multiedit|notebookedit|bash|powershell|shell|command|host_command|terminal)$/i;

function parseAgent(text: string): { name: string; description: string; prompt: string; tools?: string[]; model?: string } | undefined {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return undefined;
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) return undefined;
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  const prompt = normalized.slice(match[0].length).trim();
  if (!name || name.length > 64 || /[\s/:\\<>\0]/.test(name) || !description || description.length > 2_000 || !prompt) return undefined;
  const tools = typeof fields.tools === 'string' ? fields.tools.split(',').map(item => item.trim()).filter(Boolean)
    : Array.isArray(fields.tools) ? fields.tools.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined;
  const model = typeof fields.model === 'string' && fields.model.trim() ? fields.model.trim() : undefined;
  return { name, description, prompt, ...(tools?.length ? { tools } : {}), ...(model ? { model } : {}) };
}

/** Reads `<project>/.claude/agents/*.md` and `~/.claude/agents/*.md`; anything unreadable is simply not a subagent. */
export function discoverAgents(options: { projects: Array<{ id: string; path: string }>; homeDir?: string; limit?: number }): DiscoveredAgent[] {
  const limit = options.limit ?? 200;
  const roots: Array<{ dir: string; source: 'project' | 'user'; projectId?: string }> = [
    ...options.projects.flatMap(project => ROOT_NAMES.map(name => ({ dir: join(project.path, name, 'agents'), source: 'project' as const, projectId: project.id }))),
    ...ROOT_NAMES.map(name => ({ dir: join(options.homeDir ?? homedir(), name, 'agents'), source: 'user' as const })),
  ];
  const found: DiscoveredAgent[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (found.length >= limit) break;
    let entries: string[];
    try { entries = readdirSync(root.dir).filter(name => name.toLowerCase().endsWith('.md')).sort((a, b) => a.localeCompare(b)); }
    catch { continue; }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const path = join(root.dir, entry);
      try {
        const stats = statSync(path);
        if (!stats.isFile() || stats.size > MAX_BYTES) continue;
        const parsed = parseAgent(readFileSync(path, 'utf8'));
        if (!parsed) continue;
        const id = root.source === 'project' ? `agent:project:${root.projectId}:${parsed.name}` : `agent:user:${parsed.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({ ...parsed, id, readOnly: !!parsed.tools && !parsed.tools.some(tool => WRITING.test(tool)), source: root.source, path, ...(root.projectId ? { projectId: root.projectId } : {}) });
      } catch { /* Unreadable files are not subagents. */ }
    }
  }
  return found;
}
