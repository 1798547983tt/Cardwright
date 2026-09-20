import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Harness } from './harness.ts';
import type { Project, Task } from '../shared/types.ts';
import { createCardFolder, readCardFile, writeCardFile, type CardProjectFile } from '../core/card-studio/card-project.ts';
import { importSources, readSourceManifest, resplitSource, type SourceImportReport, type SourceRecord } from '../core/card-studio/sources.ts';
import { buildSectionPrompt, buildSquadMemberPrompt } from '../core/card-studio/prompts.ts';
import { PromptOverrides } from '../core/card-studio/prompt-overrides.ts';
import { CardRunner } from './card-runner.ts';
import { buildCardFromProject, buildLorebookFromProject, buildPiece, createComponent, importCard, importLorebook, importPiece, pieceFileName, readProject, type FileComponent, type PieceImport, type PieceKind, type ProjectComponents } from '../core/card-studio/components.ts';
import { runChecks } from '../core/card-studio/checks.ts';
import { searchSources } from '../core/card-studio/source-search.ts';
import { bookName, diffFingerprints, exportReport, fingerprintProject, piecesFolderName, readCardMeta, writeCardMeta, type PieceFingerprint } from '../core/card-studio/export-report.ts';
import { isCardJson, isLorebookJson, joinComponent } from '../shared/card-studio/card-file.ts';
import { sampleOutputFrom } from '../core/card-studio/regex.ts';
import { renderReply, updateBlocks, type PreviewRegex, type PreviewSegment } from '../shared/card-studio/preview.ts';
import { readCardFromPng, stripCardFromPng, writeCheckedCardPng } from '../core/card-studio/png.ts';
import { coverDataUrl, decodeCardImage, decodeCover } from '../core/card-studio/cover.ts';
import { SECTION_IDS } from '../shared/card-studio/boards.ts';
import { dispatchKey, messageStartsDispatch, parseDispatches } from '../shared/card-studio/dispatch.ts';
import { parsePeople } from '../shared/card-studio/design-book.ts';
import { KICKOFF, handoffRequestText, isHandoffRequest } from '../shared/card-studio/markers.ts';
import { formatHandoff, handoffFromReply } from '../shared/card-studio/handoff.ts';
import type { CardCheckReport, CardComponentResult, CardComponentSummary, CardExportResult, CardImportPreview, CardImportReport, CardMeta, CardPieceSummary, CardPreview, CardPreviewState, CardProjectView, CardStudioSnapshot, CoverSource, NewCardComponent, NewCardProject, PlanMode, StartCardConversation } from '../shared/card-studio/types.ts';

export type StartConversationInput = StartCardConversation;
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const stamp = () => new Date().toISOString();

/** A name that is safe as a file name on Windows: reserved characters become _, control characters go. */
function safeFileName(name: string): string {
  return [...name.replace(/[\\/:*?"<>|]/g, '_')].filter(char => char.charCodeAt(0) >= 32).join('').trim().replace(/[. ]+$/, '') || '未命名';
}

/** The version and date every export file carries. */
function exportStamp(components: ProjectComponents): { version: string; date: string } {
  const envelope = components.envelope as Record<string, unknown>;
  const data = (envelope.data && typeof envelope.data === 'object' ? envelope.data : {}) as Record<string, unknown>;
  const now = new Date();
  return {
    version: String(data.character_version ?? '').trim() || 'v1',
    date: String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0'),
  };
}

/** Card projects: registration in the harness, metadata in each folder's 卡项目.json, conversations as harness tasks. */
export class CardStudioService {
  private views = new Map<string, CardProjectView>();
  private queues = new Map<string, Promise<unknown>>();
  /** Developer-mode edits of the built-in prompts; they apply to conversations started after the edit. */
  readonly prompts: PromptOverrides;
  /** 一键制作 and 全部开做. */
  readonly runner: CardRunner;

  constructor(private readonly harness: Harness, readonly resourceRoot: string, private readonly options: { documentsDir: string; sandboxEntry?: string; pickCover?: () => Promise<CoverSource | null>; publishPreview?: (owner: string, segments: PreviewSegment[]) => string[] }) {
    this.prompts = new PromptOverrides(harness.dataDir, resourceRoot);
    this.runner = new CardRunner(harness, this);
  }

  snapshot(): CardStudioSnapshot {
    const { projects, tasks } = this.harness.store.state;
    return {
      resourceRoot: this.resourceRoot,
      cards: projects.filter(project => project.kind === 'card').map(project => {
        const view = this.views.get(project.id) ?? this.placeholder(project);
        const latest = tasks.filter(task => task.projectId === project.id).reduce((value, task) => task.updatedAt > value ? task.updatedAt : value, view.updatedAt);
        return { ...view, name: view.error ? project.name : view.name, lastEditedAt: latest, ...(project.cardRun ? { run: project.cardRun } : {}) };
      }),
    };
  }

  defaultFolder(name: string): string {
    const safe = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '未命名角色卡';
    return join(this.options.documentsDir, 'Cardwright 角色卡', safe);
  }

  async create(input: NewCardProject): Promise<{ card: CardProjectView; reused: boolean }> {
    const folder = resolve(String(input.folder || ''));
    const canonical = await realpath(folder).catch(() => folder);
    const existing = this.harness.store.state.projects.find(project => project.path.toLowerCase() === canonical.toLowerCase());
    if (existing && existing.kind !== 'card') throw new Error('这个文件夹已经作为普通项目添加过，请换一个文件夹。');
    const { file, reused } = await createCardFolder({ folder, name: input.name, kind: input.kind, source: input.source });
    const project = existing ?? await this.harness.registerCardProject(folder, file.name);
    return { card: await this.reload(project.id), reused };
  }

  async remove(projectId: string): Promise<void> {
    const status = this.cardProject(projectId).cardRun?.status;
    // Between two rounds a run has no conversation running, yet it is about to send the next message.
    if (status === 'running' || status === 'pausing') throw new Error('这张卡正在一键制作，请先停止。');
    this.harness.removeCardProject(projectId);
    this.views.delete(projectId);
    this.harness.publishCardStudio();
  }

  async refreshAll(): Promise<void> {
    for (const project of this.harness.store.state.projects.filter(item => item.kind === 'card')) await this.reload(project.id);
  }

  async reload(projectId: string): Promise<CardProjectView> {
    const view = await this.load(this.cardProject(projectId));
    if (this.harness.store.state.projects.some(project => project.id === projectId)) this.views.set(projectId, view);
    this.harness.publishCardStudio();
    return view;
  }

  async startConversation(input: StartConversationInput): Promise<Task> {
    const project = this.cardProject(input.projectId);
    if (!SECTION_IDS.includes(input.sectionId)) throw new Error('未知的分区。');
    if (input.sectionId === 'source') throw new Error('资料板块没有对话，请在资料页导入资料。');
    if (input.kickoff && input.sectionId !== 'plan') throw new Error('只有规划可以自动开场。');
    const view = await this.reload(project.id);
    if (view.error) throw new Error(view.error);
    if (!view.design.exists && !['plan', 'build'].includes(input.sectionId)) throw new Error('还没有设计书。除资料和拼装外，其他分区要等规划写出设计书后才能开工。');
    const dispatch = input.dispatchId ? view.dispatches.find(item => item.id === input.dispatchId) : undefined;
    if (input.dispatchId && !dispatch) throw new Error('找不到这条派单。');
    if (dispatch && dispatch.sectionId !== input.sectionId) throw new Error('这条派单不属于这个分区。');
    const mode = input.sectionId === 'plan' ? input.mode ?? (view.origin === 'import' ? 'refine' : 'scratch') : undefined;
    const title = (input.title?.trim() || (input.kickoff ? mode === 'refine' ? '完善优化卡' : '从零开始制卡' : dispatch?.title) || '新对话').slice(0, 160);
    // Ultra belongs to planning, where it brings the reading squad; elsewhere it means the highest effort.
    const thinking = input.thinking === 'ultra' && input.sectionId !== 'plan' ? 'max' : input.thinking;
    const task = await this.harness.createTask({
      projectId: project.id, title, prompt: input.kickoff ? await this.prompts.effective(`kickoff/${mode ?? 'scratch'}`) : input.prompt, permission: input.permission ?? project.cardSettings?.permission ?? 'edit', isolated: false,
      ...(thinking ? { thinking } : {}), ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      card: { sectionId: input.sectionId, ...(dispatch ? { dispatchId: dispatch.id } : {}), ...(mode ? { mode } : {}), web: input.web === true, ...(input.kickoff ? { kickoff: true } : {}) },
    });
    if (input.kickoff && (input.thinking || input.gatewayId || input.modelId)) {
      this.harness.saveCardSettings(project.id, { kickoff: { ...(input.thinking ? { thinking: input.thinking } : {}), ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}) } });
    }
    return task;
  }

  setWeb(taskId: string, enabled: boolean): void { this.harness.setCardWeb(taskId, enabled); }

  /** §5.2: the app asks the section AI for a handoff summary in the same conversation, where its context is still cached. */
  async requestHandoff(taskId: string, options: { auto?: boolean } = {}): Promise<void> {
    const conversation = this.cardConversation(taskId);
    if (conversation.card!.handoff?.status === 'requested') throw new Error('这个对话已经在写交接摘要，请稍候。');
    if (ACTIVE.has(conversation.status) || conversation.workerActive) throw new Error('这个对话正在运行，等这一轮结束再换对话。');
    const auto = options.auto ? { auto: true } : {};
    this.harness.setCardHandoff(taskId, { status: 'requested', at: stamp(), ...auto });
    try { await this.harness.prompt(taskId, handoffRequestText()); }
    catch (error) { this.harness.setCardHandoff(taskId, undefined); throw error; }
    const request = this.cardConversation(taskId).messages.findLast(message => message.role === 'user' && isHandoffRequest(message.text));
    if (this.cardConversation(taskId).card!.handoff?.status === 'requested') this.harness.setCardHandoff(taskId, { status: 'requested', at: stamp(), requestId: request?.id, ...auto });
  }

  /** A new conversation took the summary; the old one no longer offers it. */
  async consumeHandoff(taskId: string): Promise<void> {
    const handoff = this.cardConversation(taskId).card!.handoff;
    if (handoff?.status !== 'ready') throw new Error('这个对话没有待打开的交接摘要。');
    this.harness.setCardHandoff(taskId, { ...handoff, status: 'consumed', at: stamp() });
  }

  async markDispatchDone(projectId: string, dispatchId: string): Promise<void> {
    await this.mutate(projectId, file => {
      const dispatch = file.dispatches.find(item => item.id === dispatchId);
      if (!dispatch) throw new Error('找不到这条派单。');
      if (dispatch.status === 'done') return false;
      dispatch.status = 'done'; dispatch.updatedAt = stamp();
      return true;
    });
  }

  /** Called before a message is sent in a card conversation: sending a dispatch starts it. */
  async beforePrompt(task: Task, text: string): Promise<void> {
    const card = task.card;
    if (!card) return;
    try {
      await this.mutate(task.projectId, file => {
        const waiting = file.dispatches.filter(item => item.sectionId === card.sectionId && item.status === 'todo');
        // A conversation that finished its dispatch can take the next one (one-click making sends them into the same conversation).
        const target = waiting.find(item => item.id === card.dispatchId) ?? waiting.find(item => messageStartsDispatch(text, item));
        if (!target) return false;
        target.status = 'active'; target.updatedAt = stamp(); card.dispatchId = target.id;
        return true;
      });
    } catch { /* A broken registration file must not block the conversation; the library shows the error. */ }
  }

  /** Called when a card conversation run ends: planning replies register their dispatches. */
  async afterConversation(task: Task): Promise<void> {
    const card = task.card;
    if (!card) return;
    if (card.handoff?.status === 'requested') {
      const requestId = card.handoff.requestId ?? task.messages.findLast(message => message.role === 'user' && isHandoffRequest(message.text))?.id;
      const handoff = task.status === 'completed' ? handoffFromReply(task.messages, requestId) : null;
      const auto = card.handoff.auto ? { auto: true } : {};
      this.harness.setCardHandoff(task.id, handoff ? { status: 'ready', at: stamp(), requestId, summary: formatHandoff(handoff), ...auto } : { status: 'failed', at: stamp(), requestId, ...auto });
    }
    try {
      const reply = task.status === 'completed' && card.sectionId === 'plan' ? task.messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '' : '';
      const parsed = parseDispatches(reply).flatMap(item => 'error' in item ? [] : [item]);
      if (parsed.length) await this.mutate(task.projectId, file => {
        const keys = new Set(file.dispatches.map(dispatchKey)); const at = stamp(); let changed = false;
        for (const item of parsed) {
          if (keys.has(dispatchKey(item))) continue;
          keys.add(dispatchKey(item)); changed = true;
          file.dispatches.push({ id: randomUUID(), target: item.target, sectionId: item.sectionId, title: item.title, requires: item.requires, body: item.body, status: 'todo', createdAt: at, updatedAt: at, sourceTaskId: task.id });
        }
        return changed;
      });
      else await this.reload(task.projectId);
    } catch { /* The next reload reports an unreadable registration. */ }
    this.runner.settled(task);
  }

  async workerContext(task: Task): Promise<{ prompt: string; readRoots: string[] }> {
    const view = await this.reload(task.projectId);
    if (view.error) throw new Error(view.error);
    if (task.card!.member) return { prompt: buildSquadMemberPrompt({ cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path }), readRoots: [this.resourceRoot] };
    const prompt = await buildSectionPrompt(this.resourceRoot, { sectionId: task.card!.sectionId, mode: task.card!.mode, cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path }, { read: id => this.prompts.effective(id) });
    return { prompt, readRoots: [this.resourceRoot] };
  }

  async readPrompt(projectId: string, sectionId: string, mode?: PlanMode): Promise<string> {
    if (!SECTION_IDS.includes(sectionId)) throw new Error('未知的分区。');
    const view = await this.reload(projectId);
    return buildSectionPrompt(this.resourceRoot, { sectionId, mode: sectionId === 'plan' ? mode ?? (view.origin === 'import' ? 'refine' : 'scratch') : undefined, cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path }, { read: id => this.prompts.effective(id) });
  }

  listPromptOverrides() { return this.prompts.list(); }
  readPromptOverride(id: string) { return this.prompts.read(id); }
  /** §5.6: saving and restoring need developer mode; reading does not, so the list can show what is modified. */
  async savePromptOverride(id: string, text: string) { this.requireDeveloperMode(); return this.prompts.save(id, text); }
  async restorePromptOverride(id: string) { this.requireDeveloperMode(); return this.prompts.restore(id); }
  private requireDeveloperMode(): void {
    if (!this.harness.store.state.preferences.developerMode) throw new Error('请先在「工作室设置 → 制卡」打开开发者模式。');
  }

  async importSources(projectId: string, paths: string[]): Promise<SourceImportReport> {
    if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(path => typeof path !== 'string')) throw new Error('一次最多导入 32 个文件。');
    const project = this.cardProject(projectId);
    const report = await this.exclusive(projectId, () => importSources(project.path, paths));
    await this.reload(projectId);
    return report;
  }

  async resplitSource(projectId: string, name: string, mode: 'auto' | 'fixed'): Promise<SourceRecord> {
    const project = this.cardProject(projectId);
    const record = await this.exclusive(projectId, () => resplitSource(project.path, name, mode === 'fixed' ? 'fixed' : 'auto'));
    await this.reload(projectId);
    return record;
  }

  readSources(projectId: string): Promise<SourceRecord[]> { return readSourceManifest(this.cardProject(projectId).path); }

  /** What a file turns out to be, so the import dialog can show it before anything is written. */
  async importPreview(file: string): Promise<CardImportPreview> {
    const source = await this.readImportSource(file);
    const parsed = source.value;
    const format = source.image ? 'png' as const : 'json' as const;
    if (source.image && !isCardJson(parsed)) throw new Error('这张 PNG 里的数据不是角色卡。');
    if (isCardJson(parsed)) {
      const card = parsed as Record<string, unknown>;
      const data = (card.data && typeof card.data === 'object' ? card.data : card) as Record<string, unknown>;
      const book = (data.character_book ?? {}) as Record<string, unknown>;
      const extensions = (data.extensions ?? {}) as Record<string, unknown>;
      const helper = (extensions.tavern_helper ?? {}) as Record<string, unknown>;
      const alternates = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : 0;
      return {
        kind: 'card', format, file, name: String(data.name ?? card.name ?? '角色卡'),
        entries: Array.isArray(book.entries) ? book.entries.length : Object.keys((book.entries ?? {}) as object).length,
        regex: Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts.length : 0,
        scripts: Array.isArray(helper.scripts) ? helper.scripts.length : 0,
        greetings: 1 + alternates,
        ...(source.mismatch ? { mismatch: true } : {}),
      };
    }
    if (isLorebookJson(parsed)) {
      const book = parsed as Record<string, unknown>;
      const entries = book.entries;
      return { kind: 'lorebook', format, file, name: String(book.name ?? '世界书'), entries: Array.isArray(entries) ? entries.length : Object.keys((entries ?? {}) as object).length, regex: 0, scripts: 0, greetings: 0 };
    }
    throw new Error('这个文件既不是角色卡，也不是独立世界书。支持 V2/V3 角色卡 JSON 或 PNG，以及世界书 JSON。');
  }

  /** Creates a card project from a character card or a standalone world book file. */
  async createFromFile(input: NewCardProject & { file: string }): Promise<{ card: CardProjectView; reused: boolean; report: CardImportReport }> {
    const preview = await this.importPreview(input.file);
    const source = await this.readImportSource(input.file);
    const parsed = source.value as Record<string, unknown>;
    const { card, reused } = await this.create(input);
    const project = this.cardProject(card.projectId);
    const report = await this.exclusive(card.projectId, async () => {
      const result = preview.kind === 'card'
        ? await importCard(project.path, parsed)
        : await importLorebook(project.path, parsed, { name: preview.name, replace: true });
      const file = await readCardFile(project.path);
      if (source.image) {
        // The card art stays with the card: it becomes the uploaded cover, without the payloads inside it.
        await mkdir(join(project.path, '封面'), { recursive: true });
        await writeFile(join(project.path, '封面', '封面.png'), source.image);
        file.cover = '封面/封面.png';
      }
      file.origin = 'import';
      file.updatedAt = stamp();
      await writeCardFile(project.path, file);
      return result;
    });
    return { card: await this.reload(card.projectId), reused, report };
  }

  /** Imports a standalone world book into a card project that already exists. */
  async importLorebookFile(projectId: string, file: string, options: { replace?: boolean } = {}): Promise<CardImportReport> {
    const project = this.cardProject(projectId);
    const preview = await this.importPreview(file);
    if (preview.kind !== 'lorebook') throw new Error('这个文件不是独立世界书。导入整张角色卡请在卡库里新建卡项目。');
    const parsed = (await this.readImportSource(file)).value as Record<string, unknown>;
    const report = await this.exclusive(projectId, () => importLorebook(project.path, parsed, { name: preview.name, replace: options.replace === true }));
    await this.reload(projectId);
    return report;
  }

  /** The only way a uid is handed out: the AI asks, the application allocates. */
  async newComponent(projectId: string, input: NewCardComponent): Promise<CardComponentResult> {
    const project = this.cardProject(projectId);
    const result = await this.exclusive(projectId, () => createComponent(project.path, input));
    await this.reload(projectId);
    return result;
  }

  /** The components of one card project, for the section pages. */
  async listComponents(projectId: string): Promise<CardComponentSummary[]> {
    const components = await readProject(this.cardProject(projectId).path);
    return components.lore.map(item => ({
      uid: item.uid, section: item.section, name: String(item.params.comment ?? ''),
      keys: Array.isArray(item.params.key) ? item.params.key.length : 0, chars: item.content.length,
      constant: item.params.constant === true, disabled: item.params.disable === true, order: Number(item.params.order) || 0,
      bodyPath: item.bodyPath, paramsPath: item.paramsPath,
    }));
  }

  /** The regex and script pieces of one card project, for the section pages and single-piece exports. */
  async listPieces(projectId: string): Promise<CardPieceSummary[]> {
    const components = await readProject(this.cardProject(projectId).path);
    const summarize = (kind: PieceKind, list: readonly FileComponent[]): CardPieceSummary[] => list.map(item => ({
      kind, name: item.name,
      title: String(item.params[kind === 'regex' ? 'scriptName' : 'name'] ?? item.name) || item.name,
      chars: item.body.length,
      disabled: kind === 'regex' ? item.params.disabled === true : item.params.enabled === false,
      bodyPath: item.bodyPath,
    }));
    return [...summarize('regex', components.regex), ...summarize('script', components.scripts)];
  }

  runChecks(projectId: string): Promise<CardCheckReport> {
    // The card's own Zod code runs in the bundled sandbox process, never in this one.
    return runChecks(this.cardProject(projectId).path, this.options.sandboxEntry ? { sandbox: { entry: this.options.sandboxEntry } } : {});
  }

  exportCard(projectId: string): Promise<CardExportResult> { return this.writeExport(projectId, 'card'); }

  /** The renderer draws the cover (uploaded image or text cover) and hands the PNG over for the payloads. */
  exportCardPng(projectId: string, coverPng: string): Promise<CardExportResult> { return this.writeExport(projectId, 'png', coverPng); }

  /** Picks an image for the cover and returns a bounded preview; the renderer never reads the file itself. */
  async pickCover(): Promise<CoverSource | null> {
    return (await this.options.pickCover?.()) ?? null;
  }

  async saveCover(projectId: string, dataUrl: string): Promise<CardProjectView> {
    const project = this.cardProject(projectId);
    const png = decodeCover(dataUrl);
    await this.exclusive(projectId, async () => {
      await mkdir(join(project.path, '封面'), { recursive: true });
      await writeFile(join(project.path, '封面', '封面.png'), png);
      const file = await readCardFile(project.path);
      file.cover = '封面/封面.png';
      file.updatedAt = stamp();
      await writeCardFile(project.path, file);
    });
    return this.reload(projectId);
  }

  async clearCover(projectId: string): Promise<CardProjectView> {
    const project = this.cardProject(projectId);
    await this.exclusive(projectId, async () => {
      const file = await readCardFile(project.path);
      if (file.cover) await rm(join(project.path, ...file.cover.split('/')), { force: true });
      delete file.cover;
      file.updatedAt = stamp();
      await writeCardFile(project.path, file);
    });
    return this.reload(projectId);
  }

  /** The stored cover as a data URL, for the crop dialog and for drawing the export image. */
  async readCover(projectId: string): Promise<string | null> {
    const project = this.cardProject(projectId);
    const file = await readCardFile(project.path).catch(() => null);
    if (!file?.cover) return null;
    const bytes = await readFile(join(project.path, ...file.cover.split('/'))).catch(() => null);
    return bytes ? coverDataUrl(bytes) : null;
  }

  exportLorebook(projectId: string): Promise<CardExportResult> { return this.writeExport(projectId, 'lorebook'); }

  /** Exports one regex or script the way SillyTavern and 酒馆助手 take single pieces. */
  exportPiece(projectId: string, kind: PieceKind, name: string): Promise<CardExportResult> {
    const project = this.cardProject(projectId);
    return this.exclusive(projectId, async () => {
      const components = await readProject(project.path);
      const registration = await readCardFile(project.path);
      const { version, date } = exportStamp(components);
      const body = Buffer.from(JSON.stringify(buildPiece(components, kind, name), null, 2) + '\n', 'utf8');
      const target = pieceFileName(kind, name, version, date);
      const file = await this.writeUnique(project.path, target.slice(0, -'.json'.length), '.json', body);
      return this.recordExport(projectId, registration, { kind, file, bytes: body.length, entries: 1, at: stamp() });
    });
  }

  /** Imports one exported regex or script back into the project; a piece with the same id replaces it in place. */
  async importPieceFile(projectId: string, file: string): Promise<PieceImport> {
    const project = this.cardProject(projectId);
    const raw = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error('这个文件不是合法的 JSON。'); }
    return this.exclusive(projectId, async () => {
      const report = await importPiece(project.path, value);
      const registration = await readCardFile(project.path);
      registration.updatedAt = stamp();
      await writeCardFile(project.path, registration);
      await this.reload(projectId);
      return report;
    });
  }

  /** The tools a card conversation can use. Everything else about the card project stays read-only to the AI. */
  async toolRequest(task: Task, args: Record<string, unknown>): Promise<unknown> {
    if (!task.card) throw new Error('这不是制卡对话，不能使用制卡工具。');
    const action = String(args.action ?? '');
    if (action === 'new_component') {
      const board = args.board === 'regex' || args.board === 'script' || args.board === 'greeting' ? args.board : 'lore';
      return this.newComponent(task.projectId, {
        board, name: String(args.name ?? ''),
        ...(args.section ? { section: String(args.section) } : board === 'lore' ? { section: task.card.sectionId } : {}),
        ...(Array.isArray(args.keys) ? { keys: args.keys.map(String) } : {}),
        ...(args.order !== undefined ? { order: Number(args.order) } : {}),
        ...(args.constant !== undefined ? { constant: args.constant === true } : {}),
        ...(args.position !== undefined ? { position: Number(args.position) } : {}),
        ...(args.depth !== undefined ? { depth: Number(args.depth) } : {}),
        ...(args.kind ? { kind: args.kind as 'first' | 'alternate' | 'group' } : {}),
      });
    }
    if (action === 'check') return this.runChecks(task.projectId);
    if (action === 'search_sources') return searchSources(this.cardProject(task.projectId).path, { query: String(args.query ?? ''), regex: args.regex === true, ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}), ...(args.source ? { source: String(args.source) } : {}) });
    throw new Error('未知的制卡工具动作：' + (action || '(空)'));
  }

  /** A JSON file, or a PNG card: its payload (ccv3 over chara) plus the image without the payloads. */
  private async readImportSource(file: string): Promise<{ value: unknown; image?: Buffer; mismatch: boolean }> {
    if (typeof file !== 'string' || !file.trim()) throw new Error('请选择要导入的文件。');
    const bytes = await readFile(file).catch(() => { throw new Error('读不到这个文件，请确认它还在原处。'); });
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const card = readCardFromPng(bytes);
      return { value: card.card, image: stripCardFromPng(bytes), mismatch: card.mismatch };
    }
    try { return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), mismatch: false }; }
    catch { throw new Error('这个文件不是有效的 JSON，也不是 PNG 角色卡。'); }
  }

  private writeExport(projectId: string, kind: 'card' | 'lorebook' | 'png', coverPng?: string): Promise<CardExportResult> {
    const project = this.cardProject(projectId);
    return this.exclusive(projectId, async () => {
      const components = await readProject(project.path);
      const registration = await readCardFile(project.path);
      const value = kind === 'lorebook' ? buildLorebookFromProject(components) : buildCardFromProject(components);
      const { version, date } = exportStamp(components);
      const extension = kind === 'png' ? '.png' : '.json';
      const body = kind === 'png' ? writeCheckedCardPng(decodeCardImage(coverPng), value) : Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      // SillyTavern names an imported world book after its file, so the book piece carries the book's own name and
      // replaces the one already in its folder; the version and the date go on the folder instead.
      const file = kind === 'lorebook'
        ? await this.writeOver(project.path, `导出/${piecesFolderName(version, date)}/${safeFileName(bookName(components))}.json`, body)
        : await this.writeUnique(project.path, `${safeFileName(registration.name)}-${version}-${date}`, extension, body);
      const result: CardExportResult = { kind, file, bytes: body.length, entries: components.lore.length, at: stamp() };
      await this.recordExport(projectId, registration, result);
      if (kind === 'lorebook') return result;
      return { ...result, report: await this.writeReport(project.path, components, file, version, date) };
    });
  }

  /** Compares every piece with the last whole-card export and writes the report next to the export. */
  private async writeReport(root: string, components: ProjectComponents, file: string, version: string, date: string): Promise<{ file: string; text: string }> {
    // Kept beside the other hidden studio files, so 导出/ only ever holds what the author exported.
    const store = join(root, '.cardwright-exported.json');
    const previous = await readFile(store, 'utf8').then(content => JSON.parse(content) as PieceFingerprint[], () => null);
    const current = fingerprintProject(components);
    const data = (components.envelope.data && typeof components.envelope.data === 'object' ? components.envelope.data : {}) as Record<string, unknown>;
    const diff = diffFingerprints(previous, current);
    // When pieces changed, the report tells how to replace them one by one; write them now, so it points at this export's pieces.
    const piecesChanged = !!diff && [...diff.added, ...diff.changed].some(item => item.kind === 'lore' || item.kind === 'regex' || item.kind === 'script');
    const piecesFolder = piecesChanged ? (await this.writePieces(root, components, version, date)).folder : null;
    const text = exportReport({ cardName: String(data.name ?? '') || '角色卡', file, bookName: bookName(components), diff, piecesFolder });
    const reportFile = await this.writeUnique(root, `导出报告-${version}-${date}`, '.md', Buffer.from(text, 'utf8'));
    await writeFile(store, JSON.stringify(current, null, 2) + '\n');
    return { file: reportFile, text };
  }

  /** Every single piece at once, in one folder per version and date: the world book, each regex, each script. */
  exportAllPieces(projectId: string): Promise<{ folder: string; files: string[] }> {
    const project = this.cardProject(projectId);
    return this.exclusive(projectId, async () => {
      const components = await readProject(project.path);
      const registration = await readCardFile(project.path);
      const { version, date } = exportStamp(components);
      const { folder, files, bytes } = await this.writePieces(project.path, components, version, date);
      await this.recordExport(projectId, registration, { kind: 'pieces', file: folder, bytes, entries: files.length, at: stamp() });
      return { folder, files };
    });
  }

  /** Writes every piece into 导出/单件-<version>-<date>/, replacing what is there: the pieces of one version and day are the latest ones. */
  private async writePieces(root: string, components: ProjectComponents, version: string, date: string): Promise<{ folder: string; files: string[]; bytes: number }> {
    const folder = `导出/${piecesFolderName(version, date)}`;
    const files: string[] = [];
    let bytes = 0;
    const put = async (name: string, value: unknown) => {
      const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      files.push(await this.writeOver(root, `${folder}/${safeFileName(name)}.json`, body));
      bytes += body.length;
    };
    if (components.lore.length) await put(bookName(components), buildLorebookFromProject(components));
    for (const item of components.regex) await put(`正则-${item.name}`, buildPiece(components, 'regex', item.name));
    for (const item of components.scripts) await put(`脚本-${item.name}`, buildPiece(components, 'script', item.name));
    return { folder, files, bytes };
  }

  /**
   * The local preview: the card's regex over the format sample, in SillyTavern's order, each part of the result handed to
   * the publisher as a document of its own. 正文美化 shows the whole sample reply; 变量更新 shows the update block,
   * finished and still streaming, from the sample or else from the 变量 entries.
   */
  async preview(projectId: string, kind: 'body' | 'update'): Promise<CardPreview> {
    const project = this.cardProject(projectId);
    const publish = this.options.publishPreview;
    if (!publish) throw new Error('这里不能显示预览。');
    const components = await readProject(project.path);
    const data = (components.envelope.data && typeof components.envelope.data === 'object' ? components.envelope.data : {}) as Record<string, unknown>;
    const macros = { char: String(data.name ?? '').trim() || '角色卡', user: '玩家' };
    const scripts = components.regex.map(item => joinComponent({ params: item.params, body: item.body }, 'replaceString') as PreviewRegex);
    const state = (index: number, label: string, text: string): CardPreviewState => {
      const render = renderReply(text, scripts, macros);
      const urls = publish(`${projectId}:${kind}:${index}`, render.segments);
      return { label, steps: render.steps, frames: render.segments.map((segment, at) => ({ kind: segment.kind, url: urls[at] })), external: render.external };
    };
    // A card may carry several format entries (Re0 has a full and a light one): take one with a sample, an enabled one first.
    const formats = components.lore.filter(entry => entry.section === 'lore-format');
    const sampled = formats.filter(entry => sampleOutputFrom(entry.content));
    const format = sampled.find(entry => !entry.params.disable) ?? sampled[0] ?? formats[0];
    const sample = format ? sampleOutputFrom(format.content) : null;
    if (kind === 'body') {
      if (!format || !sample) return { kind, source: null, states: [], notice: format ? '正文格式条目里还没有 ```示例输出 块。预览用它当作一条 AI 回复，先在世界书 · 正文格式里写一段。' : '还没有正文格式条目。预览用它的示例输出当作一条 AI 回复，先在世界书 · 正文格式里写出来。' };
      return { kind, source: { from: 'sample', path: format.bodyPath }, notice: null, states: [state(0, '整条回复', sample)] };
    }
    const inSample = sample ? updateBlocks(sample) : null;
    const lent = format && inSample ? { from: 'sample' as const, path: format.bodyPath, blocks: inSample }
      : components.lore.filter(entry => entry.section === 'lore-vars').map(entry => ({ from: 'variables' as const, path: entry.bodyPath, blocks: updateBlocks(entry.content) })).find(item => item.blocks);
    if (!lent?.blocks) return { kind, source: null, states: [], notice: '示例输出和世界书 · 变量里都没有 <UpdateVariable> 块。在世界书 · 变量里（例如变量输出格式条目）写一段完整的更新示例，预览才有东西可看。' };
    return { kind, source: { from: lent.from, path: lent.path }, notice: null, states: [state(0, '生成完成', lent.blocks.done), state(1, '生成中', lent.blocks.streaming)] };
  }

  readMeta(projectId: string): Promise<CardMeta> { return readCardMeta(this.cardProject(projectId).path); }

  /** §3.6 step 3: the name, author, version, notes and tags SillyTavern shows, confirmed before export. */
  async saveMeta(projectId: string, meta: CardMeta): Promise<CardMeta> {
    const project = this.cardProject(projectId);
    const saved = await this.exclusive(projectId, async () => {
      const result = await writeCardMeta(project.path, meta);
      const registration = await readCardFile(project.path);
      registration.updatedAt = stamp();
      await writeCardFile(project.path, registration);
      return result;
    });
    await this.reload(projectId);
    return saved;
  }

  /** Writes into 导出/ without ever overwriting an earlier export. */
  /** Writes one project-relative file, replacing it if it is there. */
  private async writeOver(root: string, file: string, body: Buffer): Promise<string> {
    const path = join(root, ...file.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return file;
  }

  private async writeUnique(root: string, base: string, extension: string, body: Buffer): Promise<string> {
    await mkdir(dirname(join(root, '导出', ...base.split('/'))), { recursive: true });
    let file = '导出/' + base + extension;
    for (let attempt = 2; attempt < 50; attempt++) {
      const exists = await readFile(join(root, ...file.split('/'))).then(() => true, () => false);
      if (!exists) break;
      file = '导出/' + base + '-' + attempt + extension;
    }
    await writeFile(join(root, ...file.split('/')), body);
    return file;
  }

  private async recordExport(projectId: string, registration: CardProjectFile, result: CardExportResult): Promise<CardExportResult> {
    const { report: _report, ...kept } = result;
    registration.exports = [...registration.exports, kept].slice(-50);
    registration.updatedAt = stamp();
    await writeCardFile(this.cardProject(projectId).path, registration);
    await this.reload(projectId);
    return result;
  }

  private cardConversation(taskId: string): Task {
    const task = this.harness.store.state.tasks.find(item => item.id === taskId);
    if (!task?.card) throw new Error('这不是制卡对话。');
    return task;
  }

  private cardProject(projectId: string): Project {
    const project = this.harness.store.state.projects.find(item => item.id === projectId);
    if (!project || project.kind !== 'card') throw new Error('找不到这个卡项目。');
    return project;
  }

  private placeholder(project: Project, error?: string): CardProjectView {
    return { projectId: project.id, path: project.path, cardId: '', name: project.name, kind: 'original', coverStyle: 'vermilion', stylePreset: null, origin: 'new', createdAt: project.createdAt, updatedAt: project.createdAt, lastEditedAt: project.createdAt, dispatches: [], design: { exists: false, people: null }, sources: 0, ...(error ? { error } : {}) };
  }

  private async load(project: Project): Promise<CardProjectView> {
    let file: CardProjectFile;
    try { file = await readCardFile(project.path); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return this.placeholder(project, missing ? '找不到卡项目文件夹或卡项目.json。文件夹可能被移动或删除了。' : error instanceof Error ? error.message : String(error));
    }
    const design = await readFile(join(project.path, '设计书.md'), 'utf8').catch(() => undefined);
    const sources = (await readSourceManifest(project.path).catch(() => [])).length;
    return {
      projectId: project.id, path: project.path, cardId: file.cardId, name: file.name, kind: file.kind, ...(file.source ? { source: file.source } : {}),
      coverStyle: file.coverStyle, ...(file.cover ? { cover: file.cover } : {}), stylePreset: file.stylePreset, origin: file.origin,
      createdAt: file.createdAt, updatedAt: file.updatedAt, lastEditedAt: file.updatedAt, dispatches: file.dispatches,
      design: { exists: design !== undefined, people: design === undefined ? null : parsePeople(design) }, sources,
    };
  }

  private exclusive<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(projectId, next);
    return next.finally(() => { if (this.queues.get(projectId) === next) this.queues.delete(projectId); });
  }

  private async mutate(projectId: string, change: (file: CardProjectFile) => boolean): Promise<void> {
    const project = this.cardProject(projectId);
    await this.exclusive(projectId, async () => {
      const file = await readCardFile(project.path);
      if (!change(file)) return;
      file.updatedAt = stamp();
      await writeCardFile(project.path, file);
    });
    await this.reload(projectId);
  }
}
