import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Harness } from './harness.ts';
import type { Task } from '../shared/types.ts';
import type { AttachmentInfo, CheckDefinition, CheckEvidence, DeliverySummary, LabReport, StudioPreferences, StudioState, TerminalView } from '../shared/studio-types.ts';
import { AttachmentService, listWorkspace, previewLocalFile, workspacePath } from './attachments.ts';
import { CheckpointService, type ReviewAction } from '../core/checkpoints.ts';
import { reviewCommentsPrompt } from '../core/review.ts';
import { SquadIntegrationService } from '../core/squad-integration.ts';
import { buildDelivery } from '../core/delivery.ts';
import { runChecks, type CheckRun } from './check-runner.ts';
import { runSandboxCommand } from '../runtime/sandbox-runner.ts';
import { TerminalService } from './terminal-service.ts';
import { probeConnection, benchmarkConnection } from './model-lab.ts';
import { validateAccessRule, ruleMatches } from './access-rules.ts';
import { UpdateService } from './updates.ts';

const defaults: StudioPreferences = { sandboxEnabled: true, defaultSquadSize: 6, teamTokenBudget: 0, teamMinutesBudget: 0, teamMoneyBudget: 0, roleModels: {}, updateFeed: '' };
const done = (task: Task) => ['idle', 'completed', 'failed', 'cancelled'].includes(task.status);
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;

export class StudioServices extends EventEmitter {
  readonly attachments: AttachmentService; readonly checkpoints: CheckpointService; readonly integrations: SquadIntegrationService; readonly terminal: TerminalService; readonly updates: UpdateService;
  readonly state: StudioState;
  private checks = new Map<string, CheckRun[]>(); private integrationReviews = new Map<string, { taskId: string; revision: string }>();
  private sealedReviews = new Map<string, Record<string, string | null>>();
  private directoryLocks = new Map<string, Promise<unknown>>(); private checkJobs = new Set<string>();
  private checkControllers = new Set<AbortController>();
  private shuttingDown = false;
  constructor(readonly dataDir: string, private harness: Harness, readonly helperPath: string, imageToPng: (buffer: Buffer) => Buffer) {
    super();
    this.attachments = new AttachmentService(dataDir, imageToPng); this.checkpoints = new CheckpointService(dataDir); this.integrations = new SquadIntegrationService(dataDir, { checkpoints: this.checkpoints });
    this.terminal = new TerminalService(helperPath); this.updates = new UpdateService(dataDir, '1.1.0');
    let saved: Partial<StudioState> = {};
    try { saved = JSON.parse(readFileSync(join(dataDir, 'studio.json'), 'utf8')); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid studio settings.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read studio.json. The original file has been preserved for recovery.', { cause: error }); }
    this.state = { preferences: { ...defaults, ...saved.preferences, roleModels: saved.preferences?.roleModels || {} }, rules: saved.rules || [], projectChecks: saved.projectChecks || {} };
  }
  snapshot(): StudioState { return structuredClone(this.state); }
  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true }); const temporary = join(this.dataDir, `.studio-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(this.state)); renameSync(temporary, join(this.dataDir, 'studio.json')); this.harness.publishStudio();
  }
  task(id: string): Task { const task = this.harness.store.state.tasks.find(task => task.id === id); if (!task) throw new Error('Task not found.'); return task; }
  private commandPolicy(task: Task) { const readOnly = !!(task.sharedReadOnly || task.planMode || this.harness.store.state.ecosystem.roles.find(role => role.id === task.role)?.readOnly); return { mode: readOnly || this.state.preferences.sandboxEnabled && task.permission !== 'full' ? 'sandbox' as const : 'host' as const, network: 'off' as const, readOnly }; }
  project(id: string) { const project = this.harness.store.state.projects.find(project => project.id === id); if (!project) throw new Error('Project not found.'); return project; }
  settings(changes: Partial<StudioPreferences>): void {
    const next = { ...this.state.preferences, ...changes };
    if (typeof next.sandboxEnabled !== 'boolean' || !Number.isInteger(next.defaultSquadSize) || next.defaultSquadSize < 1 || next.defaultSquadSize > 6) throw new Error('Choose 1–6 squad members.');
    for (const value of [next.teamTokenBudget, next.teamMinutesBudget, next.teamMoneyBudget]) if (!Number.isFinite(value) || value < 0) throw new Error('Budgets must be non-negative; zero means no limit.');
    if (next.updateFeed) { const url = new URL(next.updateFeed); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The update source must use HTTPS.'); }
    for (const [role, model] of Object.entries(next.roleModels)) { if (!role || !model || !['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(model.thinking)) throw new Error('Invalid role model choice.'); this.harness.connection(model.gatewayId, model.modelId); }
    if (next.teamMoneyBudget > 0) {
      const preferences = this.harness.store.state.preferences;
      const selected = [preferences.defaultGatewayId ? { gatewayId: preferences.defaultGatewayId, modelId: preferences.defaultModelId } : undefined, ...Object.values(next.roleModels)].filter(Boolean) as Array<{ gatewayId: string; modelId?: string }>;
      const prices = selected.map(model => this.harness.connection(model.gatewayId, model.modelId).gateway.pricing);
      if (!prices.length || prices.some(price => !price)) throw new Error('Configure model prices before enabling a money budget. Token and time budgets work without prices.');
      if (new Set(prices.map(price => price!.currency)).size !== 1) throw new Error('A money budget requires all squad model prices to use the same currency.');
    }
    this.state.preferences = next; this.persist();
  }
  async inputs(ids: string[] = []): Promise<Array<AttachmentInfo & { storedPath: string }>> {
    if (!Array.isArray(ids) || ids.length > 16) throw new Error('Attach at most 16 files.');
    const records = await Promise.all(ids.map(id => this.attachments.resolve(id)));
    if (records.reduce((total, file) => total + file.bytes, 0) > 80 * 1024 * 1024) throw new Error('Combined attachments exceed 80 MB.'); return records;
  }
  async beforeRun(task: Task, turnId: string): Promise<void> {
    if (task.sharedReadOnly) return;
    return this.exclusive(task.cwd, () => this.captureRun(task, turnId));
  }
  private async captureRun(task: Task, turnId: string): Promise<void> {
    const last = task.checkpointIds?.at(-1);
    if (last && (await this.checkpoints.get(last)).turnId === turnId) return;
    if (last && !await this.sealed(last)) await this.seal(last);
    const checkpoint = await this.checkpoints.capture(task.id, turnId, task.cwd);
    task.checkpointIds = [...(task.checkpointIds || []), checkpoint.id];
    task.delivery = { verification: 'not-run', checkpointId: checkpoint.id, changedFiles: 0, checks: [], updatedAt: new Date().toISOString() };
  }
  async afterRun(task: Task): Promise<void> {
    if (!task.delivery?.checkpointId) return;
    const review = await this.checkpoints.diff(task.delivery.checkpointId);
    await this.seal(task.delivery.checkpointId);
    task.delivery.changedFiles = review.files.length; task.delivery.updatedAt = new Date().toISOString();
    const configured = this.state.projectChecks[task.projectId] || [];
    if (task.status === 'completed' && review.files.length && configured.some(check => check.enabled && check.automatic)) await this.runTaskChecks(task.id, true);
    else this.harness.publishStudio();
  }
  private async seal(id: string): Promise<void> {
    const review = await this.checkpoints.diff(id); const files = Object.fromEntries(review.files.map(file => [file.path, file.afterHash]));
    this.sealedReviews.set(id, files); const folder = join(this.dataDir, 'review-ends'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, id + '.json'), JSON.stringify(files));
  }
  private async sealed(id: string): Promise<Record<string, string | null> | undefined> {
    const cached = this.sealedReviews.get(id); if (cached) return cached;
    try { const value = JSON.parse(await readFile(join(this.dataDir, 'review-ends', id + '.json'), 'utf8')); this.sealedReviews.set(id, value); return value; } catch { return undefined; }
  }
  private assertIdle(cwd: string, exceptId?: string): void {
    if (this.harness.snapshot().tasks.some(task => task.id !== exceptId && task.cwd.toLowerCase() === cwd.toLowerCase() && task.workerActive)) throw new Error('Stop agents using this folder before changing reviewed files.');
    if (this.terminal.list().some(session => session.cwd.toLowerCase() === cwd.toLowerCase() && ['starting', 'running'].includes(session.status))) throw new Error('Close the terminal in this folder before applying or reverting files.');
  }
  private async exclusive<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const key = resolve(cwd).toLowerCase(); const previous = this.directoryLocks.get(key) || Promise.resolve();
    const result = previous.catch(() => undefined).then(run); this.directoryLocks.set(key, result);
    try { return await result; } finally { if (this.directoryLocks.get(key) === result) this.directoryLocks.delete(key); }
  }
  directoryLocked(cwd: string): boolean { return this.directoryLocks.has(resolve(cwd).toLowerCase()); }
  async checkpointDiff(taskId: string, id?: string) {
    const task = this.task(taskId); const checkpointId = id || task.checkpointIds?.at(-1); if (!checkpointId) throw new Error('No file checkpoint is available for this task yet.');
    const checkpoint = await this.checkpoints.get(checkpointId); if (checkpoint.taskId !== taskId) throw new Error('Checkpoint belongs to another task.');
    const review = await this.checkpoints.diff(checkpointId); const sealed = await this.sealed(checkpointId);
    if (sealed) for (const file of review.files) if (!Object.hasOwn(sealed, file.path) || sealed[file.path] !== file.afterHash) file.note = 'This file changed after the agent run. Newer edits must be reviewed separately before reverting this checkpoint.';
    return { ...review, comments: await this.checkpoints.listComments(checkpointId) };
  }
  async reviewAction(taskId: string, input: ReviewAction) {
    const task = this.task(taskId); if (this.directoryLocked(task.cwd)) throw new Error('Wait for checks or the current file operation before reviewing changes.'); await this.checkpointDiff(taskId, input.checkpointId);
    if (this.directoryLocked(task.cwd)) throw new Error('Wait for checks or the current file operation before reviewing changes.');
    return this.exclusive(task.cwd, async () => {
      if (input.action === 'revert') { if (!done(task)) throw new Error('Stop the task before reverting files.'); this.assertIdle(task.cwd); }
      const sealed = await this.sealed(input.checkpointId);
      if (sealed && (!Object.hasOwn(sealed, input.path) || sealed[input.path] !== input.expectedHash)) throw new Error('This file has newer changes since the agent finished. They will not be overwritten; review or restore the newer checkpoint first.');
      const review = await this.checkpoints.reviewAction(input);
      if (sealed) { const remaining = review.files.find(file => file.path === input.path); sealed[input.path] = remaining ? remaining.afterHash : (await this.checkpoints.get(input.checkpointId)).files[input.path]?.hash ?? null; await writeFile(join(this.dataDir, 'review-ends', input.checkpointId + '.json'), JSON.stringify(sealed)); }
      if (task.delivery && input.action === 'revert') { task.delivery.verification = 'stale'; task.delivery.changedFiles = review.files.length; }
      this.harness.publishStudio(); return review;
    });
  }
  async comment(taskId: string, input: { checkpointId: string; path: string; line: number; text: string }) {
    await this.checkpointDiff(taskId, input.checkpointId); await this.checkpoints.addComment({ ...input, side: 'after' });
  }
  async applyComments(taskId: string): Promise<void> {
    const review = await this.checkpointDiff(taskId); const comments = await this.checkpoints.listComments(review.checkpointId);
    if (!comments.length) throw new Error('Add a review comment first.');
    await this.harness.prompt(taskId, reviewCommentsPrompt(comments));
  }
  saveChecks(projectId: string, checks: CheckDefinition[]): void {
    this.project(projectId); if (!Array.isArray(checks) || checks.length > 12 || checks.some(check => !check.id || !check.name.trim() || !check.command.trim() || check.command.length > 8000 || typeof check.enabled !== 'boolean')) throw new Error('Configure up to 12 named check commands.');
    this.state.projectChecks[projectId] = checks.map(check => ({ id: check.id, name: check.name, command: check.command, enabled: check.enabled, automatic: !!check.automatic })); this.persist();
  }
  async runTaskChecks(taskId: string, automatic = false): Promise<DeliverySummary> {
    if (this.shuttingDown) throw new Error('Checks are shutting down.');
    const task = this.task(taskId); if (this.checkJobs.has(taskId)) throw new Error('Checks are already running.');
    if (!done(task)) throw new Error('Wait for the agent before checking its changes.');
    if (this.directoryLocked(task.cwd)) throw new Error('This folder is busy with checks or a reviewed file operation.');
    this.assertIdle(task.cwd, automatic ? task.id : undefined);
    // Reserve synchronously, before capture/diff awaits permit a second request.
    this.checkJobs.add(taskId);
    const controller = new AbortController(); this.checkControllers.add(controller);
    try {
      return await this.exclusive(task.cwd, async () => {
        controller.signal.throwIfAborted();
        this.assertIdle(task.cwd, automatic ? task.id : undefined);
        // Already holding the cwd lease: calling beforeRun here would deadlock.
        if (!task.delivery?.checkpointId) await this.captureRun(task, 'manual-check');
        const ownedDelivery = task.delivery!; const checkpointId = ownedDelivery.checkpointId!;
        try {
          const review = await this.checkpointDiff(taskId, checkpointId);
          const configured = (this.state.projectChecks[task.projectId] || []).filter(check => check.enabled && (!automatic || check.automatic));
          if (!configured.length) throw new Error('Configure at least one project check.');
          controller.signal.throwIfAborted();
          ownedDelivery.verification = 'running'; ownedDelivery.error = undefined; ownedDelivery.checks = []; this.harness.publishStudio();
          const results = await runChecks({ cwd: task.cwd, revision: review.revision, changedPaths: review.files.map(file => file.path), checks: configured, force: !automatic, signal: controller.signal,
            execute: (command, cwd, onData, signal) => runSandboxCommand(command, cwd, { onData: chunk => onData(chunk.toString()), signal, helperPath: this.helperPath, policy: this.commandPolicy(task) }),
            onRun: run => { const rows = ownedDelivery.checks; const value: CheckEvidence = { id: run.id, name: run.name, command: run.command, status: run.status === 'timed-out' ? 'failed' : run.status, output: run.output + (run.error ? '\n' + run.error : ''), startedAt: run.startedAt, exitCode: run.exitCode, durationMs: run.durationMs }; const index = rows.findIndex(item => item.id === run.id); if (index < 0) rows.push(value); else rows[index] = value; this.harness.publishStudio(false); } });
          this.checks.set(taskId, results);
          const current = await this.checkpointDiff(taskId, checkpointId); const delivery = buildDelivery({ taskId, turnId: (await this.checkpoints.get(checkpointId)).turnId, execution: task.status === 'completed' ? 'completed' : 'failed', review: current, checks: results, configuredChecks: configured });
          ownedDelivery.verification = delivery.verification; ownedDelivery.changedFiles = current.files.length; ownedDelivery.updatedAt = new Date().toISOString();
          if (!current.files.length && results.length && results.every(run => run.status === 'passed' && run.revision === current.revision)) ownedDelivery.verification = 'passed';
          this.harness.publishStudio(); return ownedDelivery;
        } catch (error) {
          ownedDelivery.verification = 'failed'; ownedDelivery.error = error instanceof Error ? error.message : String(error); this.harness.publishStudio(); throw error;
        }
      });
    } finally { this.checkJobs.delete(taskId); this.checkControllers.delete(controller); this.harness.publishStudio(); }
  }
  async integrateSquad(taskId: string) {
    if (this.shuttingDown) throw new Error('Checks are shutting down.');
    const task = this.task(taskId); const project = this.project(task.projectId); const members = this.harness.store.state.tasks.filter(member => member.parentId === taskId && member.worktree && member.status === 'completed');
    if (!members.length) throw new Error('No completed member worktrees are available to integrate.');
    if ([project.path, ...members.map(member => member.cwd)].some(cwd => this.directoryLocked(cwd))) throw new Error('Wait for project and member checks before integrating.');
    this.assertIdle(project.path);
    for (const member of members) this.assertIdle(member.cwd);
    const integration = await this.integrations.prepare({ projectPath: project.path, baseCommit: members[0].worktree!.baseCommit, members: members.map(member => ({ taskId: member.id, name: member.agentName || member.title, cwd: member.cwd, baseCommit: member.worktree!.baseCommit })) });
    const configured = (this.state.projectChecks[task.projectId] || []).filter(check => check.enabled);
    if (integration.status === 'ready' && configured.length) {
      if (this.shuttingDown) throw new Error('Checks are shutting down.');
      const controller = new AbortController(); this.checkControllers.add(controller);
      try { await this.integrations.check(integration.id, configured, (command, cwd, onData, signal) => runSandboxCommand(command, cwd, { onData: chunk => onData(chunk.toString()), signal, helperPath: this.helperPath, policy: this.commandPolicy(task) }), controller.signal); }
      finally { this.checkControllers.delete(controller); }
    }
    const review = await this.integrations.review(integration.id); this.integrationReviews.set(integration.id, { taskId, revision: review.revision });
    return { integration: await this.integrations.get(integration.id), review };
  }
  async applyIntegration(taskId: string, integrationId: string) {
    const task = this.task(taskId); const project = this.project(task.projectId); const reviewed = this.integrationReviews.get(integrationId);
    if (!reviewed || reviewed.taskId !== taskId) throw new Error('Open and review this integration before applying it.');
    if (this.directoryLocked(project.path)) throw new Error('Wait for checks or the current file operation before applying the integration.');
    return this.exclusive(project.path, async () => {
      this.assertIdle(project.path); const integration = await this.integrations.get(integrationId);
      const required = (this.state.projectChecks[task.projectId] || []).filter(check => check.enabled);
      const latest = new Map(integration.checks.map(check => [check.checkId, check]));
      if (required.some(check => { const result = latest.get(check.id); return !result || result.command !== check.command || result.status !== 'passed' || result.revision !== reviewed.revision; }) || [...latest.values()].some(check => check.status !== 'passed' || check.revision !== reviewed.revision)) throw new Error('Integration checks are missing, failed or stale. Prepare and verify the current changes again before applying.');
      const result = await this.integrations.applyReviewed(integrationId, reviewed.revision); this.integrationReviews.delete(integrationId); return result;
    });
  }
  private workspaceRoot(projectId: string, taskId?: string): string { const project = this.project(projectId); if (!taskId) return project.path; const task = this.task(taskId); if (task.projectId !== projectId) throw new Error('Task and project do not match.'); return task.cwd; }
  workspaceFiles(projectId: string, path = '', query = '', taskId?: string) { return listWorkspace(this.workspaceRoot(projectId, taskId), path, query); }
  async previewFile(projectId: string, path: string, taskId?: string) { return previewLocalFile(await workspacePath(this.workspaceRoot(projectId, taskId), path)); }
  async importAttachments(paths: string[]) { if (!Array.isArray(paths) || paths.length > 16 || paths.some(path => typeof path !== 'string')) throw new Error('Select up to 16 files.'); return Promise.all(paths.map(path => this.attachments.importFile(path))); }
  attachReference(projectId: string, path: string, taskId?: string) { return this.attachments.reference(projectId, this.workspaceRoot(projectId, taskId), path); }
  probeModel(gatewayId: string, modelId: string, capabilities: string[]) { return probeConnection(this.harness.connection(gatewayId, modelId), capabilities); }
  benchmarkCache(gatewayId: string, modelId: string) { return benchmarkConnection(this.harness.connection(gatewayId, modelId)); }
  grantRule(input: Parameters<typeof validateAccessRule>[0]): void { this.project(input.projectId); if (input.taskId && this.task(input.taskId).projectId !== input.projectId) throw new Error('Permission task and project do not match.'); this.state.rules.push(validateAccessRule(input)); this.persist(); }
  revokeRule(id: string): void { this.state.rules = this.state.rules.filter(rule => rule.id !== id); this.persist(); }
  allows(task: Task, kind: Parameters<typeof ruleMatches>[3], target: string): boolean { return ruleMatches(this.state.rules, task.projectId, task.id, kind, target); }
  validateBudgetModel(task: Task): void {
    if (!this.state.preferences.teamMoneyBudget) return;
    const model = this.harness.connection(task.gatewayId, task.modelId).gateway;
    const parent = task.parentId ? this.task(task.parentId) : task;
    const lead = this.harness.connection(parent.gatewayId, parent.modelId).gateway;
    if (!model.pricing || !lead.pricing || model.pricing.currency !== lead.pricing.currency) throw new Error('Configure matching model price currencies for the active money budget before starting this member.');
  }
  async openTerminal(taskId: string): Promise<TerminalView> { const task = this.task(taskId); if (this.shuttingDown) throw new Error('Terminals are shutting down.'); if (this.directoryLocked(task.cwd)) throw new Error('Wait for checks or the reviewed file operation before opening a terminal.'); const existing = this.terminal.list().find(item => item.taskId === taskId && item.status === 'running'); if (existing) return this.terminalView(existing); const opened = await this.terminal.open(taskId, task.cwd, { policy: this.commandPolicy(task) }); return this.terminalView(opened); }
  private terminalView(value: ReturnType<TerminalService['list']>[number]): TerminalView { return { id: value.id, taskId: value.taskId, status: value.status === 'running' ? 'running' : 'closed', output: value.output, columns: 100, rows: 28 }; }
  terminalState(id: string): TerminalView { const terminal = this.terminal.list().find(item => item.id === id); if (!terminal) throw new Error('Terminal not found.'); return this.terminalView(terminal); }
  async evaluateTasks(gatewayId: string, modelId: string): Promise<LabReport> {
    this.harness.connection(gatewayId, modelId);
    const report: LabReport = { id: randomUUID(), kind: 'tasks', status: 'running', rows: [], summary: '' };
    const cases = [
      { name: 'Arithmetic repair', files: { 'solution.cjs': 'exports.add = (a,b) => a-b;\n' }, prompt: 'Fix solution.cjs so exports.add correctly adds two numbers. Preserve the CommonJS export. Check your change.', oracle: `const m=require('./solution.cjs'); for(const [a,b] of [[2,3],[-5,8],[0,0],[2.5,1.25]]) if(m.add(a,b)!==a+b) process.exit(1);` },
      { name: 'Cross-file dependency', files: { 'config.cjs': 'exports.factor=3;\n', 'solution.cjs': "const {factor}=require('./config.cjs'); exports.scale=x=>x+factor;\n" }, prompt: 'Fix exports.scale in solution.cjs to multiply by the factor exported from config.cjs. Preserve the factor and exports.', oracle: `const m=require('./solution.cjs'); for(const x of [-2,0,2,2.5]) if(m.scale(x)!==x*3) process.exit(1);` },
    ];
    for (let index = 0; index < cases.length; index++) {
      const value = cases[index]; const cwd = join(this.dataDir, 'evaluations', report.id, String(index)); await mkdir(cwd, { recursive: true });
      for (const [name, text] of Object.entries(value.files)) await writeFile(join(cwd, name), text);
      const project = await this.harness.addProject(cwd); const started = Date.now();
      let taskId: string | undefined;
      try {
        const created = await this.harness.createTask({ projectId: project.id, gatewayId, modelId, prompt: value.prompt + '\nUse read/edit/write tools. Cardwright runs an independent test after you finish.', title: `Evaluation · ${value.name}`, permission: 'edit', thinking: 'medium', isolated: false });
        taskId = created.id;
        const settled = () => { const task = this.harness.publicView().tasks.find(task => task.id === created.id); return task && done(task) && !task.workerActive; };
        while (!settled() && Date.now() - started < 180000) await new Promise(resolve => setTimeout(resolve, 250));
        if (!settled()) { await this.harness.cancelTask(created.id); throw new Error('The evaluation exceeded its three-minute time limit.'); }
        const task = this.task(created.id);
        if (task.status !== 'completed') throw new Error(task.error || `The agent ended with status ${task.status}.`);
        let output = ''; const check = await runSandboxCommand(`node -e ${ps(value.oracle)}`, cwd, { helperPath: this.helperPath, policy: { mode: 'sandbox', network: 'off', readOnly: true, writeRoots: [] }, onData: chunk => { output += chunk.toString(); }, timeout: 20 });
        report.rows.push({ task: value.name, taskId: task.id, status: check.exitCode === 0 ? 'passed' : 'failed', elapsedMs: Date.now() - started, tokens: task.messages.reduce((total, message) => total + (message.usage ? message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : 0), 0), detail: output.slice(-2000) || `Independent check exit code: ${check.exitCode}` });
      } catch (error) {
        report.rows.push({ task: value.name, taskId: taskId || '', status: 'failed', elapsedMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    report.status = 'completed'; report.summary = `${report.rows.filter(row => row.status === 'passed').length}/${report.rows.length} representative coding tasks passed. This is a small repeatable suite, not a general model ranking.`; return report;
  }
  stopChecks(): void { this.shuttingDown = true; for (const controller of this.checkControllers) controller.abort(); }
  resumeAfterFailedUpdate(): void { if (this.checkJobs.size || this.checkControllers.size) throw new Error('Wait for checks to stop before reopening the workspace.'); this.terminal.resumeAfterFailedUpdate(); this.shuttingDown = false; }
  async close(): Promise<void> { this.stopChecks(); await this.terminal.closeAll(); while (this.checkJobs.size || this.checkControllers.size) await new Promise(resolve => setTimeout(resolve, 20)); }
}
