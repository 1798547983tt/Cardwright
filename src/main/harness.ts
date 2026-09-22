import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { initPrompt } from '../shared/init-prompt.ts';
import { chapterTitle } from '../shared/chapters.ts';
import { discoverAgents } from '../core/agents.ts';
import { countHooks, hooksFor, parseHooks, type HookEvent, type HooksConfig } from '../core/hooks-config.ts';
import { runHooks, type HookInput, type HookOutcome } from './hooks.ts';
import type { BrowserBridge } from './browser-bridge.ts';
import { mergeAgents, usableAgents, type DiscoveredAgent } from '../shared/agents.ts';
import { dirname, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { AppStore } from '../core/store.ts';
import { addProjectInfo, canCreateIsolatedTasks, createWorktree, getDiff, mergeWorktree } from '../core/git.ts';
import { evaluateSchedule, nextRunAfter } from '../core/scheduler.ts';
import { validateAvatars } from '../core/avatar.ts';
import { ecosystemSearch, nativeSearchEndpoint } from '../runtime/ecosystem-web.ts';
import { MEMORY_CATEGORIES, ProjectMemory } from '../runtime/ecosystem-memory.ts';
import { discoverSkills, skillsForProject } from '../core/skills.ts';
import { defaultEffortMap, effectiveEffort, validateGatewayEffort } from '../shared/effort.ts';
import { gatewayModels, normalizeGatewayModels, resolveGatewayModel } from '../shared/gateway-models.ts';
import { fetchModelCatalog } from '../core/model-catalog.ts';
import { selectRevision, startRevision } from '../core/conversation-revisions.ts';
import { mapLegacyUserMessages, type ConversationEntry } from '../runtime/conversation-history.ts';
import type { StudioServices } from './studio-services.ts';
import type { CardStudioService } from './card-studio.ts';
import { sectionLabel } from '../shared/card-studio/boards.ts';
import { budgetUsage, exceededBudget } from '../core/task-budget.ts';
import { getEcosystemSkillPaths } from '../runtime/ecosystem-skills.ts';
import { defaultEcosystem, extensionManifest } from '../core/ecosystem.ts';
import { ConfigBackup, type BackupData } from './ecosystem-backup.ts';
import type { Vault } from './vault.ts';
import type { CardHandoffState, CardRun, CardSettings } from '../shared/card-studio/types.ts';
import type { AppSnapshot, AgentRole, Approval, BrowserState, EcosystemConfig, FromWorker, Gateway, Interaction, McpServerConfig, MemoryItem, NewSchedule, NewTask, PermissionMode, Preferences, Project, Schedule, SearchConfig, SearchOutput, SkillInfo, Task, ThinkingLevel, ToWorker } from '../shared/types.ts';

const terminal = new Set(['idle', 'completed', 'failed', 'cancelled']);
const permissions = new Set<PermissionMode>(['ask', 'edit', 'full']);
const levels = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const stamp = () => new Date().toISOString();
const CARD_BUSY = '这张卡有另一个对话正在运行。同一张卡同一时间只运行一个对话，请等它结束或先停止它。';
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
/** A message still queued when its task stops never goes out; left pending, every later message would be placed above it. */
function unqueue(task: Task): void { for (const message of task.messages) if (message.pending) message.pending = false; }
function contentText(value: unknown, type = 'text'): string {
  if (!Array.isArray(value)) return '';
  return value.map(object).filter(item => item.type === type).map(item => string(item[type])).join('\n');
}
interface Running { child: ChildProcess; ready: boolean; cancelling: boolean; started: boolean; killTimer?: ReturnType<typeof setTimeout> }
interface Waiting { parentId: string; requestId: string; taskIds: string[] }

export class Harness extends EventEmitter {
  readonly store: AppStore;
  readonly dataDir: string;
  private vault: Vault;
  private workerPath: string;
  private workers = new Map<string, Running>();
  private studio?: StudioServices;
  private cardStudio?: CardStudioService;
  private starting = new Set<string>();
  private budgetBaselines = new Map<string, ReturnType<typeof budgetUsage>>();
  private budgetStarts = new Map<string, number>(); private budgetStopping = new Set<string>();
  private retiring = new Map<string, { child: ChildProcess; finished: Promise<void> }>();
  private admissions = new Map<string, number>();
  private prompts = new Map<string, Extract<ToWorker, { type: 'prompt' }>>();
  private approvals = new Map<string, Approval>();
  private interactions = new Map<string, Interaction>();
  /** Questions the app itself asks inside a task, such as before submitting a form; no worker waits on these. */
  private localAnswers = new Map<string, (answer: unknown) => void>();
  readonly backup: ConfigBackup;
  private waiters = new Map<string, Waiting>();
  private skills: SkillInfo[] = [];
  /** Subagents found under .claude/agents; refreshed with the skills. */
  private agents: DiscoveredAgent[] = [];
  /** The built-in browser, attached by the main process once the window exists (§6.4). */
  private browser?: BrowserBridge;
  private browserState?: BrowserState;
  private streaming = new Map<string, string>();
  private timer: ReturnType<typeof setInterval>;
  private lastTick = 0;
  private tickRunning = false;
  private admittingSchedules = new Set<string>();
  private cancellationEpochs = new Map<string, number>();
  private changedTimer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private bootPaused = false;
  constructor(dataDir: string, workerPath: string, vault: Vault, options: { paused?: boolean } = {}) {
    super();
    this.bootPaused = !!options.paused;
    this.dataDir = dataDir;
    this.workerPath = workerPath;
    this.vault = vault;
    this.store = new AppStore(dataDir);
    this.store.onSaveError = () => this.emit('change', this.publicView());
    this.backup = new ConfigBackup({ dataDir, getSnapshot: () => this.snapshot(), readSecretValues: () => this.secretValues(),
      listMemories: async () => Object.fromEntries(await Promise.all(this.store.state.projects.map(async p => [p.id, await this.listMemories(p.id)]))),
      apply: async data => this.applyBackup(data),
    });
    this.refreshSkills();
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  publicView(): AppSnapshot {
    const ecosystem = { ...this.store.state.ecosystem, roles: this.roles(), mcpServers: this.store.state.ecosystem.mcpServers.map(s => ({ ...s, hasSecrets: this.vault.has(`mcp:${s.id}`) })), webdav: { ...this.store.state.ecosystem.webdav, hasPassword: this.vault.has('webdav:password') } };
    return { ...this.store.state, storageError: this.store.lastSaveError?.message, tasks: this.store.state.tasks.map(task => ({ ...task, workerActive: this.workers.has(task.id) || this.retiring.has(task.id) || this.starting.has(task.id) })), studio: this.studio?.snapshot(), cardStudio: this.cardStudio?.snapshot(), ecosystem, extensions: extensionManifest(ecosystem, this.store.state.search), interactions: [...this.interactions.values()], search: { ...this.store.state.search, hasKey: this.vault.has('search:brave') }, gateways: this.store.state.gateways.map(g => ({ ...g, hasKey: this.vault.has(g.id) })), approvals: [...this.approvals.values()], skills: this.skills, browser: this.browserState, version: '0.9.1' };
  }
  snapshot(): AppSnapshot { return structuredClone(this.publicView()); }
  attachStudio(studio: StudioServices): void { this.studio = studio; }
  attachCardStudio(service: CardStudioService): void { this.cardStudio = service; }
  attachBrowser(browser: BrowserBridge): void { this.browser = browser; }
  /** The window tells the app what the browser looks like now; the renderer draws the tabs and the address bar. */
  publishBrowser(state: BrowserState): void { this.browserState = state; this.changed(); }
  /** Origins the built-in browser may open without asking again. */
  allowBrowserOrigin(origin: string): void {
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) throw new Error('Not an origin.');
    const allowed = new Set(this.store.state.preferences.browserAllowed ?? []);
    allowed.add(origin);
    this.store.state.preferences.browserAllowed = [...allowed].slice(-200);
    this.changed();
  }
  /** Asks the user inside a running task and waits for the answer; the conversation shows it like any other question. */
  private askInTask(task: Task, interaction: Omit<Interaction, 'id' | 'taskId'>): Promise<unknown> {
    const id = randomUUID();
    const item = { ...interaction, id, taskId: task.id } as Interaction;
    this.interactions.set(id, item);
    task.status = 'waiting'; this.changed(); this.emit('interaction', structuredClone(item));
    return new Promise(resolve => this.localAnswers.set(id, resolve));
  }
  /** One browser tool call from a worker. The window owns the pages; this only forwards and reports (§6.4). */
  private async browserRequest(task: Task, args: Record<string, unknown>): Promise<unknown> {
    const browser = this.browser;
    if (!browser) throw new Error('这个版本里没有内置浏览器。');
    if (task.card) throw new Error('制卡工坊的对话不使用浏览器。');
    const action = String(args.action ?? '');
    const tabId = args.tabId === undefined ? undefined : String(args.tabId);
    switch (action) {
      case 'open': {
        const result = await browser.open(String(args.url ?? ''), { tabId });
        if ('needsPermission' in result) return `这个网站要你同意才能打开。右栏的浏览器里有一张卡片问「是否允许 ${result.needsPermission}」，等用户点了再试一次。`;
        return { tabId: result.tabId, ok: true };
      }
      case 'read': return await browser.readText(tabId);
      case 'structure': return await browser.structure(tabId);
      case 'find': return await browser.find(String(args.text ?? ''), tabId);
      case 'click': {
        const ref = String(args.ref ?? '');
        // Submitting a form is the user's decision, not the agent's (§6.4).
        if (await browser.submits(ref, tabId)) {
          const allowed = await this.askInTask(task, { type: 'confirm', title: '提交这个表单？ / Submit this form?', body: `Agent 要点的是一个提交按钮（${ref}）。提交后网站就收到了这份表单。` });
          if (allowed !== true) return '用户没有同意提交这个表单。换一种做法，或者请用户自己提交。';
        }
        return await browser.click(ref, tabId);
      }
      case 'type': return await browser.type(String(args.ref ?? ''), String(args.text ?? ''), tabId);
      case 'screenshot': return await browser.screenshot(tabId);
      case 'console': return browser.consoleLines(tabId);
      case 'network': return browser.networkLines(tabId);
      default: throw new Error(`浏览器没有 ${action} 这个动作。`);
    }
  }
  publishCardStudio(): void { if (!this.closing) this.emit('change', this.publicView()); }
  resumeStartup(): void { this.bootPaused = false; this.pump(); void this.tick(); }
  resumeAfterFailedUpdate(): void {
    if (!this.closing) return;
    this.studio?.resumeAfterFailedUpdate();
    this.closing = false; this.bootPaused = false;
    this.timer = setInterval(() => void this.tick(), 5000); this.timer.unref();
    this.changed(); this.pump(); void this.tick();
  }
  publishStudio(immediate = true): void { this.changed(immediate); this.pump(); }
  connection(gatewayId: string, modelId?: string) { return { gateway: resolveGatewayModel(this.gateway(gatewayId), modelId), apiKey: this.vault.get(gatewayId) }; }
  private changed(immediate = true): void {
    if (immediate) {
      if (this.changedTimer) clearTimeout(this.changedTimer);
      this.changedTimer = undefined;
      this.store.save();
      this.emit('change', this.publicView());
    } else if (!this.changedTimer) {
      this.store.requestSave();
      this.changedTimer = setTimeout(() => { this.changedTimer = undefined; this.emit('change', this.publicView()); }, 100);
    }
  }
  private task(id: string): Task {
    const result = this.store.state.tasks.find(t => t.id === id);
    if (!result) throw new Error('Task not found.');
    return result;
  }
  private gateway(id: string): Gateway {
    const result = this.store.state.gateways.find(g => g.id === id);
    if (!result) throw new Error('Configure a model gateway in Settings first.');
    return result;
  }
  private runtimeGateway(task: Pick<Task, 'gatewayId' | 'modelId' | 'contextWindow'>): Gateway {
    return resolveGatewayModel(this.gateway(task.gatewayId), task.modelId, task.contextWindow);
  }
  private networkOrigins(gateway: Gateway): string[] {
    const values = [gateway.baseUrl, gateway.nativeSearch?.responsesUrl, this.store.state.search.baseUrl, 'https://mcp.exa.ai', 'https://api.search.brave.com', ...this.store.state.ecosystem.mcpServers.filter(server => server.enabled && server.transport === 'http').map(server => server.url)];
    return [...new Set(values.flatMap(value => { try { return value ? [new URL(value).origin] : []; } catch { return []; } }))];
  }
  private directoryBusy(candidate: Task): boolean {
    return this.store.state.tasks.some(other => {
      if (other.id === candidate.id || other.cwd.toLowerCase() !== candidate.cwd.toLowerCase() || (terminal.has(other.status) && !this.retiring.has(other.id) && !this.workers.has(other.id) && !this.starting.has(other.id))) return false;
      const shared = (task: Task) => !!(task.sharedReadOnly || task.sharedWorkspace);
      if (shared(candidate) && candidate.parentId && (other.id === candidate.parentId || (shared(other) && other.parentId === candidate.parentId))) return false;
      if (shared(other) && other.parentId === candidate.id) return false;
      return true;
    });
  }
  private async waitForDirectoryRelease(cwd: string): Promise<void> {
    await Promise.all([...this.retiring.entries()].filter(([id]) => this.task(id).cwd.toLowerCase() === cwd.toLowerCase()).map(([, value]) => value.finished));
  }
  async addProject(path: string) {
    const info = await addProjectInfo(path);
    const existing = this.store.state.projects.find(p => p.path.toLowerCase() === info.path.toLowerCase());
    if (existing?.kind === 'card') throw new Error('This folder is a card studio project. Open it from the card library. / 这个文件夹是制卡工坊的卡项目，请在卡库里打开。');
    if (existing) return existing;
    const project = { ...info, id: randomUUID(), createdAt: stamp() };
    this.store.state.projects.push(project);
    this.refreshSkills();
    this.changed();
    return project;
  }
  updateProject(id: string, changes: { name?: string; collapsed?: boolean; pinned?: boolean }): void {
    const project = this.store.state.projects.find(project => project.id === id);
    if (!project) throw new Error('Project not found.');
    if (changes.name !== undefined) { if (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 160) throw new Error('Enter a project name of 1–160 characters.'); project.name = changes.name.trim(); }
    for (const key of ['collapsed', 'pinned'] as const) if (changes[key] !== undefined) { if (typeof changes[key] !== 'boolean') throw new Error('Invalid project preference.'); project[key] = changes[key]; }
    this.changed();
  }
  /** Card projects are plain folders: no Git detection, no worktrees, listed only by the card library. */
  async registerCardProject(path: string, name: string): Promise<Project> {
    const directory = await realpath(resolve(path));
    if (!(await stat(directory)).isDirectory()) throw new Error('请选择卡项目文件夹。');
    const existing = this.store.state.projects.find(project => project.path.toLowerCase() === directory.toLowerCase());
    if (existing) { if (existing.kind !== 'card') throw new Error('这个文件夹已经作为普通项目添加过，请换一个文件夹。'); return existing; }
    const project: Project = { id: randomUUID(), name, path: directory, isGit: false, createdAt: stamp(), kind: 'card' };
    this.store.state.projects.push(project);
    this.refreshSkills();
    this.changed();
    return project;
  }
  /** Removes the registration and its conversation records; the folder itself is never touched. */
  removeCardProject(id: string): void {
    const project = this.store.state.projects.find(item => item.id === id);
    if (!project || project.kind !== 'card') throw new Error('找不到这个卡项目。');
    const tasks = this.store.state.tasks.filter(task => task.projectId === id);
    if (tasks.some(task => !terminal.has(task.status) || this.workers.has(task.id) || this.retiring.has(task.id) || this.starting.has(task.id))) throw new Error('这张卡还有对话在运行，请先停止。');
    this.store.state.tasks = this.store.state.tasks.filter(task => task.projectId !== id);
    this.store.state.projects = this.store.state.projects.filter(item => item.id !== id);
    this.refreshSkills();
    this.changed();
  }
  /** Per-card choices the card studio remembers: the permission mode new conversations start with, the kickoff effort and model. */
  saveCardSettings(projectId: string, changes: CardSettings): void {
    const project = this.store.state.projects.find(item => item.id === projectId);
    if (!project || project.kind !== 'card') throw new Error('找不到这个卡项目。');
    const next: CardSettings = { ...project.cardSettings };
    if (changes.permission !== undefined) {
      if (!permissions.has(changes.permission)) throw new Error('未知的权限模式。');
      next.permission = changes.permission;
    }
    if (changes.kickoff !== undefined) {
      const kickoff = { ...next.kickoff, ...changes.kickoff };
      if (kickoff.thinking !== undefined && !levels.has(kickoff.thinking)) throw new Error('未知的思考强度。');
      if (kickoff.gatewayId !== undefined || kickoff.modelId !== undefined) {
        const gateway = this.store.state.gateways.find(item => item.id === kickoff.gatewayId);
        if (!gateway) throw new Error('找不到所选的模型网关。');
        if (kickoff.modelId !== undefined && !gatewayModels(gateway).some(model => model.id === kickoff.modelId)) throw new Error('这个网关里没有所选的模型。');
      }
      next.kickoff = kickoff;
    }
    if (changes.run !== undefined) {
      // The whole set one run used, so a model saved for another gateway never lingers.
      const run = { ...changes.run };
      if (run.thinking !== undefined && !levels.has(run.thinking)) throw new Error('未知的思考强度。');
      if (run.permission !== undefined && !['ask', 'edit', 'full'].includes(run.permission)) throw new Error('一键制作只能用「逐项询问」「自动编辑」或「完全访问」。');
      if (run.autoAnswer !== undefined && typeof run.autoAnswer !== 'boolean') throw new Error('「遇到提问自动按推荐」只能是开或关。');
      if (run.gatewayId !== undefined || run.modelId !== undefined) {
        const gateway = this.store.state.gateways.find(item => item.id === run.gatewayId);
        if (!gateway) throw new Error('找不到所选的模型网关。');
        if (run.modelId !== undefined && !gatewayModels(gateway).some(model => model.id === run.modelId)) throw new Error('这个网关里没有所选的模型。');
      }
      next.run = run;
    }
    project.cardSettings = next;
    this.changed();
  }
  /** One-click making keeps its run on the card project; `undefined` clears it. */
  saveCardRun(projectId: string, run: CardRun | undefined): void {
    const project = this.store.state.projects.find(item => item.id === projectId);
    if (!project || project.kind !== 'card') throw new Error('找不到这个卡项目。');
    if (run) project.cardRun = run; else delete project.cardRun;
    this.changed();
  }
  /** True once the app is shutting down; the card studio's runner then leaves its runs as they are. */
  isClosing(): boolean { return this.closing; }
  /** The card studio records its handoff request on the conversation; the store saves it with the task. */
  setCardHandoff(id: string, handoff: CardHandoffState | undefined): void {
    const task = this.task(id);
    if (!task.card) throw new Error('这不是制卡对话。');
    if (handoff) task.card.handoff = handoff; else delete task.card.handoff;
    this.changed();
  }
  setCardWeb(id: string, enabled: boolean): void {
    const task = this.task(id);
    if (!task.card) throw new Error('这不是制卡对话。');
    if (typeof enabled !== 'boolean') throw new Error('Invalid web access setting.');
    task.card.web = enabled;
    // Tools are fixed when a worker starts; a running conversation gets the new search state for its next run.
    if (this.workers.has(id)) this.send(id, { type: 'search', search: { ...this.store.state.search, enabled, hasKey: this.vault.has('search:brave'), apiKey: this.vault.get('search:brave') } });
    this.changed();
  }
  async createTask(input: NewTask): Promise<Task> {
    const parentEpoch = input.parentId ? this.cancellationEpochs.get(input.parentId) || 0 : 0;
    const parentWasActive = input.parentId ? !terminal.has(this.task(input.parentId).status) : false;
    const project = this.store.state.projects.find(p => p.id === input.projectId);
    if (!project) throw new Error('Select a project folder first.');
    if ((project.kind === 'card') !== Boolean(input.card)) throw new Error(project.kind === 'card' ? '卡项目的对话请在制卡工坊里开始。' : 'Card conversations belong to card projects.');
    // Card conversations do not start squads, except the read-only reading squad of an Ultra planning conversation.
    if (input.card && input.parentId) {
      const lead = this.task(input.parentId);
      if (!input.card.member || lead.card?.sectionId !== 'plan' || lead.thinking !== 'ultra') throw new Error('Card conversations do not start squads.');
    }
    const parent = input.parentId ? this.task(input.parentId) : undefined;
    const gatewayId = input.gatewayId || parent?.gatewayId || this.store.state.preferences.defaultGatewayId;
    if (input.prompt?.trim()) this.gateway(gatewayId);
    const permission = input.permission || this.store.state.preferences.defaultPermission;
    if (!permissions.has(permission)) throw new Error('Unknown permission mode.');
    const selectedThinking = input.thinking || this.store.state.preferences.defaultThinking;
    const savedGateway = this.store.state.gateways.find(gateway => gateway.id === gatewayId);
    const preferredModel = input.modelId || (parent?.gatewayId === gatewayId ? parent.modelId : undefined) || (gatewayId === this.store.state.preferences.defaultGatewayId ? this.store.state.preferences.defaultModelId : undefined);
    const preferredContext = input.contextWindow ?? parent?.contextWindow ?? (!input.gatewayId && !input.modelId ? this.store.state.preferences.defaultContextWindow : undefined);
    const configured = savedGateway ? resolveGatewayModel(savedGateway, preferredModel, preferredContext) : undefined;
    const thinking = configured && !configured.reasoning ? 'off' : selectedThinking;
    if (!levels.has(thinking)) throw new Error('Unknown reasoning level.');
    if (input.parentId) {
      const parent = this.task(input.parentId);
      if (parent.projectId !== project.id) throw new Error('Child task must use its parent project.');
      if (parent.parentId) throw new Error('Nested delegation is limited to one level.');
    }
    const task: Task = {
      id: randomUUID(), projectId: project.id, title: (input.title || input.prompt?.trim().slice(0, 70) || 'New task').slice(0, 160),
      cwd: project.path, parentId: input.parentId, status: 'idle', permission,
      gatewayId, modelId: configured?.modelId, contextWindow: configured?.contextWindow, thinking, createdAt: stamp(), updatedAt: stamp(), messages: [], tools: [], scheduleId: input.scheduleId,
      role: input.role || 'general-purpose', planMode: input.planMode ?? input.role === 'Plan', todos: [], runtimeStatus: {},
      agentName: input.agentName, squadId: input.squadId, sharedReadOnly: Boolean(input.parentId && input.sharedReadOnly), ...(input.parentId && input.sharedWorkspace && !input.sharedReadOnly ? { sharedWorkspace: true } : {}), assignedTask: input.parentId ? input.prompt?.slice(0, 4000) : undefined,
      ...(input.card ? { card: structuredClone(input.card) } : {}),
    };
    if (task.sharedReadOnly) { task.cwd = this.task(task.parentId!).cwd; task.role = 'Explore'; }
    if (task.sharedWorkspace) task.cwd = this.task(task.parentId!).cwd;
    await this.waitForDirectoryRelease(task.cwd);
    if (!this.store.state.ecosystem.roles.some(role => role.id === task.role)) throw new Error('Select an available agent role.');
    const isolated = !task.sharedReadOnly && !task.sharedWorkspace && !task.card && (input.isolated ?? project.isGit);
    if (isolated) {
      task.worktree = await createWorktree(project, task.id, join(this.dataDir, 'worktrees'));
      task.cwd = task.worktree.path;
    } else if (this.directoryBusy(task)) {
      throw new Error(task.card ? CARD_BUSY : 'Another task is using this directory. Use an isolated Git worktree or wait for it to finish.');
    }
    if (input.parentId && ((this.cancellationEpochs.get(input.parentId) || 0) !== parentEpoch || (parentWasActive && (terminal.has(this.task(input.parentId).status) || this.workers.get(input.parentId)?.cancelling)))) {
      task.status = 'cancelled';
      task.error = 'The parent stopped while this child worktree was being prepared.';
    }
    this.store.state.tasks.push(task);
    this.changed();
    if (task.status !== 'cancelled' && (input.prompt?.trim() || input.attachments?.length)) await this.prompt(task.id, input.prompt || 'Use the attached material.', undefined, input.attachments);
    return structuredClone(task);
  }
  async prompt(id: string, text: string, behavior?: 'steer' | 'followUp', attachmentIds?: string[]): Promise<void> {
    await this.retiring.get(id)?.finished;
    const task = this.task(id);
    await this.waitForDirectoryRelease(task.cwd);
    if (this.studio?.directoryLocked(task.cwd)) throw new Error('Wait for checks or the reviewed file operation in this folder before sending a message.');
    if (!text.trim() && attachmentIds?.length) text = 'Use the attached material.';
    if (!text.trim()) throw new Error('Enter a task or message.');
    if (text.length > 200_000) throw new Error('Message is too long (maximum 200,000 characters).');
    // The app accepts prose only. Pi shell shortcuts would bypass the guarded tool path.
    if (text.trimStart().startsWith('!')) throw new Error('Ask the agent to run the command so it goes through tool approval. Direct ! shell shortcuts are disabled.');
    this.runtimeGateway(task);
    this.refreshSkills();
    // Built-in commands the worker runs itself are never taken for a skill with the same name.
    const slash = ['/compact', '/dream'].includes(text.trim()) ? null : /^\/([^\s]+)([\s\S]*)$/.exec(text.trim());
    if (slash?.[1].startsWith('skill:') && !skillsForProject(this.skills, task.projectId).some(skill => skill.name === slash[1].slice(6))) throw new Error('This skill is disabled or unavailable in this project.');
    if (slash && !slash[1].startsWith('skill:') && skillsForProject(this.skills, task.projectId).some(skill => skill.name === slash[1])) text = `/skill:${slash[1]}${slash[2]}`;
    if (task.status === 'queued') throw new Error('This task is already queued. Wait for it to start.');
    const active = this.workers.get(id);
    if (active?.cancelling) throw new Error('Wait for cancellation to finish.');
    if (active && !behavior) throw new Error('Choose Steer or Follow up while the agent is running.');
    if (!active && this.directoryBusy(task)) {
      throw new Error(task.card ? CARD_BUSY : 'This working directory is already in use by another task.');
    }
    const attachments = this.studio ? await this.studio.inputs(attachmentIds) : [];
    if (this.studio?.directoryLocked(task.cwd)) throw new Error('Wait for checks or the reviewed file operation in this folder before sending a message.');
    if (task.card && this.cardStudio) await this.cardStudio.beforePrompt(task, text.trim());
    if (!active && !task.parentId) { this.budgetBaselines.set(task.id, budgetUsage(this.store.state.tasks.filter(item => item.id === task.id || item.parentId === task.id))); this.budgetStarts.set(task.id, Date.now()); this.budgetStopping.delete(task.id); }
    const submit = await this.hooks('UserPromptSubmit', task, { prompt: text.trim(), quiet: true });
    if (submit.decision === 'deny') { task.messages.push({ id: randomUUID(), role: 'system', text: `[UserPromptSubmit] ${(submit.reason || '钩子拦下了这条消息。').slice(0, 2_000)}`, at: stamp() }); this.changed(); throw new Error(submit.reason || '钩子拦下了这条消息。'); }
    if (submit.messages.length) text = [text.trim(), ...submit.messages.map(note => `[UserPromptSubmit] ${note}`)].join('\n\n');
    const messageId = randomUUID();
    task.messages.push({ id: messageId, turnId: messageId, role: 'user', text: text.trim(), at: stamp(), pending: true, ...(attachments.length ? { attachments: attachments.map(({ storedPath: _path, ...info }) => info) } : {}) });
    task.updatedAt = stamp();
    task.error = undefined;
    task.truncation = undefined;
    if (active) this.send(id, { type: 'prompt', text: text.trim(), behavior, messageId, attachments });
    else {
      task.status = 'queued';
      this.prompts.set(id, { type: 'prompt', text: text.trim(), messageId, attachments });
    }
    this.changed();
    this.pump();
  }
  private send(taskId: string, message: ToWorker): void {
    const child = this.workers.get(taskId)?.child;
    if (child?.connected) child.send(message, error => { if (error && !this.closing && this.workers.get(taskId)?.child === child) this.fail(taskId, error.message); });
  }
  private pump(): void {
    if (this.closing || this.bootPaused) return;
    let active = [...this.workers.keys()].filter(id => !this.waiters.has(id)).length + this.retiring.size + this.starting.size;
    for (const task of this.store.state.tasks) {
      if (active >= this.store.state.preferences.maxConcurrent) break;
      if (task.status !== 'queued' || this.workers.has(task.id) || this.retiring.has(task.id) || this.starting.has(task.id) || this.studio?.directoryLocked(task.cwd) || !this.prompts.has(task.id)) continue;
      active++;
      void this.start(task);
    }
  }
  private async start(task: Task): Promise<void> {
    this.starting.add(task.id);
    try {
      await this.hooks('SessionStart', task);
      if (this.studio) await this.studio.beforeRun(task, this.prompts.get(task.id)?.messageId || randomUUID());
      if (this.closing || task.status === 'cancelled') return;
      const gateway = this.runtimeGateway(task);
      this.studio?.validateBudgetModel(task);
      if (!gateway.reasoning) task.thinking = 'off';
      effectiveEffort(gateway, task.thinking);
      this.refreshSkills();
      const apiKey = this.vault.get(gateway.id);
      if (!existsSync(task.cwd)) throw new Error('Project directory no longer exists.');
      // Card conversations: section prompt, read-only built-in resources, no squads, no memory, web only when turned on.
      const card = task.card && this.cardStudio ? await this.cardStudio.workerContext(task) : undefined;
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'PSModulePath', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      env.ELECTRON_RUN_AS_NODE = '1';
      env.PI_OFFLINE = '1';
      const options: ForkOptions & { windowsHide: boolean } = { cwd: task.cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, execArgv: [] };
      const child = fork(this.workerPath, [], options);
      const running: Running = { child, ready: false, cancelling: false, started: false };
      this.workers.set(task.id, running);
      task.status = 'running';
      task.startedAt = stamp(); task.completedAt = undefined; task.activationCount = (task.activationCount || 0) + 1;
      let diagnostics = '';
      child.stderr?.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-6000); });
      child.stdout?.resume();
      child.on('message', message => {
        if (this.workers.get(task.id) !== running) return;
        const clean = this.redact(message);
        void this.onWorker(task.id, clean as FromWorker).catch(error => this.fail(task.id, error instanceof Error ? error.message : String(error)));
      });
      child.on('error', error => { if (this.workers.get(task.id) === running) this.fail(task.id, error.message); });
      child.on('exit', (code, signal) => {
        if (running.killTimer) clearTimeout(running.killTimer);
        if (this.workers.get(task.id) !== running) return;
        if (!terminal.has(task.status)) {
          if (running.cancelling) task.status = 'cancelled';
          else { task.status = 'failed'; task.error = this.redactString(diagnostics || `Agent process exited (${code ?? signal}).`); }
        }
        this.cleanupRequests(task.id);
        task.updatedAt = stamp(); task.completedAt = task.updatedAt; this.stopChildren(task.id);
        this.retire(task.id);
        this.changed();
        this.checkWaiters();
        this.pump();
      });
      this.send(task.id, { type: 'init', squadSize: this.studio?.state.preferences.defaultSquadSize || 6, fileCheckpoints: !!this.studio, sandbox: this.studio ? { enabled: this.studio.state.preferences.sandboxEnabled, helperPath: this.studio.helperPath } : undefined, attachmentRoot: this.studio?.attachments.root, networkOrigins: this.networkOrigins(gateway), taskId: task.id, cwd: task.cwd, agentDir: join(this.dataDir, 'agents', task.id), sessionDir: join(this.dataDir, 'sessions', task.id), sessionFile: task.sessionFile, sessionLeafId: task.sessionLeafId, branchBeforeEntryId: task.branchBeforeEntryId, skillFiles: skillsForProject(this.skills, task.projectId), gateway, apiKey, thinking: task.thinking, permission: task.permission, instructions: this.store.state.preferences.instructions, skillPaths: this.store.state.preferences.skillPaths, canDelegate: !task.parentId && (!task.card || (task.card.sectionId === 'plan' && task.thinking === 'ultra')), search: { ...this.store.state.search, ...(task.card ? { enabled: !!task.card.web } : {}), hasKey: this.vault.has('search:brave'), apiKey: this.vault.get('search:brave') }, dataDir: this.dataDir, projectId: task.projectId, ecosystem: task.card ? { ...this.store.state.ecosystem, memoryEnabled: false } : this.store.state.ecosystem, mcpServers: this.store.state.ecosystem.mcpServers.map(server => ({ ...server, ...this.mcpSecrets(server.id) })), role: task.role, sharedWorkspace: !!task.sharedWorkspace, hooks: this.toolHooks(), browser: !task.card && !!this.browser, roleDefinition: task.card ? { id: 'card-section', name: sectionLabel(task.card.sectionId), prompt: '', readOnly: !!task.card.member } : task.sharedReadOnly ? { id: 'Explore', name: 'Explore', prompt: 'Read-only squad researcher. Do not modify files.', readOnly: true, builtIn: true } : usableAgents(this.roles(task.projectId), task.projectId).find(role => role.id === task.role), planMode: task.card ? false : task.planMode, todos: task.todos, ...(card ? { card } : {}) });
      const timeout = setTimeout(() => {
        if (!running.ready && this.workers.get(task.id) === running) { this.fail(task.id, 'Agent initialization timed out.'); child.kill(); }
      }, 45_000);
      timeout.unref();
      child.once('exit', () => clearTimeout(timeout));
      this.changed();
    } catch (error) { this.fail(task.id, error instanceof Error ? error.message : String(error)); this.prompts.delete(task.id); }
    finally { this.starting.delete(task.id); this.changed(); this.pump(); }
  }
  private redactString(value: string): string {
    let result = value;
    for (const key of this.secretValues()) {
      if (key && key.length > 3) result = result.split(key).join('[redacted]');
    }
    const searchKey = this.vault.get('search:brave');
    if (searchKey && searchKey.length > 3) result = result.split(searchKey).join('[redacted]');
    return result;
  }
  private secretValues(): string[] {
    return [...this.store.state.gateways.map(g => this.vault.get(g.id)), this.vault.get('search:brave'), this.vault.get('webdav:password'), ...this.store.state.ecosystem.mcpServers.flatMap(server => { const secrets = this.mcpSecrets(server.id); return [...Object.values(secrets.env ?? {}), ...Object.values(secrets.headers ?? {})]; })].filter(Boolean);
  }
  private mcpSecrets(id: string): { env?: Record<string, string>; headers?: Record<string, string> } { const value = this.vault.get(`mcp:${id}`); return value ? JSON.parse(value) : {}; }
  private redact(value: unknown): unknown { return JSON.parse(this.redactString(JSON.stringify(value))); }
  private async onWorker(id: string, message: FromWorker): Promise<void> {
    const task = this.task(id);
    const running = this.workers.get(id);
    if (!running || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      running.ready = true;
      if (message.sessionFile) task.sessionFile = message.sessionFile;
      if (message.sessionLeafId !== undefined) task.sessionLeafId = message.sessionLeafId;
      task.branchBeforeEntryId = undefined;
      const pending = this.prompts.get(id);
      if (pending && !running.cancelling) { this.prompts.delete(id); running.started = true; this.send(id, pending); }
      this.changed();
    } else if (message.type === 'event') {
      this.consume(task, message.event);
    } else if (message.type === 'error') {
      this.fail(id, message.message);
    } else if (message.type === 'done') {
      if (message.sessionFile) task.sessionFile = message.sessionFile;
      if (message.sessionLeafId !== undefined) task.sessionLeafId = message.sessionLeafId;
      for (const entry of message.userEntries || []) { const user = task.messages.find(item => item.id === entry.messageId && item.role === 'user'); if (user) user.sessionEntryId = entry.entryId; }
      task.status = running.cancelling ? 'cancelled' : task.error ? 'failed' : 'completed';
      task.updatedAt = stamp(); task.completedAt = task.updatedAt;
      task.contextCompacting = false;
      if (this.studio) { try { await this.studio.afterRun(task); } catch (error) { if (task.delivery) { task.delivery.verification = 'failed'; task.delivery.error = error instanceof Error ? error.message : String(error); } } }
      this.stopChildren(id);
      this.streaming.delete(id);
      this.cleanupRequests(id);
      this.changed();
      this.emit('finished', structuredClone(task));
      void this.hooks(task.parentId ? 'SubagentStop' : 'Stop', task);
      if (task.card) void this.cardStudio?.afterConversation(task);
      this.retire(id, true);
      this.checkWaiters();
      this.pump();
    } else if (message.type === 'request') {
      await this.handleRequest(task, message);
    }
  }
  private consume(task: Task, event: Record<string, unknown>): void {
    const type = event.type;
    if (type === 'cache_prefix') task.cachePrefix = { ...event };
    if (type === 'context_usage') { const window = Number(event.window); const tokens = typeof event.tokens === 'number' && Number.isFinite(event.tokens) ? Math.max(0, event.tokens) : null; if (window > 0) task.contextUsage = { tokens, window, percent: tokens === null ? null : Math.min(100, tokens / window * 100) }; }
    if (type === 'auto_compaction_start' || type === 'compaction_start') task.contextCompacting = true;
    if (type === 'auto_compaction_end' || type === 'compaction_end') task.contextCompacting = false;
    if (type === 'message_start' && object(event.message).role === 'user' && typeof event.messageId === 'string') {
      const user = task.messages.find(message => message.id === event.messageId && message.role === 'user');
      if (user) {
        task.messages = task.messages.filter(message => message.id !== user.id);
        user.pending = false; user.at = stamp();
        const queued = task.messages.findIndex(message => message.pending);
        task.messages.splice(queued < 0 ? task.messages.length : queued, 0, user);
      }
    }
    if (type === 'session_entry' && typeof event.entryId === 'string') task.sessionLeafId = event.entryId;
    if (type === 'prompt_rejected') task.messages.push({ id: randomUUID(), role: 'system', text: string(event.message), at: stamp(), turnId: string(event.messageId) || undefined });
    if (type === 'session_entry' && typeof event.messageId === 'string' && typeof event.entryId === 'string') {
      const user = task.messages.find(message => message.id === event.messageId && message.role === 'user'); if (user) user.sessionEntryId = event.entryId;
    }
    if (type === 'workflow_todos') task.todos = Array.isArray(event.todos) ? event.todos as Task['todos'] : [];
    // A chapter belongs to the turn that was running; a second mark in the same turn replaces the first.
    if (type === 'workflow_chapter') {
      const title = chapterTitle(string(event.title));
      const turnId = this.currentTurn(task);
      if (title && turnId) {
        task.chapters = [...(task.chapters ?? []).filter(item => item.turnId !== turnId), { id: randomUUID(), title, turnId, at: stamp() }];
      }
    }
    if (type === 'workflow_plan') task.plan = { text: string(event.text), status: 'pending' };
    if (type === 'workflow_status') task.runtimeStatus = { ...task.runtimeStatus, [string(event.key)]: string(event.value).replace(/\x1b\[[0-9;]*m/g, '') };
    if (type === 'workflow_notice') task.messages.push({ id: randomUUID(), role: 'system', text: string(event.message).replace(/\x1b\[[0-9;]*m/g, ''), at: stamp() });
    if (type === 'workflow_compaction') task.compactions = (task.compactions || 0) + 1;
    if (type === 'nested_usage') { const usage = object(event.usage); task.messages.push({ id: randomUUID(), role: 'system', text: 'Auxiliary model usage', model: string(event.model), at: stamp(), usage: { input: Number(usage.input) || 0, output: Number(usage.output) || 0, cacheRead: Number(usage.cacheRead) || 0, cacheWrite: Number(usage.cacheWrite) || 0, cost: Number(object(usage.cost).total ?? usage.cost) || 0 } }); }
    const ensureAssistant = () => {
      let id = this.streaming.get(task.id);
      if (!id) {
        id = randomUUID(); this.streaming.set(task.id, id);
        const queued = task.messages.findIndex(message => message.pending);
        task.messages.splice(queued < 0 ? task.messages.length : queued, 0, { id, role: 'assistant', text: '', at: stamp(), turnId: string(event.turnId) || undefined });
      }
      return task.messages.find(m => m.id === id)!;
    };
    if (type === 'message_start' && object(event.message).role === 'assistant') {
      this.streaming.delete(task.id); ensureAssistant();
    } else if (type === 'message_update') {
      const update = object(event.assistantMessageEvent);
      if (update.type === 'text_delta') ensureAssistant().text += string(update.delta);
      if (update.type === 'thinking_delta') { const msg = ensureAssistant(); msg.thinking = (msg.thinking || '') + string(update.delta); }
    } else if (type === 'message_end') {
      const message = object(event.message);
      if (message.role === 'assistant') {
        const msg = ensureAssistant();
        msg.text = contentText(message.content);
        msg.model = string(message.model) || task.modelId || this.store.state.gateways.find(g => g.id === task.gatewayId)?.modelId;
        msg.thinking = contentText(message.content, 'thinking') || undefined;
        const usage = object(message.usage);
        const cost = object(usage.cost);
        msg.usage = message.usage && typeof message.usage === 'object' ? { input: Number(usage.input) || 0, output: Number(usage.output) || 0, cacheRead: Number(usage.cacheRead) || 0, cacheWrite: Number(usage.cacheWrite) || 0, cost: Number(cost.total) || 0 } : undefined;
        // A provider error may be retried. Only the worker's final error marks a run failed.
        if (message.stopReason === 'error' && !msg.text) msg.text = string(message.errorMessage) || 'Model request failed; checking retry status.';
        this.streaming.delete(task.id);
      }
    } else if (type === 'output_truncated') {
      task.truncation = { outputTokens: Number(event.outputTokens) || 0, maxTokens: Number(event.maxTokens) || 0, model: string(event.model), turnId: string(event.turnId) || undefined, at: stamp() };
    } else if (type === 'thinking_level_changed') {
      const value = string(event.level) as ThinkingLevel;
      if (levels.has(value)) task.thinking = value;
    } else if (type === 'run_cancelled') {
      const running = this.workers.get(task.id);
      if (running) running.cancelling = true;
    } else if (type === 'tool_execution_start') {
      task.tools.push({ id: randomUUID(), toolCallId: string(event.toolCallId), name: string(event.toolName), args: object(event.args), output: '', status: 'running', at: stamp(), turnId: string(event.turnId) || undefined });
    } else if (type === 'tool_execution_update' || type === 'tool_execution_end') {
      const tool = task.tools.findLast(t => (t.toolCallId || t.id) === event.toolCallId);
      if (tool) {
        const result = object(type === 'tool_execution_end' ? event.result : event.partialResult);
        tool.output = contentText(result.content).slice(-160_000);
        tool.patch = string(object(result.details).patch) || tool.patch;
        if (tool.name === 'web_search' && Array.isArray(object(result.details).results)) tool.search = result.details as SearchOutput;
        if (type === 'tool_execution_end') tool.status = event.isError ? 'failed' : 'completed';
      }
    }
    task.updatedAt = stamp();
    if (type === 'message_end' || type === 'nested_usage') void this.enforceBudgets();
    this.changed(false);
  }
  /** The turn a tool call belongs to: the last user message that really went out. */
  private currentTurn(task: Task): string | undefined {
    const message = task.messages.findLast(item => item.role === 'user' && !item.pending);
    return message?.turnId ?? message?.id;
  }
  private respond(taskId: string, id: string, result?: unknown, error?: string): void { this.send(taskId, { type: 'response', id, result, error }); }
  private async handleRequest(task: Task, request: Extract<FromWorker, { type: 'request' }>): Promise<void> {
    try {
      if (request.method === 'interaction') {
        const type = String(request.args.type) as Interaction['type'];
        if (!['select', 'confirm', 'input', 'editor', 'questionnaire', 'plan'].includes(type)) throw new Error('Unsupported extension interaction.');
        const interaction = { ...request.args, type, title: string(request.args.title), id: request.id, taskId: task.id } as Interaction;
        this.interactions.set(request.id, interaction);
        task.status = 'waiting'; this.changed(); this.emit('interaction', structuredClone(interaction));
      } else if (request.method === 'hook') {
        // PreToolUse may stop the call; PostToolUse can only add a note. What a hook printed goes into the conversation.
        const phase = string(request.args.phase) === 'post' ? 'post' : 'pre';
        const outcome = await this.hooks(phase === 'pre' ? 'PreToolUse' : 'PostToolUse', task, { toolName: string(request.args.toolName), toolInput: request.args.args });
        this.respond(task.id, request.id, phase === 'pre' ? { decision: outcome.decision, reason: outcome.reason } : { reason: outcome.decision === 'deny' ? outcome.reason : undefined });
      } else if (request.method === 'checkpoint') {
        const turnId = string(request.args.turnId); if (!task.messages.some(message => message.id === turnId && message.role === 'user')) throw new Error('Unknown checkpoint turn.');
        await this.studio?.beforeRun(task, turnId); this.respond(task.id, request.id, true);
      } else if (request.method === 'card') {
        if (!this.cardStudio) throw new Error('制卡工坊未启用。');
        this.respond(task.id, request.id, await this.cardStudio.toolRequest(task, request.args));
      } else if (request.method === 'browser') {
        this.respond(task.id, request.id, await this.browserRequest(task, request.args));
      } else if (request.method === 'steer_agent') {
        const child = this.task(string(request.args.agent_id)); if (child.parentId !== task.id) throw new Error('Only direct children can be steered.');
        await this.resumeAgent(child.id, string(request.args.message)); this.respond(task.id, request.id, { id: child.id, status: child.status });
      } else if (request.method === 'team') {
        if (!Array.isArray(request.args.members) || request.args.members.length < 2 || request.args.members.length > 6) throw new Error('A squad needs 2–6 members.');
        const squadId = randomUUID();
        const members = request.args.members.map(value => { const member = object(value); return { name: this.memberName(string(member.name)), prompt: string(member.prompt), role: string(member.role) || 'general-purpose' }; });
        if (new Set(members.map(member => member.name)).size !== members.length || members.some(member => !member.prompt.trim() || member.prompt.length > 200000)) throw new Error('Give every member a distinct Chinese name and a bounded task.');
        const started: Task[] = [];
        this.reserveMembers(task, members.length);
        try {
          for (const member of members) started.push(await this.delegateMember(task, { ...member, squadId }));
          this.respond(task.id, request.id, { squadId, members: started.map(member => this.childSummary(member)) });
        } catch (error) { for (const child of started) if (!terminal.has(child.status)) await this.cancelTask(child.id); throw error; }
        finally { this.admissions.set(task.id, Math.max(0, (this.admissions.get(task.id) || 0) - members.length)); }
      } else if (request.method === 'approve') {
        const args = object(request.args.args); const tool = string(request.args.toolName);
        const kind = tool === 'read' ? 'read' : ['write', 'edit'].includes(tool) ? 'write' : 'command';
        const target = kind === 'command' ? string(args.command) : string(args.path);
        if (target && this.studio?.allows(task, kind, target)) { this.respond(task.id, request.id, true); return; }
        const approval: Approval = { id: request.id, taskId: task.id, toolName: string(request.args.toolName), args: object(request.args.args), reason: string(request.args.reason), createdAt: stamp() };
        this.approvals.set(request.id, approval);
        task.status = 'waiting';
        const last = task.tools.findLast(t => t.name === approval.toolName && t.status === 'running');
        if (last) last.status = 'waiting';
        this.changed(); this.emit('approval', approval);
      } else if (request.method === 'delegate') {
        this.reserveMembers(task, 1);
        try {
          const child = await this.delegateMember(task, { name: string(request.args.name) || undefined, title: string(request.args.title), prompt: string(request.args.prompt), role: string(request.args.role) || 'general-purpose' });
          this.respond(task.id, request.id, this.childSummary(child));
        } finally { this.admissions.set(task.id, Math.max(0, (this.admissions.get(task.id) || 0) - 1)); }
      } else if (request.method === 'network') {
        const url = new URL(string(request.args.url));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid network destination.');
        if (task.permission === 'full' || this.studio?.allows(task, 'network', url.href)) { this.respond(task.id, request.id, true); return; }
        const approval: Approval = { id: request.id, taskId: task.id, toolName: 'network', args: { origin: url.origin, path: url.pathname, method: string(request.args.method) }, reason: 'Allow this network origin for the requested operation?', createdAt: stamp() };
        this.approvals.set(request.id, approval); task.status = 'waiting'; this.changed(); this.emit('approval', approval);
      } else {
        const children = this.store.state.tasks.filter(t => t.parentId === task.id);
        const requested = Array.isArray(request.args.taskIds) ? request.args.taskIds.filter((v): v is string => typeof v === 'string') : children.map(t => t.id);
        if (requested.some(id => !children.some(t => t.id === id))) throw new Error('Only direct child tasks can be inspected.');
        const tasks = children.filter(t => requested.includes(t.id));
        if (request.method === 'wait' && tasks.some(t => !terminal.has(t.status))) {
          this.waiters.set(task.id, { parentId: task.id, requestId: request.id, taskIds: tasks.map(t => t.id) });
          task.status = 'waiting'; this.changed(); this.pump();
        } else this.respond(task.id, request.id, tasks.map(t => this.childSummary(t)));
      }
    } catch (error) { this.respond(task.id, request.id, undefined, error instanceof Error ? error.message : String(error)); }
  }
  private childSummary(task: Task) {
    return { id: task.id, title: task.title, name: task.agentName, status: task.status, cwd: task.cwd, sharedReadOnly: task.sharedReadOnly, sharedWorkspace: task.sharedWorkspace, workerActive: this.workers.has(task.id) || this.retiring.has(task.id) || this.starting.has(task.id), result: task.messages.findLast(m => m.role === 'assistant')?.text || '', verification: task.delivery?.verification, error: task.error };
  }
  private memberName(name: string): string {
    const clean = name.trim(); if (!/[\u3400-\u9fff]/.test(clean) || clean.length < 2 || clean.length > 24 || /[\r\n<>]/.test(clean)) throw new Error('Give the member a suitable Chinese name of 2–24 characters.'); return clean;
  }
  private reserveMembers(parent: Task, count: number): void {
    if (parent.parentId) throw new Error('Child agents cannot delegate further.');
    if (terminal.has(parent.status) || this.workers.get(parent.id)?.cancelling) throw new Error('The parent is no longer accepting child tasks.');
    const current = this.store.state.tasks.filter(task => task.parentId === parent.id && !terminal.has(task.status)).length;
    const reserved = this.admissions.get(parent.id) || 0;
    if (current + reserved + count > 8) throw new Error('At most eight child tasks may be active for one parent.');
    this.admissions.set(parent.id, reserved + count);
  }
  private async delegateMember(parent: Task, input: { name?: string; title?: string; prompt: string; role: string; squadId?: string }): Promise<Task> {
    if (!input.prompt.trim() || input.prompt.length > 200000) throw new Error('A child task requires a bounded, non-empty prompt.');
    const epoch = this.cancellationEpochs.get(parent.id) || 0;
    const project = this.store.state.projects.find(project => project.id === parent.projectId)!;
    const isolated = await canCreateIsolatedTasks(project);
    if ((this.cancellationEpochs.get(parent.id) || 0) !== epoch || terminal.has(parent.status) || this.workers.get(parent.id)?.cancelling) throw new Error('The parent stopped while preparing its squad.');
    // Without a separate worktree, writing members share the lead's folder; planning leads and read-only roles keep read-only members.
    const roles = this.store.state.ecosystem.roles;
    const role = parent.card || parent.planMode || roles.find(item => item.id === parent.role)?.readOnly ? 'Explore' : input.role;
    const readOnly = !!roles.find(item => item.id === role)?.readOnly;
    const name = input.name ? this.memberName(input.name) : `${role === 'Explore' ? '探索员' : role === 'Plan' ? '规划师' : '执行员'}${this.store.state.tasks.filter(task => task.parentId === parent.id).length + 1}`;
    const model = this.studio?.state.preferences.roleModels[role];
    return this.createTask({ projectId: parent.projectId, prompt: input.prompt, title: input.title || name, agentName: name, squadId: input.squadId, sharedReadOnly: !isolated && readOnly, sharedWorkspace: !isolated && !readOnly, ...(parent.card ? { card: { sectionId: parent.card.sectionId, member: true } } : {}), gatewayId: model?.gatewayId || parent.gatewayId, modelId: model?.modelId || parent.modelId, contextWindow: parent.contextWindow, thinking: model?.thinking as ThinkingLevel || (parent.thinking === 'ultra' ? 'max' : parent.thinking), permission: parent.permission, parentId: parent.id, isolated, role });
  }
  async resumeAgent(id: string, message: string): Promise<void> {
    const child = this.task(id); if (!child.parentId) throw new Error('Select a squad member.');
    if (!message.trim()) throw new Error('Describe the follow-up task.');
    const parent = this.task(child.parentId);
    if (this.workers.get(parent.id)?.cancelling) throw new Error('The lead is stopping its squad.');
    if (!this.workers.has(id)) { child.permission = parent.permission; if (terminal.has(parent.status) && !this.store.state.tasks.some(task => task.parentId === parent.id && !terminal.has(task.status))) { this.budgetBaselines.set(parent.id, budgetUsage(this.store.state.tasks.filter(task => task.id === parent.id || task.parentId === parent.id))); this.budgetStarts.set(parent.id, Date.now()); this.budgetStopping.delete(parent.id); } }
    await this.prompt(id, message, this.workers.has(id) ? 'steer' : undefined);
  }
  private checkWaiters(): void {
    for (const [id, waiter] of this.waiters) {
      const tasks = waiter.taskIds.map(id => this.task(id));
      if (tasks.some(t => !terminal.has(t.status))) continue;
      const occupied = [...this.workers.keys()].filter(workerId => !this.waiters.has(workerId)).length + this.retiring.size;
      if (this.workers.has(id) && occupied >= this.store.state.preferences.maxConcurrent) continue;
      this.waiters.delete(id);
      const task = this.task(id);
      if (this.workers.has(id)) { task.status = 'running'; this.respond(id, waiter.requestId, tasks.map(t => this.childSummary(t))); }
    }
    this.changed();
  }
  approve(id: string, allow: boolean): void {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('This approval is no longer pending.');
    if (typeof allow !== 'boolean') throw new Error('Approval must be explicit.');
    this.approvals.delete(id);
    const task = this.task(approval.taskId);
    if (![...this.approvals.values()].some(a => a.taskId === task.id)) task.status = 'running';
    this.respond(task.id, id, allow);
    this.changed();
  }
  private cleanupRequests(taskId: string): void {
    for (const [id, interaction] of this.interactions) if (interaction.taskId === taskId) {
      this.interactions.delete(id);
      const local = this.localAnswers.get(id); if (local) { this.localAnswers.delete(id); local(null); }
    }
    for (const [id, approval] of this.approvals) if (approval.taskId === taskId) this.approvals.delete(id);
    this.waiters.delete(taskId);
    const task = this.task(taskId);
    for (const tool of task.tools) {
      if (tool.status === 'waiting' || tool.status === 'running') {
        tool.status = 'failed';
        tool.output = tool.output || (task.status === 'cancelled' ? 'Cancelled before completion.' : 'Tool did not complete.');
      }
    }
  }
  private stopChildren(id: string): void {
    this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) || 0) + 1);
    for (const child of this.store.state.tasks.filter(task => task.parentId === id && !terminal.has(task.status))) void this.cancelTask(child.id);
  }
  private retire(id: string, graceful = false): void {
    const running = this.workers.get(id);
    if (!running) return;
    this.workers.delete(id);
    if (running.killTimer) clearTimeout(running.killTimer);
    const child = running.child;
    let settle!: () => void;
    const finished = new Promise<void>(resolve => { settle = resolve; });
    this.retiring.set(id, { child, finished });
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else child.kill();
    };
    const timeout = setTimeout(kill, graceful ? 2000 : 0); timeout.unref();
    const closed = () => { void (async () => {
      clearTimeout(timeout);
      const task = this.task(id);
      if (this.studio && ['failed', 'cancelled'].includes(task.status)) {
        try { await this.studio.afterRun(task); }
        catch (error) { if (task.delivery) { task.delivery.verification = 'failed'; task.delivery.error = error instanceof Error ? error.message : String(error); } }
      }
      if (this.retiring.get(id)?.child === child) this.retiring.delete(id);
      settle(); this.changed(); this.checkWaiters(); this.pump();
    })(); };
    if (child.exitCode !== null || child.signalCode !== null) closed(); else child.once('exit', closed);
    if (graceful && child.connected) child.disconnect();
  }
  private fail(id: string, message: string): void {
    const task = this.task(id);
    task.error = this.redactString(message); task.status = this.workers.get(id)?.cancelling ? 'cancelled' : 'failed';
    task.updatedAt = stamp(); task.completedAt = task.updatedAt; this.stopChildren(id); this.prompts.delete(id); unqueue(task); this.cleanupRequests(id);
    this.retire(id); this.changed(); this.emit('finished', structuredClone(task)); if (task.card) void this.cardStudio?.afterConversation(task); this.checkWaiters();
    queueMicrotask(() => this.pump());
  }
  async cancelTask(id: string): Promise<void> {
    const task = this.task(id);
    this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) || 0) + 1);
    for (const child of this.store.state.tasks.filter(t => t.parentId === id && !terminal.has(t.status))) await this.cancelTask(child.id);
    this.prompts.delete(id); unqueue(task);
    const running = this.workers.get(id);
    if (running) {
      running.cancelling = true; this.send(id, { type: 'cancel' });
      this.cleanupRequests(id);
      running.killTimer = setTimeout(() => { task.status = 'cancelled'; task.completedAt = stamp(); task.contextCompacting = false; this.retire(id); this.changed(); this.checkWaiters(); this.pump(); }, 8000);
    } else { task.status = 'cancelled'; task.completedAt = stamp(); this.checkWaiters(); }
    task.updatedAt = stamp(); this.changed(); this.pump();
  }
  updateTask(id: string, changes: { title?: string; permission?: PermissionMode; gatewayId?: string; modelId?: string; contextWindow?: number; thinking?: ThinkingLevel; archived?: boolean; pinned?: boolean }): void {
    const task = this.task(id);
    const selectionChanged = changes.gatewayId !== undefined || changes.modelId !== undefined || changes.contextWindow !== undefined;
    if ((selectionChanged || changes.thinking !== undefined) && !terminal.has(task.status)) throw new Error('Stop this task before changing its model, context window or reasoning level.');
    if (changes.title !== undefined && (typeof changes.title !== 'string' || !changes.title.trim())) throw new Error('Task title cannot be empty.');
    if (changes.permission !== undefined && !permissions.has(changes.permission)) throw new Error('Unknown permission mode.');
    if (changes.thinking !== undefined && !levels.has(changes.thinking)) throw new Error('Unknown reasoning level.');
    for (const key of ['archived', 'pinned'] as const) if (changes[key] !== undefined && typeof changes[key] !== 'boolean') throw new Error('Invalid task state.');
    if (changes.archived !== undefined && !terminal.has(task.status)) throw new Error('Stop this task before archiving it.');
    const selected = selectionChanged ? resolveGatewayModel(this.gateway(changes.gatewayId ?? task.gatewayId), changes.modelId ?? (changes.gatewayId && changes.gatewayId !== task.gatewayId ? undefined : task.modelId), changes.contextWindow ?? task.contextWindow) : undefined;
    const next = { ...task, updatedAt: stamp() };
    if (changes.title !== undefined) next.title = changes.title.trim().slice(0, 160);
    if (changes.permission !== undefined) next.permission = changes.permission;
    if (changes.thinking !== undefined) next.thinking = changes.thinking;
    if (changes.archived !== undefined) next.archived = changes.archived;
    if (changes.pinned !== undefined) next.pinned = changes.pinned;
    if (selected) { next.gatewayId = selected.id; next.modelId = selected.modelId; next.contextWindow = selected.contextWindow; next.contextUsage = undefined; next.contextCompacting = false; if (!selected.reasoning) next.thinking = 'off'; }
    const previous = { ...task };
    Object.assign(task, next);
    try { this.changed(); } catch (error) { Object.assign(task, previous); throw error; }
    if (changes.permission !== undefined) this.send(id, { type: 'permission', permission: task.permission });
  }
  private restoreMessageCursors(task: Task): void {
    if (!task.sessionFile || task.messages.filter(message => message.role === 'user').every(message => message.sessionEntryId)) return;
    try {
      const root = resolve(this.dataDir, 'sessions', task.id).toLowerCase();
      const file = resolve(task.sessionFile); if (!file.toLowerCase().startsWith(root + '\\') && !file.toLowerCase().startsWith(root + '/')) return;
      if (statSync(file).size > 64_000_000) return;
      const entries = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type !== 'session' && typeof entry.id === 'string' && (entry.parentId === null || typeof entry.parentId === 'string')) as ConversationEntry[];
      for (const item of mapLegacyUserMessages(entries, task.messages, task.sessionLeafId)) { const message = task.messages.find(message => message.id === item.messageId)!; message.sessionEntryId = item.entryId; message.turnId ||= message.id; }
      task.sessionLeafId ??= entries.at(-1)?.id ?? null;
    } catch { /* Unverifiable legacy messages retain their original history without guessed cursors. */ }
  }
  async regenerate(id: string, userMessageId: string, editedText?: string): Promise<void> {
    const task = this.task(id);
    if (this.workers.has(id) || !terminal.has(task.status)) throw new Error('Stop the current run before editing or regenerating.');
    this.restoreMessageCursors(task);
    const original = structuredClone(task);
    const previousText = startRevision(task, userMessageId);
    try { await this.prompt(id, editedText === undefined ? previousText : editedText); }
    catch (error) { Object.assign(task, original); this.changed(); throw error; }
  }
  switchRevision(id: string, revisionId: string): void {
    const task = this.task(id); if (this.workers.has(id) || !terminal.has(task.status)) throw new Error('Stop the current run before switching versions.');
    this.restoreMessageCursors(task); selectRevision(task, revisionId); task.updatedAt = stamp(); this.changed();
  }
  savePreferences(changes: Partial<Preferences>): void {
    const { migrationNotice: _notice, ...allowed } = changes;
    const next = { ...this.store.state.preferences, ...allowed };
    if (changes.defaultGatewayId !== undefined || changes.defaultModelId !== undefined || changes.defaultContextWindow !== undefined) {
      if (next.defaultGatewayId) {
        const selected = resolveGatewayModel(this.gateway(next.defaultGatewayId), changes.defaultModelId ?? (changes.defaultGatewayId && changes.defaultGatewayId !== this.store.state.preferences.defaultGatewayId ? undefined : next.defaultModelId), changes.defaultContextWindow ?? next.defaultContextWindow);
        next.defaultModelId = selected.modelId; next.defaultContextWindow = selected.contextWindow;
      } else { next.defaultModelId = undefined; next.defaultContextWindow = undefined; }
    }
    next.avatars = validateAvatars(next.avatars);
    if (typeof next.soundEnabled !== 'boolean' || !Number.isInteger(next.soundVolume) || next.soundVolume < 0 || next.soundVolume > 100) throw new Error('Sound volume must be a whole number from 0 to 100, and sound must be on or off.');
    if (!['system', 'light', 'dark'].includes(next.theme) || !['en', 'zh'].includes(next.language) || !['sans', 'serif', 'mono'].includes(next.font)) throw new Error('Unknown appearance setting.');
    if (!permissions.has(next.defaultPermission) || !levels.has(next.defaultThinking)) throw new Error('Unknown task default.');
    if (!Number.isInteger(next.maxConcurrent) || next.maxConcurrent < 1 || next.maxConcurrent > 8) throw new Error('Concurrent agents must be between 1 and 8.');
    if (typeof next.name !== 'string' || next.name.length > 80 || typeof next.instructions !== 'string' || next.instructions.length > 40_000) throw new Error('Name or instructions are too long.');
    if (!Array.isArray(next.skillPaths) || next.skillPaths.some(p => typeof p !== 'string')) throw new Error('Skill folders must be paths.');
    if (next.developerMode !== undefined && typeof next.developerMode !== 'boolean') throw new Error('开发者模式只能打开或关闭。');
    for (const key of ['notifyFinished', 'notifyApproval', 'bootSequence', 'quietUpgrade'] as const) if (next[key] !== undefined && typeof next[key] !== 'boolean') throw new Error('These switches are on or off.');
    if (next.cardHandoff !== undefined) {
      const { tokens, windowPercent } = (next.cardHandoff ?? {}) as { tokens?: unknown; windowPercent?: unknown };
      if (!Number.isInteger(tokens) || (tokens as number) < 10_000 || (tokens as number) > 10_000_000 || !Number.isInteger(windowPercent) || (windowPercent as number) < 10 || (windowPercent as number) > 90) throw new Error('换对话阈值要在 1 万到 1000 万 Token、窗口的 10% 到 90% 之间。');
      next.cardHandoff = { tokens: tokens as number, windowPercent: windowPercent as number };
    }
    if (next.disabledSkillIds !== undefined && (!Array.isArray(next.disabledSkillIds) || next.disabledSkillIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid disabled skill IDs.');
    if (next.skillPaths.some(path => { try { return !statSync(path).isDirectory(); } catch { return true; } })) throw new Error('Select an existing, readable skill folder.');
    this.store.state.preferences = next; this.refreshSkills(); this.changed(); this.pump();
  }
  dismissNotice(): void {
    if (!this.store.state.preferences.migrationNotice) return;
    const { migrationNotice: _notice, ...rest } = this.store.state.preferences;
    this.store.state.preferences = rest; this.changed();
  }
  /** One model's output budget, e.g. from the truncation notice; other models and the credential stay untouched. */
  setModelOutputLimit(gatewayId: string, modelId: string, maxTokens: number): void {
    const gateway = this.store.state.gateways.find(item => item.id === gatewayId);
    if (!gateway) throw new Error('Gateway not found.');
    const models = gatewayModels(gateway);
    const model = models.find(item => item.id === modelId);
    if (!model) throw new Error(`Model "${modelId}" is not configured in this gateway.`);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > model.contextWindow) throw new Error('Output limit must be between 1 and the context window.');
    model.maxTokens = maxTokens;
    const normalized = normalizeGatewayModels({ ...gateway, models });
    const resolved = resolveGatewayModel({ ...gateway, models: normalized }, gateway.modelId);
    Object.assign(gateway, { models: normalized, maxTokens: resolved.maxTokens, defaultsVersion: 6 });
    this.changed();
  }
  setAvatar(role: 'user' | 'assistant', value?: string): void {
    if (!['user', 'assistant'].includes(role)) throw new Error('Unknown avatar role.');
    this.savePreferences({ avatars: { ...this.store.state.preferences.avatars, [role]: value } });
  }
  saveSearch(input: Omit<SearchConfig, 'hasKey'>, apiKey?: string): void {
    if (!input || typeof input.enabled !== 'boolean' || !['auto', 'native', 'exa', 'brave', 'searxng'].includes(input.provider) || typeof input.baseUrl !== 'string') throw new Error('Invalid search settings.');
    let baseUrl = '';
    if (input.provider === 'searxng' || (input.provider === 'auto' && input.baseUrl.trim())) {
      if (input.baseUrl.trim()) {
        const url = new URL(input.baseUrl.trim());
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter an HTTP(S) SearXNG root URL without credentials or query parameters.');
        baseUrl = url.href.replace(/\/+$/, '').replace(/\/search$/, '');
      } else if (input.enabled) throw new Error('Enter your SearXNG instance URL before enabling search.');
    }
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 8192)) throw new Error('Invalid search API key.');
    const key = apiKey !== undefined ? apiKey.trim() : this.vault.get('search:brave');
    if (input.provider === 'brave' && input.enabled && !key) throw new Error('Enter a Brave Search API key before enabling search.');
    if (apiKey !== undefined && input.provider === 'brave') this.vault.set('search:brave', key);
    this.store.state.search = { enabled: input.enabled, provider: input.provider, baseUrl, hasKey: this.vault.has('search:brave') };
    for (const taskId of this.workers.keys()) this.send(taskId, { type: 'search', search: { ...this.store.state.search, apiKey: key } });
    for (const approval of [...this.approvals.values()]) if (approval.toolName === 'web_search') this.approve(approval.id, false);
    this.changed();
  }
  async testSearch(): Promise<{ ok: boolean; message: string }> {
    const config = { ...this.store.state.search, enabled: true };
    try {
      const saved = this.store.state.gateways.find(g => g.id === this.store.state.preferences.defaultGatewayId) ?? this.store.state.gateways[0];
      const gateway = saved ? resolveGatewayModel(saved, saved.id === this.store.state.preferences.defaultGatewayId ? this.store.state.preferences.defaultModelId : undefined) : undefined;
      const result = await ecosystemSearch(config, gateway, gateway ? this.vault.get(gateway.id) : '', 'Electron documentation', 3, this.vault.get('search:brave'));
      return { ok: true, message: `Search returned ${result.results.length} source(s) via ${result.provider}.` };
    } catch (error) { return { ok: false, message: this.redactString(error instanceof Error ? error.message : String(error)) }; }
  }
  saveGateway(input: Omit<Gateway, 'hasKey'>, apiKey?: string): void {
    const url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) base URL without credentials, query or fragment.');
    if (!input.name?.trim() || input.name.length > 120 || !input.id || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) throw new Error('Enter a valid gateway name and identifier.');
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(input.protocol)) throw new Error('Unknown API protocol.');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 8192)) throw new Error('Invalid API key.');
    const baseUrl = input.protocol === 'anthropic-messages' ? input.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') : input.baseUrl.replace(/\/+$/, '');
    const proposed: Gateway = { ...input, baseUrl, hasKey: false, defaultsVersion: 6 };
    const models = normalizeGatewayModels(proposed).map(model => input.protocol !== 'anthropic-messages' || model.adaptiveThinking ? { ...model, effortMap: { ...model.effortMap, ultra: 'max' } } : model);
    const defaultId = input.modelId?.trim() || models[0].id;
    if (!models.some(model => model.id === defaultId)) throw new Error('Choose a default model included in this gateway.');
    const selected = resolveGatewayModel({ ...proposed, models }, defaultId);
    const gateway: Gateway = { id: input.id, name: input.name.trim(), baseUrl, protocol: input.protocol, hasKey: false, models,
      modelId: selected.modelId, reasoning: selected.reasoning, contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, effortMap: selected.effortMap, adaptiveThinking: selected.adaptiveThinking, nativeSearch: selected.nativeSearch, defaultsVersion: 6 };
    for (const model of models) { const resolved = resolveGatewayModel(gateway, model.id); if (resolved.nativeSearch?.enabled) nativeSearchEndpoint(resolved); }
    const previous = this.store.state.gateways.find(item => item.id === gateway.id);
    if (previous) {
      const removed = gatewayModels(previous).filter(model => !models.some(next => next.id === model.id)).map(model => model.id);
      if (this.store.state.tasks.some(task => task.gatewayId === gateway.id && removed.includes(task.modelId || previous.modelId)) || this.store.state.schedules.some(schedule => schedule.gatewayId === gateway.id && removed.includes(schedule.modelId || previous.modelId))) throw new Error('A removed model is still used by a saved task or schedule. Choose another model there before removing it.');
      const active = this.store.state.tasks.filter(task => task.gatewayId === gateway.id && (!terminal.has(task.status) || this.retiring.has(task.id)));
      if (active.length && (previous.baseUrl !== gateway.baseUrl || previous.protocol !== gateway.protocol)) throw new Error('Stop tasks using this connection before changing its address or protocol.');
      for (const task of active) {
        const id = task.modelId || previous.modelId;
        if (JSON.stringify(gatewayModels(previous).find(model => model.id === id)) !== JSON.stringify(models.find(model => model.id === id))) throw new Error('Stop tasks using this model before changing its parameters. Other models can still be added.');
      }
    }
    if (apiKey !== undefined) this.vault.set(input.id, apiKey.trim());
    gateway.hasKey = this.vault.has(input.id);
    const index = this.store.state.gateways.findIndex(item => item.id === gateway.id);
    if (index < 0) this.store.state.gateways.push(gateway); else this.store.state.gateways[index] = gateway;
    if (!this.store.state.preferences.defaultGatewayId) this.store.state.preferences.defaultGatewayId = gateway.id;
    if (this.store.state.preferences.defaultGatewayId === gateway.id && !models.some(model => model.id === this.store.state.preferences.defaultModelId)) this.store.state.preferences.defaultModelId = gateway.modelId;
    this.changed();
  }
  removeGateway(id: string): void {
    if (this.store.state.tasks.some(t => t.gatewayId === id && !terminal.has(t.status))) throw new Error('Stop tasks using this gateway before removing it.');
    this.store.state.gateways = this.store.state.gateways.filter(g => g.id !== id); this.vault.set(id, '');
    if (this.store.state.preferences.defaultGatewayId === id) { this.store.state.preferences.defaultGatewayId = this.store.state.gateways[0]?.id || ''; this.store.state.preferences.defaultModelId = this.store.state.gateways[0]?.modelId; }
    this.changed();
  }
  async testGateway(id: string): Promise<{ ok: boolean; message: string }> {
    const gateway = this.gateway(id);
    const key = this.vault.get(id);
    const headers: Record<string, string> = gateway.protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : key ? { Authorization: `Bearer ${key}` } : {};
    const base = gateway.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${gateway.protocol === 'anthropic-messages' ? '/v1' : ''}/models`);
    try {
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) return { ok: false, message: `Model-list check returned HTTP ${response.status}. Check the base URL and credentials. Some gateways do not expose /models.` };
      return { ok: true, message: 'Gateway model-list endpoint responded. No generation was sent; tool calling and reasoning still need a real task.' };
    } catch (error) { return { ok: false, message: this.redactString(error instanceof Error ? error.message : String(error)) }; }
  }
  async fetchModels(input: { id?: string; baseUrl: string; protocol: Gateway['protocol'] }, apiKey?: string): Promise<Array<{ id: string; name?: string }>> {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 8192)) throw new Error('Invalid API key.');
    const saved = input.id ? this.store.state.gateways.find(gateway => gateway.id === input.id) : undefined;
    let key = apiKey?.trim() || '';
    if (!key && saved) {
      if (new URL(saved.baseUrl).origin !== new URL(input.baseUrl).origin) throw new Error('Enter the key for the new gateway address before fetching its models.');
      key = this.vault.get(saved.id);
    }
    try { return await fetchModelCatalog(input, key); }
    catch (error) { let message = error instanceof Error ? error.message : String(error); if (key) message = message.split(key).join('[redacted]'); throw new Error(this.redactString(message)); }
  }
  diff(id: string) { const task = this.task(id); return getDiff(task.cwd, task.worktree?.baseCommit); }
  async mergeTask(id: string) {
    const task = this.task(id);
    const project = this.store.state.projects.find(p => p.id === task.projectId)!;
    const result = await mergeWorktree(project, task);
    this.changed(); return result;
  }
  private validateSchedule(input: NewSchedule): void {
    if (!input.name.trim() || !input.prompt.trim() || input.prompt.length > 200_000) throw new Error('Enter a schedule name and prompt.');
    if (!this.store.state.projects.some(p => p.id === input.projectId)) throw new Error('Select a project.');
    const selected = resolveGatewayModel(this.gateway(input.gatewayId), input.modelId, input.contextWindow);
    input.modelId = selected.modelId; input.contextWindow = selected.contextWindow;
    if (!permissions.has(input.permission) || !levels.has(input.thinking)) throw new Error('Unknown task settings.');
    if (!Number.isFinite(Date.parse(input.nextRunAt))) throw new Error('Choose a valid next run time.');
    if (input.intervalMinutes !== null && (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525600)) throw new Error('Repeat interval must be 1–525600 minutes.');
  }
  createSchedule(input: NewSchedule): Schedule {
    this.validateSchedule(input);
    const schedule: Schedule = { ...input, id: randomUUID(), enabled: true, missed: Date.parse(input.nextRunAt) < Date.now() };
    this.store.state.schedules.push(schedule); this.changed(); return structuredClone(schedule);
  }
  async updateSchedule(id: string, changes: Partial<NewSchedule> & { enabled?: boolean; runNow?: boolean; skipMissed?: boolean; remove?: boolean }): Promise<void> {
    const schedule = this.store.state.schedules.find(s => s.id === id);
    if (!schedule) throw new Error('Schedule not found.');
    if (changes.remove) { this.store.state.schedules = this.store.state.schedules.filter(s => s.id !== id); this.changed(); return; }
    const { runNow, skipMissed, remove: _, enabled, ...fields } = changes;
    const next = { ...schedule, ...fields };
    if (fields.gatewayId && fields.gatewayId !== schedule.gatewayId && fields.modelId === undefined) next.modelId = undefined;
    this.validateSchedule(next);
    Object.assign(schedule, fields, { modelId: next.modelId, contextWindow: next.contextWindow });
    if (enabled !== undefined) schedule.enabled = enabled;
    if (fields.nextRunAt !== undefined) schedule.missed = Date.parse(fields.nextRunAt) < Date.now();
    if (skipMissed) { schedule.missed = false; schedule.lastError = undefined; const nextAt = nextRunAfter(schedule, Date.now()); if (nextAt) schedule.nextRunAt = nextAt; else schedule.enabled = false; }
    if (runNow) await this.runSchedule(schedule);
    this.changed();
  }
  private async runSchedule(schedule: Schedule): Promise<void> {
    if (this.admittingSchedules.has(schedule.id)) throw new Error('This schedule is already starting a task.');
    if (schedule.lastTaskId && !terminal.has(this.task(schedule.lastTaskId).status)) throw new Error('The previous scheduled task is still active.');
    this.validateSchedule(schedule);
    this.admittingSchedules.add(schedule.id);
    const now = Date.now();
    // Persist admission before any asynchronous Git setup; a restart never silently replays it.
    schedule.lastRunAt = new Date(now).toISOString(); schedule.missed = false; schedule.lastError = undefined;
    const next = nextRunAfter(schedule, now);
    if (next) schedule.nextRunAt = next; else schedule.enabled = false;
    this.changed();
    try {
      const task = await this.createTask({ ...schedule, title: schedule.name, scheduleId: schedule.id });
      schedule.lastTaskId = task.id;
    } catch (error) {
      schedule.missed = true; schedule.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.admittingSchedules.delete(schedule.id); this.changed(); }
  }
  private async enforceBudgets(): Promise<void> {
    if (!this.studio || this.closing) return;
    const settings = this.studio.state.preferences;
    if (!settings.teamTokenBudget && !settings.teamMinutesBudget && !settings.teamMoneyBudget) return;
    for (const parent of this.store.state.tasks.filter(task => !task.parentId && (!terminal.has(task.status) || this.store.state.tasks.some(member => member.parentId === task.id && !terminal.has(member.status))))) {
      if (this.budgetStopping.has(parent.id)) continue;
      const group = this.store.state.tasks.filter(task => task.id === parent.id || task.parentId === parent.id); const usage = budgetUsage(group); const baseline = this.budgetBaselines.get(parent.id);
      if (baseline) { usage.tokens = Math.max(0, usage.tokens - baseline.tokens); usage.money = Math.max(0, usage.money - baseline.money); }
      usage.elapsedMinutes = Math.max(0, (Date.now() - (this.budgetStarts.get(parent.id) || Date.parse(parent.startedAt || parent.createdAt))) / 60000);
      const reason = exceededBudget({ tokens: settings.teamTokenBudget, minutes: settings.teamMinutesBudget, money: settings.teamMoneyBudget }, usage);
      if (reason) { this.budgetStopping.add(parent.id); parent.messages.push({ id: randomUUID(), role: 'system', text: reason, at: stamp() }); await this.cancelTask(parent.id); }
    }
  }
  private async tick(): Promise<void> {
    if (this.tickRunning || this.closing || this.bootPaused) return;
    this.tickRunning = true;
    const now = Date.now(); const previous = this.lastTick; this.lastTick = now;
    try {
      await this.enforceBudgets();
      for (const schedule of this.store.state.schedules) {
        const action = evaluateSchedule(schedule, now, previous);
        if (!action) continue;
        if (action === 'missed' || (schedule.lastTaskId && !terminal.has(this.task(schedule.lastTaskId).status))) {
          schedule.missed = true; this.changed(); this.emit('missed', structuredClone(schedule));
        } else {
          try { await this.runSchedule(schedule); } catch (error) { schedule.missed = true; schedule.lastError = error instanceof Error ? error.message : String(error); this.changed(); this.emit('missed', structuredClone(schedule)); }
        }
      }
    } finally { this.tickRunning = false; }
  }
  /** Runs the hooks of one event for this task and writes what they printed into its conversation (§6.2). */
  async hooks(event: HookEvent, task: Task | undefined, extra: Omit<HookInput, 'event' | 'cwd' | 'env'> & { quiet?: boolean } = {}): Promise<HookOutcome> {
    const config = this.store.state.hooks;
    if (!hooksFor(config, event, extra.toolName).length) return { decision: 'allow', messages: [] };
    const project = task ? this.store.state.projects.find(item => item.id === task.projectId) : undefined;
    let outcome: HookOutcome;
    try { outcome = await runHooks(config, { event, cwd: task?.cwd ?? project?.path ?? this.dataDir, taskId: task?.id, projectDir: project?.path, ...extra }); }
    catch (error) { outcome = { decision: 'allow', messages: [`钩子无法运行：${error instanceof Error ? error.message : String(error)}`] }; }
    const notes = [...outcome.messages, ...(outcome.decision === 'deny' && outcome.reason ? [outcome.reason] : [])].filter(Boolean);
    if (task && notes.length && !extra.quiet) {
      for (const note of notes.slice(0, 5)) task.messages.push({ id: randomUUID(), role: 'system', text: `[${event}] ${note.slice(0, 2_000)}`, at: stamp() });
      this.changed();
    }
    return outcome;
  }
  /** Runs one hook command on a sample event, for the try-it button in settings. */
  async testHook(event: HookEvent, command: string, timeout: number | undefined, projectId?: string): Promise<HookOutcome> {
    const { hooks } = parseHooks({ [event]: [{ hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }] }, { strict: true });
    const project = projectId ? this.store.state.projects.find(item => item.id === projectId) : undefined;
    return runHooks(hooks, { event, cwd: project?.path ?? this.dataDir, projectDir: project?.path, toolName: 'write', toolInput: { path: 'example.txt' }, prompt: '试跑钩子', message: '试跑钩子' });
  }
  /** True when a tool call has to ask the app first. */
  private toolHooks(): boolean { return !!this.store.state.hooks.PreToolUse?.length || !!this.store.state.hooks.PostToolUse?.length; }
  saveHooks(value: unknown): void {
    const { hooks } = parseHooks(value, { strict: true });
    this.store.state.hooks = hooks;
    for (const id of this.workers.keys()) this.send(id, { type: 'hooks', enabled: this.toolHooks() });
    this.changed();
  }
  /** Reads the hooks in the user's and the project's Claude Code settings, for the import preview. */
  claudeHooks(projectId?: string): Array<{ source: string; path: string; hooks: HooksConfig; skipped: string[] }> {
    const project = projectId ? this.store.state.projects.find(item => item.id === projectId) : undefined;
    const files: Array<{ source: string; path: string }> = [
      { source: 'user', path: join(process.env.CARDWRIGHT_SKILL_HOME ?? homedir(), '.claude', 'settings.json') },
      ...(project ? [{ source: 'project', path: join(project.path, '.claude', 'settings.json') }] : []),
    ];
    const found: Array<{ source: string; path: string; hooks: HooksConfig; skipped: string[] }> = [];
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file.path, 'utf8'));
        const { hooks, skipped } = parseHooks(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).hooks : undefined);
        if (countHooks(hooks) || skipped.length) found.push({ ...file, hooks, skipped });
      } catch { /* No readable settings file there. */ }
    }
    return found;
  }
  refreshSkills(): void {
    let bundledPaths: string[] = [];
    try { bundledPaths = getEcosystemSkillPaths(); } catch { /* Worker reports missing bundled resources. */ }
    this.skills = discoverSkills({ projects: this.store.state.projects, customPaths: this.store.state.preferences.skillPaths, disabledIds: this.store.state.preferences.disabledSkillIds || [], bundledPaths, homeDir: process.env.CARDWRIGHT_SKILL_HOME });
    this.agents = discoverAgents({ projects: this.store.state.projects, homeDir: process.env.CARDWRIGHT_SKILL_HOME });
  }
  /** Built-in roles, the user's own, and the subagents discovered for this project (§6.2). */
  roles(projectId?: string): AgentRole[] {
    return mergeAgents({ saved: this.store.state.ecosystem.roles, discovered: this.agents, disabled: this.store.state.preferences.disabledAgentIds || [], projectId });
  }
  setAgentEnabled(id: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean' || !this.roles().some(role => role.id === id)) throw new Error('Select a subagent.');
    const disabled = new Set(this.store.state.preferences.disabledAgentIds || []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    this.store.state.preferences.disabledAgentIds = [...disabled]; this.changed();
  }
  setSkillEnabled(id: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean' || !this.skills.some(skill => skill.id === id)) throw new Error('Select a discovered skill.');
    const disabled = new Set(this.store.state.preferences.disabledSkillIds || []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    this.store.state.preferences.disabledSkillIds = [...disabled]; this.refreshSkills(); this.changed();
  }
  answerInteraction(id: string, answer: unknown): void {
    const item = this.interactions.get(id); if (!item) throw new Error('This question is no longer pending.');
    if (JSON.stringify(answer).length > 100_000) throw new Error('Answer is too long.');
    if (answer !== null) {
      if (['confirm', 'plan'].includes(item.type) && typeof answer !== 'boolean') throw new Error('Choose an explicit response.');
      if (item.type === 'select' && (typeof answer !== 'string' || !item.options?.includes(answer))) throw new Error('Choose one of the offered options.');
      if (['input', 'editor'].includes(item.type) && typeof answer !== 'string') throw new Error('Enter a text answer.');
      if (item.type === 'questionnaire' && (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.values(answer).some(value => typeof value !== 'string' && !(Array.isArray(value) && value.every(entry => typeof entry === 'string'))))) throw new Error('Invalid questionnaire response.');
    }
    this.interactions.delete(id); this.task(item.taskId).status = 'running';
    const local = this.localAnswers.get(id);
    if (local) { this.localAnswers.delete(id); local(answer); this.changed(); return; }
    this.respond(item.taskId, id, answer); this.changed();
  }
  setPlanMode(id: string, enabled: boolean): void {
    const task = this.task(id); if (this.workers.has(id)) throw new Error('Stop the active run before changing planning mode.');
    task.planMode = Boolean(enabled); if (!enabled) task.plan = undefined; this.changed();
  }
  async approvePlan(id: string): Promise<void> {
    const task = this.task(id);
    if (this.workers.has(id) || !task.plan || task.plan.status !== 'pending') throw new Error('Wait for a complete proposed plan before approving.');
    if (task.sharedReadOnly) throw new Error('A shared read-only member can propose a plan; ask the lead to implement it.');
    task.plan.status = 'approved'; task.planMode = false; task.role = 'general-purpose'; this.changed();
    await this.prompt(id, `Implement this user-approved plan. Track the steps with todo and verify the result.\n\n${task.plan.text}`);
  }
  async command(id: string, input: string): Promise<void> {
    const task = this.task(id); const command = input.trim();
    if (command === '/plan') { this.setPlanMode(id, !task.planMode); return; }
    if (command === '/todos') { task.messages.push({ id: randomUUID(), role: 'system', text: (task.todos || []).map(todo => `${todo.status}: ${todo.content}`).join('\n') || 'No todos yet.', at: stamp() }); this.changed(); return; }
    if (command === '/memory') { const memories = await this.listMemories(task.projectId); task.messages.push({ id: randomUUID(), role: 'system', text: memories.slice(0, 30).map(item => item.content).join('\n\n') || 'No project memories yet.', at: stamp() }); this.changed(); return; }
    if (command === '/dream' || command === '/compact') { await this.prompt(id, command); return; }
    // /init writes the project's own instruction file: the one it already has, or a new CLAUDE.md (§6.2).
    if (command === '/init') {
      const existing = ['AGENTS.md', 'CLAUDE.md'].find(name => existsSync(join(task.cwd, name))) ?? null;
      await this.prompt(id, initPrompt(existing, this.store.state.preferences.language));
      return;
    }
    const skillName = command.split(/\s+/)[0].slice(1);
    if (['claude-md-improver', 'claude-md-revision'].includes(skillName)) {
      this.refreshSkills();
      if (!skillsForProject(this.skills, task.projectId).some(skill => skill.name === skillName)) throw new Error('Enable this skill before using it.');
      await this.prompt(id, `/skill:${skillName}${command.slice(skillName.length + 1)}`); return;
    }
    if (/^\/cache-optimizer(?:\s+(?:stats|doctor|help))?$/.test(command)) { await this.prompt(id, command); return; }
    throw new Error('This built-in command is not available.');
  }
  saveEcosystem(changes: Partial<Pick<EcosystemConfig, 'memoryEnabled' | 'cacheEnabled' | 'showStatusline' | 'compactTools'>>): void {
    for (const [key, value] of Object.entries(changes)) if (!['memoryEnabled', 'cacheEnabled', 'showStatusline', 'compactTools'].includes(key) || typeof value !== 'boolean') throw new Error('Invalid ecosystem preference.');
    Object.assign(this.store.state.ecosystem, changes); this.changed();
  }
  saveAgentRole(role: AgentRole): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(role.id) || !role.name.trim() || !role.prompt.trim() || role.prompt.length > 20_000 || typeof role.readOnly !== 'boolean') throw new Error('Enter a valid role ID, name and prompt.');
    if (defaultEcosystem().roles.some(item => item.id.toLowerCase() === role.id.toLowerCase())) throw new Error('Built-in roles cannot be overwritten. Create a custom role.');
    if (this.store.state.tasks.some(task => task.role === role.id && !terminal.has(task.status))) throw new Error('Stop tasks using this role before editing it.');
    const roles = this.store.state.ecosystem.roles; const saved = { id: role.id, name: role.name.trim(), prompt: role.prompt, readOnly: role.readOnly, builtIn: false };
    const index = roles.findIndex(item => item.id === role.id); if (index < 0) roles.push(saved); else roles[index] = saved; this.changed();
  }
  removeAgentRole(id: string): void {
    if (this.store.state.ecosystem.roles.some(role => role.id === id && role.builtIn)) throw new Error('Built-in roles cannot be removed.');
    if (this.store.state.tasks.some(task => task.role === id && !terminal.has(task.status))) throw new Error('Stop tasks using this role first.');
    this.store.state.ecosystem.roles = this.store.state.ecosystem.roles.filter(role => role.id !== id); this.changed();
  }
  saveMcpServer(input: McpServerConfig, secrets?: { env?: Record<string, string>; headers?: Record<string, string> }): void {
    if (this.workers.size) throw new Error('Stop active agents before changing MCP connections.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.id) || !input.name?.trim() || typeof input.enabled !== 'boolean' || !['stdio', 'http'].includes(input.transport)) throw new Error('Invalid MCP server configuration.');
    if (input.transport === 'stdio' && (!input.command?.trim() || input.command.includes('\0') || input.args?.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('Enter a valid executable and argument list.');
    if (input.transport === 'http') { const url = new URL(input.url || ''); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Use an HTTP(S) MCP URL without credentials or query parameters. Put credentials in private headers.'); }
    if (secrets !== undefined) {
      for (const values of [secrets.env, secrets.headers]) if (values && (typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) => typeof value !== 'string' || key.length > 200 || value.length > 8192 || /[\r\n\0]/.test(key)))) throw new Error('Private MCP settings must contain string values.');
      this.vault.set(`mcp:${input.id}`, Object.keys(secrets.env || {}).length || Object.keys(secrets.headers || {}).length ? JSON.stringify(secrets) : '');
    }
    const server: McpServerConfig = { id: input.id, name: input.name.trim(), enabled: input.enabled, transport: input.transport, command: input.command?.trim(), args: input.args, url: input.url, hasSecrets: this.vault.has(`mcp:${input.id}`) };
    const servers = this.store.state.ecosystem.mcpServers; const index = servers.findIndex(item => item.id === input.id); if (index < 0) servers.push(server); else servers[index] = server; this.changed();
  }
  removeMcpServer(id: string): void { if (this.workers.size) throw new Error('Stop active agents before changing MCP connections.'); this.store.state.ecosystem.mcpServers = this.store.state.ecosystem.mcpServers.filter(server => server.id !== id); this.vault.set(`mcp:${id}`, ''); this.changed(); }
  private async memory(projectId: string) {
    if (!this.store.state.projects.some(project => project.id === projectId)) throw new Error('Select a project.');
    return ProjectMemory.open({ dataDir: this.dataDir, projectId, sessionId: 'desktop', redact: text => this.redactString(text) });
  }
  async listMemories(projectId: string, query?: string): Promise<MemoryItem[]> { const memory = await this.memory(projectId); try { return (query?.trim() ? memory.search(query) : memory.list()).map(item => ({ id: 'source' in item && item.source === 'journal' ? `journal:${item.id}` : String(item.id), content: item.content, category: item.category, source: 'sourceType' in item ? item.sourceType : 'source' in item ? item.source : undefined, createdAt: 'createdAt' in item ? new Date(item.createdAt).toISOString() : undefined })); } finally { memory.close(); } }
  async writeMemory(projectId: string, content: string): Promise<void> { const memory = await this.memory(projectId); try { memory.write({ content, source: 'agent', category: 'USER_DIRECTIVES' }); } finally { memory.close(); } }
  async archiveMemory(projectId: string, id: string): Promise<void> { if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('Invalid memory ID.'); const memory = await this.memory(projectId); try { memory.archive(Number(id)); } finally { memory.close(); } }
  async dreamMemory(projectId: string): Promise<Task> { if (!this.store.state.ecosystem.memoryEnabled) throw new Error('Enable project memory first.'); return this.createTask({ projectId, title: 'Dreamer · 项目记忆整理', prompt: '/dream', isolated: false, role: 'Explore' }); }
  saveWebdav(config: { url: string; username: string }, password?: string): void {
    if (config.url) { const url = new URL(config.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter a WebDAV root URL without embedded credentials.'); }
    if (typeof config.username !== 'string' || config.username.length > 500 || (password !== undefined && (typeof password !== 'string' || password.length > 8192))) throw new Error('Invalid WebDAV account.');
    if (password !== undefined) this.vault.set('webdav:password', password);
    this.store.state.ecosystem.webdav = { url: config.url.trim(), username: config.username.trim(), hasPassword: this.vault.has('webdav:password') }; this.changed();
  }
  private webdavConnection() { return { ...this.store.state.ecosystem.webdav, password: this.vault.get('webdav:password') }; }
  previewBackup(source: 'local' | 'remote' = 'local') { return this.backup.preview(source, this.webdavConnection()); }
  pushBackup() { return this.backup.push(this.webdavConnection()); }
  pullBackup() { if (this.workers.size) throw new Error('Stop active agents before restoring configuration.'); return this.backup.pull(this.webdavConnection()); }
  private async applyBackup(data: BackupData & { importedSkillPaths: string[] }): Promise<void> {
    for (const gateway of data.gateways) {
      const existing = this.store.state.gateways.find(item => item.id === gateway.id);
      const incoming = gatewayModels(gateway);
      // Keep additional local models so restoring an older backup cannot orphan a task.
      const models = [...incoming, ...(existing ? gatewayModels(existing).filter(model => !incoming.some(item => item.id === model.id)) : [])];
      this.saveGateway({ ...gateway, models });
    }
    this.savePreferences({ ...data.preferences, skillPaths: [...new Set([...this.store.state.preferences.skillPaths, ...data.importedSkillPaths.map(path => dirname(path))])] });
    this.saveSearch({ ...data.search, enabled: data.search.provider === 'brave' ? this.vault.has('search:brave') && data.search.enabled : data.search.enabled });
    this.saveEcosystem({ memoryEnabled: data.ecosystem.memoryEnabled, cacheEnabled: data.ecosystem.cacheEnabled, showStatusline: data.ecosystem.showStatusline, compactTools: data.ecosystem.compactTools });
    for (const role of data.ecosystem.roles) if (!defaultEcosystem().roles.some(item => item.id === role.id)) this.saveAgentRole({ ...role, builtIn: false });
    for (const server of data.ecosystem.mcpServers) this.saveMcpServer({ ...server, enabled: false });
    for (const group of data.memories) {
      const matches = this.store.state.projects.filter(p => p.name === group.projectName);
      const project = this.store.state.projects.find(p => p.id === group.projectId) ?? (matches.length === 1 ? matches[0] : undefined); if (!project) continue;
      const memory = await this.memory(project.id); try { for (const item of group.items) memory.write({ content: item.content, source: item.source === 'dreamer' || item.source === 'historian' ? item.source : 'agent', category: MEMORY_CATEGORIES.find(category => category === item.category) || 'PROJECT_RULES' }); } finally { memory.close(); }
    }
    this.changed();
  }
  allowedPath(path: string): boolean {
    const target = resolve(path).toLowerCase();
    return [this.dataDir, ...this.store.state.projects.map(p => p.path), ...this.store.state.tasks.map(t => t.cwd), ...this.store.state.preferences.skillPaths, ...this.skills.map(s => s.path)].some(p => target === resolve(p).toLowerCase());
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer); if (this.changedTimer) clearTimeout(this.changedTimer);
    this.studio?.stopChecks();
    while (this.starting.size) await new Promise(resolve => setTimeout(resolve, 20));
    for (const id of [...this.workers.keys()]) {
      this.send(id, { type: 'cancel' }); this.task(id).status = 'cancelled'; unqueue(this.task(id));
    }
    await new Promise(resolve => setTimeout(resolve, this.workers.size ? 1500 : 0));
    for (const id of [...this.workers.keys()]) this.retire(id);
    await Promise.all([...this.retiring.values()].map(value => value.finished));
    await this.studio?.close();
    this.store.save();
    await this.store.flush();
  }
}
