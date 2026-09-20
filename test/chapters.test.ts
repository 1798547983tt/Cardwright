import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterTitle, chaptersByTurn } from '../src/shared/chapters.ts';
import type { TaskChapter } from '../src/shared/types.ts';

const chapter = (id: string, title: string, turnId: string, at: string): TaskChapter => ({ id, title, turnId, at });

test('a chapter title is trimmed, kept to one line and bounded', () => {
  assert.equal(chapterTitle('  定位根因  '), '定位根因');
  assert.equal(chapterTitle('第一行\n第二行'), '第一行 第二行');
  assert.equal(chapterTitle('x'.repeat(80)).length, 40);
  assert.equal(chapterTitle('   '), '');
  assert.equal(chapterTitle(42 as unknown as string), '');
});

test('one chapter per turn: a later mark on the same turn replaces the earlier one', () => {
  const chapters = [
    chapter('c1', '定位根因', 't1', '2026-09-19T10:00:00.000Z'),
    chapter('c2', '改名了', 't1', '2026-09-19T10:05:00.000Z'),
    chapter('c3', '修复', 't2', '2026-09-19T11:00:00.000Z'),
  ];
  const byTurn = chaptersByTurn(chapters);
  assert.equal(byTurn.get('t1')?.title, '改名了');
  assert.equal(byTurn.get('t2')?.title, '修复');
  assert.equal(byTurn.size, 2);
  assert.deepEqual([...byTurn.values()].map(item => item.title), ['改名了', '修复'], 'in the order the turns happened');
  assert.equal(chaptersByTurn(undefined).size, 0);
});
