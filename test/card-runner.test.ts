import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Harness } from '../src/main/harness.ts';
import { CardStudioService } from '../src/main/card-studio.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';
import type { CardRun, CardRunSettings } from '../src/shared/card-studio/types.ts';
import { CONTINUE_LIMIT, CONTINUE_TEXT } from '../src/shared/card-studio/run.ts';
import { formatDispatch } from '../src/shared/card-studio/dispatch.ts';
import type { Gateway, Task } from '../src/shared/types.ts';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
const resources = fileURLToPath(new URL('../card-studio', import.meta.url));
const codec: SecretCodec = { encrypt: value => Buffer.from(`fixture-codec:${value}`), decrypt: value => value.toString().slice('fixture-codec:'.length) };
const gateway: Omit<Gateway, 'hasKey'> = { id: 'fixture', name: 'Fixture', baseUrl: 'https://example.invalid/v1', modelId: 'fixture', protocol: 'openai-completions', reasoning: false, contextWindow: 200000, maxTokens: 1024 };
const settings: CardRunSettings = { thinking: 'off', gatewayId: 'fixture', permission: 'edit', autoAnswer: false };

async function setup(t: TestContext, root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'cardwright-card-runner-'));
  const harness = new Harness(join(root, 'data'), fakeWorker, new Vault(join(root, 'data'), codec));
  harness.saveGateway(gateway, 'fixture-key-never-a-real-credential');
  harness.savePreferences({ maxConcurrent: 3 });
  const studio = new CardStudioService(harness, resources, { documentsDir: join(root, 'documents') });
  harness.attachCardStudio(studio);
  const notices: Array<{ title: string; body: string }> = [];
  studio.runner.on('notify', notice => notices.push(notice));
  return { root, harness, studio, notices };
}
function cleanup(t: TestContext, root: string, ...harnesses: Harness[]) {
  t.after(async () => {
    for (const harness of harnesses) await harness.close();
    assert.ok(relative(resolve(tmpdir()), root).startsWith('cardwright-card-runner-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}
async function until(condition: () => boolean, description: string, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(done => setTimeout(done, 20));
  }
}

/** A card project with a design book and these dispatches (目标, body script), registered as planning would. */
async function card(harness: Harness, studio: CardStudioService, root: string, name: string, dispatches: Array<[string, string, string]>) {
  const folder = join(root, 'cards', name);
  const { card: { projectId } } = await studio.create({ name, kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), `# 设计书 · ${name}\n`);
  const file = JSON.parse(await readFile(join(folder, '卡项目.json'), 'utf8'));
  const at = new Date().toISOString();
  const sections: Record<string, string> = { '世界书/人设': 'lore-people', '世界书/叙事规则': 'lore-rules', '正则/正文美化': 'regex-body', '开场白': 'greet' };
  file.dispatches = dispatches.map(([target, title, body], index) => ({ id: `d${index + 1}`, target, sectionId: sections[target], title, requires: '设计书', body, status: 'todo', createdAt: at, updatedAt: at }));
  await writeFile(join(folder, '卡项目.json'), JSON.stringify(file, null, 2));
  await studio.reload(projectId);
  return { projectId, folder };
}
const run = (harness: Harness, projectId: string): CardRun | undefined => harness.snapshot().projects.find(project => project.id === projectId)?.cardRun;
const status = (harness: Harness, projectId: string) => run(harness, projectId)?.status;
const dispatchStatus = (harness: Harness, projectId: string, id: string) => harness.snapshot().cardStudio?.cards.find(card => card.projectId === projectId)?.dispatches.find(item => item.id === id)?.status;
const task = (harness: Harness, id: string): Task => { const found = harness.snapshot().tasks.find(item => item.id === id); assert.ok(found); return found; };
const settled = (harness: Harness, id: string) => { const value = harness.snapshot().tasks.find(item => item.id === id); return !!value && ['completed', 'failed', 'cancelled'].includes(value.status) && !value.workerActive; };

test('one board runs through: dispatches go out in order, one conversation per section, each marked done', async t => {
  const { root, harness, studio, notices } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·板块', [['世界书/人设', '写甲', 'RUN:deliver 甲'], ['世界书/人设', '写乙', 'RUN:deliver 乙'], ['正则/正文美化', '正文美化', 'RUN:deliver 美化']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'completed', 'the lore run to complete');
  const finished = run(harness, projectId)!;
  assert.deepEqual(finished.done, ['d1', 'd2']);
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done');
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
  assert.equal(dispatchStatus(harness, projectId, 'd3'), 'todo', 'another board is not part of this run');
  const conversation = task(harness, finished.conversations['lore-people']);
  assert.deepEqual(conversation.messages.filter(message => message.role === 'user').map(message => message.text.includes('RUN:deliver 甲') ? '甲' : message.text.includes('RUN:deliver 乙') ? '乙' : '?'), ['甲', '乙']);
  assert.equal(conversation.permission, 'edit');
  assert.equal(conversation.card?.dispatchId, 'd2', 'the conversation follows the dispatch it works on');
  assert.deepEqual(harness.snapshot().projects.find(project => project.id === projectId)?.cardSettings?.run, settings, 'the card remembers what the run used');
  harness.saveCardSettings(projectId, { run: { ...settings, modelId: 'fixture' } });
  harness.saveCardSettings(projectId, { run: settings });
  assert.equal(harness.snapshot().projects.find(project => project.id === projectId)?.cardSettings?.run?.modelId, undefined, 'a later run replaces the whole set');
  assert.ok(notices.some(notice => /一键制作完成/.test(notice.title)), JSON.stringify(notices));
  assert.equal(studio.runner.owns(conversation.id), false, 'a finished run no longer owns its conversations');
  await assert.rejects(studio.runner.start(projectId, 'lore', settings), /没有未派的派单/);
});

test('a question pauses the run; with 自动按推荐 it answers and carries on, keeping what it answered', async t => {
  const { root, harness, studio, notices } = await setup(t); cleanup(t, root, harness);
  const asked = await card(harness, studio, root, '一键·提问', [['世界书/人设', '写甲', 'RUN:ask']]);
  await studio.runner.start(asked.projectId, 'lore', settings);
  await until(() => status(harness, asked.projectId) === 'paused', 'the question pause');
  assert.equal(run(harness, asked.projectId)?.pause?.reason, 'question');
  assert.match(run(harness, asked.projectId)?.pause?.message ?? '', /称呼用哪个/);
  assert.ok(notices.some(notice => /暂停/.test(notice.title)));
  const questioned = run(harness, asked.projectId)!.current!.taskId;
  assert.equal(studio.runner.owns(questioned), true);
  // 继续 without answering in the conversation takes the recommendations.
  await studio.runner.resume(asked.projectId);
  await until(() => status(harness, asked.projectId) === 'completed', 'the run after 继续 on a question');
  assert.ok(task(harness, questioned).messages.some(message => message.role === 'user' && message.text === '全部按推荐'));
  assert.equal(run(harness, asked.projectId)?.autoAnswered.length, 0, 'the user chose, the run did not answer on its own');
  const auto = await card(harness, studio, root, '一键·自动', [['世界书/人设', '写甲', 'RUN:ask']]);
  await studio.runner.start(auto.projectId, 'lore', { ...settings, autoAnswer: true });
  await until(() => status(harness, auto.projectId) === 'completed', 'the auto-answered run');
  assert.equal(dispatchStatus(harness, auto.projectId, 'd1'), 'done');
  assert.equal(run(harness, auto.projectId)?.autoAnswered.length, 1);
  assert.match(run(harness, auto.projectId)!.autoAnswered[0].text, /称呼用哪个/);
});

// 自动按推荐 answers a question for the user; a section AI that never stops asking would be answered for ever, request after request.
test('自动按推荐 stops answering a dispatch after CONTINUE_LIMIT answers and pauses for the user', { timeout: 120_000 }, async t => {
  const { root, harness, studio, notices } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·问个没完', [['世界书/人设', '写甲', 'RUN:ask forever'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  await studio.runner.start(projectId, 'lore', { ...settings, autoAnswer: true });
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run to stop on its own', 90_000);
  const paused = run(harness, projectId)!;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pause?.reason, 'question');
  assert.match(paused.pause?.message ?? '', new RegExp(`自动按推荐答了 ${CONTINUE_LIMIT} 次`));
  assert.match(paused.pause?.message ?? '', /称呼用哪个/, 'the pending question is in the message');
  assert.equal(paused.autoAnswered.length, CONTINUE_LIMIT);
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active', 'not marked done');
  const answers = task(harness, paused.current!.taskId).messages.filter(message => message.role === 'user' && message.text === '全部按推荐');
  assert.equal(answers.length, CONTINUE_LIMIT, 'it sent exactly that many');
  assert.ok(notices.some(notice => /暂停/.test(notice.title)), JSON.stringify(notices));
  await studio.runner.stop(projectId);
});

test('自动按推荐 answers the question tool the same way, up to CONTINUE_LIMIT times for one dispatch', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·工具问个没完', [['世界书/人设', '写甲', 'RUN:interact forever']]);
  await studio.runner.start(projectId, 'lore', { ...settings, autoAnswer: true });
  await until(() => status(harness, projectId) === 'paused', 'the run to stop on its own', 30_000);
  const paused = run(harness, projectId)!;
  assert.equal(paused.pause?.reason, 'question');
  assert.match(paused.pause?.message ?? '', new RegExp(`自动按推荐答了 ${CONTINUE_LIMIT} 次`));
  assert.match(paused.pause?.message ?? '', /称呼用大王可以吗/);
  assert.equal(paused.autoAnswered.length, CONTINUE_LIMIT);
  assert.equal(harness.snapshot().interactions.length, 1, 'the next question waits for the user');
  await studio.runner.stop(projectId);
});

// Only messages of the dispatch in hand count; the turns of earlier dispatches in the same conversation are not news.
test('继续 on a later dispatch of the same conversation still does what the pause waited for', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·同对话', [['世界书/人设', '写甲', 'RUN:deliver 甲'], ['世界书/人设', '写乙', 'RUN:ask']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the question pause on the second dispatch');
  assert.equal(run(harness, projectId)?.pause?.reason, 'question');
  assert.deepEqual(run(harness, projectId)?.done, ['d1']);
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  const conversation = task(harness, run(harness, projectId)!.conversations['lore-people']);
  assert.ok(conversation.messages.some(message => message.role === 'user' && message.text === '全部按推荐'), conversation.messages.map(message => message.text).join(' | '));
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
});

test('a refusal, a model error and the same tool failing three times each pause the run', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  for (const [script, reason] of [['RUN:refuse', 'refusal'], ['RUN:error', 'model-error'], ['RUN:toolfail', 'tool-failures']]) {
    const { projectId } = await card(harness, studio, root, `一键·${reason}`, [['世界书/人设', '写甲', script]]);
    await studio.runner.start(projectId, 'lore', settings);
    await until(() => status(harness, projectId) === 'paused', `the ${reason} pause`);
    assert.equal(run(harness, projectId)?.pause?.reason, reason);
    await studio.runner.stop(projectId);
    assert.equal(status(harness, projectId), 'stopped');
  }
});

test('继续 after a model error asks the same conversation to go on with the dispatch', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·重试', [['世界书/人设', '写甲', 'RUN:error']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the model-error pause');
  const conversation = run(harness, projectId)!.current!.taskId;
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  assert.ok(task(harness, conversation).messages.some(message => message.role === 'user' && /继续做这条派单/.test(message.text)));
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done');
});

test('a reply that names gaps the squad left pauses the run; 继续 asks the section to go on', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·缺口', [['世界书/人设', '写甲乙', 'RUN:incomplete']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the incomplete pause');
  assert.equal(run(harness, projectId)?.pause?.reason, 'incomplete');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active', 'not marked done');
  const conversation = run(harness, projectId)!.current!.taskId;
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  assert.ok(task(harness, conversation).messages.some(message => message.role === 'user' && /继续做这条派单/.test(message.text)));
});

test('an approval pauses the run at once; after the user allows it, 继续 carries on', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·批准', [['世界书/人设', '写甲', 'RUN:approve']]);
  await studio.runner.start(projectId, 'lore', { ...settings, permission: 'ask' });
  await until(() => status(harness, projectId) === 'paused', 'the approval pause');
  assert.equal(run(harness, projectId)?.pause?.reason, 'approval');
  const approval = harness.snapshot().approvals[0];
  assert.ok(approval);
  harness.approve(approval.id, true);
  const conversation = run(harness, projectId)!.current!.taskId;
  await until(() => settled(harness, conversation), 'the approved turn');
  assert.equal(status(harness, projectId), 'paused', 'it waits for 继续');
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done');
});

test('check errors on this dispatch get one fix round; if they remain the run pauses', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId, folder } = await card(harness, studio, root, '一键·检查', [['世界书/人设', '可修', 'RUN:fixable'], ['世界书/人设', '坏条目', 'RUN:broken']]);
  await mkdir(join(folder, '世界书', '人设'), { recursive: true });
  await writeFile(join(folder, '世界书', '人设', '131-可修.json'), JSON.stringify({ uid: 131, comment: '可修' }));
  await writeFile(join(folder, '世界书', '人设', '130-坏条目.json'), JSON.stringify({ uid: 130, comment: '坏条目' }));
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the check-errors pause');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done', 'the fixable dispatch passed after one round');
  assert.equal(run(harness, projectId)?.pause?.reason, 'check-errors');
  assert.match(run(harness, projectId)?.pause?.message ?? '', /130-坏条目/);
  const conversation = task(harness, run(harness, projectId)!.current!.taskId);
  assert.equal(conversation.messages.filter(message => message.role === 'user' && message.text.startsWith('【拼装检查】')).length, 2, 'one fix round for each dispatch');
});

// 分批写 (ADR 0024): a dispatch that writes a list one item per round is not done after its first round.
test('a dispatch that is not finished goes on in the same conversation until the section AI says it is', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·接着做', [['世界书/人设', '逐个写人物', 'RUN:continue 2'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  const continues = () => { const id = run(harness, projectId)?.conversations['lore-people']; return id ? task(harness, id).messages.filter(message => message.role === 'user' && message.text === CONTINUE_TEXT).length : 0; };
  const marked: Array<[string, number]> = [];
  const mark = studio.markDispatchDone.bind(studio);
  studio.markDispatchDone = async (id: string, dispatchId: string) => { marked.push([dispatchId, continues()]); return mark(id, dispatchId); };
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run to stop on its own', 30_000);
  assert.deepEqual(marked, [['d1', 2], ['d2', 2]], 'the first dispatch was marked done only after its two extra rounds');
  const finished = run(harness, projectId)!;
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.done, ['d1', 'd2']);
  assert.equal(finished.continued, undefined, 'the count goes with the finished dispatch');
  const sent = task(harness, finished.conversations['lore-people']).messages.filter(message => message.role === 'user').map(message => message.text);
  assert.ok(sent.findIndex(text => text.includes('RUN:deliver 乙')) > sent.lastIndexOf(CONTINUE_TEXT), 'the next dispatch waits until the first is finished');
});

test('a dispatch that never says it is finished pauses after CONTINUE_LIMIT rounds; 继续 gives it more', async t => {
  const { root, harness, studio, notices } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·停不下', [['世界书/人设', '逐个写人物', 'RUN:continue forever']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run to stop on its own', 90_000);
  const paused = run(harness, projectId)!;
  assert.equal(paused.pause?.reason, 'continue-limit');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active', 'the dispatch is not marked done');
  assert.deepEqual(paused.continued, { dispatchId: 'd1', count: CONTINUE_LIMIT });
  assert.ok(notices.some(notice => notice.title.includes(String(CONTINUE_LIMIT))), JSON.stringify(notices));
  const conversation = paused.current!.taskId;
  const continues = () => task(harness, conversation).messages.filter(message => message.role === 'user' && message.text === CONTINUE_TEXT).length;
  assert.equal(continues(), CONTINUE_LIMIT);
  await studio.runner.resume(projectId);
  await until(() => continues() === CONTINUE_LIMIT + 1, 'one more round after 继续');
  assert.equal(run(harness, projectId)?.continued?.count, 1, '继续 starts the count again');
  await studio.runner.stop(projectId);
});

// The user can press 【标记完成】 while a run waits on a dispatch; 继续 then has nothing left to carry on.
test('a dispatch the user marked done during a pause is finished, and the run moves on instead of carrying it on', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·暂停时标完成', [['世界书/人设', '逐个写人物', 'RUN:continue forever'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  const d1 = harness.snapshot().cardStudio!.cards.find(item => item.projectId === projectId)!.dispatches[0];
  // The dispatch's first round, which says it is not finished, as the run would have sent it; then the run stops on CONTINUE_LIMIT.
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: d1.id, title: d1.title, prompt: formatDispatch(d1) });
  await until(() => settled(harness, conversation.id), 'the first round of the dispatch');
  const sentIds = task(harness, conversation.id).messages.filter(message => message.role === 'user').map(message => message.id);
  const at = new Date().toISOString();
  harness.saveCardRun(projectId, { id: 'fixture-run', scope: 'lore', status: 'paused', pause: { reason: 'continue-limit', message: '为了不一直自动接着做下去，先停在这里。', at }, settings, queue: ['d1', 'd2'], total: 2, done: [], current: { dispatchId: 'd1', taskId: conversation.id, stage: 'work', sent: sentIds }, conversations: { 'lore-people': conversation.id }, sentIds: { [conversation.id]: sentIds }, continued: { dispatchId: 'd1', count: CONTINUE_LIMIT }, autoAnswered: [], startedAt: at, updatedAt: at });
  await studio.markDispatchDone(projectId, 'd1');
  const continues = () => task(harness, conversation.id).messages.filter(message => message.role === 'user' && message.text === CONTINUE_TEXT).length;
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed' || continues() > 0, 'the run after 继续');
  assert.equal(continues(), 0, 'nothing was sent to carry on a dispatch that is done');
  assert.equal(status(harness, projectId), 'completed');
  assert.deepEqual(run(harness, projectId)?.done, ['d1', 'd2']);
  assert.equal(run(harness, projectId)?.continued, undefined, 'the count goes with the finished dispatch');
  assert.ok(task(harness, conversation.id).messages.some(message => message.role === 'user' && message.text.includes('RUN:deliver 乙')), 'the next dispatch went out in the same conversation');
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
});

test('check errors in a round that goes on get their fix round first; a later round gets its own', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId, folder } = await card(harness, studio, root, '一键·接着修', [['世界书/人设', '逐个写人物', 'RUN:continue 2 errors']]);
  await mkdir(join(folder, '世界书', '人设'), { recursive: true });
  await writeFile(join(folder, '世界书', '人设', '131-可修.json'), JSON.stringify({ uid: 131, comment: '可修' }));
  await writeFile(join(folder, '世界书', '人设', '132-再修.json'), JSON.stringify({ uid: 132, comment: '再修' }));
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run to stop on its own', 30_000);
  assert.equal(run(harness, projectId)?.pause?.reason, 'check-errors');
  assert.match(run(harness, projectId)?.pause?.message ?? '', /132-再修/);
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active');
  const sent = task(harness, run(harness, projectId)!.current!.taskId).messages.filter(message => message.role === 'user').map(message => message.text);
  const fixes = sent.flatMap((text, index) => text.startsWith('【拼装检查】') ? [index] : []);
  assert.equal(fixes.length, 2, 'the round after a fix round that went on got a fix round of its own');
  assert.equal(sent.filter(text => text === CONTINUE_TEXT).length, 1);
  assert.ok(fixes[0] < sent.indexOf(CONTINUE_TEXT), 'errors are fixed before the dispatch goes on');
});

test('check errors on a component a squad member wrote hold the dispatch back as well', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  harness.savePreferences({ cardSquad: { mode: 'write', selfDispatch: true } });
  // The section AI sends a 写组件, which writes 130-坏条目; the section AI itself writes nothing.
  const { projectId, folder } = await card(harness, studio, root, '一键·小队检查', [['世界书/人设', '坏条目', 'RUN:squad-broken']]);
  await mkdir(join(folder, '世界书', '人设'), { recursive: true });
  await writeFile(join(folder, '世界书', '人设', '130-坏条目.json'), JSON.stringify({ uid: 130, comment: '坏条目' }));
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the check-errors pause');
  assert.equal(run(harness, projectId)?.pause?.reason, 'check-errors');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active', 'not marked done');
  const conversation = task(harness, run(harness, projectId)!.current!.taskId);
  assert.ok(harness.snapshot().tasks.some(item => item.parentId === conversation.id && item.card?.squad?.role === 'writer'), 'a 写组件 did the writing');
  assert.equal(conversation.messages.filter(message => message.role === 'user' && message.text.startsWith('【拼装检查】')).length, 1, 'the member’s component got the fix round');
});

test('暂停 lets the round finish, 停止 cancels at once, 继续 goes on', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const paused = await card(harness, studio, root, '一键·暂停', [['世界书/人设', '慢', 'RUN:slow'], ['世界书/人设', '快', 'RUN:deliver']]);
  await studio.runner.start(paused.projectId, 'lore', settings);
  await until(() => !!run(harness, paused.projectId)?.current, 'the first dispatch to go out');
  await studio.runner.pause(paused.projectId);
  assert.equal(status(harness, paused.projectId), 'pausing');
  await until(() => status(harness, paused.projectId) === 'paused', 'the pause after the round');
  assert.equal(dispatchStatus(harness, paused.projectId, 'd1'), 'done', 'the round that was running finished');
  assert.deepEqual(run(harness, paused.projectId)?.queue, ['d2']);
  await studio.runner.resume(paused.projectId);
  await until(() => status(harness, paused.projectId) === 'completed', 'the run after 继续');

  const stopped = await card(harness, studio, root, '一键·停止', [['世界书/人设', '一直做', 'RUN:hold']]);
  await studio.runner.start(stopped.projectId, 'lore', settings);
  await until(() => { const current = run(harness, stopped.projectId)?.current; return !!current && task(harness, current.taskId).status === 'running'; }, 'the held turn');
  const held = run(harness, stopped.projectId)!.current!.taskId;
  await studio.runner.stop(stopped.projectId);
  assert.equal(status(harness, stopped.projectId), 'stopped');
  assert.equal(studio.runner.owns(held), true, 'the conversation it stopped stays quiet until it settles');
  await until(() => settled(harness, held), 'the cancelled turn');
  assert.equal(task(harness, held).status, 'cancelled');
  await until(() => !studio.runner.owns(held), 'the stopped conversation to be the user\'s again');
});

test('a message from the user during a run is handled, then the run pauses until 继续', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·插话', [['世界书/人设', '慢', 'RUN:slow']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => { const current = run(harness, projectId)?.current; return !!current && task(harness, current.taskId).status === 'running'; }, 'the slow turn');
  const conversation = run(harness, projectId)!.current!.taskId;
  await harness.prompt(conversation, '补充：称呼改成大王。', 'followUp');
  await until(() => status(harness, projectId) === 'paused', 'the interjection pause');
  assert.equal(run(harness, projectId)?.pause?.reason, 'interjection');
  assert.ok(task(harness, conversation).messages.some(message => message.text === 'Echo: 补充：称呼改成大王。'), 'the user message was handled in that round');
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
});

// The user can write in the moment between the run judging one dispatch and sending the next one.
test('a message that lands between two dispatches pauses the run as an interjection', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·夹缝', [['世界书/人设', '写甲', 'RUN:deliver 甲'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  const checks = studio.runChecks.bind(studio);
  let slipped = false;
  studio.runChecks = async (id: string) => {
    const report = await checks(id);
    const conversation = run(harness, projectId)?.current?.taskId;
    if (!slipped && conversation) { slipped = true; await harness.prompt(conversation, '补充：先等一下。', 'followUp'); }
    return report;
  };
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the interjection pause');
  assert.equal(run(harness, projectId)?.pause?.reason, 'interjection');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done');
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
});

test('past the threshold the run changes conversation, sending the summary with the next dispatch', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·换对话', [['世界书/人设', '大', 'RUN:big'], ['世界书/人设', '下一条', 'RUN:deliver 下一条']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'completed', 'the run across the handoff', 20_000);
  const finished = run(harness, projectId)!;
  const fresh = task(harness, finished.conversations['lore-people']);
  const first = fresh.messages.find(message => message.role === 'user')!;
  assert.match(first.text, /已定: 人物模板 v2/);
  assert.match(first.text, /RUN:deliver 下一条/);
  const old = harness.snapshot().tasks.find(item => item.card?.handoff);
  assert.equal(old?.card?.handoff?.status, 'consumed');
  assert.notEqual(old?.id, fresh.id);
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
});

test('past the threshold an unfinished dispatch goes on in a new conversation, with the summary and the dispatch', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·接着换对话', [['世界书/人设', '逐个写人物', 'RUN:continue 1 big'], ['世界书/人设', '下一条', 'RUN:deliver 下一条']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run across the handoff', 30_000);
  const finished = run(harness, projectId)!;
  assert.equal(finished.status, 'completed', finished.pause?.message);
  assert.deepEqual(finished.done, ['d1', 'd2']);
  assert.equal(finished.continued, undefined);
  const fresh = task(harness, finished.conversations['lore-people']);
  const first = fresh.messages.find(message => message.role === 'user')!;
  assert.match(first.text, /已定: 人物模板 v2/);
  assert.match(first.text, /RUN:continue 1 big/, 'the dispatch goes along with the summary');
  const old = harness.snapshot().tasks.find(item => item.card?.handoff);
  assert.equal(old?.card?.handoff?.status, 'consumed');
  assert.notEqual(old?.id, fresh.id);
  assert.equal(old!.messages.filter(message => message.role === 'user' && message.text === CONTINUE_TEXT).length, 0, 'the old conversation handed over instead of going on');
});

// What a failed summary leaves: the dispatch is 进行中 in its old conversation and nothing is running.
test('after 继续, a dispatch the run was carrying on with is sent on, not dropped from the queue', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·半途', [['世界书/人设', '逐个写人物', 'RUN:deliver 剩下的']]);
  const d1 = harness.snapshot().cardStudio!.cards.find(item => item.projectId === projectId)!.dispatches[0];
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: d1.id, title: d1.title, prompt: formatDispatch(d1) });
  await until(() => settled(harness, conversation.id), 'the first round of the dispatch');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active');
  const at = new Date().toISOString();
  const sentIds = task(harness, conversation.id).messages.filter(message => message.role === 'user').map(message => message.id);
  harness.saveCardRun(projectId, { id: 'fixture-run', scope: 'lore', status: 'paused', pause: { reason: 'model-error', message: '没有拿到交接摘要，换对话没有完成。', at }, settings, queue: ['d1'], total: 1, done: [], conversations: { 'lore-people': conversation.id }, sentIds: { [conversation.id]: sentIds }, continued: { dispatchId: 'd1', count: 4 }, autoAnswered: [], startedAt: at, updatedAt: at });
  await studio.runner.resume(projectId);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run after 继续');
  assert.deepEqual(run(harness, projectId)?.done, ['d1']);
  const sent = task(harness, conversation.id).messages.filter(message => message.role === 'user').map(message => message.text);
  assert.equal(sent.at(-1), CONTINUE_TEXT, 'the conversation goes on with the dispatch instead of getting it again');
  assert.equal(sent.filter(text => text.includes('RUN:deliver 剩下的')).length, 1);
});

// A dispatch stopped mid-way stays 进行中 in the section's conversation; the next run has to pick it up, or it is never finished.
test('a new run picks up a dispatch a stopped run left 进行中 and continues it in its own conversation', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·停了再来', [['世界书/人设', '写甲', 'RUN:hold'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => { const current = run(harness, projectId)?.current; return !!current && task(harness, current.taskId).status === 'running'; }, 'the held turn');
  const held = run(harness, projectId)!.current!.taskId;
  await studio.runner.stop(projectId);
  await until(() => settled(harness, held) && !studio.runner.owns(held), 'the stopped turn to settle');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active', 'the stop left it 进行中');
  await studio.runner.dismiss(projectId);

  await studio.runner.start(projectId, 'lore', settings);
  const started = run(harness, projectId)!;
  assert.deepEqual([started.queue, started.total, started.pickedUp], [['d1', 'd2'], 2, ['d1']], 'both, in planning order, the 进行中 one remembered as picked up');
  await until(() => status(harness, projectId) === 'completed', 'the second run to complete');
  const finished = run(harness, projectId)!;
  assert.deepEqual(finished.done, ['d1', 'd2']);
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'done');
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'done');
  assert.equal(finished.conversations['lore-people'], held, 'the section’s conversation is the one that holds the dispatch');
  assert.equal(harness.snapshot().tasks.filter(item => item.card?.sectionId === 'lore-people').length, 1, 'no second conversation was opened');
  const sent = task(harness, held).messages.filter(message => message.role === 'user').map(message => message.text);
  assert.equal(sent.length, 3);
  assert.ok(sent[0].includes('RUN:hold'));
  assert.equal(sent[1], CONTINUE_TEXT, 'the dispatch goes on instead of being sent again');
  assert.ok(sent[2].includes('RUN:deliver 乙'), 'and the next one follows in the same conversation');
});

test('a 进行中 dispatch whose conversation is gone starts again cleanly in a new one', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·没了对话', [['世界书/人设', '写甲', 'RUN:deliver 甲'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  const d1 = harness.snapshot().cardStudio!.cards.find(item => item.projectId === projectId)!.dispatches[0];
  const gone = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: d1.id, title: d1.title, prompt: formatDispatch(d1) });
  await until(() => settled(harness, gone.id), 'the first round of the dispatch');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active');
  harness.updateTask(gone.id, { archived: true });

  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'completed', 'the run to complete');
  const finished = run(harness, projectId)!;
  assert.deepEqual(finished.done, ['d1', 'd2']);
  const fresh = task(harness, finished.conversations['lore-people']);
  assert.notEqual(fresh.id, gone.id);
  const sent = fresh.messages.filter(message => message.role === 'user').map(message => message.text);
  assert.ok(sent[0].includes('RUN:deliver 甲'), 'the dispatch is sent whole, not continued');
  assert.equal(sent.includes(CONTINUE_TEXT), false);
  assert.equal(task(harness, gone.id).messages.filter(message => message.role === 'user').length, 1, 'the archived conversation is left alone');
});

test('a picked-up dispatch whose conversation is past the threshold goes on in a new conversation, with the summary and the dispatch', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·捡起来换对话', [['世界书/人设', '逐个写人物', 'RUN:continue 1 big'], ['世界书/人设', '下一条', 'RUN:deliver 下一条']]);
  const d1 = harness.snapshot().cardStudio!.cards.find(item => item.projectId === projectId)!.dispatches[0];
  // A first round that said the dispatch is not finished, with the context nearly full: sent by hand, or by a run that was stopped.
  const old = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: d1.id, title: d1.title, prompt: formatDispatch(d1) });
  await until(() => settled(harness, old.id) && !!task(harness, old.id).contextUsage?.tokens, 'the first round');
  assert.equal(dispatchStatus(harness, projectId, 'd1'), 'active');
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => ['paused', 'completed'].includes(status(harness, projectId) ?? ''), 'the run across the handoff', 30_000);
  const finished = run(harness, projectId)!;
  assert.equal(finished.status, 'completed', finished.pause?.message);
  assert.deepEqual(finished.done, ['d1', 'd2']);
  const fresh = task(harness, finished.conversations['lore-people']);
  assert.notEqual(fresh.id, old.id);
  const first = fresh.messages.find(message => message.role === 'user')!;
  assert.match(first.text, /已定: 人物模板 v2/);
  assert.match(first.text, /RUN:continue 1 big/, 'the dispatch goes along with the summary');
  assert.equal(task(harness, old.id).card?.handoff?.status, 'consumed');
  assert.equal(task(harness, old.id).messages.filter(message => message.role === 'user' && message.text === CONTINUE_TEXT).length, 0, 'the old conversation handed over instead of going on');
});

test('a dispatch the user started by hand while the run was paused stays out of the run', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·手动发', [['世界书/人设', '写甲', 'RUN:ask'], ['世界书/人设', '写乙', 'RUN:deliver 乙']]);
  await studio.runner.start(projectId, 'lore', settings);
  await until(() => status(harness, projectId) === 'paused', 'the question pause');
  // The user sends the second dispatch to its section by hand, in a conversation of their own.
  const d2 = harness.snapshot().cardStudio!.cards.find(item => item.projectId === projectId)!.dispatches[1];
  const byHand = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: d2.id, title: d2.title, prompt: formatDispatch(d2) });
  await until(() => settled(harness, byHand.id) && dispatchStatus(harness, projectId, 'd2') === 'active', 'the hand-sent dispatch');
  await studio.runner.resume(projectId);
  await until(() => status(harness, projectId) === 'completed', 'the run after 继续');
  assert.deepEqual(run(harness, projectId)?.done, ['d1'], 'the run did not send the dispatch again');
  assert.equal(dispatchStatus(harness, projectId, 'd2'), 'active', 'it stays the user’s');
  assert.equal(task(harness, byHand.id).messages.filter(message => message.role === 'user').length, 1);
});

test('全部开做 runs every board in dispatch order and ends with the assembly check', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·全部', [['世界书/叙事规则', '规则', 'RUN:deliver 规则'], ['正则/正文美化', '美化', 'RUN:deliver 美化'], ['开场白', '开场白', 'RUN:deliver 开场']]);
  await studio.runner.start(projectId, 'all', settings);
  await until(() => status(harness, projectId) === 'completed', 'the full run', 20_000);
  const finished = run(harness, projectId)!;
  assert.deepEqual(finished.done, ['d1', 'd2', 'd3']);
  assert.ok(finished.finalCheck && typeof finished.finalCheck.errors === 'number');
  assert.deepEqual(Object.keys(finished.conversations).sort(), ['greet', 'lore-rules', 'regex-body']);
});

test('a card cannot leave the library while its run is going; a paused run goes with it', async t => {
  const { root, harness, studio } = await setup(t); cleanup(t, root, harness);
  const { projectId } = await card(harness, studio, root, '一键·移除', [['世界书/人设', '写甲', 'RUN:deliver']]);
  const at = new Date().toISOString();
  const going: CardRun = { id: 'fixture-run', scope: 'lore', status: 'running', settings, queue: ['d1'], total: 1, done: [], conversations: {}, autoAnswered: [], startedAt: at, updatedAt: at };
  harness.saveCardRun(projectId, going);
  await assert.rejects(studio.remove(projectId), /一键制作/);
  harness.saveCardRun(projectId, { ...going, status: 'paused', pause: { reason: 'user', message: '已暂停。', at } });
  await studio.remove(projectId);
  assert.equal(harness.snapshot().projects.some(project => project.id === projectId), false);
});

test('after a restart a run that was going is paused and can go on', async t => {
  const first = await setup(t);
  const { projectId } = await card(first.harness, first.studio, first.root, '一键·重启', [['世界书/人设', '一直做', 'RUN:hold'], ['世界书/人设', '再做', 'RUN:deliver']]);
  await first.studio.runner.start(projectId, 'lore', settings);
  await until(() => { const current = run(first.harness, projectId)?.current; return !!current && task(first.harness, current.taskId).status === 'running'; }, 'the held turn');
  await first.harness.close();
  const second = await setup(t, first.root); cleanup(t, first.root, second.harness);
  assert.equal(status(second.harness, projectId), 'paused');
  assert.equal(run(second.harness, projectId)?.pause?.reason, 'restart');
  await second.studio.runner.resume(projectId);
  await until(() => status(second.harness, projectId) === 'completed', 'the run after 继续 following a restart');
  assert.deepEqual(run(second.harness, projectId)?.done, ['d1', 'd2']);
});
