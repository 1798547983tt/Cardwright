import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AttachmentInfo, FilePreview, WorkspaceEntry } from '../shared/studio-types.ts';
import { readdir } from 'node:fs/promises';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };

export async function workspacePath(root: string, path = ''): Promise<string> {
  const base = await realpath(root); const target = await realpath(resolve(base, path));
  if (!inside(base, target)) throw new Error('Select a file inside this project.');
  return target;
}
export async function listWorkspace(root: string, path = '', query = ''): Promise<WorkspaceEntry[]> {
  const base = await realpath(root); const folder = await workspacePath(base, path); const pending = [folder]; const found: WorkspaceEntry[] = [];
  let visited = 0;
  while (pending.length && found.length < 300 && visited++ < 1000) {
    const current = pending.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const full = join(current, entry.name); const item = { path: relative(base, full).replaceAll('\\', '/'), name: entry.name, directory: entry.isDirectory() };
      if (!query || item.path.toLowerCase().includes(query.toLowerCase())) found.push(item);
      if (query && entry.isDirectory()) pending.push(full);
      if (found.length >= 300) break;
    }
    if (!query) break;
  }
  return found.sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
}

export class AttachmentService {
  readonly root: string;
  private records = new Map<string, AttachmentInfo & { storedPath: string }>();
  constructor(dataDir: string, private imageToPng?: (buffer: Buffer) => Buffer) { this.root = join(dataDir, 'attachments'); }
  async importFile(path: string): Promise<AttachmentInfo> {
    const target = await realpath(path); const info = await stat(target);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Choose a regular file up to 32 MB.');
    const buffer = await readFile(target); const extension = extname(path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      if (buffer.length > 10 * 1024 * 1024) throw new Error('Images must be at most 10 MB.');
      if (!this.imageToPng) throw new Error('Image processing is unavailable.');
      return this.store(this.imageToPng(buffer), basename(path, extension) + '.png', 'image/png', 'image');
    }
    return this.store(buffer, basename(path), extension === '.pdf' ? 'application/pdf' : 'application/octet-stream', 'file');
  }
  async importImage(buffer: Buffer): Promise<AttachmentInfo> {
    if (!buffer.length || buffer.length > 10 * 1024 * 1024 || !this.imageToPng) throw new Error('Clipboard image is empty or too large.');
    return this.store(this.imageToPng(buffer), 'Screenshot.png', 'image/png', 'image');
  }
  private async store(buffer: Buffer, name: string, mimeType: string, kind: AttachmentInfo['kind']): Promise<AttachmentInfo> {
    const id = createHash('sha256').update(buffer).update('\0' + mimeType).digest('hex');
    await mkdir(this.root, { recursive: true });
    const storedPath = join(this.root, id + (kind === 'image' ? '.png' : extname(name).slice(0, 12)));
    try { await writeFile(storedPath, buffer, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const record = { id, name, mimeType, bytes: buffer.length, kind, storedPath };
    await writeFile(join(this.root, id + '.json'), JSON.stringify(record), { mode: 0o600 }); this.records.set(id, record);
    const { storedPath: _path, ...publicRecord } = record; return publicRecord;
  }
  async reference(projectId: string, root: string, path: string): Promise<AttachmentInfo> {
    const target = await workspacePath(root, path); const info = await stat(target);
    if (info.isDirectory()) {
      const entries = await listWorkspace(root, path);
      return this.store(Buffer.from(`Directory reference: ${target}\n${entries.map(entry => entry.path + (entry.directory ? '/' : '')).join('\n')}`), basename(target) + '-files.txt', 'text/plain', 'file');
    }
    const imported = await this.importFile(target);
    return { ...imported, projectId, path: relative(root, target).replaceAll('\\', '/') };
  }
  async resolve(id: string): Promise<AttachmentInfo & { storedPath: string }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid attachment.');
    const record = this.records.get(id) || JSON.parse(await readFile(join(this.root, id + '.json'), 'utf8')) as AttachmentInfo & { storedPath: string };
    const path = await realpath(record.storedPath);
    if (!inside(await realpath(this.root), path) || basename(path).split('.')[0] !== id || record.id !== id) throw new Error('Attachment storage is invalid.');
    const info = await stat(path); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Attachment storage is invalid.');
    const digest = createHash('sha256').update(await readFile(path)).update('\0' + record.mimeType).digest('hex');
    if (digest !== id) throw new Error('The attachment changed after it was added. Add it again before sending.');
    this.records.set(id, record); return record;
  }
  async preview(id: string): Promise<FilePreview> { const record = await this.resolve(id); return previewLocalFile(record.storedPath, record.name); }
}

export async function previewLocalFile(path: string, name = basename(path)): Promise<FilePreview> {
  const info = await stat(path); if (!info.isFile()) throw new Error('Select a file to preview.');
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) && info.size <= 10 * 1024 * 1024) {
    const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : extname(path).toLowerCase() === '.webp' ? 'image/webp' : 'image/jpeg';
    return { path, name, kind: 'image', bytes: info.size, dataUrl: `data:${mime};base64,${(await readFile(path)).toString('base64')}` };
  }
  if (info.size > 1024 * 1024) return { path, name, kind: 'binary', bytes: info.size };
  const buffer = await readFile(path);
  if (buffer.includes(0)) return { path, name, kind: 'binary', bytes: info.size };
  return { path, name, kind: 'text', text: buffer.toString('utf8').slice(0, 256000), bytes: info.size, truncated: buffer.length > 256000 };
}
