/**
 * Assembly checks (handoff §5.21). Deterministic: the same components always give the same findings.
 * Errors block the export, warnings are listed, information is reported. This stage covers the world book.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCardFile } from './card-project.ts';
import { buildCardFromProject, readProject, WRAPPED_SECTIONS, type LoreComponent, type ProjectComponents } from './components.ts';
import { splitCard } from '../../shared/card-studio/card-file.ts';
import { UNCLASSIFIED_SECTION } from '../../shared/card-studio/boards.ts';
import { checkRegexParams, compileRegex, regexHits, sampleOutputFrom } from './regex.ts';
import { parseInitialVariables, validateInSandbox, type SandboxOptions } from './variables.ts';

import type { CardCheckFinding, CardCheckReport } from '../../shared/card-studio/types.ts';
export type CheckFinding = CardCheckFinding;
export type CheckStats = CardCheckReport['stats'];
export type CheckReport = CardCheckReport;

const KEY_RANGE: Record<string, { min: number; max: number }> = {
  'lore-setting': { min: 2, max: 3 },
  'lore-people': { min: 1, max: 5 },
};
const DATE_KEY = /\d{1,4}\s*年.*?月.*?日|\d{4}-\d{2}-\d{2}/;
const CITATION = /第\s*\d+\s*(章|回|节|页)|出处：|页码|资料未载/;
const TITLE_INDEX = /标题剧情索引|剧情索引/;
const INITVAR = /initvar|初始变量/i;
const VARIABLE_LIST = /^变量列表/;
const ZOD_SCRIPT = /registerMvuSchema/;
const MVU_FIXED = /MVU-offline@/;
/** The fixed 变量列表 body (handoff §8.6); anything else has been edited by hand. */
const FIXED_VARIABLE_LIST = ['---', '<status_current_variables>', '{{format_message_variable::stat_data}}', '</status_current_variables>'].join(String.fromCharCode(10));
const OVERVIEW = /总览$/;

/** A rough budget number: Chinese characters cost about 0.7 tokens, other text about a quarter of a character. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) { const code = char.codePointAt(0)!; if (code > 0x2e80) cjk++; }
  return Math.round(cjk * 0.7 + (text.length - cjk) / 4);
}

const firstLine = (body: string): string => body.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
const lastLine = (body: string): string => [...body.split('\n').map(line => line.trim())].reverse().find(line => line.length > 0) ?? '';

function checkWrapper(entry: LoreComponent, findings: CheckFinding[]): void {
  if (!WRAPPED_SECTIONS.has(entry.section) || !entry.content.trim()) return;
  const open = /^<([^/<>\s][^<>]*)>$/.exec(firstLine(entry.content));
  const close = /^<\/([^<>]+)>$/.exec(lastLine(entry.content));
  const at = { uid: entry.uid, path: entry.bodyPath };
  if (!open) {
    const wrongWayRound = /^<\/([^<>]+)>$/.exec(firstLine(entry.content));
    findings.push({ level: 'error', code: 'wrap-tag', ...at, message: wrongWayRound
      ? `「${entry.params.comment}」的正文开头写成了 </${wrongWayRound[1]}>，应该是 <${wrongWayRound[1]}>。`
      : `「${entry.params.comment}」的正文开头不是 <条目名>，条目没有被包裹标签包住。` });
    return;
  }
  if (!close || close[1] !== open[1]) {
    findings.push({ level: 'error', code: 'wrap-tag', ...at, message: `「${entry.params.comment}」的正文以 <${open[1]}> 开始，但结尾不是 </${open[1]}>。` });
  }
}

function checkKeys(entry: LoreComponent, findings: CheckFinding[]): void {
  const keys = Array.isArray(entry.params.key) ? entry.params.key.filter(key => String(key).trim()) : [];
  const range = KEY_RANGE[entry.section];
  const at = { uid: entry.uid, path: entry.paramsPath };
  if (!entry.params.constant && !entry.params.disable && keys.length === 0) {
    findings.push({ level: 'warning', code: 'key-count', ...at, message: `「${entry.params.comment}」不是常驻条目，却没有关键词，永远不会被触发。` });
    return;
  }
  if (range && !entry.params.constant && keys.length && (keys.length < range.min || keys.length > range.max)) {
    findings.push({ level: 'warning', code: 'key-count', ...at, message: `「${entry.params.comment}」有 ${keys.length} 个关键词，本分区建议 ${range.min}–${range.max} 个。` });
  }
  if (entry.section === 'lore-plot' && !entry.params.constant && !keys.some(key => DATE_KEY.test(String(key)))) {
    findings.push({ level: 'warning', code: 'plot-date', ...at, message: `剧情条目「${entry.params.comment}」的关键词里没有完整日期，按卡内历法应该写上每个完整日期。` });
  }
}

function checkCollisions(lore: LoreComponent[], findings: CheckFinding[]): void {
  const byKey = new Map<string, LoreComponent[]>();
  for (const entry of lore) {
    if (entry.params.disable) continue;
    for (const key of Array.isArray(entry.params.key) ? entry.params.key : []) {
      const value = String(key).trim();
      if (!value) continue;
      byKey.set(value, [...(byKey.get(value) ?? []), entry]);
    }
  }
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    // Plot entries share the dates of the days they cover; that is how the handoff wants them keyed (§5.4).
    if (DATE_KEY.test(key) && entries.every(item => item.section === 'lore-plot')) continue;
    const names = entries.map(item => `${item.params.comment}(${item.uid})`).join('、');
    findings.push({ level: 'warning', code: 'key-collision', message: `关键词「${key}」同时属于 ${entries.length} 条条目：${names}。一出现就会同时触发它们。` });
  }
}

/** Field names listed under a 字段 heading of the character or plot template. */
export function templateFields(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{1,6}\s.*字段/.test(line.trim()));
  if (start < 0) return [];
  const fields: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (/^#{1,6}\s/.test(text)) break;
    const item = /^[-*+]\s+(.+)$/.exec(text);
    if (!item) continue;
    const name = item[1].split(/[：:（(]/)[0].trim();
    if (name) fields.push(name);
  }
  return fields;
}

/** uids recorded in a 出处索引 table. */
export function sourceIndexUids(markdown: string): Set<number> {
  const uids = new Set<number>();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.trim().startsWith('|') ? line.split('|').map(cell => cell.trim()).filter(Boolean) : [];
    for (const cell of cells) { if (/^\d+$/.test(cell)) { uids.add(Number(cell)); break; } }
  }
  return uids;
}

const readOptional = async (root: string, relative: string): Promise<string | null> => {
  try { return (await readFile(join(root, ...relative.split('/')), 'utf8')).replace(/^\uFEFF/, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

async function checkTemplates(root: string, project: ProjectComponents, findings: CheckFinding[]): Promise<void> {
  const people = project.lore.filter(entry => entry.section === 'lore-people' && !OVERVIEW.test(String(entry.params.comment)));
  const plots = project.lore.filter(entry => entry.section === 'lore-plot' && !TITLE_INDEX.test(String(entry.params.comment)));
  const pairs: Array<{ entries: LoreComponent[]; template: string; index: string; label: string }> = [
    { entries: people, template: '世界书/人设/人物模板.md', index: '世界书/人设/出处索引.md', label: '人物' },
    { entries: plots, template: '世界书/剧情/剧情模板.md', index: '世界书/剧情/出处索引.md', label: '剧情' },
  ];
  for (const pair of pairs) {
    if (!pair.entries.length) continue;
    const template = await readOptional(root, pair.template);
    const fields = template ? templateFields(template) : [];
    if (template && !fields.length) findings.push({ level: 'warning', code: 'template-fields-missing', path: pair.template, message: `${pair.label}模板里没有「字段清单」小节，无法核对条目字段。` });
    for (const entry of pair.entries) {
      if (fields.length) {
        const missing = fields.filter(field => !entry.content.includes(field));
        if (missing.length) findings.push({ level: 'warning', code: 'template-field', uid: entry.uid, path: entry.bodyPath, message: `「${entry.params.comment}」缺少${pair.label}模板要求的字段：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 项` : ''}。` });
      }
    }
    const index = await readOptional(root, pair.index);
    if (index === null) {
      findings.push({ level: 'warning', code: 'source-index-missing', path: pair.index, message: `还没有${pair.label}的出处索引（${pair.index}），无法核对每条条目的原文出处。` });
      continue;
    }
    const uids = sourceIndexUids(index);
    for (const entry of pair.entries) {
      if (!uids.has(entry.uid)) findings.push({ level: 'warning', code: 'source-index', uid: entry.uid, path: pair.index, message: `出处索引里没有「${entry.params.comment}」(uid ${entry.uid}) 的记录。` });
    }
  }
}

/** The sample output nests like XML: one root, every tag closed in order; `<x/>` stands alone. Returns what is wrong, or null. */
export function sampleShapeProblem(sample: string): string | null {
  const stack: string[] = [];
  let roots = 0;
  for (const match of sample.matchAll(/<(\/?)([^\s<>/!]+)[^<>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) { if (!stack.length) roots++; continue; }
    if (!closing) { if (!stack.length) roots++; stack.push(name); continue; }
    const open = stack.pop();
    if (open !== name) return open ? `<${open}> 还没有闭合就出现了 </${name}>。` : `</${name}> 没有对应的开始标签。`;
  }
  if (stack.length) return `<${stack[stack.length - 1]}> 没有闭合。`;
  if (roots > 1) return `示例输出只能有一个根元素，现在有 ${roots} 个。`;
  return null;
}

/** §5.21: the sample output is itself in the format, its volume headings exist, and plot dates use its calendar. */
function checkFormatSample(project: ProjectComponents, format: LoreComponent, sample: string, findings: CheckFinding[]): void {
  const shape = sampleShapeProblem(sample);
  if (shape) findings.push({ level: 'error', code: 'format-sample-shape', uid: format.uid, path: format.bodyPath, message: `正文格式的示例输出结构不对：${shape}` });
  const index = project.lore.find(entry => TITLE_INDEX.test(String(entry.params.comment)));
  if (index) {
    for (const [, heading] of sample.matchAll(/<story\b[^>]*>([\s\S]*?)<\/story>/g)) {
      const title = heading.trim();
      if (title && !index.content.includes(title)) findings.push({ level: 'error', code: 'format-sample-story', uid: format.uid, path: format.bodyPath, message: `示例输出里的篇章「${title}」不在标题剧情索引里。篇章标题只能从索引里取。` });
    }
  }
  const time = /<time\b[^>]*>([\s\S]*?)<\/time>/.exec(sample)?.[1]?.trim() ?? '';
  const calendar = /^([^\d一二三四五六七八九十〇零元]+)/.exec(time)?.[1]?.trim();
  if (!calendar) return;
  for (const entry of project.lore.filter(item => item.section === 'lore-plot' && !TITLE_INDEX.test(String(item.params.comment)))) {
    const dates = (Array.isArray(entry.params.key) ? entry.params.key : []).map(String).filter(key => DATE_KEY.test(key));
    if (dates.length && !dates.some(key => key.trim().startsWith(calendar))) {
      findings.push({ level: 'warning', code: 'plot-calendar', uid: entry.uid, path: entry.paramsPath, message: `剧情条目「${entry.params.comment}」的日期关键词没有写「${calendar}」，和正文格式里的时间写法对不上，正文里出现这一天时触发不了。` });
    }
  }
}

/** §5.21: every uid the world book controller names exists, under the same name. The table is written as uid: N, name: '…'. */
function checkControllerUids(project: ProjectComponents, findings: CheckFinding[]): void {
  const byUid = new Map(project.lore.map(entry => [entry.uid, entry]));
  for (const script of project.scripts) {
    const label = String(script.params.name ?? script.name);
    for (const match of script.body.matchAll(/\buid\s*:\s*(\d+)\s*,\s*name\s*:\s*(['"`])((?:(?!\2)[^\n])*)\2/g)) {
      const uid = Number(match[1]);
      const name = match[3];
      const entry = byUid.get(uid);
      if (!entry) findings.push({ level: 'error', code: 'controller-uid', path: script.bodyPath, message: `「${label}」切换的世界书条目 uid ${uid}（${name}）不存在。` });
      else if (String(entry.params.comment) !== name) findings.push({ level: 'error', code: 'controller-uid', uid, path: script.bodyPath, message: `「${label}」里 uid ${uid} 写的是「${name}」，世界书里这条叫「${entry.params.comment}」。控制器按 uid 找条目并核对名称，名称不符会拒绝切换。` });
    }
  }
}

function checkPlotIndex(project: ProjectComponents, findings: CheckFinding[]): void {
  const plots = project.lore.filter(entry => entry.section === 'lore-plot');
  const index = plots.find(entry => TITLE_INDEX.test(String(entry.params.comment)));
  const entries = plots.filter(entry => entry !== index);
  if (!entries.length) return;
  if (!index) {
    findings.push({ level: 'warning', code: 'plot-index-missing', message: '有剧情条目，但没有标题剧情索引。正文格式允许使用的篇章标题都从索引里取。' });
    return;
  }
  for (const entry of entries) {
    const title = String(entry.params.comment).trim();
    if (title && !index.content.includes(title)) findings.push({ level: 'warning', code: 'plot-index', uid: entry.uid, path: index.bodyPath, message: `标题剧情索引里没有「${title}」，剧情条目与索引对不上。` });
  }
}

function checkExportReadback(project: ProjectComponents, findings: CheckFinding[]): void {
  try {
    const card = buildCardFromProject(project);
    const again = splitCard(JSON.parse(JSON.stringify(card)) as Record<string, unknown>);
    if (again.lore.length !== project.lore.length) {
      findings.push({ level: 'error', code: 'export-readback', message: `导出的 JSON 重新读回后条目数不一致：${again.lore.length} ≠ ${project.lore.length}。` });
      return;
    }
    for (const [index, item] of again.lore.entries()) {
      const source = project.lore[index];
      if (item.params.uid !== source.uid || item.content !== source.content) {
        findings.push({ level: 'error', code: 'export-readback', uid: source.uid, message: `导出的 JSON 重新读回后，条目「${source.params.comment}」与组件文件不一致。` });
        return;
      }
    }
    findings.push({ level: 'info', code: 'export-readback', message: `导出的 JSON 重新读回后，${again.lore.length} 条条目与组件文件一致。` });
  } catch (error) {
    findings.push({ level: 'error', code: 'export-readback', message: `导出的 JSON 无法重新读回：${error instanceof Error ? error.message : String(error)}` });
  }
}

/** Tag names written in a text: <content>, </time>, <StatusPlaceHolderImpl/>. */
const tagNames = (text: string): Set<string> => new Set([...text.matchAll(/<\\?\/?([A-Za-z_][\w-]*)/g)].map(match => match[1].toLowerCase()));

function checkRegexComponents(project: ProjectComponents, sample: string | null, findings: CheckFinding[]): void {
  const ids = new Map<string, string>();
  // Only a regex aimed at a tag the body sample defines has to hit it; the update block and the start page have their own formats.
  const sampleTags = sample ? tagNames(sample) : new Set<string>();
  for (const item of project.regex) {
    const label = String(item.params.scriptName ?? item.name);
    findings.push(...checkRegexParams(item.params).map(finding => ({ ...finding, path: item.paramsPath })));
    const id = String(item.params.id ?? '');
    if (id && ids.has(id)) findings.push({ level: 'error', code: 'regex-id', path: item.paramsPath, message: `正则 id ${id} 重复：「${ids.get(id)}」与「${label}」。酒馆按 id 替换单件。` });
    else if (id) ids.set(id, label);
    let compiled: RegExp | undefined;
    try { compiled = compileRegex(item.params.findRegex); }
    catch (error) { findings.push({ level: 'error', code: 'regex-compile', path: item.paramsPath, message: `「${label}」${error instanceof Error ? error.message : String(error)}` }); }
    const placement = Array.isArray(item.params.placement) ? item.params.placement.map(Number) : [];
    const aimsAtBody = [...tagNames(String(item.params.findRegex ?? ''))].some(tag => sampleTags.has(tag));
    if (compiled && sample && aimsAtBody && item.params.markdownOnly === true && placement.includes(2) && item.params.disabled !== true && !regexHits(compiled, sample)) {
      findings.push({ level: 'warning', code: 'regex-sample', path: item.paramsPath, message: `「${label}」是只改显示的正则，但命中不了正文格式的示例输出。` });
    }
    if (!item.body.trim() && item.params.promptOnly !== true) {
      findings.push({ level: 'warning', code: 'regex-empty', path: item.bodyPath, message: `「${label}」的替换内容是空的。只改提示词的正则才用空替换。` });
    }
  }
}

function checkScriptComponents(project: ProjectComponents, findings: CheckFinding[]): void {
  const ids = new Map<string, string>();
  for (const item of project.scripts) {
    const label = String(item.params.name ?? item.name);
    const id = String(item.params.id ?? '');
    if (!id) findings.push({ level: 'error', code: 'script-id', path: item.paramsPath, message: `脚本「${label}」没有 id，酒馆无法替换单件。` });
    else if (ids.has(id)) findings.push({ level: 'error', code: 'script-id', path: item.paramsPath, message: `脚本 id ${id} 重复：「${ids.get(id)}」与「${label}」。` });
    else ids.set(id, label);
    if (/MVU/i.test(label) && !MVU_FIXED.test(item.body)) {
      findings.push({ level: 'warning', code: 'fixed-piece', path: item.bodyPath, message: `「${label}」看起来是 MVU 固定件，但内容不是固定的 MVU-offline 导入行。固定件要原样使用。` });
    }
    if (ZOD_SCRIPT.test(item.body) && !/registerMvuSchema\s*\(\s*Schema\s*\)/.test(item.body)) {
      findings.push({ level: 'warning', code: 'zod-register', path: item.bodyPath, message: `「${label}」注册了 Zod，但结尾不是固定的 registerMvuSchema(Schema) 写法。` });
    }
  }
}

function checkGreetings(project: ProjectComponents, rootTag: string | null, findings: CheckFinding[]): void {
  if (!project.greetings.length) {
    findings.push({ level: 'warning', code: 'greeting-missing', message: '这张卡还没有开场白。导入酒馆后第一条消息会是空的。' });
    return;
  }
  for (const greeting of project.greetings) {
    if (!greeting.text.trim()) { findings.push({ level: 'warning', code: 'greeting-empty', path: greeting.path, message: `开场白「${greeting.path}」是空的。` }); continue; }
    if (/<start>/.test(greeting.text)) continue;
    if (rootTag && !greeting.text.includes(`<${rootTag}>`)) {
      findings.push({ level: 'warning', code: 'greeting-format', path: greeting.path, message: `开场白「${greeting.path}」没有按正文格式写（缺 <${rootTag}>），第一条消息不会被正文美化渲染。` });
    }
  }
}

/** The root tag the text format entry defines, taken from its sample output. */
function formatRootTag(sample: string | null): string | null {
  if (!sample) return null;
  const match = /<([A-Za-z_][\w-]*)>/.exec(sample);
  return match ? match[1] : null;
}

/** JSON Pointer paths mentioned in rule text. Chinese prose puts full-width punctuation right after a path, so that ends it. */
function pointerPaths(text: string): string[] {
  const found = text.matchAll(/(?:^|[\s（(「『【《：，、])(\/[^\s"'`,;:)）：，。；、」』】》！？]+)/g);
  return [...new Set([...found].map(match => match[1].replace(/\.+$/, '')).filter(path => path.length > 1))];
}

/** `{死亡ID}`, `<键>`, `*` and the array append `-` stand for any member: rules describe records by pattern. */
const PLACEHOLDER = /^(?:\{[^{}]+\}|<[^<>]+>|\*|-)$/;

function valueAtPointer(value: unknown, pointer: string): boolean {
  let current: unknown = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object') return false;
    // Past a placeholder the member is unknown, so only the container it belongs to can be checked.
    if (PLACEHOLDER.test(key)) return true;
    if (Array.isArray(current)) { const index = Number(key); if (!Number.isInteger(index) || index < 0 || index >= current.length) return false; current = current[index]; continue; }
    if (!Object.hasOwn(current as Record<string, unknown>, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

async function checkVariables(project: ProjectComponents, findings: CheckFinding[], sandbox?: SandboxOptions): Promise<void> {
  const initvar = project.lore.find(entry => INITVAR.test(String(entry.params.comment)));
  const zod = project.scripts.find(script => ZOD_SCRIPT.test(script.body));
  const variableList = project.lore.find(entry => VARIABLE_LIST.test(String(entry.params.comment).trim()));
  if (variableList && variableList.content.trim() !== FIXED_VARIABLE_LIST) {
    findings.push({ level: 'warning', code: 'fixed-piece', uid: variableList.uid, path: variableList.bodyPath, message: '「变量列表」是固定件，内容被改过了。它必须与固定写法一字不差。' });
  }
  if (!initvar) return;
  if (!zod) { findings.push({ level: 'warning', code: 'zod-missing', uid: initvar.uid, message: '有初始变量，但没有找到注册 Zod 的脚本，无法校验初始变量。' }); return; }
  let initial: unknown;
  try { initial = parseInitialVariables(initvar.content); }
  catch (error) { findings.push({ level: 'error', code: 'initvar-parse', uid: initvar.uid, path: initvar.bodyPath, message: error instanceof Error ? error.message : String(error) }); return; }
  if (!sandbox) { findings.push({ level: 'info', code: 'initvar-skipped', message: '没有配置变量结构沙箱，跳过了 Zod 校验。' }); return; }
  const result = await validateInSandbox(zod.body, initial, sandbox);
  if (result.error) { findings.push({ level: 'error', code: 'initvar-invalid', uid: initvar.uid, path: zod.bodyPath, message: result.error }); return; }
  if (!result.ok) {
    for (const issue of result.issues.slice(0, 8)) findings.push({ level: 'error', code: 'initvar-invalid', uid: initvar.uid, path: initvar.bodyPath, message: `初始变量不符合变量结构：${issue.path} — ${issue.message}` });
    if (result.issues.length > 8) findings.push({ level: 'error', code: 'initvar-invalid', uid: initvar.uid, message: `初始变量还有 ${result.issues.length - 8} 处不符合变量结构。` });
    return;
  }
  findings.push({ level: 'info', code: 'initvar-ok', message: `初始变量通过了卡里的 Zod 校验（在${result.restricted ? '受限' : '独立'}进程里执行）。` });
  // Our own entries are 变量规则 / 变量输出格式; MVU cards in the wild (Re0 included) call the first one 变量更新规则.
  const rules = project.lore.filter(entry => /变量(?:更新)?规则|变量输出格式/.test(String(entry.params.comment)));
  for (const rule of rules) {
    for (const pointer of pointerPaths(rule.content)) {
      if (!valueAtPointer(result.value, pointer)) {
        findings.push({ level: 'warning', code: 'variable-path', uid: rule.uid, path: rule.bodyPath, message: `「${rule.params.comment}」里的路径 ${pointer} 在变量结构里不存在。` });
      }
    }
  }
}

export async function runChecks(root: string, options: { sandbox?: SandboxOptions } = {}): Promise<CheckReport> {
  const project = await readProject(root);
  const findings: CheckFinding[] = project.issues.map(issue => ({ level: issue.level, code: issue.code, message: issue.message, path: issue.path }));
  const registration = await readCardFile(root).catch(() => null);

  const sections: Record<string, number> = {};
  let constantChars = 0; let constantTokens = 0;
  for (const entry of project.lore) {
    sections[entry.section] = (sections[entry.section] ?? 0) + 1;
    const at = { uid: entry.uid, path: entry.paramsPath };
    if (registration && entry.uid >= registration.nextUid) {
      findings.push({ level: 'error', code: 'uid-unallocated', ...at, message: `uid ${entry.uid} 不是应用分配的。uid 由【新建组件】分配，不要手写。` });
    }
    const position = Number(entry.params.position);
    if (!Number.isInteger(position) || position < 0 || position > 7) findings.push({ level: 'error', code: 'params-invalid', ...at, message: `「${entry.params.comment}」的位置值 ${entry.params.position} 不在 0–7 之间。` });
    if (!Number.isFinite(Number(entry.params.order))) findings.push({ level: 'error', code: 'params-invalid', ...at, message: `「${entry.params.comment}」的顺序不是数字。` });
    if (!entry.content.trim()) findings.push({ level: 'warning', code: 'empty-body', ...at, path: entry.bodyPath, message: `「${entry.params.comment}」的正文是空的。` });
    if (CITATION.test(entry.content)) findings.push({ level: 'warning', code: 'citation', uid: entry.uid, path: entry.bodyPath, message: `「${entry.params.comment}」的正文里出现了章节号或出处字样，条目正文不写出处。` });
    checkWrapper(entry, findings);
    checkKeys(entry, findings);
    if (entry.params.constant && !entry.params.disable) { constantChars += entry.content.length; constantTokens += estimateTokens(entry.content); }
  }
  const unclassified = sections[UNCLASSIFIED_SECTION] ?? 0;
  if (unclassified) findings.push({ level: 'info', code: 'lore-unclassified', message: `有 ${unclassified} 条世界书条目没有归入任何分区（世界书/未分类），会照常导出。` });
  checkCollisions(project.lore, findings);
  await checkTemplates(root, project, findings);
  checkPlotIndex(project, findings);
  const format = project.lore.find(entry => entry.section === 'lore-format');
  const sample = format ? sampleOutputFrom(format.content) : null;
  if (format && !sample) findings.push({ level: 'warning', code: 'format-sample', uid: format.uid, path: format.bodyPath, message: '正文格式条目里没有 ```示例输出 块，正则和拼装检查无法验证渲染。' });
  if (format && sample) checkFormatSample(project, format, sample, findings);
  checkRegexComponents(project, sample, findings);
  checkControllerUids(project, findings);
  checkScriptComponents(project, findings);
  checkGreetings(project, formatRootTag(sample), findings);
  await checkVariables(project, findings, options.sandbox);
  checkExportReadback(project, findings);

  const stats: CheckStats = { entries: project.lore.length, constantChars, constantTokens, sections };
  findings.push({ level: 'info', code: 'budget', message: `常驻条目共 ${constantChars.toLocaleString('zh-CN')} 字，约 ${stats.constantTokens.toLocaleString('zh-CN')} Token（估算）；条目共 ${project.lore.length} 条。` });
  return { ok: !findings.some(item => item.level === 'error'), findings, stats, checkedAt: new Date().toISOString() };
}
