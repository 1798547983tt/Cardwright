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
