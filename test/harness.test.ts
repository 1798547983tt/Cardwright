import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { AppStore } from '../src/core/store.ts';
import { Harness } from '../src/main/harness.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';
import type { Gateway, NewSchedule, Preferences, Task } from '../src/shared/types.ts';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
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
    assert.equal(member.role, 'general-purpose');
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
      assert.equal(member.role, 'Explore');
      assert.equal(JSON.parse(member.messages.at(-1)?.text ?? '{}').readOnly, true);
    }
  }
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
