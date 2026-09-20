import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Harness } from './harness.ts';
import type { CardStudioService } from './card-studio.ts';
import { formatDispatch } from '../shared/card-studio/dispatch.ts';
import { ACCEPT_ALL_TEXT } from '../shared/card-studio/markers.ts';
import { DEFAULT_HANDOFF, handoffThreshold } from '../shared/card-studio/handoff.ts';
import { CONTINUE_TEXT, RUN_PAUSE_LABELS, dispatchErrors, runIsOpen, runQueue, turnOutcome } from '../shared/card-studio/run.ts';
import type { CardCheckFinding, CardRun, CardRunPause, CardRunScope, CardRunSettings } from '../shared/card-studio/types.ts';
import type { Approval, ChatMessage, Interaction, Project, Task } from '../shared/types.ts';

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const SCOPES = new Set<CardRunScope>(['all', 'lore', 'script', 'regex', 'greet']);
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const stamp = () => new Date().toISOString();

/** The message that asks for one fix round on this dispatch's check errors. */
function fixPrompt(errors: CardCheckFinding[]): string {
  return ['【拼装检查】这条派单写的组件有下面的错误，请逐条修正，修完再按交付格式回复：', '', ...errors.slice(0, 20).map((finding, index) => `${index + 1}. ${finding.message}${finding.path ? `（${finding.path}）` : ''}`)].join('\n');
}

/**
 * 一键制作 and 全部开做 (§5.1, ADR 0014): sends a card's unsent dispatches in order, one conversation per section, and
 * decides after each turn whether to mark the dispatch done, ask for a fix round, change conversation or pause.
 * Its state lives on the card project, so a restart finds a run paused rather than lost. Emits `notify` on pause and on completion.
 */
export class CardRunner extends EventEmitter {
  private locks = new Map<string, Promise<unknown>>();
  /** Conversations 停止 cancelled: their last event belongs to the run, not to the user. */
  private stopping = new Set<string>();

  constructor(private readonly harness: Harness, private readonly studio: CardStudioService) {
    super();
    // Detached, like `advance`: a card removed meanwhile has no run left to pause.
    harness.on('approval', (approval: Approval) => { const projectId = this.runOf(approval.taskId); if (projectId) void this.exclusive(projectId, () => this.onApproval(projectId, approval)).catch(() => undefined); });
    harness.on('interaction', (interaction: Interaction) => { const projectId = this.runOf(interaction.taskId); if (projectId) void this.exclusive(projectId, () => this.onInteraction(projectId, interaction)).catch(() => undefined); });
    this.restore();
  }

  /** A run that was going when the app stopped is paused, never resumed on its own. */
  private restore(): void {
    for (const project of this.harness.store.state.projects) {
      const run = project.cardRun;
      if (run && (run.status === 'running' || run.status === 'pausing')) this.harness.saveCardRun(project.id, { ...run, status: 'paused', pause: { reason: 'restart', message: '应用重启时这次一键制作还没做完，点【继续】接着做。', at: stamp() }, updatedAt: stamp() });
    }
  }

  async start(projectId: string, scope: CardRunScope, settings: CardRunSettings): Promise<CardRun> {
    return this.exclusive(projectId, async () => {
      const project = this.project(projectId);
      if (runIsOpen(project.cardRun)) throw new Error('这张卡还有一次一键制作没做完，先继续或停止它。');
      if (!SCOPES.has(scope)) throw new Error('未知的一键制作范围。');
      if (!settings || !['ask', 'edit', 'full'].includes(settings.permission) || !LEVELS.has(settings.thinking) || typeof settings.autoAnswer !== 'boolean' || !this.harness.store.state.gateways.some(gateway => gateway.id === settings.gatewayId)) throw new Error('一键制作的设置不完整：请选好思考强度、模型和权限。');
      if (this.harness.store.state.tasks.some(task => task.projectId === projectId && task.card && !task.card.member && ACTIVE.has(task.status))) throw new Error('这张卡有对话正在运行，等它结束或先停止它。');
      const view = await this.studio.reload(projectId);
      if (!view.design.exists) throw new Error('还没有设计书。先在规划写出设计书和派单。');
      const queue = runQueue(view.dispatches, scope);
      if (!queue.length) throw new Error('没有未派的派单可做。');
      const chosen: CardRunSettings = { thinking: settings.thinking, gatewayId: settings.gatewayId, ...(settings.modelId ? { modelId: settings.modelId } : {}), permission: settings.permission, autoAnswer: settings.autoAnswer };
      this.harness.saveCardSettings(projectId, { run: chosen });
      const run: CardRun = { id: randomUUID(), scope, status: 'running', settings: chosen, queue, total: queue.length, done: [], conversations: {}, autoAnswered: [], startedAt: stamp(), updatedAt: stamp() };
      this.save(projectId, run);
      void this.advance(projectId);
      return structuredClone(run);
    });
  }

  /** 暂停: the round that is running finishes, then the run stops before sending anything else. */
  pause(projectId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const run = this.project(projectId).cardRun;
      if (!run || run.status !== 'running') throw new Error('这张卡没有正在跑的一键制作。');
      const busy = [run.current?.taskId, run.handoff?.fromTaskId].some(id => id && ACTIVE.has(this.task(id)?.status ?? ''));
      if (busy) { run.status = 'pausing'; this.save(projectId, run); }
      else this.halt(projectId, run, 'user', '已暂停。点【继续】接着做。');
    });
  }

  /**
   * 继续: messages the user sent meanwhile count as handled and the last turn is judged again. Without any, the run does
   * what the pause was waiting for: it takes the recommendations for a question, allows another fix round for check
   * errors, asks again for a summary that never came, and asks the conversation to go on after an error, a restart, a
   * stopped turn, a refusal or failing tools.
   */
  resume(projectId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const run = this.project(projectId).cardRun;
      if (!run || run.status !== 'paused') throw new Error('这张卡没有暂停中的一键制作。');
      const previous = structuredClone(run);
      const reason = run.pause?.reason;
      run.status = 'running'; delete run.pause;
      if (run.handoff) {
        const from = this.task(run.handoff.fromTaskId);
        if (from?.card?.handoff?.status !== 'ready' && !(from && ACTIVE.has(from.status))) {
          if (from?.card?.handoff?.status === 'requested') this.harness.setCardHandoff(from.id, undefined);
          delete run.handoff;
        }
      }
      // Anything in the run's conversations it neither sent nor acknowledged is the user writing; 继续 takes it as handled.
      let wrote = false;
      for (const taskId of new Set([...Object.values(run.conversations), ...(run.current ? [run.current.taskId] : [])])) {
        const task = this.task(taskId);
        const fresh = task ? this.strays(run, task) : [];
        if (!task || !fresh.length) continue;
        wrote = true;
        this.remember(run, taskId, fresh.map(message => message.id));
        // Only the ones inside this dispatch's turns belong to its window.
        if (run.current?.taskId !== taskId) continue;
        const start = task.messages.findIndex(message => run.current!.sent.includes(message.id));
        run.current.sent.push(...fresh.filter(message => start >= 0 && task.messages.indexOf(message) > start).map(message => message.id));
      }
      const current = run.current && this.task(run.current.taskId);
      let nudge: string | undefined;
      if (run.current && current && !wrote && !ACTIVE.has(current.status)) {
        if (current.status === 'failed' || current.status === 'cancelled' || reason === 'refusal' || reason === 'tool-failures') nudge = CONTINUE_TEXT;
        else if (reason === 'question') nudge = ACCEPT_ALL_TEXT;
        else if (reason === 'check-errors') run.current.stage = 'work';
      }
      if (nudge && current) {
        try { await this.send(projectId, run, current.id, nudge); }
        catch (error) { this.save(projectId, previous); throw error; }
        return;
      }
      this.save(projectId, run);
      void this.advance(projectId);
    });
  }

  /** 停止: the conversation that is running is stopped at once. */
  stop(projectId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const run = this.project(projectId).cardRun;
      if (!run || !runIsOpen(run)) throw new Error('这张卡没有进行中的一键制作。');
      run.status = 'stopped'; run.finishedAt = stamp(); delete run.pause;
      this.save(projectId, run);
      for (const id of [run.current?.taskId, run.handoff?.fromTaskId]) if (id && ACTIVE.has(this.task(id)?.status ?? '')) { this.stopping.add(id); await this.harness.cancelTask(id); }
    });
  }

  /** Clears a finished or stopped run from the card project home. */
  dismiss(projectId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const run = this.project(projectId).cardRun;
      if (runIsOpen(run)) throw new Error('一键制作还没做完，先停止它。');
      this.harness.saveCardRun(projectId, undefined);
    });
  }

  /** A conversation of a run that has not finished, or one 停止 just cancelled; the app leaves its notifications to the run. */
  owns(taskId: string): boolean {
    if (this.stopping.has(taskId)) return true;
    return this.harness.store.state.projects.some(project => {
      const run = project.cardRun;
      return !!run && runIsOpen(run) && (Object.values(run.conversations).includes(taskId) || run.current?.taskId === taskId || run.handoff?.fromTaskId === taskId);
    });
  }

  /** The card studio calls this after its own bookkeeping for a finished card conversation. */
  settled(task: Pick<Task, 'id' | 'projectId'>): void {
    this.stopping.delete(task.id);
    const run = this.harness.store.state.projects.find(project => project.id === task.projectId)?.cardRun;
    if (!run) return;
    // Also when a round of the user's own ends in one of the run's conversations, which the run was waiting for.
    const waiting = run.status === 'running' && !run.current && !run.handoff && Object.values(run.conversations).includes(task.id);
    if (run.current?.taskId === task.id || run.handoff?.fromTaskId === task.id || waiting) void this.advance(task.projectId);
  }

  private advance(projectId: string): Promise<void> {
    return this.exclusive(projectId, () => this.step(projectId)).catch(error => {
      // A step that throws (a gateway that disappeared, a card folder that moved) pauses the run with the reason.
      const run = this.harness.store.state.projects.find(project => project.id === projectId)?.cardRun;
      try { if (run && (run.status === 'running' || run.status === 'pausing')) this.halt(projectId, run, 'model-error', error instanceof Error ? error.message : String(error)); }
      catch { /* The card project is gone; so is its run. */ }
    });
  }

  private async step(projectId: string): Promise<void> {
    if (this.harness.isClosing()) return;
    const project = this.project(projectId);
    const run = project.cardRun;
    if (!run || (run.status !== 'running' && run.status !== 'pausing')) return;

    if (run.handoff) {
      const from = this.task(run.handoff.fromTaskId);
      if (from && ACTIVE.has(from.status)) return;
      const state = from?.card?.handoff;
      if (state?.status === 'requested') return;
      if (state?.status !== 'ready' || !state.summary || !from) { this.halt(projectId, run, 'model-error', '没有拿到交接摘要，换对话没有完成。'); return; }
      if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
      const dispatch = (await this.studio.reload(projectId)).dispatches.find(item => item.id === run.handoff!.dispatchId);
      delete run.handoff;
      if (dispatch?.sectionId && dispatch.status === 'todo') {
        const task = await this.studio.startConversation({ projectId, sectionId: dispatch.sectionId, dispatchId: dispatch.id, title: dispatch.title, prompt: `${state.summary}\n\n${formatDispatch(dispatch)}`, ...this.conversationSettings(run) });
        await this.studio.consumeHandoff(from.id);
        run.conversations[dispatch.sectionId] = task.id;
        run.current = { dispatchId: dispatch.id, taskId: task.id, stage: 'work', sent: this.userMessages(task.id) };
        this.remember(run, task.id, run.current.sent);
        this.save(projectId, run);
        return;
      }
      this.save(projectId, run);
    }

    if (run.current) {
      const task = this.task(run.current.taskId);
      if (task && ACTIVE.has(task.status)) return;
      if (!task) delete run.current;
      else {
        const outcome = turnOutcome({ status: task.status, error: task.error, messages: task.messages, tools: task.tools, sent: run.current.sent, known: run.sentIds?.[task.id] ?? run.current.sent });
        if (outcome.kind === 'cancelled') { this.halt(projectId, run, 'user', '对话被停止了。点【继续】重新看这条派单。'); return; }
        if (outcome.kind === 'model-error') { this.halt(projectId, run, 'model-error', outcome.message); return; }
        if (outcome.kind === 'interjection') { this.halt(projectId, run, 'interjection', '你在对话里发了消息，这一轮已经处理。看过后点【继续】接着做。'); return; }
        if (outcome.kind === 'tool-failures') { this.halt(projectId, run, 'tool-failures', `${outcome.tool} 连续失败了 ${outcome.count} 次。看过对话后点【继续】。`); return; }
        if (outcome.kind === 'refusal') { this.halt(projectId, run, 'refusal', outcome.text); return; }
        if (outcome.kind === 'question') {
          if (!run.settings.autoAnswer) { this.halt(projectId, run, 'question', outcome.text); return; }
          run.autoAnswered.push({ dispatchId: run.current.dispatchId, text: outcome.text });
          if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
          await this.send(projectId, run, task.id, ACCEPT_ALL_TEXT);
          return;
        }
        const report = await this.studio.runChecks(projectId);
        const errors = dispatchErrors(report, task.tools, run.current.sent, project.path);
        if (errors.length) {
          const list = errors.slice(0, 8).map(finding => `${finding.message}${finding.path ? `（${finding.path}）` : ''}`).join('\n');
          if (run.current.stage === 'fix') { this.halt(projectId, run, 'check-errors', `修过一轮仍有错误：\n${list}`); return; }
          if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
          run.current.stage = 'fix';
          await this.send(projectId, run, task.id, fixPrompt(errors));
          return;
        }
        const done = run.current.dispatchId;
        await this.studio.markDispatchDone(projectId, done);
        run.done.push(done); run.queue = run.queue.filter(id => id !== done); delete run.current;
        this.save(projectId, run);
      }
    }

    if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
    const view = await this.studio.reload(projectId);
    while (run.queue.length) {
      const dispatch = view.dispatches.find(item => item.id === run.queue[0]);
      if (!dispatch?.sectionId || dispatch.status !== 'todo') { run.queue.shift(); continue; }
      const existing = run.conversations[dispatch.sectionId] ? this.task(run.conversations[dispatch.sectionId]) : undefined;
      if (existing && !existing.archived) {
        // The user can write in the moment between two dispatches, and may even have a round of their own going.
        if (this.strays(run, existing).length) {
          this.halt(projectId, run, 'interjection', '你在对话里发了消息。看过这一轮的结果后点【继续】接着做。');
          return;
        }
        // A round of the user's own that 继续 already acknowledged: wait for it, `settled` comes back here.
        if (ACTIVE.has(existing.status) || existing.workerActive) return;
        const threshold = handoffThreshold(existing.contextWindow || existing.contextUsage?.window || 0, this.harness.store.state.preferences.cardHandoff ?? DEFAULT_HANDOFF);
        const used = existing.contextUsage?.tokens ?? 0;
        if (used > 0 && used >= threshold) {
          run.handoff = { fromTaskId: existing.id, dispatchId: dispatch.id };
          this.save(projectId, run);
          await this.studio.requestHandoff(existing.id, { auto: true });
          return;
        }
        run.current = { dispatchId: dispatch.id, taskId: existing.id, stage: 'work', sent: [] };
        await this.send(projectId, run, existing.id, formatDispatch(dispatch));
        return;
      }
      const task = await this.studio.startConversation({ projectId, sectionId: dispatch.sectionId, dispatchId: dispatch.id, title: dispatch.title, prompt: formatDispatch(dispatch), ...this.conversationSettings(run) });
      run.conversations[dispatch.sectionId] = task.id;
      run.current = { dispatchId: dispatch.id, taskId: task.id, stage: 'work', sent: this.userMessages(task.id) };
      this.remember(run, task.id, run.current.sent);
      this.save(projectId, run);
      return;
    }

    if (run.scope === 'all') {
      const report = await this.studio.runChecks(projectId);
      run.finalCheck = { errors: report.findings.filter(item => item.level === 'error').length, warnings: report.findings.filter(item => item.level === 'warning').length, at: stamp() };
    }
    run.status = 'completed'; run.finishedAt = stamp(); delete run.pause;
    this.save(projectId, run);
    const check = run.finalCheck ? `，拼装检查 ${run.finalCheck.errors} 个错误、${run.finalCheck.warnings} 个警告` : '';
    this.emit('notify', { title: run.scope === 'all' ? this.say('Full run finished', '全部开做完成') : this.say('One-click making finished', '一键制作完成'), body: `${project.name}：做完 ${run.done.length} 条派单${check}。` });
  }

  private async onApproval(projectId: string, approval: Approval): Promise<void> {
    const run = this.project(projectId).cardRun;
    if (!run || (run.status !== 'running' && run.status !== 'pausing') || run.current?.taskId !== approval.taskId) return;
    this.halt(projectId, run, 'approval', `分区 AI 想用 ${approval.toolName}：${approval.reason} 在对话里批准或拒绝后点【继续】。`);
  }

  private async onInteraction(projectId: string, interaction: Interaction): Promise<void> {
    const run = this.project(projectId).cardRun;
    if (!run || (run.status !== 'running' && run.status !== 'pausing') || run.current?.taskId !== interaction.taskId) return;
    const text = [interaction.title, ...(interaction.questions ?? []).map(question => question.question)].join('\n').slice(0, 1200);
    if (!run.settings.autoAnswer) { this.halt(projectId, run, 'question', text); return; }
    const recommended = (options: Array<{ label: string; description?: string }> | undefined) => options?.find(option => /推荐/.test(`${option.label} ${option.description ?? ''}`))?.label ?? options?.[0]?.label ?? '按推荐';
    const answer = interaction.type === 'confirm' ? true
      : interaction.type === 'select' ? interaction.options?.find(option => option.includes('推荐')) ?? interaction.options?.[0] ?? '按推荐'
      : interaction.type === 'questionnaire' ? Object.fromEntries((interaction.questions ?? []).map(question => [question.id, recommended(question.options)]))
      : '按推荐';
    run.autoAnswered.push({ dispatchId: run.current.dispatchId, text });
    this.save(projectId, run);
    this.harness.answerInteraction(interaction.id, answer);
  }

  /** Pauses with a reason and tells the user, in the window and with a system notification. */
  private halt(projectId: string, run: CardRun, reason: CardRunPause, message: string): void {
    run.status = 'paused'; run.pause = { reason, message: message.slice(0, 2000), at: stamp() };
    this.save(projectId, run);
    this.emit('notify', { title: this.say(`One-click making paused: ${RUN_PAUSE_LABELS[reason].en}`, `一键制作已暂停：${RUN_PAUSE_LABELS[reason].zh}`), body: `${this.project(projectId).name}：${message.split('\n')[0].slice(0, 120)}` });
  }

  private async send(projectId: string, run: CardRun, taskId: string, text: string): Promise<void> {
    await this.harness.prompt(taskId, text);
    const message = this.task(taskId)?.messages.findLast(item => item.role === 'user' && item.text === text.trim());
    if (message) { if (run.current) run.current.sent.push(message.id); this.remember(run, taskId, [message.id]); }
    this.save(projectId, run);
  }

  private say(en: string, zh: string): string { return this.harness.store.state.preferences.language === 'en' ? en : zh; }
  private conversationSettings(run: CardRun) {
    return { thinking: run.settings.thinking, gatewayId: run.settings.gatewayId, ...(run.settings.modelId ? { modelId: run.settings.modelId } : {}), permission: run.settings.permission };
  }

  /** Messages the user wrote in one of the run's conversations, from the run's first message there onwards. */
  private strays(run: CardRun, task: Task): ChatMessage[] {
    const known = run.sentIds?.[task.id] ?? (run.current?.taskId === task.id ? run.current.sent : []);
    const first = task.messages.findIndex(message => known.includes(message.id));
    if (first < 0) return [];
    return task.messages.slice(first).filter(message => message.role === 'user' && !known.includes(message.id));
  }

  /** Messages the run sent or acknowledged in this conversation. */
  private remember(run: CardRun, taskId: string, ids: readonly string[]): void {
    if (!ids.length) return;
    run.sentIds = { ...run.sentIds, [taskId]: [...new Set([...(run.sentIds?.[taskId] ?? []), ...ids])] };
  }
  private userMessages(taskId: string): string[] { return this.task(taskId)?.messages.filter(message => message.role === 'user').map(message => message.id) ?? []; }
  private task(id: string): Task | undefined { return this.harness.store.state.tasks.find(task => task.id === id); }
  private runOf(taskId: string): string | undefined { return this.harness.store.state.projects.find(project => project.cardRun?.current?.taskId === taskId)?.id; }
  private project(projectId: string): Project {
    const project = this.harness.store.state.projects.find(item => item.id === projectId);
    if (!project || project.kind !== 'card') throw new Error('找不到这个卡项目。');
    return project;
  }
  private save(projectId: string, run: CardRun): void { run.updatedAt = stamp(); this.harness.saveCardRun(projectId, run); }
  private exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(projectId, next);
    return next.finally(() => { if (this.locks.get(projectId) === next) this.locks.delete(projectId); });
  }
}
