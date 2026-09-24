import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableTableError, describeVariableRow, fieldSegments, matchVariablePath, parseVariableTable, serializeVariableTable } from '../src/shared/card-studio/variable-table.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

test('a variable table parses into rows with defaults filled in', () => {
  const table = parseVariableTable(SAMPLE_TABLE);
  assert.equal(table.version, 1);
  assert.equal(table.note, '样卡的变量');
  assert.equal(table.rows.length, 13);
  const row = (path: string) => table.rows.find(item => item.path === path)!;
  assert.deepEqual(row('/主角/姓名'), { path: '/主角/姓名', type: '文本', owner: '创角页', default: '' });
  assert.deepEqual(row('/主角/生命'), { path: '/主角/生命', type: '数值', owner: '模型', default: 100, range: [0, 100], when: '受伤或恢复时' });
  assert.deepEqual(row('/主角/状态'), { path: '/主角/状态', type: '枚举', owner: '模型', values: ['正常', '受伤', '濒死'], default: '正常' });
  assert.equal(row('/主角/在逃').default, false, 'a boolean without 默认 is false');
  assert.deepEqual(row('/人物'), { path: '/人物', type: '记录', owner: '模型', limit: 12, note: '出场人物，键是人物名' });
  assert.deepEqual(row('/事件记录'), { path: '/事件记录', type: '列表', owner: '模型', element: '文本', limit: 8 });
  assert.equal(row('/任务').element, '对象');
});

test('every problem of a table is reported at once, with its path', () => {
  const bad = [
    '版本: 1',
    '变量:',
    '  - 路径: /主角',
    '    类型: 对象',
    '    默认: 1',
    '  - 路径: /主角/生命',
    '    类型: 数值',
    '    范围: [100, 0]',
    '  - 路径: /主角/生命',
    '    类型: 数值',
    '  - 路径: /主角/状态',
    '    类型: 枚举',
    '    取值: [正常]',
    '    默认: 受伤',
    '  - 路径: /孤儿/字段',
    '    类型: 文本',
    '  - 路径: /主角/{键}/x',
    '    类型: 文本',
    '  - 路径: 没有斜杠',
    '    类型: 文本',
    '  - 路径: /主角/年龄',
    '    类型: 年纪',
  ].join('\n');
  assert.throws(() => parseVariableTable(bad), (error: unknown) => {
    assert.ok(error instanceof VariableTableError);
    const messages = error.issues.map(issue => `${issue.path ?? ''}|${issue.message}`);
    const expect = (path: string, fragment: string) => assert.ok(messages.some(item => item.startsWith(`${path}|`) && item.includes(fragment)), `${path} ${fragment}\n${messages.join('\n')}`);
    expect('/主角', '没有「默认」');
    expect('/主角/生命', '下限不大于上限');
    expect('/主角/生命', '路径重复');
    expect('/主角/状态', '不在「取值」里');
    expect('/孤儿/字段', '没有在表里定义');
    expect('/主角/{键}/x', '不是记录');
    expect('没有斜杠', '以 / 开头');
    expect('/主角/年龄', '「类型」必须是');
    return true;
  });
});

test('a table that is not YAML or not a map fails with one message', () => {
  assert.throws(() => parseVariableTable('- just: a list'), /应该是一个映射/);
  assert.throws(() => parseVariableTable('版本: 1\n变量: []'), /非空列表/);
  assert.throws(() => parseVariableTable(': : :'), /不是有效的 YAML/);
});

test('a concrete pointer finds its row through record keys and list indexes', () => {
  const table = parseVariableTable(SAMPLE_TABLE);
  assert.equal(matchVariablePath(table, '/人物/张三/好感')?.path, '/人物/{键}/好感');
  assert.equal(matchVariablePath(table, '/人物/张三')?.type, '对象', 'an item of a record of objects');
  assert.equal(matchVariablePath(table, '/货币/银币')?.path, '/货币/{键}', 'a record of numbers');
  assert.equal(matchVariablePath(table, '/事件记录/-')?.type, '文本', 'one element of a list of text');
  assert.equal(matchVariablePath(table, '/任务/0/标题')?.path, '/任务/-/标题');
  assert.equal(matchVariablePath(table, '/主角')?.type, '对象');
  assert.equal(matchVariablePath(table, '/主角/不存在'), null);
  assert.equal(matchVariablePath(table, '/主角/生命/0'), null, 'a number has no members');
  assert.equal(matchVariablePath(table, '/人物/张三/好感/toFixed'), null, 'callers strip JavaScript members first');
  assert.equal(matchVariablePath(table, '/'), null);
});

test('a row describes itself for the path list and the brief', () => {
  const table = parseVariableTable(SAMPLE_TABLE);
  const row = (path: string) => table.rows.find(item => item.path === path)!;
  assert.equal(describeVariableRow(row('/主角/生命')), '数值 0–100，默认 100；受伤或恢复时');
  assert.equal(describeVariableRow(row('/主角/姓名')), '文本，默认「」，创角页维护');
  assert.equal(describeVariableRow(row('/主角/状态')), '枚举 正常/受伤/濒死，默认 正常');
  assert.equal(describeVariableRow(row('/人物')), '记录，最多 12 条');
  assert.equal(describeVariableRow(row('/事件记录')), '列表，元素文本，最多 8 条');
});

test('serializing a table and parsing it again gives the same rows', () => {
  const table = parseVariableTable(SAMPLE_TABLE);
  const again = parseVariableTable(serializeVariableTable(table));
  assert.deepEqual(again, table);
});

test('a byte order mark in front of the YAML is ignored', () => {
  const table = parseVariableTable(String.fromCharCode(0xfeff) + SAMPLE_TABLE);
  assert.equal(table.rows.length, 13);
});

test('trailing JavaScript members are not fields', () => {
  assert.deepEqual(fieldSegments(['主角', '生命', 'toFixed']), ['主角', '生命']);
  assert.deepEqual(fieldSegments(['人物', 'length']), ['人物']);
  assert.deepEqual(fieldSegments(['事件记录', 'slice', 'length']), ['事件记录']);
  assert.deepEqual(fieldSegments(['length']), []);
  assert.deepEqual(fieldSegments(['主角', '姓名']), ['主角', '姓名']);
});

test('escaped keys, nested records and numeric indexes match too', () => {
  const nested = parseVariableTable([SAMPLE_TABLE.trimEnd(), '  - 路径: /人物/{键}/物品', '    类型: 记录', '  - 路径: /人物/{键}/物品/{键}/数量', '    类型: 数值', '    默认: 1', ''].join('\n'));
  assert.equal(matchVariablePath(nested, '/人物/张三/物品/短剑/数量')?.path, '/人物/{键}/物品/{键}/数量');
  assert.equal(matchVariablePath(nested, '/货币/金~1银')?.path, '/货币/{键}', 'an escaped / inside a key');
  assert.equal(matchVariablePath(nested, '/任务/0')?.type, '对象', 'a numeric index into a list of objects');
  assert.equal(describeVariableRow(nested.rows.find(row => row.path === '/主角/在逃')!), '布尔，默认 false');
});
