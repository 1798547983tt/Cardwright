import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJsonPatch } from '../src/core/card-studio/variable-patch.ts';

const initial = { 主角: { 生命: 100, 状态: '正常' }, 人物: {}, 事件记录: ['a'], 任务: [{ 标题: '一' }] };

test('replace and remove need the path to exist; add needs only the parent', () => {
  const ok = applyJsonPatch(initial, [
    { op: 'replace', path: '/主角/生命', value: 90 },
    { op: 'add', path: '/人物/张三', value: { 好感: 5 } },
    { op: 'add', path: '/事件记录/-', value: 'b' },
    { op: 'add', path: '/任务/0', value: { 标题: '零' } },
    { op: 'remove', path: '/主角/状态' },
  ]);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.value, { 主角: { 生命: 90 }, 人物: { 张三: { 好感: 5 } }, 事件记录: ['a', 'b'], 任务: [{ 标题: '零' }, { 标题: '一' }] });
  assert.deepEqual(initial.事件记录, ['a'], 'the input is not touched');

  const replaced = applyJsonPatch(initial, [{ op: 'replace', path: '/主角/不存在', value: 1 }]);
  assert.equal(replaced.ok, false);
  assert.match(replaced.error!, /第 1 条.*replace 的路径不存在，新增要用 add/);

  const orphan = applyJsonPatch(initial, [{ op: 'add', path: '/人物/李四/好感', value: 1 }]);
  assert.equal(orphan.ok, false);
  assert.match(orphan.error!, /\/人物\/李四 不存在/);

  const gone = applyJsonPatch(initial, [{ op: 'remove', path: '/主角/魔力' }]);
  assert.match(gone.error!, /remove 的路径不存在/);
});

test('move takes a value from one path to another; bad operations name the line', () => {
  const moved = applyJsonPatch(initial, [{ op: 'move', from: '/主角/状态', path: '/主角/旧状态' }]);
  assert.equal(moved.ok, true, moved.error);
  assert.deepEqual((moved.value as typeof initial).主角, { 生命: 100, 旧状态: '正常' });
  assert.match(applyJsonPatch(initial, [{ op: 'move', path: '/主角/x' }]).error!, /move 需要 from/);
  assert.match(applyJsonPatch(initial, [{ op: 'delta', path: '/主角/生命', value: -1 }]).error!, /op 只能是 add、replace、remove、move/);
  assert.match(applyJsonPatch(initial, [{ op: 'add', path: '主角', value: 1 }]).error!, /path 要以 \/ 开头/);
  assert.match(applyJsonPatch(initial, [{ op: 'add', path: '/主角/生命/次级', value: 1 }]).error!, /上级不是容器/);
  assert.match(applyJsonPatch(initial, [{ op: 'replace', path: '/主角/生命' }]).error!, /缺少 value/);
  assert.match(applyJsonPatch(initial, [{ op: 'replace', path: '/任务/5', value: {} }]).error!, /replace 的路径不存在/);
});

test('a patch that is not an array, or a value that is undefined, is handled without throwing', () => {
  const notArray = applyJsonPatch(initial, 'oops' as unknown as never);
  assert.equal(notArray.ok, false);
  assert.match(notArray.error!, /必须是一个数组/);
  const phantom = applyJsonPatch(initial, [{ op: 'add', path: '/主角/称号', value: undefined }]);
  assert.equal(phantom.ok, true, phantom.error);
  assert.equal((phantom.value as { 主角: Record<string, unknown> }).主角.称号, null, 'JSON has no undefined');
  const escaped = applyJsonPatch({ 'a/b': { '~x': 1 } }, [{ op: 'replace', path: '/a~1b/~0x', value: 2 }]);
  assert.deepEqual(escaped.value, { 'a/b': { '~x': 2 } });
  const overwrite = applyJsonPatch(initial, [{ op: 'add', path: '/主角/生命', value: 1 }, { op: 'add', path: '/任务/1', value: { 标题: '二' } }]);
  assert.deepEqual((overwrite.value as typeof initial).主角.生命, 1, 'add on an existing member overwrites it');
  assert.equal((overwrite.value as typeof initial).任务.length, 2, 'add at index == length appends');
  assert.equal(applyJsonPatch(initial, [{ op: 'move', from: '/主角', path: '/主角/内' }]).ok, false, 'moving into its own child fails');
});
