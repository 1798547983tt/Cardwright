/**
 * 变量表 (ADR 0020): the single source of truth for a card's variables, one row per path, in the YAML the
 * 变量结构 section writes. Pure code without Node APIs, so the renderer can show the table and the checks can
 * match pointers against it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const VARIABLE_TYPES = ['文本', '数值', '布尔', '枚举', '对象', '记录', '列表'] as const;
export type VariableType = typeof VARIABLE_TYPES[number];
export const VARIABLE_OWNERS = ['模型', '脚本', '创角页'] as const;
export type VariableOwner = typeof VARIABLE_OWNERS[number];
export const VARIABLE_ELEMENTS = ['文本', '数值', '布尔', '对象'] as const;
export type VariableElement = typeof VARIABLE_ELEMENTS[number];
export type VariableDefault = string | number | boolean;

export interface VariableRow {
  /** JSON Pointer style: `/主角/生命`. `{键}` stands for any key of a 记录, `-` for any element of a 列表. */
  path: string;
  type: VariableType;
  owner: VariableOwner;
  /** Leaf rows only (文本, 数值, 布尔, 枚举). */
  default?: VariableDefault;
  /** 数值 only: inclusive bounds. */
  range?: [number, number];
  /** 枚举 only. */
  values?: string[];
  /** 记录 and 列表 only: how many entries are kept (the newest). */
  limit?: number;
  /** 列表 only; 对象 elements are described by rows under `/…/-/`. */
  element?: VariableElement;
  note?: string;
  when?: string;
}
export interface VariableTable { version: 1; note?: string; rows: VariableRow[] }
export interface VariableTableIssue { path?: string; message: string }
export class VariableTableError extends Error {
  constructor(readonly issues: VariableTableIssue[]) {
    super(issues.map(issue => (issue.path ? `${issue.path}：${issue.message}` : issue.message)).join('\n'));
    this.name = 'VariableTableError';
  }
}

export const KEY_PLACEHOLDER = '{键}';
export const ELEMENT_PLACEHOLDER = '-';
const LEAF_TYPES: ReadonlySet<string> = new Set(['文本', '数值', '布尔', '枚举']);
/** JavaScript members a front-end may chain after a field; they are not fields. */
const MEMBERS: ReadonlySet<string> = new Set(['length', 'toString', 'toFixed', 'toLocaleString', 'valueOf', 'map', 'filter', 'forEach', 'join', 'slice', 'includes', 'find', 'some', 'every', 'keys', 'values', 'entries', 'trim', 'split', 'replace', 'padStart', 'padEnd', 'sort', 'reduce', 'indexOf', 'concat', 'push', 'at', 'hasOwnProperty', 'constructor']);

export const isLeaf = (row: VariableRow): boolean => LEAF_TYPES.has(row.type);
export const pointerSegments = (path: string): string[] => path.split('/').slice(1).map(raw => raw.replace(/~1/g, '/').replace(/~0/g, '~'));
export const escapeSegment = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');
export const lastSegment = (path: string): string => pointerSegments(path).at(-1) ?? '';
/** Rows exactly one level under `prefix` (`''` for the top level). */
export const directChildren = (rows: VariableRow[], prefix: string): VariableRow[] => rows.filter(row => row.path.startsWith(`${prefix}/`) && !row.path.slice(prefix.length + 1).includes('/'));
/** Drops trailing JavaScript members such as `.length` or `.toFixed`. */
export function fieldSegments(segments: string[]): string[] {
  const parts = [...segments];
  while (parts.length && MEMBERS.has(parts.at(-1)!)) parts.pop();
  return parts;
}

/** The row a path hangs under: `/主角/生命` → `/主角`; `/人物/{键}/好感` → `/人物`; `/事件/-/标题` → `/事件`. Root is null. */
export function parentPath(path: string): string | null {
  const segments = pointerSegments(path);
  segments.pop();
  if (segments.length && (segments.at(-1) === KEY_PLACEHOLDER || segments.at(-1) === ELEMENT_PLACEHOLDER)) segments.pop();
  return segments.length ? `/${segments.map(escapeSegment).join('/')}` : null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined);
/** A byte order mark at the start of the file is not part of the YAML (compared by code point: an escape in the source would be decoded away by the tools that write it). */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Parses and validates a 变量表. Every problem is reported at once so the section AI can fix the table in one go. */
export function parseVariableTable(text: string): VariableTable {
  let raw: unknown;
  try { raw = parseYaml(stripBom(String(text ?? ''))); }
  catch (error) { throw new VariableTableError([{ message: `变量表不是有效的 YAML：${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }]); }
  if (!isRecord(raw)) throw new VariableTableError([{ message: '变量表应该是一个映射：顶层写「版本: 1」和「变量:」。' }]);
  const issues: VariableTableIssue[] = [];
  if (raw.版本 !== 1) issues.push({ message: '变量表的「版本」必须是 1。' });
  const list = raw.变量;
  if (!Array.isArray(list) || !list.length) throw new VariableTableError([...issues, { message: '变量表的「变量」必须是一个非空列表，每项写「路径」和「类型」。' }]);
  const rows: VariableRow[] = [];
  const seen = new Set<string>();
  list.forEach((item, index) => {
    if (!isRecord(item)) { issues.push({ message: `第 ${index + 1} 项不是映射。` }); return; }
    const path = str(item.路径)?.trim() ?? '';
    const at = path || `第 ${index + 1} 项`;
    if (!path.startsWith('/') || path.length < 2 || path.endsWith('/') || pointerSegments(path).some(segment => !segment)) { issues.push({ path: at, message: '「路径」要以 / 开头、用 / 分段、每段非空，例如 /主角/生命。' }); return; }
    if (seen.has(path)) { issues.push({ path, message: '路径重复。' }); return; }
    seen.add(path);
    const type = str(item.类型) as VariableType | undefined;
    if (!type || !(VARIABLE_TYPES as readonly string[]).includes(type)) { issues.push({ path, message: `「类型」必须是 ${VARIABLE_TYPES.join('、')} 之一。` }); return; }
    const owner = (str(item.维护者) ?? '模型') as VariableOwner;
    if (!(VARIABLE_OWNERS as readonly string[]).includes(owner)) { issues.push({ path, message: `「维护者」必须是 ${VARIABLE_OWNERS.join('、')} 之一。` }); return; }
    const row: VariableRow = { path, type, owner };
    if (item.范围 !== undefined) {
      if (type !== '数值') issues.push({ path, message: '「范围」只用于数值。' });
      else if (!Array.isArray(item.范围) || item.范围.length !== 2 || !item.范围.every(value => typeof value === 'number' && Number.isFinite(value)) || item.范围[0] > item.范围[1]) issues.push({ path, message: '「范围」写成 [下限, 上限] 两个数字，下限不大于上限。' });
      else row.range = [item.范围[0] as number, item.范围[1] as number];
    }
    if (item.取值 !== undefined) {
      if (type !== '枚举') issues.push({ path, message: '「取值」只用于枚举。' });
      else if (!Array.isArray(item.取值) || !item.取值.length || !item.取值.every(value => str(value)?.trim())) issues.push({ path, message: '「取值」写成非空的文字列表。' });
      else row.values = item.取值.map(value => String(value).trim());
    }
    if (type === '枚举' && !row.values) issues.push({ path, message: '枚举必须写「取值」。' });
    if (item.上限 !== undefined) {
      if (type !== '记录' && type !== '列表') issues.push({ path, message: '「上限」只用于记录和列表。' });
      else if (typeof item.上限 !== 'number' || !Number.isInteger(item.上限) || item.上限 < 1) issues.push({ path, message: '「上限」是正整数。' });
      else row.limit = item.上限;
    }
    if (item.元素 !== undefined) {
      const element = str(item.元素) as VariableElement | undefined;
      if (type !== '列表') issues.push({ path, message: '「元素」只用于列表。' });
      else if (!element || !(VARIABLE_ELEMENTS as readonly string[]).includes(element)) issues.push({ path, message: '「元素」是 文本、数值、布尔 或 对象。' });
      else row.element = element;
    }
    if (type === '列表' && !row.element) row.element = '文本';
    if (LEAF_TYPES.has(type)) {
      const given = item.默认;
      if (type === '文本') row.default = given === undefined || given === null ? '' : String(given);
      else if (type === '数值') {
        if (given !== undefined && typeof given !== 'number') issues.push({ path, message: '数值的「默认」要是数字。' });
        row.default = typeof given === 'number' && Number.isFinite(given) ? given : row.range ? row.range[0] : 0;
        if (row.range && (row.default < row.range[0] || row.default > row.range[1])) issues.push({ path, message: '「默认」不在「范围」之内。' });
      } else if (type === '布尔') {
        if (given !== undefined && typeof given !== 'boolean') issues.push({ path, message: '布尔的「默认」写 true 或 false。' });
        row.default = typeof given === 'boolean' ? given : false;
      } else if (row.values) {
        const value = given === undefined || given === null ? row.values[0] : String(given);
        if (!row.values.includes(value)) issues.push({ path, message: '「默认」不在「取值」里。' });
        row.default = value;
      }
    } else if (item.默认 !== undefined) issues.push({ path, message: `${type}没有「默认」，它的初值由子字段决定。` });
    const note = str(item.说明)?.trim(); if (note) row.note = note;
    const when = str(item.更新时机)?.trim(); if (when) row.when = when;
    rows.push(row);
  });
  // Structure: every nested path hangs under a row of the right kind.
  const byPath = new Map(rows.map(row => [row.path, row]));
  for (const row of rows) {
    const segments = pointerSegments(row.path);
    const last = segments.at(-1)!;
    const parent = parentPath(row.path);
    if (last === ELEMENT_PLACEHOLDER) { issues.push({ path: row.path, message: '列表元素不单独成行：用「元素」说明元素类型，对象元素的字段写成 /列表/-/字段。' }); continue; }
    if (last === KEY_PLACEHOLDER) {
      // `/货币/{键}`: the items of a record are leaves. Object items are described by rows under `/…/{键}/`, not by a row of their own.
      const holder = parent === null ? undefined : byPath.get(parent);
      if (parent === null) issues.push({ path: row.path, message: '{键} 不能是顶层。' });
      else if (!holder) issues.push({ path: row.path, message: `上级 ${parent} 没有在表里定义。` });
      else if (holder.type !== '记录') issues.push({ path: row.path, message: `${parent} 不是记录，下面不能用 {键}。` });
      else if (!isLeaf(row)) issues.push({ path: row.path, message: '记录项本身只能是文本、数值、布尔或枚举；对象项直接写它的字段 /记录/{键}/字段。' });
      continue;
    }
    if (parent === null) continue;
    const holder = byPath.get(parent);
    if (!holder) { issues.push({ path: row.path, message: `上级 ${parent} 没有在表里定义。` }); continue; }
    const marker = segments.at(-2);
    if (marker === KEY_PLACEHOLDER) { if (holder.type !== '记录') issues.push({ path: row.path, message: `${parent} 不是记录，下面不能用 {键}。` }); }
    else if (marker === ELEMENT_PLACEHOLDER) { if (holder.type !== '列表' || holder.element !== '对象') issues.push({ path: row.path, message: `${parent} 不是元素为对象的列表，下面不能用 -。` }); }
    else if (holder.type === '记录') issues.push({ path: row.path, message: `${parent} 是记录，它的项要写成 ${parent}/{键}/字段。` });
    else if (holder.type === '列表') issues.push({ path: row.path, message: `${parent} 是列表，元素字段要写成 ${parent}/-/字段。` });
    else if (holder.type !== '对象') issues.push({ path: row.path, message: `${parent} 是${holder.type}，下面不能再有字段。` });
  }
  for (const row of rows) {
    if (row.type !== '记录') continue;
    const item = `${row.path}/${KEY_PLACEHOLDER}`;
    if (byPath.has(item) && rows.some(other => other.path.startsWith(`${item}/`))) issues.push({ path: row.path, message: `记录项不能既是 ${item} 这样的单值，又有 ${item}/字段。` });
  }
  if (issues.length) throw new VariableTableError(issues);
  const note = str(raw.说明)?.trim();
  return { version: 1, ...(note ? { note } : {}), rows };
}

/** The row a concrete pointer such as `/人物/张三/好感` refers to: record keys stand in for `{键}`, list indexes for `-`. */
export function matchVariablePath(table: VariableTable, pointer: string): VariableRow | null {
  const byPath = new Map(table.rows.map(row => [row.path, row]));
  const target = pointerSegments(pointer);
  if (!target.length || target.some(segment => !segment)) return null;
  let current = '';
  for (const segment of target) {
    const literal = `${current}/${escapeSegment(segment)}`;
    if (byPath.has(literal)) { current = literal; continue; }
    const holder = byPath.get(current);
    if (holder?.type === '记录') { current = `${current}/${KEY_PLACEHOLDER}`; continue; }
    if (holder?.type === '列表' && (segment === ELEMENT_PLACEHOLDER || /^\d+$/.test(segment))) { current = `${current}/${ELEMENT_PLACEHOLDER}`; continue; }
    return null;
  }
  const row = byPath.get(current);
  if (row) return row;
  // `/人物/{键}` without a row of its own is an object item; `/事件/-` is one element of the list.
  const holderPath = parentPath(current);
  const holder = holderPath === null ? undefined : byPath.get(holderPath);
  if (holder?.type === '记录') return { path: current, type: '对象', owner: holder.owner };
  if (holder?.type === '列表') return { path: current, type: holder.element === '对象' ? '对象' : holder.element ?? '文本', owner: holder.owner };
  return null;
}

/** One line about a row, for the path list in 变量规则 and the brief (which shows the default in a column of its own). */
export function describeVariableRow(row: VariableRow, options: { omitDefault?: boolean } = {}): string {
  const parts: string[] = [];
  if (row.type === '数值') parts.push(row.range ? `数值 ${row.range[0]}–${row.range[1]}` : '数值');
  else if (row.type === '枚举') parts.push(`枚举 ${(row.values ?? []).join('/')}`);
  else if (row.type === '记录') parts.push(row.limit ? `记录，最多 ${row.limit} 条` : '记录');
  else if (row.type === '列表') parts.push(`列表，元素${row.element ?? '文本'}${row.limit ? `，最多 ${row.limit} 条` : ''}`);
  else parts.push(row.type);
  if (isLeaf(row) && !options.omitDefault) parts.push(row.type === '文本' ? `默认「${String(row.default ?? '')}」` : `默认 ${String(row.default)}`);
  if (row.owner !== '模型') parts.push(`${row.owner}维护`);
  return parts.join('，') + (row.when ? `；${row.when}` : '');
}

/** The table as YAML in the same shape the section AI writes; used for derived tables. */
export function serializeVariableTable(table: VariableTable): string {
  const rows = table.rows.map(row => {
    const raw: Record<string, unknown> = { 路径: row.path, 类型: row.type };
    if (row.default !== undefined) raw.默认 = row.default;
    if (row.range) raw.范围 = row.range;
    if (row.values) raw.取值 = row.values;
    if (row.limit) raw.上限 = row.limit;
    if (row.type === '列表') raw.元素 = row.element ?? '文本';
    if (row.owner !== '模型') raw.维护者 = row.owner;
    if (row.when) raw.更新时机 = row.when;
    if (row.note) raw.说明 = row.note;
    return raw;
  });
  return stringifyYaml({ 版本: 1, ...(table.note ? { 说明: table.note } : {}), 变量: rows }, { lineWidth: 0 });
}
