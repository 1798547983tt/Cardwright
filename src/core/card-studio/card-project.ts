import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CardChange, CardChangeItem, CardDispatch, CardKind, CoverStyleId } from '../../shared/card-studio/types.ts';

/** The app-maintained registration inside every card project folder. The AI may read it but never writes it. */
export const CARD_FILE = '卡项目.json';
export const CARD_SCHEMA = 'cardwright.card-project';
export const CARD_FOLDERS = ['资料/原件', '资料/分章', '世界书/叙事规则', '世界书/总览', '世界书/设定', '世界书/变量', '世界书/正文格式', '世界书/人设', '世界书/剧情', '脚本', '正则', '开场白', '封面', '导出'] as const;
export const COVER_STYLES: readonly CoverStyleId[] = ['vermilion', 'archive', 'terminal', 'theatre', 'gilded'];

export interface CardProjectFile {
  schema: typeof CARD_SCHEMA; version: 1; cardId: string; name: string; kind: CardKind; source?: string;
  coverStyle: CoverStyleId; cover?: string; stylePreset: { id: string; name: string } | null;
  origin: 'new' | 'import'; createdAt: string; updatedAt: string; dispatches: CardDispatch[]; exports: unknown[];
  /** The next world book uid to hand out. It only grows, so a deleted entry never gives its uid to another one. */
  nextUid: number;
  /** 改动单 (§5.4), oldest first. */
  changes: CardChange[];
}

const DISPATCH_STATUSES = new Set(['todo', 'active', 'done']);
const CHANGE_STATUSES = new Set(['draft', 'running', 'paused', 'done', 'dropped']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

export function validateCardName(value: unknown): string {
  const name = isString(value) ? value.trim() : '';
  if (!name) throw new Error('请填写卡名。');
  if ([...name].length > 40) throw new Error('卡名不能超过 40 个字。');
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new Error('卡名不能包含 \\ / : * ? " < > | 这些字符。');
  return name;
}

export function validateSource(value: unknown): string {
  const source = isString(value) ? value.trim() : '';
  if (!source) throw new Error('请填写原作名。');
  if ([...source].length > 60) throw new Error('原作名不能超过 60 个字。');
  return source;
}

function validDispatch(value: unknown): value is CardDispatch {
  return isRecord(value) && ['id', 'target', 'title', 'requires', 'body', 'createdAt', 'updatedAt'].every(key => isString(value[key]))
    && (value.sectionId === null || isString(value.sectionId)) && DISPATCH_STATUSES.has(String(value.status))
    && (value.sourceTaskId === undefined || isString(value.sourceTaskId)) && (value.changeId === undefined || isString(value.changeId));
}

function validChangeItem(value: unknown): value is CardChangeItem {
  return isRecord(value) && ['id', 'target', 'title', 'requires', 'body'].every(key => isString(value[key])) && (value.sectionId === null || isString(value.sectionId));
}

/** A 改动单 as written by the app. One that does not read as one is left out rather than failing the whole card. */
function validChange(value: unknown): value is CardChange {
  return isRecord(value) && ['id', 'text', 'createdAt', 'updatedAt'].every(key => isString(value[key]))
    && (value.kind === 'request' || value.kind === 'error') && CHANGE_STATUSES.has(String(value.status))
    && Array.isArray(value.items) && value.items.every(validChangeItem)
    && Array.isArray(value.dispatchIds) && value.dispatchIds.every(isString)
    && (value.direct === undefined || (Array.isArray(value.direct) && value.direct.every(isString)))
    && ['taskId', 'note'].every(key => value[key] === undefined || isString(value[key]));
}

export function parseCardFile(value: unknown): CardProjectFile {
  if (!isRecord(value) || value.schema !== CARD_SCHEMA) throw new Error('这不是卡项目登记文件（卡项目.json）。');
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error('卡项目.json 的版本号无效。');
  if (Number(value.version) > 1) throw new Error('这个卡项目由更新版本的 Cardwright 创建，请升级后再打开。');
  if (!isString(value.cardId) || !value.cardId) throw new Error('卡项目.json 缺少卡项目编号。');
  if (!isString(value.name) || !value.name.trim()) throw new Error('卡项目.json 缺少卡名。');
  if (value.kind !== 'fan' && value.kind !== 'original') throw new Error('卡项目类型必须是同人或原创。');
  if (!isString(value.createdAt) || !isString(value.updatedAt)) throw new Error('卡项目.json 缺少时间信息。');
  if (value.dispatches !== undefined && (!Array.isArray(value.dispatches) || !value.dispatches.every(validDispatch))) throw new Error('卡项目.json 里的派单记录无效。');
  const preset = isRecord(value.stylePreset) && isString(value.stylePreset.id) && isString(value.stylePreset.name) ? { id: value.stylePreset.id, name: value.stylePreset.name } : null;
  const file: Record<string, unknown> = {
    ...value, schema: CARD_SCHEMA, version: 1, cardId: value.cardId, name: value.name.trim(), kind: value.kind,
    coverStyle: COVER_STYLES.includes(value.coverStyle as CoverStyleId) ? value.coverStyle : COVER_STYLES[0], stylePreset: preset,
    origin: value.origin === 'import' ? 'import' : 'new', createdAt: value.createdAt, updatedAt: value.updatedAt,
    dispatches: (value.dispatches as CardDispatch[] | undefined) ?? [], exports: Array.isArray(value.exports) ? value.exports : [],
    nextUid: Number.isInteger(value.nextUid) && Number(value.nextUid) >= 0 ? Number(value.nextUid) : 0,
    changes: Array.isArray(value.changes) ? value.changes.filter(validChange) : [],
  };
  for (const key of ['source', 'cover'] as const) if (!isString(value[key]) || !value[key]) delete file[key];
  return file as unknown as CardProjectFile;
}

export async function readCardFile(folder: string): Promise<CardProjectFile> {
  const text = await readFile(join(folder, CARD_FILE), 'utf8');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('卡项目.json 不是有效的 JSON。'); }
  return parseCardFile(value);
}

export async function writeCardFile(folder: string, file: CardProjectFile): Promise<void> {
  const checked = parseCardFile(file);
  const temporary = join(folder, `.卡项目-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(folder, CARD_FILE));
  } finally { await rm(temporary, { force: true }); }
}

export async function createCardFolder(input: { folder: string; name: string; kind: CardKind; source?: string; now?: Date; random?: () => number; id?: string }): Promise<{ file: CardProjectFile; reused: boolean }> {
  if (!isString(input.folder) || !input.folder.trim() || !isAbsolute(input.folder)) throw new Error('请选择卡项目文件夹。');
  try { return { file: await readCardFile(input.folder), reused: true }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`这个文件夹里的卡项目.json 无法读取：${error instanceof Error ? error.message : String(error)}`); }
  const name = validateCardName(input.name);
  if (input.kind !== 'fan' && input.kind !== 'original') throw new Error('请选择同人卡或原创卡。');
  const source = input.kind === 'fan' ? validateSource(input.source) : undefined;
  let entries: string[] = [];
  try { entries = await readdir(input.folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (entries.length) throw new Error('这个文件夹不是空的，请换一个空文件夹或新文件夹。');
  for (const relative of CARD_FOLDERS) await mkdir(join(input.folder, ...relative.split('/')), { recursive: true });
  const at = (input.now ?? new Date()).toISOString();
  const pick = Math.floor((input.random ?? Math.random)() * COVER_STYLES.length);
  const file: CardProjectFile = {
    schema: CARD_SCHEMA, version: 1, cardId: input.id ?? randomUUID(), name, kind: input.kind, ...(source ? { source } : {}),
    coverStyle: COVER_STYLES[Math.max(0, Math.min(COVER_STYLES.length - 1, pick))], stylePreset: null, origin: 'new',
    createdAt: at, updatedAt: at, dispatches: [], exports: [], nextUid: 0, changes: [],
  };
  await writeCardFile(input.folder, file);
  return { file, reused: false };
}

/** Hands out world book uids from the registration; uids are never reused (§4.1). */
export async function allocateUids(folder: string, count = 1): Promise<number[]> {
  const file = await readCardFile(folder);
  const first = file.nextUid;
  file.nextUid = first + Math.max(1, count);
  file.updatedAt = new Date().toISOString();
  await writeCardFile(folder, file);
  return Array.from({ length: Math.max(1, count) }, (_value, index) => first + index);
}

/** Moves the counter past every uid an import brought in. */
export async function raiseNextUid(folder: string, minimum: number): Promise<number> {
  const file = await readCardFile(folder);
  if (file.nextUid >= minimum) return file.nextUid;
  file.nextUid = minimum;
  file.updatedAt = new Date().toISOString();
  await writeCardFile(folder, file);
  return file.nextUid;
}
