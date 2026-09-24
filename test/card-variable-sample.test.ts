// test/card-variable-sample.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleVariables } from '../src/core/card-studio/variable-sample.ts';
import { parseVariableTable } from '../src/shared/card-studio/variable-table.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';
import type { ProjectComponents } from '../src/core/card-studio/components.ts';

const NL = String.fromCharCode(10);
const lore = (comment: string, content: string) => ({ uid: 1, section: 'lore-vars', params: { uid: 1, comment }, content, paramsPath: 'x.json', bodyPath: 'x.md' });
const project = (entries: Array<ReturnType<typeof lore>>) => ({ lore: entries } as unknown as ProjectComponents);

test('the sample comes from [initvar], else from the table defaults, else nothing', () => {
  assert.deepEqual(sampleVariables(project([lore('[initvar] 初始', ['主角:', '  生命: 42'].join(NL))]), parseVariableTable(SAMPLE_TABLE)), { 主角: { 生命: 42 } });
  const fromTable = sampleVariables(project([]), parseVariableTable(SAMPLE_TABLE)) as { 主角: { 生命: number; 状态: string }; 人物: unknown; 任务: unknown[] };
  assert.equal(fromTable.主角.生命, 100); assert.equal(fromTable.主角.状态, '正常'); assert.deepEqual(fromTable.人物, {}); assert.deepEqual(fromTable.任务, []);
  assert.deepEqual(sampleVariables(project([lore('[initvar] 初始', 'not: [valid')]), null), {}, 'a broken [initvar] falls through');
  assert.deepEqual(sampleVariables(project([]), null), {});
});
