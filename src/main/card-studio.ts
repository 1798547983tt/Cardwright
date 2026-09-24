import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Harness } from './harness.ts';
import type { Project, Task } from '../shared/types.ts';
import { createCardFolder, readCardFile, writeCardFile, type CardProjectFile } from '../core/card-studio/card-project.ts';
import { importSources, readSourceManifest, resplitSource, type SourceImportReport, type SourceRecord } from '../core/card-studio/sources.ts';
import { buildSectionPrompt, buildSquadMemberPrompt } from '../core/card-studio/prompts.ts';
import { PromptOverrides } from '../core/card-studio/prompt-overrides.ts';
import { CardRunner } from './card-runner.ts';
import { LORE_FOLDERS, buildLorebookFromProject, createComponent, importCard, importLorebook, importPiece, moveLoreComponents, pieceFileName, readProject, type FileComponent, type PieceImport, type PieceKind, type ProjectComponents } from '../core/card-studio/components.ts';
import { LORE_SUGGESTION_LIMIT, LORE_TARGETS, loreSuggestionRequest, parseLoreSuggestions } from '../shared/card-studio/lore-suggest.ts';
import { oneShotCompletion } from './one-shot.ts';
import { assemblyCardName, buildCardFromProject, buildPiece, compileProject, type AssemblyContext } from '../core/card-studio/assembly.ts';
import { loadFrontendResources } from '../core/card-studio/frontend-resources.ts';
import { sampleVariables } from '../core/card-studio/variable-sample.ts';
import { tavernSimScript } from '../shared/card-studio/tavern-sim.ts';
import { frontendDocument } from '../shared/card-studio/frontend.ts';
import type { FrontendResources } from '../shared/card-studio/frontend-compile.ts';
import { runChecks } from '../core/card-studio/checks.ts';
import { searchSources } from '../core/card-studio/source-search.ts';
import { DERIVED_TABLE_FILE, VARIABLE_TABLE_FILE, hashText, readArtifactManifest, readVariableTableState, syncVariableArtifacts, writeDerivedTable } from '../core/card-studio/variable-artifacts.ts';
import { describeVariableRow } from '../shared/card-studio/variable-table.ts';
import { bookName, diffFingerprints, exportReport, fingerprintProject, piecesFolderName, readCardMeta, writeCardMeta, type PieceFingerprint } from '../core/card-studio/export-report.ts';
import { isCardJson, isLorebookJson, joinComponent } from '../shared/card-studio/card-file.ts';
import { sampleOutputFrom } from '../core/card-studio/regex.ts';
import { renderReply, updateBlocks, type PreviewRegex, type PreviewSegment } from '../shared/card-studio/preview.ts';
import { readCardFromPng, stripCardFromPng, writeCheckedCardPng } from '../core/card-studio/png.ts';
import { coverDataUrl, decodeCardImage, decodeCover } from '../core/card-studio/cover.ts';
import { SECTION_IDS, UNCLASSIFIED_SECTION, sortByDependency } from '../shared/card-studio/boards.ts';
import { dispatchKey, messageStartsDispatch, parseDispatches } from '../shared/card-studio/dispatch.ts';
import { projectRelativePath } from '../shared/card-studio/view.ts';
import { parsePeople } from '../shared/card-studio/design-book.ts';
import { parseStylePreset } from '../shared/card-studio/style-presets.ts';
import { KICKOFF, handoffRequestText, isHandoffRequest } from '../shared/card-studio/markers.ts';
import { formatHandoff, handoffFromReply } from '../shared/card-studio/handoff.ts';
import { changeQueue, runIsOpen, runOwns, runnableSection } from '../shared/card-studio/run.ts';
import type { CardChange, CardChangeItem, CardCheckReport, CardComponentResult, CardComponentSummary, CardDispatch, CardExportResult, CardImportPreview, CardImportReport, CardLoreSuggestion, CardMeta, CardPieceSummary, CardPreview, CardPreviewKind, CardPreviewState, CardProjectView, CardRunSettings, CardStudioSnapshot, CardVariableSyncResult, CardVariableTableView, CoverSource, NewCardChange, NewCardComponent, NewCardProject, PlanMode, StartCardConversation } from '../shared/card-studio/types.ts';

export type StartConversationInput = StartCardConversation;
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const stamp = () => new Date().toISOString();

/** A name that is safe as a file name on Windows: reserved characters become _, control characters go. */
function safeFileName(name: string): string {
  return [...name.replace(/[\\/:*?"<>|]/g, '_')].filter(char => char.charCodeAt(0) >= 32).join('').trim().replace(/[. ]+$/, '') || '未命名';
}

/** 改动派单 titles start with 「改动 · 」 whatever way the change AI wrote the prefix, or whether it wrote one. */
function changeTitle(title: string): string {
  const rest = title.trim().replace(/^改动\s*[·・:：]\s*/, '');
  return `改动 · ${rest || title.trim()}`;
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
  private frontendResources?: Promise<FrontendResources | null>;
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

  /** `internal.changeId`: the change AI's conversation of a 改动单; only `startChange` opens one. */
  async startConversation(input: StartConversationInput, internal: { changeId?: string } = {}): Promise<Task> {
    const project = this.cardProject(input.projectId);
    if (!SECTION_IDS.includes(input.sectionId)) throw new Error('未知的分区。');
    if (input.sectionId === 'source') throw new Error('资料板块没有对话，请在资料页导入资料。');
    if (input.kickoff && input.sectionId !== 'plan') throw new Error('只有规划可以自动开场。');
    if ((input.mode === 'change') !== !!internal.changeId || (internal.changeId && (input.sectionId !== 'plan' || input.kickoff))) throw new Error('改动单请从卡项目主页的「提改动」或 /改动 开始。');
    const view = await this.reload(project.id);
    if (view.error) throw new Error(view.error);
    const dispatch = input.dispatchId ? view.dispatches.find(item => item.id === input.dispatchId) : undefined;
    if (input.dispatchId && !dispatch) throw new Error('找不到这条派单。');
    // 改动派单 also go out on a card without a design book (Q15): the dispatch and the card's components are the reference.
    if (!view.design.exists && !['plan', 'build'].includes(input.sectionId) && !dispatch?.changeId) throw new Error('还没有设计书。除资料和拼装外，其他分区要等规划写出设计书后才能开工。');
    if (dispatch && dispatch.sectionId !== input.sectionId) throw new Error('这条派单不属于这个分区。');
    const mode = input.sectionId === 'plan' ? input.mode ?? (view.origin === 'import' ? 'refine' : 'scratch') : undefined;
    const title = (input.title?.trim() || (input.kickoff ? mode === 'refine' ? '完善优化卡' : '从零开始制卡' : dispatch?.title) || '新对话').slice(0, 160);
    // Ultra belongs to planning, where it brings the reading squad; elsewhere it means the highest effort.
    const thinking = input.thinking === 'ultra' && input.sectionId !== 'plan' ? 'max' : input.thinking;
    const task = await this.harness.createTask({
      projectId: project.id, title, prompt: input.kickoff ? await this.prompts.effective(`kickoff/${mode ?? 'scratch'}`) : input.prompt, permission: input.permission ?? project.cardSettings?.permission ?? 'edit', isolated: false,
      ...(thinking ? { thinking } : {}), ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      card: { sectionId: input.sectionId, ...(dispatch ? { dispatchId: dispatch.id } : {}), ...(mode ? { mode } : {}), web: input.web === true, ...(input.kickoff ? { kickoff: true } : {}), ...(internal.changeId ? { changeId: internal.changeId } : {}) },
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

  /** Called before a message is sent in a card conversation: sending a dispatch starts it. Returns the dispatch it started. */
  async beforePrompt(task: Task, text: string): Promise<string | undefined> {
    const card = task.card;
    if (!card) return undefined;
    let started: string | undefined;
    try {
      await this.mutate(task.projectId, file => {
        const waiting = file.dispatches.filter(item => item.sectionId === card.sectionId && item.status === 'todo');
        // A conversation that finished its dispatch can take the next one (one-click making sends them into the same conversation).
        const target = waiting.find(item => item.id === card.dispatchId) ?? waiting.find(item => messageStartsDispatch(text, item));
        if (!target) return false;
        target.status = 'active'; target.updatedAt = stamp(); card.dispatchId = target.id; started = target.id;
        return true;
      });
    } catch { /* A broken registration file must not block the conversation; the library shows the error. */ }
    return started;
  }

  /**
   * 撤回 in a card conversation (Q16): the harness stops the turn and takes the message out; a dispatch the message
   * started goes back to 未派. The app's own lines (the kickoff, the handoff request) and one-click making's
   * conversations are not withdrawn here: stop them instead.
   */
  async withdraw(taskId: string, messageId: string): Promise<{ text: string; turnId: string }> {
    const conversation = this.cardConversation(taskId);
    const message = conversation.messages.find(item => item.id === messageId && item.role === 'user');
    if (!message) throw new Error('找不到这条消息。');
    const kickoff = conversation.card!.kickoff && conversation.messages.find(item => item.role === 'user')?.id === message.id;
    if (kickoff || isHandoffRequest(message.text)) throw new Error('这条是应用发出的消息，不能撤回；要停下这一轮，请按【停止】。');
    if (runOwns(this.cardProject(conversation.projectId).cardRun, taskId)) throw new Error('一键制作正在用这个对话。先停止一键制作，再撤回。');
    const withdrawal = await this.harness.withdraw(taskId, messageId);
    if (withdrawal.dispatchIds.length) {
      await this.mutate(conversation.projectId, file => {
        let changed = false;
        for (const dispatch of file.dispatches.filter(item => withdrawal.dispatchIds.includes(item.id) && item.status === 'active')) {
          dispatch.status = 'todo'; dispatch.updatedAt = stamp(); changed = true;
        }
        return changed;
      });
    }
    return { text: withdrawal.text, turnId: withdrawal.turnId };
  }

  /** Called when a card conversation run ends: planning replies register their dispatches; a change AI's reply is its 影响清单. */
  async afterConversation(task: Task): Promise<void> {
    const card = task.card;
    if (!card) return;
    if (card.handoff?.status === 'requested') {
      const requestId = card.handoff.requestId ?? task.messages.findLast(message => message.role === 'user' && isHandoffRequest(message.text))?.id;
      const handoff = task.status === 'completed' ? handoffFromReply(task.messages, requestId) : null;
      const auto = card.handoff.auto ? { auto: true } : {};
      this.harness.setCardHandoff(task.id, handoff ? { status: 'ready', at: stamp(), requestId, summary: formatHandoff(handoff), ...auto } : { status: 'failed', at: stamp(), requestId, ...auto });
    }
    if (card.changeId) await this.afterChangeTurn(task, card.changeId).catch(() => undefined);
    else try {
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
    // The 变量结构 section's turn is over: whatever it wrote into 变量表.yaml becomes the variable files (a missing or broken table is left to the checks).
    if (card.sectionId === 'script-schema' && task.status === 'completed') await this.syncVariables(task.projectId).catch(() => undefined);
    this.runner.settled(task);
  }

  /**
   * 提改动 (§5.4, Q10, Q15): a draft 改动单 and the change AI's planning conversation. The AI reads the card and answers
   * with one 派单 block per affected component, which become the 影响清单; with a single component it edits it directly.
   */
  async startChange(projectId: string, input: NewCardChange): Promise<{ change: CardChange; task: Task }> {
    const kind = input?.kind === 'request' || input?.kind === 'error' ? input.kind : null;
    if (!kind) throw new Error('未知的改动类型。');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw new Error(kind === 'error' ? '请贴上报错的内容。' : '请用一句话写下要改什么。');
    if (text.length > 100_000) throw new Error('内容太长了，只贴相关的部分就好。');
    if (runIsOpen(this.cardProject(projectId).cardRun)) throw new Error('这张卡还有一次一键制作没做完，先继续或停止它。');
    const view = await this.reload(projectId);
    if (view.error) throw new Error(view.error);
    const at = stamp();
    const change: CardChange = { id: randomUUID(), kind, text, status: 'draft', items: [], dispatchIds: [], ...(view.design.exists ? {} : { noDesignBook: true }), createdAt: at, updatedAt: at };
    await this.mutate(projectId, file => { file.changes.push(change); return true; });
    const line = [...text.replace(/\s+/g, ' ')];
    const prompt = [kind === 'error' ? '【报错】' : '【改动单】', text, ...(view.design.exists ? [] : ['（本卡没有设计书：以卡里现有的组件为准。）'])].join('\n\n');
    let task: Task;
    try {
      task = await this.startConversation({
        projectId, sectionId: 'plan', mode: 'change', title: `改动 · ${line.slice(0, 16).join('')}${line.length > 16 ? '…' : ''}`, prompt,
        ...(input.thinking ? { thinking: input.thinking } : {}), ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      }, { changeId: change.id });
    } catch (error) {
      await this.mutate(projectId, file => { const before = file.changes.length; file.changes = file.changes.filter(item => item.id !== change.id); return file.changes.length < before; }).catch(() => undefined);
      throw error;
    }
    await this.updateChange(projectId, change.id, item => { item.taskId = task.id; });
    return { change: { ...change, taskId: task.id }, task };
  }

  /** Takes one row off a draft 影响清单. */
  async removeChangeItem(projectId: string, changeId: string, itemId: string): Promise<void> {
    await this.mutate(projectId, file => {
      const change = file.changes.find(item => item.id === changeId);
      if (!change) throw new Error('找不到这个改动。');
      if (change.status !== 'draft') throw new Error('这个改动已经照单开做，影响清单不能再改。');
      const before = change.items.length;
      change.items = change.items.filter(item => item.id !== itemId);
      if (change.items.length === before) return false;
      change.updatedAt = stamp();
      return true;
    });
  }

  /**
   * 照单开做 (Q14): the 影响清单 becomes 改动派单, sorted by the sections' dependencies. With a design book the change AI
   * first brings it in line and the run starts when that turn ends; without one the run starts at once.
   */
  async confirmChange(projectId: string, changeId: string, settings: CardRunSettings): Promise<void> {
    if (runIsOpen(this.cardProject(projectId).cardRun)) throw new Error('这张卡还有一次一键制作没做完，先继续或停止它。');
    this.runner.checkSettings(settings);
    const chosen: CardRunSettings = { thinking: settings.thinking, gatewayId: settings.gatewayId, ...(settings.modelId ? { modelId: settings.modelId } : {}), permission: settings.permission, autoAnswer: settings.autoAnswer };
    if (this.conversationRunning(projectId)) throw new Error('这张卡有对话正在运行，等它结束或先停止它。');
    const view = await this.reload(projectId);
    if (view.error) throw new Error(view.error);
    const change = view.changes.find(item => item.id === changeId);
    if (!change) throw new Error('找不到这个改动。');
    if (change.status !== 'draft') throw new Error('这个改动已经照单开做过了。');
    if (!change.items.length) throw new Error('影响清单是空的，没有要做的改动派单。');
    const stray = change.items.find(item => !runnableSection(item.sectionId));
    if (stray) throw new Error(`「${stray.title}」的目标「${stray.target}」不是一键制作能去的分区（世界书、脚本、正则、开场白）。删掉这一条再照单开做。`);
    const conversation = change.taskId ? this.harness.store.state.tasks.find(task => task.id === change.taskId) : undefined;
    const sync = view.design.exists && !!conversation;
    const at = stamp();
    const created: CardDispatch[] = [];
    await this.mutate(projectId, file => {
      const target = file.changes.find(item => item.id === changeId);
      if (target?.status !== 'draft') throw new Error('这个改动已经照单开做过了。');
      const keys = new Set(file.dispatches.map(dispatchKey));
      for (const item of sortByDependency(target.items)) {
        // Sending a dispatch starts the one with the same target and title, so a title already taken gets a number.
        let title = item.title;
        for (let copy = 2; keys.has(dispatchKey({ target: item.target, title })); copy++) title = `${item.title}（${copy}）`;
        keys.add(dispatchKey({ target: item.target, title }));
        created.push({ id: randomUUID(), target: item.target, sectionId: item.sectionId, title, requires: item.requires, body: item.body, status: 'todo', createdAt: at, updatedAt: at, changeId, ...(target.taskId ? { sourceTaskId: target.taskId } : {}) });
      }
      file.dispatches.push(...created);
      target.dispatchIds = created.map(item => item.id);
      target.settings = chosen; target.status = 'running'; delete target.note;
      if (sync) target.syncing = true;
      target.updatedAt = at;
      return true;
    });
    try {
      if (sync) {
        const list = created.map((item, index) => `${index + 1}. ${item.target}｜${item.title}`).join('\n');
        await this.harness.prompt(conversation!.id, `照单开做。确认的条目：\n${list}\n\n先把设计书改到与这些条目一致（只改涉及的地方），改完只回复「设计书已同步」，不要再写派单。`);
      } else await this.runner.start(projectId, 'change', chosen, { changeId });
    } catch (error) {
      // Nothing went out: the 改动派单 come off the list and the 影响清单 waits again.
      await this.mutate(projectId, file => {
        const target = file.changes.find(item => item.id === changeId);
        file.dispatches = file.dispatches.filter(item => !(item.status === 'todo' && created.some(made => made.id === item.id)));
        if (target) { target.status = 'draft'; target.dispatchIds = []; delete target.syncing; target.updatedAt = stamp(); }
        return true;
      }).catch(() => undefined);
      throw error;
    }
  }

  /** 继续跑: a paused run of this change goes on; after a stopped one, a new run takes the 改动派单 not yet done. */
  async resumeChange(projectId: string, changeId: string, settings?: CardRunSettings): Promise<void> {
    const run = this.cardProject(projectId).cardRun;
    const change = (await this.reload(projectId)).changes.find(item => item.id === changeId);
    if (!change) throw new Error('找不到这个改动。');
    if (change.status !== 'paused' && change.status !== 'running') throw new Error('这个改动没有在等「继续跑」。');
    if (runIsOpen(run)) {
      if (run!.changeId !== changeId) throw new Error('这张卡还有一次一键制作没做完，先继续或停止它。');
      if (run!.status !== 'paused') throw new Error('这个改动正在一键制作。');
      await this.runner.resume(projectId);
      return;
    }
    if (settings) this.runner.checkSettings(settings);
    if (this.conversationRunning(projectId)) throw new Error('这张卡有对话正在运行，等它结束或先停止它。');
    // The dispatch a stopped run was working on goes out again.
    await this.mutate(projectId, file => {
      let changed = false;
      for (const dispatch of file.dispatches) if (dispatch.changeId === changeId && dispatch.status === 'active') { dispatch.status = 'todo'; dispatch.updatedAt = stamp(); changed = true; }
      const target = file.changes.find(item => item.id === changeId);
      if (target?.syncing) { delete target.syncing; changed = true; }
      return changed;
    });
    if (!changeQueue(change, (await this.reload(projectId)).dispatches).length) { await this.finishChange(projectId, changeId, { errors: 0 }); return; }
    await this.startChangeRun(projectId, changeId, settings, { quiet: false });
  }

  /** 放弃这个改动: the 改动派单 not yet sent come off the list; what was already done stays. */
  async dropChange(projectId: string, changeId: string): Promise<void> {
    const run = this.cardProject(projectId).cardRun;
    const change = (await this.reload(projectId)).changes.find(item => item.id === changeId);
    if (!change) throw new Error('找不到这个改动。');
    if (change.status === 'done' || change.status === 'dropped') throw new Error('这个改动已经结束了。');
    const conversation = change.taskId ? this.harness.store.state.tasks.find(task => task.id === change.taskId) : undefined;
    if (change.syncing && conversation && ACTIVE.has(conversation.status)) throw new Error('改动 AI 正在同步设计书，等这一轮结束再放弃。');
    if (runIsOpen(run) && run!.changeId === changeId) {
      if (run!.status !== 'paused') throw new Error('这个改动正在一键制作，先在进度条上暂停或停止它。');
      await this.runner.stop(projectId);
    }
    await this.mutate(projectId, file => {
      const target = file.changes.find(item => item.id === changeId);
      if (!target) return false;
      file.dispatches = file.dispatches.filter(item => !(item.changeId === changeId && item.status === 'todo'));
      target.status = 'dropped'; delete target.syncing; target.updatedAt = stamp();
      return true;
    });
  }

  /** The runner calls this when a change's run completes: done, with the errors the final assembly check still found. */
  async finishChange(projectId: string, changeId: string, result: { errors: number }): Promise<void> {
    await this.updateChange(projectId, changeId, change => {
      if (change.status === 'dropped' || change.status === 'done') return false;
      change.status = 'done'; delete change.syncing;
      if (result.errors) change.note = `拼装检查还有 ${result.errors} 个错误，去拼装台看看。`; else delete change.note;
    });
  }

  /** The runner calls this when a change's run pauses, stops or goes on again. */
  async markChangeRun(projectId: string, changeId: string, status: 'running' | 'paused', note?: string): Promise<void> {
    await this.updateChange(projectId, changeId, change => {
      if (change.status !== 'running' && change.status !== 'paused') return false;
      change.status = status;
      if (note) change.note = note.slice(0, 2000); else delete change.note;
    });
  }

  /**
   * A turn of the change AI ended. While the 改动单 is a draft, the 派单 blocks of its reply replace the 影响清单 and are
   * not registered as dispatches; a reply without any whose turn wrote files was the one-component case, done directly.
   * After 照单开做, the turn that brought the design book in line starts the run.
   */
  private async afterChangeTurn(task: Task, changeId: string): Promise<void> {
    const project = this.cardProject(task.projectId);
    const change = (await readCardFile(project.path)).changes.find(item => item.id === changeId);
    if (change?.syncing) {
      if (task.status === 'completed') {
        await this.updateChange(task.projectId, changeId, item => { delete item.syncing; });
        await this.startChangeRun(task.projectId, changeId, undefined, { quiet: true });
      } else await this.updateChange(task.projectId, changeId, item => {
        delete item.syncing; item.status = 'paused';
        item.note = task.status === 'cancelled' ? '同步设计书的那一轮被停止了，改动派单还没开跑。点「继续跑」直接开跑。' : `同步设计书时出错：${task.error || '模型请求失败。'} 点「继续跑」直接开跑。`;
      });
      return;
    }
    if (change?.status !== 'draft' || task.status !== 'completed') { await this.reload(task.projectId); return; }
    const lastUser = task.messages.findLastIndex(message => message.role === 'user');
    const reply = task.messages.slice(lastUser + 1).findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '';
    const parsed = parseDispatches(reply).flatMap(item => 'error' in item ? [] : [item]);
    if (parsed.length) {
      const items: CardChangeItem[] = parsed.map(item => ({ id: randomUUID(), target: item.target, sectionId: item.sectionId, title: changeTitle(item.title), requires: item.requires, body: item.body }));
      await this.updateChange(task.projectId, changeId, item => { if (item.status !== 'draft') return false; item.items = items; });
      return;
    }
    // Only this turn's writes: the worker restarts for every turn, so they are the ones after it started.
    const since = task.startedAt ?? '';
    const direct = [...new Set(task.tools.filter(tool => tool.status === 'completed' && (tool.name === 'write' || tool.name === 'edit') && tool.at >= since)
      .map(tool => projectRelativePath(project.path, String(tool.args.path ?? ''))).filter((path): path is string => !!path))];
    if (direct.length) await this.updateChange(task.projectId, changeId, item => { if (item.status !== 'draft') return false; item.direct = direct; item.status = 'done'; delete item.note; });
    else await this.reload(task.projectId);
  }

  /** Starts the change's run over its unsent 改动派单. When it cannot start, the change pauses and says why; `quiet` keeps the error there. */
  private async startChangeRun(projectId: string, changeId: string, settings: CardRunSettings | undefined, options: { quiet: boolean }): Promise<void> {
    const change = (await this.reload(projectId)).changes.find(item => item.id === changeId);
    if (!change || change.status === 'dropped' || change.status === 'done') return;
    const chosen = settings ?? change.settings;
    await this.updateChange(projectId, changeId, item => { item.status = 'running'; if (chosen) item.settings = chosen; delete item.note; });
    try {
      if (!chosen) throw new Error('这个改动还没有选一键制作的设置。');
      await this.runner.start(projectId, 'change', chosen, { changeId });
    } catch (error) {
      await this.markChangeRun(projectId, changeId, 'paused', `改动派单没能开跑：${error instanceof Error ? error.message : String(error)} 处理好后点「继续跑」。`).catch(() => undefined);
      if (!options.quiet) throw error;
    }
  }

  private async updateChange(projectId: string, changeId: string, edit: (change: CardChange) => boolean | void): Promise<void> {
    await this.mutate(projectId, file => {
      const change = file.changes.find(item => item.id === changeId);
      if (!change || edit(change) === false) return false;
      change.updatedAt = stamp();
      return true;
    });
  }

  /** Whether a conversation of this card (not a squad member) is running; one-click making needs the card to itself. */
  private conversationRunning(projectId: string): boolean {
    return this.harness.store.state.tasks.some(task => task.projectId === projectId && task.card && !task.card.member && ACTIVE.has(task.status));
  }

  async workerContext(task: Task): Promise<{ prompt: string; readRoots: string[] }> {
    const view = await this.reload(task.projectId);
    if (view.error) throw new Error(view.error);
    if (task.card!.member) return { prompt: buildSquadMemberPrompt({ cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path }), readRoots: [this.resourceRoot] };
    const prompt = await buildSectionPrompt(this.resourceRoot, { sectionId: task.card!.sectionId, mode: task.card!.mode, cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path, stylePreset: view.stylePreset }, { read: id => this.prompts.effective(id) });
    return { prompt, readRoots: [this.resourceRoot] };
  }

  async readPrompt(projectId: string, sectionId: string, mode?: PlanMode): Promise<string> {
    if (!SECTION_IDS.includes(sectionId)) throw new Error('未知的分区。');
    const view = await this.reload(projectId);
    return buildSectionPrompt(this.resourceRoot, { sectionId, mode: sectionId === 'plan' ? mode ?? (view.origin === 'import' ? 'refine' : 'scratch') : undefined, cardName: view.name, cardKind: view.kind, source: view.source, projectRoot: view.path, stylePreset: view.stylePreset }, { read: id => this.prompts.effective(id) });
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
      await writeDerivedTable(project.path).catch(() => false);
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

  /** 整理未分类 (Q22): moves world book components into a section's folder; the uid, the order and the body stay as they are. */
  async moveLore(projectId: string, paramsPaths: string[], section: string): Promise<string[]> {
    if (!Array.isArray(paramsPaths) || !paramsPaths.length || paramsPaths.some(path => typeof path !== 'string')) throw new Error('先勾选要移动的条目。');
    if (!LORE_TARGETS.some(target => target.id === section)) throw new Error('只能移到世界书的七个分区之一。');
    const project = this.cardProject(projectId);
    const moved = await this.exclusive(projectId, async () => {
      const result = await moveLoreComponents(project.path, paramsPaths, section);
      // A move counts as an edit of the card: the brief and the library re-read on `updatedAt`.
      const file = await readCardFile(project.path);
      file.updatedAt = stamp();
      await writeCardFile(project.path, file);
      return result;
    });
    await this.reload(projectId);
    return moved;
  }

  /**
   * AI 归类建议 (Q22): one model call over up to 200 unclassified entries (the given uids, else the first ones), on the
   * model this card plans or runs with, else the default one. It only suggests: the author moves the entries.
   */
  async suggestLoreSections(projectId: string, uids?: number[]): Promise<CardLoreSuggestion[]> {
    const project = this.cardProject(projectId);
    const wanted = Array.isArray(uids) && uids.length ? new Set(uids.map(Number)) : null;
    const entries = (await readProject(project.path)).lore.filter(item => item.section === UNCLASSIFIED_SECTION && (!wanted || wanted.has(item.uid))).slice(0, LORE_SUGGESTION_LIMIT);
    if (!entries.length) throw new Error('没有要归类的未分类条目。');
    const request = loreSuggestionRequest(entries.map(item => ({
      uid: item.uid, name: String(item.params.comment ?? ''), keys: Array.isArray(item.params.key) ? item.params.key.map(String) : [], content: item.content,
    })));
    // About 40 tokens a line; the reader keeps whatever complete lines a cut-off reply has.
    const reply = await oneShotCompletion(this.oneShotConnection(project), { ...request, maxTokens: Math.min(12_000, 1_000 + entries.length * 50), timeoutMs: 180_000 });
    return parseLoreSuggestions(reply.text, entries.map(item => item.uid));
  }

  /** The model for the app's own one-off calls: the card's planning choice, its last run's, the default gateway, the first one. */
  private oneShotConnection(project: Project): ReturnType<Harness['connection']> {
    const { gateways, preferences } = this.harness.store.state;
    const settings = project.cardSettings;
    const choices = [
      { gatewayId: settings?.kickoff?.gatewayId, modelId: settings?.kickoff?.modelId },
      { gatewayId: settings?.run?.gatewayId, modelId: settings?.run?.modelId },
      { gatewayId: preferences.defaultGatewayId, modelId: preferences.defaultModelId },
      { gatewayId: gateways[0]?.id, modelId: undefined },
    ];
    for (const choice of choices) {
      if (!choice.gatewayId || !gateways.some(gateway => gateway.id === choice.gatewayId)) continue;
      // A model since removed from its gateway falls back to the gateway's own.
      try { return this.harness.connection(choice.gatewayId, choice.modelId); }
      catch { try { return this.harness.connection(choice.gatewayId); } catch { /* try the next choice */ } }
    }
    throw new Error('还没有可用的模型网关。先在设置里添加一个网关，再让 AI 给归类建议。');
  }

  /** The regex and script pieces of one card project, for the section pages and single-piece exports; a floating status app's script is listed too. */
  async listPieces(projectId: string): Promise<CardPieceSummary[]> {
    const components = await readProject(this.cardProject(projectId).path);
    const summarize = (kind: PieceKind, list: readonly FileComponent[]): CardPieceSummary[] => list.map(item => ({
      kind, name: item.name,
      title: String(item.params[kind === 'regex' ? 'scriptName' : 'name'] ?? item.name) || item.name,
      chars: item.body.length,
      disabled: kind === 'regex' ? item.params.disabled === true : item.params.enabled === false,
      bodyPath: item.bodyPath,
    }));
    let synthesized: CardPieceSummary[] = [];
    try {
      const compiled = compileProject(components, await this.assemblyContext(projectId, components));
      synthesized = compiled.scripts.map(item => ({ kind: 'script' as const, name: item.name, title: String(item.params.name), chars: item.body.length, disabled: item.params.enabled === false, bodyPath: item.from.bodyPath, synthesized: true }));
    } catch { /* A damaged skeleton is the checks' to report; the files still list. */ }
    return [...summarize('regex', components.regex), ...summarize('script', components.scripts), ...synthesized];
  }

  async runChecks(projectId: string): Promise<CardCheckReport> {
    const root = this.cardProject(projectId).path;
    // A card without an authored table gets a derived one for the checks to work from; nothing else is written here.
    await this.exclusive(projectId, () => writeDerivedTable(root)).catch(() => false);
    // The card's own Zod code runs in the bundled sandbox process, never in this one.
    return runChecks(root, { ...(this.options.sandboxEntry ? { sandbox: { entry: this.options.sandboxEntry } } : {}), frontend: await this.frontend(), preset: this.views.get(projectId)?.stylePreset?.id ?? null });
  }

  /** Writes the Zod script, [initvar], the fixed entries and the cleanup regex from 变量表.yaml (ADR 0020). */
  async syncVariables(projectId: string): Promise<CardVariableSyncResult> {
    const project = this.cardProject(projectId);
    const name = this.views.get(projectId)?.name ?? project.name;
    const result = await this.exclusive(projectId, async () => {
      const sync = await syncVariableArtifacts(project.path, { cardName: name });
      if (sync) {
        // The generated files count as an edit of the card: the brief and the library re-read on `updatedAt`.
        const file = await readCardFile(project.path);
        file.updatedAt = stamp();
        await writeCardFile(project.path, file);
      }
      return sync;
    });
    await this.reload(projectId);
    if (!result) throw new Error(`卡项目里没有 ${VARIABLE_TABLE_FILE}。先按「脚本 · 变量结构」的格式写出变量表，再生成。`);
    return result;
  }

  /** The 变量表 as the section brief shows it. */
  async readVariableTable(projectId: string): Promise<CardVariableTableView> {
    const root = this.cardProject(projectId).path;
    try {
      const state = await readVariableTableState(root);
      if (!state.source) return { source: null, path: VARIABLE_TABLE_FILE, rows: [] };
      const manifest = state.source === 'authored' ? await readArtifactManifest(root) : null;
      const rows = state.table.rows.map(row => ({ path: row.path, type: describeVariableRow({ ...row, owner: '模型', when: undefined }, { omitDefault: true }), default: row.default === undefined ? '' : String(row.default), owner: row.owner, when: row.when ?? '', note: row.note ?? '' }));
      return { source: state.source, path: state.source === 'authored' ? VARIABLE_TABLE_FILE : DERIVED_TABLE_FILE, rows, ...(state.source === 'authored' && (!manifest || manifest.table !== hashText(state.text)) ? { stale: true } : {}) };
    } catch (error) {
      return { source: 'authored', path: VARIABLE_TABLE_FILE, rows: [], error: error instanceof Error ? error.message : String(error) };
    }
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
      const context = await this.assemblyContext(projectId, components);
      const body = Buffer.from(JSON.stringify(buildPiece(components, kind, name, context), null, 2) + '\n', 'utf8');
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
        ...(args.format === 'sheet' ? { format: 'sheet' as const } : {}),
      });
    }
    if (action === 'check') return this.runChecks(task.projectId);
    if (action === 'sync_variables') {
      const sync = await this.syncVariables(task.projectId);
      const check = await this.runChecks(task.projectId);
      return { sync, check: { ok: check.ok, errors: check.findings.filter(item => item.level === 'error'), warnings: check.findings.filter(item => item.level === 'warning') } };
    }
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
      const context = await this.assemblyContext(projectId, components);
      const value = kind === 'lorebook' ? buildLorebookFromProject(components) : buildCardFromProject(components, context);
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
      return { ...result, report: await this.writeReport(project.path, components, context, file, version, date) };
    });
  }

  /** Compares every piece with the last whole-card export and writes the report next to the export. */
  private async writeReport(root: string, components: ProjectComponents, context: AssemblyContext, file: string, version: string, date: string): Promise<{ file: string; text: string }> {
    // Kept beside the other hidden studio files, so 导出/ only ever holds what the author exported.
    const store = join(root, '.cardwright-exported.json');
    const previous = await readFile(store, 'utf8').then(content => JSON.parse(content) as PieceFingerprint[], () => null);
    const current = fingerprintProject(components);
    const data = (components.envelope.data && typeof components.envelope.data === 'object' ? components.envelope.data : {}) as Record<string, unknown>;
    const diff = diffFingerprints(previous, current);
    // When pieces changed, the report tells how to replace them one by one; write them now, so it points at this export's pieces.
    const piecesChanged = !!diff && [...diff.added, ...diff.changed].some(item => item.kind === 'lore' || item.kind === 'regex' || item.kind === 'script');
    const piecesFolder = piecesChanged ? (await this.writePieces(root, components, context, version, date)).folder : null;
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
      const { folder, files, bytes } = await this.writePieces(project.path, components, await this.assemblyContext(projectId, components), version, date);
      await this.recordExport(projectId, registration, { kind: 'pieces', file: folder, bytes, entries: files.length, at: stamp() });
      return { folder, files };
    });
  }

  /**
   * Writes every piece into 导出/单件-<version>-<date>/, replacing what is there: the pieces of one version and day are the
   * latest ones. The project is compiled once; a floating status app's synthesized script is a piece of its own.
   */
  private async writePieces(root: string, components: ProjectComponents, context: AssemblyContext, version: string, date: string): Promise<{ folder: string; files: string[]; bytes: number }> {
    const folder = `导出/${piecesFolderName(version, date)}`;
    const files: string[] = [];
    let bytes = 0;
    const put = async (name: string, value: unknown) => {
      const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      files.push(await this.writeOver(root, `${folder}/${safeFileName(name)}.json`, body));
      bytes += body.length;
    };
    const compiled = compileProject(components, context);
    if (components.lore.length) await put(bookName(components), buildLorebookFromProject(components));
    for (const item of components.regex) await put(`正则-${item.name}`, buildPiece(components, 'regex', item.name, context, compiled));
    for (const item of [...components.scripts, ...compiled.scripts]) await put(`脚本-${item.name}`, buildPiece(components, 'script', item.name, context, compiled));
    return { folder, files, bytes };
  }

  /**
   * The local preview: the card's regex over the format sample, in SillyTavern's order, each part of the result handed to
   * the publisher as a document of its own. 正文美化 shows the whole sample reply; 变量更新 shows the update block,
   * finished and still streaming, from the sample or else from the 变量 entries; 状态栏 and 开局创角页 show their
   * front-end on the sample variables. Every front-end runs inside the 模拟酒馆; message text runs no card script.
   */
  async preview(projectId: string, kind: CardPreviewKind): Promise<CardPreview> {
    const project = this.cardProject(projectId);
    const publish = this.options.publishPreview;
    if (!publish) throw new Error('这里不能显示预览。');
    const components = await readProject(project.path);
    const context = await this.assemblyContext(projectId, components);
    // The replacements as the exported card carries them — a sheet compiled, a document fenced — so the preview renders what SillyTavern will.
    const compiled = compileProject(components, context);
    const macros = { char: context.cardName, user: '玩家' };
    const scripts = compiled.regex.map(item => joinComponent({ params: item.component.params, body: item.replacement }, 'replaceString') as PreviewRegex);
    const statData = sampleVariables(components, context.table);
    let variables = '{}';
    try { variables = JSON.stringify(statData, null, 2) ?? '{}'; } catch { /* a cycle made of YAML aliases shows as nothing; the sim reports it */ }
    const base = { kind, variables };
    const sim = tavernSimScript({ cardName: macros.char, bookName: components.book.name, statData });
    const withSim = (segments: PreviewSegment[]): PreviewSegment[] => segments.map(segment => (segment.kind === 'frontend' ? { ...segment, sim } : segment));
    const state = (index: number, label: string, text: string): CardPreviewState => {
      const render = renderReply(text, scripts, macros);
      const urls = publish(`${projectId}:${kind}:${index}`, withSim(render.segments));
      return { label, steps: render.steps, frames: render.segments.map((segment, at) => ({ kind: segment.kind, url: urls[at] })), external: render.external };
    };
    // A card may carry several format entries (Re0 has a full and a light one): take one with a sample, an enabled one first.
    const formats = components.lore.filter(entry => entry.section === 'lore-format');
    const sampled = formats.filter(entry => sampleOutputFrom(entry.content));
    const format = sampled.find(entry => !entry.params.disable) ?? sampled[0] ?? formats[0];
    const sample = format ? sampleOutputFrom(format.content) : null;
    if (kind === 'status' || kind === 'start') {
      const wanted = kind === 'status' ? '状态栏' : '创角页';
      const nameLike = kind === 'status' ? /状态栏|status/i : /创角|开局|start/i;
      // The sheet of that kind, else a hand-written document whose name says what it is.
      const entry = compiled.regex.find(item => item.sheet?.kind === wanted) ?? compiled.regex.find(item => nameLike.test(String(item.component.params.scriptName ?? item.component.name)) && frontendDocument(item.replacement));
      if (!entry) return { ...base, source: null, states: [], notice: kind === 'status' ? '还没有状态栏正则。新建一个装配单（card_new_component，format: sheet）或手写一份 HTML 文档，预览才有东西可看。' : '还没有开局创角页正则。新建一个装配单（format: sheet），预览才有东西可看。' };
      const form = entry.form;
      const publishWith = (index: number, label: string, segments: PreviewSegment[], external: string[] = []): CardPreviewState => {
        const urls = publish(`${projectId}:${kind}:${index}`, withSim(segments));
        return { label, steps: [], frames: segments.map((segment, at) => ({ kind: segment.kind, url: urls[at] })), external };
      };
      const source = { from: entry.sheet ? 'sheet' as const : 'sample' as const, path: entry.component.bodyPath };
      if (kind === 'status' && form === 'header') {
        const body = compiled.regex.find(item => item.sheet?.kind === '正文美化' && item.sheet.statusHead);
        if (!body) return { ...base, form, source, states: [], notice: 'header 形态的状态栏嵌在正文美化的顶部，本卡还没有开了 状态头 的正文美化装配单。' };
        if (!sample) return { ...base, form, source, states: [], notice: '状态头随正文美化出现，预览需要正文格式里的 ```示例输出 块当作一条回复。' };
        const render = renderReply(sample, scripts, macros);
        return { ...base, form, source, notice: null, states: [publishWith(0, '初始变量', render.segments, render.external)] };
      }
      if (kind === 'status' && form === 'floating') {
        const script = compiled.scripts.find(item => item.from === entry.component);
        if (!script) return { ...base, form, source, states: [], notice: '悬浮应用没有编译出来，先看拼装检查里的 sheet-invalid。' };
        const html = ['<!DOCTYPE html>', '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;min-height:480px;background:#1b1b1b;}</style></head>', `<body><script>${script.body}</script></body></html>`].join('\n');
        return { ...base, form, source, notice: '悬浮球挂在酒馆页面右下角；这里用预览文档代替酒馆页面。', states: [publishWith(0, '初始变量', [{ kind: 'frontend', html }])] };
      }
      let html = frontendDocument(entry.replacement);
      if (!html) return { ...base, ...(form ? { form } : {}), source, states: [], notice: '这条正则的替换内容不是完整的 HTML 文档，预览不了；看拼装检查。' };
      if (kind === 'start') {
        // In SillyTavern the page gets the greeting's <start> block as $1; the preview hands it the first greeting's.
        const greeting = components.greetings.find(item => item.kind === 'first')?.text ?? '';
        const block = /<start>([\s\S]*?)<\/start>/i.exec(greeting)?.[1] ?? '';
        html = html.replace('<textarea id="cw-source" hidden>$1</textarea>', () => `<textarea id="cw-source" hidden>${block.replace(/<\/textarea/gi, '&lt;/textarea')}</textarea>`);
      }
      return { ...base, ...(form ? { form } : {}), source, notice: null, states: [publishWith(0, '初始变量', [{ kind: 'frontend', html }])] };
    }
    if (kind === 'body') {
      if (!format || !sample) return { ...base, source: null, states: [], notice: format ? '正文格式条目里还没有 ```示例输出 块。预览用它当作一条 AI 回复，先在世界书 · 正文格式里写一段。' : '还没有正文格式条目。预览用它的示例输出当作一条 AI 回复，先在世界书 · 正文格式里写出来。' };
      return { ...base, source: { from: 'sample', path: format.bodyPath }, notice: null, states: [state(0, '整条回复', sample)] };
    }
    const inSample = sample ? updateBlocks(sample) : null;
    const lent = format && inSample ? { from: 'sample' as const, path: format.bodyPath, blocks: inSample }
      : components.lore.filter(entry => entry.section === 'lore-vars').map(entry => ({ from: 'variables' as const, path: entry.bodyPath, blocks: updateBlocks(entry.content) })).find(item => item.blocks);
    if (!lent?.blocks) return { ...base, source: null, states: [], notice: '示例输出和世界书 · 变量里都没有 <UpdateVariable> 块。在世界书 · 变量里（例如变量输出格式条目）写一段完整的更新示例，预览才有东西可看。' };
    return { ...base, source: { from: lent.from, path: lent.path }, notice: null, states: [state(0, '生成完成', lent.blocks.done), state(1, '生成中', lent.blocks.streaming)] };
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

  /** The skeleton ships with the app; a missing file is logged once and the sheets then report one issue, not crashes. */
  private frontend(): Promise<FrontendResources | null> {
    this.frontendResources ??= loadFrontendResources(this.resourceRoot).catch(error => { console.error('[card-studio] 前端骨架读取失败', error); return null; });
    return this.frontendResources;
  }

  /** What the checks, the exports and the previews assemble with: the skeleton, the 变量表 (authored or derived), the card's name and preset. */
  private async assemblyContext(projectId: string, components: ProjectComponents): Promise<AssemblyContext> {
    const project = this.cardProject(projectId);
    const view = this.views.get(projectId);
    let table: AssemblyContext['table'] = null;
    try { const state = await readVariableTableState(project.path); table = state.source ? state.table : null; } catch { table = null; }
    return { frontend: await this.frontend(), table, cardName: assemblyCardName(components, view?.name ?? project.name), preset: view?.stylePreset?.id ?? null };
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
    return { projectId: project.id, path: project.path, cardId: '', name: project.name, kind: 'original', coverStyle: 'vermilion', stylePreset: null, origin: 'new', createdAt: project.createdAt, updatedAt: project.createdAt, lastEditedAt: project.createdAt, dispatches: [], design: { exists: false, people: null }, changes: [], sources: 0, unclassified: 0, ...(error ? { error } : {}) };
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
    // Counted from the folder, not by reading every entry: a reload happens on every edit and an imported book can hold 800.
    const unclassified = (await readdir(join(project.path, ...LORE_FOLDERS[UNCLASSIFIED_SECTION].split('/'))).catch(() => [] as string[])).filter(name => name.endsWith('.json') && !name.startsWith('.')).length;
    const variableTable = await this.variableSummary(project.path);
    return {
      projectId: project.id, path: project.path, cardId: file.cardId, name: file.name, kind: file.kind, ...(file.source ? { source: file.source } : {}),
      // Planning names the preset in the design book's 风格预设 section; that is what the card shows once it exists.
      coverStyle: file.coverStyle, ...(file.cover ? { cover: file.cover } : {}), stylePreset: (design === undefined ? null : parseStylePreset(design)) ?? file.stylePreset, origin: file.origin,
      createdAt: file.createdAt, updatedAt: file.updatedAt, lastEditedAt: file.updatedAt, dispatches: file.dispatches,
      design: { exists: design !== undefined, people: design === undefined ? null : parsePeople(design) }, changes: file.changes, sources, unclassified,
      ...(variableTable ? { variableTable } : {}),
    };
  }

  private async variableSummary(root: string): Promise<CardProjectView['variableTable']> {
    try { const state = await readVariableTableState(root); return state.source ? { source: state.source, rows: state.table.rows.length } : undefined; }
    catch (error) { return { source: 'authored', rows: 0, error: error instanceof Error ? error.message.split('\n')[0] : String(error) }; }
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
