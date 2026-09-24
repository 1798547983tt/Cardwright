/**
 * What the application writes from a 变量表 (ADR 0020): the Zod script, [initvar], the fixed 变量列表, the
 * 变量输出格式 entry and the path list inside 变量规则. Pure text generation; the files are written by
 * core/card-studio/variable-artifacts.ts.
 */
import { stringify as stringifyYaml } from 'yaml';
import { ELEMENT_PLACEHOLDER, KEY_PLACEHOLDER, describeVariableRow, directChildren, isLeaf, lastSegment, pointerSegments, type VariableDefault, type VariableRow, type VariableTable } from './variable-table.ts';

export const MVU_IMPORT_LINE = "import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js'";
/** The six buttons of the MVU fixed piece; only two stay visible (knowledge 40 §2). */
export const MVU_BUTTONS = { enabled: true, buttons: [
  { name: '重新处理变量', visible: true }, { name: '重新读取初始变量', visible: false }, { name: '快照楼层', visible: false },
  { name: '重演楼层', visible: false }, { name: '重试额外模型解析', visible: true }, { name: '清除旧楼层变量', visible: false },
] };
export const ZOD_IMPORT_LINE = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';";
/** The fixed 变量列表 body (handoff 0.8 §8.6); anything else has been edited by hand. */
export const FIXED_VARIABLE_LIST = ['---', '<status_current_variables>', '{{format_message_variable::stat_data}}', '</status_current_variables>'].join('\n');
export const CLEANUP_REGEX_NAME = '只发送最新3楼的变量更新';
export const CLEANUP_REGEX_FIND = String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gm`;
export const PATH_LIST_START = '【路径清单·应用生成，勿手改】';
export const PATH_LIST_END = '【路径清单·结束】';
export const RULES_INTRO = '本条目由「世界书·变量」分区撰写：总则、Patch 约定、初始化、各容器规则、数量上限与清理、不变量。末尾的路径清单由应用从变量表生成，不要手改。';
const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六'];

const key = (segment: string): string => JSON.stringify(segment);
const comment = (row: VariableRow): string => (row.note ? ` // ${row.note.replace(/\r?\n/g, ' ')}` : '');

function leafSchema(row: VariableRow): string {
  switch (row.type) {
    case '数值': return row.range ? `num(${JSON.stringify(row.default)}, ${row.range[0]}, ${row.range[1]})` : `anyNum(${JSON.stringify(row.default)})`;
    case '布尔': return `flag(${row.default === true})`;
    case '枚举': return `pick(${JSON.stringify(row.values)}, ${JSON.stringify(row.default)})`;
    default: return `text(${JSON.stringify(row.default ?? '')})`;
  }
}
function objectSchema(rows: VariableRow[], prefix: string, depth: number): string {
  const fields = directChildren(rows, prefix);
  if (!fields.length) return 'obj({})';
  const pad = '  '.repeat(depth + 1);
  return `obj({\n${fields.map(field => `${pad}${key(lastSegment(field.path))}: ${schemaOf(rows, field, depth + 1)},${comment(field)}`).join('\n')}\n${'  '.repeat(depth)}})`;
}
function schemaOf(rows: VariableRow[], row: VariableRow, depth: number): string {
  if (isLeaf(row)) return leafSchema(row);
  if (row.type === '对象') return objectSchema(rows, row.path, depth);
  if (row.type === '记录') {
    const item = rows.find(candidate => candidate.path === `${row.path}/${KEY_PLACEHOLDER}`);
    const inner = item ? leafSchema(item) : objectSchema(rows, `${row.path}/${KEY_PLACEHOLDER}`, depth);
    return `record(${inner}${row.limit ? `, ${row.limit}` : ''})`;
  }
  const element = row.element === '对象' ? objectSchema(rows, `${row.path}/${ELEMENT_PLACEHOLDER}`, depth) : row.element === '数值' ? 'anyNum(0)' : row.element === '布尔' ? 'flag(false)' : "text('')";
  return `list(${element}${row.limit ? `, ${row.limit}` : ''})`;
}

/** The Zod script: the fixed header and footer, the helpers, and one line per field. `stamp` names the table it came from. */
export function generateZodScript(table: VariableTable, options: { cardName: string; stamp: string }): string {
  const name = options.cardName.replace(/[\r\n'\\]/g, ' ').trim() || '本卡';
  const fields = directChildren(table.rows, '').map(row => `  ${key(lastSegment(row.path))}: ${schemaOf(table.rows, row, 1)},${comment(row)}`);
  return [
    ZOD_IMPORT_LINE,
    '',
    `// 由 Cardwright 从 变量表.yaml 生成（${options.stamp}）。要改字段请改变量表再重新生成，不要手改这个文件。`,
    '// z（Zod 4）与 _（lodash）由酒馆助手注入。每个字段：coerce/preprocess → catch(兜底) → transform(归一) → prefault(默认)。',
    'const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);',
    'const num = (fallback, min, max) => z.coerce.number().catch(fallback).transform(v => _.clamp(finite(v, fallback), min, max)).prefault(fallback);',
    'const anyNum = fallback => z.coerce.number().catch(fallback).transform(v => finite(v, fallback)).prefault(fallback);',
    "const text = fallback => z.preprocess(v => (v == null ? fallback : v), z.coerce.string()).catch(fallback).transform(v => (v.trim() === '' ? fallback : v)).prefault(fallback);",
    "const flag = fallback => z.preprocess(v => (typeof v === 'string' ? /^(true|1|是|有|开|yes)$/i.test(v.trim()) : v == null ? fallback : Boolean(v)), z.boolean()).catch(fallback).prefault(fallback);",
    'const pick = (values, fallback) => z.enum(values).catch(fallback).prefault(fallback);',
    '// Objects keep fields the table does not know (an older save, a script of its own): z.looseObject, never the deprecated pass-through API.',
    'const obj = shape => { const schema = z.looseObject(shape); return schema.catch(() => schema.parse({})).prefault({}); };',
    'const record = (item, limit) => { const base = z.record(z.string(), item).catch({}).prefault({}); return limit ? base.transform(data => _(data).entries().takeRight(limit).fromPairs().value()) : base; };',
    'const list = (item, limit) => { const base = z.array(item).catch([]).prefault([]); return limit ? base.transform(data => data.slice(-limit)) : base; };',
    '',
    '// 顶层保持 z.object：registerMvuSchema 注册时会把它包成 z.looseObject，不要在这里改成 looseObject。',
    'export const Schema = z.object({',
    ...fields,
    '});',
    '',
    `console.log('[${name}] Schema 注册中');`,
    `$(() => { registerMvuSchema(Schema); console.log('[${name}] Schema 已注册'); });`,
    '',
  ].join('\n');
}

function defaultsOf(rows: VariableRow[], row: VariableRow): unknown {
  if (isLeaf(row)) return row.default;
  if (row.type === '记录') return {};
  if (row.type === '列表') return [];
  const value: Record<string, unknown> = {};
  for (const field of directChildren(rows, row.path)) value[lastSegment(field.path)] = defaultsOf(rows, field);
  return value;
}
/** The [initvar] body: the table's defaults as YAML. */
export function generateInitialVariables(table: VariableTable): string {
  const value: Record<string, unknown> = {};
  for (const row of directChildren(table.rows, '')) value[lastSegment(row.path)] = defaultsOf(table.rows, row);
  return stringifyYaml(value, { lineWidth: 0 });
}

const concrete = (row: VariableRow): boolean => isLeaf(row) && row.owner === '模型' && pointerSegments(row.path).every(segment => segment !== KEY_PLACEHOLDER && segment !== ELEMENT_PLACEHOLDER);
/** A replace on an existing field the model maintains: the smallest patch that always applies to [initvar]. */
export function exampleOperation(table: VariableTable): { op: 'replace'; path: string; value: VariableDefault } | null {
  const row = table.rows.find(item => concrete(item) && item.type === '数值') ?? table.rows.find(concrete);
  return row ? { op: 'replace', path: row.path, value: row.default as VariableDefault } : null;
}

/** The 变量输出格式 entry: the block the model writes at the end of every reply. */
export function generateOutputFormat(table: VariableTable): string {
  const analysis = directChildren(table.rows, '').map((row, index) => `${NUMERALS[index] ?? String(index + 1)}、${lastSegment(row.path)}：${row.note ?? '本轮有没有变化，变了哪几项'}`);
  const example = exampleOperation(table);
  return [
    '每次回复的末尾有且只有一个 <UpdateVariable> 块；块外不写任何变量内容。格式：',
    '',
    '<UpdateVariable>',
    '<Analysis>',
    '逐项核对本轮正文里发生了什么、对应哪些路径（每行至少一条路径，没变就写「无变化」）：',
    ...analysis,
    '</Analysis>',
    '<JSONPatch>',
    example ? `[\n  ${JSON.stringify(example)}\n]` : '[]',
    '</JSONPatch>',
    '</UpdateVariable>',
    '',
    '- op 只用 add、replace、remove、move。replace 的路径必须已经存在；新增字段或记录项一律用 add；删除用 remove。',
    `- 路径只能是变量规则末尾「${PATH_LIST_START}」里列出的路径；记录项的键写在路径里，例如 /人物/张三/好感。`,
    '- 没有变化时 <JSONPatch> 里只输出 []。同一路径在一次更新里只出现一次。',
    '- 不要输出变量表里没有的字段，不要在块里写解释。',
    '',
  ].join('\n');
}

/** The path list that closes 变量规则: every row with what it is, and which fields the model must not touch. */
export function generatePathList(table: VariableTable): string {
  const lines = [PATH_LIST_START];
  const walk = (prefix: string, depth: number): void => {
    for (const row of directChildren(table.rows, prefix)) {
      lines.push(`${'  '.repeat(depth)}- ${row.path}（${describeVariableRow(row)}）${row.note ? `：${row.note}` : ''}`);
      if (row.type === '对象') walk(row.path, depth + 1);
      // A leaf item is the literal {键} row right under the record; object items are rows under {键}/. Never both, so nothing prints twice.
      else if (row.type === '记录') { walk(row.path, depth + 1); walk(`${row.path}/${KEY_PLACEHOLDER}`, depth + 1); }
      else if (row.type === '列表' && row.element === '对象') walk(`${row.path}/${ELEMENT_PLACEHOLDER}`, depth + 1);
    }
  };
  walk('', 0);
  const locked = table.rows.filter(row => isLeaf(row) && row.owner !== '模型');
  lines.push(locked.length ? `模型不得修改：${locked.map(row => `${row.path}（${row.owner}维护）`).join('、')}` : '模型不得修改：无（所有字段都由模型按规则更新）');
  lines.push(PATH_LIST_END);
  return lines.join('\n');
}

export function extractPathListBlock(body: string): string | null {
  const start = body.lastIndexOf(PATH_LIST_START);
  const end = start < 0 ? -1 : body.indexOf(PATH_LIST_END, start);
  return start >= 0 && end >= 0 ? body.slice(start, end + PATH_LIST_END.length) : null;
}
/** Replaces the block between the markers, or appends it after the narrative. */
export function replacePathListBlock(body: string, block: string): string {
  const current = extractPathListBlock(body);
  if (current) return body.replace(current, () => block);
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}
