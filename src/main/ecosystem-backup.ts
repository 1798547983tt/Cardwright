import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sha256String, stableJson } from 'pi-webdav-sync/src/manifest.ts';
import { validateGatewayEffort } from '../shared/effort.ts';
import { gatewayModels, normalizeGatewayModels, resolveGatewayModel } from '../shared/gateway-models.ts';
import type { AgentRole, AppSnapshot, BackupPreview, Gateway, McpServerConfig, MemoryItem, Preferences, SearchConfig } from '../shared/types.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const PREVIEW_LIFETIME = 5 * 60 * 1000;
const REMOTE_FILE = 'cardwright-config.json';
type SafePreferences = Pick<Preferences, 'name' | 'theme' | 'language' | 'font' | 'reducedMotion' | 'notifications' | 'instructions' | 'maxConcurrent' | 'defaultGatewayId' | 'defaultModelId' | 'defaultContextWindow' | 'defaultThinking'>;
export interface BackupData {
  version: 1; createdAt: string;
  preferences: SafePreferences; gateways: Gateway[]; search: SearchConfig;
  ecosystem: { memoryEnabled: boolean; cacheEnabled: boolean; showStatusline: boolean; compactTools: boolean; roles: AgentRole[]; mcpServers: McpServerConfig[] };
  skills: Array<{ id: string; name: string; content: string }>;
  memories: Array<{ projectId: string; projectName: string; items: MemoryItem[] }>;
}
export interface BackupConnection { url: string; username: string; password: string }
export interface ConfigBackupOptions {
  dataDir: string;
  getSnapshot(): AppSnapshot;
  listMemories(): Promise<Record<string, MemoryItem[]>>;
  readSecretValues(): string[];
  /** Merge into existing state; preserve credentials, projects, tasks and schedules. */
  apply(data: BackupData & { importedSkillPaths: string[] }): Promise<void>;
}
interface PreviewReceipt { data: BackupData; digest: string; expires: number; connectionDigest?: string }
const EXCLUDES = [
  'Credentials, authentication stores, passwords, MCP headers/environment and WebDAV account settings',
  'Chat history, tool logs, projects, schedules, approval modes, workspace paths and avatar files',
  'Skill assets/scripts and files other than the selected SKILL.md documents',
  'Known stored secret values are redacted from prose. Unknown secrets embedded in instructions, skills or memories cannot be detected reliably; review these documents before uploading.',
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid backup ${label}.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unexpected field in backup ${label}.`);
}
function text(value: unknown, max: number, label: string, empty = true): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw new Error(`Invalid backup ${label}.`);
  return value;
}
function flag(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`Invalid backup ${label}.`); return value; }
function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid backup ${label}.`); return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T { if (!values.includes(value as T)) throw new Error(`Invalid backup ${label}.`); return value as T; }
function list(value: unknown, max: number, label: string): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid backup ${label}.`); return value; }
function identifier(value: unknown, label: string): string {
  const id = text(value, 100, label, false); if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid backup ${label}.`); return id;
}
function date(value: unknown): string { const result = text(value, 40, 'timestamp', false); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid backup timestamp.'); return result; }
function safeUrl(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  const input = text(value, 4096, 'endpoint', false); let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid backup endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Backup endpoints cannot contain credentials, query parameters or fragments.');
  return url.href.replace(/\/$/, '');
}
function unique<T>(values: T[], id: (value: T) => string, label: string): T[] {
  if (new Set(values.map(id)).size !== values.length) throw new Error(`Duplicate backup ${label}.`); return values;
}
function skillId(name: string, content: string): string { return sha256String(`${name}\n${content}`).slice(0, 24); }

/** Reject unknown/prototype/credential fields before any data is handed to the application. */
export function validateBackupData(input: unknown): BackupData {
  const data = object(input, 'document'); keys(data, ['version', 'createdAt', 'preferences', 'gateways', 'search', 'ecosystem', 'skills', 'memories'], 'document');
  if (data.version !== 1) throw new Error('Unsupported backup format version.');
  const pref = object(data.preferences, 'preferences'); keys(pref, ['name', 'theme', 'language', 'font', 'reducedMotion', 'notifications', 'instructions', 'maxConcurrent', 'defaultGatewayId', 'defaultModelId', 'defaultContextWindow', 'defaultThinking'], 'preferences');
  const preferences: SafePreferences = {
    name: text(pref.name, 100, 'name'), theme: choice(pref.theme, ['system', 'light', 'dark'], 'theme'), language: choice(pref.language, ['en', 'zh'], 'language'),
    font: choice(pref.font, ['sans', 'serif', 'mono'], 'font'), reducedMotion: flag(pref.reducedMotion, 'reduced motion'), notifications: flag(pref.notifications, 'notifications'),
    instructions: text(pref.instructions, 100_000, 'instructions'), maxConcurrent: number(pref.maxConcurrent, 1, 32, 'concurrency'),
    defaultGatewayId: text(pref.defaultGatewayId, 100, 'default model'), defaultThinking: choice(pref.defaultThinking, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'thinking'),
  };
  if (pref.defaultModelId !== undefined) preferences.defaultModelId = text(pref.defaultModelId, 200, 'default model ID');
  if (pref.defaultContextWindow !== undefined) preferences.defaultContextWindow = number(pref.defaultContextWindow, 1024, 10000000, 'default context window');
  const gateways = unique(list(data.gateways, 100, 'gateways').map(value => {
    const g = object(value, 'gateway'); keys(g, ['id', 'name', 'baseUrl', 'modelId', 'protocol', 'reasoning', 'contextWindow', 'maxTokens', 'hasKey', 'nativeSearch', 'effortMap', 'adaptiveThinking', 'models'], 'gateway');
    if (g.hasKey !== false) throw new Error('Backup cannot contain authenticated gateway state.');
    const gateway: Gateway = { id: identifier(g.id, 'gateway ID'), name: text(g.name, 200, 'gateway name'), baseUrl: safeUrl(g.baseUrl), modelId: text(g.modelId, 300, 'model ID', false),
      protocol: choice(g.protocol, ['openai-completions', 'openai-responses', 'anthropic-messages'], 'protocol'), reasoning: flag(g.reasoning, 'reasoning'),
      contextWindow: number(g.contextWindow, 1, 100_000_000, 'context size'), maxTokens: number(g.maxTokens, 1, 10_000_000, 'output size'), hasKey: false };
    if (g.nativeSearch !== undefined) {
      const native = object(g.nativeSearch, 'native search'); keys(native, ['enabled', 'responsesUrl'], 'native search');
      gateway.nativeSearch = { enabled: flag(native.enabled, 'native search enabled') };
      if (native.responsesUrl) {
        const endpoint = safeUrl(native.responsesUrl);
        if (new URL(endpoint).origin !== new URL(gateway.baseUrl).origin) throw new Error('Backup native search must use the gateway origin.');
        gateway.nativeSearch.responsesUrl = endpoint;
      }
    }
    if (g.effortMap !== undefined) gateway.effortMap = object(g.effortMap, 'reasoning mapping') as Gateway['effortMap'];
    if (g.adaptiveThinking !== undefined) gateway.adaptiveThinking = flag(g.adaptiveThinking, 'adaptive thinking');
    validateGatewayEffort(gateway);
    if (g.models !== undefined) gateway.models = list(g.models, 200, 'gateway models').map(value => {
      const model = object(value, 'model'); keys(model, ['id', 'name', 'reasoning', 'contextWindow', 'maxTokens', 'effortMap', 'adaptiveThinking', 'nativeSearch', 'pricing'], 'model');
      if (model.pricing !== undefined) { const price = object(model.pricing, 'model pricing'); keys(price, ['currency', 'input', 'output', 'cacheRead', 'cacheWrite'], 'model pricing'); }
      if (model.nativeSearch !== undefined) { const native = object(model.nativeSearch, 'native search'); keys(native, ['enabled', 'responsesUrl'], 'native search'); if (native.responsesUrl && new URL(safeUrl(native.responsesUrl)).origin !== new URL(gateway.baseUrl).origin) throw new Error('Backup native search must use the gateway origin.'); }
      return { ...(model.pricing ? { pricing: model.pricing as NonNullable<Gateway['pricing']> } : {}), id: text(model.id, 200, 'model ID', false), ...(model.name !== undefined ? { name: text(model.name, 120, 'model name') } : {}), reasoning: flag(model.reasoning, 'model reasoning'), contextWindow: number(model.contextWindow, 1024, 10000000, 'model context'), maxTokens: number(model.maxTokens, 1, 10000000, 'model output'), ...(model.effortMap !== undefined ? { effortMap: object(model.effortMap, 'model reasoning mapping') as Gateway['effortMap'] } : {}), ...(model.adaptiveThinking !== undefined ? { adaptiveThinking: flag(model.adaptiveThinking, 'model adaptive thinking') } : {}), ...(model.nativeSearch !== undefined ? { nativeSearch: model.nativeSearch as Gateway['nativeSearch'] } : {}) };
    });
    gateway.models = normalizeGatewayModels(gateway);
    return resolveGatewayModel(gateway, gateway.modelId);
  }), gateway => gateway.id, 'gateway IDs');
  const rawSearch = object(data.search, 'search'); keys(rawSearch, ['enabled', 'provider', 'baseUrl', 'hasKey'], 'search');
  if (rawSearch.hasKey !== false) throw new Error('Backup cannot contain authenticated search state.');
  const search: SearchConfig = { enabled: flag(rawSearch.enabled, 'search enabled'), provider: choice(rawSearch.provider, ['auto', 'native', 'exa', 'brave', 'searxng'], 'search provider'), baseUrl: safeUrl(rawSearch.baseUrl, true), hasKey: false };
  const eco = object(data.ecosystem, 'ecosystem'); keys(eco, ['memoryEnabled', 'cacheEnabled', 'showStatusline', 'compactTools', 'roles', 'mcpServers'], 'ecosystem');
  const roles: AgentRole[] = unique(list(eco.roles, 100, 'roles').map(value => {
    const role = object(value, 'role'); keys(role, ['id', 'name', 'prompt', 'readOnly', 'builtIn'], 'role');
    return { id: identifier(role.id, 'role ID'), name: text(role.name, 200, 'role name'), prompt: text(role.prompt, 100_000, 'role instructions'), readOnly: flag(role.readOnly, 'role read-only'),
      ...(role.builtIn !== undefined ? { builtIn: flag(role.builtIn, 'built-in role') } : {}) };
  }), role => role.id, 'role IDs');
  const mcpServers: McpServerConfig[] = unique(list(eco.mcpServers, 100, 'MCP servers').map(value => {
    const mcp = object(value, 'MCP server'); keys(mcp, ['id', 'name', 'enabled', 'transport', 'command', 'args', 'url', 'hasSecrets'], 'MCP server');
    if (mcp.hasSecrets !== false || mcp.enabled !== false) throw new Error('Restored MCP configurations must be disabled and contain no credentials.');
    const server: McpServerConfig = { id: identifier(mcp.id, 'MCP ID'), name: text(mcp.name, 200, 'MCP name'), enabled: false, transport: choice(mcp.transport, ['stdio', 'http'], 'MCP transport'), hasSecrets: false };
    if (server.transport === 'http') server.url = safeUrl(mcp.url);
    else {
      server.command = text(mcp.command, 4096, 'MCP command', false);
      server.args = list(mcp.args ?? [], 100, 'MCP arguments').map(arg => text(arg, 16_000, 'MCP argument'));
      if (server.args.some(arg => sensitiveArgument(arg))) throw new Error('Backup MCP arguments contain a credential-shaped option.');
    }
    return server;
  }), server => server.id, 'MCP IDs');
  const skills = unique(list(data.skills, 500, 'skills').map(value => {
    const skill = object(value, 'skill'); keys(skill, ['id', 'name', 'content'], 'skill');
    const name = text(skill.name, 200, 'skill name', false); const content = text(skill.content, MAX_SKILL_BYTES, 'skill content');
    if (Buffer.byteLength(content) > MAX_SKILL_BYTES || skill.id !== skillId(name, content)) throw new Error('Backup skill content does not match its identifier.');
    return { id: skillId(name, content), name, content };
  }), skill => skill.id, 'skills');
  let memoryCount = 0;
  const memories = unique(list(data.memories, 100, 'memory projects').map(value => {
    const group = object(value, 'memory group'); keys(group, ['projectId', 'projectName', 'items'], 'memory group');
    const items = unique(list(group.items, 1000, 'memories').map(value => {
      const memory = object(value, 'memory'); keys(memory, ['id', 'content', 'category', 'source', 'createdAt'], 'memory');
      if (++memoryCount > 1000) throw new Error('Backup supports at most 1000 memory entries.');
      const item: MemoryItem = { id: identifier(memory.id, 'memory ID'), content: text(memory.content, 32_000, 'memory content') };
      if (memory.category !== undefined) item.category = text(memory.category, 200, 'memory category');
      if (memory.source !== undefined) item.source = text(memory.source, 200, 'memory source');
      if (memory.createdAt !== undefined) item.createdAt = date(memory.createdAt);
      return item;
    }), item => item.id, 'memory IDs');
    return { projectId: identifier(group.projectId, 'project ID'), projectName: text(group.projectName, 200, 'project name'), items };
  }), group => group.projectId, 'memory groups');
  const result: BackupData = { version: 1, createdAt: date(data.createdAt), preferences, gateways, search,
    ecosystem: { memoryEnabled: flag(eco.memoryEnabled, 'memory enabled'), cacheEnabled: flag(eco.cacheEnabled, 'cache enabled'), showStatusline: flag(eco.showStatusline, 'status line'), compactTools: flag(eco.compactTools, 'compact tools'), roles, mcpServers }, skills, memories };
  if (Buffer.byteLength(stableJson(result)) > MAX_BYTES) throw new Error('Backup exceeds the 5 MB limit.');
  return result;
}

function sensitiveArgument(value: string): boolean { return /(?:^|\s)--?(?:api[-_]?key|token|password|passwd|secret|authorization|header)(?:=|\s|$)/i.test(value) || /(?:Bearer|Basic)\s+[\w+/=.-]+/i.test(value); }
function sanitizedUrl(value: string): string {
  if (!value) return ''; const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.replace(/\/$/, '');
}
function endpoint(connection: BackupConnection): string {
  const url = new URL(safeUrl(connection.url));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${REMOTE_FILE}`;
  return url.href;
}
function connectionDigest(connection: BackupConnection): string { return sha256String(stableJson({ url: endpoint(connection), username: connection.username, password: connection.password })); }

export class ConfigBackup {
  private readonly options: ConfigBackupOptions;
  private local?: PreviewReceipt;
  private remote?: PreviewReceipt;
  private busy = false;
  constructor(options: ConfigBackupOptions) { this.options = options; }

  private redact(value: string): string {
    return this.options.readSecretValues().filter(secret => typeof secret === 'string' && secret.length > 0).sort((a, b) => b.length - a.length)
      .reduce((output, secret) => output.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]'), value);
  }

  private async collect(createdAt = new Date().toISOString()): Promise<BackupData> {
    const snapshot = this.options.getSnapshot(); const p = snapshot.preferences;
    const preferences: SafePreferences = { name: this.redact(p.name), theme: p.theme, language: p.language, font: p.font, reducedMotion: p.reducedMotion, notifications: p.notifications,
      instructions: this.redact(p.instructions), maxConcurrent: p.maxConcurrent, defaultGatewayId: p.defaultGatewayId, defaultModelId: p.defaultModelId, defaultContextWindow: p.defaultContextWindow, defaultThinking: p.defaultThinking };
    const gateways = snapshot.gateways.map(g => ({ id: g.id, name: this.redact(g.name), baseUrl: sanitizedUrl(this.redact(g.baseUrl)), modelId: this.redact(g.modelId), protocol: g.protocol,
      reasoning: g.reasoning, contextWindow: g.contextWindow, maxTokens: g.maxTokens, hasKey: false, models: JSON.parse(this.redact(JSON.stringify(gatewayModels(g)))), ...(g.effortMap ? { effortMap: g.effortMap } : {}), ...(g.adaptiveThinking !== undefined ? { adaptiveThinking: g.adaptiveThinking } : {}),
      ...(g.nativeSearch ? { nativeSearch: { enabled: g.nativeSearch.enabled, ...(g.nativeSearch.responsesUrl ? { responsesUrl: sanitizedUrl(this.redact(g.nativeSearch.responsesUrl)) } : {}) } } : {}) }));
    const search = { ...snapshot.search, baseUrl: sanitizedUrl(this.redact(snapshot.search.baseUrl)), hasKey: false };
    const roles = snapshot.ecosystem.roles.map(role => ({ id: role.id, name: this.redact(role.name), prompt: this.redact(role.prompt), readOnly: role.readOnly, ...(role.builtIn !== undefined ? { builtIn: role.builtIn } : {}) }));
    const mcpServers = snapshot.ecosystem.mcpServers.map(server => {
      const args: string[] = [];
      for (let index = 0; index < (server.args?.length ?? 0); index++) {
        const arg = server.args![index];
        if (sensitiveArgument(arg)) { if (!arg.includes('=') && /^--?[\w-]+$/.test(arg)) index++; continue; }
        args.push(this.redact(arg));
      }
      return { id: server.id, name: this.redact(server.name), enabled: false, transport: server.transport, hasSecrets: false,
        ...(server.transport === 'http' ? { url: sanitizedUrl(this.redact(server.url ?? '')) } : { command: this.redact(server.command ?? ''), args }) };
    });
    if (snapshot.skills.length > 500) throw new Error('Backup supports at most 500 selected SKILL.md documents.');
    const skills: BackupData['skills'] = [];
    for (const skill of snapshot.skills) {
      // Only already selected documents; never traverse an attached resource directory.
      if (basename(skill.path).toLowerCase() !== 'skill.md') continue;
      const stats = await lstat(skill.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SKILL_BYTES) throw new Error('A selected skill is not a regular SKILL.md file within the 256 KB limit.');
      const content = this.redact(await readFile(skill.path, 'utf8')); const name = this.redact(skill.name);
      const id = skillId(name, content); if (!skills.some(skill => skill.id === id)) skills.push({ id, name, content });
    }
    const memoriesByProject = await this.options.listMemories();
    const memories = snapshot.projects.filter(project => memoriesByProject[project.id]?.length).map(project => ({ projectId: project.id, projectName: this.redact(project.name),
      items: memoriesByProject[project.id].map(memory => ({ id: memory.id, content: this.redact(memory.content), ...(memory.category ? { category: this.redact(memory.category) } : {}),
        // Memory source can contain an absolute project path or a transcript reference; keep content/category only.
        ...(memory.createdAt ? { createdAt: memory.createdAt } : {}) })) }));
    return validateBackupData({ version: 1, createdAt, preferences, gateways, search,
      ecosystem: { memoryEnabled: snapshot.ecosystem.memoryEnabled, cacheEnabled: snapshot.ecosystem.cacheEnabled, showStatusline: snapshot.ecosystem.showStatusline,
        compactTools: snapshot.ecosystem.compactTools, roles, mcpServers }, skills, memories });
  }

  private summary(data: BackupData): BackupPreview {
    return { files: ['preferences.json', 'gateways.json', 'search.json', 'ecosystem/features.json', ...data.ecosystem.roles.map(role => `roles/${role.id}.json`),
      ...data.ecosystem.mcpServers.map(server => `mcp/${server.id}.json`), ...data.skills.map(skill => `skills/${skill.id}/SKILL.md`), ...data.memories.map(group => `memories/${group.projectId}.json`)],
      bytes: Buffer.byteLength(stableJson(data)), createdAt: data.createdAt, excludes: [...EXCLUDES] };
  }

  async preview(source: 'local' | 'remote' = 'local', connection?: BackupConnection): Promise<BackupPreview> {
    const data = source === 'local' ? await this.collect() : await this.readRemote(connection);
    const receipt = { data, digest: sha256String(stableJson(data)), expires: Date.now() + PREVIEW_LIFETIME, ...(connection ? { connectionDigest: connectionDigest(connection) } : {}) };
    if (source === 'local') this.local = receipt; else this.remote = receipt;
    return this.summary(data);
  }

  private receipt(source: 'local' | 'remote', connection: BackupConnection): PreviewReceipt {
    const receipt = source === 'local' ? this.local : this.remote;
    if (!receipt || receipt.expires < Date.now()) throw new Error('Preview this backup again before continuing.');
    if (receipt.connectionDigest && receipt.connectionDigest !== connectionDigest(connection)) throw new Error('The WebDAV connection changed. Preview the backup again.');
    return receipt;
  }

  private async transfer(connection: BackupConnection, method: 'GET' | 'PUT', body?: string): Promise<Response> {
    const target = endpoint(connection);
    if (typeof connection.username !== 'string' || typeof connection.password !== 'string' || connection.username.includes(':') || /[\r\n]/.test(connection.username)) throw new Error('Invalid WebDAV credentials.');
    try {
      const response = await fetch(target, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(method === 'PUT' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}` }, body });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`WebDAV request failed (HTTP ${response.status}).`); }
      return response;
    } catch (error) {
      if (error instanceof Error && /^WebDAV request failed \(HTTP \d{3}\)\.$/.test(error.message)) throw error;
      throw new Error('WebDAV request failed. Check the connection; redirects are not followed.');
    }
  }

  private async readRemote(connection?: BackupConnection): Promise<BackupData> {
    if (!connection) throw new Error('Configure the WebDAV connection before previewing a remote backup.');
    const response = await this.transfer(connection, 'GET');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('Remote backup exceeds the 5 MB limit.'); }
    if (!response.body) throw new Error('Remote backup is empty.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_BYTES) throw new Error('Remote backup exceeds the 5 MB limit.'); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Remote backup is not valid JSON.'); }
    return validateBackupData(parsed);
  }

  async push(connection: BackupConnection): Promise<{ message: string }> {
    if (this.busy) throw new Error('Another backup operation is in progress.'); this.busy = true;
    try {
      const receipt = this.receipt('local', connection); const current = await this.collect(receipt.data.createdAt);
      if (sha256String(stableJson(current)) !== receipt.digest) throw new Error('Local settings or documents changed. Preview the backup again.');
      const body = stableJson(current);
      // The account password is never allowed into the uploaded snapshot, even if a callback omitted it.
      if (connection.password && body.includes(connection.password)) throw new Error('A document contains the WebDAV password. Remove it and preview again.');
      const response = await this.transfer(connection, 'PUT', body); await response.body?.cancel(); this.local = undefined;
      return { message: 'Configuration backup uploaded. Credentials and chat history were excluded.' };
    } finally { this.busy = false; }
  }

  async pull(connection: BackupConnection): Promise<{ message: string }> {
    if (this.busy) throw new Error('Another backup operation is in progress.'); this.busy = true;
    try {
      const receipt = this.receipt('remote', connection); const current = await this.readRemote(connection);
      if (sha256String(stableJson(current)) !== receipt.digest) throw new Error('The remote backup changed. Preview it again.');
      const importedSkillPaths: string[] = [];
      const root = resolve(this.options.dataDir); await mkdir(root, { recursive: true }); const canonicalRoot = await realpath(root);
      const skillRoot = join(canonicalRoot, 'imported-skills');
      await mkdir(skillRoot, { recursive: true });
      if ((await lstat(skillRoot)).isSymbolicLink() || await realpath(skillRoot) !== skillRoot) throw new Error('Imported skill directory must remain inside application storage.');
      for (const skill of current.skills) {
        const directory = join(skillRoot, skillId(skill.name, skill.content)); await mkdir(directory, { recursive: true });
        if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Imported skill directory contains an unsafe link.');
        const path = join(directory, 'SKILL.md');
        try { await writeFile(path, skill.content, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
          const stats = await lstat(path);
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SKILL_BYTES || await readFile(path, 'utf8') !== skill.content) throw new Error('An imported skill conflicts with an existing local file.');
        }
        importedSkillPaths.push(path);
      }
      await this.options.apply({ ...current, importedSkillPaths }); this.remote = undefined;
      return { message: 'Configuration backup restored. Existing credentials and chat history were preserved; imported MCP connections remain disabled.' };
    } finally { this.busy = false; }
  }
}
