/**
 * 装配单 (ADR 0019): what a front-end section writes instead of a hand-written document. Chinese keys in YAML, parsed
 * into typed sheets here; the compiler (frontend-compile.ts) turns them into documents. Pure code, no Node APIs.
 */
import { parse as parseYaml } from 'yaml';
import { STYLE_PRESETS } from './style-presets.ts';
import type { VariableRow } from './variable-table.ts';

export const SHEET_KINDS = ['状态栏', '正文美化', '创角页'] as const;
export type SheetKind = typeof SHEET_KINDS[number];
export const STATUS_FORMS = ['placeholder', 'header', 'floating'] as const;
export type StatusForm = typeof STATUS_FORMS[number];
export const DEFAULT_STATUS_FORM: StatusForm = 'header';
export const BLOCK_TYPES = ['stats', 'bars', 'gauge', 'tags', 'fold', 'list', 'relation', 'timeline', 'crisis', 'delta', 'text', 'custom'] as const;
export type BlockType = typeof BLOCK_TYPES[number];
export const ICONS = ['heart', 'map', 'clock', 'users', 'bag', 'sword', 'star', 'book', 'flag', 'bolt', 'shield', 'moon', 'sun', 'leaf', 'gear', 'pin', 'eye', 'scroll'] as const;
export const BODY_ROLES = ['页眉', '章节', '场景', '正文', '对白', '独白', '提示', '检定', '折叠', '隐藏'] as const;
export type BodyRole = typeof BODY_ROLES[number];
export const FIELD_TYPES = ['文本', '长文本', '单选', '多选', '滑杆', '人物列表'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export const TONES = ['ok', 'warn', 'danger', 'accent'] as const;
export type Tone = typeof TONES[number];
/** The tokens a custom preset must define (styles/README.md rule 1); a skin may use more. */
export const REQUIRED_TOKENS = ['--bg', '--panel', '--line', '--text', '--text-2', '--text-3', '--accent', '--accent-2', '--ok', '--warn', '--danger'] as const;
const PRESET_IDS = new Set(STYLE_PRESETS.map(preset => preset.id));

export interface SheetItem { path: string; label?: string; format?: string }
export interface CustomBlock { html: string; css?: string }
/** Blocks as the parser leaves them; `kind` and `barRange` are filled from the 变量表 by enrichSheet (frontend-compile.ts), never by the parser. */
export type SheetBlock =
  | { type: 'stats' | 'bars' | 'gauge' | 'delta'; title?: string; items: SheetItem[] }
  | { type: 'tags'; title?: string; path: string; kind?: VariableRow['type'] }
  | { type: 'list'; title?: string; path: string; fields?: Record<string, string>; recent: number }
  | { type: 'timeline'; title?: string; path: string; time?: string; note?: string; recent: number }
  | { type: 'relation'; title?: string; path: string; fields: Record<string, string>; bar?: string; barRange?: [number, number] }
  | { type: 'crisis'; title?: string; path: string; tiers: Array<{ upTo?: number; name: string; tone: Tone }>; kind?: VariableRow['type'] }
  | { type: 'text'; title?: string; path?: string; text?: string; kind?: VariableRow['type'] }
  | { type: 'fold'; title: string; open: boolean; blocks: SheetBlock[] }
  | { type: 'custom'; html: string; css?: string };
export interface SheetPage { name: string; icon?: string; blocks: SheetBlock[] }
export interface StatusSheet { kind: '状态栏'; form: StatusForm; preset?: string; title: string; collapsed: boolean; summary: SheetItem[]; pages: SheetPage[]; tokens?: Record<string, string> }
export interface BodyModule { tag: string; role: BodyRole; label?: string }
export interface BodySheet { kind: '正文美化'; preset?: string; root: string; floors: number; statusHead: boolean; modules: BodyModule[]; playerMark: string; custom: CustomBlock[]; tokens?: Record<string, string> }
export interface StartField { key: string; type: FieldType; required: boolean; hint?: string; options?: string[]; range?: [number, number]; max?: number; write?: string }
export interface StartStep { name: string; custom: boolean; fields: StartField[] }
export interface StartSheet { kind: '创角页'; preset?: string; title: string; steps: StartStep[]; writes: { entry: { name: string; template: string } | null; opening: string | null; variables: boolean }; tokens?: Record<string, string> }
export type AssemblySheet = StatusSheet | BodySheet | StartSheet;
export interface SheetIssue { path: string; message: string }
export class AssemblySheetError extends Error {
  constructor(readonly issues: SheetIssue[]) { super(issues.map(issue => `${issue.path}：${issue.message}`).join('\n')); this.name = 'AssemblySheetError'; }
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const POINTER = /^\/[^\s/]+(\/[^\s/]+)*$/;
const HARD_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

/** A sheet starts with `前端:` once comments, blank lines and a `---` document marker are skipped; a document never does. */
export function isAssemblySheet(body: string): boolean {
  const first = stripBom(body).split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#') && !/^---\s*$/.test(line));
  return !!first && /^前端\s*[:：]/.test(first.trim());
}

class Reader {
  readonly issues: SheetIssue[] = [];
  bad(path: string, message: string): undefined { this.issues.push({ path, message }); return undefined; }
  str(raw: Raw, key: string, path: string, options: { required?: boolean; oneOf?: readonly string[]; fallback?: string } = {}): string | undefined {
    const value = raw[key];
    if (value === undefined || value === null || value === '') {
      if (options.required) return this.bad(`${path}${key}`, '缺少这一项。');
      return options.fallback;
    }
    const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
    if (text === undefined) return this.bad(`${path}${key}`, '要写成文字。');
    if (options.oneOf && !options.oneOf.includes(text)) return this.bad(`${path}${key}`, `只能是 ${options.oneOf.join('、')}。`);
    return text;
  }
  bool(raw: Raw, key: string, path: string, fallback: boolean): boolean {
    const value = raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    this.bad(`${path}${key}`, '要写 true 或 false。'); return fallback;
  }
  int(raw: Raw, key: string, path: string, options: { min: number; max: number; fallback?: number; required?: boolean }): number | undefined {
    const value = raw[key];
    if (value === undefined || value === null) { if (options.required) return this.bad(`${path}${key}`, '缺少这一项。'); return options.fallback; }
    if (!Number.isInteger(value) || (value as number) < options.min || (value as number) > options.max) return this.bad(`${path}${key}`, `要写 ${options.min} 到 ${options.max} 之间的整数。`);
    return value as number;
  }
  pointer(raw: Raw, key: string, path: string, required = false): string | undefined {
    const text = this.str(raw, key, path, { required });
    if (text === undefined) return undefined;
    if (!POINTER.test(text)) return this.bad(`${path}${key}`, '要写成变量表里的路径，例如 /主角/生命。');
    return text;
  }
  list(raw: Raw, key: string, path: string, options: { min?: number; max?: number; required?: boolean } = {}): unknown[] | undefined {
    const value = raw[key];
    if (value === undefined || value === null) { if (options.required || (options.min ?? 0) > 0) return this.bad(`${path}${key}`, options.min ? `至少${options.min === 1 ? '一' : options.min}${key === '分页' ? '页' : key === '步骤' ? '步' : '项'}。` : '缺少这一项。'); return []; }
    if (!Array.isArray(value)) return this.bad(`${path}${key}`, '要写成列表。');
    if (options.min !== undefined && value.length < options.min) return this.bad(`${path}${key}`, `至少${options.min === 1 ? '一' : options.min}${key === '分页' ? '页' : key === '步骤' ? '步' : '项'}。`);
    if (options.max !== undefined && value.length > options.max) return this.bad(`${path}${key}`, `最多 ${options.max} ${key === '分页' ? '页' : key === '步骤' ? '步' : '项'}。`);
    return value;
  }
  record(raw: Raw, key: string, path: string, required = false): Record<string, string> | undefined {
    const value = raw[key];
    if (value === undefined || value === null) { if (required) return this.bad(`${path}${key}`, '缺少这一项。'); return undefined; }
    if (!isRecord(value)) return this.bad(`${path}${key}`, '要写成「显示名: 路径」的映射。');
    const out: Record<string, string> = {};
    for (const [name, pointer] of Object.entries(value)) {
      if (typeof pointer !== 'string' || !POINTER.test(pointer)) { this.bad(`${path}${key}.${name}`, '要写成变量表里的路径。'); continue; }
      out[name] = pointer;
    }
    return out;
  }
  items(raw: Raw, path: string, options: { min?: number; max?: number; key?: string } = {}): SheetItem[] {
    const key = options.key ?? '项';
    const list = this.list(raw, key, path, { min: options.min ?? 1, max: options.max });
    if (!list) return [];
    return list.flatMap((entry, index) => {
      if (!isRecord(entry)) return this.bad(`${path}${key}[${index}]`, '每一项要写 变量。') ?? [];
      const pointer = this.pointer(entry, '变量', `${path}${key}[${index}].`, true);
      if (!pointer) return [];
      const label = this.str(entry, '显示', `${path}${key}[${index}].`);
      const format = this.str(entry, '格式', `${path}${key}[${index}].`);
      return [{ path: pointer, ...(label ? { label } : {}), ...(format ? { format } : {}) }];
    });
  }
}

function customBlock(reader: Reader, raw: Raw, path: string): CustomBlock | undefined {
  const html = reader.str(raw, 'HTML', path, { required: true });
  const css = reader.str(raw, 'CSS', path);
  if (html !== undefined && /<script\b/i.test(html)) reader.bad(`${path}HTML`, '自定义区块只放 HTML 与 CSS，不放脚本。');
  if (css !== undefined && HARD_COLOUR.test(css)) reader.bad(`${path}CSS`, '只能用令牌（var(--accent) 这样的写法），不写具体色值。');
  if (css !== undefined && css.includes('</')) reader.bad(`${path}CSS`, '自定义 CSS 不能包含 </，会提前结束样式。');
  if (html === undefined) return undefined;
  return { html, ...(css ? { css } : {}) };
}

function block(reader: Reader, raw: unknown, path: string): SheetBlock | undefined {
  if (!isRecord(raw)) return reader.bad(path, '每个区块要写 类型。');
  const type = reader.str(raw, '类型', `${path}.`, { required: true, oneOf: BLOCK_TYPES }) as BlockType | undefined;
  if (!type) return undefined;
  const title = reader.str(raw, '标题', `${path}.`);
  const at = `${path}.`;
  switch (type) {
    case 'stats': case 'bars': case 'delta': return { type, ...(title ? { title } : {}), items: reader.items(raw, at) };
    case 'gauge': return { type, ...(title ? { title } : {}), items: reader.items(raw, at, { min: 1, max: 4 }) };
    case 'tags': { const pointer = reader.pointer(raw, '变量', at, true); return pointer ? { type, ...(title ? { title } : {}), path: pointer } : undefined; }
    case 'list': {
      const pointer = reader.pointer(raw, '变量', at, true); const fields = reader.record(raw, '字段', at); const recent = reader.int(raw, '最近', at, { min: 1, max: 50, fallback: 5 }) ?? 5;
      return pointer ? { type, ...(title ? { title } : {}), path: pointer, ...(fields ? { fields } : {}), recent } : undefined;
    }
    case 'timeline': {
      const pointer = reader.pointer(raw, '变量', at, true); const time = reader.pointer(raw, '时间', at); const note = reader.pointer(raw, '说明', at); const recent = reader.int(raw, '最近', at, { min: 1, max: 50, fallback: 6 }) ?? 6;
      return pointer ? { type, ...(title ? { title } : {}), path: pointer, ...(time ? { time } : {}), ...(note ? { note } : {}), recent } : undefined;
    }
    case 'relation': {
      const pointer = reader.pointer(raw, '变量', at, true); const fields = reader.record(raw, '字段', at, true); const bar = reader.pointer(raw, '进度', at);
      return pointer && fields ? { type, ...(title ? { title } : {}), path: pointer, fields, ...(bar ? { bar } : {}) } : undefined;
    }
    case 'crisis': {
      const pointer = reader.pointer(raw, '变量', at, true);
      let lastUpTo: number | undefined;
      let openEndedAt = -1;
      const tiers = (reader.list(raw, '档位', at, { min: 1, max: 6 }) ?? []).flatMap((tier, index) => {
        if (openEndedAt >= 0) { reader.bad(`${at}档位[${openEndedAt}].至`, '没有写 至 的档位只能是最后一档。'); openEndedAt = -1; }
        if (!isRecord(tier)) return reader.bad(`${at}档位[${index}]`, '每个档位要写 名称 与 色。') ?? [];
        const name = reader.str(tier, '名称', `${at}档位[${index}].`, { required: true }); const tone = reader.str(tier, '色', `${at}档位[${index}].`, { required: true, oneOf: TONES }) as Tone | undefined;
        const upTo = tier['至'] === undefined ? undefined : typeof tier['至'] === 'number' ? tier['至'] : reader.bad(`${at}档位[${index}].至`, '要写数字。');
        if (tier['至'] === undefined) openEndedAt = index;
        else if (upTo !== undefined) {
          if (lastUpTo !== undefined && upTo <= lastUpTo) reader.bad(`${at}档位[${index}].至`, '要比上一档的 至 大。');
          lastUpTo = upTo;
        }
        return name && tone ? [{ ...(upTo !== undefined ? { upTo } : {}), name, tone }] : [];
      });
      return pointer ? { type, ...(title ? { title } : {}), path: pointer, tiers } : undefined;
    }
    case 'text': {
      const pointer = reader.pointer(raw, '变量', at); const text = reader.str(raw, '文本', at);
      if (!pointer && !text) return reader.bad(path, '文本区块要写 变量 或 文本。');
      return { type, ...(title ? { title } : {}), ...(pointer ? { path: pointer } : {}), ...(text ? { text } : {}) };
    }
    case 'fold': {
      const name = reader.str(raw, '标题', at, { required: true });
      const open = reader.bool(raw, '默认展开', at, false);
      const blocks = (reader.list(raw, '区块', at, { min: 1 }) ?? []).flatMap((child, index) => {
        // Only fold has child blocks, so rejecting fold children here already keeps nesting to one level.
        if (isRecord(child) && child['类型'] === 'fold') return reader.bad(`${at}区块[${index}]`, '折叠面板（fold）里不能再放折叠面板。') ?? [];
        const parsed = block(reader, child, `${at}区块[${index}]`); return parsed ? [parsed] : [];
      });
      return name ? { type, title: name, open, blocks } : undefined;
    }
    case 'custom': { const custom = customBlock(reader, raw, at); return custom ? { type, ...custom } : undefined; }
  }
}

function tokens(reader: Reader, raw: Raw, preset: string | undefined): Record<string, string> | undefined {
  const value = raw['令牌'];
  if (value === undefined || value === null) { if (preset === 'custom') reader.bad('令牌', '题材自定要在装配单里写全令牌。'); return undefined; }
  if (preset !== 'custom') return reader.bad('令牌', '只有 预设: custom 才写令牌；其他预设的令牌由皮肤提供。');
  if (!isRecord(value)) return reader.bad('令牌', '要写成「--名称: 值」的映射。');
  const out: Record<string, string> = {};
  for (const [name, colour] of Object.entries(value)) {
    if (!/^--[a-z][\w-]*$/i.test(name)) { reader.bad(`令牌.${name}`, '令牌名要以 -- 开头。'); continue; }
    if (colour === null || colour === undefined) { reader.bad(`令牌.${name}`, '色值要加引号，例如 --bg: \'#0f1412\'；不加引号时 # 后面会被当成注释。'); continue; }
    if (typeof colour !== 'string' || !colour.trim()) { reader.bad(`令牌.${name}`, '要写成文字。'); continue; }
    if (/[{}]|<\//.test(colour)) { reader.bad(`令牌.${name}`, '令牌值不能包含 { } 或 </。'); continue; }
    out[name] = colour.trim();
  }
  const missing = REQUIRED_TOKENS.filter(name => !(name in out));
  if (missing.length) reader.bad('令牌', `还缺 ${missing.join('、')}。`);
  return out;
}

const tokensOf = (reader: Reader, raw: Raw, preset: string | undefined): { tokens?: Record<string, string> } => { const value = tokens(reader, raw, preset); return value ? { tokens: value } : {}; };

function statusSheet(reader: Reader, raw: Raw, preset: string | undefined): StatusSheet {
  const form = (reader.str(raw, '形态', '', { oneOf: STATUS_FORMS, fallback: DEFAULT_STATUS_FORM }) ?? DEFAULT_STATUS_FORM) as StatusForm;
  const title = reader.str(raw, '标题', '', { fallback: '' }) ?? '';
  const collapsed = reader.bool(raw, '折叠', '', true);
  const summary = reader.items(raw, '', { min: 0, max: 4, key: '摘要' });
  const pageNames = new Set<string>();
  const pages = (reader.list(raw, '分页', '', { min: 1, max: 6 }) ?? []).flatMap((page, index) => {
    const at = `分页[${index}].`;
    if (!isRecord(page)) return reader.bad(`分页[${index}]`, '每页要写 名称 与 区块。') ?? [];
    const name = reader.str(page, '名称', at, { required: true });
    if (name && pageNames.has(name)) reader.bad(`${at}名称`, `「${name}」重复了，每页的名称要唯一。`); if (name) pageNames.add(name);
    const icon = reader.str(page, '图标', at, { oneOf: ICONS });
    const blocks = (reader.list(page, '区块', at, { min: 1 }) ?? []).flatMap((entry, at2) => { const parsed = block(reader, entry, `${at}区块[${at2}]`); return parsed ? [parsed] : []; });
    return name ? [{ name, ...(icon ? { icon } : {}), blocks }] : [];
  });
  return { kind: '状态栏', form, ...(preset ? { preset } : {}), title, collapsed, summary, pages, ...tokensOf(reader, raw, preset) };
}

function bodySheet(reader: Reader, raw: Raw, preset: string | undefined): BodySheet {
  const root = reader.str(raw, '根标签', '', { required: true }) ?? 'content';
  if (raw['根标签'] !== undefined && !/^[A-Za-z][\w-]*$/.test(root)) reader.bad('根标签', '只写标签名，例如 content。');
  const floors = reader.int(raw, '楼层', '', { min: 1, max: 50, fallback: 10 }) ?? 10;
  const statusHead = reader.bool(raw, '状态头', '', false);
  const modules = (reader.list(raw, '模块', '') ?? []).flatMap((module, index) => {
    const at = `模块[${index}].`;
    if (!isRecord(module)) return reader.bad(`模块[${index}]`, '每个模块要写 标签 与 角色。') ?? [];
    const tag = reader.str(module, '标签', at, { required: true }); const role = reader.str(module, '角色', at, { required: true, oneOf: BODY_ROLES }) as BodyRole | undefined; const label = reader.str(module, '显示', at);
    return tag && role ? [{ tag, role, ...(label ? { label } : {}) }] : [];
  });
  const dialogue = isRecord(raw['对白']) ? raw['对白'] : {};
  const playerMark = reader.str(dialogue, '玩家标记', '对白.', { fallback: '#' }) ?? '#';
  const custom = (reader.list(raw, '自定义区块', '') ?? []).flatMap((entry, index) => { const parsed = isRecord(entry) ? customBlock(reader, entry, `自定义区块[${index}].`) : reader.bad(`自定义区块[${index}]`, '要写 HTML。'); return parsed ? [parsed] : []; });
  return { kind: '正文美化', ...(preset ? { preset } : {}), root, floors, statusHead, modules, playerMark, custom, ...tokensOf(reader, raw, preset) };
}

function startSheet(reader: Reader, raw: Raw, preset: string | undefined): StartSheet {
  const title = reader.str(raw, '标题', '', { fallback: '' }) ?? '';
  const keys = new Set<string>();
  const steps = (reader.list(raw, '步骤', '', { min: 1, max: 8 }) ?? []).flatMap((step, index) => {
    const at = `步骤[${index}].`;
    if (!isRecord(step)) return reader.bad(`步骤[${index}]`, '每步要写 名称 与 字段。') ?? [];
    const name = reader.str(step, '名称', at, { required: true });
    const custom = reader.bool(step, '自定义开局', at, false);
    const fields = (reader.list(step, '字段', at, { min: 1 }) ?? []).flatMap((field, at2) => {
      const here = `${at}字段[${at2}].`;
      if (!isRecord(field)) return reader.bad(`${at}字段[${at2}]`, '每个字段要写 键 与 类型。') ?? [];
      const key = reader.str(field, '键', here, { required: true }); const type = reader.str(field, '类型', here, { required: true, oneOf: FIELD_TYPES }) as FieldType | undefined;
      if (key && keys.has(key)) reader.bad(`${here}键`, `「${key}」重复了，每个字段的键要唯一。`); if (key) keys.add(key);
      const required = reader.bool(field, '必填', here, false); const hint = reader.str(field, '提示', here); const write = reader.pointer(field, '写入', here);
      const options = ['单选', '多选', '人物列表'].includes(type ?? '') ? (reader.list(field, '选项', here, { min: 1, max: 40 }) ?? []).map(String) : undefined;
      let range: [number, number] | undefined;
      if (type === '滑杆') {
        const value = field['范围'];
        if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number') && value[0] < value[1]) range = [value[0], value[1]];
        else reader.bad(`${here}范围`, '滑杆要写 范围: [最小, 最大]。');
      }
      const max = ['多选', '人物列表'].includes(type ?? '') ? reader.int(field, '最多', here, { min: 1, max: 40 }) : undefined;
      return key && type ? [{ key, type, required, ...(hint ? { hint } : {}), ...(options ? { options } : {}), ...(range ? { range } : {}), ...(max !== undefined ? { max } : {}), ...(write ? { write } : {}) }] : [];
    });
    return name ? [{ name, custom, fields }] : [];
  });
  const writesRaw = isRecord(raw['写入']) ? raw['写入'] : {};
  const entryRaw = isRecord(writesRaw['世界书条目']) ? writesRaw['世界书条目'] : null;
  const entryName = entryRaw ? reader.str(entryRaw, '名称', '写入.世界书条目.', { required: true }) : undefined;
  const entryTemplate = entryRaw ? reader.str(entryRaw, '模板', '写入.世界书条目.', { required: true }) : undefined;
  const opening = reader.str(writesRaw, '开场信息', '写入.');
  const variables = reader.bool(writesRaw, '初始变量', '写入.', false);
  if (variables && !steps.some(step => step.fields.some(field => field.write))) reader.bad('写入.初始变量', '开了初始变量，但没有任何字段写了 写入: 路径。');
  return { kind: '创角页', ...(preset ? { preset } : {}), title, steps, writes: { entry: entryName && entryTemplate ? { name: entryName, template: entryTemplate } : null, opening: opening ?? null, variables }, ...tokensOf(reader, raw, preset) };
}

export function parseAssemblySheet(text: string): AssemblySheet {
  let raw: unknown;
  try { raw = parseYaml(stripBom(text)); }
  catch (error) { throw new AssemblySheetError([{ path: '装配单', message: `不是有效的 YAML：${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }]); }
  if (!isRecord(raw)) throw new AssemblySheetError([{ path: '装配单', message: '要写成键值对，以 前端: 开头。' }]);
  const reader = new Reader();
  const kind = reader.str(raw, '前端', '', { required: true, oneOf: SHEET_KINDS }) as SheetKind | undefined;
  if (!kind) throw new AssemblySheetError(reader.issues.length ? reader.issues : [{ path: '前端', message: '只能是 状态栏、正文美化、创角页。' }]);
  const preset = reader.str(raw, '预设', '');
  if (preset !== undefined && !PRESET_IDS.has(preset)) reader.bad('预设', `没有这个预设，可用：${[...PRESET_IDS].join('、')}。`);
  const sheet = kind === '状态栏' ? statusSheet(reader, raw, preset) : kind === '正文美化' ? bodySheet(reader, raw, preset) : startSheet(reader, raw, preset);
  if (reader.issues.length) throw new AssemblySheetError(reader.issues);
  return sheet;
}

/** Every variable path a sheet binds, in sheet order, each once. */
export function sheetPaths(sheet: AssemblySheet): string[] {
  const found = new Set<string>();
  const add = (path?: string) => { if (path) found.add(path); };
  const walk = (block: SheetBlock): void => {
    switch (block.type) {
      case 'stats': case 'bars': case 'gauge': case 'delta': block.items.forEach(item => add(item.path)); break;
      case 'tags': case 'text': add(block.path); break;
      case 'list': add(block.path); Object.values(block.fields ?? {}).forEach(add); break;
      case 'timeline': add(block.path); add(block.time); add(block.note); break;
      case 'relation': add(block.path); Object.values(block.fields).forEach(add); add(block.bar); break;
      case 'crisis': add(block.path); break;
      case 'fold': block.blocks.forEach(walk); break;
      case 'custom': break;
    }
  };
  if (sheet.kind === '状态栏') { sheet.summary.forEach(item => add(item.path)); sheet.pages.forEach(page => page.blocks.forEach(walk)); }
  if (sheet.kind === '创角页') sheet.steps.forEach(step => step.fields.forEach(field => add(field.write)));
  return [...found];
}

/** What the section pages and findings call a sheet. */
export const sheetLabel = (sheet: AssemblySheet): string => sheet.kind === '状态栏' ? `状态栏（${sheet.form}）` : sheet.kind;
