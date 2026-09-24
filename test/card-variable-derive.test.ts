import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVariableTable, zodHints } from '../src/core/card-studio/variable-derive.ts';
import { parseVariableTable, serializeVariableTable } from '../src/shared/card-studio/variable-table.ts';
import type { ProjectComponents } from '../src/core/card-studio/components.ts';

const NL = '\n';
const initvar = [
  '主角:', '  姓名: 林砚', '  生命: 90', '  状态: 正常', '  在逃: false',
  '人物:', '  张三:', '    好感: 10', '    所在: 王都', '  李四:', '    好感: 0', '    所在: 未知',
  '物品栏: {}',
  '事件记录: []',
  '任务:', '  - 标题: 初入王都', '    进度: 0',
].join(NL);
const zod = [
  "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';",
  'const percent = (fallback = 0) => z.coerce.number().catch(fallback).transform(v => _.clamp(v, 0, 100)).prefault(fallback);',
  'const limitedRecord = (item, limit) => z.record(z.string(), item).catch({}).prefault({}).transform(d => _(d).entries().takeRight(limit).fromPairs().value());',
  'export const Schema = z.object({',
  '  主角: z.object({',
  "    姓名: z.string().prefault('未知'),",
  '    生命: percent(100),',
  "    状态: z.enum(['正常', '受伤', '濒死']).catch('正常'),",
  '    在逃: z.boolean().catch(false),',
  '  }).prefault({}),',
  '  人物: limitedRecord(z.object({ 好感: z.coerce.number().catch(0).transform(v => _.clamp(v, -100, 100)), 所在: z.string().prefault("未知") }), 12),',
  '  物品栏: z.record(z.string(), z.coerce.number()).prefault({}),',
  '  事件记录: z.array(z.string()).prefault([]).transform(d => d.slice(-8)),',
  '  任务: z.array(z.object({ 标题: z.string(), 进度: percent(0) })).prefault([]),',
  '});',
  '$(() => { registerMvuSchema(Schema); });',
].join(NL);

const project = (): ProjectComponents => ({
  root: '', envelope: {}, book: { name: '样卡', extras: {}, order: [1] },
  lore: [{ uid: 1, section: 'lore-people', params: { uid: 1, key: [], comment: '[initvar] 变量初始化', order: 100, position: 0, constant: true }, content: initvar, paramsPath: '世界书/人设/100-[initvar].json', bodyPath: '世界书/人设/100-[initvar].md' }],
  regex: [], scripts: [{ name: '02-ZOD', params: { name: 'ZOD' }, body: zod, format: 'js', paramsPath: '脚本/02-ZOD.json', bodyPath: '脚本/02-ZOD.js' }], greetings: [], issues: [],
});

test('a field line of the Zod script gives away its range, enum and limit', () => {
  const hints = zodHints(zod);
  assert.deepEqual(hints.get('生命'), { range: [0, 100] });
  assert.deepEqual(hints.get('状态'), { values: ['正常', '受伤', '濒死'] });
  assert.deepEqual(hints.get('人物'), { limit: 12 });
  assert.deepEqual(hints.get('好感'), { range: [-100, 100] });
  assert.equal(hints.has('姓名'), false);
});

test('a card without a table gets one derived from [initvar] and the Zod script', () => {
  const table = deriveVariableTable(project())!;
  assert.ok(table, 'derived');
  const row = (path: string) => table.rows.find(item => item.path === path);
  assert.equal(row('/主角')?.type, '对象');
  assert.deepEqual(row('/主角/生命'), { path: '/主角/生命', type: '数值', owner: '模型', default: 90, range: [0, 100] });
  assert.deepEqual(row('/主角/状态'), { path: '/主角/状态', type: '枚举', owner: '模型', values: ['正常', '受伤', '濒死'], default: '正常' });
  assert.deepEqual(row('/主角/在逃'), { path: '/主角/在逃', type: '布尔', owner: '模型', default: false });
  assert.deepEqual(row('/人物'), { path: '/人物', type: '记录', owner: '模型', limit: 12 }, 'two items with the same fields are a record');
  assert.deepEqual(row('/人物/{键}/好感'), { path: '/人物/{键}/好感', type: '数值', owner: '模型', default: 10, range: [-100, 100] });
  assert.equal(row('/物品栏')?.type, '记录');
  assert.match(row('/物品栏')?.note ?? '', /初始为空/);
  assert.deepEqual(row('/事件记录'), { path: '/事件记录', type: '列表', owner: '模型', element: '文本' });
  assert.equal(row('/任务')?.element, '对象');
  assert.deepEqual(row('/任务/-/进度'), { path: '/任务/-/进度', type: '数值', owner: '模型', default: 0, range: [0, 100] });
  assert.match(table.note ?? '', /推导/);
  assert.deepEqual(parseVariableTable(serializeVariableTable(table)).rows, table.rows, 'the derived table is a valid table');
});

test('nothing is derived without an [initvar] entry, or from one that is not YAML', () => {
  const none = project(); none.lore = [];
  assert.equal(deriveVariableTable(none), null);
  const bad = project(); bad.lore[0].content = ': : :';
  assert.equal(deriveVariableTable(bad), null);
});

test('enumOf wrappers, records of scalars and keys with slashes derive sensibly', () => {
  const hints = zodHints("  时段: enumOf(['黎明', '白天', '夜晚'], '黎明'),");
  assert.deepEqual(hints.get('时段'), { values: ['黎明', '白天', '夜晚'] });
  const card = project();
  card.lore[0].content = ['货币:', '  银币: 12', '  金币: 3', '路径/名:', '  子~项: 1', '人物:', '  张三:', '    好感: 1', '  李四:', '    所在: 王都'].join(NL);
  const table = deriveVariableTable(card)!;
  assert.equal(table.rows.find(row => row.path === '/货币')?.type, '对象', 'numbers are not items of a record');
  assert.equal(table.rows.find(row => row.path === '/人物')?.type, '对象', 'items with different fields are not a record');
  assert.ok(table.rows.some(row => row.path === '/路径~1名/子~0项'), 'keys are escaped in paths');
  assert.deepEqual(parseVariableTable(serializeVariableTable(table)).rows, table.rows);
});
