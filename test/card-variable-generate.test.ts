import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { parseVariableTable } from '../src/shared/card-studio/variable-table.ts';
import { generateZodScript, generateInitialVariables } from '../src/shared/card-studio/variable-generate.ts';
import { PATH_LIST_END, PATH_LIST_START, exampleOperation, extractPathListBlock, generateOutputFormat, generatePathList, replacePathListBlock } from '../src/shared/card-studio/variable-generate.ts';
import { evaluateSchema, parseInitialVariables, validateInitialVariables } from '../src/core/card-studio/variables.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

const table = parseVariableTable(SAMPLE_TABLE);
const options = { cardName: '样卡', stamp: '变量表 abcd1234' };

test('the generated Zod script registers, keeps unknown fields and never writes .passthrough()', () => {
  const script = generateZodScript(table, options);
  assert.match(script, /^import \{ registerMvuSchema \}/);
  assert.match(script, /z\.looseObject\(shape\)/);
  assert.doesNotMatch(script, /passthrough/);
  assert.match(script, /\$\(\(\) => \{ registerMvuSchema\(Schema\); console\.log\('\[样卡\] Schema 已注册'\); \}\);/);
  assert.match(script, /变量表 abcd1234/);
  const evaluated = evaluateSchema(script);
  assert.equal(evaluated.registered, true);
  const initial = parseInitialVariables(generateInitialVariables(table));
  const result = validateInitialVariables(evaluated.schema, initial);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.value, initial, 'the generated defaults pass through unchanged');
});

test('the generated schema clamps, falls back and trims records the way the table says', () => {
  const evaluated = evaluateSchema(generateZodScript(table, options));
  const people: Record<string, unknown> = {};
  for (let index = 0; index < 14; index++) people[`人${index}`] = { 好感: 150, 所在: '' };
  const result = validateInitialVariables(evaluated.schema, {
    主角: { 姓名: 7, 生命: '250', 状态: '发光', 在逃: '是', 额外: '旧存档留下的字段' },
    人物: people, 货币: { 银币: '12' }, 事件记录: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 任务: [{ 标题: 1 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const value = result.value as { 主角: Record<string, unknown>; 人物: Record<string, { 好感: number; 所在: string }>; 货币: Record<string, number>; 事件记录: string[]; 任务: Array<{ 标题: string }> };
  assert.equal(value.主角.姓名, '7');
  assert.equal(value.主角.生命, 100, 'clamped into the range');
  assert.equal(value.主角.状态, '正常', 'an unknown enum value falls back to the default');
  assert.equal(value.主角.在逃, true, '「是」reads as true');
  assert.equal(value.主角.额外, '旧存档留下的字段', 'unknown fields survive (z.looseObject)');
  assert.equal(Object.keys(value.人物).length, 12, 'the record keeps the newest 12');
  assert.equal(value.人物.人13.好感, 100);
  assert.equal(value.人物.人13.所在, '未知', 'an empty text falls back to its default');
  assert.equal(value.货币.银币, 12);
  assert.deepEqual(value.事件记录, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'the list keeps the newest 8');
  assert.equal(value.任务[0].标题, '1');
});

test('the generated [initvar] is YAML with every default in place', () => {
  const text = generateInitialVariables(table);
  assert.deepEqual(parseYaml(text), {
    主角: { 姓名: '', 生命: 100, 状态: '正常', 在逃: false },
    人物: {}, 货币: {}, 事件记录: [], 任务: [],
  });
});

test('the output format names every top container and shows a patch that applies to the defaults', () => {
  const text = generateOutputFormat(table);
  assert.match(text, /<UpdateVariable>\n<Analysis>/);
  assert.match(text, /一、主角：玩家自己的状态/);
  assert.match(text, /二、人物：出场人物，键是人物名/);
  assert.match(text, /四、事件记录：本轮有没有变化/);
  assert.deepEqual(exampleOperation(table), { op: 'replace', path: '/主角/生命', value: 100 }, '姓名 belongs to the creation page, 生命 is the first number the model keeps');
  assert.match(text, /\{"op":"replace","path":"\/主角\/生命","value":100\}/);
  assert.match(text, /<\/JSONPatch>\n<\/UpdateVariable>/);
});

test('the path list describes every row, nests record items, and names the locked fields', () => {
  const block = generatePathList(table);
  const lines = block.split('\n');
  assert.equal(lines[0], PATH_LIST_START);
  assert.equal(lines.at(-1), PATH_LIST_END);
  assert.ok(lines.includes('- /主角（对象）：玩家自己的状态'), block);
  assert.ok(lines.includes('  - /主角/生命（数值 0–100，默认 100；受伤或恢复时）'), block);
  assert.ok(lines.includes('  - /人物/{键}/好感（数值 -100–100，默认 0）'), block);
  assert.ok(lines.includes('  - /货币/{键}（数值，默认 0）'), block);
  assert.ok(lines.includes('  - /任务/-/标题（文本，默认「」）'), block);
  assert.equal(lines.at(-2), '模型不得修改：/主角/姓名（创角页维护）');
});

test('the path list block is appended once and replaced in place afterwards', () => {
  const block = generatePathList(table);
  const first = replacePathListBlock('总则：只按事实更新。\n', block);
  assert.equal(first, `总则：只按事实更新。\n\n${block}\n`);
  const edited = first.replace('总则：只按事实更新。', '总则：只按本轮事实更新。');
  const second = replacePathListBlock(edited, block.replace('最多 12 条', '最多 3 条'));
  assert.match(second, /^总则：只按本轮事实更新。\n\n/, 'the narrative above the block is untouched');
  assert.match(second, /最多 3 条/);
  assert.doesNotMatch(second, /最多 12 条/);
  assert.equal(extractPathListBlock(second)?.split('\n')[0], PATH_LIST_START);
  assert.equal(extractPathListBlock('没有清单'), null);
});

test('the block is found from the end, so a mention of the marker in the narrative is left alone', () => {
  const block = generatePathList(table);
  const body = `总则：末尾的「${PATH_LIST_START}」一段由应用维护。\n\n${block}\n`;
  assert.equal(extractPathListBlock(body), block);
  const replaced = replacePathListBlock(body, block.replace('最多 12 条', '最多 5 条'));
  assert.match(replaced, /^总则：末尾的「/, 'the narrative survives');
  assert.match(replaced, /最多 5 条/);
  assert.equal(extractPathListBlock(`${PATH_LIST_START}\n没有结束标记`), null);
});
