import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationsOf, dispatchDone, leadTurnWrites, markableDispatch, memberSummary, memberWrites, membersOfTurn, nextDispatch, progressInputOf, projectRelativePath, relativeTime, runningConversation, squadOf, squadTools, turnAt, turnWrites } from '../src/shared/card-studio/view.ts';
import type { AppSnapshot, ChatMessage, Task, ToolCall } from '../src/shared/types.ts';
import type { CardDispatch, CardProjectView } from '../src/shared/card-studio/types.ts';

// Calendar words (昨天, 9月2日) depend on the local time zone; pin it so the test is stable on any machine.
process.env.TZ = 'Asia/Shanghai';
const now = new Date('2026-09-17T14:30:00+08:00');

test('formats relative edit times in Chinese and English', () => {
  assert.equal(relativeTime('2026-09-17T14:29:40+08:00', now, 'zh'), '刚刚');
  assert.equal(relativeTime('2026-09-17T14:12:00+08:00', now, 'zh'), '18 分钟前');
  assert.equal(relativeTime('2026-09-17T11:30:00+08:00', now, 'zh'), '3 小时前');
  assert.equal(relativeTime('2026-09-16T22:40:00+08:00', now, 'zh'), '昨天 22:40');
  assert.equal(relativeTime('2026-09-02T09:00:00+08:00', now, 'zh'), '9月2日');
  assert.equal(relativeTime('2026-09-17T14:12:00+08:00', now, 'en'), '18 min ago');
  assert.equal(relativeTime('2026-09-16T22:40:00+08:00', now, 'en'), 'Yesterday 22:40');
});

test('maps tool paths to card project relative paths', () => {
  const root = 'E:\\Cards\\西游';
  assert.equal(projectRelativePath(root, 'E:\\Cards\\西游\\世界书\\人设\\120-红孩儿.md'), '世界书/人设/120-红孩儿.md');
  assert.equal(projectRelativePath(root, 'e:/cards/西游/设计书.md'), '设计书.md');
  assert.equal(projectRelativePath(root, '世界书\\总览\\地点总览.md'), '世界书/总览/地点总览.md');
  assert.equal(projectRelativePath(root, './设计书.md'), '设计书.md');
  assert.equal(projectRelativePath(root, 'E:\\Cards\\西游-副本\\设计书.md'), null);
  assert.equal(projectRelativePath(root, '..\\别处.md'), null);
});

const tool = (name: string, path: string, turnId: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id: `${name}-${path}-${turnId}`, name, args: { path }, output: '', status: 'completed', at: '2026-09-17T06:00:00.000Z', turnId, ...extra });

test('groups the completed file writes of one turn by component', () => {
  const tools = [
    tool('write', 'E:\\Cards\\西游\\世界书\\人设\\120-红孩儿.md', 't1', { args: { path: 'E:\\Cards\\西游\\世界书\\人设\\120-红孩儿.md', content: '<红孩儿>\n姓名：红孩儿' } }),
    tool('edit', '世界书/人设/120-红孩儿.md', 't1', { patch: '@@ -1 +1 @@' }),
    tool('edit', '设计书.md', 't1'),
    tool('read', '资料/索引.md', 't1'),
    tool('write', '世界书/人设/121-白骨夫人.md', 't1', { status: 'failed' }),
    tool('write', '世界书/人设/121-白骨夫人.md', 't2'),
    tool('write', 'E:\\elsewhere.txt', 't1'),
  ];
  assert.deepEqual(turnWrites(tools, 't1', 'E:\\Cards\\西游'), [
    { name: '人设·红孩儿', op: 'edit', paths: ['世界书/人设/120-红孩儿.md'], patch: '@@ -1 +1 @@', preview: '<红孩儿>\n姓名：红孩儿' },
    { name: '设计书', op: 'edit', paths: ['设计书.md'] },
  ]);
});

const task = (id: string, sectionId: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: 'p1', title: id, cwd: 'E:\\Cards\\西游', status: 'completed', permission: 'edit', gatewayId: 'g', thinking: 'medium',
  createdAt: `2026-09-17T0${id.length}:00:00.000Z`, updatedAt: '2026-09-17T09:00:00.000Z', messages: [], tools: [], card: { sectionId }, ...extra,
});

test('a member’s work belongs to the lead turn that was running, under the member’s name', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', text: '写三个人物', at: '2026-09-17T06:00:00.000Z', turnId: 'u1' },
    { id: 'a1', role: 'assistant', text: '派了小队。', at: '2026-09-17T06:05:00.000Z', turnId: 'u1' },
    { id: 'u2', role: 'user', text: '再写一个', at: '2026-09-17T07:00:00.000Z', turnId: 'u2' },
  ];
  const lead = task('lead', 'lore-people', { messages, tools: [tool('edit', '设计书.md', 'u1')] });
  const writer = task('m1', 'lore-people', { parentId: 'lead', agentName: '白骨精', createdAt: '2026-09-17T06:01:00.000Z', card: { sectionId: 'lore-people', member: true, squad: { role: 'writer', files: [], create: ['黄袍怪'] } }, tools: [
    tool('write', '世界书/人设/130-黄袍怪.md', 'm1-turn', { at: '2026-09-17T06:02:00.000Z' }),
    tool('write', '世界书/人设/131-奎木狼.md', 'm1-turn', { at: '2026-09-17T07:01:00.000Z' }),
  ] });
  const reader = task('m2', 'lore-people', { parentId: 'lead', agentName: '土地公', createdAt: '2026-09-17T06:01:30.000Z', card: { sectionId: 'lore-people', member: true } });
  const other = task('x', 'lore-people', { parentId: 'someone-else', card: { sectionId: 'lore-people', member: true } });
  assert.deepEqual(squadOf([lead, writer, reader, other], 'lead').map(item => item.id), ['m1', 'm2']);
  assert.equal(turnAt(lead, '2026-09-17T06:30:00.000Z'), 'u1');
  assert.equal(turnAt(lead, '2026-09-17T05:00:00.000Z'), undefined);
  assert.deepEqual(membersOfTurn(lead, [reader, writer], 'u1').map(item => item.id), ['m1', 'm2']);
  assert.deepEqual(squadTools(lead, [writer], ['u1']).map(item => [item.turnId, item.memberName, item.args.path]), [['u1', '写组件 · 白骨精', '世界书/人设/130-黄袍怪.md']]);
  assert.deepEqual(leadTurnWrites(lead, [lead, writer, reader], 'u1', 'E:\\Cards\\西游'), [
    { name: '设计书', op: 'edit', paths: ['设计书.md'] },
    { name: '人设·黄袍怪', op: 'write', paths: ['世界书/人设/130-黄袍怪.md'], member: '写组件 · 白骨精' },
  ]);
  assert.deepEqual(leadTurnWrites(lead, [lead, writer], 'u2', 'E:\\Cards\\西游').map(item => item.name), ['人设·奎木狼']);
});

test('a member’s work stays with the lead turn that sent it: a withdrawn turn takes its squad along, and a member sent again works for the later turn', () => {
  // The lead's u2 (07:00) was withdrawn; u3 (08:00) sent 白骨精 again. Each member message records the lead turn that sent it.
  const lead = task('lead', 'lore-people', { messages: [
    { id: 'u1', role: 'user', text: '写人物', at: '2026-09-17T06:00:00.000Z', turnId: 'u1' },
    { id: 'a1', role: 'assistant', text: '派了小队。', at: '2026-09-17T06:05:00.000Z', turnId: 'u1' },
    { id: 'u3', role: 'user', text: '让白骨精再补一个', at: '2026-09-17T08:00:00.000Z', turnId: 'u3' },
  ] });
  const writer = (id: string, name: string, createdAt: string, extra: Partial<Task>) => task(id, 'lore-people', { parentId: 'lead', agentName: name, createdAt, card: { sectionId: 'lore-people', member: true, squad: { role: 'writer', files: [], create: [name] } }, ...extra });
  const sentAgain = writer('m1', '白骨精', '2026-09-17T06:01:00.000Z', {
    messages: [
      { id: 'm1a', role: 'user', text: '写黄袍怪', at: '2026-09-17T06:01:00.000Z', turnId: 'm1a', leadTurnId: 'u1' },
      { id: 'm1b', role: 'user', text: '再写白骨精', at: '2026-09-17T08:01:00.000Z', turnId: 'm1b', leadTurnId: 'u3' },
    ],
    tools: [tool('write', '世界书/人设/130-黄袍怪.md', 'm1a', { at: '2026-09-17T06:02:00.000Z' }), tool('write', '世界书/人设/132-白骨精.md', 'm1b', { at: '2026-09-17T08:02:00.000Z' })],
  });
  const fromWithdrawn = writer('m2', '黄袍怪', '2026-09-17T07:01:00.000Z', {
    messages: [{ id: 'm2a', role: 'user', text: '写奎木狼', at: '2026-09-17T07:01:00.000Z', turnId: 'm2a', leadTurnId: 'u2' }],
    tools: [tool('write', '世界书/人设/131-奎木狼.md', 'm2a', { at: '2026-09-17T07:02:00.000Z' })],
  });
  const tasks = [lead, sentAgain, fromWithdrawn];
  assert.deepEqual(membersOfTurn(lead, [fromWithdrawn, sentAgain], 'u1').map(item => item.id), ['m1'], 'the withdrawn turn’s member does not move to the turn before it');
  assert.deepEqual(membersOfTurn(lead, [fromWithdrawn, sentAgain], 'u3'), [], 'a member’s card stays in the turn that started it');
  assert.deepEqual(leadTurnWrites(lead, tasks, 'u1', 'E:\\Cards\\西游').map(item => [item.name, item.member]), [['人设·黄袍怪', '写组件 · 白骨精']]);
  assert.deepEqual(leadTurnWrites(lead, tasks, 'u3', 'E:\\Cards\\西游').map(item => [item.name, item.member]), [['人设·白骨精', '写组件 · 白骨精']]);
  assert.deepEqual(squadTools(lead, [fromWithdrawn]).map(item => item.turnId), ['u2'], 'still the turn that sent it');
});

test('a member card shows what the member wrote and a short version of what it returned', () => {
  const member = task('m1', 'lore-people', { tools: [
    tool('write', '世界书/人设/130-黄袍怪.md', 'm1'), tool('edit', '世界书/人设/130-黄袍怪.md', 'm1'), tool('read', '资料/索引.md', 'm1'), tool('write', '世界书/人设/131-x.md', 'm1', { status: 'failed' }),
  ], messages: [{ id: 'a', role: 'assistant', text: `黄袍怪写好了。\n<!-- cardwright:incomplete -->`, at: '2026-09-17T06:00:00.000Z' }] });
  assert.deepEqual(memberWrites(member, 'E:\\Cards\\西游'), [{ name: '人设·黄袍怪', op: 'edit', paths: ['世界书/人设/130-黄袍怪.md'] }]);
  assert.equal(memberSummary(member), '黄袍怪写好了。');
  assert.equal(memberSummary({ messages: [{ id: 'b', role: 'assistant', text: '长'.repeat(500), at: '' }] }).length, 401);
  assert.equal(memberSummary({ messages: [] }), '');
});

test('a member card’s summary is its last reply with words in it, and its writes are its own whatever turn it worked in', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', text: '写黄袍怪', at: '2026-09-17T06:00:00.000Z', turnId: 'u1' },
    { id: 'a1', role: 'assistant', text: '先读资料。', at: '2026-09-17T06:01:00.000Z', turnId: 'u1' },
    { id: 'a2', role: 'assistant', text: '黄袍怪写好了，两处引用了出处。\n<!-- cardwright:refuse -->', at: '2026-09-17T06:02:00.000Z', turnId: 'u1' },
    { id: 'u2', role: 'user', text: '再补一句', at: '2026-09-17T06:03:00.000Z', turnId: 'u2' },
    { id: 'a3', role: 'assistant', text: '   ', at: '2026-09-17T06:04:00.000Z', turnId: 'u2' },
  ];
  assert.equal(memberSummary({ messages }), '黄袍怪写好了，两处引用了出处。', 'the empty reply after it and the user’s message are skipped, and the marker line is hidden');
  const member = task('m1', 'lore-people', { tools: [
    tool('write', '世界书/人设/130-黄袍怪.md', 'u1'), tool('write', '世界书/人设/131-奎木狼.md', 'u2'), tool('write', 'E:\\elsewhere.txt', 'u2'),
  ] });
  assert.deepEqual(memberWrites(member, 'E:\\Cards\\西游').map(item => item.name), ['人设·黄袍怪', '人设·奎木狼'], 'both of its turns count, and a path outside the card does not');
});

test('lists a section conversations newest first and finds the running conversation of a card', () => {
  const tasks = [task('a', 'plan'), task('bbb', 'lore-people'), task('cc', 'lore-people', { archived: true }), task('dddd', 'lore-people'), { ...task('eeeee', 'plan'), projectId: 'p2' }];
  assert.deepEqual(conversationsOf(tasks, 'p1', 'lore-people').map(item => item.id), ['dddd', 'bbb']);
  assert.equal(runningConversation(tasks, 'p1'), undefined);
  assert.equal(runningConversation([...tasks, task('run', 'plan', { status: 'running' })], 'p1')?.id, 'run');
  assert.equal(runningConversation([...tasks, task('tail', 'plan', { status: 'completed', workerActive: true })], 'p1')?.id, 'tail');
});

const dispatch = (id: string, sectionId: string, status: CardDispatch['status']): CardDispatch => ({ id, target: '', sectionId, title: id, requires: '', body: '', status, createdAt: '', updatedAt: '' });
const view = (dispatches: CardDispatch[]): CardProjectView => ({ projectId: 'p1', path: 'E:\\Cards\\西游', cardId: 'c', name: '西游', kind: 'fan', source: '西游记', coverStyle: 'vermilion', stylePreset: null, frontendAssets: { mode: 'inline', base: '' }, origin: 'new', createdAt: '', updatedAt: '', lastEditedAt: '', dispatches, design: { exists: true, people: null }, changes: [], sources: 2, unclassified: 0 });

test('builds progress input and picks the dispatch that 标记完成 applies to', () => {
  const card = view([dispatch('d1', 'lore-people', 'done'), dispatch('d2', 'lore-people', 'active'), dispatch('d3', 'lore-people', 'active'), dispatch('d4', 'lore-plot', 'todo')]);
  assert.deepEqual(progressInputOf(card, [task('a', 'plan')]), { dispatches: card.dispatches, designExists: true, planStarted: true, sources: 2, origin: 'new' });
  assert.equal(markableDispatch(card, 'lore-people')?.id, 'd2');
  assert.equal(markableDispatch(card, 'lore-people', task('x', 'lore-people', { card: { sectionId: 'lore-people', dispatchId: 'd3' } }))?.id, 'd3');
  assert.equal(markableDispatch(card, 'lore-plot'), undefined);
});

test('the next dispatch is the first one not yet sent, and a conversation knows when its own is done', () => {
  const card = view([dispatch('d1', 'lore-people', 'done'), dispatch('d2', 'lore-plot', 'active'), dispatch('d3', 'lore-people', 'todo'), dispatch('d4', 'regex-body', 'todo')]);
  assert.equal(nextDispatch(card)?.id, 'd3');
  assert.equal(nextDispatch(view([dispatch('d1', 'lore-people', 'done')])), undefined);
  assert.equal(dispatchDone(card, task('x', 'lore-people', { card: { sectionId: 'lore-people', dispatchId: 'd1' } })), true);
  assert.equal(dispatchDone(card, task('y', 'lore-plot', { card: { sectionId: 'lore-plot', dispatchId: 'd2' } })), false);
  assert.equal(dispatchDone(card, task('z', 'lore-people')), false);
});

test('a message offers 撤回 while its turn is in progress and 编辑并重新生成 once it is written (Q16)', async () => {
  const view = await import('../src/shared/card-studio/view.ts') as Record<string, unknown>;
  assert.equal(typeof view.messageAction, 'function', 'the studio thread asks which action a message offers');
  const messageAction = view.messageAction as (task: Task, messageId: string, options?: { runOwned?: boolean }) => 'withdraw' | 'edit' | null;
  const at = '2026-09-17T06:00:00.000Z';
  const messages: Task['messages'] = [
    { id: 'u1', turnId: 'u1', role: 'user', text: '写红孩儿。', at },
    { id: 'a1', turnId: 'u1', role: 'assistant', text: '好。', at },
    { id: 'u2', turnId: 'u2', role: 'user', text: '再写白骨夫人。', at },
  ];
  const running = task('r', 'lore-people', { status: 'running', messages });
  assert.equal(messageAction(running, 'u2'), 'withdraw', 'the message whose turn is running');
  assert.equal(messageAction(running, 'u1'), null, 'earlier messages wait for the run to end');
  assert.equal(messageAction(running, 'a1'), null, 'replies are not withdrawn');
  assert.equal(messageAction(running, 'u2', { runOwned: true }), null, 'one-click making owns its conversation; pause it first');
  const queued = task('q', 'lore-people', { status: 'running', messages: [...messages, { id: 'u3', turnId: 'u3', role: 'user', text: '还有黄袍怪。', at, pending: true }] });
  assert.equal(messageAction(queued, 'u3'), 'withdraw', 'a queued follow-up is the latest message');
  assert.equal(messageAction(queued, 'u2'), null);
  assert.equal(messageAction(task('w', 'lore-people', { status: 'completed', workerActive: true, messages }), 'u2'), 'withdraw', 'the worker is still winding down');
  const done = task('d', 'lore-people', { status: 'completed', messages });
  assert.equal(messageAction(done, 'u2'), 'edit');
  assert.equal(messageAction(done, 'u1'), 'edit', 'as in the workbench, any written message can be edited into a new version');
  assert.equal(messageAction(task('f', 'lore-people', { status: 'cancelled', messages }), 'u2'), 'edit', 'a stopped turn is finished too');
  const kickoff = task('k', 'plan', { status: 'running', card: { sectionId: 'plan', kickoff: true, mode: 'scratch' }, messages: [{ id: 'k1', turnId: 'k1', role: 'user', text: '开场', at }] });
  assert.equal(messageAction(kickoff, 'k1'), null, 'the kickoff line is the app’s, not the user’s');
  const handoff = task('h', 'lore-people', { status: 'running', messages: [...messages.slice(0, 2), { id: 'h1', turnId: 'h1', role: 'user', text: '【换对话 · 请写交接摘要】\n请写。', at }] });
  assert.equal(messageAction(handoff, 'h1'), null, 'the handoff request is the app’s too');
});

test('the workbench view hides card projects, card conversations and what belongs to them', async () => {
  const { workbenchSnapshot } = await import('../src/shared/card-studio/view.ts');
  const base = { publicationRevision: 1, preferences: {}, gateways: [], schedules: [], skills: [], version: '0.8.0', search: {}, ecosystem: {}, extensions: [] } as unknown as AppSnapshot;
  const code = { id: 'p1', name: 'app', path: 'E:\app', isGit: true, createdAt: '' };
  const cardProject = { id: 'p2', name: '西游', path: 'E:\Cards\西游', isGit: false, createdAt: '', kind: 'card' as const };
  const plain = { id: 't1', projectId: 'p1' } as Task;
  const section = { id: 't2', projectId: 'p2', card: { sectionId: 'plan' } } as Task;
  const snapshot = { ...base, projects: [code, cardProject], tasks: [plain, section],
    approvals: [{ id: 'a1', taskId: 't1' }, { id: 'a2', taskId: 't2' }], interactions: [{ id: 'i1', taskId: 't2' }] } as unknown as AppSnapshot;
  const view = workbenchSnapshot(snapshot);
  assert.deepEqual(view.projects.map(item => item.id), ['p1']);
  assert.deepEqual(view.tasks.map(item => item.id), ['t1']);
  assert.deepEqual(view.approvals.map(item => item.id), ['a1']);
  assert.deepEqual(view.interactions, []);
  assert.equal(view.version, '0.8.0');

  // A later publication where only the card conversation changed keeps the workbench arrays, so hidden streaming does not re-render the workbench.
  const next = { ...snapshot, tasks: [plain, { ...section, title: 'streaming' }], approvals: [...snapshot.approvals], interactions: [] } as AppSnapshot;
  const nextView = workbenchSnapshot(next, view);
  assert.equal(nextView.tasks, view.tasks);
  assert.equal(nextView.projects, view.projects);
  assert.equal(nextView.approvals, view.approvals);

  const without = { ...base, projects: [code], tasks: [plain], approvals: [], interactions: [] } as unknown as AppSnapshot;
  assert.equal(workbenchSnapshot(without), without);
});

test('long card names step the text cover title down in three sizes', async () => {
  const { coverFit, titleUnits } = await import('../src/shared/card-studio/view.ts');
  assert.ok(Math.abs(titleUnits('西游·八十一难') - 6.55) < 1e-9, 'the middle dot counts as half a character');
  assert.ok(Math.abs(titleUnits('Re:从零开始的异世界生活') - 11.65) < 1e-9);
  assert.equal(coverFit('西游·八十一难'), 1);
  assert.equal(coverFit('长夜之城与最后一位守灯人'), 1);
  assert.equal(coverFit('长夜之城与最后一位守灯人们'), 2);
  assert.equal(coverFit('一'.repeat(24)), 2);
  assert.equal(coverFit('一'.repeat(25)), 3);
  assert.equal(coverFit('A'.repeat(40)), 2);
});
