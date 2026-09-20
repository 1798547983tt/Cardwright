import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsageReport, localDayKey } from '../src/shared/usage.ts';
import type { ChatMessage, Task, Usage } from '../src/shared/types.ts';

const local = (day: number, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const now = new Date(2026, 8, 16, 20).getTime();
test('auxiliary native search and Dreamer usage count once in daily and model totals', () => {
  const report = buildUsageReport([task('auxiliary', [
    message('answer', local(16), { usage: usage(20, 5) }),
    message('search', local(16), { role: 'system', usage: usage(100, 10, 30), model: 'search-model' }),
    message('notice', local(16), { role: 'system', model: undefined }),
  ])], { now });
  assert.equal(report.tokens.total, 165);
  assert.equal(report.responses, 2);
  assert.equal(report.unreported, 0);
  assert.equal(report.models.find(item => item.model === 'search-model')?.tokens.total, 140);
  assert.equal(report.days.find(day => day.date === '2026-09-16')?.tokens.total, 165);
});
function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage { return { input, output, cacheRead, cacheWrite, cost: 0 }; }
function message(id: string, at: string, overrides: Partial<ChatMessage> = {}): ChatMessage { return { id, at, role: 'assistant', text: 'Fixture response', model: 'original-model', ...overrides }; }
function task(id: string, messages: ChatMessage[], overrides: Partial<Task> = {}): Task { return { id, title: `Task ${id}`, projectId: 'project', cwd: '', status: 'completed', permission: 'ask', gatewayId: 'gateway-that-now-uses-another-model', thinking: 'off', createdAt: local(1), updatedAt: local(16), messages, tools: [], ...overrides }; }

test('usage aggregates exact input, output and both cache categories by original response model', () => {
  const report = buildUsageReport([
    task('first', [message('user', local(15), { role: 'user', model: undefined }), message('one', local(15), { usage: usage(1100, 200, 70, 30) }), message('two', local(16), { model: 'next-model', usage: usage(300, 40, 10, 5) })]),
    task('second', [message('three', local(16), { usage: usage(20, 2) })]),
  ], { now });
  assert.deepEqual(report.tokens, { input: 1420, output: 242, cacheRead: 80, cacheWrite: 35, total: 1777 });
  assert.equal(report.sessions, 2); assert.equal(report.messages, 4); assert.equal(report.responses, 3);
  assert.equal(report.models.find(model => model.model === 'original-model')?.tokens.total, 1422);
  assert.equal(report.models.find(model => model.model === 'next-model')?.tokens.total, 355);
  const day = report.days.find(day => day.date === '2026-09-16')!;
  assert.equal(day.tokens.total, 377); assert.equal(day.tasks.length, 2);
  assert.equal(day.tasks.find(task => task.id === 'first')?.tokens.total, 355);
  assert.equal(day.tasks.reduce((sum, task) => sum + task.tokens.total, 0), day.tokens.total);
});

test('local day boundaries and a seven-day calendar include full first day without timezone shifts', () => {
  const early = new Date(2026, 8, 10, 0, 1);
  assert.equal(localDayKey(early.toISOString()), '2026-09-10');
  const report = buildUsageReport([task('boundary', [
    message('before', local(9, 23, 59), { usage: usage(90, 9) }), message('first-minute', early.toISOString(), { usage: usage(10, 1) }),
    message('last-minute', local(15, 23, 59), { usage: usage(20, 2) }), message('next-day', local(16, 0, 1), { usage: usage(30, 3) }),
  ])], { now, days: 7 });
  assert.equal(report.tokens.total, 66); assert.equal(report.days.length, 7);
  assert.equal(report.days[0].date, '2026-09-10'); assert.equal(report.days.at(-1)?.date, '2026-09-16');
  assert.equal(report.days.find(day => day.date === '2026-09-15')?.tokens.total, 22);
  assert.equal(report.days.find(day => day.date === '2026-09-16')?.tokens.total, 33);
});

test('renamed old tasks do not count as recent sessions; message dates count despite stale metadata', () => {
  const old = task('renamed-today', [message('old', local(1), { usage: usage(900, 90) })]);
  const recent = task('actual-recent', [message('recent', local(15), { usage: usage(5, 3) })], { updatedAt: local(1) });
  const report = buildUsageReport([old, recent], { now, days: 7 });
  assert.equal(report.sessions, 1); assert.equal(report.tokens.total, 8); assert.deepEqual(report.tasks.map(task => task.id), ['actual-recent']);
});

test('unreported responses remain distinct from reported zero and absent model names are not invented', () => {
  const report = buildUsageReport([task('unknowns', [message('unreported', local(16), { usage: undefined, model: undefined }), message('zero', local(16), { usage: usage(0, 0) }), message('user', local(16), { role: 'user', usage: undefined, model: undefined })])], { now });
  assert.equal(report.tokens.total, 0); assert.equal(report.unreported, 1); assert.equal(report.responses, 2);
  assert.equal(report.models.find(model => model.model === null)?.unreported, 1); assert.equal(report.days.find(day => day.date === '2026-09-16')?.unreported, 1);
  assert.equal(report.models.find(model => model.model === 'original-model')?.unreported, 0);
});

test('empty and future calendar cells stay explicit; invalid and future-dated messages cannot inflate usage', () => {
  const report = buildUsageReport([task('invalid', [message('bad', 'invalid date', { usage: usage(100, 20) }), message('future', local(17), { usage: usage(100, 20) })])], { now });
  assert.equal(report.days.length, 140); assert.equal(report.sessions, 0); assert.equal(report.messages, 0); assert.equal(report.tokens.total, 0);
  assert.deepEqual(report.days.find(day => day.date === '2026-09-15')?.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.equal(report.days.find(day => day.date === '2026-09-16')?.future, false); assert.equal(report.days.find(day => day.date === '2026-09-17')?.future, true);
});
