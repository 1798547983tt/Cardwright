import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { AppSnapshot, Gateway, Preferences, Task } from '../shared/types.ts';
import { parseHooks } from './hooks-config.ts';
import { validateAvatars } from './avatar.ts';
import { defaultEcosystem } from './ecosystem.ts';
import { defaultEffortMap } from '../shared/effort.ts';
import { gatewayModels, normalizeGatewayModels, resolveGatewayModel } from '../shared/gateway-models.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS } from '../shared/output-limit.ts';

export type StoredState = Pick<AppSnapshot, 'preferences' | 'gateways' | 'projects' | 'tasks' | 'schedules' | 'search' | 'ecosystem' | 'hooks'>;
export const STATE_SCHEMA_VERSION = 7;

export function defaultPreferences(): Preferences {
  let name = 'You';
  try { name = userInfo().username || name; } catch { /* A profile is optional. */ }
  return {
    name, theme: 'system', language: 'zh', font: 'sans', reducedMotion: false,
    notifications: false, instructions: '', defaultPermission: 'ask', maxConcurrent: 2,
    defaultGatewayId: '', defaultModelId: '', defaultContextWindow: 300000,
    defaultThinking: 'medium', skillPaths: [], disabledSkillIds: [], disabledAgentIds: [], browserAllowed: [], avatars: {},
    soundEnabled: false, soundVolume: 40, bootSequence: false,
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

function parseState(value: unknown): StoredState {
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
    soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : defaults.soundEnabled,
    soundVolume: Number.isInteger(settings.soundVolume) && settings.soundVolume >= 0 && settings.soundVolume <= 100 ? settings.soundVolume : defaults.soundVolume,
  };
  const notice = validNotice(settings.migrationNotice);
  if (notice) safePreferences.migrationNotice = notice;
  // Card studio settings: the new-conversation threshold and developer mode.
  const handoff = settings.cardHandoff as unknown;
  if (isRecord(handoff) && Number.isInteger(handoff.tokens) && Number.isInteger(handoff.windowPercent) && (handoff.tokens as number) >= 10_000 && (handoff.tokens as number) <= 10_000_000 && (handoff.windowPercent as number) >= 10 && (handoff.windowPercent as number) <= 90) {
    safePreferences.cardHandoff = { tokens: handoff.tokens as number, windowPercent: handoff.windowPercent as number };
  }
  if (typeof settings.developerMode === 'boolean') safePreferences.developerMode = settings.developerMode;
  for (const key of ['notifyFinished', 'notifyApproval', 'bootSequence', 'quietUpgrade'] as const) if (typeof settings[key] === 'boolean') safePreferences[key] = settings[key] as boolean;
  const result: StoredState = {
    preferences: safePreferences, gateways: [], projects: [], tasks: [], schedules: [],
    search: { enabled: true, provider: 'auto', baseUrl: '', hasKey: false }, ecosystem: defaultEcosystem(),
    // Hooks run the user's own commands, so anything unreadable is dropped rather than guessed at.
    hooks: parseHooks(value.hooks).hooks,
  };
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
    if (Array.isArray(config.roles)) result.ecosystem.roles = config.roles.map(item => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.prompt !== 'string') throw new Error('Invalid saved agent role.');
      return { id: item.id, name: String(item.name), prompt: item.prompt, readOnly: item.readOnly === true, builtIn: item.builtIn === true };
    });
    if (Array.isArray(config.mcpServers)) result.ecosystem.mcpServers = config.mcpServers.map(item => {
      if (!isRecord(item) || typeof item.id !== 'string') throw new Error('Invalid saved MCP server.');
      return { id: item.id, name: String(item.name), enabled: item.enabled === true, transport: item.transport === 'stdio' ? 'stdio' : 'http', command: typeof item.command === 'string' ? item.command : undefined, args: Array.isArray(item.args) ? item.args.map(String) : undefined, url: typeof item.url === 'string' ? item.url : undefined, hasSecrets: item.hasSecrets === true };
    });
    if (isRecord(config.webdav)) result.ecosystem.webdav = { url: String(config.webdav.url || ''), username: String(config.webdav.username || ''), hasPassword: config.webdav.hasPassword === true };
  } else if (isRecord(value.search) && !value.search.enabled && !value.search.hasKey && !value.search.baseUrl) {
    result.search = { enabled: true, provider: 'auto', baseUrl: '', hasKey: false };
  }
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
      result.tasks = entries as Task[];
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
    this.state = parseState(saved);
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
