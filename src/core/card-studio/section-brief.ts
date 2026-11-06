import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { referenceLine } from '../../shared/card-studio/dispatch.ts';
import type { CardDispatch, CardDispatchReference, CardDispatchReferenceInput } from '../../shared/card-studio/types.ts';

/** One dispatch carries at most this many references; one read stays under this many lines. */
export const REFERENCE_LIMIT = 8;
export const REFERENCE_LINE_LIMIT = 200;
export const REFERENCES_TOTAL_LINE_LIMIT = 600;

const DESIGN_BOOK = '设计书.md';
const VARIABLE_TABLE = '变量表.yaml';
const SOURCE_INDEX = '资料/索引.md';

/** A project-relative path with no traversal or drive letter; null when the path is refused. */
export function projectFilePath(root: string, path: string): string | null {
  const normal = path.trim().replace(/\\/g, '/');
  if (!normal || normal.startsWith('/') || normal.startsWith('~') || /^[a-zA-Z]:/.test(normal)) return null;
  const parts = normal.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) return null;
  const base = resolve(root);
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return parts.join('/');
}

async function fileLines(root: string, path: string): Promise<string[] | null> {
  const safe = projectFilePath(root, path);
  if (!safe) return null;
  try {
    return (await readFile(join(root, ...safe.split('/')), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/);
  } catch { return null; }
}

function headingAt(lines: readonly string[], heading: string): { index: number; level: number } | null {
  const needle = heading.trim();
  if (!needle) return null;
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index].trim());
    if (match && match[2].includes(needle)) return { index, level: match[1].length };
  }
  return null;
}

/** The line range from a heading to the next heading at the same or a higher level. */
function headingRange(lines: readonly string[], index: number, level: number): { offset: number; lines: number } {
  let end = lines.length;
  for (let next = index + 1; next < lines.length; next++) {
    const match = /^(#{1,6})\s+/.exec(lines[next].trim());
    if (match && match[1].length <= level) { end = next; break; }
  }
  return { offset: index + 1, lines: Math.max(1, Math.min(REFERENCE_LINE_LIMIT, end - index)) };
}

function clampLines(value: number | undefined): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return 40;
  return Math.min(REFERENCE_LINE_LIMIT, Math.max(1, Math.round(value as number)));
}

/**
 * Resolve what planning gave into real line ranges in this card project. A heading is
 * turned into the range that follows it; an explicit offset is clamped to the file. A
 * missing file or bad path is dropped rather than stored as a broken reference.
 */
export async function resolveDispatchReferences(root: string, inputs: readonly CardDispatchReferenceInput[] | undefined): Promise<CardDispatchReference[]> {
  if (!inputs?.length) return [];
  const output: CardDispatchReference[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const input of inputs.slice(0, REFERENCE_LIMIT)) {
    const path = projectFilePath(root, input.path);
    if (!path) continue;
    const lines = await fileLines(root, path);
    if (!lines?.length) continue;
    let offset: number;
    let count: number;
    let heading = input.heading?.trim() || undefined;
    if (heading) {
      const found = headingAt(lines, heading);
      if (!found) continue;
      const range = headingRange(lines, found.index, found.level);
      offset = range.offset;
      count = range.lines;
    } else {
      const rawOffset = Number.isInteger(input.offset) ? Math.max(1, Math.min(lines.length, input.offset as number)) : 1;
      offset = rawOffset;
      count = Math.min(clampLines(input.lines), lines.length - rawOffset + 1);
    }
    if (count < 1) continue;
    if (total + count > REFERENCES_TOTAL_LINE_LIMIT) continue;
    const key = `${path}:${offset}:${count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += count;
    const summary = input.summary?.trim().slice(0, 240) || undefined;
    output.push({ path, offset, lines: count, ...(heading ? { heading } : {}), ...(summary ? { summary } : {}) });
  }
  return output;
}

/** The design-book headings a section usually needs, in the order they are worth reading. */
const SECTION_HEADINGS: Record<string, string[]> = {
  'lore-people': ['主角与配角', '人物名单', '世界观'],
  'lore-overview': ['作品与范围', '世界观', '玩法'],
  'lore-setting': ['世界观', '作品与范围'],
  'lore-plot': ['剧情', '可做清单与顺序', '世界观'],
  'lore-rules': ['玩法', '剧情', '文风'],
  'lore-vars': ['变量与脚本', '变量结构', '玩法'],
  'lore-format': ['正文格式', '文风', '玩法'],
  'script-schema': ['变量与脚本', '变量结构', '玩法'],
  'script-controller': ['变量与脚本', '玩法', '变量结构'],
  'script-mechanism': ['玩法', '变量与脚本', '变量结构'],
  'regex-update': ['变量与脚本', '前端', '玩法'],
  'regex-status': ['前端', '变量与脚本', '玩法'],
  'regex-body': ['正文格式', '文风', '前端'],
  'regex-start': ['开场白', '前端', '主角与配角'],
  greet: ['开场白', '主角与配角', '正文格式'],
};

const countVariables = (lines: readonly string[]): number => lines.filter(line => /^\s*-\s+path\s*:/.test(line)).length;

/** References derived from the card when planning did not give any. */
async function derivedReferences(root: string, sectionId: string): Promise<CardDispatchReference[]> {
  const references: CardDispatchReference[] = [];
  const design = await fileLines(root, DESIGN_BOOK);
  if (design?.length) {
    for (const heading of SECTION_HEADINGS[sectionId] ?? ['作品与范围', '世界观']) {
      const found = headingAt(design, heading);
      if (!found) continue;
      const range = headingRange(design, found.index, found.level);
      references.push({ path: DESIGN_BOOK, heading, offset: range.offset, lines: range.lines });
      if (references.length >= 2) break;
    }
    if (!references.length) references.push({ path: DESIGN_BOOK, offset: 1, lines: Math.min(80, design.length), summary: '设计书开头' });
  }
  const variables = await fileLines(root, VARIABLE_TABLE);
  if (variables?.length) {
    const count = countVariables(variables);
    references.push({ path: VARIABLE_TABLE, offset: 1, lines: Math.min(120, variables.length), summary: count ? `变量表，共 ${count} 个变量` : '变量表' });
  }
  const index = await fileLines(root, SOURCE_INDEX);
  if (index?.length) references.push({ path: SOURCE_INDEX, offset: 1, lines: Math.min(40, index.length), summary: '资料索引' });
  return references.slice(0, REFERENCE_LIMIT);
}

/**
 * 分区项目摘要: what the section needs to read, short enough to sit in the prompt.
 * Planning's own brief and references win; otherwise the card's design book, variable
 * table and source index are reduced to the headings this section usually uses.
 */
export async function buildSectionBrief(root: string, dispatch: Pick<CardDispatch, 'title' | 'brief' | 'references'> | undefined, sectionId: string): Promise<string | null> {
  if (!dispatch) return null;
  const brief = dispatch.brief?.trim();
  const references = dispatch.references?.length ? dispatch.references : await derivedReferences(root, sectionId);
  if (!brief && !references.length) return null;
  return [
    '## 本次派单摘要',
    '',
    `- 派单：${dispatch.title}`,
    ...(brief ? [`- 规划要点：${brief.replace(/\s*\n\s*/g, ' ')}`] : []),
    ...(references.length ? ['', '参考资料（先读这些行，不要整本读）：', ...references.map(referenceLine)] : []),
    '',
    '先读上面列出的行；摘要没写到的细节，再用 `read` 的 `offset` / `limit` 读原文件对应段落，不要整本通读。',
  ].join('\n');
}

/** The reference lines as one compact line, for prompts and tests. */
export function referencesText(references: readonly CardDispatchReference[]): string {
  return references.map(referenceLine).join('\n');
}
