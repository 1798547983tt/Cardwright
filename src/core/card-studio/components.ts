/**
 * Component files inside a card project: one body file per component with its parameters in a sidecar of the
 * same name. The application owns the sidecars (uid, order) and the section AI owns the bodies, so a rewritten
 * body can never invent a uid or break the JSON around a 20,000 character entry (ADR 0010).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildCard, emptyCardEnvelope, joinComponent, splitCard, splitComponent, type CardParts, type ComponentSplit } from '../../shared/card-studio/card-file.ts';
import { bookEntryToParams, cardEntryToParams, defaultLoreParams, loreFileName, paramsToBookEntry, sectionOfParams, type LoreParams } from '../../shared/card-studio/lore.ts';
import { allocateUids, raiseNextUid, readCardFile } from './card-project.ts';
import type { CardComponentResult, CardImportReport, NewCardComponent } from '../../shared/card-studio/types.ts';

export const CARD_ENVELOPE_FILE = '.cardwright-card.json';
export const BOOK_FILE = '世界书/.cardwright-book.json';
export const LORE_FOLDERS: Record<string, string> = {
  'lore-rules': '世界书/叙事规则', 'lore-overview': '世界书/总览', 'lore-setting': '世界书/设定',
  'lore-people': '世界书/人设', 'lore-plot': '世界书/剧情', 'lore-vars': '世界书/变量',
  'lore-format': '世界书/正文格式', 'lore-other': '世界书/未分类',
};
/** Sections whose entries wrap their body in `<条目名>…</条目名>` (handoff §5.4). */
export const WRAPPED_SECTIONS = new Set(['lore-rules', 'lore-overview', 'lore-setting', 'lore-people', 'lore-plot']);
const TEMPLATE_STEMS = new Set(['人物模板', '剧情模板', '出处索引']);

export interface ComponentIssue { level: 'error' | 'warning'; code: string; message: string; path?: string }
export interface LoreComponent { uid: number; section: string; params: LoreParams; content: string; paramsPath: string; bodyPath: string }
export interface FileComponent { name: string; params: Record<string, unknown>; body: string; paramsPath: string; bodyPath: string }
export interface GreetingComponent { kind: 'first' | 'alternate' | 'group'; text: string; path: string }
export interface ProjectComponents {
  root: string;
  envelope: Record<string, unknown>;
  book: { name: string; extras: Record<string, unknown>; order: number[] };
  lore: LoreComponent[];
  regex: FileComponent[];
  scripts: FileComponent[];
  greetings: GreetingComponent[];
  issues: ComponentIssue[];
}
export type ImportReport = CardImportReport;

const read = async (root: string, relative: string): Promise<string | null> => {
  try { return (await readFile(join(root, ...relative.split('/')), 'utf8')).replace(/^\uFEFF/, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
async function write(root: string, relative: string, body: string): Promise<void> {
  const target = join(root, ...relative.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const stem = (name: string): string => name.replace(/\.[^.]+$/, '');
const numberPrefix = (name: string): number => { const match = /^(\d+)-/.exec(name); return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER; };
const safeName = (value: string, fallback: string): string => [...value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()].slice(0, 40).join('').replace(/[. ]+$/, '') || fallback;

/** `世界书/人设/100-爱蜜莉雅` and friends: the section folder plus an order-prefixed name. */
export function loreComponentPaths(section: string, params: LoreParams, taken: ReadonlySet<string>): { folder: string; base: string } {
  const folder = LORE_FOLDERS[section] ?? LORE_FOLDERS['lore-other'];
  return { folder, base: loreFileName(params, taken) };
}

export async function readProject(root: string): Promise<ProjectComponents> {
  const issues: ComponentIssue[] = [];
  const envelopeFile = await read(root, CARD_ENVELOPE_FILE);
  let envelope: Record<string, unknown> | undefined;
  if (envelopeFile) {
    try { envelope = record(JSON.parse(envelopeFile).envelope); }
    catch { issues.push({ level: 'error', code: 'card-parse', message: '卡片信封文件损坏，无法读取。', path: CARD_ENVELOPE_FILE }); }
  }
  const registration = await readCardFile(root).catch(() => null);
  envelope ??= emptyCardEnvelope(registration?.name ?? '角色卡');

  const bookFile = await read(root, BOOK_FILE);
  let book = { name: String(record(envelope.data).name ?? registration?.name ?? '角色卡'), extras: {} as Record<string, unknown>, order: [] as number[] };
  if (bookFile) {
    try {
      const parsed = JSON.parse(bookFile) as Record<string, unknown>;
      book = { name: String(parsed.name ?? book.name), extras: record(parsed.extras), order: Array.isArray(parsed.order) ? parsed.order.map(Number).filter(Number.isFinite) : [] };
    } catch { issues.push({ level: 'error', code: 'book-parse', message: '世界书清单文件损坏，无法读取。', path: BOOK_FILE }); }
  }

  const lore: LoreComponent[] = [];
  const seen = new Map<number, string>();
  for (const [section, folder] of Object.entries(LORE_FOLDERS)) {
    const names = await readdir(join(root, ...folder.split('/'))).catch(() => [] as string[]);
    const bodies = new Set(names.filter(name => name.endsWith('.md') && !TEMPLATE_STEMS.has(stem(name))));
    for (const name of names.filter(item => item.endsWith('.json') && !item.startsWith('.'))) {
      const paramsPath = `${folder}/${name}`;
      const bodyName = `${stem(name)}.md`;
      const raw = await read(root, paramsPath);
      let params: LoreParams;
      try { params = JSON.parse(raw ?? '') as LoreParams; }
      catch { issues.push({ level: 'error', code: 'params-parse', message: `参数文件不是合法 JSON：${paramsPath}`, path: paramsPath }); continue; }
      if (!Number.isInteger(params?.uid)) { issues.push({ level: 'error', code: 'params-uid', message: `参数文件缺少 uid：${paramsPath}`, path: paramsPath }); continue; }
      const content = await read(root, `${folder}/${bodyName}`);
      if (content === null) { issues.push({ level: 'error', code: 'orphan-params', message: `参数文件没有对应的正文：${paramsPath}`, path: paramsPath }); continue; }
      bodies.delete(bodyName);
      const previous = seen.get(params.uid);
      if (previous) issues.push({ level: 'error', code: 'duplicate-uid', message: `uid ${params.uid} 重复：${previous} 与 ${paramsPath}`, path: paramsPath });
      else seen.set(params.uid, paramsPath);
      lore.push({ uid: params.uid, section, params, content, paramsPath, bodyPath: `${folder}/${bodyName}` });
    }
    for (const orphan of bodies) issues.push({ level: 'error', code: 'orphan-body', message: `正文没有对应的参数文件：${folder}/${orphan}`, path: `${folder}/${orphan}` });
  }
  const rank = new Map(book.order.map((uid, index) => [uid, index]));
  lore.sort((a, b) => (rank.get(a.uid) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.uid) ?? Number.MAX_SAFE_INTEGER) || Number(a.params.order) - Number(b.params.order) || a.uid - b.uid);

  const regex = await readFileComponents(root, '正则', '.html', issues);
  const scripts = await readFileComponents(root, '脚本', '.js', issues);
  const greetings = await readGreetings(root);
  return { root, envelope, book, lore, regex, scripts, greetings, issues };
}

async function readFileComponents(root: string, folder: string, extension: string, issues: ComponentIssue[]): Promise<FileComponent[]> {
  const names = await readdir(join(root, folder)).catch(() => [] as string[]);
  const bodies = new Set(names.filter(name => name.endsWith(extension)));
  const components: FileComponent[] = [];
  for (const name of names.filter(item => item.endsWith('.json') && !item.startsWith('.'))) {
    const paramsPath = `${folder}/${name}`;
    const bodyName = `${stem(name)}${extension}`;
    const raw = await read(root, paramsPath);
    let params: Record<string, unknown>;
    try { params = record(JSON.parse(raw ?? '')); }
    catch { issues.push({ level: 'error', code: 'params-parse', message: `参数文件不是合法 JSON：${paramsPath}`, path: paramsPath }); continue; }
    const body = await read(root, `${folder}/${bodyName}`);
    if (body === null) { issues.push({ level: 'error', code: 'orphan-params', message: `参数文件没有对应的正文：${paramsPath}`, path: paramsPath }); continue; }
    bodies.delete(bodyName);
    components.push({ name: stem(name), params, body, paramsPath, bodyPath: `${folder}/${bodyName}` });
  }
  for (const orphan of bodies) issues.push({ level: 'error', code: 'orphan-body', message: `正文没有对应的参数文件：${folder}/${orphan}`, path: `${folder}/${orphan}` });
  return components.sort((a, b) => numberPrefix(a.name) - numberPrefix(b.name) || a.name.localeCompare(b.name));
}

async function readGreetings(root: string): Promise<GreetingComponent[]> {
  const greetings: GreetingComponent[] = [];
  const names = (await readdir(join(root, '开场白')).catch(() => [] as string[])).filter(name => name.endsWith('.md')).sort((a, b) => numberPrefix(a) - numberPrefix(b) || a.localeCompare(b));
  for (const name of names) {
    const text = await read(root, `开场白/${name}`) ?? '';
    greetings.push({ kind: numberPrefix(name) === 0 || greetings.length === 0 ? 'first' : 'alternate', text, path: `开场白/${name}` });
  }
  const groupNames = (await readdir(join(root, '开场白/群聊')).catch(() => [] as string[])).filter(name => name.endsWith('.md')).sort((a, b) => numberPrefix(a) - numberPrefix(b) || a.localeCompare(b));
  for (const name of groupNames) greetings.push({ kind: 'group', text: await read(root, `开场白/群聊/${name}`) ?? '', path: `开场白/群聊/${name}` });
  return greetings;
}

function partsOf(project: ProjectComponents): CardParts {
  const toComponent = (item: FileComponent): ComponentSplit => ({ params: item.params, body: item.body });
  return {
    envelope: project.envelope,
    book: { name: project.book.name, extras: project.book.extras },
    lore: project.lore.map(item => ({ params: item.params, content: item.content })),
    regex: project.regex.map(toComponent),
    scripts: project.scripts.map(toComponent),
    greetings: {
      first: project.greetings.find(item => item.kind === 'first')?.text ?? '',
      alternates: project.greetings.filter(item => item.kind === 'alternate').map(item => item.text),
      groupOnly: project.greetings.filter(item => item.kind === 'group').map(item => item.text),
    },
  };
}

export function buildCardFromProject(project: ProjectComponents): Record<string, unknown> {
  return buildCard(partsOf(project));
}

/** A standalone world book export: the same entries without the card-only fields. */
export function buildLorebookFromProject(project: ProjectComponents): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const item of project.lore) entries[String(item.uid)] = paramsToBookEntry(item.params, item.content);
  return { entries };
}

async function writeLore(root: string, lore: Array<{ params: LoreParams; content: string }>, issues: ComponentIssue[]): Promise<number[]> {
  const taken = new Map<string, Set<string>>();
  const order: number[] = [];
  const seen = new Set<number>();
  for (const item of lore) {
    if (seen.has(item.params.uid)) { issues.push({ level: 'error', code: 'duplicate-uid', message: `导入的世界书里 uid ${item.params.uid} 重复，已跳过后一条。` }); continue; }
    seen.add(item.params.uid);
    const section = sectionOfParams(item.params);
    const folder = LORE_FOLDERS[section] ?? LORE_FOLDERS['lore-other'];
    const used = taken.get(folder) ?? new Set<string>();
    const base = loreFileName(item.params, used);
    used.add(base); taken.set(folder, used);
    await write(root, `${folder}/${base}.json`, json(item.params));
    await write(root, `${folder}/${base}.md`, item.content);
    order.push(item.params.uid);
  }
  return order;
}

async function writeBook(root: string, book: { name: string; extras: Record<string, unknown> }, order: number[]): Promise<void> {
  await write(root, BOOK_FILE, json({ schema: 'cardwright.lorebook', version: 1, name: book.name, extras: book.extras, order }));
}

/** Imports a V1/V2/V3 card into component files. The folder keeps whatever the card did not cover. */
export async function importCard(root: string, card: Record<string, unknown>): Promise<ImportReport> {
  const parts = splitCard(card);
  const issues: ComponentIssue[] = [];
  await clearLore(root);
  const order = await writeLore(root, parts.lore, issues);
  await writeBook(root, parts.book, order);
  await write(root, CARD_ENVELOPE_FILE, json({ schema: 'cardwright.card', version: 1, updatedAt: new Date().toISOString(), envelope: parts.envelope }));

  for (const [index, item] of parts.regex.entries()) {
    const base = `${String(index + 1).padStart(2, '0')}-${safeName(String(item.params.scriptName ?? '正则'), '正则')}`;
    await write(root, `正则/${base}.json`, json(item.params));
    await write(root, `正则/${base}.html`, item.body);
  }
  for (const [index, item] of parts.scripts.entries()) {
    const base = `${String(index + 1).padStart(2, '0')}-${safeName(String(item.params.name ?? '脚本'), '脚本')}`;
    await write(root, `脚本/${base}.json`, json(item.params));
    await write(root, `脚本/${base}.js`, item.body);
  }
  await write(root, '开场白/00-开场.md', parts.greetings.first);
  for (const [index, text] of parts.greetings.alternates.entries()) await write(root, `开场白/${String(index + 1).padStart(2, '0')}-备选开场.md`, text);
  for (const [index, text] of parts.greetings.groupOnly.entries()) await write(root, `开场白/群聊/${String(index + 1).padStart(2, '0')}-群聊开场.md`, text);

  await raiseNextUid(root, order.length ? Math.max(...order) + 1 : 0);
  return { lore: order.length, regex: parts.regex.length, scripts: parts.scripts.length, greetings: 1 + parts.greetings.alternates.length + parts.greetings.groupOnly.length, issues };
}

/** Imports a standalone world book. An existing book is only touched when the caller asks to replace it. */
export async function importLorebook(root: string, book: Record<string, unknown>, options: { name?: string; replace?: boolean } = {}): Promise<ImportReport> {
  const existing = await readProject(root);
  if (existing.lore.length && !options.replace) throw new Error('这张卡已经有世界书条目。导入独立世界书会覆盖它们，请确认替换后再导入。');
  const rawEntries = book.entries;
  const entries = Array.isArray(rawEntries) ? rawEntries : Object.values(record(rawEntries));
  const issues: ComponentIssue[] = [];
  const lore = entries.map((value, index) => {
    const entry = record(value);
    const split = entry.uid === undefined && entry.id !== undefined ? cardEntryToParams(entry, index) : bookEntryToParams(entry);
    if (!Number.isInteger(split.params.uid)) split.params.uid = index;
    return split;
  });
  await clearLore(root);
  const order = await writeLore(root, lore, issues);
  await writeBook(root, { name: options.name ?? existing.book.name, extras: existing.book.extras }, order);
  await raiseNextUid(root, order.length ? Math.max(...order) + 1 : 0);
  return { lore: order.length, regex: 0, scripts: 0, greetings: 0, issues };
}

async function clearLore(root: string): Promise<void> {
  for (const folder of Object.values(LORE_FOLDERS)) {
    const names = await readdir(join(root, ...folder.split('/'))).catch(() => [] as string[]);
    for (const name of names) {
      if (TEMPLATE_STEMS.has(stem(name)) || name.startsWith('.')) continue;
      if (name.endsWith('.json') || name.endsWith('.md')) await rm(join(root, ...folder.split('/'), name), { force: true });
    }
  }
}

export type PieceKind = 'regex' | 'script';
const PIECE = {
  regex: { folder: '正则', extension: '.html', body: 'replaceString', name: 'scriptName', label: '正则' },
  script: { folder: '脚本', extension: '.js', body: 'content', name: 'name', label: '脚本' },
} as const;
export interface PieceImport { kind: PieceKind; name: string; paramsPath: string; bodyPath: string; replaced: boolean }

/** One regex or script joined back into the shape SillyTavern and 酒馆助手 import. */
export function buildPiece(project: ProjectComponents, kind: PieceKind, name: string): Record<string, unknown> {
  const piece = (kind === 'regex' ? project.regex : project.scripts).find(item => item.name === name);
  if (!piece) throw new Error(`没有找到${PIECE[kind].label}组件「${name}」。`);
  return joinComponent({ params: piece.params, body: piece.body }, PIECE[kind].body);
}

export function pieceFileName(kind: PieceKind, name: string, version: string, date: string): string {
  return `${[PIECE[kind].folder, name, version, date].filter(Boolean).join('-')}.json`;
}

/** What a JSON file holds, as far as a single piece goes: a regex, a 酒馆助手 script, or neither. */
export function pieceKindOf(value: unknown): PieceKind | null {
  const item = record(value);
  if (typeof item.findRegex === 'string' || typeof item.replaceString === 'string' || typeof item.scriptName === 'string') return 'regex';
  if (typeof item.content === 'string' && typeof item.name === 'string') return 'script';
  return null;
}

/** Imports one exported piece. A piece whose id the project already has replaces that component in place. */
export async function importPiece(root: string, value: unknown): Promise<PieceImport> {
  const kind = pieceKindOf(value);
  if (!kind) throw new Error('这个文件既不是正则，也不是酒馆助手脚本。');
  const shape = PIECE[kind];
  const item = record(value);
  const split = splitComponent(item, shape.body);
  const project = await readProject(root);
  const siblings = kind === 'regex' ? project.regex : project.scripts;
  const existing = typeof item.id === 'string' && item.id ? siblings.find(component => component.params.id === item.id) : undefined;
  const next = Math.max(0, ...siblings.map(component => numberPrefix(component.name)).filter(value => value < Number.MAX_SAFE_INTEGER)) + 1;
  const base = existing ? existing.name : `${String(next).padStart(2, '0')}-${safeName(String(item[shape.name] ?? shape.label), shape.label)}`;
  await write(root, `${shape.folder}/${base}.json`, json(split.params));
  await write(root, `${shape.folder}/${base}${shape.extension}`, split.body);
  return { kind, name: base, paramsPath: `${shape.folder}/${base}.json`, bodyPath: `${shape.folder}/${base}${shape.extension}`, replaced: Boolean(existing) };
}

export type NewComponentInput = NewCardComponent;
export type NewComponentResult = CardComponentResult;

/** Creates one component with the parameters its section needs. The uid comes from the registration, never from the AI. */
export async function createComponent(root: string, input: NewComponentInput): Promise<NewComponentResult> {
  const name = input.name?.trim();
  if (!name) throw new Error('请给组件起一个名称。');
  if (input.board === 'lore') {
    const section = input.section && LORE_FOLDERS[input.section] ? input.section : 'lore-other';
    const [uid] = await allocateUids(root, 1);
    const params = defaultLoreParams({ uid, section, name, keys: input.keys, order: input.order });
    if (input.constant !== undefined) params.constant = input.constant;
    if (input.position !== undefined) params.position = input.position;
    if (input.depth !== undefined) params.depth = input.depth;
    const folder = LORE_FOLDERS[section];
    const names = await readdir(join(root, ...folder.split('/'))).catch(() => [] as string[]);
    const base = loreFileName(params, new Set(names.filter(item => item.endsWith('.json')).map(stem)));
    await write(root, `${folder}/${base}.json`, json(params));
    await write(root, `${folder}/${base}.md`, WRAPPED_SECTIONS.has(section) ? `<${name}>\n\n</${name}>\n` : '');
    const project = await readProject(root);
    await writeBook(root, project.book, [...project.book.order.filter(item => item !== uid), uid]);
    return { uid, section, paramsPath: `${folder}/${base}.json`, bodyPath: `${folder}/${base}.md` };
  }
  const folder = input.board === 'regex' ? '正则' : input.board === 'script' ? '脚本' : '开场白';
  const extension = input.board === 'regex' ? '.html' : input.board === 'script' ? '.js' : '.md';
  const target = input.board === 'greeting' && input.kind === 'group' ? `${folder}/群聊` : folder;
  const names = await readdir(join(root, ...target.split('/'))).catch(() => [] as string[]);
  const next = Math.max(0, ...names.map(numberPrefix).filter(value => value < Number.MAX_SAFE_INTEGER)) + 1;
  const base = `${String(input.board === 'greeting' && input.kind === 'first' ? 0 : next).padStart(2, '0')}-${safeName(name, input.board)}`;
  if (input.board === 'greeting') {
    await write(root, `${target}/${base}.md`, '');
    return { uid: -1, paramsPath: '', bodyPath: `${target}/${base}.md` };
  }
  const params = input.board === 'regex'
    ? { id: randomUUID(), scriptName: name, findRegex: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }
    : { type: 'script', enabled: true, name, id: randomUUID(), info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } };
  await write(root, `${target}/${base}.json`, json(params));
  await write(root, `${target}/${base}${extension}`, '');
  return { uid: -1, paramsPath: `${target}/${base}.json`, bodyPath: `${target}/${base}${extension}` };
}
