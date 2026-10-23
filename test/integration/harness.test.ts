import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { AppStore } from '../../src/core/store.ts';
import { DREAMER_ROLE } from '../../src/core/ecosystem.ts';
import { Harness } from '../../src/main/harness.ts';
import { StudioServices } from '../../src/main/studio-services.ts';
import { Vault, type SecretCodec } from '../../src/main/vault.ts';
import type { Gateway, NewSchedule, NewTask, Preferences, Task } from '../../src/shared/types.ts';

const fakeWorker = fileURLToPath(new URL('../fixtures/fake-worker.mjs', import.meta.url));
const exec = promisify(execFile);
const harnesses = new Map<string, Harness>();
const codec: SecretCodec = {
  encrypt: value => Buffer.from(`fixture-codec:${value}`),
  decrypt: value => value.toString().slice('fixture-codec:'.length),
};
const fixtureKey = 'fixture-key-never-a-real-credential';
const gateway: Omit<Gateway, 'hasKey'> = {
  id: 'fixture', name: 'Fixture', baseUrl: 'https://example.invalid/v1', modelId: 'fixture',
  protocol: 'openai-completions', reasoning: false, contextWindow: 8192, maxTokens: 1024,
};

async function temp(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-harness-test-'));
  t.after(async () => {
    await harnesses.get(directory)?.close();
    harnesses.delete(directory);
    const within = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(within.startsWith('cardwright-harness-test-') && !within.includes('..'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

async function setup(t: TestContext, concurrency = 1) {
  const root = await temp(t);
  const directory = join(root, 'data');
  const vault = new Vault(directory, codec);
  const harness = new Harness(directory, fakeWorker, vault);
  harness.saveGateway(gateway, fixtureKey);
  harness.savePreferences({ maxConcurrent: concurrency });
  harnesses.set(root, harness);
  return { root, directory, vault, harness };
}

/** The harness with the workbench services attached, as the app runs it: checkpoints, checks and squad settings. Discovery reads an empty home. `saved` is a studio.json already on disk, as a hand-edited one would be. */
async function setupWithStudio(t: TestContext, concurrency = 3, saved?: unknown) {
  await skillHome(t);
  const context = await setup(t, concurrency);
  if (saved !== undefined) { await mkdir(context.directory, { recursive: true }); await writeFile(join(context.directory, 'studio.json'), JSON.stringify(saved)); }
  const studio = new StudioServices(context.directory, context.harness, resolve('dist/Cardwright.CommandHost.exe'), buffer => buffer);
  context.harness.attachStudio(studio);
  return { ...context, studio };
}

/** Discovery reads ~/.claude and ~/.agents; a temp home keeps a developer's own subagents and skills out of a test. Call it before `setup`, whose Harness already reads the home once while it is built. */
async function skillHome(t: TestContext): Promise<string> {
  const home = await temp(t);
  const previous = process.env.CARDWRIGHT_SKILL_HOME;
  process.env.CARDWRIGHT_SKILL_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CARDWRIGHT_SKILL_HOME; else process.env.CARDWRIGHT_SKILL_HOME = previous; });
  return home;
}

async function project(harness: Harness, root: string, name: string, isGit = false) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  if (isGit) {
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'core.autocrlf', 'false']]) {
      await exec('git', args, { cwd: path, windowsHide: true });
    }
    await writeFile(join(path, 'README.md'), 'Fixture repository.\n');
    await exec('git', ['add', 'README.md'], { cwd: path, windowsHide: true });
    await exec('git', ['commit', '-m', 'Fixture base'], { cwd: path, windowsHide: true });
  }
  return harness.addProject(path);
}

/** Discovery reads ~/.claude/agents; these tests point it at an empty folder so the developer's own subagents never leak in. */
async function quietHome(t: TestContext, root: string): Promise<string> {
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const previous = process.env.CARDWRIGHT_SKILL_HOME;
  process.env.CARDWRIGHT_SKILL_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CARDWRIGHT_SKILL_HOME; else process.env.CARDWRIGHT_SKILL_HOME = previous; });
  return home;
}

/** A Claude Code subagent file. Without a `tools:` line it keeps every tool, so it is a writing subagent. */
async function writeAgent(directory: string, name: string, description: string, extra: string[] = [], body = '照文件里写的做。'): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), ['---', `name: ${name}`, `description: ${description}`, ...extra, '---', '', body, ''].join('\n'));
}

type Outcome = { ok?: boolean; error?: string; result?: unknown };
/** The fake lead's script: each step is one request it sends to the app, in order (see test/fixtures/fake-worker.mjs). */
const leadScript = (steps: Array<{ method: string; args: Record<string, unknown> }>) => `script:${JSON.stringify(steps)}`;
/** One squad member as the lead's worker sends it to the app. */
const squadMember = (name: string, prompt: string, role?: string) => ({ name, prompt, ...(role ? { role } : {}) });
/** What the fake lead reports once its script has run. */
const scriptOutcomes = (harness: Harness, id: string): Outcome[] => JSON.parse(current(harness, id).messages.at(-1)?.text.slice('script:'.length) || '[]');

async function until(condition: () => boolean, description: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
}

function current(harness: Harness, id: string): Task {
  const result = harness.snapshot().tasks.find(task => task.id === id);
  assert.ok(result);
  return result;
}

function scheduleInput(projectId: string, overrides: Partial<NewSchedule> = {}): NewSchedule {
  return {
    name: 'Fixture schedule', projectId, prompt: 'complete', gatewayId: 'fixture',
    thinking: 'medium', permission: 'ask', isolated: false,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), intervalMinutes: 60, ...overrides,
  };
}

test('harness enforces concurrency and queued cancellation, then records real worker IPC usage', async t => {
  const { root, harness } = await setup(t);
  const firstProject = await project(harness, root, 'first');
  const secondProject = await project(harness, root, 'second');
  const first = await harness.createTask({ projectId: firstProject.id, isolated: false, prompt: 'hold' });
  await until(() => current(harness, first.id).tools.length === 1, 'first task running');
  const second = await harness.createTask({ projectId: secondProject.id, isolated: false, prompt: 'complete' });
  assert.equal(current(harness, second.id).status, 'queued');
  assert.equal(harness.snapshot().tasks.filter(task => task.status === 'running').length, 1);
  await harness.cancelTask(second.id);
  assert.equal(current(harness, second.id).status, 'cancelled');
  await harness.prompt(first.id, 'release', 'followUp');
  await until(() => current(harness, first.id).status === 'completed', 'first task completes');
  assert.equal(current(harness, second.id).status, 'cancelled');
  await harness.prompt(second.id, 'complete');
  await until(() => current(harness, second.id).status === 'completed', 'resumed task completes');
  const assistant = current(harness, second.id).messages.find(message => message.role === 'assistant');
  assert.equal(assistant?.text, 'Fixture completed.');
  assert.deepEqual(assistant?.usage, { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, cost: 0 });
});

test('a first turn stopped before its reply was finished leaves no session behind, and the next message starts a new one', async t => {
  // Pi writes a session file only once the first reply is finished; a worker stopped the hard way before that left the
  // task pointing into a file that was never written, and every later message failed.
  const { root, harness } = await setup(t);
  const target = await project(harness, root, 'unsaved');
  const started = await harness.createTask({ projectId: target.id, isolated: false, prompt: 'unsaved' });
  await until(() => current(harness, started.id).messages.some(message => message.role === 'assistant'), 'the reply being written');
  assert.equal(current(harness, started.id).sessionLeafId, 'fixture-unsaved-entry');
  await harness.cancelTask(started.id);
  await until(() => current(harness, started.id).status === 'cancelled' && !current(harness, started.id).workerActive, 'the stopped worker');
  const stopped = current(harness, started.id);
  assert.deepEqual([stopped.sessionFile, stopped.sessionLeafId, stopped.messages[0].sessionEntryId], [undefined, undefined, undefined]);
  await harness.prompt(started.id, 'complete');
  await until(() => ['completed', 'failed'].includes(current(harness, started.id).status), 'the next message');
  assert.equal(current(harness, started.id).status, 'completed', current(harness, started.id).error);
});

test('a task an older version left pointing into a session file that was never written recovers after one refused run', async t => {
  const { root, directory, vault, harness } = await setup(t);
  const target = await project(harness, root, 'stuck');
  const created = await harness.createTask({ projectId: target.id, isolated: false, prompt: 'complete' });
  await until(() => current(harness, created.id).status === 'completed' && !current(harness, created.id).workerActive, 'the first turn');
  await harness.close();
  harnesses.delete(root);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { tasks: Task[] };
  Object.assign(state.tasks.find(task => task.id === created.id)!, { sessionFile: join(directory, 'sessions', created.id, 'never-written.jsonl'), sessionLeafId: 'entry-only-in-memory' });
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  const reopened = new Harness(directory, fakeWorker, vault);
  harnesses.set(root, reopened);
  await reopened.prompt(created.id, 'complete');
  await until(() => current(reopened, created.id).status === 'failed' && !current(reopened, created.id).workerActive, 'the refused run');
  assert.match(current(reopened, created.id).error ?? '', /missing a saved entry/);
  await reopened.prompt(created.id, 'complete');
  await until(() => ['completed', 'failed'].includes(current(reopened, created.id).status) && !current(reopened, created.id).workerActive, 'the next run');
  assert.equal(current(reopened, created.id).status, 'completed', current(reopened, created.id).error);
});

test('a message that never went out stops showing as queued once its task is cancelled or interrupted', async t => {
  const { root, directory, vault, harness } = await setup(t);
  const holding = await project(harness, root, 'holding');
  const waitingProject = await project(harness, root, 'waiting');
  const interruptedProject = await project(harness, root, 'interrupted');
  const first = await harness.createTask({ projectId: holding.id, isolated: false, prompt: 'hold' });
  await until(() => current(harness, first.id).tools.length === 1, 'first task running');
  const cancelled = await harness.createTask({ projectId: waitingProject.id, isolated: false, prompt: 'never sent' });
  assert.equal(current(harness, cancelled.id).messages[0]?.pending, true);
  await harness.cancelTask(cancelled.id);
  assert.equal(current(harness, cancelled.id).messages[0]?.pending, false);
  await harness.prompt(first.id, 'release', 'followUp');
  await until(() => current(harness, first.id).status === 'completed', 'first task completes');
  await harness.prompt(cancelled.id, 'complete');
  await until(() => current(harness, cancelled.id).status === 'completed', 'the cancelled task taking a new message');
  assert.deepEqual(current(harness, cancelled.id).messages.map(message => message.text), ['never sent', 'complete', 'Fixture completed.']);
  await harness.prompt(first.id, 'hold');
  await until(() => current(harness, first.id).status === 'running', 'first task holding again');
  const interrupted = await harness.createTask({ projectId: interruptedProject.id, isolated: false, prompt: 'never sent either' });
  assert.equal(current(harness, interrupted.id).status, 'queued');
  await harness.close();
  harnesses.delete(root);
  const reopened = new Harness(directory, fakeWorker, vault);
  harnesses.set(root, reopened);
  assert.equal(current(reopened, interrupted.id).status, 'failed');
  assert.equal(current(reopened, interrupted.id).messages[0]?.pending, false);
});

test('closing the app stops a follow-up the agent never took from showing as queued', async t => {
  const { root, directory, vault, harness } = await setup(t);
  const folder = await project(harness, root, 'slow');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'RUN:slow' });
  await until(() => current(harness, task.id).status === 'running' && current(harness, task.id).messages[0]?.pending === false, 'the slow turn');
  await harness.prompt(task.id, 'later', 'followUp');
  assert.equal(current(harness, task.id).messages.at(-1)?.pending, true);
  await harness.close();
  harnesses.delete(root);
  const reopened = new Harness(directory, fakeWorker, vault);
  harnesses.set(root, reopened);
  assert.equal(current(reopened, task.id).messages.find(message => message.text === 'later')?.pending, false);
});

test('/init updates the instruction file a project has, or writes CLAUDE.md', async t => {
  const { root, harness } = await setup(t, 3);
  const withAgents = await project(harness, root, 'with-agents');
  await writeFile(join(root, 'with-agents', 'AGENTS.md'), '# Agents' + '\n');
  const withClaude = await project(harness, root, 'with-claude');
  await writeFile(join(root, 'with-claude', 'CLAUDE.md'), '# Claude' + '\n');
  const bare = await project(harness, root, 'bare');
  const sent = async (projectId: string) => {
    const task = await harness.createTask({ projectId, isolated: false, prompt: 'complete' });
    await until(() => current(harness, task.id).status === 'completed', 'the first turn');
    await harness.command(task.id, '/init');
    await until(() => current(harness, task.id).status === 'completed', 'the /init turn');
    return current(harness, task.id).messages.filter(message => message.role === 'user').at(-1)!.text;
  };
  assert.match(await sent(withAgents.id), /更新 `AGENTS\.md`/);
  assert.match(await sent(withClaude.id), /更新 `CLAUDE\.md`/);
  assert.match(await sent(bare.id), /新建 `CLAUDE\.md`/);
  await assert.rejects(harness.command((await harness.createTask({ projectId: bare.id, isolated: false, prompt: 'complete' })).id, '/nonsense'), /not available/);
});

test('approval is scoped to its pending ID and denial reaches the worker as boolean false', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'approval');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'approve' });
  await until(() => harness.snapshot().approvals.length === 1, 'approval');
  const approval = harness.snapshot().approvals[0]!;
  assert.equal(approval.taskId, task.id);
  assert.equal(current(harness, task.id).status, 'waiting');
  assert.throws(() => harness.approve('not-pending', true), /no longer pending/);
  assert.throws(() => harness.approve(approval.id, 'yes' as unknown as boolean), /explicit/);
  harness.approve(approval.id, false);
  await until(() => current(harness, task.id).status === 'completed', 'denied tool handled');
  assert.equal(current(harness, task.id).messages.at(-1)?.text, 'approval:boolean:false');
  assert.equal(current(harness, task.id).tools[0]?.status, 'failed');
  assert.equal(harness.snapshot().approvals.length, 0);
  assert.throws(() => harness.approve(approval.id, true), /no longer pending/);
});

test('worker failures and process crashes fail tasks and redact gateway credentials', async t => {
  const { root, directory, harness } = await setup(t);
  const folder = await project(harness, root, 'failure');
  const failed = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'error' });
  await until(() => current(harness, failed.id).status === 'failed', 'worker failure');
  assert.match(current(harness, failed.id).error ?? '', /Fixture failed: \[redacted\]/);
  const crashed = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'crash' });
  await until(() => current(harness, crashed.id).status === 'failed', 'process crash');
  assert.match(current(harness, crashed.id).error ?? '', /Fixture crashed: \[redacted\]/);
  assert.ok(!(await readFile(join(directory, 'state.json'), 'utf8')).includes(fixtureKey));
});

test('active task cancellation clears pending approval and reaches cancelled state', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'cancellation');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'approve' });
  await until(() => harness.snapshot().approvals.length === 1, 'approval before cancel');
  await harness.cancelTask(task.id);
  await until(() => current(harness, task.id).status === 'cancelled', 'cancelled state');
  assert.equal(harness.snapshot().approvals.length, 0);
});

test('parent wait releases its concurrency slot so an isolated child can run', async t => {
  const { root, harness } = await setup(t, 1);
  const folder = await project(harness, root, 'delegation', true);
  const parent = await harness.createTask({ projectId: folder.id, isolated: true, prompt: 'delegate-hold' });
  await until(() => harness.snapshot().tasks.some(task => task.parentId === parent.id && task.tools.length > 0), 'child runs while parent waits');
  const child = harness.snapshot().tasks.find(task => task.parentId === parent.id)!;
  assert.equal(current(harness, parent.id).status, 'waiting');
  assert.equal(child.status, 'running');
  assert.ok(child.worktree);
  assert.notEqual(child.cwd, parent.cwd);
  await harness.prompt(child.id, 'release', 'followUp');
  await until(() => current(harness, parent.id).status === 'completed', 'parent receives child summary');
  assert.match(current(harness, parent.id).messages.at(-1)?.text ?? '', /children:.*completed/);
});

test('squad members in a folder without Git share it, run together and can write', async t => {
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'plain-folder');
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'team:hold' });
  await until(() => harness.snapshot().tasks.filter(task => task.parentId === lead.id && task.status === 'running' && task.tools.length > 0).length === 2, 'both members running beside the lead');
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  for (const member of members) {
    assert.equal(member.sharedWorkspace, true);
    assert.equal(member.sharedReadOnly, false);
    assert.equal(member.role, 'executor');
    assert.equal(member.cwd, current(harness, lead.id).cwd);
    assert.equal(member.worktree, undefined);
  }
  for (const member of members) await harness.prompt(member.id, 'release', 'followUp');
  await until(() => current(harness, lead.id).status === 'completed', 'lead collects both members');
  const inspecting = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'team:inspect-init' });
  await until(() => current(harness, inspecting.id).status === 'completed', 'lead collects the reports');
  for (const member of harness.snapshot().tasks.filter(task => task.parentId === inspecting.id)) {
    const report = JSON.parse(member.messages.at(-1)?.text ?? '{}');
    assert.deepEqual({ readOnly: report.readOnly, planMode: report.planMode, sharedWorkspace: report.sharedWorkspace }, { readOnly: false, planMode: false, sharedWorkspace: true }, JSON.stringify(report));
  }
});

test('/compact reaches the worker as the built-in command, even beside a skill of the same name', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'compact-project');
  await mkdir(join(folder.path, '.claude', 'skills', 'compact'), { recursive: true });
  await writeFile(join(folder.path, '.claude', 'skills', 'compact', 'SKILL.md'), '---\nname: compact\ndescription: A project skill whose name clashes with the command\n---\nDo something else.');
  harness.refreshSkills();
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete' });
  await until(() => current(harness, task.id).status === 'completed', 'first run');
  await harness.command(task.id, '/compact');
  await until(() => current(harness, task.id).status === 'completed' && current(harness, task.id).messages.at(-1)?.text === 'Echo: /compact', 'the command reaches the worker unchanged');
});

test('planning leads and read-only roles still get read-only members in a folder without Git', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'plain-readonly');
  harness.saveAgentRole({ id: 'reviewer', name: 'Reviewer', prompt: 'Review only.', readOnly: true });
  for (const input of [{ planMode: true }, { role: 'reviewer' }]) {
    const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'team:inspect-init', ...input });
    await until(() => current(harness, lead.id).status === 'completed', `lead ${JSON.stringify(input)} collects its members`);
    const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
    assert.equal(members.length, 2);
    for (const member of members) {
      assert.equal(member.sharedReadOnly, true);
      assert.ok(!member.sharedWorkspace);
      assert.equal(member.role, 'executor', 'the member keeps the subagent it was sent as');
      assert.equal(member.readOnly, true);
      assert.equal(JSON.parse(member.messages.at(-1)?.text ?? '{}').readOnly, true);
    }
  }
});

test('a member that runs a read-only subagent keeps that subagent’s instructions and stays read-only', async t => {
  const { root, harness } = await setup(t, 3);
  await quietHome(t, root);
  const folder = await project(harness, root, 'plain-reviewers');
  harness.saveAgentRole({ id: 'reviewer', name: 'Reviewer', prompt: 'Review only.', readOnly: true });
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲队员', 'inspect-init', 'reviewer'), squadMember('乙队员', 'inspect-init', 'reviewer')] } },
    { method: 'wait', args: {} },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead collects its reviewers');
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.equal(members.length, 2, JSON.stringify(scriptOutcomes(harness, lead.id)));
  for (const item of members) {
    assert.equal(item.role, 'reviewer', 'not swapped for the built-in explorer');
    assert.equal(item.readOnly, true);
    assert.equal(item.sharedReadOnly, true);
    const report = JSON.parse(item.messages.at(-1)?.text ?? '{}');
    assert.equal(report.rolePrompt, 'Review only.');
    assert.equal(report.readOnly, true);
  }
  // Read-only is for good: the member may propose a plan, never carry it out itself.
  const target = harness.store.state.tasks.find(task => task.id === members[0].id)!;
  target.plan = { text: 'Fix it.', status: 'pending' };
  await assert.rejects(harness.approvePlan(target.id), /只读/);
});

test('a lead running a read-only subagent from its project folder sends read-only members', async t => {
  const { root, harness } = await setup(t, 3);
  await quietHome(t, root);
  const folder = await project(harness, root, 'plain-reader');
  await writeAgent(join(folder.path, '.claude', 'agents'), 'reader', '只读的项目子代理', ['tools: Read, Grep']);
  harness.refreshSkills();
  const readerId = `agent:project:${folder.id}:reader`;
  harness.setAgentEnabled(readerId, true);
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'team:inspect-init', role: readerId });
  await until(() => current(harness, lead.id).status === 'completed', 'the reader collects its members');
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.equal(members.length, 2);
  for (const item of members) {
    assert.equal(item.readOnly, true);
    assert.equal(JSON.parse(item.messages.at(-1)?.text ?? '{}').readOnly, true);
  }
});

test('a squad with one unknown subagent starts no one, and the lead hears which ones exist', async t => {
  const { root, harness } = await setup(t, 3);
  await quietHome(t, root);
  const folder = await project(harness, root, 'plain-unknown-role');
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲队员', 'hold'), squadMember('乙队员', 'hold', 'nobody')] } },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the refused squad');
  const [outcome] = scriptOutcomes(harness, lead.id);
  assert.match(outcome.error ?? '', /没有可用的子代理「nobody」/);
  assert.match(outcome.error ?? '', /executor/);
  assert.equal(harness.snapshot().tasks.filter(task => task.parentId === lead.id).length, 0);
});

test('a project folder’s subagents stay off until turned on; the user’s own stay on until turned off', async t => {
  const { root, directory, vault, harness } = await setup(t);
  const home = await quietHome(t, root);
  await writeAgent(join(home, '.claude', 'agents'), 'helper', '用户目录里的帮手');
  const folder = await project(harness, root, 'project-agents');
  await writeAgent(join(folder.path, '.agents', 'agents'), 'reviewer', '项目里带的审查员');
  harness.refreshSkills();
  const fileId = `agent:project:${folder.id}:reviewer`;
  const role = (id: string, owner = harness) => owner.roles(folder.id).find(item => item.id === id);
  assert.equal(role(fileId)?.enabled, false, 'off until the user turns it on');
  assert.equal(role('agent:user:helper')?.enabled, true, 'the user’s own folder is trusted');
  harness.setAgentEnabled(fileId, true);
  assert.equal(role(fileId)?.enabled, true);
  assert.deepEqual(harness.snapshot().preferences.enabledAgentIds, [fileId]);
  harness.setAgentEnabled('agent:user:helper', false);
  assert.deepEqual(harness.snapshot().preferences.disabledAgentIds, ['agent:user:helper']);
  assert.deepEqual(harness.snapshot().preferences.enabledAgentIds, [fileId], 'turning a user subagent off leaves the project list alone');
  assert.throws(() => harness.savePreferences({ enabledAgentIds: 'all' as never }), /子代理/);
  assert.throws(() => harness.savePreferences({ disabledAgentIds: [42] as never }), /子代理/);
  await harness.close();
  harnesses.delete(root);
  const reopened = new Harness(directory, fakeWorker, vault);
  harnesses.set(root, reopened);
  assert.equal(role(fileId, reopened)?.enabled, true, 'the choice survives a restart');
  reopened.setAgentEnabled(fileId, false);
  assert.equal(role(fileId, reopened)?.enabled, false);
  assert.deepEqual(reopened.snapshot().preferences.enabledAgentIds, []);
});

test('every subagent that is on can start a task, and the lead is told about each one', async t => {
  const { root, harness } = await setup(t, 2);
  await quietHome(t, root);
  const folder = await project(harness, root, 'roles');
  await writeAgent(join(folder.path, '.claude', 'agents'), 'reviewer', '审查改动');
  harness.refreshSkills();
  harness.saveAgentRole({ id: 'tester', name: '测试员', prompt: 'Run the tests.', readOnly: false });
  const fileId = `agent:project:${folder.id}:reviewer`;
  const report = async (input: Partial<NewTask>) => {
    const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'inspect-init', ...input });
    await until(() => current(harness, task.id).status === 'completed' && !current(harness, task.id).workerActive, `the report of ${JSON.stringify(input)}`);
    return JSON.parse(current(harness, task.id).messages.at(-1)?.text ?? '{}');
  };
  const before = await report({});
  assert.ok(before.roles.includes('tester'), 'a subagent made in settings is listed');
  assert.ok(!before.roles.includes('reviewer'), 'a project file that is off is not');
  await assert.rejects(harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete', role: fileId }), /子代理「reviewer」已关闭/);
  harness.setAgentEnabled(fileId, true);
  const after = await report({ role: fileId });
  assert.equal(after.role, fileId, 'a discovered subagent runs as itself');
  assert.ok(after.roles.includes('reviewer'), 'listed by the name Claude Code uses');
  assert.ok(!after.roles.some((id: string) => id.startsWith('agent:')));
  assert.equal((await report({ role: 'reviewer' })).role, fileId, 'and it can be asked for by that name');
});

test('cancelling a parent during child admission cannot leave an active orphan child', async t => {
  const { root, harness } = await setup(t, 1);
  const folder = await project(harness, root, 'cancel-delegation', true);
  const parent = await harness.createTask({ projectId: folder.id, isolated: true, prompt: 'delegate-hold' });
  await until(() => current(harness, parent.id).tools.some(tool => tool.name === 'delegate_task'), 'delegation begins');
  await harness.cancelTask(parent.id);
  await until(() => current(harness, parent.id).status === 'cancelled', 'parent cancellation');
  // Git worktree admission consists of several subprocesses and can still be settling.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200));
  const children = harness.snapshot().tasks.filter(task => task.parentId === parent.id);
  assert.ok(children.every(task => ['completed', 'failed', 'cancelled'].includes(task.status)), JSON.stringify(children.map(task => ({ id: task.id, status: task.status }))));
});

test('an explicitly created child of a completed parent still runs in its own worktree', async t => {
  const { root, harness } = await setup(t, 1);
  const folder = await project(harness, root, 'completed-parent', true);
  const parent = await harness.createTask({ projectId: folder.id, isolated: true, prompt: 'complete' });
  await until(() => current(harness, parent.id).status === 'completed', 'completed parent');
  const child = await harness.createTask({
    projectId: folder.id, parentId: parent.id, isolated: true, prompt: 'complete',
    title: 'Explicit follow-up child',
  });
  await until(() => current(harness, child.id).status === 'completed', 'explicit child completion');
  assert.equal(current(harness, parent.id).status, 'completed');
  assert.equal(current(harness, child.id).parentId, parent.id);
  assert.notEqual(child.cwd, parent.cwd);
  assert.ok(child.worktree);
  assert.equal(current(harness, child.id).messages.at(-1)?.text, 'Fixture completed.');
});

test('schedule run admission advances occurrence and blocks overlap with its running task', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'scheduled');
  const schedule = harness.createSchedule(scheduleInput(folder.id, { prompt: 'hold' }));
  await harness.updateSchedule(schedule.id, { runNow: true });
  const admitted = harness.snapshot().schedules.find(item => item.id === schedule.id)!;
  assert.ok(admitted.lastRunAt);
  assert.ok(admitted.lastTaskId);
  await assert.rejects(harness.updateSchedule(schedule.id, { runNow: true }), /still active/);
  assert.equal(harness.snapshot().tasks.filter(task => task.scheduleId === schedule.id).length, 1);
  await harness.cancelTask(admitted.lastTaskId!);
  await until(() => current(harness, admitted.lastTaskId!).status === 'cancelled', 'scheduled task cancelled');
});

test('restart marks overdue schedules missed without generating or replaying a task', async t => {
  const root = await temp(t);
  const directory = join(root, 'data');
  const store = new AppStore(directory);
  const old = new Date(Date.now() - 120_000).toISOString();
  store.state.schedules.push({ ...scheduleInput('missing-project', { nextRunAt: old }), id: 'missed', enabled: true, missed: false });
  store.save();
  const harness = new Harness(directory, fakeWorker, new Vault(directory, codec));
  harnesses.set(root, harness);
  await until(() => harness.snapshot().schedules[0]?.missed === true, 'overdue schedule classified after startup');
  assert.equal(harness.snapshot().schedules[0]?.missed, true);
  assert.equal(harness.snapshot().tasks.length, 0);
});

test('startup health gate prevents schedule processing until the renderer is ready', async t => {
  const root = await temp(t); const directory = join(root, 'data'); const store = new AppStore(directory);
  store.state.schedules.push({ ...scheduleInput('missing-project', { nextRunAt: new Date(Date.now() - 120_000).toISOString() }), id: 'paused-missed', enabled: true, missed: false }); store.save();
  const harness = new Harness(directory, fakeWorker, new Vault(directory, codec), { paused: true }); harnesses.set(root, harness);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(harness.snapshot().schedules[0]?.missed, false); assert.equal(harness.snapshot().tasks.length, 0);
  harness.resumeStartup();
  await until(() => harness.snapshot().schedules[0]?.missed === true, 'schedule processing after health gate');
  assert.equal(harness.snapshot().tasks.length, 0);
});

test('invalid gateway and task settings are rejected without saving secrets or corrupting state', async t => {
  const { harness, vault } = await setup(t);
  for (const baseUrl of ['file:///tmp/test', 'https://user:pass@example.invalid/v1', 'https://example.invalid/v1?key=value']) {
    assert.throws(() => harness.saveGateway({ ...gateway, id: 'rejected', baseUrl }, 'must-not-save'));
  }
  assert.equal(vault.has('rejected'), false);
  assert.throws(() => harness.saveGateway({ ...gateway, maxTokens: 100_000 }), /context window/);
  assert.throws(() => harness.savePreferences({ maxConcurrent: 0 }), /between 1 and 8/);
  assert.throws(() => harness.savePreferences({ theme: 'unknown' as Preferences['theme'] }), /appearance/);
  assert.equal(harness.snapshot().preferences.maxConcurrent, 1);
  assert.equal(harness.snapshot().preferences.theme, 'system');
});

test('the theme is a built-in one or a theme pack in the data folder, and the pet settings are checked', async t => {
  const { directory, harness } = await setup(t);
  harness.savePreferences({ theme: 'sakura' });
  assert.equal(harness.snapshot().preferences.theme, 'sakura');
  assert.throws(() => harness.savePreferences({ theme: 'night-tea' }), /appearance/, 'a pack that is not installed');
  await mkdir(join(directory, 'themes', 'night-tea'), { recursive: true });
  await writeFile(join(directory, 'themes', 'night-tea', 'theme.json'), '{}');
  harness.savePreferences({ theme: 'night-tea' });
  assert.equal(harness.snapshot().preferences.theme, 'night-tea');
  assert.throws(() => harness.savePreferences({ theme: '../escape' }), /appearance/);
  assert.equal(harness.snapshot().preferences.petEnabled, undefined, 'the pet is off until the user turns it on');
  harness.savePreferences({ petEnabled: true, petId: 'erii', petPosition: { x: 1640, y: 770 } });
  assert.deepEqual([harness.snapshot().preferences.petEnabled, harness.snapshot().preferences.petId, harness.snapshot().preferences.petPosition], [true, 'erii', { x: 1640, y: 770 }]);
  assert.throws(() => harness.savePreferences({ petPosition: { x: Number.NaN, y: 0 } }), /pet/i);
  assert.throws(() => harness.savePreferences({ petPosition: 'top-left' as never }), /pet/i);
  assert.throws(() => harness.savePreferences({ petId: '../erii' }), /pet/i);
  assert.throws(() => harness.savePreferences({ petEnabled: 'yes' as never }), /pet/i);
});

test('multi-model selection is atomic and retains one shared gateway credential', async t => {
  const { root, directory, harness, vault } = await setup(t);
  const folder = await project(harness, root, 'models');
  const model = { reasoning: false, contextWindow: 300000, maxTokens: 8192, effortMap: { ultra: 'ultra' } };
  const config = { ...gateway, modelId: 'model-a', models: [{ ...model, id: 'model-a' }, { ...model, id: 'model-b' }] };
  harness.saveGateway(config);
  const task = await harness.createTask({ projectId: folder.id, isolated: false, modelId: 'model-a', contextWindow: 500000 });
  const persisted = await readFile(join(directory, 'state.json'), 'utf8');
  assert.throws(() => harness.updateTask(task.id, { modelId: 'model-b', contextWindow: 1000000, pinned: 'invalid' as unknown as boolean }), /Invalid task state/);
  assert.equal(current(harness, task.id).modelId, 'model-a');
  assert.equal(current(harness, task.id).contextWindow, 500000);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), persisted);
  harness.updateTask(task.id, { modelId: 'model-b', contextWindow: 1000000 });
  assert.equal(current(harness, task.id).modelId, 'model-b');
  assert.equal(harness.snapshot().gateways[0].models?.[1].contextWindow, 300000);
  assert.equal(harness.snapshot().gateways[0].models?.[1].effortMap?.ultra, 'max');
  assert.equal(vault.get(gateway.id), fixtureKey);
  assert.throws(() => harness.saveGateway({ ...config, models: [config.models[0], config.models[0]] }, 'do-not-save'), /already included/);
  assert.equal(vault.get(gateway.id), fixtureKey);
  assert.throws(() => harness.saveGateway({ ...config, models: [config.models[0]] }, 'do-not-save'), /saved task or schedule/);
  assert.equal(vault.get(gateway.id), fixtureKey);
  harness.saveGateway({ ...config, modelId: 'model-b' });
  assert.equal(current(harness, task.id).contextWindow, 1000000);
  const schedule = harness.createSchedule(scheduleInput(folder.id, { modelId: 'model-a', contextWindow: 500000 }));
  assert.equal(schedule.modelId, 'model-a'); assert.equal(schedule.contextWindow, 500000);
});

test('concurrent run-now requests admit only one scheduled task', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'schedule-race', true);
  const schedule = harness.createSchedule(scheduleInput(folder.id, { prompt: 'hold', isolated: true }));
  await Promise.allSettled([
    harness.updateSchedule(schedule.id, { runNow: true }),
    harness.updateSchedule(schedule.id, { runNow: true }),
  ]);
  assert.equal(harness.snapshot().tasks.filter(task => task.scheduleId === schedule.id).length, 1);
});

test('terminal task failure and cancellation also terminate its pending tool statuses', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'terminal-tools');
  const failed = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'error' });
  await until(() => current(harness, failed.id).status === 'failed', 'failed tool task');
  assert.equal(current(harness, failed.id).tools[0]?.status, 'failed');
  const cancelled = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'approve' });
  await until(() => harness.snapshot().approvals.length === 1, 'approval to cancel');
  await harness.cancelTask(cancelled.id);
  await until(() => current(harness, cancelled.id).status === 'cancelled', 'cancelled tool task');
  assert.equal(current(harness, cancelled.id).tools[0]?.status, 'failed');
});

test('skill configuration with a file path cannot poison persisted preferences', async t => {
  const { root, harness } = await setup(t);
  const file = join(root, 'not-a-folder.txt');
  await writeFile(file, 'Fixture');
  try { harness.savePreferences({ skillPaths: [file] }); } catch { /* Rejecting a file is valid if state stays valid. */ }
  assert.doesNotThrow(() => harness.refreshSkills());
  assert.equal(harness.snapshot().preferences.skillPaths.includes(file), false);
});

test('a truncated run fails with structured truncation state that the next run clears', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'truncation');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'truncate' });
  await until(() => current(harness, task.id).status === 'failed', 'truncated run fails');
  const truncated = current(harness, task.id);
  assert.equal(truncated.truncation?.outputTokens, 1024);
  assert.equal(truncated.truncation?.maxTokens, 1024);
  assert.equal(truncated.truncation?.model, 'fixture');
  assert.match(truncated.error ?? '', /Output limit reached/);
  await harness.prompt(task.id, 'complete');
  await until(() => current(harness, task.id).status === 'completed', 'follow-up completes');
  assert.equal(current(harness, task.id).truncation, undefined);
  assert.equal(current(harness, task.id).error, undefined);
});

test('one model output limit changes in place and renderer preferences cannot forge upgrade notices', async t => {
  const { harness } = await setup(t);
  harness.saveGateway({ ...gateway, id: 'multi', name: 'Multi', modelId: 'a', models: [
    { id: 'a', reasoning: false, contextWindow: 8192, maxTokens: 1024 },
    { id: 'b', reasoning: false, contextWindow: 8192, maxTokens: 1024 },
  ] });
  harness.setModelOutputLimit('multi', 'b', 8000);
  const saved = harness.snapshot().gateways.find(item => item.id === 'multi')!;
  assert.deepEqual(saved.models!.map(model => model.maxTokens), [1024, 8000]);
  assert.equal(saved.maxTokens, 1024);
  assert.throws(() => harness.setModelOutputLimit('multi', 'b', 9000), /between 1 and the context window/);
  assert.throws(() => harness.setModelOutputLimit('multi', 'missing', 10), /not configured/);
  harness.savePreferences({ migrationNotice: { kind: 'output-limit', models: ['forged'] } });
  assert.equal(harness.snapshot().preferences.migrationNotice, undefined);
  harness.dismissNotice();
  assert.equal(harness.snapshot().preferences.migrationNotice, undefined);
});

test('sound preferences are validated before saving', async t => {
  const { harness } = await setup(t);
  harness.savePreferences({ soundEnabled: false, soundVolume: 55 });
  assert.equal(harness.snapshot().preferences.soundEnabled, false);
  assert.equal(harness.snapshot().preferences.soundVolume, 55);
  assert.throws(() => harness.savePreferences({ soundVolume: 101 }), /Sound volume/);
  assert.throws(() => harness.savePreferences({ soundVolume: 12.5 }), /Sound volume/);
  assert.throws(() => harness.savePreferences({ soundEnabled: 'on' as unknown as boolean }), /Sound volume/);
});

test('each run tells its worker who speaks: 小绘 with the personality as set, in the interface language; a member gets one line', async t => {
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'identity');
  const run = async (prompt: string) => {
    const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt });
    await until(() => current(harness, task.id).status === 'completed', prompt);
    return task.id;
  };
  const identityOf = (id: string) => JSON.parse(current(harness, id).messages.at(-1)?.text ?? 'null');
  assert.deepEqual(identityOf(await run('inspect-identity')), { language: 'zh', persona: true, member: false });
  harness.savePreferences({ persona: false, language: 'en' });
  assert.deepEqual(identityOf(await run('inspect-identity')), { language: 'en', persona: false, member: false });
  const lead = await run('team:inspect-identity');
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead);
  assert.equal(members.length, 2);
  for (const member of members) assert.equal(identityOf(member.id).member, true);
  // Only a member a lead dispatched is a member. A child the user starts by hand (the 启动并行 Agent dialog: a parentId and no member name) talks to the user.
  const byHand = await harness.createTask({ projectId: folder.id, parentId: lead, isolated: false, prompt: 'inspect-identity' });
  await until(() => current(harness, byHand.id).status === 'completed', 'the child started by hand');
  assert.deepEqual(identityOf(byHand.id), { language: 'en', persona: false, member: false });
  assert.throws(() => harness.savePreferences({ persona: 'off' as unknown as boolean }), /on or off/);
});

test('1.2 role ids from the composer or the model land on executor / explorer / planner', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'role-ids');
  assert.deepEqual(harness.snapshot().ecosystem.roles.filter(role => role.builtIn).map(role => [role.id, role.name]), [['executor', '执行员'], ['explorer', '探索员'], ['planner', '规划师']]);
  const planning = await harness.createTask({ projectId: folder.id, isolated: false, role: 'Plan' });
  assert.equal(planning.role, 'planner');
  assert.equal(planning.planMode, true, 'the planner still starts in plan mode');
  assert.equal((await harness.createTask({ projectId: folder.id, isolated: false, role: 'general-purpose' })).role, 'executor');
  assert.equal((await harness.createTask({ projectId: folder.id, isolated: false })).role, 'executor');
  for (const id of ['executor', 'Explore', 'PLANNER', 'researcher', 'writer']) assert.throws(() => harness.saveAgentRole({ id, name: '我的', prompt: '自建', readOnly: false }), /Built-in roles/, id);
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'delegate-role:Explore' });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead collects its explorer');
  const member = harness.snapshot().tasks.find(task => task.parentId === lead.id)!;
  assert.equal(member.role, 'explorer');
  assert.equal(member.agentName, '探索员1');
  assert.equal(member.sharedReadOnly, true, 'an explorer only reads');
  assert.equal((await harness.dreamMemory(folder.id)).role, DREAMER_ROLE.id, 'the Dreamer has a definition of its own, not the explorer’s');
});

test('a project file named like a built-in role takes no one’s place until it is turned on, so the read-only roles stay read-only', async t => {
  await skillHome(t);
  const agentFile = (name: string) => ['---', `name: ${name}`, `description: My own ${name}`, '---', `You are my own ${name}.`, ''].join('\n');
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'shadowed-roles', true);
  // The project's own files are committed, so the repository stays clean and a member still gets a worktree of its own.
  await mkdir(join(folder.path, '.claude', 'agents'), { recursive: true });
  for (const name of ['explorer', 'planner']) await writeFile(join(folder.path, '.claude', 'agents', `${name}.md`), agentFile(name));
  for (const args of [['add', '.claude'], ['commit', '-m', 'Add subagents named like the built-in roles']]) await exec('git', args, { cwd: folder.path, windowsHide: true });
  harness.refreshSkills();
  const hidden = () => harness.roles(folder.id).filter(role => role.builtIn && role.shadowedBy).map(role => role.id);
  // A project folder's subagents start off (Q25): until the user turns one on, it hides nothing and the built-in roles run as they are.
  assert.deepEqual(hidden(), [], 'files that are off take no one’s place');
  const seen = (id: string) => { const { role, readOnly, planMode } = JSON.parse(current(harness, id).messages.at(-1)?.text ?? '{}'); return { role, readOnly, planMode }; };
  const reported = (id: string) => until(() => current(harness, id).status === 'completed' && !!current(harness, id).messages.at(-1)?.text?.startsWith('{'), 'the task reports its role');
  // A planning lead's members keep the subagent they were sent as and only read. In a clean Git project each one gets a worktree, so its read-only comes from the dispatch, not from the shared read-only shortcut.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, planMode: true, prompt: 'team:inspect-init' });
  await until(() => current(harness, lead.id).status === 'completed', 'the planning lead collects its members');
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.equal(members.length, 2);
  assert.ok(members.every(member => member.worktree && !member.sharedReadOnly), 'members of a Git project work in worktrees of their own');
  // A planner with plan mode off stays read-only until its plan is approved.
  const planner = await harness.createTask({ projectId: folder.id, isolated: false, role: 'planner', planMode: false, prompt: 'inspect-init' });
  await reported(planner.id);
  // The Dreamer has a read-only definition of its own, and the user can keep talking to it.
  const dreamer = await harness.dreamMemory(folder.id);
  await until(() => current(harness, dreamer.id).status === 'completed', 'the Dreamer finishes');
  await harness.prompt(dreamer.id, 'inspect-init');
  await reported(dreamer.id);
  const readOnly = { readOnly: true, planMode: false };
  assert.deepEqual({ members: members.map(member => seen(member.id)), planner: seen(planner.id), dreamer: seen(dreamer.id) }, {
    members: [{ role: 'executor', ...readOnly }, { role: 'executor', ...readOnly }], planner: { role: 'planner', ...readOnly }, dreamer: { role: DREAMER_ROLE.id, ...readOnly },
  });
  // Turned on, each file does take its built-in role's place in this project.
  for (const name of ['explorer', 'planner']) harness.setAgentEnabled(`agent:project:${folder.id}:${name}`, true);
  assert.deepEqual(hidden(), ['explorer', 'planner'], 'turned on, both files hide their built-in role from the usable list');
});

test('a switched-on explorer.md may bring its own instructions, but a planning lead’s members still only read, and the Dreamer keeps its own definition', async t => {
  // The user's own explorer.md: no tools line, so a writing subagent, and on by default like every file in the user's folder (Q25).
  const home = await skillHome(t);
  await writeAgent(join(home, '.claude', 'agents'), 'explorer', '我自己的探索员');
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'own-explorer', true);
  const fileId = 'agent:user:explorer';
  const role = (id: string) => harness.roles(folder.id).find(item => item.id === id);
  assert.deepEqual([role(fileId)?.enabled, role(fileId)?.readOnly, role('explorer')?.shadowedBy], [true, false, fileId], 'on, writable, and in the built-in explorer’s place');
  const report = (id: string) => { const { role: seen, readOnly, rolePrompt } = JSON.parse(current(harness, id).messages.at(-1)?.text ?? '{}'); return [seen, readOnly, rolePrompt]; };
  // A planning lead's members ask for explorer and get the file. In a clean Git project each one has a worktree of its own, so no shared folder makes them read-only: the dispatch does.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, planMode: true, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲探索员', 'inspect-init', 'explorer'), squadMember('乙探索员', 'inspect-init', 'explorer')] } },
    { method: 'wait', args: {} },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the planning lead collects its members', 15_000);
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.equal(members.length, 2, JSON.stringify(scriptOutcomes(harness, lead.id)));
  for (const member of members) {
    assert.ok(member.worktree && !member.sharedReadOnly, 'a worktree of its own');
    assert.deepEqual([member.role, member.readOnly], [fileId, true]);
    assert.deepEqual(report(member.id), [fileId, true, '照文件里写的做。'], 'the file’s instructions, never its write access');
  }
  // The Dreamer does not ask for explorer: the file neither stops it nor brings its instructions, and it only reads.
  const dreamer = await harness.dreamMemory(folder.id);
  assert.deepEqual([dreamer.role, dreamer.readOnly], [DREAMER_ROLE.id, true]);
  await until(() => current(harness, dreamer.id).status === 'completed' && !current(harness, dreamer.id).workerActive, 'the Dreamer finishes');
  await harness.prompt(dreamer.id, 'inspect-init');
  await until(() => current(harness, dreamer.id).status === 'completed' && !!current(harness, dreamer.id).messages.at(-1)?.text?.startsWith('{'), 'the Dreamer reports');
  assert.deepEqual(report(dreamer.id), [DREAMER_ROLE.id, true, DREAMER_ROLE.prompt]);
});

test('the Dreamer does not need the 探索员: switched off or replaced, it still runs, read-only, with its own instructions', async t => {
  const home = await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'dreamer-without-explorer');
  const report = async (id: string) => {
    await until(() => current(harness, id).status === 'completed' && !current(harness, id).workerActive, 'the Dreamer settles');
    await harness.prompt(id, 'inspect-init');
    await until(() => current(harness, id).status === 'completed' && !current(harness, id).workerActive && !!current(harness, id).messages.at(-1)?.text?.startsWith('{'), 'the Dreamer reports');
    const { role, readOnly, rolePrompt } = JSON.parse(current(harness, id).messages.at(-1)?.text ?? '{}');
    return [role, readOnly, rolePrompt];
  };
  // The user switched the 探索员 off: organizing memory is not their explorer's job, so it neither refuses nor asks them to switch it on.
  harness.setAgentEnabled('explorer', false);
  const dreamer = await harness.dreamMemory(folder.id);
  assert.deepEqual([dreamer.role, dreamer.readOnly], [DREAMER_ROLE.id, true]);
  assert.deepEqual(await report(dreamer.id), [DREAMER_ROLE.id, true, DREAMER_ROLE.prompt], 'and the user can keep talking to it');
  // Their own explorer.md takes the built-in's place: the file's instructions are not the Dreamer's, and nothing stops a Dreamer already started.
  await writeAgent(join(home, '.claude', 'agents'), 'explorer', '我自己的探索员');
  harness.refreshSkills();
  harness.setAgentEnabled('explorer', true);
  assert.equal(harness.roles(folder.id).find(role => role.id === 'explorer')?.shadowedBy, 'agent:user:explorer');
  assert.deepEqual(await report(dreamer.id), [DREAMER_ROLE.id, true, DREAMER_ROLE.prompt]);
  const another = await harness.dreamMemory(folder.id);
  assert.deepEqual(await report(another.id), [DREAMER_ROLE.id, true, DREAMER_ROLE.prompt]);
});

test('a file named Explore or Plan answers to the 1.2 ids, and what is asked for that way still only reads', async t => {
  // The user's own Explore.md and Plan.md: no tools line, so writing subagents, and on by default like every file in the user's folder.
  const home = await skillHome(t);
  await writeAgent(join(home, '.claude', 'agents'), 'Explore', '我自己的探索');
  await writeAgent(join(home, '.claude', 'agents'), 'Plan', '我自己的规划');
  const { root, harness } = await setup(t, 3);
  const folder = await project(harness, root, 'one-two-ids', true);
  const files = ['agent:user:Explore', 'agent:user:Plan'];
  assert.deepEqual(harness.roles(folder.id).filter(role => files.includes(role.id)).map(role => [role.enabled, role.readOnly]), [[true, false], [true, false]], 'on, and the files themselves keep every tool');
  // A lead that is no planner and reads nothing special dispatches by the 1.2 ids; in a clean Git project each member has a worktree, so only the app's own decision keeps it from writing.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'delegate', args: { name: '探路甲', prompt: 'inspect-init', role: 'Explore' } },
    { method: 'team', args: { members: [squadMember('谋划乙', 'inspect-init', 'Plan'), squadMember('谋划丙', 'inspect-init', 'plan')] } },
    { method: 'wait', args: {} },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead collects its members', 15_000);
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.equal(members.length, 3, JSON.stringify(scriptOutcomes(harness, lead.id)));
  for (const member of members) {
    assert.ok(member.worktree && !member.sharedReadOnly, 'a worktree of its own');
    assert.deepEqual([files.includes(member.role!), member.readOnly], [true, true], `${member.agentName} answers as the file and only reads`);
    assert.equal(JSON.parse(member.messages.at(-1)?.text ?? '{}').readOnly, true, `${member.agentName}'s worker is told to only read`);
  }
  // The same names from the composer.
  for (const role of ['Explore', 'Plan']) assert.equal((await harness.createTask({ projectId: folder.id, isolated: false, role })).readOnly, true, `a task started as ${role}`);
});

test('a task asked for as the planner only reads, whichever file answers to the name, until the user approves its plan', async t => {
  const home = await skillHome(t);
  await writeAgent(join(home, '.claude', 'agents'), 'planner', '我自己的规划师');
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'own-planner');
  const fileId = 'agent:user:planner';
  const reported = async (id: string, text: string) => {
    await harness.prompt(id, text);
    await until(() => current(harness, id).status === 'completed' && !current(harness, id).workerActive && !!current(harness, id).messages.at(-1)?.text?.startsWith('{'), `the report after ${text}`);
    const { role, readOnly, planMode, rolePrompt } = JSON.parse(current(harness, id).messages.at(-1)?.text ?? '{}');
    return { role, readOnly, planMode, rolePrompt };
  };
  const planner = await harness.createTask({ projectId: folder.id, isolated: false, role: 'planner', planMode: true });
  assert.deepEqual([planner.role, planner.planMode, planner.readOnly], [fileId, true, true]);
  assert.deepEqual(await reported(planner.id, 'inspect-init'), { role: fileId, readOnly: true, planMode: true, rolePrompt: '照文件里写的做。' });
  // Out of plan mode it still only reads: the file brought its instructions, not write access.
  harness.setPlanMode(planner.id, false);
  assert.deepEqual(await reported(planner.id, 'inspect-init'), { role: fileId, readOnly: true, planMode: false, rolePrompt: '照文件里写的做。' });
  // Approving its plan is what turns it into an executor that writes, as approving a plan always has.
  harness.setPlanMode(planner.id, true);
  harness.store.state.tasks.find(task => task.id === planner.id)!.plan = { text: 'Write the notes.', status: 'pending' };
  await harness.approvePlan(planner.id);
  await until(() => current(harness, planner.id).status === 'completed' && !current(harness, planner.id).workerActive, 'the approved plan runs');
  assert.deepEqual([current(harness, planner.id).role, !!current(harness, planner.id).readOnly], ['executor', false]);
  const { role, readOnly, planMode } = await reported(planner.id, 'inspect-init');
  assert.deepEqual({ role, readOnly, planMode }, { role: 'executor', readOnly: false, planMode: false });
});

test('a switched-on subagent that stands in for the planner keeps plan mode, as the planner itself has', async t => {
  const home = await skillHome(t);
  for (const name of ['planner', 'Plan', 'planning']) await writeAgent(join(home, '.claude', 'agents'), name, `我自己的 ${name}`);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'plan-stand-ins', true);
  // No planMode is asked for: the subagent decides. A file named planner, or Plan (the planner's 1.2 id), stands in for it; planning is only a name that looks alike.
  const started = async (role: string) => { const { planMode, readOnly, role: taskRole } = await harness.createTask({ projectId: folder.id, isolated: false, role }); return { planMode, readOnly, role: taskRole }; };
  assert.deepEqual(await started('planner'), { planMode: true, readOnly: true, role: 'agent:user:planner' });
  assert.deepEqual(await started('Plan'), { planMode: true, readOnly: true, role: 'agent:user:Plan' });
  assert.deepEqual(await started('planning'), { planMode: false, readOnly: undefined, role: 'agent:user:planning' });
  // A member the lead sends as the planner starts in plan mode too.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'delegate', args: { name: '谋划甲', prompt: 'inspect-init', role: 'planner' } },
    { method: 'wait', args: {} },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead collects its planner', 15_000);
  const [member] = harness.snapshot().tasks.filter(item => item.parentId === lead.id);
  assert.deepEqual([member?.role, member?.planMode, member?.readOnly], ['agent:user:planner', true, true], JSON.stringify(scriptOutcomes(harness, lead.id)));
  assert.equal(JSON.parse(member.messages.at(-1)?.text ?? '{}').planMode, true);
});

test('a member from before 1.3 whose subagent only reads cannot be turned into a writer by approving its plan', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'old-readers', true);
  const lead = await harness.createTask({ projectId: folder.id, isolated: false });
  const stored = (id: string) => harness.store.state.tasks.find(task => task.id === id)!;
  for (const role of ['planner', 'explorer']) {
    // A member of an older version: a worktree of its own, a plan waiting for approval, and no read-only flag (that came with 1.3).
    const member = await harness.createTask({ projectId: folder.id, parentId: lead.id, role, isolated: true, planMode: true });
    delete stored(member.id).readOnly;
    stored(member.id).plan = { text: 'Fix it.', status: 'pending' };
    await assert.rejects(harness.approvePlan(member.id), /只读/, `a member made as ${role}`);
    assert.deepEqual([stored(member.id).plan?.status, stored(member.id).role, stored(member.id).planMode], ['pending', role, true], 'nothing was changed');
  }
  // A member that writes is not affected.
  const writer = await harness.createTask({ projectId: folder.id, parentId: lead.id, role: 'executor', isolated: true, planMode: true });
  stored(writer.id).plan = { text: 'Fix it.', status: 'pending' };
  await harness.approvePlan(writer.id);
  assert.equal(stored(writer.id).plan?.status, 'approved');
  await until(() => current(harness, writer.id).status === 'completed' && !current(harness, writer.id).workerActive, 'the writing member runs its plan');
});

test('approving a plan while the executor cannot run refuses it and leaves the plan waiting for approval', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'no-executor');
  const planner = await harness.createTask({ projectId: folder.id, isolated: false, role: 'planner' });
  const task = harness.store.state.tasks.find(item => item.id === planner.id)!;
  task.plan = { text: 'Write the notes.', status: 'pending' };
  harness.setAgentEnabled('executor', false);
  await assert.rejects(harness.approvePlan(planner.id), /子代理「执行员」已关闭/);
  assert.deepEqual([task.plan.status, task.role, task.planMode, task.readOnly], ['pending', 'planner', true, true], 'the plan is not marked approved and the task is still the planner');
  harness.setAgentEnabled('executor', true);
  await harness.approvePlan(planner.id);
  assert.deepEqual([task.plan.status, task.role], ['approved', 'executor']);
  await until(() => current(harness, planner.id).status === 'completed' && !current(harness, planner.id).workerActive, 'the approved plan runs');
});

test('a project file named like a built-in subagent cannot turn a read-only task writable', async t => {
  const { root, harness } = await setup(t, 3);
  await quietHome(t, root);
  const folder = await project(harness, root, 'named-like-builtin');
  await writeAgent(join(folder.path, '.claude', 'agents'), 'explorer', '项目里的同名文件');
  harness.refreshSkills();
  const fileId = `agent:project:${folder.id}:explorer`;
  // Off by default, the file takes no one's place: the built-in explorer runs, read-only.
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'inspect-init', role: 'explorer' });
  await until(() => current(harness, task.id).status === 'completed' && !current(harness, task.id).workerActive, 'the built-in explorer');
  const builtInReport = JSON.parse(current(harness, task.id).messages.at(-1)?.text ?? '{}');
  assert.equal(builtInReport.role, 'explorer');
  assert.equal(builtInReport.readOnly, true);
  // Turned on, the file replaces the built-in in this project; the task made as the built-in refuses to run.
  harness.setAgentEnabled(fileId, true);
  await assert.rejects(harness.prompt(task.id, 'inspect-init'), /被同名的「explorer」顶替了/);
  // A planning lead's member that asks for "explorer" gets the file's subagent, and it still only reads.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, planMode: true, prompt: leadScript([
    { method: 'delegate', args: { name: '探路甲', prompt: 'inspect-init', role: 'explorer' } },
    { method: 'wait', args: {} },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the planning lead collects its member');
  const [member] = harness.snapshot().tasks.filter(item => item.parentId === lead.id);
  assert.equal(member?.role, fileId, JSON.stringify(scriptOutcomes(harness, lead.id)));
  assert.equal(member.readOnly, true);
  const memberReport = JSON.parse(member.messages.at(-1)?.text ?? '{}');
  assert.equal(memberReport.readOnly, true);
  assert.equal(memberReport.rolePrompt, '照文件里写的做。');
});

test('a run queued before its subagent was replaced is refused when it would start', async t => {
  const { root, harness } = await setup(t, 1);
  await quietHome(t, root);
  const busy = await project(harness, root, 'busy');
  const folder = await project(harness, root, 'queued-explorer');
  await writeAgent(join(folder.path, '.claude', 'agents'), 'explorer', '项目里的同名文件');
  harness.refreshSkills();
  const holder = await harness.createTask({ projectId: busy.id, isolated: false, prompt: 'hold' });
  await until(() => current(harness, holder.id).tools.length === 1, 'the only slot taken');
  const queued = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'inspect-init', role: 'explorer' });
  assert.equal(current(harness, queued.id).status, 'queued');
  harness.setAgentEnabled(`agent:project:${folder.id}:explorer`, true);
  await harness.prompt(holder.id, 'release', 'followUp');
  await until(() => current(harness, queued.id).status === 'failed', 'the refused run');
  assert.match(current(harness, queued.id).error ?? '', /顶替/);
  assert.equal(current(harness, queued.id).messages.some(message => message.role === 'assistant'), false, 'no worker ever ran');
});

test('a task whose subagent was switched off or removed says so instead of running', async t => {
  const { root, harness } = await setup(t, 2);
  await quietHome(t, root);
  const folder = await project(harness, root, 'custom-role');
  harness.saveAgentRole({ id: 'tester', name: '测试员', prompt: 'Test only.', readOnly: false });
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete', role: 'tester' });
  await until(() => current(harness, task.id).status === 'completed' && !current(harness, task.id).workerActive, 'the first run');
  harness.setAgentEnabled('tester', false);
  await assert.rejects(harness.prompt(task.id, 'complete'), /子代理「测试员」已关闭/);
  harness.setAgentEnabled('tester', true);
  harness.removeAgentRole('tester');
  await assert.rejects(harness.prompt(task.id, 'complete'), /找不到子代理「tester」/);
});

test('a task whose subagent is gone says so by the name the user knows, even when a file of the same name is on', async t => {
  const home = await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'gone-subagents');
  const settled = (id: string) => until(() => current(harness, id).status === 'completed' && !current(harness, id).workerActive, 'the run settles');
  harness.saveAgentRole({ id: 'helper', name: '帮手', prompt: 'Help.', readOnly: false });
  const custom = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete', role: 'helper' });
  await settled(custom.id);
  // A file of the same name now answers to it: the custom subagent is replaced, then removed.
  await writeAgent(join(home, '.claude', 'agents'), 'helper', '用户目录里的帮手');
  harness.refreshSkills();
  await assert.rejects(harness.prompt(custom.id, 'complete'), /子代理「帮手」被同名的「helper」顶替了/);
  harness.removeAgentRole('helper');
  // The task was made as the custom subagent; the file is another one. It is not found, and the refusal says why.
  await assert.rejects(harness.prompt(custom.id, 'complete'), /找不到子代理「helper」，它可能已被删除。.*这一轮没有开始/);
  // A task made as a file's subagent hears the file's name, not the id the app keeps.
  await writeAgent(join(home, '.claude', 'agents'), 'temporary', '临时的帮手');
  harness.refreshSkills();
  const fileTask = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete', role: 'temporary' });
  await settled(fileTask.id);
  await rm(join(home, '.claude', 'agents', 'temporary.md'));
  harness.refreshSkills();
  await assert.rejects(harness.prompt(fileTask.id, 'complete'), (error: Error) => {
    assert.match(error.message, /找不到子代理「temporary」，它可能已被删除。/);
    assert.doesNotMatch(error.message, /agent:/);
    return true;
  });
});

test('asking for a subagent that is switched off, by name, says it is off instead of that it is gone', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'off-by-name');
  await writeAgent(join(folder.path, '.claude', 'agents'), 'reviewer', '项目里带的审查员');
  harness.refreshSkills();
  // The user starts a task by the file's name: it is off until turned on.
  await assert.rejects(harness.createTask({ projectId: folder.id, isolated: false, prompt: 'complete', role: 'reviewer' }), /子代理「reviewer」已关闭/);
  // The lead asks for it by name: the same words, and nobody of its squad starts.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲队员', 'hold'), squadMember('乙队员', 'hold', 'reviewer')] } },
    { method: 'delegate', args: { name: '丙队员', prompt: 'hold', role: 'nobody' } },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the refused requests');
  const [team, single] = scriptOutcomes(harness, lead.id);
  assert.match(team.error ?? '', /子代理「reviewer」已关闭。可用的有：.*executor/);
  assert.match(single.error ?? '', /没有可用的子代理「nobody」/, 'a name nobody has still says so plainly');
  assert.equal(harness.snapshot().tasks.filter(task => task.parentId === lead.id).length, 0);
});

test('a second writing member in a shared folder waits behind the first one’s checkpoint instead of failing the squad', async t => {
  const { root, harness, studio } = await setupWithStudio(t, 3);
  const folder = await project(harness, root, 'shared-checkpoints');
  await writeFile(join(folder.path, 'notes.txt'), 'baseline\n');
  // Each checkpoint takes a while, so the second member is created while the first one's holds the folder.
  const capture = studio.checkpoints.capture.bind(studio.checkpoints);
  t.mock.method(studio.checkpoints, 'capture', async (...args: Parameters<typeof capture>) => { await new Promise(done => setTimeout(done, 300)); return capture(...args); });
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'team:complete' });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead collects both members', 15_000);
  assert.match(current(harness, lead.id).messages.at(-1)?.text ?? '', /^children:/, current(harness, lead.id).messages.at(-1)?.text);
  const members = harness.snapshot().tasks.filter(task => task.parentId === lead.id);
  assert.deepEqual(members.map(member => member.status), ['completed', 'completed']);
  for (const member of members) {
    assert.equal(member.sharedWorkspace, true);
    assert.equal(member.checkpointIds?.length, 1, 'each member kept its own checkpoint of the shared folder');
  }
});

test('a member queued while its folder is locked starts once the lock is released', async t => {
  const { root, harness, studio } = await setupWithStudio(t, 3);
  const folder = await project(harness, root, 'locked-folder');
  await writeFile(join(folder.path, 'notes.txt'), 'baseline\n');
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'hold' });
  await until(() => current(harness, lead.id).tools.length === 1, 'the lead holding the folder');
  const capture = studio.checkpoints.capture.bind(studio.checkpoints);
  t.mock.method(studio.checkpoints, 'capture', async (...args: Parameters<typeof capture>) => { await new Promise(done => setTimeout(done, 400)); return capture(...args); });
  // The lead's next checkpoint holds the folder, as one does before each of its writes.
  const checkpoint = studio.beforeRun(studio.task(lead.id), 'second-turn');
  assert.equal(studio.directoryLocked(folder.path), true);
  const member = await harness.createTask({ projectId: folder.id, parentId: lead.id, isolated: false, sharedReadOnly: true, role: 'explorer', prompt: 'complete', title: 'Queued reader' });
  assert.equal(current(harness, member.id).status, 'queued', 'queued, not refused');
  await checkpoint;
  await until(() => current(harness, member.id).status === 'completed', 'the member started after the lock', 5_000);
});

test('without the workbench settings a lead still holds at most six members', async t => {
  await skillHome(t);
  const { root, harness } = await setup(t, 2);
  const folder = await project(harness, root, 'six-members');
  const six = ['甲', '乙', '丙', '丁', '戊', '己'].map(name => squadMember(`${name}队员`, 'hold'));
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: six } },
    { method: 'delegate', args: { name: '庚队员', prompt: 'hold' } },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead runs its script');
  const results = scriptOutcomes(harness, lead.id);
  assert.equal(results[0].ok, true, JSON.stringify(results));
  assert.match(results[1].error ?? '', /成员额度是 6 人/);
  assert.equal(harness.snapshot().tasks.filter(task => task.parentId === lead.id).length, 6);
});

test('成员额度 counts working, queued and re-tasked members, and tells the lead plainly', async t => {
  const { root, harness, studio } = await setupWithStudio(t, 2);
  studio.settings({ defaultSquadSize: 3 });
  const folder = await project(harness, root, 'squad-limit');
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲队员', 'complete'), squadMember('乙队员', 'hold')] } },
    { method: 'wait', args: { taskIds: ['@0.0'] } },
    { method: 'delegate', args: { name: '丙队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '丁队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '戊队员', prompt: 'hold' } },
    { method: 'steer_agent', args: { agent_id: '@0.0', message: 'hold' } },
    { method: 'team', args: { members: [squadMember('己队员', 'hold'), squadMember('庚队员', 'hold')] } },
  ]) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead runs its script', 15_000);
  const results = scriptOutcomes(harness, lead.id);
  assert.deepEqual(results.slice(0, 4).map(item => item.ok), [true, true, true, true], JSON.stringify(results));
  assert.match(results[4].error ?? '', /成员额度是 3 人：现在已有 3 位成员在做或排队，再派 1 位就超了/);
  assert.match(results[5].error ?? '', /成员额度是 3 人/, 'a returned member sent back to work needs room too');
  assert.match(results[6].error ?? '', /再派 2 位就超了/);
  assert.equal(harness.snapshot().tasks.filter(task => task.parentId === lead.id).length, 4, 'nobody over the limit was created');
  const first = (results[0].result as { members: Array<{ id: string }> }).members[0].id;
  assert.equal(current(harness, first).status, 'completed', 'the returned member was not sent back');
});

test('two members that already returned, messaged at once, cannot both take the last place', async t => {
  const { root, harness, studio } = await setupWithStudio(t, 3);
  studio.settings({ defaultSquadSize: 3 });
  const folder = await project(harness, root, 'squad-last-place');
  // Pi runs a model's tool calls together, so both messages reach the app in one burst while a single place is free.
  // 丁 is the gate: the lead waits for it, so the burst only goes out after the test has seen 甲 and 乙 wound down for good.
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript([
    { method: 'team', args: { members: [squadMember('甲队员', 'complete'), squadMember('乙队员', 'complete')] } },
    { method: 'wait', args: { taskIds: ['@0.0', '@0.1'] } },
    { method: 'delegate', args: { name: '丙队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '丁队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '戊队员', prompt: 'hold' } },
    { method: 'wait', args: { taskIds: ['@3.0'] } },
    { method: 'parallel', args: { requests: [
      { method: 'steer_agent', args: { agent_id: '@0.0', message: 'hold' } },
      { method: 'steer_agent', args: { agent_id: '@0.1', message: 'hold' } },
    ] } },
  ]) });
  const member = (name: string) => harness.snapshot().tasks.find(task => task.parentId === lead.id && task.agentName === `${name}队员`)!;
  await until(() => current(harness, lead.id).status === 'waiting' && member('丁')?.tools.length === 1 && ['甲', '乙'].every(name => !member(name).workerActive), 'the lead waiting at the gate with 甲 and 乙 wound down', 15_000);
  await harness.prompt(member('丁').id, 'release', 'followUp');
  // A hook on the message keeps the first returning member waiting before it is queued again: the window in which the second message must already find the place taken.
  harness.saveHooks({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.platform === 'win32' ? 'Start-Sleep -Milliseconds 800' : 'sleep 1' }] }] });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead runs the rest of its script', 15_000);
  const results = scriptOutcomes(harness, lead.id);
  assert.deepEqual(results.slice(0, 6).map(item => item.ok), [true, true, true, true, true, true], JSON.stringify(results));
  const burst = results[6].result as Outcome[];
  assert.equal(burst.filter(item => item.ok).length, 1, `only one of them got the last place: ${JSON.stringify(burst)}`);
  assert.match(burst.find(item => item.error)?.error ?? '', /成员额度是 3 人：现在已有 3 位成员在做或排队，再派 1 位就超了/);
});

test('a 成员额度 that studio.json holds out of range or as the wrong kind of value still counts as 1–6, and anything unusable as 6', async t => {
  // Saving checks the setting; reading studio.json does not, so a hand-edited file has to be made sense of where it is used.
  const { root, harness, studio } = await setupWithStudio(t, 2, { preferences: { defaultSquadSize: 100 } });
  const folder = await project(harness, root, 'hand-edited-quota');
  const seven = ['甲', '乙', '丙', '丁', '戊', '己', '庚'].map(name => ({ method: 'delegate', args: { name: `${name}队员`, prompt: 'hold' } }));
  const lead = await harness.createTask({ projectId: folder.id, isolated: false, prompt: leadScript(seven) });
  await until(() => current(harness, lead.id).status === 'completed', 'the lead runs its script');
  const results = scriptOutcomes(harness, lead.id);
  assert.deepEqual(results.map(item => item.ok === true), [true, true, true, true, true, true, false], `a quota of 100 counts as 6: ${JSON.stringify(results)}`);
  assert.match(results[6].error ?? '', /成员额度是 6 人/);
  // The number a worker is told is the same one, whatever the file held: a whole number is kept, a fraction rounds down, nothing else shrinks it.
  // The lead's exit stops its squad; a stopped member's worker is still being closed for a moment, and until then its folder counts as in use.
  await until(() => harness.snapshot().tasks.every(task => !task.workerActive && ['idle', 'completed', 'failed', 'cancelled'].includes(task.status)), 'the squad stopped with its lead and every worker closed');
  const told = async (stored: unknown) => {
    studio.state.preferences.defaultSquadSize = stored as number;
    const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'inspect-init' });
    await until(() => current(harness, task.id).status === 'completed' && !current(harness, task.id).workerActive, `the report for ${JSON.stringify(stored)}`);
    return JSON.parse(current(harness, task.id).messages.at(-1)?.text ?? '{}').squadSize;
  };
  const stored = [3, 6, 3.9, 0, -2, 'many', null];
  const limits: unknown[] = [];
  for (const value of stored) limits.push(await told(value));
  assert.deepEqual(limits, [3, 6, 3, 6, 6, 6, 6], `read as ${JSON.stringify(stored)}`);
});

test('成员额度 counts the members a lead dispatched, not the parallel agents the user started by hand', async t => {
  const { root, harness, studio } = await setupWithStudio(t, 4);
  studio.settings({ defaultSquadSize: 2 });
  const folder = await project(harness, root, 'hand-started', true);
  const lead = await harness.createTask({ projectId: folder.id, isolated: false });
  // Two parallel agents started by hand (启动并行 Agent): one still working, one returned. Neither has a member's name.
  const working = await harness.createTask({ projectId: folder.id, parentId: lead.id, prompt: 'hold' });
  const returned = await harness.createTask({ projectId: folder.id, parentId: lead.id, prompt: 'complete' });
  await until(() => current(harness, working.id).tools.length === 1 && current(harness, returned.id).status === 'completed' && !current(harness, returned.id).workerActive, 'one agent working and one returned');
  await harness.prompt(lead.id, leadScript([
    { method: 'delegate', args: { name: '甲队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '乙队员', prompt: 'hold' } },
    { method: 'delegate', args: { name: '丙队员', prompt: 'hold' } },
    { method: 'steer_agent', args: { agent_id: returned.id, message: 'hold' } },
  ]));
  await until(() => current(harness, lead.id).status === 'completed', 'the lead runs its script', 15_000);
  const results = scriptOutcomes(harness, lead.id);
  assert.deepEqual(results.map(item => item.ok === true), [true, true, false, true], JSON.stringify(results));
  assert.match(results[2].error ?? '', /成员额度是 2 人：现在已有 2 位成员在做或排队，再派 1 位就超了/, 'the two agents started by hand are not among them');
  assert.equal(results[3].ok, true, 'sending a returned agent started by hand back to work takes no place either');
});

test('a custom subagent keeps its 说明 across a restart, and a long one is refused', async t => {
  await skillHome(t);
  const { root, directory, vault, harness } = await setup(t);
  harness.saveAgentRole({ id: 'reviewer', name: '审查员', prompt: '先读改动。\n再列风险。', readOnly: true, description: '  审查改动，列出风险  ' });
  assert.equal(harness.roles().find(role => role.id === 'reviewer')?.description, '审查改动，列出风险');
  assert.throws(() => harness.saveAgentRole({ id: 'long', name: '长', prompt: 'x', readOnly: false, description: '字'.repeat(301) }), /说明/);
  harness.saveAgentRole({ id: 'plain', name: '无说明', prompt: '第一行就是说明。\n第二行。', readOnly: false });
  await harness.close();
  harnesses.delete(root);
  const reopened = new Harness(directory, fakeWorker, vault);
  harnesses.set(root, reopened);
  assert.equal(reopened.roles().find(role => role.id === 'reviewer')?.description, '审查改动，列出风险');
  assert.equal(reopened.roles().find(role => role.id === 'plain')?.description, undefined, 'empty means the first line of the instructions is used');
});

test('a role or role id that is not text is refused in plain words, not with a TypeError', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'role-types');
  for (const role of [5, true, {}, ['explorer']]) await assert.rejects(harness.createTask({ projectId: folder.id, isolated: false, role: role as unknown as string }), /Select an available agent role\./, JSON.stringify(role));
  for (const id of [5, {}, ['reviewer'], null]) assert.throws(() => harness.removeAgentRole(id as unknown as string), /Select a role to remove\./, JSON.stringify(id));
  assert.deepEqual(harness.snapshot().tasks, [], 'a refused role starts no task');
});

test('a gateway’s traffic settings are saved for the next start, and a bad 无响应断开 is refused', async t => {
  const { directory, harness, vault } = await setup(t);
  harness.saveGateway({ ...gateway, upstream: 'nvidia', rateLimit: { enabled: true, perMinute: 30 }, retry: { maxRetries: 5 }, stall: { seconds: 90 } });
  const traffic = () => { const saved = new AppStore(directory).state.gateways.find(item => item.id === gateway.id)!; return [saved.upstream, saved.rateLimit, saved.retry, saved.stall]; };
  assert.deepEqual(traffic(), ['nvidia', { enabled: true, perMinute: 30 }, { maxRetries: 5 }, { seconds: 90 }]);
  for (const stall of [{ seconds: 14 }, { seconds: 301 }, { seconds: 30.5 }, { seconds: '60' }]) {
    assert.throws(() => harness.saveGateway({ ...gateway, stall: stall as never }), /无响应断开/);
  }
  assert.deepEqual(harness.snapshot().gateways[0].stall, { seconds: 90 }, 'a refused save changes nothing');
  harness.saveGateway({ ...gateway, upstream: 'auto' });
  assert.deepEqual(traffic(), [undefined, undefined, undefined, undefined], 'an emptied field is off; auto is the absent upstream');
  assert.equal(vault.get(gateway.id), fixtureKey);
});

test('every worker hears that the desktop process holds its rate slots, with the gateway’s traffic settings', async t => {
  const { root, harness } = await setup(t);
  harness.saveGateway({ ...gateway, retry: { maxRetries: 4 }, stall: { seconds: 45 } });
  const folder = await project(harness, root, 'slots');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'inspect-gateway' });
  await until(() => current(harness, task.id).status === 'completed', 'inspection completes');
  const answer = JSON.parse(current(harness, task.id).messages.findLast(message => message.role === 'assistant')!.text);
  assert.deepEqual(answer, { rateSlots: true, retry: { maxRetries: 4 }, stall: { seconds: 45 } });
});

test('a stopped task gives up its place in the rate-limit queue instead of taking a slot later', async t => {
  const { root, harness } = await setup(t);
  harness.saveGateway({ ...gateway, rateLimit: { enabled: true, perMinute: 1 } });
  const folder = await project(harness, root, 'paced');
  const state = () => harness.rateLimiter.state(gateway.id, 1);
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots' });
  await until(() => state().waiting === 1, 'the second request waiting for a slot');
  assert.equal(state().used, 1);
  await harness.cancelTask(task.id);
  await until(() => state().waiting === 0, 'the wait given up');
  assert.equal(state().used, 1, 'the request that never went out never took a slot');
  await until(() => current(harness, task.id).status === 'cancelled', 'task cancelled');

  // Closing the app gives the waits up too, so no timer holds the process open for a minute.
  await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots' });
  await until(() => state().waiting > 0, 'requests waiting again');
  await harness.close();
  harnesses.delete(root);
  assert.equal(state().waiting, 0);
});

test('a slot request that was already on its way when the task began to stop is refused, not queued', async t => {
  // A stuck worker never says done, so nothing but the refusal can keep the late request out of the queue.
  const { root, harness } = await setup(t);
  harness.saveGateway({ ...gateway, rateLimit: { enabled: true, perMinute: 1 } });
  const folder = await project(harness, root, 'late-slot');
  const state = () => harness.rateLimiter.state(gateway.id, 1);
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots-late' });
  await until(() => state().waiting === 1, 'the second request waiting for a slot');
  await harness.cancelTask(task.id);
  await until(() => current(harness, task.id).messages.some(message => message.text === 'late slot refused: This task is stopping.'), 'the late request refused');
  assert.equal(state().waiting, 0);
});

test('closing the app gives a rate-slot wait up even when its worker never answers the stop', async t => {
  const { root, harness } = await setup(t);
  harness.saveGateway({ ...gateway, rateLimit: { enabled: true, perMinute: 1 } });
  const folder = await project(harness, root, 'hung-slot');
  const state = () => harness.rateLimiter.state(gateway.id, 1);
  await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots-hung' });
  await until(() => state().waiting === 1, 'the second request waiting for a slot');
  await harness.close();
  harnesses.delete(root);
  assert.equal(state().waiting, 0, 'no worker said done, so only close() could give the wait up');
});

test('closing the app tells a worker to stop before it refuses the slot that was waiting, even while another task is still starting', async t => {
  // A refused slot lets its request go out unless the run was already told to stop. A task that is still starting keeps close()
  // from stopping anything for a moment; the waiting request must not be refused in that moment.
  const { root, harness } = await setup(t, 2);
  harness.saveGateway({ ...gateway, rateLimit: { enabled: true, perMinute: 1 } });
  const state = () => harness.rateLimiter.state(gateway.id, 1);
  const waiting = await harness.createTask({ projectId: (await project(harness, root, 'close-order')).id, isolated: false, prompt: 'rate-slots-open' });
  await until(() => state().waiting === 1, 'the second request waiting for a slot');
  harness.saveHooks({ SessionStart: [{ hooks: [{ type: 'command', command: process.platform === 'win32' ? 'Start-Sleep -Milliseconds 800' : 'sleep 1' }] }] });
  const starting = await harness.createTask({ projectId: (await project(harness, root, 'close-order-starting')).id, isolated: false, prompt: 'complete' });
  await until(() => current(harness, starting.id).workerActive === true, 'the second task starting');
  await harness.close();
  harnesses.delete(root);
  const atTheStop = current(harness, waiting.id).messages.find(message => message.text.startsWith('slot-2 at the stop:'))?.text;
  assert.equal(atTheStop, 'slot-2 at the stop: unanswered', 'the stop reached the worker first, and the refusal came after it');
  assert.equal(state().waiting, 0, 'the wait was still given up');
});

test('granting a rate slot publishes the change without writing state.json synchronously', async t => {
  // Every model request of every task asks for a slot; a full synchronous write of the state file each time would stall the app.
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'slot-publish');
  const savedBy: string[] = [];
  const save = harness.store.save.bind(harness.store);
  harness.store.save = () => { savedBy.push(new Error().stack ?? ''); save(); };
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots' });
  await until(() => current(harness, task.id).status === 'completed', 'both requests granted and the run finished');
  const answer = current(harness, task.id).messages.findLast(message => message.role === 'assistant')?.text ?? '';
  assert.deepEqual(JSON.parse(answer.slice('slots:'.length)), { 'slot-1': 'granted', 'slot-2': 'granted' });
  assert.ok(savedBy.length > 0, 'the run itself still saves at its own turning points');
  assert.deepEqual(savedBy.filter(stack => stack.includes('handleRequest')), [], 'none of those writes came from answering a request');
});

test('a request over the per-minute limit shows 排队 and when it may go; the line goes when the task stops', async t => {
  const { root, harness } = await setup(t);
  harness.saveGateway({ ...gateway, rateLimit: { enabled: true, perMinute: 1 } });
  const folder = await project(harness, root, 'queued-net');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots' });
  await until(() => current(harness, task.id).net?.state === 'queued', 'the second request queued');
  const due = current(harness, task.id).net!.until!;
  assert.ok(due > Date.now() + 50_000 && due <= Date.now() + 60_000, 'when the first request leaves the 60-second window');
  await harness.cancelTask(task.id);
  await until(() => current(harness, task.id).status === 'cancelled', 'stopped');
  assert.equal(current(harness, task.id).net, undefined);
});

test('a granted slot takes the line down only when the task has no other request still waiting', async t => {
  // Two requests of one task can be in flight at once (a turn and a compaction summary, say): one going out says nothing of the other.
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'two-waits');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let asked = 0;
  // The first request waits for its slot; the second is granted at once.
  harness.rateLimiter.acquire = async (_gatewayId, _limit, _signal, onWait) => {
    if (asked++ > 0) return;
    onWait?.({ reason: 'limit', until: Date.now() + 60_000 });
    await held;
  };
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'rate-slots-open' });
  await until(() => asked === 2, 'the second request granted');
  assert.equal(current(harness, task.id).net?.state, 'queued', 'the first request still waits, and the line still says so');
  release();
  await until(() => current(harness, task.id).messages.some(message => message.text.startsWith('slots answered:')), 'both requests answered');
  assert.equal(current(harness, task.id).status, 'running', 'the run goes on');
  assert.equal(current(harness, task.id).net, undefined, 'the last request out takes the line down');
});

test('after a 429 the task shows 冷却 at once and keeps it until the retried request goes out', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'cooldown-net');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'cooldown-retry' });
  await until(() => current(harness, task.id).net?.state === 'cooldown', 'the cooldown shown');
  assert.ok(current(harness, task.id).net!.until! > Date.now() + 1_500, 'the 3-second cooldown is still ahead');
  assert.ok(harness.rateLimiter.state(gateway.id, 0).cooldown > 0, 'the whole gateway pauses, not only this task');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(current(harness, task.id).net?.state, 'cooldown', 'pi’s error reply and its retry announcement leave it in place');
  await until(() => current(harness, task.id).status === 'completed', 'the retried request went out once the gateway could send');
  assert.equal(current(harness, task.id).net, undefined);
  assert.equal(current(harness, task.id).messages.findLast(message => message.role === 'assistant')?.text, '重试后完成。');
});

test('a 429 that reaches a task already stopping still pauses the gateway, but leaves the task no 冷却 line', async t => {
  // A worker stopped the hard way never says done, so nothing would take down a line that was shown after the stop.
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'late-cooldown');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'cooldown-late' });
  await until(() => current(harness, task.id).messages.some(message => message.text === 'waiting for the stop'), 'the worker holding on its last request');
  await harness.cancelTask(task.id);
  await until(() => current(harness, task.id).messages.some(message => message.text === 'late cooldown answered'), 'the late 429 reported and answered');
  assert.ok(harness.rateLimiter.state(gateway.id, 0).cooldown > 0, 'every other task of the gateway still pauses');
  assert.equal(current(harness, task.id).net, undefined, 'the stopping task shows no 冷却');
});

test('pi’s automatic retry shows as 重试 with its attempt, until the retried request goes out', async t => {
  const { root, harness } = await setup(t);
  const folder = await project(harness, root, 'retrying');
  const task = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'auto-retry' });
  await until(() => current(harness, task.id).net?.state === 'retrying', 'the retry announced');
  const net = current(harness, task.id).net!;
  assert.deepEqual([net.attempt, net.max], [2, 3]);
  assert.ok(net.until! > Date.now() + 2_000 && net.until! <= Date.now() + 4_000, 'until is the end of the backoff');
  await until(() => current(harness, task.id).net === undefined, 'the retried reply started');
  assert.equal(current(harness, task.id).status, 'running', 'cleared when the request goes out, not when the run ends');
  await until(() => current(harness, task.id).status === 'completed', 'the run finished');

  const compacting = await harness.createTask({ projectId: folder.id, isolated: false, prompt: 'compaction-retry' });
  await until(() => current(harness, compacting.id).net?.state === 'retrying', 'a compaction summary’s retry announced');
  assert.deepEqual([current(harness, compacting.id).net!.attempt, current(harness, compacting.id).net!.max], [1, 2]);
  await until(() => current(harness, compacting.id).net === undefined, 'the summary request went out again');
  assert.equal(current(harness, compacting.id).status, 'running');
  await until(() => current(harness, compacting.id).status === 'completed', 'that run finished');
});
