import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { DiffResult, Project, Task } from '../shared/types.ts';

const MAX_PATCH_BYTES = 32 * 1024 * 1024;

function runGit(cwd: string, args: string[], options: { input?: string; indexFile?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', ['--no-optional-locks', ...args], {
      cwd, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_PATCH_BYTES,
      timeout: 60_000,
      env: { ...process.env, ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}) },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        const wrapped = new Error(`Git ${args[0]} failed: ${detail}`, { cause: error });
        Object.assign(wrapped, { code: error.code });
        reject(wrapped);
      } else resolvePromise(stdout);
    });
    child.stdin?.on('error', () => { /* execFile reports the authoritative process error. */ });
    child.stdin?.end(options.input);
  });
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

async function cleanRepository(cwd: string): Promise<void> {
  if ((await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) {
    throw new Error('The original project has uncommitted or untracked changes. Commit or move those changes before creating or merging an isolated task.');
  }
}

async function branchName(cwd: string): Promise<string> {
  try { return (await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
  catch { throw new Error('The repository has a detached HEAD. Select a branch before using isolated tasks.'); }
}

export async function addProjectInfo(path: string): Promise<Pick<Project, 'name' | 'path' | 'isGit'>> {
  const directory = await realpath(resolve(path));
  if (!(await stat(directory)).isDirectory()) throw new Error('Choose a project folder.');
  try {
    const root = await realpath((await runGit(directory, ['rev-parse', '--show-toplevel'])).trim());
    return { name: basename(root), path: root, isGit: true };
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      return { name: basename(directory), path: directory, isGit: false };
    }
    throw error;
  }
}

/** A squad can still research in read-only mode when a clean Git base is unavailable. */
export async function canCreateIsolatedTasks(project: Project): Promise<boolean> {
  if (!project.isGit) return false;
  try { await cleanRepository(project.path); await branchName(project.path); await runGit(project.path, ['rev-parse', '--verify', 'HEAD']); return true; }
  catch { return false; }
}

export async function createWorktree(project: Project, taskId: string, worktreeRoot: string): Promise<NonNullable<Task['worktree']>> {
  if (!project.isGit) throw new Error('An isolated task requires a Git repository with an initial commit. Use a local task for this folder.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(taskId)) throw new Error('Invalid task identifier.');
  await cleanRepository(project.path);
  const baseBranch = await branchName(project.path);
  let baseCommit: string;
  try { baseCommit = (await runGit(project.path, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch { throw new Error('Create an initial Git commit before starting an isolated task.'); }
  await mkdir(worktreeRoot, { recursive: true });
  const root = await realpath(worktreeRoot);
  const insideProject = relative(await realpath(project.path), root);
  if (!isAbsolute(insideProject) && (insideProject === '' || (!insideProject.startsWith('..') && insideProject !== '..'))) {
    throw new Error('Store isolated worktrees outside the original project folder.');
  }
  const path = resolve(root, taskId);
  const descendant = relative(root, path);
  if (!descendant || descendant.startsWith('..') || isAbsolute(descendant)) throw new Error('Worktree path is outside the application worktree folder.');
  const branch = `cardwright/${taskId}`;
  await runGit(project.path, ['worktree', 'add', '-b', branch, path, baseCommit]);
  return { path, branch, baseBranch, baseCommit };
}

/** Snapshot the complete working tree without changing its real Git index. */
async function worktreeChanges(cwd: string, baseCommit: string): Promise<{ patch: string; status: string }> {
  const base = (await runGit(cwd, ['rev-parse', '--verify', '--end-of-options', `${baseCommit}^{commit}`])).trim();
  const temporaryIndex = join(tmpdir(), `cardwright-review-${randomUUID()}.index`);
  try {
    const indexPath = (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    try { await copyFile(indexPath, temporaryIndex); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await runGit(cwd, ['read-tree', 'HEAD'], { indexFile: temporaryIndex });
    }
    await runGit(cwd, ['add', '-A', '--', '.'], { indexFile: temporaryIndex });
    const [patch, status] = await Promise.all([
      runGit(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base, '--'], { indexFile: temporaryIndex }),
      runGit(cwd, ['diff', '--cached', '--name-status', '--no-ext-diff', '--no-textconv', base, '--'], { indexFile: temporaryIndex }),
    ]);
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('The worktree patch exceeds 32 MiB. Review and merge it manually.');
    return { patch, status };
  } finally {
    await rm(temporaryIndex, { force: true });
    await rm(`${temporaryIndex}.lock`, { force: true });
  }
}

export async function getDiff(cwd: string, baseCommit?: string): Promise<DiffResult> {
  const info = await addProjectInfo(cwd);
  if (!info.isGit) return { patch: '', status: 'This folder is not a Git repository.', branch: '', untracked: [] };
  if (baseCommit !== undefined) {
    const [changes, branch, names] = await Promise.all([
      worktreeChanges(cwd, baseCommit),
      runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    return { ...changes, branch: branch.trim(), untracked: names.split('\0').filter(Boolean) };
  }
  let hasCommit = true;
  try { await runGit(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { hasCommit = false; }
  const [patch, status, branch, names] = await Promise.all([
    hasCommit
      ? runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])
      : Promise.all([
        runGit(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']),
        runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--']),
      ]).then(parts => parts.join('\n')),
    runGit(cwd, ['status', '--short']),
    hasCommit ? runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : branchName(cwd),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return { patch, status, branch: branch.trim(), untracked: names.split('\0').filter(Boolean) };
}

export async function mergeWorktree(project: Project, task: Task): Promise<{ message: string }> {
  if (!task.worktree || !project.isGit || task.projectId !== project.id) throw new Error('This task has no isolated worktree for this project.');
  if (task.status !== 'completed') throw new Error('Wait for the isolated task to complete before merging its changes.');
  const worktree = task.worktree;
  const taskRoot = await realpath((await runGit(worktree.path, ['rev-parse', '--show-toplevel'])).trim());
  if (!samePath(taskRoot, worktree.path)) throw new Error('The task worktree path no longer matches its repository.');
  const [parentCommon, taskCommon] = await Promise.all([
    runGit(project.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    runGit(worktree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (!samePath(parentCommon.trim(), taskCommon.trim())) throw new Error('The task worktree belongs to a different repository.');
  if (await branchName(worktree.path) !== worktree.branch) throw new Error('The task branch changed. Restore its original branch before merging.');

  const assertParent = async (): Promise<void> => {
    await cleanRepository(project.path);
    if (await branchName(project.path) !== worktree.baseBranch) throw new Error(`Switch the original project to ${worktree.baseBranch} before merging.`);
    if ((await runGit(project.path, ['rev-parse', 'HEAD'])).trim() !== worktree.baseCommit) {
      throw new Error('The original project advanced since this task started. Review and merge its branch manually to preserve both histories.');
    }
  };
  await assertParent();
  const { patch } = await worktreeChanges(worktree.path, worktree.baseCommit);
  if (!patch.trim()) return { message: 'There are no changes to merge.' };
  await assertParent();
  await runGit(project.path, ['apply', '--check', '--binary', '-'], { input: patch });
  await runGit(project.path, ['apply', '--binary', '-'], { input: patch });
  return { message: 'Changes, including new files, were applied to the original project. Review and commit them when ready. The isolated branch is preserved.' };
}
