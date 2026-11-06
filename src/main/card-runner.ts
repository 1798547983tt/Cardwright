import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Harness } from './harness.ts';
import type { CardStudioService } from './card-studio.ts';
import { formatDispatch } from '../shared/card-studio/dispatch.ts';
import { ACCEPT_ALL_TEXT } from '../shared/card-studio/markers.ts';
import { DEFAULT_HANDOFF, handoffThresholdFor } from '../shared/card-studio/handoff.ts';
import { CONTINUE_TEXT, carriedOn, changeQueue, continueRounds, dispatchErrors, pauseLabel, runIsOpen, runQueue, turnOutcome } from '../shared/card-studio/run.ts';
import { squadOf, squadTools } from '../shared/card-studio/view.ts';
import type { CardAgentOptimization } from '../shared/card-studio/card-optimization.ts';
import type { CardCheckFinding, CardDispatch, CardRun, CardRunPause, CardRunScope, CardRunSettings } from '../shared/card-studio/types.ts';
import type { Approval, ChatMessage, Interaction, Project, Task } from '../shared/types.ts';

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const SCOPES = new Set<CardRunScope>(['all', 'lore', 'script', 'regex', 'greet', 'change']);
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const stamp = () => new Date().toISOString();

/** What the pause says when 自动按推荐 has answered one dispatch the effective limit and the section AI still asks. */
const answerLimitMessage = (question: string, limit: number) => `已经自动按推荐答了 ${limit} 次，分区 AI 还在提问，先停在这里。\n\n${question}`;

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
      if (!run || (run.status !== 'running' && run.status !== 'pausing')) continue;
      const message = '应用重启时这次一键制作还没做完，点【继续】接着做。';
      this.harness.saveCardRun(project.id, { ...run, status: 'paused', pause: { reason: 'restart', message, at: stamp() }, updatedAt: stamp() });
      this.followChange(project.id, run, 'paused', message);
    }
  }

  /** Throws unless these are complete run settings with a gateway that exists. */
  checkSettings(settings: CardRunSettings): void {
    if (!settings || !['ask', 'edit', 'full'].includes(settings.permission) || !LEVELS.has(settings.thinking) || typeof settings.autoAnswer !== 'boolean' || !this.harness.store.state.gateways.some(gateway => gateway.id === settings.gatewayId)) throw new Error('一键制作的设置不完整：请选好思考强度、模型和权限。');
  }

  /** Scope `change` runs one 改动单's dispatches (`options.changeId`) in their stored order; it needs no design book (Q15). */
  async start(projectId: string, scope: CardRunScope, settings: CardRunSettings, options: { changeId?: string } = {}): Promise<CardRun> {
    return this.exclusive(projectId, async () => {
      const project = this.project(projectId);
      if (runIsOpen(project.cardRun)) throw new Error('这张卡还有一次一键制作没做完，先继续或停止它。');
      if (!SCOPES.has(scope) || (scope === 'change') !== !!options.changeId) throw new Error('未知的一键制作范围。');
      this.checkSettings(settings);
      if (this.harness.store.state.tasks.some(task => task.projectId === projectId && task.card && !task.card.member && ACTIVE.has(task.status))) throw new Error('这张卡有对话正在运行，等它结束或先停止它。');
      const view = await this.studio.reload(projectId);
      let queue: string[];
      if (scope === 'change') {
        const change = view.changes.find(item => item.id === options.changeId);
        if (!change) throw new Error('找不到这个改动。');
        queue = changeQueue(change, view.dispatches);
      } else {
        if (!view.design.exists) throw new Error('还没有设计书。先在规划写出设计书和派单。');
        queue = runQueue(view.dispatches, scope);
      }
      if (!queue.length) throw new Error('没有未派的派单可做。');
      const chosen: CardRunSettings = { thinking: settings.thinking, gatewayId: settings.gatewayId, ...(settings.modelId ? { modelId: settings.modelId } : {}), permission: settings.permission, autoAnswer: settings.autoAnswer };
      this.harness.saveCardSettings(projectId, { run: chosen });
      // A dispatch a stopped run left 进行中 is queued with the unsent ones, in planning order; this run goes on with it where it stopped.
      const pickedUp = view.dispatches.filter(item => item.status === 'active' && queue.includes(item.id)).map(item => item.id);
      const run: CardRun = { id: randomUUID(), scope, ...(options.changeId ? { changeId: options.changeId } : {}), status: 'running', settings: chosen, queue, total: queue.length, ...(pickedUp.length ? { pickedUp } : {}), done: [], conversations: {}, autoAnswered: [], startedAt: stamp(), updatedAt: stamp() };
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
   * stopped turn, a refusal, failing tools or gaps the squad left. A dispatch the run carries on with gets
   * CONTINUE_LIMIT automatic rounds again.
   */
  resume(projectId: string): Promise<void> {
    return this.exclusive(projectId, async () => {
      const run = this.project(projectId).cardRun;
      if (!run || run.status !== 'paused') throw new Error('这张卡没有暂停中的一键制作。');
      const previous = structuredClone(run);
      const reason = run.pause?.reason;
      run.status = 'running'; delete run.pause;
      // 继续 is the user looking: a dispatch the run carries on with gets CONTINUE_LIMIT automatic rounds again.
      if (run.continued) run.continued = { ...run.continued, count: 0 };
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
        if (current.status === 'failed' || current.status === 'cancelled' || reason === 'refusal' || reason === 'tool-failures' || reason === 'incomplete') nudge = CONTINUE_TEXT;
        else if (reason === 'question') nudge = ACCEPT_ALL_TEXT;
        else if (reason === 'check-errors') run.current.stage = 'work';
      }
      if (nudge && current) {
        try { await this.send(projectId, run, current.id, nudge); }
        catch (error) { this.save(projectId, previous); throw error; }
        this.followChange(projectId, run, 'running');
        return;
      }
      this.save(projectId, run);
      this.followChange(projectId, run, 'running');
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
      this.followChange(projectId, run, 'paused', '一键制作已停止。点「继续跑」接着做还没做完的改动派单。');
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
      if (dispatch?.sectionId && (dispatch.status === 'todo' || carriedOn(run, dispatch))) {
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
        if (outcome.kind === 'incomplete') { this.halt(projectId, run, 'incomplete', outcome.text); return; }
        if (outcome.kind === 'question') {
          if (!run.settings.autoAnswer) { this.halt(projectId, run, 'question', outcome.text); return; }
          if (this.answeredEnough(run)) { this.halt(projectId, run, 'question', answerLimitMessage(outcome.text, this.rounds())); return; }
          run.autoAnswered.push({ dispatchId: run.current.dispatchId, text: outcome.text });
          if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
          await this.send(projectId, run, task.id, ACCEPT_ALL_TEXT);
          return;
        }
        const report = await this.studio.runChecks(projectId);
        // What the squad wrote during these turns is the dispatch's work too (spec §6.6).
        const squad = squadTools(task, squadOf(this.harness.store.state.tasks, task.id), run.current.sent);
        const errors = dispatchErrors(report, [...task.tools, ...squad], run.current.sent, project.path);
        if (errors.length) {
          const list = errors.slice(0, 8).map(finding => `${finding.message}${finding.path ? `（${finding.path}）` : ''}`).join('\n');
          if (run.current.stage === 'fix') { this.halt(projectId, run, 'check-errors', `修过一轮仍有错误：\n${list}`); return; }
          if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
          run.current.stage = 'fix';
          await this.send(projectId, run, task.id, fixPrompt(errors));
          return;
        }
        // 分批写 (ADR 0024): a reply that says the dispatch is not finished goes on with it; nothing is marked done.
        // Unless the user marked it done meanwhile: then it is finished, and the run moves on to the next one.
        if (outcome.kind === 'continue' && await this.carryOn(projectId, run, task)) return;
        const done = run.current.dispatchId;
        await this.studio.markDispatchDone(projectId, done);
        run.done.push(done); run.queue = run.queue.filter(id => id !== done); delete run.current; delete run.continued;
        this.save(projectId, run);
      }
    }

    if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return; }
    const view = await this.studio.reload(projectId);
    while (run.queue.length) {
      const dispatch = view.dispatches.find(item => item.id === run.queue[0]);
      // A dispatch the run was carrying on with is already 进行中; it goes on rather than out of the queue.
      const carrying = !!dispatch && carriedOn(run, dispatch);
      if (!dispatch?.sectionId || (dispatch.status !== 'todo' && !carrying)) { run.queue.shift(); continue; }
      let existing = run.conversations[dispatch.sectionId] ? this.task(run.conversations[dispatch.sectionId]) : undefined;
      // A dispatch an earlier run left 进行中 goes on in the conversation that holds it, which then is the run's conversation in its section.
      // With none left, `existing` stays as it is and the dispatch starts again in a new conversation, sent whole.
      if (carrying && run.pickedUp?.includes(dispatch.id)) {
        const holder = this.holderOf(projectId, dispatch);
        if (holder && holder.id !== existing?.id) { existing = holder; run.conversations[dispatch.sectionId] = holder.id; }
      }
      if (existing && !existing.archived) {
        // The user can write in the moment between two dispatches, and may even have a round of their own going.
        if (this.strays(run, existing).length) {
          this.halt(projectId, run, 'interjection', '你在对话里发了消息。看过这一轮的结果后点【继续】接着做。');
          return;
        }
        // A round of the user's own that 继续 already acknowledged: wait for it, `settled` comes back here.
        if (ACTIVE.has(existing.status) || existing.workerActive) return;
        if (this.pastThreshold(existing)) {
          run.handoff = { fromTaskId: existing.id, dispatchId: dispatch.id };
          this.save(projectId, run);
          await this.studio.requestHandoff(existing.id, { auto: true });
          return;
        }
        run.current = { dispatchId: dispatch.id, taskId: existing.id, stage: 'work', sent: [] };
        await this.send(projectId, run, existing.id, carrying ? CONTINUE_TEXT : formatDispatch(dispatch));
        return;
      }
      const task = await this.studio.startConversation({ projectId, sectionId: dispatch.sectionId, dispatchId: dispatch.id, title: dispatch.title, prompt: formatDispatch(dispatch), ...this.conversationSettings(run) });
      run.conversations[dispatch.sectionId] = task.id;
      run.current = { dispatchId: dispatch.id, taskId: task.id, stage: 'work', sent: this.userMessages(task.id) };
      this.remember(run, task.id, run.current.sent);
      this.save(projectId, run);
      return;
    }

    if (run.scope === 'all' || run.scope === 'change') {
      const report = await this.studio.runChecks(projectId);
      run.finalCheck = { errors: report.findings.filter(item => item.level === 'error').length, warnings: report.findings.filter(item => item.level === 'warning').length, at: stamp() };
    }
    run.status = 'completed'; run.finishedAt = stamp(); delete run.pause;
    this.save(projectId, run);
    if (run.changeId) await this.studio.finishChange(projectId, run.changeId, { errors: run.finalCheck?.errors ?? 0 }).catch(() => undefined);
    const check = run.finalCheck ? `，拼装检查 ${run.finalCheck.errors} 个错误、${run.finalCheck.warnings} 个警告` : '';
    const title = run.scope === 'all' ? this.say('Full run finished', '全部开做完成') : run.scope === 'change' ? this.say('Change order finished', '改动单做完了') : this.say('One-click making finished', '一键制作完成');
    this.emit('notify', { title, body: `${project.name}：做完 ${run.done.length} 条${run.scope === 'change' ? '改动' : ''}派单${check}。` });
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
    if (this.answeredEnough(run)) { this.halt(projectId, run, 'question', answerLimitMessage(text, this.rounds())); return; }
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
    this.followChange(projectId, run, 'paused', `${pauseLabel(reason, this.rounds()).zh}：${message}`);
    this.emit('notify', { title: this.say(`One-click making paused: ${pauseLabel(reason, this.rounds()).en}`, `一键制作已暂停：${pauseLabel(reason, this.rounds()).zh}`), body: `${this.project(projectId).name}：${message.split('\n')[0].slice(0, 120)}` });
  }

  /**
   * 分批写 (ADR 0024): the section AI wrote part of its dispatch and said so. The same conversation goes on with the same
   * dispatch, which stays unfinished. A pause asked for meanwhile comes first, and after CONTINUE_LIMIT automatic rounds
   * without the user pressing 继续 the run pauses, so a model that never says it is finished cannot run up requests.
   * Returns false, having sent nothing, when the user marked the dispatch done while the run was paused on it: there is
   * nothing left to carry on, and the caller finishes it like any delivered dispatch.
   */
  private async carryOn(projectId: string, run: CardRun, task: Task): Promise<boolean> {
    const current = run.current!;
    if (run.status === 'pausing') { this.halt(projectId, run, 'user', '已在这一轮结束后暂停。'); return true; }
    if ((await this.studio.reload(projectId)).dispatches.find(item => item.id === current.dispatchId)?.status === 'done') return false;
    const count = run.continued && run.continued.dispatchId === current.dispatchId ? run.continued.count : 0;
    const limit = this.rounds();
    if (count >= limit) { this.halt(projectId, run, 'continue-limit', '为了不一直自动接着做下去，先停在这里。看过对话里写到哪了，点【继续】接着做。'); return true; }
    run.continued = { dispatchId: current.dispatchId, count: count + 1 };
    // What the next rounds write is new: it gets a fix round of its own.
    current.stage = 'work';
    if (this.pastThreshold(task)) {
      // The rest goes to a new conversation with the summary and the dispatch, the way the next dispatch would.
      run.handoff = { fromTaskId: task.id, dispatchId: current.dispatchId };
      delete run.current;
      this.save(projectId, run);
      await this.studio.requestHandoff(task.id, { auto: true });
      return true;
    }
    await this.send(projectId, run, task.id, CONTINUE_TEXT);
    return true;
  }

  /**
   * Whether 自动按推荐 has answered the dispatch in hand as often as the run goes on by itself with one dispatch (CONTINUE_LIMIT,
   * the same as the automatic 继续): a section AI that keeps asking would be answered for ever, request after request.
   */
  private answeredEnough(run: CardRun): boolean {
    return run.autoAnswered.filter(item => item.dispatchId === run.current?.dispatchId).length >= this.rounds();
  }

  /** The conversation a 进行中 dispatch was sent in: the newest one in its section that holds it and is still there (not archived, not a squad member's or the change AI's). */
  private holderOf(projectId: string, dispatch: CardDispatch): Task | undefined {
    return this.harness.store.state.tasks
      .filter(task => task.projectId === projectId && !!task.card && !task.card.member && !task.card.changeId && !task.archived && task.card.sectionId === dispatch.sectionId && task.card.dispatchId === dispatch.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** Whether a conversation's context reached the threshold set in the studio settings. */
  private pastThreshold(task: Task): boolean {
    const threshold = handoffThresholdFor(
      task.contextWindow || task.contextUsage?.window || 0,
      this.harness.store.state.preferences.cardHandoff ?? DEFAULT_HANDOFF,
      this.optimization(),
    );
    if (threshold === null) return false;
    const used = task.contextUsage?.tokens ?? 0;
    return used > 0 && used >= threshold;
  }

  /** 制卡 Agent 优化; absent settings keep the shipped behavior. */
  private optimization(): CardAgentOptimization | undefined { return this.harness.studioPreferences()?.cardOptimization; }
  private rounds(): number { return continueRounds(this.optimization()); }

  private async send(projectId: string, run: CardRun, taskId: string, text: string): Promise<void> {
    await this.harness.prompt(taskId, text);
    const message = this.task(taskId)?.messages.findLast(item => item.role === 'user' && item.text === text.trim());
    if (message) { if (run.current) run.current.sent.push(message.id); this.remember(run, taskId, [message.id]); }
    this.save(projectId, run);
  }

  /** A change's run keeps its 改动单 in step: paused with the reason, or running again. Detached: the card file has its own queue. */
  private followChange(projectId: string, run: CardRun, status: 'running' | 'paused', note?: string): void {
    if (run.changeId) void this.studio.markChangeRun(projectId, run.changeId, status, note).catch(() => undefined);
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
