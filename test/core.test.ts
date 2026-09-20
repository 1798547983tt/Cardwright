import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppStore } from '../src/core/store.ts';
import { addProjectInfo, createWorktree, getDiff, mergeWorktree } from '../src/core/git.ts';
import { evaluateSchedule, nextRunAfter, SCHEDULE_GRACE_MS } from '../src/core/scheduler.ts';
import type { Gateway, Project, Schedule, Task } from '../src/shared/types.ts';

const exec = promisify(execFile);
const at = '2026-09-16T10:00:00.000Z';

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-core-test-'));
  t.after(async () => {
    const path = resolve(directory);
    const within = relative(resolve(tmpdir()), path);
    assert.ok(within.startsWith('cardwright-core-test-') && !within.includes('..'));
    await rm(path, { recursive: true, force: true });
  });
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  return stdout.trim();
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task', projectId: 'project', title: 'Fixture task', cwd: '', status: 'completed',
    permission: 'ask', gatewayId: '', thinking: 'medium', createdAt: at, updatedAt: at,
    messages: [], tools: [], ...overrides,
  };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule', name: 'Fixture', projectId: 'project', prompt: 'Read the project.', gatewayId: '',
    thinking: 'medium', permission: 'ask', isolated: false, nextRunAt: at,
    intervalMinutes: 60, enabled: true, missed: false, ...overrides,
  };
}

async function repo(directory: string): Promise<Project> {
  await git(directory, 'init', '-b', 'main');
  await git(directory, 'config', 'user.name', 'Cardwright Fixture');
  await git(directory, 'config', 'user.email', 'fixture@example.invalid');
  await git(directory, 'config', 'core.autocrlf', 'false');
  await writeFile(join(directory, 'tracked.txt'), 'original\n');
  await git(directory, 'add', 'tracked.txt');
  await git(directory, 'commit', '-m', 'Fixture base');
  return { id: 'project', createdAt: at, ...await addProjectInfo(directory) };
}

test('store starts empty, persists atomically, and excludes credentials and approvals', async t => {
  const directory = await fixture(t);
  const store = new AppStore(directory);
  assert.equal(store.state.tasks.length, 0);
  assert.equal(store.state.projects.length, 0);
  assert.equal(store.state.gateways.length, 0);
  assert.equal(store.state.schedules.length, 0);
  const gateway: Gateway & { apiKey: string } = {
    id: 'gateway', name: 'Gateway', baseUrl: 'https://example.invalid/v1', modelId: 'model',
    protocol: 'openai-completions', reasoning: false, contextWindow: 100, maxTokens: 20,
    hasKey: true, apiKey: 'secret-must-not-persist',
  };
  store.state.gateways.push(gateway);
  Object.assign(store.state, { approvals: [{ id: 'pending-approval' }] });
  store.save();
  const contents = await readFile(store.filePath, 'utf8');
  assert.ok(!contents.includes('secret-must-not-persist'));
  assert.ok(!contents.includes('pending-approval'));
  assert.equal(new AppStore(directory).state.gateways[0]?.id, 'gateway');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('store marks interrupted tasks and in-flight tools failed on restart', async t => {
  const store = new AppStore(await fixture(t));
  for (const status of ['queued', 'running', 'waiting'] as const) {
    store.state.tasks.push(task({ id: status, status, tools: [{ id: 'tool', name: 'bash', args: {}, output: '', status: 'waiting', at }] }));
  }
  store.state.tasks.push(task({ id: 'done' }));
  store.save();
  const restarted = new AppStore(store.dataDir);
  for (const item of restarted.state.tasks.slice(0, 3)) {
    assert.equal(item.status, 'failed');
    assert.match(item.error ?? '', /interrupted/i);
    assert.equal(item.tools[0]?.status, 'failed');
  }
  assert.equal(restarted.state.tasks[3]?.status, 'completed');
  assert.equal(new AppStore(store.dataDir).state.tasks[0]?.status, 'failed');
});

test('store preserves last valid state when serialization fails and preserves corrupted input', async t => {
  const store = new AppStore(await fixture(t));
  store.save();
  const before = await readFile(store.filePath, 'utf8');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  store.state.tasks.push(task({ tools: [{ id: 'tool', name: 'fixture', args: circular, output: '', status: 'completed', at }] }));
  assert.throws(() => store.save(), /circular/i);
  assert.equal(await readFile(store.filePath, 'utf8'), before);
  assert.deepEqual((await readdir(store.dataDir)).filter(name => name.endsWith('.tmp')), []);
  await writeFile(store.filePath, '{broken');
  assert.throws(() => new AppStore(store.dataDir), /preserved/);
  assert.equal(await readFile(store.filePath, 'utf8'), '{broken');
});

test('schedule runs once in grace, skips downtime and advances without catch-up replay', () => {
  const due = Date.parse(at);
  const entry = schedule();
  assert.equal(evaluateSchedule(entry, due - 1, due - 2), null);
  assert.equal(evaluateSchedule(entry, due, due - 1000), 'run');
  assert.equal(evaluateSchedule(entry, due + SCHEDULE_GRACE_MS + 1, due + SCHEDULE_GRACE_MS), 'missed');
  assert.equal(evaluateSchedule(entry, due + 1, 0), 'missed');
  assert.equal(evaluateSchedule(entry, due, due - SCHEDULE_GRACE_MS - 1), 'missed');
  assert.equal(evaluateSchedule(schedule({ lastRunAt: at }), due + 1000, due), null);
  assert.equal(evaluateSchedule(schedule({ enabled: false }), due, due - 1000), null);
  assert.equal(evaluateSchedule(schedule({ missed: true }), due, due - 1000), null);
  assert.equal(nextRunAfter(entry, due + 3.5 * 3_600_000), '2026-09-16T14:00:00.000Z');
  assert.equal(nextRunAfter(entry, due), '2026-09-16T11:00:00.000Z');
  assert.equal(nextRunAfter(schedule({ intervalMinutes: null }), due), null);
  assert.equal(nextRunAfter(schedule({ intervalMinutes: 0 }), due), null);
});

test('project detection permits plain folders and worktree isolation rejects dirty projects', async t => {
  const directory = await fixture(t);
  const info = await addProjectInfo(directory);
  assert.equal(info.isGit, false);
  assert.deepEqual(await getDiff(directory), { patch: '', status: 'This folder is not a Git repository.', branch: '', untracked: [] });
  const project = await repo(directory);
  await writeFile(join(directory, 'untracked.txt'), 'local work');
  await assert.rejects(createWorktree(project, 'dirty', join(await fixture(t), 'worktrees')), /uncommitted or untracked/);
  assert.equal(await readFile(join(directory, 'tracked.txt'), 'utf8'), 'original\n');
});

test('diff supports a new Git repository before its first commit', async t => {
  const directory = await fixture(t);
  await git(directory, 'init', '-b', 'main');
  await writeFile(join(directory, 'first.txt'), 'first file\n');
  await git(directory, 'add', 'first.txt');
  await writeFile(join(directory, 'second.txt'), 'untracked file\n');
  const result = await getDiff(directory);
  assert.equal(result.branch, 'main');
  assert.match(result.patch, /first file/);
  assert.deepEqual(result.untracked, ['second.txt']);
});

test('isolated worktree merges tracked, binary and untracked files without altering either index or branch', async t => {
  const project = await repo(await fixture(t));
  const root = await fixture(t);
  const worktree = await createWorktree(project, 'isolated', root);
  const isolated = task({ cwd: worktree.path, worktree });
  assert.equal(worktree.baseBranch, 'main');
  assert.equal(await git(project.path, 'branch', '--show-current'), 'main');
  await writeFile(join(worktree.path, 'tracked.txt'), 'edited in task\n');
  await writeFile(join(worktree.path, 'new file.txt'), 'new content\n');
  await writeFile(join(worktree.path, 'binary.bin'), Buffer.from([0, 255, 1, 2, 0, 128]));
  await writeFile(join(worktree.path, '.gitignore'), 'included-by-choice.txt\n');
  await writeFile(join(worktree.path, 'included-by-choice.txt'), 'explicitly staged ignored content\n');
  await git(worktree.path, 'add', '-f', 'included-by-choice.txt');
  const preview = await getDiff(worktree.path);
  assert.match(preview.patch, /edited in task/);
  assert.ok(preview.untracked.includes('new file.txt'));
  const taskIndexBefore = await git(worktree.path, 'diff', '--cached', '--binary');
  const result = await mergeWorktree(project, isolated);
  assert.match(result.message, /new files/);
  assert.equal(await readFile(join(project.path, 'tracked.txt'), 'utf8'), 'edited in task\n');
  assert.equal(await readFile(join(project.path, 'new file.txt'), 'utf8'), 'new content\n');
  assert.equal(await readFile(join(project.path, 'included-by-choice.txt'), 'utf8'), 'explicitly staged ignored content\n');
  assert.deepEqual(await readFile(join(project.path, 'binary.bin')), Buffer.from([0, 255, 1, 2, 0, 128]));
  assert.equal(await git(project.path, 'rev-parse', 'HEAD'), worktree.baseCommit);
  assert.equal(await git(project.path, 'diff', '--cached', '--binary'), '');
  assert.equal(await git(worktree.path, 'diff', '--cached', '--binary'), taskIndexBefore);
  assert.equal(await git(worktree.path, 'branch', '--show-current'), worktree.branch);
  await assert.rejects(mergeWorktree(project, isolated), /uncommitted or untracked/);
});

test('merge includes task branch commits and later working tree changes', async t => {
  const project = await repo(await fixture(t));
  const worktree = await createWorktree(project, 'committed', await fixture(t));
  await writeFile(join(worktree.path, 'committed.txt'), 'committed on the task branch\n');
  await git(worktree.path, 'add', 'committed.txt');
  await git(worktree.path, 'commit', '-m', 'Task change');
  const taskHead = await git(worktree.path, 'rev-parse', 'HEAD');
  await writeFile(join(worktree.path, 'tracked.txt'), 'subsequent working tree change\n');
  await mergeWorktree(project, task({ cwd: worktree.path, worktree }));
  assert.equal(await readFile(join(project.path, 'committed.txt'), 'utf8'), 'committed on the task branch\n');
  assert.equal(await readFile(join(project.path, 'tracked.txt'), 'utf8'), 'subsequent working tree change\n');
  assert.equal(await git(project.path, 'rev-parse', 'HEAD'), worktree.baseCommit);
  assert.equal(await git(worktree.path, 'rev-parse', 'HEAD'), taskHead);
});

test('worktree review includes the same committed, unstaged, new and binary changes as merge', async t => {
  const project = await repo(await fixture(t));
  const worktree = await createWorktree(project, 'complete-review', await fixture(t));
  await writeFile(join(worktree.path, 'committed.txt'), 'committed task content\n');
  await git(worktree.path, 'add', 'committed.txt');
  await git(worktree.path, 'commit', '-m', 'Committed task result');
  await writeFile(join(worktree.path, 'tracked.txt'), 'unstaged task content\n');
  await writeFile(join(worktree.path, 'new file.txt'), 'new task content\n');
  const binary = Buffer.from([0, 127, 255, 1, 128, 0]);
  await writeFile(join(worktree.path, 'new.bin'), binary);
  const originalIndex = await git(worktree.path, 'diff', '--cached', '--binary');
  const originalHead = await git(worktree.path, 'rev-parse', 'HEAD');
  const preview = await getDiff(worktree.path, worktree.baseCommit);
  assert.match(preview.patch, /committed task content/);
  assert.match(preview.patch, /unstaged task content/);
  assert.match(preview.patch, /new task content/);
  assert.match(preview.patch, /GIT binary patch/);
  for (const name of ['committed.txt', 'tracked.txt', 'new file.txt', 'new.bin']) assert.ok(preview.status.includes(name));
  assert.ok(preview.untracked.includes('new file.txt'));
  assert.ok(preview.untracked.includes('new.bin'));
  assert.equal(await git(worktree.path, 'diff', '--cached', '--binary'), originalIndex);
  assert.equal(await git(worktree.path, 'rev-parse', 'HEAD'), originalHead);
  await mergeWorktree(project, task({ cwd: worktree.path, worktree }));
  assert.equal(await readFile(join(project.path, 'committed.txt'), 'utf8'), 'committed task content\n');
  assert.equal(await readFile(join(project.path, 'tracked.txt'), 'utf8'), 'unstaged task content\n');
  assert.equal(await readFile(join(project.path, 'new file.txt'), 'utf8'), 'new task content\n');
  assert.deepEqual(await readFile(join(project.path, 'new.bin')), binary);
});

test('merge rejects running tasks, a different parent branch, and an advanced parent HEAD', async t => {
  const project = await repo(await fixture(t));
  const worktree = await createWorktree(project, 'guarded', await fixture(t));
  const isolated = task({ cwd: worktree.path, worktree });
  await writeFile(join(worktree.path, 'tracked.txt'), 'task edit\n');
  await assert.rejects(mergeWorktree(project, { ...isolated, status: 'running' }), /complete/);
  await git(project.path, 'checkout', '-b', 'other');
  await assert.rejects(mergeWorktree(project, isolated), /Switch the original project/);
  await git(project.path, 'checkout', 'main');
  await writeFile(join(project.path, 'parent.txt'), 'other work\n');
  await git(project.path, 'add', 'parent.txt');
  await git(project.path, 'commit', '-m', 'Parent advanced');
  await assert.rejects(mergeWorktree(project, isolated), /advanced/);
  assert.equal(await readFile(join(project.path, 'tracked.txt'), 'utf8'), 'original\n');
});
