import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { AppSnapshot, Gateway, Preferences, Task } from '../shared/types.ts';
import { parseHooks } from './hooks-config.ts';
import { validateAvatars } from './avatar.ts';
import { BUILTIN_ROLES, defaultEcosystem } from './ecosystem.ts';
import { canonicalRoleId, savedCustomRoles } from '../shared/agents.ts';
import { normalizeCardSquad } from '../shared/card-studio/squad.ts';
import { defaultEffortMap } from '../shared/effort.ts';
import { gatewayModels, normalizeGatewayModels, resolveGatewayModel } from '../shared/gateway-models.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS } from '../shared/output-limit.ts';
import { trafficSettings } from '../shared/gateway-traffic.ts';
import type { TokenTotals, UsageLedgerDay } from '../shared/usage.ts';

export type StoredState = Pick<AppSnapshot, 'preferences' | 'gateways' | 'projects' | 'tasks' | 'schedules' | 'search' | 'ecosystem' | 'hooks' | 'usageLedger'>;
export const STATE_SCHEMA_VERSION = 8;

export function defaultPreferences(): Preferences {
  let name = 'You';
  try { name = userInfo().username || name; } catch { /* A profile is optional. */ }
  return {
    name, theme: 'system', language: 'zh', font: 'sans', reducedMotion: false,
    notifications: false, instructions: '', defaultPermission: 'ask', maxConcurrent: 2,
    defaultGatewayId: '', defaultModelId: '', defaultContextWindow: 300000,
    defaultThinking: 'medium', skillPaths: [], disabledSkillIds: [], disabledAgentIds: [], enabledAgentIds: [], browserAllowed: [], avatars: {},
    soundEnabled: false, soundVolume: 40, bootSequence: false, releaseCheck: true, persona: true,
    modelAutoMatch: 'online',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 0.7.1: the untouched 8192 editor default starved reasoning models; migrate it once per gateway. */
const outputLimit = (maxTokens: number, contextWindow: number, migrate: boolean) =>
  migrate && maxTokens === LEGACY_DEFAULT_MAX_OUTPUT_TOKENS ? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow) : maxTokens;

function withoutCredential(gateway: Gateway, migrated: string[] = []): Gateway {
  const migrate = (gateway.defaultsVersion || 0) < 5;
  const migrateOutput = (gateway.defaultsVersion || 0) < 6;
  const contextWindow = migrate && ![300000, 500000, 1000000].includes(gateway.contextWindow) ? 300000 : gateway.contextWindow;
  const legacyAnthropic = gateway.protocol === 'anthropic-messages' && !gateway.adaptiveThinking;
  const effortMap = migrate && !legacyAnthropic ? { ...defaultEffortMap, ...Object.fromEntries(Object.entries(gateway.effortMap || {}).filter(([, value]) => value !== null)), ultra: 'max' } : gateway.effortMap;
  const labels: string[] = [];
  const models = Array.isArray(gateway.models) ? gateway.models.map(model => {
    const maxTokens = outputLimit(model.maxTokens, model.contextWindow, migrateOutput);
    if (maxTokens !== model.maxTokens) labels.push(`${gateway.name} / ${model.id}`);
    return { ...model, maxTokens };
  }) : gateway.models;
  const legacyMax = Math.min(gateway.maxTokens, contextWindow);
  const maxTokens = models === undefined ? outputLimit(legacyMax, contextWindow, migrateOutput) : legacyMax;
  if (models === undefined && maxTokens !== legacyMax) labels.push(`${gateway.name} / ${gateway.modelId}`);
  const safe: Gateway = {
    id: gateway.id, name: gateway.name, baseUrl: gateway.baseUrl, modelId: gateway.modelId,
    protocol: gateway.protocol, reasoning: gateway.reasoning, contextWindow,
    maxTokens, hasKey: gateway.hasKey, nativeSearch: gateway.nativeSearch, effortMap, adaptiveThinking: gateway.adaptiveThinking, defaultsVersion: 6, pricing: gateway.pricing,
    // 上游服务商, 每分钟请求上限, retries and 无响应断开, kept when readable (1.3.0 §5.4).
    ...trafficSettings(gateway),
  };
  safe.models = normalizeGatewayModels({ ...safe, models });
  migrated.push(...labels);
  return resolveGatewayModel(safe);
}

function validNotice(value: unknown): Preferences['migrationNotice'] {
  if (!isRecord(value) || value.kind !== 'output-limit' || !Array.isArray(value.models)) return undefined;
  const models = value.models.filter((item): item is string => typeof item === 'string' && item.length <= 400).slice(0, 200);
  return models.length ? { kind: 'output-limit', models } : undefined;
}

/** `renamedRoles` receives the custom roles this read moved off an id Cardwright now reserves (old id → new id). */
function parseState(value: unknown, renamedRoles = new Map<string, string>()): StoredState {
  if (!isRecord(value)) throw new Error('Saved application state must be an object.');
  const preferences = value.preferences;
  if (preferences !== undefined && !isRecord(preferences)) throw new Error('Invalid saved preferences.');
  const defaults = defaultPreferences();
  const settings = { ...defaults, ...preferences } as Preferences;
  // Keep the persisted preference surface explicit; keys and transient approvals never belong here.
  const safePreferences: Preferences = {
    name: settings.name, theme: settings.theme, language: settings.language, font: settings.font,
    reducedMotion: settings.reducedMotion, notifications: settings.notifications,
    instructions: settings.instructions, defaultPermission: settings.defaultPermission,
    maxConcurrent: settings.maxConcurrent, defaultGatewayId: settings.defaultGatewayId,
    defaultModelId: typeof settings.defaultModelId === 'string' ? settings.defaultModelId : '',
    defaultContextWindow: settings.defaultContextWindow,
    defaultThinking: settings.defaultThinking, skillPaths: settings.skillPaths, disabledSkillIds: Array.isArray(settings.disabledSkillIds) ? settings.disabledSkillIds.filter(id => typeof id === 'string') : [], disabledAgentIds: Array.isArray(settings.disabledAgentIds) ? settings.disabledAgentIds.filter(id => typeof id === 'string') : [], browserAllowed: Array.isArray(settings.browserAllowed) ? settings.browserAllowed.filter(origin => typeof origin === 'string' && /^https?:\/\//.test(origin)).slice(0, 200) : [], avatars: validateAvatars(settings.avatars),
    // A project folder's subagents the user turned on (Q25); what is not an id is dropped.
    enabledAgentIds: Array.isArray(settings.enabledAgentIds) ? settings.enabledAgentIds.filter(id => typeof id === 'string').map(id => canonicalRoleId(id)).slice(0, 500) : [],
    soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : defaults.soundEnabled,
    soundVolume: Number.isInteger(settings.soundVolume) && settings.soundVolume >= 0 && settings.soundVolume <= 100 ? settings.soundVolume : defaults.soundVolume,
    // 小绘的性格: absent or unreadable means on (§5.4).
    persona: typeof settings.persona === 'boolean' ? settings.persona : true,
    // models.dev auto-match: an unknown mode falls back to the default, online.
    modelAutoMatch: settings.modelAutoMatch === 'local' || settings.modelAutoMatch === 'off' ? settings.modelAutoMatch : 'online',
  };
  const notice = validNotice(settings.migrationNotice);
  if (notice) safePreferences.migrationNotice = notice;
  // Card studio settings: the new-conversation threshold and developer mode.
  const handoff = settings.cardHandoff as unknown;
  if (isRecord(handoff) && Number.isInteger(handoff.tokens) && Number.isInteger(handoff.windowPercent) && (handoff.tokens as number) >= 10_000 && (handoff.tokens as number) <= 10_000_000 && (handoff.windowPercent as number) >= 10 && (handoff.windowPercent as number) <= 90) {
    safePreferences.cardHandoff = { tokens: handoff.tokens as number, windowPercent: handoff.windowPercent as number, ...(handoff.enabled === false ? { enabled: false } : {}) };
  }
  if (typeof settings.developerMode === 'boolean') safePreferences.developerMode = settings.developerMode;
  // 工坊小队 (spec §5.4): kept when the mode is known; a missing 自行组队 is on, anything else means the default.
  const squad = normalizeCardSquad(settings.cardSquad);
  if (squad) safePreferences.cardSquad = squad;
  for (const key of ['notifyFinished', 'notifyApproval', 'bootSequence', 'quietUpgrade', 'releaseCheck'] as const) if (typeof settings[key] === 'boolean') safePreferences[key] = settings[key] as boolean;
  const result: StoredState = {
    preferences: safePreferences, gateways: [], projects: [], tasks: [], schedules: [],
    search: { enabled: true, provider: 'auto', baseUrl: '', hasKey: false }, ecosystem: defaultEcosystem(),
    // Hooks run the user's own commands, so anything unreadable is dropped rather than guessed at.
    hooks: parseHooks(value.hooks).hooks,
  };
  // The usage ledger holds counts only; anything unreadable is dropped rather than guessed at.
  if (Array.isArray(value.usageLedger)) {
    const totals = (raw: unknown): TokenTotals | undefined => {
      if (!isRecord(raw)) return undefined;
      const read = (key: string) => Number.isFinite(raw[key]) && (raw[key] as number) >= 0 ? raw[key] as number : 0;
      return { input: read('input'), output: read('output'), cacheRead: read('cacheRead'), cacheWrite: read('cacheWrite'), total: read('total') };
    };
    const days: UsageLedgerDay[] = [];
    for (const entry of value.usageLedger) {
      if (!isRecord(entry) || typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
      const tokens = totals(entry.tokens);
      if (!tokens) continue;
      const models = Array.isArray(entry.models) ? entry.models.flatMap(item => {
        if (!isRecord(item)) return [];
        const modelTokens = totals(item.tokens);
        if (!modelTokens) return [];
        return [{ model: typeof item.model === 'string' ? item.model : null, tokens: modelTokens, responses: Number(item.responses) || 0, unreported: Number(item.unreported) || 0 }];
      }) : [];
      days.push({ date: entry.date, tokens, messages: Number(entry.messages) || 0, responses: Number(entry.responses) || 0, unreported: Number(entry.unreported) || 0, models });
    }
    if (days.length) result.usageLedger = days;
  }
  if (isRecord(value.search)) {
    result.search = {
      enabled: value.search.enabled === true,
      provider: ['auto', 'native', 'exa', 'brave', 'searxng'].includes(String(value.search.provider)) ? value.search.provider as AppSnapshot['search']['provider'] : 'auto',
      baseUrl: typeof value.search.baseUrl === 'string' ? value.search.baseUrl : '',
      hasKey: value.search.hasKey === true,
    };
  }
  if (isRecord(value.ecosystem)) {
    const config = value.ecosystem;
    for (const key of ['memoryEnabled', 'cacheEnabled', 'showStatusline', 'compactTools'] as const) if (typeof config[key] === 'boolean') result.ecosystem[key] = config[key];
    if (Array.isArray(config.roles)) {
      const saved = config.roles.map(item => {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.prompt !== 'string') throw new Error('Invalid saved agent role.');
        // 说明 (§5.1): a role's description survives a save and a load; the built-in roles take theirs from the app below.
        const description = typeof item.description === 'string' ? item.description.trim().slice(0, 300) : '';
        return { id: item.id, name: String(item.name), prompt: item.prompt, readOnly: item.readOnly === true, builtIn: item.builtIn === true, ...(description ? { description } : {}) };
      });
      // 1.3.0 (§5.1): the built-in roles are always the app's own executor / explorer / planner; custom roles stay.
      const custom = savedCustomRoles(saved);
      result.ecosystem.roles = [...structuredClone(BUILTIN_ROLES), ...custom.roles];
      for (const [from, to] of custom.renamed) renamedRoles.set(from, to);
    }
    if (Array.isArray(config.mcpServers)) result.ecosystem.mcpServers = config.mcpServers.map(item => {
      if (!isRecord(item) || typeof item.id !== 'string') throw new Error('Invalid saved MCP server.');
      return { id: item.id, name: String(item.name), enabled: item.enabled === true, transport: item.transport === 'stdio' ? 'stdio' : 'http', command: typeof item.command === 'string' ? item.command : undefined, args: Array.isArray(item.args) ? item.args.map(String) : undefined, url: typeof item.url === 'string' ? item.url : undefined, hasSecrets: item.hasSecrets === true };
    });
    if (isRecord(config.webdav)) result.ecosystem.webdav = { url: String(config.webdav.url || ''), username: String(config.webdav.username || ''), hasPassword: config.webdav.hasPassword === true };
  } else if (isRecord(value.search) && !value.search.enabled && !value.search.hasKey && !value.search.baseUrl) {
    result.search = { enabled: true, provider: 'auto', baseUrl: '', hasKey: false };
  }
  // A role id from before 1.3 reads as its new id; a custom role that moved off a reserved id takes its switch along.
  const roleId = (id: string) => renamedRoles.get(id) ?? canonicalRoleId(id);
  safePreferences.disabledAgentIds = [...new Set((safePreferences.disabledAgentIds ?? []).map(roleId))];
  for (const key of ['gateways', 'projects', 'tasks', 'schedules'] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some(entry => !isRecord(entry) || typeof entry.id !== 'string')) {
      throw new Error(`Invalid saved ${key}. The original state file has been preserved.`);
    }
    if (key === 'gateways') {
      const migrated: string[] = [];
      result.gateways = (entries as Gateway[]).map(gateway => withoutCredential(gateway, migrated));
      if (migrated.length) safePreferences.migrationNotice = { kind: 'output-limit', models: [...new Set([...(safePreferences.migrationNotice?.models ?? []), ...migrated])].slice(0, 200) };
    }
    if (key === 'projects') result.projects = entries as StoredState['projects'];
    if (key === 'schedules') result.schedules = entries as StoredState['schedules'];
    if (key === 'tasks') {
      if (entries.some(entry => !isRecord(entry) || !Array.isArray(entry.messages) || !Array.isArray(entry.tools))) {
        throw new Error('Invalid saved tasks. The original state file has been preserved.');
      }
      // 网络状态 (§5.5) belongs to a request in flight: never written, never read back.
      result.tasks = (entries as Task[]).map(task => { if (task.net === undefined) return task; const { net: _net, ...rest } = task; return rest; });
      for (const task of result.tasks) if (typeof task.role === 'string') task.role = roleId(task.role);
    }
  }
  const defaultGateway = result.gateways.find(gateway => gateway.id === safePreferences.defaultGatewayId);
  if (defaultGateway) {
    if (!safePreferences.defaultModelId) safePreferences.defaultModelId = defaultGateway.modelId;
    if (!isRecord(preferences) || preferences.defaultContextWindow === undefined) {
      const model = gatewayModels(defaultGateway).find(item => item.id === safePreferences.defaultModelId);
      safePreferences.defaultContextWindow = model?.contextWindow ?? defaultGateway.contextWindow;
    }
  }
  // Pin legacy records once. A later default change must not reroute a saved task or schedule.
  // Explicit selections remain intact even if their model was removed: execution can explain it.
  for (const item of [...result.tasks, ...result.schedules]) {
    const gateway = result.gateways.find(entry => entry.id === item.gatewayId);
    if (!gateway) continue;
    if (!item.modelId) item.modelId = gateway.modelId;
    if (item.contextWindow === undefined) {
      const model = gatewayModels(gateway).find(entry => entry.id === item.modelId);
      item.contextWindow = model?.contextWindow ?? gateway.contextWindow;
    }
  }
  return result;
}

export class AppStore {
  readonly dataDir: string;
  readonly filePath: string;
  readonly state: StoredState;
  readonly migrationBackup?: string;
  /** Custom roles this load moved off an id Cardwright now reserves (old id → new id), so studio.json's role models can follow. */
  readonly renamedRoles: ReadonlyMap<string, string>;
  onSaveError?: (error: Error) => void;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSave?: Promise<void>;
  private dirty = false;
  private revision = 0;
  private criticalEpoch = 0;
  private error?: Error;

  get lastSaveError(): Error | undefined { return this.error; }

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.filePath = join(this.dataDir, 'state.json');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    let saved: unknown = {};
    let original: string | undefined;
    try {
      original = readFileSync(this.filePath, 'utf8');
      saved = JSON.parse(original) as unknown;
    } catch (error) {
      if (!(isRecord(error) && error.code === 'ENOENT')) {
        throw new Error(`Cannot load ${this.filePath}. The original file has been preserved.`, { cause: error });
      }
    }
    const renamedRoles = new Map<string, string>();
    this.state = parseState(saved, renamedRoles);
    this.renamedRoles = renamedRoles;
    if (original !== undefined && (!isRecord(saved) || Number(saved.schemaVersion || 0) < STATE_SCHEMA_VERSION)) {
      const backups = join(this.dataDir, 'backups');
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      this.migrationBackup = join(backups, `state-before-0.7-${createHash('sha256').update(original).digest('hex').slice(0, 20)}.json`);
      try { writeFileSync(this.migrationBackup, original, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
      catch (error) { if (!(isRecord(error) && error.code === 'EEXIST')) throw new Error('Could not back up the previous application state. The original file was preserved.', { cause: error }); }
    }
    let repaired = false;
    const at = new Date().toISOString();
    for (const task of this.state.tasks) {
      if (task.status !== 'running' && task.status !== 'queued' && task.status !== 'waiting') continue;
      task.status = 'failed';
      task.error = 'This task was interrupted when Cardwright closed. Resume explicitly to continue.';
      // A message still queued never went out and nothing will send it now; left pending, it would stay below every later message.
      for (const message of task.messages) if (message.pending) message.pending = false;
      task.updatedAt = at;
      for (const tool of task.tools) {
        if (tool.status === 'running' || tool.status === 'waiting') {
          tool.status = 'failed';
          tool.output = `${tool.output}${tool.output ? '\n' : ''}Interrupted when Cardwright closed.`;
        }
      }
      repaired = true;
    }
    if (repaired) this.save();
  }

  save(): void {
    this.clearSaveTimer();
    this.revision++;
    this.criticalEpoch++;
    this.dirty = true;
    const snapshot = parseState(this.state);
    const temporaryPath = join(this.dataDir, `.state-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, this.serialize(snapshot), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporaryPath, this.filePath);
      this.dirty = false;
      this.error = undefined;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  /** Coalesce streams; the deadline is not reset by every token. */
  requestSave(delay = 750): void {
    this.dirty = true;
    this.revision++;
    if (this.saveTimer || this.pendingSave) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.writePending().catch(error => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onSaveError?.(this.error);
      });
    }, Math.max(0, Math.min(5000, delay)));
    this.saveTimer.unref();
  }

  /** Await this after workers stop and before quitting, exporting or backing up. */
  async flush(): Promise<void> {
    this.clearSaveTimer();
    if (this.pendingSave) await this.pendingSave;
    while (this.dirty) { this.clearSaveTimer(); await this.writePending(); }
  }

  private clearSaveTimer(): void { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = undefined; }
  private serialize(snapshot = parseState(this.state)): string { return JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, ...snapshot }) + '\n'; }

  private async writePending(): Promise<void> {
    if (this.pendingSave) return this.pendingSave;
    if (!this.dirty) return;
    const revision = this.revision;
    const epoch = this.criticalEpoch;
    const text = this.serialize();
    const temporaryPath = join(this.dataDir, `.state-${randomUUID()}.tmp`);
    const write = async () => {
      try {
        await writeFile(temporaryPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        // A critical synchronous save can run during the asynchronous write.
        // The check and atomic rename are one JS turn, so an old write cannot
        // land after the newer critical snapshot.
        if (epoch === this.criticalEpoch) {
          renameSync(temporaryPath, this.filePath);
          this.dirty = revision !== this.revision;
          this.error = undefined;
        }
      } catch (error) {
        this.error = error instanceof Error ? error : new Error(String(error));
        throw this.error;
      } finally { await rm(temporaryPath, { force: true }); }
    };
    this.pendingSave = write();
    try { await this.pendingSave; }
    finally {
      this.pendingSave = undefined;
      // Flush owns immediate retries; ordinary ongoing streams get another
      // bounded save window. Failures remain visible and retry on new activity.
      if (this.dirty && !this.error) this.requestSave();
    }
  }
}
