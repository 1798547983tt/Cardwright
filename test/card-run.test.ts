import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchErrors, runQueue, runUsage, toolFailureStreak, turnOutcome } from '../src/shared/card-studio/run.ts';
import { ACCEPT_ALL_MARKER, REFUSE_MARKER } from '../src/shared/card-studio/markers.ts';
import type { CardCheckReport, CardDispatch, CardRun } from '../src/shared/card-studio/types.ts';
import type { ChatMessage, Task, ToolCall } from '../src/shared/types.ts';

const dispatch = (id: string, sectionId: string | null, status: CardDispatch['status'] = 'todo'): CardDispatch => ({ id, target: '', sectionId, title: id, requires: '', body: '', status, createdAt: '', updatedAt: '' });
const at = '2026-09-19T10:00:00.000Z';
const user = (id: string, text = '派单'): ChatMessage => ({ id, role: 'user', text, at, turnId: id });
const ai = (id: string, text: string, turnId: string, usage?: ChatMessage['usage']): ChatMessage => ({ id, role: 'assistant', text, at, turnId, ...(usage ? { usage } : {}) });
const tool = (name: string, status: ToolCall['status'], turnId: string, path?: string): ToolCall => ({ id: `${name}-${Math.random()}`, name, args: path ? { path } : {}, output: '', status, at, turnId });

test('the queue takes unsent dispatches of the chosen boards, in planning order', () => {
  const dispatches = [dispatch('p', 'plan'), dispatch('a', 'lore-people'), dispatch('b', 'regex-body'), dispatch('c', 'lore-rules', 'done'), dispatch('d', 'script-schema'), dispatch('e', 'greet'), dispatch('f', 'build'), dispatch('g', null), dispatch('h', 'lore-plot', 'active'), dispatch('i', 'source')];
  assert.deepEqual(runQueue(dispatches, 'all'), ['a', 'b', 'd', 'e']);
  assert.deepEqual(runQueue(dispatches, 'lore'), ['a']);
  assert.deepEqual(runQueue(dispatches, 'regex'), ['b']);
  assert.deepEqual(runQueue(dispatches, 'greet'), ['e']);
});

test('a dispatch aimed at a section no board has stays out of the queue instead of throwing', () => {
  const dispatches = [dispatch('a', 'lore-people'), dispatch('x', 'lore-other'), dispatch('y', '随便什么'), dispatch('b', 'greet')];
  assert.deepEqual(runQueue(dispatches, 'all'), ['a', 'b']);
  assert.deepEqual(runQueue(dispatches, 'lore'), ['a']);
});

test('three failures in a row of the same tool count; a success or another tool breaks the streak', () => {
  assert.deepEqual(toolFailureStreak([tool('powershell', 'failed', 't'), tool('powershell', 'failed', 't'), tool('powershell', 'failed', 't')]), { name: 'powershell', count: 3 });
  assert.equal(toolFailureStreak([tool('powershell', 'failed', 't'), tool('read', 'failed', 't'), tool('powershell', 'failed', 't'), tool('powershell', 'failed', 't')]), null);
  assert.equal(toolFailureStreak([tool('write', 'failed', 't'), tool('write', 'completed', 't'), tool('write', 'failed', 't'), tool('write', 'failed', 't')]), null);
});

test('a turn is a model error, an interjection, a question, a refusal or a delivery', () => {
  const base = { status: 'completed' as Task['status'], tools: [] as ToolCall[], sent: ['u1'] };
  assert.equal(turnOutcome({ ...base, messages: [user('u1'), ai('a1', '已交付。', 'u1')] }).kind, 'delivered');
  assert.deepEqual(turnOutcome({ ...base, status: 'failed', error: '网关 502', messages: [user('u1')] }), { kind: 'model-error', message: '网关 502' });
  assert.equal(turnOutcome({ ...base, status: 'cancelled', messages: [user('u1')] }).kind, 'cancelled');
  assert.equal(turnOutcome({ ...base, messages: [user('u1'), ai('a1', '好', 'u1'), user('x', '顺便改一下语气'), ai('a2', '已改。', 'x')] }).kind, 'interjection');
  const question = turnOutcome({ ...base, messages: [user('u1'), ai('a1', `1. 用哪个称呼？推荐：大王。\n${ACCEPT_ALL_MARKER}`, 'u1')] });
  assert.equal(question.kind, 'question');
  assert.ok(question.kind === 'question' && question.text.includes('用哪个称呼') && !question.text.includes(ACCEPT_ALL_MARKER));
  assert.equal(turnOutcome({ ...base, messages: [user('u1'), ai('a1', `缺少设计书。\n${REFUSE_MARKER}`, 'u1')] }).kind, 'refusal');
  // A marker quoted in a code block (a regex or prompt the section wrote) is not the AI speaking.
  assert.equal(turnOutcome({ ...base, messages: [user('u1'), ai('a1', `已交付。\n\`\`\`html\n${REFUSE_MARKER}\n\`\`\``, 'u1')] }).kind, 'delivered');
  const failing = [tool('powershell', 'failed', 'u1'), tool('powershell', 'failed', 'u1'), tool('powershell', 'failed', 'u1')];
  assert.deepEqual(turnOutcome({ ...base, tools: failing, messages: [user('u1'), ai('a1', '命令一直失败。', 'u1')] }), { kind: 'tool-failures', tool: 'powershell', count: 3 });
  // Earlier turns of the same conversation do not count.
  assert.equal(turnOutcome({ ...base, sent: ['u2'], messages: [user('u1'), ai('a1', `问题？\n${ACCEPT_ALL_MARKER}`, 'u1'), user('u2'), ai('a2', '已交付。', 'u2')] }).kind, 'delivered');
  // A message the user slipped in between two dispatches is an interjection, even though it is before this dispatch.
  const between = [user('u1'), ai('a1', '已交付。', 'u1'), user('x', '补充：先等一下'), ai('ax', '好的。', 'x'), user('u2'), ai('a2', '已交付。', 'u2')];
  assert.equal(turnOutcome({ ...base, sent: ['u2'], known: ['u1', 'u2'], messages: between }).kind, 'interjection');
  assert.equal(turnOutcome({ ...base, sent: ['u2'], known: ['u1', 'x', 'u2'], messages: between }).kind, 'delivered', 'once it is acknowledged the run goes on');
});

test('only check errors on the components this dispatch wrote hold it back', () => {
  const report: CardCheckReport = { ok: false, checkedAt: at, stats: { entries: 0, constantChars: 0, constantTokens: 0, sections: {} }, findings: [
    { level: 'error', code: 'a', message: '人设参数缺失', path: '世界书/人设/120-红孩儿.json' },
    { level: 'error', code: 'b', message: '别的分区的错误', path: '世界书/剧情/200-火云洞.md' },
    { level: 'warning', code: 'c', message: '只是警告', path: '世界书/人设/120-红孩儿.md' },
  ] };
  const tools = [tool('write', 'completed', 'u1', 'E:/Cards/西游/世界书/人设/120-红孩儿.md'), tool('write', 'completed', 'other', 'E:/Cards/西游/世界书/剧情/200-火云洞.md')];
  assert.deepEqual(dispatchErrors(report, tools, ['u1'], 'E:/Cards/西游').map(finding => finding.code), ['a']);
  assert.deepEqual(dispatchErrors(report, [], ['u1'], 'E:/Cards/西游'), []);
});

test('a run adds up the usage of its conversations since it started', () => {
  const run = { conversations: { 'lore-people': 't1' }, current: { taskId: 't2' }, startedAt: '2026-09-19T09:00:00.000Z' } as unknown as CardRun;
  const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: 0.01 };
  const early = { ...ai('old', 'x', 'u0', usage), at: '2026-09-19T08:00:00.000Z' };
  const tasks = [
    { id: 't1', messages: [early, ai('a', 'x', 'u1', usage)] },
    { id: 't2', messages: [ai('b', 'x', 'u2', usage)] },
    { id: 'other', messages: [ai('c', 'x', 'u3', usage)] },
  ] as unknown as Task[];
  const total = runUsage(run, tasks);
  assert.equal(total.tokens, 340);
  assert.ok(Math.abs(total.cost - 0.02) < 1e-9);
});
