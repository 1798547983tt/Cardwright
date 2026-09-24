/**
 * A 变量表 read off a card that has none (ADR 0020, Q17): structure and defaults from [initvar]; ranges, enums and
 * limits from the parts of the Zod script that show them. Only for the checks and 改动单. It never rewrites the
 * card's own Zod.
 */
import type { ProjectComponents } from './components.ts';
import { parseInitialVariables } from './variables.ts';
import { ELEMENT_PLACEHOLDER, KEY_PLACEHOLDER, escapeSegment, type VariableRow, type VariableTable } from '../../shared/card-studio/variable-table.ts';

const INITVAR = /initvar|初始变量/i;
const ZOD = /registerMvuSchema/;
export const DERIVED_NOTE = '推导的变量表：结构与默认值来自 [initvar]，范围、取值与条数上限来自 Zod 脚本里认得出的写法；认不出的没有写。只用于核对，不会改写这张卡的 Zod。';

export interface ZodHint { range?: [number, number]; values?: string[]; limit?: number }

const LIMIT_WRAPPER = /limitedRecord|limitedList|\bCap\(|takeRight|slice\(-/;
/** The count of a limit wrapper: the trailing `, 12)` (or `takeRight(12)` / `slice(-8)`) of the declaration. It is only trusted at the end of the line — a count buried in further calls, like `slice(-8)` inside a transform, is not one. */
function lineLimit(line: string): number | undefined {
  if (!LIMIT_WRAPPER.test(line)) return undefined;
  const match = /(?:takeRight\(|slice\(-|,\s*)(\d+)\s*\)[^)]*$/.exec(line.replace(/,\s*$/, ''));
  return match ? Number(match[1]) : undefined;
}

/**
 * What a `名字: …` piece of the Zod script gives away, keyed by field name. Range and values come from the
 * field's own segment (up to the next `名字:` on the line): `percent(100)` or `clamp(v, 0, 100)` → range,
 * `z.enum([...])` → values. A limit wrapper (`limitedRecord(…, 12)`, `limitedList`, `Cap(`, `takeRight`,
 * `slice(-`) spans the whole field declaration — its count sits at the end of the line, past the inner fields —
 * so the limit is read off the whole line and recorded for the line's first field name only.
 */
export function zodHints(code: string): Map<string, ZodHint> {
  const hints = new Map<string, ZodHint>();
  for (const line of code.split(/\r?\n/)) {
    const names = [...line.matchAll(/(?:^|[\s{,(])["']?([\p{L}\p{N}_]+)["']?\s*:(?!:)/gu)];
    for (const [index, match] of names.entries()) {
      const name = match[1];
      const from = match.index! + match[0].length;
      const to = index + 1 < names.length ? names[index + 1].index! : line.length;
      const segment = line.slice(from, to);
      const hint: ZodHint = {};
      const clamp = /clamp\([^,]+,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(segment);
      if (clamp) hint.range = [Number(clamp[1]), Number(clamp[2])];
      else if (/\bpercent\(/.test(segment)) hint.range = [0, 100];
      const values = /(?:z\.enum|enumOf)\(\s*\[([^\]]*)\]/.exec(segment);
      if (values) hint.values = [...values[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]);
      if (index === 0) {
        const limit = lineLimit(line);
        if (limit !== undefined) hint.limit = limit;
      }
      if (hint.range || hint.values || hint.limit) hints.set(name, hint);
    }
  }
  return hints;
}

const isPlain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shape = (value: object): string => JSON.stringify(Object.keys(value).sort());
/** Two or more values that are objects with the same fields: a record of items, not a fixed set of fields. */
const looksLikeRecord = (value: Record<string, unknown>): boolean => {
  const items = Object.values(value);
  return items.length >= 2 && items.every(item => isPlain(item)) && items.every(item => shape(item as object) === shape(items[0] as object));
};
const clampTo = (value: number, range?: [number, number]): number => (range ? Math.min(Math.max(value, range[0]), range[1]) : value);

function walk(value: unknown, path: string, name: string, rows: VariableRow[], hints: Map<string, ZodHint>): void {
  const hint = hints.get(name) ?? {};
  if (typeof value === 'number') { rows.push({ path, type: '数值', owner: '模型', default: Number.isFinite(value) ? clampTo(value, hint.range) : 0, ...(hint.range ? { range: hint.range } : {}) }); return; }
  if (typeof value === 'boolean') { rows.push({ path, type: '布尔', owner: '模型', default: value }); return; }
  if (value === null || value === undefined || typeof value === 'string') {
    const text = value == null ? '' : value;
    if (hint.values?.length) rows.push({ path, type: '枚举', owner: '模型', values: hint.values, default: hint.values.includes(text) ? text : hint.values[0] });
    else rows.push({ path, type: '文本', owner: '模型', default: text });
    return;
  }
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    const element = typeof first === 'number' ? '数值' : typeof first === 'boolean' ? '布尔' : isPlain(first) ? '对象' : '文本';
    rows.push({ path, type: '列表', owner: '模型', element, ...(hint.limit ? { limit: hint.limit } : {}) });
    if (isPlain(first)) for (const [key, item] of Object.entries(first)) walk(item, `${path}/${ELEMENT_PLACEHOLDER}/${escapeSegment(key)}`, key, rows, hints);
    return;
  }
  if (isPlain(value)) {
    if (!Object.keys(value).length || looksLikeRecord(value)) {
      rows.push({ path, type: '记录', owner: '模型', ...(hint.limit ? { limit: hint.limit } : {}), ...(Object.keys(value).length ? {} : { note: '初始为空，项的字段未知' }) });
      const sample: unknown = Object.values(value)[0];
      if (isPlain(sample)) for (const [key, item] of Object.entries(sample)) walk(item, `${path}/${KEY_PLACEHOLDER}/${escapeSegment(key)}`, key, rows, hints);
      return;
    }
    rows.push({ path, type: '对象', owner: '模型' });
    for (const [key, item] of Object.entries(value)) walk(item, `${path}/${escapeSegment(key)}`, key, rows, hints);
    return;
  }
  rows.push({ path, type: '文本', owner: '模型', default: String(value) });
}

export function deriveVariableTable(project: ProjectComponents): VariableTable | null {
  const initvar = project.lore.find(entry => INITVAR.test(String(entry.params.comment)));
  if (!initvar) return null;
  let value: unknown;
  try { value = parseInitialVariables(initvar.content); } catch { return null; }
  const hints = zodHints(project.scripts.find(script => ZOD.test(script.body))?.body ?? '');
  const rows: VariableRow[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `/${escapeSegment(key)}`, key, rows, hints);
  return rows.length ? { version: 1, note: DERIVED_NOTE, rows } : null;
}
