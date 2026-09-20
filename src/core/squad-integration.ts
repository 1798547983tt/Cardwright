import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CheckpointService, checkpointPathIncluded, currentFile, replaceReviewedFile, ReviewDriftError, type ReviewSnapshot } from './checkpoints.ts';
import { runChecks, type CheckDefinition, type CheckExecutor, type CheckRun } from '../main/check-runner.ts';

export interface IntegrationMember { taskId: string; name?: string; cwd: string; baseCommit?: string }
export interface MemberIntegration { taskId: string; name?: string; status: 'applied' | 'unchanged' | 'conflict'; patchHash: string; paths: string[]; error?: string }
export interface SquadIntegration { id: string; projectPath: string; path: string; baseCommit: string; checkpointId: string; createdAt: string; status: 'ready' | 'conflicted' | 'applied'; members: MemberIntegration[]; checks: CheckRun[]; appliedPaths?: string[]; appliedAt?: string }
export interface PrepareIntegration { projectPath: string; baseCommit: string; members: IntegrationMember[] }
const maximumPatch = 32 * 1024 * 1024;
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const within = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
function git(cwd: string, args: string[], options: { input?: string; indexFile?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: maximumPatch, env: { ...process.env, ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}) } }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(stdout));
    child.stdin?.on('error', () => undefined); child.stdin?.end(options.input);
  });
}
async function repositoryRoot(path: string): Promise<string> { const real = await realpath(path); const root = await realpath((await git(real, ['rev-parse', '--show-toplevel'])).trim()); if (!samePath(real, root)) throw new Error('Integration requires the repository root directory.'); return root; }
async function commitId(cwd: string, ref: string): Promise<string> { if (!/^[a-f0-9]{7,64}$/i.test(ref)) throw new Error('Integration requires a recorded base commit hash.'); return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
async function commonDirectory(cwd: string): Promise<string> { return realpath((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()); }

/** Member changes are combined outside the user's checkout; conflicts never touch it. */
export class SquadIntegrationService {
  readonly root: string;
  readonly checkpoints: CheckpointService;
  private locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string, options: { checkpoints?: CheckpointService } = {}) { this.root = resolve(dataDir, 'integrations'); this.checkpoints = options.checkpoints || new CheckpointService(dataDir); }
  private recordPath(id: string): string { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid integration identifier.'); return join(this.root, 'records', `${id}.json`); }
  private async save(record: SquadIntegration): Promise<void> { const path = this.recordPath(record.id); await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } }
  async get(id: string): Promise<SquadIntegration> { const record = JSON.parse(await readFile(this.recordPath(id), 'utf8')) as SquadIntegration; if (record.id !== id || !within(join(this.root, 'worktrees'), record.path)) throw new Error('Invalid integration record.'); return record; }
  private async exclusive<T>(key: string, callback: () => Promise<T>): Promise<T> { const previous = this.locks.get(key) || Promise.resolve(); const next = previous.catch(() => undefined).then(callback); this.locks.set(key, next); try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); } }
  private async memberPatch(member: IntegrationMember, projectPath: string, base: string): Promise<{ patch: string; paths: string[] }> {
    const cwd = await repositoryRoot(member.cwd); if (samePath(cwd, projectPath)) throw new Error('Select isolated member worktrees for squad integration.');
    if (!samePath(await commonDirectory(cwd), await commonDirectory(projectPath))) throw new Error('A member belongs to another repository.');
    if (member.baseCommit && await commitId(cwd, member.baseCommit) !== base) throw new Error('All members must share the integration base commit.');
    const temporaryIndex = join(this.root, `index-${randomUUID()}`); await mkdir(this.root, { recursive: true });
    try {
      await git(cwd, ['read-tree', base], { indexFile: temporaryIndex });
      await git(cwd, ['add', '-A', '--', '.'], { indexFile: temporaryIndex });
      const patch = await git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base, '--'], { indexFile: temporaryIndex });
      const paths = (await git(cwd, ['diff', '--cached', '--name-only', '-z', base, '--'], { indexFile: temporaryIndex })).split('\0').filter(Boolean);
      if (paths.some(path => !checkpointPathIncluded(path))) throw new Error('This member changes generated files outside checkpoint coverage. Review those files manually.');
      // Links could write outside the review root and cannot be represented by file checkpoints.
      const index = await git(cwd, ['ls-files', '--stage', '-z'], { indexFile: temporaryIndex });
      const baseline = await git(cwd, ['ls-tree', '-r', '-z', base]);
      for (const entry of [...index.split('\0'), ...baseline.split('\0')]) {
        const tab = entry.indexOf('\t'); if (tab !== -1 && /^(120000|160000) /.test(entry) && paths.includes(entry.slice(tab + 1))) throw new Error('Changed symbolic links and submodules need manual integration.');
      }
      return { patch, paths };
    } finally { await rm(temporaryIndex, { force: true }); await rm(`${temporaryIndex}.lock`, { force: true }); }
  }
  async prepare(input: PrepareIntegration): Promise<SquadIntegration> {
    if (!input.members.length || input.members.length > 8 || new Set(input.members.map(member => member.taskId)).size !== input.members.length) throw new Error('Select one to eight distinct squad members.');
    const projectPath = await repositoryRoot(input.projectPath); const base = await commitId(projectPath, input.baseCommit); const id = randomUUID();
    const worktreeRoot = join(this.root, 'worktrees'); await mkdir(worktreeRoot, { recursive: true }); const path = resolve(worktreeRoot, id);
    if (within(projectPath, path) || samePath(projectPath, path)) throw new Error('Integration worktrees must be outside the project.');
    await git(projectPath, ['worktree', 'add', '--detach', path, base]);
    const checkpoint = await this.checkpoints.capture(`integration:${id}`, 'base', path);
    const record: SquadIntegration = { id, projectPath, path, baseCommit: base, checkpointId: checkpoint.id, createdAt: new Date().toISOString(), status: 'ready', members: [], checks: [] };
    await this.save(record);
    for (const member of input.members) {
      let patchHash = ''; let paths: string[] = [];
      try {
        const patch = await this.memberPatch(member, projectPath, base); paths = patch.paths; patchHash = createHash('sha256').update(patch.patch).digest('hex');
        if (!patch.patch.trim()) { record.members.push({ taskId: member.taskId, name: member.name, status: 'unchanged', patchHash, paths }); continue; }
        // --check is non-mutating; a conflicting member never partially applies its patch.
        await git(path, ['apply', '--check', '--index', '--binary', '-'], { input: patch.patch });
        await git(path, ['apply', '--index', '--binary', '-'], { input: patch.patch });
        record.members.push({ taskId: member.taskId, name: member.name, status: 'applied', patchHash, paths });
      } catch (error) { record.status = 'conflicted'; record.members.push({ taskId: member.taskId, name: member.name, status: 'conflict', patchHash, paths, error: error instanceof Error ? error.message : String(error) }); }
      await this.save(record);
    }
    await this.save(record); return record;
  }
  async review(id: string): Promise<ReviewSnapshot> { const record = await this.get(id); await this.assertIntegration(record); return this.checkpoints.diff(record.checkpointId); }
  private async assertIntegration(record: SquadIntegration): Promise<void> {
    if (!samePath(await repositoryRoot(record.path), record.path) || !samePath(await commonDirectory(record.path), await commonDirectory(record.projectPath))) throw new Error('The integration worktree no longer belongs to its project.');
    if ((await git(record.path, ['rev-parse', 'HEAD'])).trim() !== record.baseCommit) throw new Error('The integration base changed. Prepare a new integration.');
  }
  async check(id: string, checks: CheckDefinition[], execute: CheckExecutor, signal?: AbortSignal, onRun?: (run: CheckRun) => void): Promise<CheckRun[]> {
    return this.exclusive(id, async () => { const record = await this.get(id); if (record.status !== 'ready') throw new Error('Resolve conflicting members before verifying this integration.'); const review = await this.review(id);
      const runs = await runChecks({ checks, execute, signal, onRun, cwd: record.path, revision: review.revision, changedPaths: review.files.map(file => file.path) }); record.checks.push(...runs); await this.save(record); return runs;
    });
  }
  /** Apply only the previewed affected files; unrelated dirty files are preserved. */
  async applyReviewed(id: string, expectedRevision: string): Promise<{ message: string; files: string[] }> {
    return this.exclusive(id, async () => {
      const record = await this.get(id); if (record.status !== 'ready') throw new Error(record.status === 'applied' ? 'This integration was already applied.' : 'This integration has conflicting members. Prepare it again after resolving them.');
      await this.assertIntegration(record); if (!samePath(await repositoryRoot(record.projectPath), record.projectPath)) throw new Error('The original project directory changed.');
      const review = await this.review(id); if (review.revision !== expectedRevision) throw new Error('The integration changed since review. Refresh before applying.');
      const planned: Array<{ path: string; expectedHash: string | null; bytes: Buffer | null; mode?: number }> = [];
      for (const file of review.files) {
        const target = await currentFile(record.projectPath, file.path); if ((target?.info.hash ?? null) !== file.beforeHash) throw new ReviewDriftError(file.path);
        const source = await currentFile(record.path, file.path); if ((source?.info.hash ?? null) !== file.afterHash) throw new ReviewDriftError(file.path);
        planned.push({ path: file.path, expectedHash: file.beforeHash, bytes: source?.bytes ?? null, mode: source?.info.mode });
      }
      // Root must serialize target writers. Persist progress so a rare I/O failure is inspectable.
      record.appliedPaths = [];
      for (const file of planned) {
        try { await replaceReviewedFile(record.projectPath, file.path, file.expectedHash, file.bytes, file.mode); record.appliedPaths.push(file.path); await this.save(record); }
        catch (error) { throw new Error(`Integration stopped after ${record.appliedPaths.length} file(s). Already applied: ${record.appliedPaths.join(', ') || 'none'}. ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      }
      record.status = 'applied'; record.appliedAt = new Date().toISOString(); await this.save(record);
      return { message: 'Reviewed squad changes were applied. Existing unrelated edits and member worktrees are preserved.', files: record.appliedPaths };
    });
  }
}
