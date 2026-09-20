import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyPatch, formatPatch, reversePatch, structuredPatch } from 'diff';

export interface SnapshotFile { hash: string; size: number; mode: number }
export interface SnapshotCoverage { omitted: Array<{ path: string; reason: string }>; files: number; bytes: number }
export interface Checkpoint { id: string; taskId: string; turnId: string; cwd: string; createdAt: string; files: Record<string, SnapshotFile>; revision: string; coverage: SnapshotCoverage }
export interface ReviewHunk { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[]; accepted: boolean }
export interface ReviewFile { path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash: string | null; afterHash: string | null; beforeBytes: number; afterBytes: number; binary: boolean; patch: string; hunks: ReviewHunk[]; accepted: boolean; note?: string }
export interface ReviewSnapshot { checkpointId: string; cwd: string; revision: string; files: ReviewFile[]; coverage: SnapshotCoverage }
export interface ReviewAction { checkpointId: string; path: string; hunkId?: string; action: 'accept' | 'revert'; expectedHash: string | null }
export interface ReviewAudit extends ReviewAction { id: string; at: string; resultHash: string | null }
export interface ReviewComment { id: string; checkpointId: string; path: string; line?: number; side: 'before' | 'after'; text: string; at: string; fileHash: string | null }
export interface CheckpointLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxDiffBytes: number }
interface Manifest extends Checkpoint { version: 1; audit: ReviewAudit[]; comments: ReviewComment[] }
const defaults: CheckpointLimits = { maxFiles: 20000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxDiffBytes: 2 * 1024 * 1024 };
const excludedNames = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', 'coverage']);
export const checkpointPathIncluded = (path: string): boolean => !path.replaceAll('\\', '/').split('/').some(part => excludedNames.has(part) || part.startsWith('.cardwright-restore-'));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
export class ReviewDriftError extends Error { constructor(readonly path: string) { super(`File changed since this review was opened: ${path}. Refresh the review before continuing.`); this.name = 'ReviewDriftError'; } }

export function snapshotRevision(files: Record<string, SnapshotFile>): string {
  return sha(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}
function childOf(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function cleanRelative(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Use a project-relative file path.');
  return path;
}
async function rootPath(cwd: string): Promise<string> { const root = await realpath(resolve(cwd)); if (!(await stat(root)).isDirectory()) throw new Error('The checkpoint root is not a directory.'); return root; }

/** Reject every symlink in the path, including a replaced parent of a deleted file. */
export async function safeReviewPath(cwd: string, path: string): Promise<string> {
  const root = await rootPath(cwd); const parts = cleanRelative(path).split('/'); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try { const entry = await lstat(current); if (entry.isSymbolicLink() || (i < parts.length - 1 && !entry.isDirectory()) || (i === parts.length - 1 && !entry.isFile())) throw new Error(`The review path is no longer an ordinary file: ${path}`); }
    catch (error) { if (!missing(error)) throw error; }
  }
  if (!childOf(root, current)) throw new Error('The review path is outside the project.');
  return current;
}
export async function currentFile(cwd: string, path: string, maxBytes = defaults.maxFileBytes): Promise<{ bytes: Buffer; info: SnapshotFile } | null> {
  const resolved = await safeReviewPath(cwd, path);
  try {
    // Opening without following the leaf closes the common link-replacement race.
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { const entry = await handle.stat(); if (!entry.isFile()) throw new Error(`Not an ordinary file: ${path}`); if (entry.size > maxBytes) throw new Error(`File exceeds the checkpoint size limit: ${path}`); const bytes = await handle.readFile(); if (bytes.length > maxBytes) throw new Error(`File grew beyond the checkpoint size limit: ${path}`); return { bytes, info: { hash: sha(bytes), size: bytes.length, mode: entry.mode & 0o777 } }; }
    finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}
export function textContent(bytes: Buffer): string | undefined { if (bytes.includes(0)) return undefined; try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; } }

/** Uses content hashes rather than timestamps and never follows links or build trees. */
export async function scanProject(cwd: string, options: { limits?: Partial<CheckpointLimits>; exclude?: string[]; onFile?: (bytes: Buffer, file: SnapshotFile) => Promise<void> } = {}): Promise<{ files: Record<string, SnapshotFile>; coverage: SnapshotCoverage }> {
  const root = await rootPath(cwd); const limits = { ...defaults, ...options.limits }; const files: Record<string, SnapshotFile> = Object.create(null); const coverage: SnapshotCoverage = { omitted: [], files: 0, bytes: 0 }; let directories = 0;
  const exclusions = (options.exclude || []).map(path => resolve(path));
  async function visit(directory: string, prefix: string): Promise<void> {
    if (++directories > limits.maxFiles + 2000) throw new Error('The project has too many directories for a bounded checkpoint.');
    const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = join(directory, entry.name);
      if (!checkpointPathIncluded(entry.name) || exclusions.some(excluded => childOf(excluded, absolute))) { coverage.omitted.push({ path, reason: 'Generated files or application storage' }); continue; }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { coverage.omitted.push({ path, reason: 'Symbolic links are not followed' }); continue; }
      if (info.isDirectory()) { await visit(absolute, path); continue; }
      if (!info.isFile()) { coverage.omitted.push({ path, reason: 'Not an ordinary file' }); continue; }
      if (info.size > limits.maxFileBytes) throw new Error(`Checkpoint file exceeds ${limits.maxFileBytes} bytes: ${path}`);
      if (coverage.files + 1 > limits.maxFiles || coverage.bytes + info.size > limits.maxTotalBytes) throw new Error('The project exceeds the checkpoint size limit.');
      const content = await currentFile(root, path, limits.maxFileBytes); if (!content) throw new Error(`A file changed while taking the checkpoint: ${path}`);
      if (content.info.size > limits.maxFileBytes || coverage.bytes + content.info.size > limits.maxTotalBytes) throw new Error(`A file grew beyond the checkpoint size limit: ${path}`);
      files[path] = content.info; coverage.files++; coverage.bytes += content.info.size; await options.onFile?.(content.bytes, content.info);
    }
  }
  await visit(root, ''); return { files, coverage };
}

/** Atomic replacement for one file. Caller serializes project writers and preflights batches. */
export async function replaceReviewedFile(cwd: string, path: string, expectedHash: string | null, bytes: Buffer | null, mode?: number): Promise<string | null> {
  const destination = await safeReviewPath(cwd, path); const previous = await currentFile(cwd, path);
  if ((previous?.info.hash ?? null) !== expectedHash) throw new ReviewDriftError(path);
  if (bytes === null) { if (previous) { if ((await currentFile(cwd, path))?.info.hash !== expectedHash) throw new ReviewDriftError(path); await rm(destination); } return null; }
  await mkdir(dirname(destination), { recursive: true }); await safeReviewPath(cwd, path);
  const temporary = join(dirname(destination), `.cardwright-restore-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: mode ?? previous?.info.mode ?? 0o600 });
    if ((await currentFile(cwd, path))?.info.hash !== (expectedHash ?? undefined)) throw new ReviewDriftError(path);
    await safeReviewPath(cwd, path); await rename(temporary, destination);
    if (mode !== undefined && process.platform !== 'win32') await chmod(destination, mode);
    return sha(bytes);
  } finally { await rm(temporary, { force: true }); }
}

export class CheckpointService {
  readonly root: string;
  private readonly limits: CheckpointLimits;
  private locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string, options: { limits?: Partial<CheckpointLimits> } = {}) { this.root = resolve(dataDir, 'checkpoints'); this.limits = { ...defaults, ...options.limits }; }
  private file(id: string): string { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid checkpoint identifier.'); return join(this.root, 'manifests', `${id}.json`); }
  private blob(hash: string): string { if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid snapshot hash.'); return join(this.root, 'blobs', hash.slice(0, 2), hash); }
  private async storeBlob(bytes: Buffer, file: SnapshotFile): Promise<void> { const path = this.blob(file.hash); await mkdir(dirname(path), { recursive: true }); try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; } }
  async readBlob(hash: string): Promise<Buffer> { const bytes = await readFile(this.blob(hash)); if (sha(bytes) !== hash) throw new Error('The checkpoint content failed its integrity check.'); return bytes; }
  private async load(id: string): Promise<Manifest> { const value = JSON.parse(await readFile(this.file(id), 'utf8')) as Manifest; if (value.version !== 1 || value.id !== id || snapshotRevision(value.files) !== value.revision) throw new Error('Invalid checkpoint manifest.'); value.files = Object.assign(Object.create(null), value.files); return value; }
  private async save(value: Manifest): Promise<void> { const path = this.file(value.id); await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } }
  private async exclusive<T>(key: string, callback: () => Promise<T>): Promise<T> { const previous = this.locks.get(key) || Promise.resolve(); const next = previous.catch(() => undefined).then(callback); this.locks.set(key, next); try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); } }
  async capture(taskId: string, turnId: string, cwd: string): Promise<Checkpoint> {
    if (!taskId || !turnId) throw new Error('A checkpoint needs a task and turn identifier.');
    const root = await rootPath(cwd); const scan = await scanProject(root, { limits: this.limits, exclude: [this.root], onFile: (bytes, info) => this.storeBlob(bytes, info) });
    const value: Manifest = { version: 1, id: randomUUID(), taskId, turnId, cwd: root, createdAt: new Date().toISOString(), ...scan, revision: snapshotRevision(scan.files), audit: [], comments: [] };
    await this.save(value); return this.publicCheckpoint(value);
  }
  private publicCheckpoint({ version: _version, audit: _audit, comments: _comments, ...checkpoint }: Manifest): Checkpoint { return checkpoint; }
  async get(id: string): Promise<Checkpoint> { return this.publicCheckpoint(await this.load(id)); }
  async list(taskId?: string): Promise<Checkpoint[]> {
    let names: string[]; try { names = await readdir(join(this.root, 'manifests')); } catch (error) { if (missing(error)) return []; throw error; }
    const checkpoints: Checkpoint[] = []; for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) { const value = await this.get(name.slice(0, -5)); if (!taskId || value.taskId === taskId) checkpoints.push(value); }
    return checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async diff(id: string): Promise<ReviewSnapshot> {
    const checkpoint = await this.load(id); if (resolve(await rootPath(checkpoint.cwd)) !== resolve(checkpoint.cwd)) throw new Error('The checkpoint project directory changed.'); const current = await scanProject(checkpoint.cwd, { limits: this.limits, exclude: [this.root] }); const files: ReviewFile[] = [];
    const omitted = [...checkpoint.coverage.omitted, ...current.coverage.omitted];
    for (const path of [...new Set([...Object.keys(checkpoint.files), ...Object.keys(current.files)])].sort()) {
      if (omitted.some(entry => path === entry.path || path.startsWith(`${entry.path}/`))) continue;
      const before = checkpoint.files[path]; const after = current.files[path]; if (before?.hash === after?.hash) continue;
      const oldBytes = before ? await this.readBlob(before.hash) : Buffer.alloc(0); const live = after ? await currentFile(checkpoint.cwd, path) : null;
      if ((live?.info.hash ?? null) !== (after?.hash ?? null)) throw new ReviewDriftError(path);
      const newBytes = live?.bytes || Buffer.alloc(0); const oldText = textContent(oldBytes); const newText = textContent(newBytes); const binary = oldText === undefined || newText === undefined;
      const file: ReviewFile = { path, kind: !before ? 'added' : !after ? 'deleted' : 'modified', beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null, beforeBytes: oldBytes.length, afterBytes: newBytes.length, binary, patch: '', hunks: [], accepted: checkpoint.audit.some(entry => entry.path === path && !entry.hunkId && entry.action === 'accept' && entry.expectedHash === (after?.hash ?? null)) };
      if (!binary && oldBytes.length + newBytes.length <= this.limits.maxDiffBytes) {
        const patch = structuredPatch(before ? `a/${path}` : '/dev/null', after ? `b/${path}` : '/dev/null', oldText!, newText!, '', '', { context: 3, timeout: 250 });
        if (patch) { file.patch = formatPatch(patch); file.hunks = patch.hunks.map(hunk => { const hunkId = sha(JSON.stringify([path, file.beforeHash, file.afterHash, hunk])); return { ...hunk, id: hunkId, accepted: file.accepted || checkpoint.audit.some(entry => entry.path === path && entry.action === 'accept' && entry.hunkId === hunkId && entry.expectedHash === file.afterHash) }; }); }
        else file.note = 'Text diff exceeded its time limit. File-level review is available.';
      } else file.note = binary ? 'Binary file: review and restore the whole file.' : 'Large file: review and restore the whole file.';
      files.push(file);
    }
    return { checkpointId: id, cwd: checkpoint.cwd, revision: snapshotRevision(current.files), files, coverage: current.coverage };
  }
  async reviewAction(input: ReviewAction): Promise<ReviewSnapshot> {
    return this.exclusive(input.checkpointId, async () => {
      if (!['accept', 'revert'].includes(input.action)) throw new Error('Unknown review action.');
      cleanRelative(input.path); const checkpoint = await this.load(input.checkpointId); const review = await this.diff(input.checkpointId); const file = review.files.find(file => file.path === input.path);
      if (!file || file.afterHash !== input.expectedHash) throw new ReviewDriftError(input.path);
      let resultHash = file.afterHash;
      if (input.hunkId && !file.hunks.some(hunk => hunk.id === input.hunkId)) throw new Error('This code block changed. Refresh the review.');
      if (input.action === 'revert') {
        let bytes: Buffer | null = file.beforeHash ? await this.readBlob(file.beforeHash) : null;
        if (input.hunkId) {
          const hunk = file.hunks.find(hunk => hunk.id === input.hunkId)!; const live = await currentFile(checkpoint.cwd, input.path);
          if ((live?.info.hash ?? null) !== input.expectedHash) throw new ReviewDriftError(input.path);
          const source = live ? textContent(live.bytes) : ''; if (source === undefined) throw new Error('A binary file cannot be reverted by code block.');
          const reversed = reversePatch({ oldFileName: input.path, newFileName: input.path, oldHeader: '', newHeader: '', hunks: [{ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines }] });
          const result = applyPatch(source, reversed, { fuzzFactor: 0, autoConvertLineEndings: false }); if (result === false) throw new ReviewDriftError(input.path);
          bytes = !file.beforeHash && result === '' ? null : Buffer.from(result);
        }
        resultHash = await replaceReviewedFile(checkpoint.cwd, input.path, input.expectedHash, bytes, checkpoint.files[input.path]?.mode);
      } else if ((await currentFile(checkpoint.cwd, input.path))?.info.hash !== (input.expectedHash ?? undefined)) throw new ReviewDriftError(input.path);
      checkpoint.audit.push({ ...input, id: randomUUID(), at: new Date().toISOString(), resultHash }); await this.save(checkpoint);
      return this.diff(input.checkpointId);
    });
  }
  async addComment(input: Omit<ReviewComment, 'id' | 'at' | 'fileHash'>): Promise<ReviewComment> {
    return this.exclusive(input.checkpointId, async () => { cleanRelative(input.path); if (!input.text.trim() || input.text.length > 10000 || (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) || !['before', 'after'].includes(input.side)) throw new Error('Enter a valid review comment.');
      const value = await this.load(input.checkpointId); const change = (await this.diff(input.checkpointId)).files.find(file => file.path === input.path); if (!change) throw new Error('The commented file is not in this review.');
      const comment = { ...input, text: input.text.trim(), id: randomUUID(), at: new Date().toISOString(), fileHash: input.side === 'before' ? change.beforeHash : change.afterHash }; value.comments.push(comment); await this.save(value); return comment;
    });
  }
  async listComments(id: string): Promise<ReviewComment[]> { return (await this.load(id)).comments; }
  async listAudit(id: string): Promise<ReviewAudit[]> { return (await this.load(id)).audit; }
}
