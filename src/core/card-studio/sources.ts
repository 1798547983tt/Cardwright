import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { decodeText } from './encoding.ts';
import { countChars, DEFAULT_PART_SIZE, splitChapters, type SplitResult } from './chapters.ts';
import type { SourceImportReport, SourceRecord, SourceSplit } from '../../shared/card-studio/types.ts';

export type { SourceChapter, SourceImportReport, SourceRecord, SourceSplit } from '../../shared/card-studio/types.ts';

/** Material import: copy originals, convert text to UTF-8 chapters and keep 资料/索引.md in step. */
export const SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;
export const SOURCE_INDEX = '资料/索引.md';
const MANIFEST = '资料/.cardwright-sources.json';
const TEXT = new Set(['.txt', '.md']);
const IMAGE = new Set(['.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const CONVERT_FIRST = new Set(['.docx', '.doc', '.pdf', '.epub']);

interface ImportOptions { now?: Date; size?: number; limitBytes?: number }

const at = (root: string, relative: string) => join(root, ...relative.split('/'));

export async function readSourceManifest(root: string): Promise<SourceRecord[]> {
  try {
    const value = JSON.parse(await readFile(at(root, MANIFEST), 'utf8')) as { sources?: SourceRecord[] };
    return Array.isArray(value.sources) ? value.sources : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('资料清单无法读取，请重新导入资料。', { cause: error });
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

function safeFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[\s　]+/g, ' ').trim();
  return Array.from(clean).slice(0, 40).join('').replace(/[. ]+$/, '') || '未命名';
}

function hasCardChunk(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return false;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + length));
    if ((type === 'tEXt' || type === 'iTXt') && ['chara', 'ccv3'].includes(data.toString('latin1', 0, Math.max(0, data.indexOf(0))))) return true;
    if (type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function describeJson(bytes: Buffer): string {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { return '无法解析的 JSON'; }
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (typeof record.spec === 'string' && record.spec.startsWith('chara_card')) return '角色卡';
  if (typeof record.entries === 'object' && record.entries !== null) return '世界书';
  if (Array.isArray(value) ? value.some(item => typeof item === 'object' && item !== null && 'findRegex' in item) : 'findRegex' in record) return '正则';
  if (record.type === 'script') return '脚本';
  return '其他';
}

async function uniqueName(folder: string, name: string): Promise<string> {
  const taken = new Set((await readdir(folder).catch(() => [] as string[])).map(item => item.toLowerCase()));
  const extension = extname(name); const stem = name.slice(0, name.length - extension.length);
  for (let counter = 1; ; counter++) {
    const candidate = counter === 1 ? name : `${stem} (${counter})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function writeChapters(root: string, record: SourceRecord, split: SplitResult, size: number, manual: boolean): Promise<void> {
  const stem = record.name.slice(0, record.name.length - extname(record.name).length);
  const folder = at(root, `资料/分章/${stem}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  record.chapters = [];
  for (const chapter of split.chapters) {
    const file = `${String(chapter.index).padStart(4, '0')}-${safeFileName(chapter.title)}.txt`;
    await writeFile(join(folder, file), chapter.text, 'utf8');
    record.chapters.push({ index: chapter.index, title: chapter.title, ...(chapter.volume ? { volume: chapter.volume } : {}), chars: chapter.chars, path: `资料/分章/${stem}/${file}` });
  }
  record.split = split.mode === 'headings' ? { mode: 'headings', level: split.level!, parts: split.chapters.length } : { mode: 'fixed', parts: split.chapters.length, size, manual };
}

function splitLabel(split: SourceSplit): string {
  if (split.mode === 'headings') return `按章节标题（${split.level}），${split.parts} 份`;
  const size = `约 ${split.size.toLocaleString('en-US')} 字一份`;
  return split.manual ? `按固定字数重新切分（${size}），${split.parts} 份` : `未识别到章节标题，按固定字数切分（${size}），${split.parts} 份`;
}

function kindLabel(record: SourceRecord): string {
  return record.kind === 'text' ? '文本' : record.kind === 'json' ? `JSON 参考资料（${record.note ?? '其他'}）` : record.kind === 'card-png' ? 'PNG 角色卡（参考资料）' : '图片';
}

export function renderSourceIndex(records: SourceRecord[]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = ['# 资料索引', '', '> 由 Cardwright 在导入或重新切分资料后生成，请不要手动修改。', '> 分区 AI：先读本索引，再按任务精读相关的分章文件，不要整本通读。', ''];
  if (!records.length) lines.push('还没有导入资料。', '');
  for (const record of records) {
    lines.push(`## ${record.name}`, '', `- 原件：${record.original}`, `- 类型：${kindLabel(record)}`);
    if (record.kind === 'text' && record.split && record.chapters) {
      lines.push(`- 编码：${record.encoding}`, `- 切分：${splitLabel(record.split)}`, `- 字数：${(record.chars ?? 0).toLocaleString('en-US')}`, '', '| 序号 | 章节标题 | 字数 | 分章文件 |', '| --- | --- | --- | --- |');
      for (const chapter of record.chapters) lines.push(`| ${chapter.index} | ${cell(chapter.volume ? `${chapter.volume} / ${chapter.title}` : chapter.title)} | ${chapter.chars} | ${chapter.path} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function saveManifest(root: string, records: SourceRecord[]): Promise<void> {
  await writeAtomic(at(root, MANIFEST), `${JSON.stringify({ version: 1, sources: records }, null, 2)}\n`);
  await writeAtomic(at(root, SOURCE_INDEX), renderSourceIndex(records));
}

export async function importSources(root: string, paths: string[], options: ImportOptions = {}): Promise<SourceImportReport> {
  const size = options.size ?? DEFAULT_PART_SIZE; const limit = options.limitBytes ?? SOURCE_LIMIT_BYTES;
  const records = await readSourceManifest(root);
  const report: SourceImportReport = { imported: [], rejected: [] };
  const originals = at(root, '资料/原件');
  await mkdir(originals, { recursive: true });
  for (const path of paths) {
    const name = basename(path);
    const info = await stat(path).catch(() => undefined);
    if (!info) { report.rejected.push({ name, reason: '找不到这个文件' }); continue; }
    if (info.isDirectory()) { report.rejected.push({ name, reason: '请选择文件，不支持文件夹' }); continue; }
    const extension = extname(name).toLowerCase();
    if (CONVERT_FIRST.has(extension)) { report.rejected.push({ name, reason: '请先转成 txt 再导入' }); continue; }
    if (!TEXT.has(extension) && !IMAGE.has(extension) && extension !== '.json' && extension !== '.png') { report.rejected.push({ name, reason: '不支持这种文件类型' }); continue; }
    if (info.size > limit) { report.rejected.push({ name, reason: '文件太大（上限 64 MB）' }); continue; }
    const bytes = await readFile(path);
    const finalName = await uniqueName(originals, name);
    await copyFile(path, join(originals, finalName));
    const record: SourceRecord = { name: finalName, kind: 'image', original: `资料/原件/${finalName}`, bytes: bytes.length, importedAt: (options.now ?? new Date()).toISOString() };
    if (TEXT.has(extension)) {
      const decoded = decodeText(bytes);
      record.kind = 'text'; record.encoding = decoded.label; record.chars = countChars(decoded.text);
      await writeChapters(root, record, splitChapters(decoded.text, { size }), size, false);
    } else if (extension === '.json') { record.kind = 'json'; record.note = describeJson(bytes); }
    else if (extension === '.png' && hasCardChunk(bytes)) record.kind = 'card-png';
    records.push(record); report.imported.push(record);
  }
  if (report.imported.length || !(await stat(at(root, SOURCE_INDEX)).catch(() => undefined))) await saveManifest(root, records);
  return report;
}

export async function resplitSource(root: string, name: string, mode: 'auto' | 'fixed', options: ImportOptions = {}): Promise<SourceRecord> {
  const size = options.size ?? DEFAULT_PART_SIZE;
  const records = await readSourceManifest(root);
  const record = records.find(item => item.name === name);
  if (!record) throw new Error(`找不到这份资料：${name}`);
  if (record.kind !== 'text') throw new Error('只有文本资料可以重新切分。');
  const decoded = decodeText(await readFile(at(root, record.original)));
  await writeChapters(root, record, splitChapters(decoded.text, { size, mode }), size, mode === 'fixed');
  await saveManifest(root, records);
  return record;
}
