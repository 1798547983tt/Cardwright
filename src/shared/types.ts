import type { AttachmentInfo, DeliverySummary, ModelPricing, StudioBridge, StudioState } from './studio-types.ts';
import type { AppUpdate } from './app-updates.ts';
import type { RendererErrorReport } from './diagnostics.ts';
import type { HooksConfig } from '../core/hooks-config.ts';
import type { ThemeDefinition } from './themes.ts';
import type { PetTarget, SpriteLayout } from './pets.ts';
import type { CardChange, NewCardChange, CardRun, CardRunScope, CardRunSettings, CardSettings, PromptOverrideDetail, PromptOverrideItem, CardMeta, CardPieceImport, CardPreview, CardPreviewKind, CardPieceSummary, CardCheckReport, CardComponentResult, CardComponentSummary, CardExportResult, CardImportPreview, CardImportReport, CardLoreSuggestion, CardProjectView, CardStudioSnapshot, CardTaskInfo, CardVariableTableView, CoverSource, NewCardComponent, NewCardProject, PlanMode, SourceImportReport, SourceRecord, StartCardConversation } from './card-studio/types.ts';
export type PermissionMode = 'ask' | 'edit' | 'full';
export type TaskStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface GatewayModel {
  id: string; name?: string; reasoning: boolean; contextWindow: number; maxTokens: number;
  effortMap?: Partial<Record<ThinkingLevel, string | null>>; adaptiveThinking?: boolean;
  nativeSearch?: { enabled: boolean; responsesUrl?: string };
  pricing?: ModelPricing;
}
export interface Gateway {
  id: string; name: string; baseUrl: string; modelId: string;
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  reasoning: boolean; contextWindow: number; maxTokens: number; hasKey: boolean;
  nativeSearch?: { enabled: boolean; responsesUrl?: string };
  effortMap?: Partial<Record<ThinkingLevel, string | null>>; adaptiveThinking?: boolean;
  defaultsVersion?: number;
  models?: GatewayModel[];
  pricing?: ModelPricing;
}
export interface Preferences {
  /** 主题: 'system', a built-in id (dark, light, sakura) or a theme pack's id; a pack that has gone shows as dark. */
  name: string; theme: string; language: 'en' | 'zh';
  font: 'sans' | 'serif' | 'mono'; reducedMotion: boolean; notifications: boolean;
  instructions: string; defaultPermission: PermissionMode; maxConcurrent: number;
  defaultGatewayId: string; defaultThinking: ThinkingLevel; skillPaths: string[];
  defaultModelId?: string; defaultContextWindow?: number;
  disabledSkillIds?: string[];
  /** Subagents the user switched off, built-in, saved or discovered. */
  disabledAgentIds?: string[];
  /** Origins the built-in browser may open without asking again (§6.4). */
  browserAllowed?: string[];
  avatars?: { user?: string; assistant?: string };
  /** One-time upgrade notice; only the main process writes it and `dismissNotice` clears it. */
  migrationNotice?: { kind: 'output-limit'; models: string[] };
  /** Notifications by kind; the master switch is `notifications`. */
  notifyFinished?: boolean; notifyApproval?: boolean;
  /** Synthesized interface cues; played only while the window is focused. Off by default since 0.9. */
  soundEnabled: boolean; soundVolume: number;
  /** The startup animation; off by default since 0.9. */
  bootSequence?: boolean;
  /** Set once when an older profile is opened by 0.9, which turns the animation and the sounds off. */
  quietUpgrade?: boolean;
  /** Card studio: when the app offers a new conversation (tokens, or share of the model window, whichever first). */
  cardHandoff?: { tokens: number; windowPercent: number };
  /** Card studio: shows and edits the built-in prompts (提示词覆盖). */
  developerMode?: boolean;
  /** 桌宠: off by default; the pet, when none is chosen, is the theme's; where its floating window was dragged to. */
  petEnabled?: boolean; petId?: string; petPosition?: { x: number; y: number };
  /** 新版本提醒 (1.1): once a day the version number of the latest GitHub release; on unless false. */
  releaseCheck?: boolean;
}
/** 一键自检 of a gateway: the model list, then one completion of a single token; each step on its own. */
export interface GatewaySelfTest { ok: boolean; steps: Array<{ step: 'models' | 'completion'; ok: boolean; detail: string; ms: number }> }
export interface PetSummary { id: string; displayName: string; description: string; builtIn: boolean; version: 1 | 2; /** The pack carries a NOTICE.md (source, author, licence). */ notice: boolean }
export interface AppearanceSnapshot {
  themes: ThemeDefinition[]; rejectedThemes: Array<{ folder: string; reason: string }>;
  pets: PetSummary[]; rejectedPets: Array<{ folder: string; reason: string }>;
  themesFolder: string; petsFolder: string;
}
export interface SearchConfig { enabled: boolean; provider: 'auto' | 'native' | 'exa' | 'brave' | 'searxng'; baseUrl: string; hasKey: boolean }
export interface SearchResult { title: string; url: string; snippet: string; age?: string }
export interface SearchOutput { query: string; provider: 'native' | 'exa' | 'brave' | 'searxng'; results: SearchResult[]; searchedAt: string; answer?: string }
export interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; dependsOn?: string[] }
export interface UserQuestion { id: string; question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }
export interface Interaction { id: string; taskId: string; type: 'select' | 'confirm' | 'input' | 'editor' | 'questionnaire' | 'plan'; title: string; body?: string; options?: string[]; questions?: UserQuestion[]; secret?: boolean; placeholder?: string; initialValue?: string }
export interface McpServerConfig { id: string; name: string; enabled: boolean; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; hasSecrets?: boolean }
export interface AgentRole {
  id: string; name: string; prompt: string; readOnly: boolean; builtIn?: boolean;
  /** Where this subagent comes from; absent on the roles saved before 0.9. */
  source?: 'builtin' | 'custom' | 'project' | 'user';
  /** Discovered subagents carry their own description, file and declared tools; Cardwright only reads the tools to tell read-only ones apart. */
  description?: string; path?: string; tools?: string[]; model?: string; projectId?: string;
  enabled?: boolean;
  /** Another subagent of the same name takes precedence. */
  shadowedBy?: string;
}
export interface EcosystemConfig { memoryEnabled: boolean; cacheEnabled: boolean; showStatusline: boolean; compactTools: boolean; roles: AgentRole[]; mcpServers: McpServerConfig[]; webdav: { url: string; username: string; hasPassword: boolean } }
export interface ExtensionInfo { id: string; name: string; version: string; category: string; integration: 'native' | 'adapter' | 'skills'; enabled: boolean; description: string; source: string; note?: string }
export interface MemoryItem { id: string; content: string; category?: string; source?: string; createdAt?: string }
export interface BackupPreview { files: string[]; bytes: number; createdAt: string; excludes: string[] }
export interface Project { id: string; name: string; path: string; isGit: boolean; createdAt: string; collapsed?: boolean; pinned?: boolean; /** Card studio projects appear only in the card library. */ kind?: 'card'; cardSettings?: CardSettings; /** The card's 一键制作 / 全部开做 run, if any. */ cardRun?: CardRun }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'system'; text: string; thinking?: string; /** When the thinking began, moved on by earlier thinking time when the model thinks again, so now minus this is the total while it thinks. */ thinkingStartedAt?: string; /** How long the model thought, set once it stops thinking. */ thinkingMs?: number; at: string; usage?: Usage; model?: string; turnId?: string; sessionEntryId?: string; pending?: boolean; attachments?: AttachmentInfo[]; /** The card dispatch this message started; 撤回 sends it back to 未派. */ dispatchId?: string }
export interface ToolCall { id: string; toolCallId?: string; name: string; args: Record<string, unknown>; output: string; status: 'running' | 'waiting' | 'completed' | 'failed'; patch?: string; at: string; search?: SearchOutput; turnId?: string }
/** A phase of a long conversation, marked by the agent (§6.3). */
export interface TaskChapter { id: string; title: string; turnId: string; at: string }
export interface TaskRevision { id: string; label: string; createdAt: string; messages: ChatMessage[]; tools: ToolCall[]; sessionFile?: string; sessionLeafId?: string | null; todos?: TodoItem[]; plan?: Task['plan']; compactions?: number }
export interface Task {
  id: string; projectId: string; title: string; cwd: string; parentId?: string;
  status: TaskStatus; permission: PermissionMode; gatewayId: string; thinking: ThinkingLevel;
  modelId?: string; contextWindow?: number;
  createdAt: string; updatedAt: string; messages: ChatMessage[]; tools: ToolCall[];
  sessionFile?: string; worktree?: { path: string; branch: string; baseBranch: string; baseCommit: string };
  error?: string; scheduleId?: string; archived?: boolean;
  role?: string; planMode?: boolean; plan?: { text: string; status: 'draft' | 'pending' | 'approved' };
  todos?: TodoItem[]; runtimeStatus?: Record<string, string>; compactions?: number;
  /** The phases the agent marked while working; the conversation shows them as chapters. */
  chapters?: TaskChapter[];
  pinned?: boolean; activeRevisionId?: string; revisions?: TaskRevision[]; sessionLeafId?: string | null; branchBeforeEntryId?: string;
  agentName?: string; squadId?: string; assignedTask?: string; sharedReadOnly?: boolean;
  /** A squad member writing in its lead's folder because no separate Git worktree is available. */
  sharedWorkspace?: boolean;
  workerActive?: boolean; activationCount?: number; startedAt?: string; completedAt?: string;
  contextUsage?: { tokens: number | null; window: number; percent: number | null }; contextCompacting?: boolean;
  delivery?: DeliverySummary; checkpointIds?: string[]; cachePrefix?: Record<string, unknown>;
  /** Set when the final response hit its output limit; the run is failed and nothing after the cut ran. */
  truncation?: { outputTokens: number; maxTokens: number; model: string; turnId?: string; at: string };
  /** A section conversation of a card project; hidden from the workbench. */
  card?: CardTaskInfo;
}
export interface Approval { id: string; taskId: string; toolName: string; args: Record<string, unknown>; reason: string; createdAt: string }
export interface Schedule {
  id: string; name: string; projectId: string; prompt: string; gatewayId: string;
  thinking: ThinkingLevel; permission: PermissionMode; isolated: boolean;
  modelId?: string; contextWindow?: number;
  nextRunAt: string; intervalMinutes: number | null; enabled: boolean;
  missed: boolean; lastRunAt?: string; lastTaskId?: string; lastError?: string;
}
export interface SkillInfo { name: string; description: string; path: string; id?: string; source?: 'project' | 'user' | 'custom' | 'bundled'; enabled?: boolean; disableModelInvocation?: boolean; shadowedBy?: string; projectId?: string }
/** One tab of the built-in browser (§6.4). */
export interface BrowserTab { id: string; title: string; url: string; loading: boolean; takenOver: boolean }
export interface BrowserState { tabs: BrowserTab[]; activeId: string; pending?: { origin: string; url: string }; visible: boolean }
export interface AppSnapshot {
  publicationRevision?: number;
  storageError?: string;
  preferences: Preferences; gateways: Gateway[]; projects: Project[]; tasks: Task[];
  schedules: Schedule[]; approvals: Approval[]; skills: SkillInfo[]; version: string;
  search: SearchConfig;
  ecosystem: EcosystemConfig; extensions: ExtensionInfo[]; interactions: Interaction[];
  /** The user's own hooks, in Claude Code's settings.json shape (§6.2). */
  hooks: HooksConfig;
  /** The built-in browser, when it has been opened in this session. */
  browser?: BrowserState;
  studio?: StudioState;
  cardStudio?: CardStudioSnapshot;
}
export interface NewTask {
  projectId: string; prompt?: string; title?: string; gatewayId?: string;
  thinking?: ThinkingLevel; permission?: PermissionMode; isolated?: boolean; parentId?: string;
  scheduleId?: string;
  modelId?: string; contextWindow?: number;
  role?: string; planMode?: boolean;
  agentName?: string; squadId?: string; sharedReadOnly?: boolean; sharedWorkspace?: boolean;
  attachments?: string[];
  card?: CardTaskInfo;
}
export interface NewSchedule {
  name: string; projectId: string; prompt: string; gatewayId: string;
  thinking: ThinkingLevel; permission: PermissionMode; isolated: boolean;
  nextRunAt: string; intervalMinutes: number | null;
  modelId?: string; contextWindow?: number;
}
export interface DiffResult { patch: string; status: string; branch: string; untracked: string[] }
export interface Bridge extends StudioBridge {
  snapshot(): Promise<AppSnapshot>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  /** Internal renderer stream; avoids copying complete histories across contextBridge. */
  subscribeUpdates?(listener: (update: AppUpdate) => void): () => void;
  /** The desk pet's click (ADR 0018): the main process asks this window to open what the pet reported. */
  onOpen(listener: (target: PetTarget) => void): () => void;
  pickProject(): Promise<Project | null>;
  addProject(path: string): Promise<Project>;
  updateProject(id: string, changes: { name?: string; collapsed?: boolean; pinned?: boolean }): Promise<void>;
  createTask(input: NewTask): Promise<Task>;
  prompt(taskId: string, text: string, behavior?: 'steer' | 'followUp', attachments?: string[]): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  updateTask(taskId: string, changes: { title?: string; permission?: PermissionMode; gatewayId?: string; modelId?: string; contextWindow?: number; thinking?: ThinkingLevel; archived?: boolean; pinned?: boolean }): Promise<void>;
  regenerate(taskId: string, userMessageId: string, editedText?: string): Promise<void>;
  switchRevision(taskId: string, revisionId: string): Promise<void>;
  resumeAgent(taskId: string, message: string): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  savePreferences(changes: Partial<Preferences>): Promise<void>;
  uploadAvatar(role: 'user' | 'assistant'): Promise<void>;
  resetAvatar(role: 'user' | 'assistant'): Promise<void>;
  /** Opens a file dialog and returns a bounded preview for the in-app cropper. */
  pickAvatarImage(role: 'user' | 'assistant'): Promise<{ dataUrl: string; width: number; height: number } | null>;
  saveAvatarImage(role: 'user' | 'assistant', dataUrl: string): Promise<void>;
  setModelOutputLimit(gatewayId: string, modelId: string, maxTokens: number): Promise<void>;
  dismissNotice(): Promise<void>;
  saveSearch(config: Omit<SearchConfig, 'hasKey'>, apiKey?: string): Promise<void>;
  testSearch(): Promise<{ ok: boolean; message: string }>;
  answerInteraction(id: string, answer: unknown): Promise<void>;
  setPlanMode(taskId: string, enabled: boolean): Promise<void>;
  approvePlan(taskId: string): Promise<void>;
  command(taskId: string, command: string): Promise<void>;
  saveEcosystem(changes: Partial<Pick<EcosystemConfig, 'memoryEnabled' | 'cacheEnabled' | 'showStatusline' | 'compactTools'>>): Promise<void>;
  saveMcpServer(server: McpServerConfig, secrets?: { env?: Record<string, string>; headers?: Record<string, string> }): Promise<void>;
  removeMcpServer(id: string): Promise<void>;
  saveAgentRole(role: AgentRole): Promise<void>;
  removeAgentRole(id: string): Promise<void>;
  listMemories(projectId: string, query?: string): Promise<MemoryItem[]>;
  writeMemory(projectId: string, content: string): Promise<void>;
  archiveMemory(projectId: string, id: string): Promise<void>;
  dreamMemory(projectId: string): Promise<Task>;
  saveWebdav(config: { url: string; username: string }, password?: string): Promise<void>;
  previewBackup(source?: 'local' | 'remote'): Promise<BackupPreview>;
  pushBackup(): Promise<{ message: string }>;
  pullBackup(): Promise<{ message: string }>;
  openExternal(url: string): Promise<void>;
  saveGateway(gateway: Omit<Gateway, 'hasKey'>, apiKey?: string): Promise<void>;
  removeGateway(id: string): Promise<void>;
  /** Lists the models, then sends one completion of a single token, to the gateway being set up. */
  selfTestGateway(input: { id?: string; baseUrl: string; protocol: Gateway['protocol']; modelId: string }, apiKey?: string): Promise<GatewaySelfTest>;
  testGateway(id: string): Promise<{ ok: boolean; message: string }>;
  fetchModels(input: { id?: string; baseUrl: string; protocol: Gateway['protocol'] }, apiKey?: string): Promise<Array<{ id: string; name?: string }>>;
  diff(taskId: string): Promise<DiffResult>;
  mergeTask(taskId: string): Promise<{ message: string }>;
  createSchedule(input: NewSchedule): Promise<Schedule>;
  updateSchedule(id: string, changes: Partial<NewSchedule> & { enabled?: boolean; runNow?: boolean; skipMissed?: boolean; remove?: boolean }): Promise<void>;
  pickSkillFolder(): Promise<string | null>;
  refreshSkills(): Promise<void>;
  setSkillEnabled(id: string, enabled: boolean): Promise<void>;
  /** Switches one subagent off or on, built-in, saved or discovered. */
  setAgentEnabled(id: string, enabled: boolean): Promise<void>;
  /** Hooks: saving replaces the whole block, as in Claude Code's settings.json. */
  saveHooks(hooks: unknown): Promise<void>;
  /** What the user's and the project's Claude Code settings hold, for the import preview. */
  claudeCodeHooks(projectId?: string): Promise<Array<{ source: string; path: string; hooks: HooksConfig; skipped: string[] }>>;
  testHook(event: string, command: string, timeout?: number, projectId?: string): Promise<{ decision: 'allow' | 'deny'; reason?: string; messages: string[] }>;
  exportData(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  /** `reload` reloads the interface from the desktop process; the page itself cannot navigate. */
  window(action: 'minimize' | 'maximize' | 'close' | 'reload'): Promise<void>;
  /** Writes an interface error to <资料目录>/logs/renderer.log and returns the diagnostic text an error card copies. */
  reportRendererError(report: RendererErrorReport): Promise<string>;
  /** Opens <资料目录>/logs, creating it first. */
  openLogFolder(): Promise<void>;
  /** The system clipboard, written by the desktop process: the permission handler refuses the page's own clipboard writes. */
  copyText(text: string): Promise<void>;
  /** 新版本提醒 (1.1): this build, whether the latest release is newer, when the daily check last succeeded, and that release with its page only while it is newer. */
  readReleaseCheck(): Promise<{ current: string; newer: boolean; latest?: string; url?: string; checkedAt?: string }>;
  /** True only when the app was started with CARDWRIGHT_SMOKE_RENDER_FAULT=1, so the packaged smoke can make a page fail. */
  smokeRenderFault?: boolean;
  // Card studio
  createCardProject(input: NewCardProject): Promise<{ card: CardProjectView; reused: boolean }>;
  defaultCardFolder(name: string): Promise<string>;
  pickCardFolder(): Promise<string | null>;
  removeCardProject(projectId: string): Promise<void>;
  refreshCardProject(projectId: string): Promise<CardProjectView>;
  openCardFolder(projectId: string, relativePath?: string): Promise<void>;
  startCardConversation(input: StartCardConversation): Promise<Task>;
  markDispatchDone(projectId: string, dispatchId: string): Promise<void>;
  saveCardSettings(projectId: string, changes: CardSettings): Promise<void>;
  cardPromptOverrides(): Promise<PromptOverrideItem[]>;
  readCardPromptOverride(id: string): Promise<PromptOverrideDetail>;
  saveCardPromptOverride(id: string, text: string): Promise<PromptOverrideDetail>;
  restoreCardPromptOverride(id: string): Promise<PromptOverrideDetail>;
  setCardConversationWeb(taskId: string, enabled: boolean): Promise<void>;
  /** Asks the section AI for a handoff summary; the summary then opens one new conversation in the same section. */
  requestCardHandoff(taskId: string): Promise<void>;
  consumeCardHandoff(taskId: string): Promise<void>;
  /** 主题包 and 桌宠 packs: what is installed, and what was refused with the reason. */
  appearance(): Promise<AppearanceSnapshot>;
  themeBackground(themeId: string): Promise<string>;
  petSprite(petId: string): Promise<{ dataUrl: string; layout: SpriteLayout }>;
  petNotice(petId: string): Promise<string>;
  /** Picks a pet pack ZIP or folder and installs it; null when the picker is cancelled. */
  installPet(from: 'zip' | 'folder'): Promise<{ id: string; displayName: string; version: 1 | 2; replaced: boolean } | null>;
  openAppearanceFolder(kind: 'themes' | 'pets'): Promise<void>;
  /** 撤回: stops the turn, takes the message out and returns its text for the composer. */
  withdrawCardMessage(taskId: string, messageId: string): Promise<{ text: string; turnId: string }>;
  /** 一键制作 (one board) or 全部开做 (all boards): sends the card's unsent dispatches in order. */
  startCardRun(projectId: string, scope: CardRunScope, settings: CardRunSettings): Promise<CardRun>;
  pauseCardRun(projectId: string): Promise<void>;
  resumeCardRun(projectId: string): Promise<void>;
  stopCardRun(projectId: string): Promise<void>;
  dismissCardRun(projectId: string): Promise<void>;
  /** 提改动 (§5.4): a draft 改动单 and the change AI's planning conversation, which lists the 影响清单. */
  startCardChange(projectId: string, input: NewCardChange): Promise<{ change: CardChange; task: Task }>;
  removeCardChangeItem(projectId: string, changeId: string, itemId: string): Promise<void>;
  dropCardChange(projectId: string, changeId: string): Promise<void>;
  /** 照单开做: the 影响清单 becomes 改动派单 that one-click making runs in dependency order. */
  confirmCardChange(projectId: string, changeId: string, settings: CardRunSettings): Promise<void>;
  /** 继续跑: the change's paused run goes on, or a new one takes the 改动派单 not yet done. */
  resumeCardChange(projectId: string, changeId: string, settings?: CardRunSettings): Promise<void>;
  readCardPrompt(projectId: string, sectionId: string, mode?: PlanMode): Promise<string>;
  pickCardSources(projectId: string): Promise<SourceImportReport | null>;
  importCardSources(projectId: string, paths: string[]): Promise<SourceImportReport>;
  resplitCardSource(projectId: string, name: string, mode: 'auto' | 'fixed'): Promise<SourceRecord>;
  readCardSources(projectId: string): Promise<SourceRecord[]>;
  pickCardImportFile(): Promise<CardImportPreview | null>;
  createCardProjectFromFile(input: NewCardProject & { file: string }): Promise<{ card: CardProjectView; reused: boolean; report: CardImportReport }>;
  importCardLorebook(projectId: string, replace?: boolean): Promise<CardImportReport | null>;
  newCardComponent(projectId: string, input: NewCardComponent): Promise<CardComponentResult>;
  readCardComponents(projectId: string): Promise<CardComponentSummary[]>;
  /** 整理未分类: moves world book components into a section's folder (uid, order and body stay); returns their new parameter paths. */
  moveCardLore(projectId: string, paramsPaths: string[], section: string): Promise<string[]>;
  /** AI 归类建议: one model call over up to 200 unclassified entries (these uids, else the first); suggestions only, nothing moves. */
  suggestCardLoreSections(projectId: string, uids?: number[]): Promise<CardLoreSuggestion[]>;
  readCardVariableTable(projectId: string): Promise<CardVariableTableView>;
  readCardPieces(projectId: string): Promise<CardPieceSummary[]>;
  runCardChecks(projectId: string): Promise<CardCheckReport>;
  exportCardProject(projectId: string, kind: 'card' | 'lorebook'): Promise<CardExportResult>;
  exportCardPng(projectId: string, coverPng: string): Promise<CardExportResult>;
  exportAllCardPieces(projectId: string): Promise<{ folder: string; files: string[] }>;
  readCardMeta(projectId: string): Promise<CardMeta>;
  saveCardMeta(projectId: string, meta: CardMeta): Promise<CardMeta>;
  previewCard(projectId: string, kind: CardPreviewKind): Promise<CardPreview>;
  exportCardPiece(projectId: string, kind: 'regex' | 'script', name: string): Promise<CardExportResult>;
  importCardPiece(projectId: string): Promise<CardPieceImport | null>;
  pickCardCover(): Promise<CoverSource | null>;
  saveCardCover(projectId: string, dataUrl: string): Promise<CardProjectView>;
  clearCardCover(projectId: string): Promise<CardProjectView>;
  readCardCover(projectId: string): Promise<string | null>;
  /** The built-in browser (§6.4); the pages live in the window, beside the renderer. */
  browserOpen(url: string): Promise<string | null>;
  browserClose(tabId: string): Promise<void>;
  browserSelect(tabId: string): Promise<void>;
  browserBounds(rect: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  browserDecide(answer: 'once' | 'always' | 'deny'): Promise<void>;
  browserTakeOver(tabId: string, taken: boolean): Promise<void>;
}
declare global { interface Window { cardwright: Bridge } }

export interface WorkerInit {
  type: 'init'; taskId: string; cwd: string; agentDir: string; sessionDir: string;
  sessionFile?: string; gateway: Gateway; apiKey: string; thinking: ThinkingLevel;
  permission: PermissionMode; instructions: string; skillPaths: string[];
  canDelegate: boolean;
  search?: SearchConfig & { apiKey?: string };
  projectId?: string; dataDir?: string; ecosystem?: EcosystemConfig;
  mcpServers?: Array<McpServerConfig & { env?: Record<string, string>; headers?: Record<string, string> }>;
  role?: string; roleDefinition?: AgentRole; planMode?: boolean; todos?: TodoItem[];
  skillFiles?: SkillInfo[]; sessionLeafId?: string | null; branchBeforeEntryId?: string;
  sandbox?: { enabled: boolean; helperPath?: string }; attachmentRoot?: string;
  fileCheckpoints?: boolean;
  squadSize?: number;
  networkOrigins?: string[];
  /** A squad member sharing its lead's folder with other writing members. */
  sharedWorkspace?: boolean;
  /** Card studio section conversations: the assembled section prompt and read-only built-in resources. */
  card?: { prompt: string; readRoots: string[] };
  /** True when the user has PreToolUse or PostToolUse hooks; the worker then asks the app about each tool call. */
  hooks?: boolean;
  /** Workbench tasks get the built-in browser; card studio conversations do not. */
  browser?: boolean;
}
export type ToWorker = WorkerInit | { type: 'prompt'; text: string; behavior?: 'steer' | 'followUp'; messageId?: string; attachments?: Array<AttachmentInfo & { storedPath: string }> }
  | { type: 'cancel' } | { type: 'permission'; permission: PermissionMode }
  | { type: 'search'; search: SearchConfig & { apiKey?: string } }
  | { type: 'plan'; enabled: boolean } | { type: 'command'; command: string }
  | { type: 'hooks'; enabled: boolean }
  | { type: 'response'; id: string; result?: unknown; error?: string };
export type FromWorker = { type: 'ready'; sessionFile?: string; sessionLeafId?: string | null }
  | { type: 'event'; event: Record<string, unknown> }
  | { type: 'request'; id: string; method: 'approve' | 'checkpoint' | 'network' | 'delegate' | 'team' | 'agents' | 'wait' | 'steer_agent' | 'interaction' | 'card' | 'hook' | 'browser'; args: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done'; sessionFile?: string; sessionLeafId?: string | null; userEntries?: Array<{ messageId: string; entryId: string }> };
