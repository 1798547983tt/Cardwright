/**
 * The files the application writes from a card's 变量表 (ADR 0020), and the manifest that records what it wrote so
 * the checks can tell a hand edit from a regeneration. Reading and writing happen only here; the generators are pure.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createComponent, readProject, type ProjectComponents } from './components.ts';
import { deriveVariableTable } from './variable-derive.ts';
import { parseVariableTable, serializeVariableTable, type VariableTable } from '../../shared/card-studio/variable-table.ts';
import { CLEANUP_REGEX_FIND, CLEANUP_REGEX_NAME, FIXED_VARIABLE_LIST, MVU_BUTTONS, MVU_IMPORT_LINE, RULES_INTRO, extractPathListBlock, generateInitialVariables, generateOutputFormat, generatePathList, generateZodScript, replacePathListBlock } from '../../shared/card-studio/variable-generate.ts';

export const VARIABLE_TABLE_FILE = '变量表.yaml';
export const DERIVED_TABLE_FILE = '变量表.推导.yaml';
export const ARTIFACT_MANIFEST_FILE = '变量表.生成.json';

export interface ArtifactManifest { schema: 'cardwright.variable-artifacts'; version: 1; table: string; at: string; files: Record<string, { hash: string; part: 'file' | 'block' }> }
export interface VariableSyncResult { rows: number; created: string[]; written: string[]; unchanged: string[] }
export type VariableTableState = { source: 'authored' | 'derived'; table: VariableTable; text: string } | { source: null };

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
export const hashText = (text: string): string => createHash('sha256').update(stripBom(text)).digest('hex');
const at = (root: string, relative: string): string => join(root, ...relative.split('/'));
async function readText(root: string, relative: string): Promise<string | null> {
  try { return stripBom(await readFile(at(root, relative), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function writeText(root: string, relative: string, text: string): Promise<void> {
  await mkdir(dirname(at(root, relative)), { recursive: true });
  await writeFile(at(root, relative), text);
}
async function patchJson(root: string, relative: string, change: (params: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const params = JSON.parse((await readText(root, relative)) ?? '{}') as Record<string, unknown>;
  await writeText(root, relative, `${JSON.stringify(change(params), null, 2)}\n`);
}

/** The table the checks work from: the authored one when it exists (its parse errors are thrown), else a derived one. */
export async function readVariableTableState(root: string): Promise<VariableTableState> {
  const authored = await readText(root, VARIABLE_TABLE_FILE);
  if (authored !== null) return { source: 'authored', table: parseVariableTable(authored), text: authored };
  const derived = await readText(root, DERIVED_TABLE_FILE);
  if (derived === null) return { source: null };
  try { return { source: 'derived', table: parseVariableTable(derived), text: derived }; }
  catch { return { source: null }; }
}

export async function readArtifactManifest(root: string): Promise<ArtifactManifest | null> {
  const text = await readText(root, ARTIFACT_MANIFEST_FILE);
  if (text === null) return null;
  try { const parsed = JSON.parse(text) as ArtifactManifest; return parsed.schema === 'cardwright.variable-artifacts' && parsed.files ? parsed : null; }
  catch { return null; }
}

/** Writes 变量表.推导.yaml for a card without an authored table; false when there is nothing to derive from. */
export async function writeDerivedTable(root: string, project?: ProjectComponents): Promise<boolean> {
  if (await readText(root, VARIABLE_TABLE_FILE) !== null) return false;
  const table = deriveVariableTable(project ?? await readProject(root));
  if (!table) return false;
  const text = serializeVariableTable(table);
  if (await readText(root, DERIVED_TABLE_FILE) !== text) await writeText(root, DERIVED_TABLE_FILE, text);
  return true;
}

/**
 * Generates every artifact from 变量表.yaml and writes the ones that changed. Null when the card has no table;
 * throws VariableTableError when the table does not parse. Idempotent: a second run writes nothing.
 */
export async function syncVariableArtifacts(root: string, options: { cardName: string }): Promise<VariableSyncResult | null> {
  const text = await readText(root, VARIABLE_TABLE_FILE);
  if (text === null) return null;
  const table = parseVariableTable(text);
  const stamp = `变量表 ${hashText(text).slice(0, 8)}`;
  const result: VariableSyncResult = { rows: table.rows.length, created: [], written: [], unchanged: [] };
  const files: ArtifactManifest['files'] = {};
  let project = await readProject(root);
  const refresh = async (): Promise<void> => { project = await readProject(root); };

  const put = async (path: string, body: string, current: string, part: 'file' | 'block' = 'file'): Promise<void> => {
    files[path] = { hash: hashText(part === 'block' ? extractPathListBlock(body) ?? body : body), part };
    if (current === body) { result.unchanged.push(path); return; }
    await writeText(root, path, body);
    result.written.push(path);
  };
  /** The parameters a fixed piece must carry (a disabled [initvar], the MVU buttons): set on creation, and put right on an existing component that lost them. */
  const enforce = async (paramsPath: string, params: Record<string, unknown>, extra: Record<string, unknown>): Promise<void> => {
    if (!Object.keys(extra).some(key => JSON.stringify(params[key]) !== JSON.stringify(extra[key]))) return;
    await patchJson(root, paramsPath, current => ({ ...current, ...extra }));
    result.written.push(paramsPath);
  };
  const script = async (test: (body: string, name: string) => boolean, name: string, extra: Record<string, unknown>) => {
    let item = project.scripts.find(candidate => test(candidate.body, String(candidate.params.name ?? candidate.name)));
    if (!item) {
      const made = await createComponent(root, { board: 'script', name });
      if (Object.keys(extra).length) await patchJson(root, made.paramsPath, params => ({ ...params, ...extra }));
      result.created.push(made.bodyPath); await refresh();
      item = project.scripts.find(candidate => candidate.bodyPath === made.bodyPath)!;
    } else await enforce(item.paramsPath, item.params, extra);
    return item;
  };
  const lore = async (test: RegExp, name: string, order: number, extra: Record<string, unknown>) => {
    let entry = project.lore.find(candidate => test.test(String(candidate.params.comment).trim()));
    if (!entry) {
      const made = await createComponent(root, { board: 'lore', section: 'lore-vars', name, order, constant: true, position: 0 });
      if (Object.keys(extra).length) await patchJson(root, made.paramsPath, params => ({ ...params, ...extra }));
      result.created.push(made.bodyPath); await refresh();
      entry = project.lore.find(candidate => candidate.bodyPath === made.bodyPath)!;
    } else await enforce(entry.paramsPath, entry.params, extra);
    return entry;
  };

  const mvu = await script((body, name) => /MVU/i.test(name) && !/registerMvuSchema/.test(body), 'MVU', { button: MVU_BUTTONS });
  await put(mvu.bodyPath, `${MVU_IMPORT_LINE}\n`, mvu.body);
  const zod = await script(body => /registerMvuSchema/.test(body), 'ZOD', {});
  await put(zod.bodyPath, generateZodScript(table, { cardName: options.cardName, stamp }), zod.body);
  // Names are matched at their end so a hand-written 「变量输出格式说明」 is never claimed; imported cards prefix theirs with [mvu_update].
  const initvar = await lore(/\[initvar\]|^初始变量$/i, '[initvar]', 1002, { disable: true });
  await put(initvar.bodyPath, generateInitialVariables(table), initvar.content);
  const list = await lore(/变量列表$/, '变量列表', 9994, {});
  await put(list.bodyPath, `${FIXED_VARIABLE_LIST}\n`, list.content);
  const format = await lore(/变量输出格式$/, '变量输出格式', 9996, {});
  await put(format.bodyPath, generateOutputFormat(table), format.content);
  const rules = await lore(/变量(?:更新)?规则$/, '变量规则', 9995, {});
  const block = generatePathList(table);
  await put(rules.bodyPath, rules.content.trim() ? replacePathListBlock(rules.content, block) : `${RULES_INTRO}\n\n${block}\n`, rules.content, 'block');
  if (!project.regex.some(item => item.params.promptOnly === true && /UpdateVariable/i.test(String(item.params.findRegex ?? '')))) {
    const made = await createComponent(root, { board: 'regex', name: CLEANUP_REGEX_NAME });
    await patchJson(root, made.paramsPath, params => ({ ...params, findRegex: CLEANUP_REGEX_FIND, markdownOnly: false, promptOnly: true, minDepth: 6, maxDepth: null }));
    result.created.push(made.bodyPath);
  }
  const manifest: ArtifactManifest = { schema: 'cardwright.variable-artifacts', version: 1, table: hashText(text), at: new Date().toISOString(), files };
  await writeText(root, ARTIFACT_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}
