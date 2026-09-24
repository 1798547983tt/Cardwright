import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Harness } from '../src/main/harness.ts';
import { CardStudioService } from '../src/main/card-studio.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';
import { COVER_STYLES } from '../src/core/card-studio/card-project.ts';
import { formatDispatch } from '../src/shared/card-studio/dispatch.ts';
import { KICKOFF, isHandoffRequest } from '../src/shared/card-studio/markers.ts';
import { parseHandoff } from '../src/shared/card-studio/handoff.ts';
import { conversationsOf } from '../src/shared/card-studio/view.ts';
import { pngChunks, readCardFromPng, writeCardIntoPng } from '../src/core/card-studio/png.ts';
import { deflateSync } from 'node:zlib';
import type { PreviewSegment } from '../src/shared/card-studio/preview.ts';
import type { Gateway, Task } from '../src/shared/types.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';
import { START_SHEET, STATUS_SHEET } from './assembly-sheet-samples.ts';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
const resources = fileURLToPath(new URL('../card-studio', import.meta.url));
const codec: SecretCodec = { encrypt: value => Buffer.from(`fixture-codec:${value}`), decrypt: value => value.toString().slice('fixture-codec:'.length) };
const gateway: Omit<Gateway, 'hasKey'> = { id: 'fixture', name: 'Fixture', baseUrl: 'https://example.invalid/v1', modelId: 'fixture', protocol: 'openai-completions', reasoning: false, contextWindow: 8192, maxTokens: 1024 };

async function setup(t: TestContext, extra: Partial<ConstructorParameters<typeof CardStudioService>[2]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-card-harness-'));
  const harness = new Harness(join(root, 'data'), fakeWorker, new Vault(join(root, 'data'), codec));
  t.after(async () => {
    await harness.close();
    assert.ok(relative(resolve(tmpdir()), root).startsWith('cardwright-card-harness-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  harness.saveGateway(gateway, 'fixture-key-never-a-real-credential');
  harness.savePreferences({ maxConcurrent: 2 });
  const studio = new CardStudioService(harness, resources, { documentsDir: join(root, 'documents'), ...extra });
  harness.attachCardStudio(studio);
  return { root, harness, studio };
}

async function until(condition: () => boolean, description: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(done => setTimeout(done, 20));
  }
}
const task = (harness: Harness, id: string): Task => { const found = harness.snapshot().tasks.find(item => item.id === id); assert.ok(found); return found; };
const card = (harness: Harness) => { const found = harness.snapshot().cardStudio?.cards[0]; assert.ok(found); return found; };
const settled = (harness: Harness, id: string) => { const value = harness.snapshot().tasks.find(item => item.id === id); return !!value && ['completed', 'failed', 'cancelled'].includes(value.status) && !value.workerActive; };
const lastReply = (harness: Harness, id: string) => task(harness, id).messages.findLast(message => message.role === 'assistant')?.text ?? '';

test('a card project is registered as a card, listed by the card library and reused for its folder', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'cards', '西游');
  const created = await studio.create({ name: '西游·八十一难', kind: 'fan', source: '西游记', folder });
  assert.equal(created.reused, false);
  const project = harness.snapshot().projects.find(item => item.id === created.card.projectId);
  assert.equal(project?.kind, 'card');
  assert.equal(project?.name, '西游·八十一难');
  const view = card(harness);
  assert.equal(view.name, '西游·八十一难');
  assert.equal(view.kind, 'fan');
  assert.equal(view.source, '西游记');
  assert.ok(COVER_STYLES.includes(view.coverStyle));
  assert.deepEqual(view.dispatches, []);
  assert.deepEqual(view.design, { exists: false, people: null });
  assert.equal(view.sources, 0);
  assert.equal(resolve(view.path), resolve(folder));
  assert.equal(studio.defaultFolder('西游·八十一难'), join(root, 'documents', 'Cardwright 角色卡', '西游·八十一难'));

  const again = await studio.create({ name: '另一个名字', kind: 'original', folder });
  assert.equal(again.reused, true);
  assert.equal(again.card.projectId, created.card.projectId);
  assert.equal(harness.snapshot().projects.length, 1);

  const plain = join(root, 'plain'); await mkdir(plain);
  await harness.addProject(plain);
  await assert.rejects(studio.create({ name: '普通', kind: 'original', folder: plain }), /已经作为普通项目添加/);
});

test('planning starts with the kickoff, runs offline, without squads or memory, and with the section prompt', async t => {
  const { root, harness, studio } = await setup(t);
  const { card: { projectId } } = await studio.create({ name: '雾港档案局', kind: 'original', folder: join(root, 'fog') });
  const started = await studio.startConversation({ projectId, sectionId: 'plan', mode: 'scratch', kickoff: true });
  await until(() => settled(harness, started.id), 'kickoff reply');
  const conversation = task(harness, started.id);
  assert.equal(conversation.messages[0].text, KICKOFF.scratch);
  assert.equal(conversation.permission, 'edit');
  assert.equal(conversation.title, '从零开始制卡');
  assert.deepEqual(conversation.card, { sectionId: 'plan', mode: 'scratch', web: false, kickoff: true });
  assert.equal(card(harness).design.exists, false);

  await harness.prompt(started.id, 'inspect-card-init');
  await until(() => settled(harness, started.id) && lastReply(harness, started.id).startsWith('{'), 'init report');
  const init = JSON.parse(lastReply(harness, started.id));
  assert.equal(init.canDelegate, false);
  assert.equal(init.memoryEnabled, false);
  assert.equal(init.searchEnabled, false);
  assert.equal(init.role, 'card-section');
  assert.equal(init.permission, 'edit');
  assert.ok(init.prompt.includes('# 规划 · 从零开始制卡'));
  assert.ok(init.prompt.includes('雾港档案局'));
  assert.deepEqual(init.readRoots, [resources]);

  await assert.rejects(studio.startConversation({ projectId, sectionId: 'lore-people' }), /还没有设计书/);
  await assert.rejects(studio.startConversation({ projectId, sectionId: 'source' }), /资料板块没有对话/);
  await assert.rejects(studio.startConversation({ projectId, sectionId: 'nowhere' }), /未知的分区/);
});

test('planning replies register dispatches once, sending a dispatch starts it and marking completes it', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'xiyou');
  const { card: { projectId } } = await studio.create({ name: '西游·八十一难', kind: 'fan', source: '西游记', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 西游·八十一难\n\n## 人物名单\n| 序号 | 人物 | 档位 | 状态 |\n| --- | --- | --- | --- |\n| 1 | 唐三藏 | 主要 | 已写 |\n| 2 | 红孩儿 | 次要 | 未写 |\n');
  const plan = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'reply-dispatches' });
  await until(() => card(harness).dispatches.length === 2, 'dispatches registered');
  assert.deepEqual(card(harness).dispatches.map(item => [item.sectionId, item.title, item.status, item.sourceTaskId]), [['lore-rules', '写叙事规则', 'todo', plan.id], ['lore-people', '写人物模板', 'todo', plan.id]]);
  assert.deepEqual(card(harness).design, { exists: true, people: { written: 1, total: 2 } });

  await harness.prompt(plan.id, 'reply-dispatches');
  await until(() => settled(harness, plan.id) && task(harness, plan.id).messages.filter(message => message.role === 'assistant').length === 2, 'second planning reply');
  await new Promise(done => setTimeout(done, 100));
  assert.equal(card(harness).dispatches.length, 2);

  const [rules, template] = card(harness).dispatches;
  const people = await studio.startConversation({ projectId, sectionId: 'lore-people', dispatchId: template.id, title: template.title, prompt: formatDispatch(template) });
  assert.equal(task(harness, people.id).card?.dispatchId, template.id);
  assert.equal(card(harness).dispatches[1].status, 'active');
  await until(() => settled(harness, people.id), 'people conversation reply');

  const rulesConversation = await studio.startConversation({ projectId, sectionId: 'lore-rules', prompt: `请开工。\n${formatDispatch(rules)}` });
  assert.equal(task(harness, rulesConversation.id).card?.dispatchId, rules.id);
  assert.equal(card(harness).dispatches[0].status, 'active');

  await studio.markDispatchDone(projectId, template.id);
  assert.equal(card(harness).dispatches[1].status, 'done');
  await assert.rejects(studio.markDispatchDone(projectId, 'missing'), /找不到这条派单/);
  const saved = JSON.parse(await readFile(join(folder, '卡项目.json'), 'utf8'));
  assert.deepEqual(saved.dispatches.map((item: { status: string }) => item.status), ['active', 'done']);
});

test('撤回 stops the turn in progress, takes the message out, hands its text back and returns its dispatch to 未派', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'withdraw');
  const { card: { projectId } } = await studio.create({ name: '西游·撤回', kind: 'fan', source: '西游记', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 西游·撤回\n');
  const plan = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'reply-dispatches' });
  await until(() => card(harness).dispatches.length === 2 && settled(harness, plan.id), 'dispatches registered');
  const [rules] = card(harness).dispatches;
  const sent = `${formatDispatch(rules)}\nRUN:hold`;
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-rules', dispatchId: rules.id, title: rules.title, prompt: sent });
  await until(() => task(harness, conversation.id).tools.length > 0, 'the turn in progress');
  assert.equal(card(harness).dispatches[0].status, 'active');
  const message = task(harness, conversation.id).messages.find(item => item.role === 'user')!;

  const result = await studio.withdraw(conversation.id, message.id);
  assert.equal(result.text, sent, 'the text goes back to the composer');
  assert.equal(result.turnId, message.turnId, 'the turn, so its writes can still be undone');
  const after = task(harness, conversation.id);
  assert.equal(after.workerActive, false, 'the turn has stopped');
  assert.deepEqual(after.messages, [], 'the message and the partial reply are gone');
  assert.deepEqual(after.tools, []);
  assert.equal(after.status, 'idle');
  assert.equal(after.card?.dispatchId, rules.id, 'the conversation still belongs to its dispatch');
  assert.equal(card(harness).dispatches[0].status, 'todo', 'the dispatch is 未派 again');
  const saved = JSON.parse(await readFile(join(folder, '卡项目.json'), 'utf8'));
  assert.equal(saved.dispatches[0].status, 'todo');

  await harness.prompt(conversation.id, formatDispatch(rules));
  await until(() => settled(harness, conversation.id), 'the resent dispatch');
  assert.equal(card(harness).dispatches[0].status, 'active', 'sending again starts the dispatch again');
  await assert.rejects(studio.withdraw(conversation.id, task(harness, conversation.id).messages[0].id), /编辑/, 'a written message is edited, not withdrawn');
});

test('撤回 keeps the earlier turns, only takes the latest message, and takes a queued message out before it runs', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'withdraw-later');
  const { card: { projectId } } = await studio.create({ name: '西游·撤回二', kind: 'fan', source: '西游记', folder });
  const conversation = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'complete' });
  await until(() => settled(harness, conversation.id), 'the first turn');
  await harness.prompt(conversation.id, 'hold');
  await until(() => task(harness, conversation.id).tools.length > 0, 'the second turn in progress');
  const [first, , second] = task(harness, conversation.id).messages;
  await assert.rejects(studio.withdraw(conversation.id, first.id), /最后/, 'only the latest message can be withdrawn');
  assert.equal((await studio.withdraw(conversation.id, second.id)).text, 'hold');
  assert.deepEqual(task(harness, conversation.id).messages.map(item => [item.role, item.text]), [['user', 'complete'], ['assistant', 'Fixture completed.']]);
  assert.equal(task(harness, conversation.id).status, 'completed');

  // A plain task holds the only slot, so the card conversation's next message waits in the queue.
  harness.savePreferences({ maxConcurrent: 1 });
  await mkdir(join(root, 'plain'), { recursive: true });
  const plain = await harness.createTask({ projectId: (await harness.addProject(join(root, 'plain'))).id, prompt: 'hold' });
  await until(() => task(harness, plain.id).status === 'running', 'the plain task holding the slot');
  await harness.prompt(conversation.id, '排队的这句');
  assert.equal(task(harness, conversation.id).status, 'queued');
  const queued = task(harness, conversation.id).messages.at(-1)!;
  assert.equal((await studio.withdraw(conversation.id, queued.id)).text, '排队的这句');
  assert.equal(task(harness, conversation.id).messages.length, 2);
  assert.equal(task(harness, conversation.id).status, 'completed');
  await harness.cancelTask(plain.id);
  await until(() => settled(harness, plain.id), 'the plain task stopped');
  await new Promise(done => setTimeout(done, 200));
  assert.equal(task(harness, conversation.id).messages.length, 2, 'the withdrawn message never runs');
});

test('撤回 of a first message the model is still answering leaves a conversation that can be sent again', async t => {
  // Pi writes a new session file only once the first reply is finished. When the run has to be stopped the hard way, the
  // file never exists, so the conversation must not keep pointing into it: in the packaged 1.0 smoke every later message
  // failed with "missing a saved entry".
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'withdraw-unsaved');
  const { card: { projectId } } = await studio.create({ name: '西游·撤回三', kind: 'fan', source: '西游记', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 西游·撤回三\n');
  const plan = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'reply-dispatches' });
  await until(() => card(harness).dispatches.length === 2 && settled(harness, plan.id), 'dispatches registered');
  const [rules] = card(harness).dispatches;
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-rules', dispatchId: rules.id, title: rules.title, prompt: `${formatDispatch(rules)}\nRUN:unsaved` });
  await until(() => lastReply(harness, conversation.id).includes('正在写'), 'the reply being written');
  const message = task(harness, conversation.id).messages.find(item => item.role === 'user')!;
  assert.equal(message.sessionEntryId, 'fixture-unsaved-entry', 'the worker said where the message sits in its session');

  await studio.withdraw(conversation.id, message.id);
  const after = task(harness, conversation.id);
  assert.equal(after.sessionFile, undefined, 'nothing of that session reached the disk, so the next message starts a new one');
  assert.equal(after.sessionLeafId, undefined);
  assert.equal(after.branchBeforeEntryId, undefined);

  await harness.prompt(conversation.id, formatDispatch(rules));
  await until(() => settled(harness, conversation.id), 'the resent dispatch');
  assert.equal(task(harness, conversation.id).status, 'completed', task(harness, conversation.id).error);
  assert.equal(card(harness).dispatches[0].status, 'active');
});

test('the style preset the design book names shows on the card', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'preset');
  const { card: { projectId } } = await studio.create({ name: '樱花庄', kind: 'original', folder });
  assert.equal(card(harness).stylePreset, null, 'to be planned');
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 樱花庄\n\n## 风格预设\n预设：粉樱（sakura）。樱粉只给当前项。\n');
  assert.deepEqual((await studio.reload(projectId)).stylePreset, { id: 'sakura', name: '粉樱' });
});

test('the app asks the section AI for a handoff summary and hands it to one new conversation', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'handoff');
  const { card: { projectId } } = await studio.create({ name: '西游·交接', kind: 'fan', source: '西游记', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 西游·交接\n');
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-people', prompt: 'complete' });
  await until(() => settled(harness, conversation.id), 'first reply');
  await studio.requestHandoff(conversation.id);
  assert.equal(task(harness, conversation.id).card?.handoff?.status, 'requested');
  await assert.rejects(studio.requestHandoff(conversation.id), /已经在写交接摘要/);
  await until(() => settled(harness, conversation.id) && task(harness, conversation.id).card?.handoff?.status === 'ready', 'summary ready');
  const done = task(harness, conversation.id);
  assert.ok(done.messages.some(message => message.role === 'user' && isHandoffRequest(message.text)));
  assert.deepEqual(parseHandoff(done.card?.handoff?.summary ?? ''), { decided: '人物模板 v2', written: '红孩儿 uid 120', pending: '名单剩余 19 人', first: '写黄袍怪' });
  await studio.consumeHandoff(conversation.id);
  assert.equal(task(harness, conversation.id).card?.handoff?.status, 'consumed');
  await assert.rejects(studio.consumeHandoff(conversation.id), /没有待打开的交接摘要/);
  harness.savePreferences({ cardHandoff: { tokens: 120_000, windowPercent: 40 } });
  assert.deepEqual(harness.snapshot().preferences.cardHandoff, { tokens: 120_000, windowPercent: 40 });
  assert.throws(() => harness.savePreferences({ cardHandoff: { tokens: 500, windowPercent: 40 } }), /换对话阈值/);
  assert.throws(() => harness.savePreferences({ cardHandoff: { tokens: 120_000, windowPercent: 100 } }), /换对话阈值/);
});

test('developer mode edits the built-in prompts; new conversations get the override, and restoring brings the default back', async t => {
  const { root, harness, studio } = await setup(t);
  const { card: { projectId } } = await studio.create({ name: '雾港·开发者', kind: 'original', folder: join(root, 'developer') });
  await assert.rejects(studio.savePromptOverride('kickoff/scratch', '【开始规划】改过的开场话'), /开发者模式/);
  harness.savePreferences({ developerMode: true });
  await studio.savePromptOverride('kickoff/scratch', '【开始规划】改过的开场话');
  await studio.savePromptOverride('prompts/规划-从零开始制卡.md', '# 规划 · 覆盖版\n只按覆盖版提问。');
  assert.ok((await studio.listPromptOverrides()).filter(item => item.overridden).length === 2);
  const started = await studio.startConversation({ projectId, sectionId: 'plan', mode: 'scratch', kickoff: true });
  await until(() => settled(harness, started.id), 'kickoff reply');
  assert.equal(task(harness, started.id).messages[0].text, '【开始规划】改过的开场话');
  assert.equal(task(harness, started.id).card?.kickoff, true, 'the conversation remembers it began with the kickoff');
  await harness.prompt(started.id, 'inspect-card-init');
  await until(() => settled(harness, started.id) && lastReply(harness, started.id).startsWith('{'), 'init report');
  assert.match(JSON.parse(lastReply(harness, started.id)).prompt, /只按覆盖版提问/);
  await studio.restorePromptOverride('prompts/规划-从零开始制卡.md');
  assert.match(await studio.readPrompt(projectId, 'plan', 'scratch'), /# 规划 · 从零开始制卡/);
  harness.savePreferences({ developerMode: false });
  await assert.rejects(studio.restorePromptOverride('kickoff/scratch'), /开发者模式/);
  assert.throws(() => harness.savePreferences({ developerMode: 'yes' as never }), /开发者模式/);
});

test('each card remembers its permission mode and its kickoff effort and model', async t => {
  const { root, harness, studio } = await setup(t);
  harness.saveGateway({ id: 'thinker', name: 'Thinker', baseUrl: 'https://example.invalid/v1', modelId: 'deep', protocol: 'openai-completions', reasoning: true, contextWindow: 200000, maxTokens: 8192, models: [{ id: 'deep', reasoning: true, contextWindow: 200000, maxTokens: 8192 }, { id: 'quick', reasoning: true, contextWindow: 100000, maxTokens: 8192 }] }, 'fixture-key-never-a-real-credential');
  const folder = join(root, 'settings');
  const { card: { projectId } } = await studio.create({ name: '雾港·设置', kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书\n');
  const plain = await studio.startConversation({ projectId, sectionId: 'lore-rules', prompt: 'complete' });
  assert.equal(task(harness, plain.id).permission, 'edit', 'project-scoped auto edit is the default');
  await until(() => settled(harness, plain.id), 'first conversation');

  harness.saveCardSettings(projectId, { permission: 'ask' });
  assert.equal(harness.snapshot().projects.find(project => project.id === projectId)?.cardSettings?.permission, 'ask');
  const asking = await studio.startConversation({ projectId, sectionId: 'lore-rules', prompt: 'complete' });
  assert.equal(task(harness, asking.id).permission, 'ask');
  await until(() => settled(harness, asking.id), 'second conversation');
  assert.throws(() => harness.saveCardSettings(projectId, { permission: 'plan' as never }), /权限/);
  assert.throws(() => harness.saveCardSettings(projectId, { kickoff: { gatewayId: 'thinker', modelId: 'missing' } }), /模型/);

  const kickoff = await studio.startConversation({ projectId, sectionId: 'plan', mode: 'scratch', kickoff: true, thinking: 'ultra', gatewayId: 'thinker', modelId: 'quick' });
  await until(() => settled(harness, kickoff.id), 'kickoff reply');
  assert.equal(task(harness, kickoff.id).thinking, 'ultra');
  assert.equal(task(harness, kickoff.id).modelId, 'quick');
  assert.deepEqual(harness.snapshot().projects.find(project => project.id === projectId)?.cardSettings?.kickoff, { thinking: 'ultra', gatewayId: 'thinker', modelId: 'quick' });
});

test('only an Ultra planning conversation gets a squad, and its members only read', async t => {
  const { root, harness, studio } = await setup(t);
  harness.saveGateway({ id: 'thinker', name: 'Thinker', baseUrl: 'https://example.invalid/v1', modelId: 'deep', protocol: 'openai-completions', reasoning: true, contextWindow: 200000, maxTokens: 8192 }, 'fixture-key-never-a-real-credential');
  harness.savePreferences({ maxConcurrent: 4 });
  const folder = join(root, 'squad');
  const { card: { projectId } } = await studio.create({ name: '雾港·小队', kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书\n');
  const report = async (input: Parameters<typeof studio.startConversation>[0]) => {
    const started = await studio.startConversation({ ...input, prompt: 'inspect-card-init' });
    await until(() => settled(harness, started.id), `init report for ${input.sectionId}`);
    return JSON.parse(lastReply(harness, started.id));
  };
  assert.equal((await report({ projectId, sectionId: 'plan', thinking: 'ultra', gatewayId: 'thinker' })).canDelegate, true);
  assert.equal((await report({ projectId, sectionId: 'plan', thinking: 'high', gatewayId: 'thinker' })).canDelegate, false);
  assert.equal((await report({ projectId, sectionId: 'lore-rules', thinking: 'ultra', gatewayId: 'thinker' })).canDelegate, false);

  const lead = await studio.startConversation({ projectId, sectionId: 'plan', thinking: 'ultra', gatewayId: 'thinker', prompt: 'team:inspect-init' });
  await until(() => settled(harness, lead.id), 'the planning lead collects its squad');
  const members = harness.snapshot().tasks.filter(item => item.parentId === lead.id);
  assert.equal(members.length, 2, lastReply(harness, lead.id));
  for (const member of members) {
    assert.equal(member.sharedReadOnly, true);
    assert.equal(member.role, 'Explore');
    assert.deepEqual(member.card, { sectionId: 'plan', member: true });
    assert.equal(JSON.parse(lastReply(harness, member.id)).readOnly, true);
  }
  assert.ok(!conversationsOf(harness.snapshot().tasks, projectId, 'plan').some(item => item.parentId), 'members are not conversations of the section');
});

test('web access can be turned on for one conversation', async t => {
  const { root, harness, studio } = await setup(t);
  const { card: { projectId } } = await studio.create({ name: '汽灯与铜镜', kind: 'original', folder: join(root, 'lamp') });
  const conversation = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'complete' });
  await until(() => settled(harness, conversation.id), 'first reply');
  studio.setWeb(conversation.id, true);
  assert.equal(task(harness, conversation.id).card?.web, true);
  await harness.prompt(conversation.id, 'inspect-card-init');
  await until(() => settled(harness, conversation.id) && lastReply(harness, conversation.id).startsWith('{'), 'init report');
  assert.equal(JSON.parse(lastReply(harness, conversation.id)).searchEnabled, true);
  assert.throws(() => studio.setWeb('missing', true), /Task not found|找不到/);
});

test('removing a card project needs idle conversations and keeps the folder', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'abyss');
  const { card: { projectId } } = await studio.create({ name: '深渊收容录', kind: 'original', folder });
  const running = await studio.startConversation({ projectId, sectionId: 'plan', prompt: 'hold' });
  await until(() => task(harness, running.id).tools.length === 1, 'conversation running');
  await assert.rejects(studio.remove(projectId), /还有对话在运行/);
  await assert.rejects(studio.startConversation({ projectId, sectionId: 'plan', prompt: 'complete' }), /同一时间只运行一个对话/);
  await harness.cancelTask(running.id);
  await until(() => settled(harness, running.id), 'cancelled');
  await studio.remove(projectId);
  assert.equal(harness.snapshot().projects.length, 0);
  assert.equal(harness.snapshot().tasks.length, 0);
  assert.deepEqual(harness.snapshot().cardStudio?.cards, []);
  assert.ok((await stat(join(folder, '卡项目.json'))).isFile());
});

const sampleCardJson = () => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡', first_mes: '开场',
  data: {
    name: '样卡', first_mes: '开场', character_book: { name: '样卡世界书', entries: [
      { id: 3, keys: ['爱蜜莉雅'], secondary_keys: [], comment: '爱蜜莉雅', content: '<爱蜜莉雅>\n姓名：爱蜜莉雅\n</爱蜜莉雅>', constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char', use_regex: true, extensions: { position: 0, depth: 4, display_index: 0 } },
    ] },
    extensions: { world: '样卡世界书' },
  },
});

test('importing a character card creates a card project made of components', async t => {
  const { root, harness, studio } = await setup(t);
  const file = join(root, 'sample-card.json');
  await writeFile(file, JSON.stringify(sampleCardJson()));
  const preview = await studio.importPreview(file);
  assert.equal(preview.kind, 'card');
  assert.equal(preview.name, '样卡');
  assert.equal(preview.entries, 1);

  const folder = join(root, 'cards', '导入卡');
  const created = await studio.createFromFile({ name: '样卡', kind: 'fan', source: 'Re:从零开始的异世界生活', folder, file });
  assert.equal(created.report.lore, 1);
  assert.equal(created.card.origin, 'import', 'an imported project can use 完善优化卡');
  assert.ok((await stat(join(folder, '世界书/人设/100-爱蜜莉雅.md'))).isFile());
  assert.equal(harness.snapshot().cardStudio?.cards.length, 1);

  const report = await studio.runChecks(created.card.projectId);
  assert.equal(report.stats.entries, 1);
  assert.ok(report.findings.some(item => item.code === 'export-readback' && item.level === 'info'));

  const exported = await studio.exportCard(created.card.projectId);
  assert.match(exported.file, /^导出\/样卡.*\.json$/);
  const written = JSON.parse(await readFile(join(folder, ...exported.file.split('/')), 'utf8'));
  assert.equal(written.data.character_book.entries.length, 1);
  assert.equal(written.data.character_book.entries[0].content, '<爱蜜莉雅>\n姓名：爱蜜莉雅\n</爱蜜莉雅>');
  const book = await studio.exportLorebook(created.card.projectId);
  const bookJson = JSON.parse(await readFile(join(folder, ...book.file.split('/')), 'utf8'));
  assert.deepEqual(Object.keys(bookJson.entries), ['3']);
  const registration = JSON.parse(await readFile(join(folder, '卡项目.json'), 'utf8'));
  assert.equal(registration.exports.length, 2, 'exports are recorded in the registration');
  assert.equal(registration.nextUid, 4);
});

/** A 2×3 greyscale PNG: enough of an image to carry a card and become a cover. */
function portraitPng(): Buffer {
  const crc32 = (buffer: Buffer) => { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(3, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0))]);
}

test('a PNG character card imports like its JSON, and its image becomes the cover', async t => {
  const { root, studio } = await setup(t);
  const image = portraitPng();
  const file = join(root, '样卡.png');
  await writeFile(file, writeCardIntoPng(image, sampleCardJson()));

  const preview = await studio.importPreview(file);
  assert.deepEqual({ kind: preview.kind, format: preview.format, name: preview.name, entries: preview.entries, mismatch: preview.mismatch }, { kind: 'card', format: 'png', name: '样卡', entries: 1, mismatch: undefined }, 'the payloads agree, so there is nothing to warn about');

  const folder = join(root, 'cards', 'PNG 卡');
  const created = await studio.createFromFile({ name: '样卡', kind: 'original', folder, file });
  assert.equal(created.report.lore, 1);
  assert.equal(created.card.cover, '封面/封面.png', 'the card art is kept as the uploaded cover');
  const cover = await readFile(join(folder, '封面', '封面.png'));
  assert.deepEqual(cover, image, 'the cover is the image alone, without a second copy of the card inside');
  assert.throws(() => readCardFromPng(cover), /没有角色卡数据/);
  assert.ok(pngChunks(cover).length > 0);

  const exported = await studio.exportCard(created.card.projectId);
  const written = JSON.parse(await readFile(join(folder, ...exported.file.split('/')), 'utf8'));
  assert.equal(written.data.character_book.entries[0].content, '<爱蜜莉雅>\n姓名：爱蜜莉雅\n</爱蜜莉雅>', 'the payload came through intact');

  const broken = join(root, 'not-a-card.png');
  await writeFile(broken, image);
  await assert.rejects(studio.importPreview(broken), /没有角色卡数据/);
});

test('each whole-card export writes a report of what changed and how to replace it', async t => {
  const { root, studio } = await setup(t);
  const file = join(root, 'sample-card.json');
  await writeFile(file, JSON.stringify(sampleCardJson()));
  const folder = join(root, 'cards', '报告卡');
  const created = await studio.createFromFile({ name: '样卡', kind: 'original', folder, file });
  const id = created.card.projectId;

  const first = await studio.exportCard(id);
  assert.ok(first.report, 'a whole-card export comes with a report');
  assert.match(first.report!.file, /^导出\/导出报告-.*\.md$/);
  assert.match(first.report!.text, /第一次导出/);
  assert.equal(await readFile(join(folder, ...first.report!.file.split('/')), 'utf8'), first.report!.text, 'the report is also a file next to the export');

  const unchanged = await studio.exportCard(id);
  assert.match(unchanged.report!.text, /和上次导出相比没有改动/);

  await writeFile(join(folder, '世界书/人设/100-爱蜜莉雅.md'), '<爱蜜莉雅>\n姓名：爱蜜莉雅\n外貌：银发。\n</爱蜜莉雅>');
  const changed = await studio.exportCard(id);
  assert.match(changed.report!.text, /改动 · 世界书：爱蜜莉雅/);
  assert.match(changed.report!.text, /替换\/更新/);
  const pieces = /单件在 `(导出\/单件-[^`]+)\/`/.exec(changed.report!.text)?.[1];
  assert.ok(pieces, 'a report with changed pieces says where they are');
  const fresh = JSON.parse(await readFile(join(folder, ...pieces.split('/'), '样卡世界书.json'), 'utf8'));
  assert.ok(Object.values(fresh.entries).some((item: any) => item.content.includes('外貌：银发。')), 'the pieces it points at were written with this export, not left over from an earlier one');

  const book = await studio.exportLorebook(id);
  assert.equal(book.file, `${pieces}/样卡世界书.json`, 'the world book piece keeps the book name even when the file is already there, so SillyTavern imports it under the same name');
  assert.equal(book.report, undefined, 'a single piece has no report of its own');
});

test('card metadata can be confirmed on the assembly bench, and every piece can be exported at once', async t => {
  const { root, studio } = await setup(t);
  const file = join(root, 'sample-card.json');
  const card = sampleCardJson() as Record<string, any>;
  card.data.extensions.regex_scripts = [{ id: 'r1', scriptName: '正文美化', findRegex: '/<content>/', replaceString: '<div>$1</div>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }];
  card.data.extensions.tavern_helper = { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: 'import "mvu";', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: {} };
  await writeFile(file, JSON.stringify(card));
  const folder = join(root, 'cards', '单件卡2');
  const created = await studio.createFromFile({ name: '样卡', kind: 'original', folder, file });
  const id = created.card.projectId;

  const meta = await studio.readMeta(id);
  assert.equal(meta.name, '样卡');
  await studio.saveMeta(id, { ...meta, creator: '示例作者', version: 'v3', notes: '阶段四', tags: ['测试'] });
  const exported = await studio.exportCard(id);
  const written = JSON.parse(await readFile(join(folder, ...exported.file.split('/')), 'utf8'));
  assert.equal(written.data.creator, '示例作者');
  assert.equal(written.data.character_version, 'v3');
  assert.match(exported.file, /-v3-\d{8}\.json$/, 'the file name follows the confirmed version');

  const all = await studio.exportAllPieces(id);
  assert.match(all.folder, /^导出\/单件-v3-\d{8}$/);
  assert.deepEqual(all.files.map(item => item.split('/').at(-1)).sort(), ['样卡世界书.json', '正则-01-正文美化.json', '脚本-01-MVU.json'].sort());
  const regex = JSON.parse(await readFile(join(folder, ...all.files.find(item => item.includes('正则'))!.split('/')), 'utf8'));
  assert.equal(regex.replaceString, '<div>$1</div>', 'each piece is written exactly as SillyTavern takes it');

  const twice = await studio.exportAllPieces(id);
  assert.deepEqual(twice.files, all.files, 'exporting the pieces again the same day replaces them under the same names');
});

test('one regex piece exports and imports back, and the registration records it', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'cards', '单件卡');
  const created = await studio.create({ name: '单件卡', kind: 'original', folder });
  const piece = { id: 'r1', scriptName: '正文美化', findRegex: '/<content>/i', replaceString: '<div>正文</div>', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
  const file = join(root, 'regex.json');
  await writeFile(file, JSON.stringify(piece, null, 2));

  const imported = await studio.importPieceFile(created.card.projectId, file);
  assert.deepEqual({ kind: imported.kind, name: imported.name, replaced: imported.replaced }, { kind: 'regex', name: '01-正文美化', replaced: false });
  assert.equal(await readFile(join(folder, '正则/01-正文美化.html'), 'utf8'), '<div>正文</div>');

  const exported = await studio.exportPiece(created.card.projectId, 'regex', '01-正文美化');
  assert.match(exported.file, /^导出\/正则-01-正文美化-v1-\d{8}\.json$/);
  assert.equal(exported.entries, 1);
  assert.deepEqual(JSON.parse(await readFile(join(folder, ...exported.file.split('/')), 'utf8')), piece, 'what comes out is what went in');
  assert.deepEqual((await studio.listPieces(created.card.projectId)).map(item => `${item.kind}:${item.name}:${item.title}`), ['regex:01-正文美化:正文美化']);
  const registration = JSON.parse(await readFile(join(folder, '卡项目.json'), 'utf8'));
  assert.equal(registration.exports.at(-1).kind, 'regex');
  assert.equal(registration.exports.at(-1).entries, 1, 'a piece counts as one');

  await assert.rejects(() => studio.exportPiece(created.card.projectId, 'script', '没有这个'), /没有找到/);
});

test('the section AI gets uids and check results through tools, other tasks do not', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'cards', '工具卡');
  const { card: { projectId } } = await studio.create({ name: '工具卡', kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), ['# 设计书', '', '## 人物名单', '', '| 序号 | 人物 | 档位 | 状态 |', '| --- | --- | --- | --- |', ''].join('\n'));
  const conversation = await studio.startConversation({ projectId, sectionId: 'lore-rules', prompt: 'card-request:{"action":"new_component","board":"lore","section":"lore-rules","name":"战斗规则","keys":["战斗"]}' });
  await until(() => settled(harness, conversation.id), 'component tool');
  const reply = lastReply(harness, conversation.id);
  assert.ok(reply.startsWith('card:'), reply);
  const result = JSON.parse(reply.slice('card:'.length));
  assert.equal(result.uid, 0);
  assert.equal(result.paramsPath, '世界书/叙事规则/1-战斗规则.json');
  assert.ok((await stat(join(folder, '世界书/叙事规则/1-战斗规则.md'))).isFile());

  const checking = await studio.startConversation({ projectId, sectionId: 'lore-rules', prompt: 'card-request:{"action":"check"}' });
  await until(() => settled(harness, checking.id), 'check tool');
  const checkReply = lastReply(harness, checking.id);
  assert.ok(checkReply.startsWith('card:'), checkReply);
  const checked = JSON.parse(checkReply.slice('card:'.length));
  assert.equal(checked.stats.entries, 1);
  assert.equal(checked.stats.sections['lore-rules'], 1);
  assert.equal(checked.ok, true, 'a scaffolded entry passes the checks');
  assert.equal(checked.findings.some((item: { code: string }) => item.code === 'uid-unallocated'), false, 'the uid came from the application');

  await mkdir(join(root, 'plain'), { recursive: true });
  const project = await harness.addProject(join(root, 'plain'));
  const ordinary = await harness.createTask({ projectId: project.id, prompt: 'card-request:{"action":"check"}' });
  await until(() => settled(harness, ordinary.id), 'ordinary task');
  assert.match(lastReply(harness, ordinary.id), /card-error:.*制卡对话/);
});

test('the variable structure section turns 变量表.yaml into the variable files through a tool', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'cards', '变量卡');
  const { card: { projectId } } = await studio.create({ name: '变量卡', kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), ['# 设计书', '', '## 人物名单', '', '| 序号 | 人物 | 档位 | 状态 |', '| --- | --- | --- | --- |', ''].join('\n'));
  await writeFile(join(folder, '变量表.yaml'), SAMPLE_TABLE);
  const conversation = await studio.startConversation({ projectId, sectionId: 'script-schema', prompt: 'card-request:{"action":"sync_variables"}' });
  await until(() => settled(harness, conversation.id), 'sync tool');
  const reply = lastReply(harness, conversation.id);
  assert.ok(reply.startsWith('card:'), reply);
  const result = JSON.parse(reply.slice('card:'.length));
  assert.equal(result.sync.rows, 13);
  assert.ok(result.sync.created.some((path: string) => path.endsWith('ZOD.js')), JSON.stringify(result.sync.created));
  assert.equal(typeof result.check.ok, 'boolean');
  assert.ok((await stat(join(folder, '世界书', '变量', '1002-[initvar].md'))).isFile());
  assert.deepEqual((await studio.reload(projectId)).variableTable, { source: 'authored', rows: 13 });
  const table = await studio.readVariableTable(projectId);
  assert.equal(table.source, 'authored');
  assert.equal(table.rows.length, 13);
  assert.equal(table.stale, undefined, 'generated from the current table');
  assert.deepEqual(table.rows[2], { path: '/主角/生命', type: '数值 0–100', default: '100', owner: '模型', when: '受伤或恢复时', note: '' });
  const before = (await studio.reload(projectId)).updatedAt;
  await writeFile(join(folder, '变量表.yaml'), SAMPLE_TABLE.replace('上限: 12', '上限: 5'));
  await studio.syncVariables(projectId);
  assert.notEqual((await studio.reload(projectId)).updatedAt, before, 'a sync counts as an edit, so the brief re-reads');
});

test('the local preview runs the card regex over the format sample and hands each part over as its own document', async t => {
  const published: Array<{ owner: string; segments: PreviewSegment[] }> = [];
  const publishPreview = (owner: string, segments: PreviewSegment[]) => { published.push({ owner, segments }); return segments.map((_, index) => `test://${owner}/${index}`); };
  const { root, studio } = await setup(t, { publishPreview });
  const fence = '`'.repeat(3);
  const update = ['<UpdateVariable>', '<Analysis>天气没变</Analysis>', '<JSONPatch>[]</JSONPatch>', '</UpdateVariable>'].join('\n');
  const format = ['<customize_format>根标签 content</customize_format>', `${fence}示例输出`, '<content>雾从码头升起。「又是这种天气。」</content>', update, fence].join('\n');
  const entry = (id: number, comment: string, content: string, order: number, position: number) => ({ id, keys: [], secondary_keys: [], comment, content, constant: true, selective: true, insertion_order: order, enabled: true, position: 'before_char', use_regex: true, extensions: { position, depth: position === 4 ? 0 : 4 } });
  const regex = (id: string, scriptName: string, findRegex: string, replaceString: string) => ({ id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null });
  const file = join(root, 'preview-card.json');
  await writeFile(file, JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: '雾港档案', data: {
    name: '雾港档案', first_mes: '雾。', character_book: { name: '雾港档案世界书', entries: [entry(0, '正文格式', format, 0, 4), entry(1, '变量输出格式', `按下面的格式输出：\n${update.replace('天气没变', '体力减一')}`, 9995, 0)] },
    extensions: { regex_scripts: [
      regex('r1', '正文美化', String.raw`/<content>([\s\S]*?)<\/content>/is`, `${fence}html\n<!DOCTYPE html><html><body><div class="mist">$1</div></body></html>\n${fence}`),
      regex('r2', '变量更新', String.raw`/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi`, '<details class="cw-update"><summary>变量更新</summary><pre>$1</pre></details>'),
      regex('r3', '变量更新中', String.raw`/<UpdateVariable>(?![\s\S]*<\/UpdateVariable>)[\s\S]*$/g`, '<p class="cw-pending">变量更新中</p>'),
    ] },
  } }));
  const folder = join(root, 'cards', '预览卡');
  const id = (await studio.createFromFile({ name: '雾港档案', kind: 'original', folder, file })).card.projectId;

  const body = await studio.preview(id, 'body');
  assert.deepEqual(body.source, { from: 'sample', path: '世界书/正文格式/0-正文格式.md' });
  assert.equal(body.states.length, 1);
  assert.deepEqual(body.states[0].steps.map(step => [step.name, step.outcome]), [['正文美化', 'applied'], ['变量更新', 'applied'], ['变量更新中', 'no-match']]);
  assert.deepEqual(body.states[0].frames.map(frame => frame.kind), ['frontend', 'html']);
  assert.equal(body.states[0].frames[0].url, `test://${published.at(-1)!.owner}/0`, 'each part is served under the address the publisher gives it');
  const [document, receipt] = published.at(-1)!.segments;
  assert.match(document.sim ?? '', /cardwrightSim/, 'a front-end in the body preview runs inside the 模拟酒馆');
  assert.equal(receipt.sim, undefined, 'message text runs no card script, so it gets no sim');
  assert.equal(typeof body.variables, 'string');
  assert.ok(document.html.includes('<div class="mist">雾从码头升起。「又是这种天气。」</div>'), 'the body regex output, with the quotes left alone inside the document');
  assert.ok(receipt.html.includes('<details class="cw-update"><summary>变量更新</summary><pre>'), receipt.html);

  const updates = await studio.preview(id, 'update');
  assert.deepEqual(updates.states.map(state => [state.label, state.frames.length]), [['生成完成', 1], ['生成中', 1]]);
  assert.deepEqual(updates.states[1].steps.map(step => step.outcome), ['no-match', 'no-match', 'applied'], 'while streaming, only the pending receipt hits');
  assert.ok(published.at(-1)!.segments[0].html.includes('<p class="cw-pending">变量更新中</p>'));

  await writeFile(join(folder, '世界书/正文格式/0-正文格式.md'), format.replace(update, ''));
  const fallback = await studio.preview(id, 'update');
  assert.deepEqual(fallback.source, { from: 'variables', path: '世界书/变量/9995-变量输出格式.md' }, 'without one in the sample, the 变量 entries lend their update block');
  assert.ok(published.find(item => item.segments.some(segment => segment.html.includes('体力减一'))));

  await writeFile(join(folder, '世界书/变量/9995-变量输出格式.md'), '按格式输出。');
  const none = await studio.preview(id, 'update');
  assert.equal(none.states.length, 0);
  assert.match(none.notice ?? '', /世界书 · 变量/);

  await writeFile(join(folder, '世界书/正文格式/0-正文格式.md'), '没有示例。');
  const missing = await studio.preview(id, 'body');
  assert.equal(missing.states.length, 0);
  assert.match(missing.notice ?? '', /示例输出/);

  // A card may carry several format entries (Re0 has a full and a light one): the one with a sample is the one to show.
  await studio.newComponent(id, { board: 'lore', section: 'lore-format', name: '正文格式·轻量', order: 0, position: 4, depth: 0 });
  const light = (await readdir(join(folder, '世界书/正文格式'))).find(name => name.includes('轻量') && name.endsWith('.md'))!;
  await writeFile(join(folder, '世界书/正文格式', light), `${fence}示例输出\n<content>轻量版的示例。</content>\n${fence}`);
  const second = await studio.preview(id, 'body');
  assert.deepEqual(second.source, { from: 'sample', path: `世界书/正文格式/${light}` });
});

test('the preview shows a front-end written as a bare document the way the exported card renders it: in its own frame', async t => {
  const published: Array<{ owner: string; segments: PreviewSegment[] }> = [];
  const publishPreview = (owner: string, segments: PreviewSegment[]) => { published.push({ owner, segments }); return segments.map((_, index) => `test://${owner}/${index}`); };
  const { root, studio } = await setup(t, { publishPreview });
  const fence = '`'.repeat(3);
  const format = ['<customize_format>根标签 content</customize_format>', `${fence}示例输出`, '<content>雾从码头升起。</content>', fence].join('\n');
  const file = join(root, 'bare-card.json');
  await writeFile(file, JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: '雾港档案', data: {
    name: '雾港档案', first_mes: '雾。',
    character_book: { name: '雾港档案世界书', entries: [{ id: 0, keys: [], secondary_keys: [], comment: '正文格式', content: format, constant: true, selective: true, insertion_order: 0, enabled: true, position: 'before_char', use_regex: true, extensions: { position: 4, depth: 0 } }] },
    extensions: { regex_scripts: [{ id: 'r1', scriptName: '正文美化', findRegex: String.raw`/<content>([\s\S]*?)<\/content>/is`, replaceString: '<!DOCTYPE html>\n<html><body><div class="mist">$1</div><script>document.body.dataset.ran = "1";</script></body></html>', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }] },
  } }));
  const id = (await studio.createFromFile({ name: '雾港档案', kind: 'original', folder: join(root, 'cards', '裸文档'), file })).card.projectId;
  const body = await studio.preview(id, 'body');
  assert.deepEqual(body.states[0].frames.map(frame => frame.kind), ['frontend'], 'the app adds the fence, so 酒馆助手 makes it an iframe and its script runs');
  assert.ok(published.at(-1)!.segments[0].html.includes('<div class="mist">雾从码头升起。</div>'));
});

test('status and creation previews compile the sheets, carry the sample variables and the sim, and list the floating script', async t => {
  const published: Array<{ owner: string; segments: PreviewSegment[] }> = [];
  const publishPreview = (owner: string, segments: PreviewSegment[]) => { published.push({ owner, segments }); return segments.map((_, index) => `test://${owner}/${index}`); };
  const { root, studio } = await setup(t, { publishPreview });
  const { card: { projectId, path } } = await studio.create({ name: '雾港档案', kind: 'original', folder: join(root, 'cards', '骨架卡') });
  await writeFile(join(path, '变量表.yaml'), SAMPLE_TABLE);
  const status = await studio.newComponent(projectId, { board: 'regex', name: '状态栏', format: 'sheet' });
  await writeFile(join(path, status.bodyPath), STATUS_SHEET);
  const start = await studio.newComponent(projectId, { board: 'regex', name: '开局创角页', format: 'sheet' });
  await writeFile(join(path, start.bodyPath), START_SHEET);
  await writeFile(join(path, '开场白/00-开场.md'), '<start>入港</start>');

  const preview = await studio.preview(projectId, 'status');
  assert.equal(preview.kind, 'status'); assert.equal(preview.form, 'placeholder');
  assert.deepEqual(preview.source, { from: 'sheet', path: '正则/01-状态栏.yaml' });
  assert.equal(JSON.parse(preview.variables ?? '{}').主角.生命, 100, 'the table defaults stand in for [initvar]');
  assert.equal(preview.states.length, 1); assert.equal(preview.states[0].label, '初始变量'); assert.deepEqual(preview.states[0].steps, []);
  const segment = published.at(-1)!.segments[0];
  assert.equal(segment.kind, 'frontend');
  assert.match(segment.html, /CardwrightHost\.boot\(\)/);
  assert.match(segment.sim ?? '', /cardwrightSim/);
  assert.match(segment.sim ?? '', /"生命":100/);

  const creation = await studio.preview(projectId, 'start');
  assert.equal(creation.kind, 'start');
  const startSegment = published.at(-1)!.segments[0];
  assert.match(startSegment.html, /<textarea id="cw-source" hidden>入港<\/textarea>/, 'the greeting start block stands in for the capture');
  assert.ok(startSegment.sim);

  const checks = await studio.runChecks(projectId);
  assert.ok(checks.findings.some(item => item.code === 'status-form'), 'the service hands the skeleton to the checks');

  await writeFile(join(path, status.bodyPath), STATUS_SHEET.replace('形态: placeholder', '形态: header'));
  const header = await studio.preview(projectId, 'status');
  assert.equal(header.form, 'header');
  assert.match(header.notice ?? '', /正文美化/);

  await writeFile(join(path, status.bodyPath), STATUS_SHEET.replace('形态: placeholder', '形态: floating'));
  const floating = await studio.preview(projectId, 'status');
  assert.equal(floating.form, 'floating');
  assert.match(published.at(-1)!.segments[0].html, /CardwrightFloating\.mount/);
  const pieces = await studio.listPieces(projectId);
  const synthesized = pieces.find(piece => piece.synthesized);
  assert.equal(synthesized?.kind, 'script'); assert.equal(synthesized?.title, '状态栏·悬浮应用'); assert.equal(synthesized?.bodyPath, '正则/01-状态栏.yaml');
  const exported = await studio.exportPiece(projectId, 'script', synthesized!.name);
  assert.match(exported.file, /脚本-01-状态栏·悬浮应用/);

  const missing = await studio.preview(projectId, 'body');
  assert.ok(missing.notice, 'the body preview still explains itself when there is no format sample');
});

test('the tool makes a sheet when asked', async t => {
  const { root, studio, harness } = await setup(t);
  const { card: { projectId } } = await studio.create({ name: '工具卡', kind: 'original', folder: join(root, 'cards', '工具卡') });
  const task = { projectId, card: { sectionId: 'regex-status' } } as unknown as Task;
  const made = await studio.toolRequest(task, { action: 'new_component', board: 'regex', name: '状态栏', format: 'sheet' }) as { bodyPath: string };
  assert.equal(made.bodyPath, '正则/01-状态栏.yaml');
  void harness;
});

// Q11: one sentence → 影响清单 → 改动派单 → the run goes to the end without the user entering a section.
test('a 改动单 lists its 派单 as the 影响清单, not as dispatches; 照单开做 registers them in dependency order and runs them', async t => {
  const { root, harness, studio } = await setup(t);
  const folder = join(root, 'change');
  const { card: { projectId } } = await studio.create({ name: '雾港档案局', kind: 'original', folder });
  await writeFile(join(folder, '设计书.md'), '# 设计书 · 雾港档案局\n');
  const { change, task: started } = await studio.startChange(projectId, { kind: 'request', text: '创角页加自定义开局选项 CHANGE:impact' });
  assert.equal(change.status, 'draft');
  assert.deepEqual(task(harness, started.id).card, { sectionId: 'plan', mode: 'change', web: false, changeId: change.id });
  assert.ok(task(harness, started.id).messages[0].text.startsWith('【改动单】'));
  assert.ok(task(harness, started.id).title.startsWith('改动 · 创角页加自定义开局选项'));
  await until(() => card(harness).changes[0]?.items.length === 4, 'the impact list');
  assert.deepEqual(card(harness).dispatches, [], 'the change AI\'s 派单 wait for 照单开做');
  const items = card(harness).changes[0].items;
  assert.deepEqual(items.map(item => [item.sectionId, item.title]), [['greet', '改动 · 开场白提到自定义开局'], ['regex-start', '改动 · 加自定义选项'], ['script-schema', '改动 · 变量表加开局字段'], ['lore-vars', '改动 · 变量规则']]);
  assert.equal(card(harness).changes[0].taskId, started.id);
  await assert.rejects(studio.startConversation({ projectId, sectionId: 'plan', mode: 'change', prompt: '改点东西' }), /提改动/);

  await studio.removeChangeItem(projectId, change.id, items[0].id);
  await studio.confirmChange(projectId, change.id, { thinking: 'off', gatewayId: 'fixture', permission: 'edit', autoAnswer: false });
  const confirmed = card(harness);
  assert.deepEqual(confirmed.dispatches.map(item => [item.sectionId, item.title, item.status, item.changeId]), [
    ['script-schema', '改动 · 变量表加开局字段', 'todo', change.id], ['lore-vars', '改动 · 变量规则', 'todo', change.id], ['regex-start', '改动 · 加自定义选项', 'todo', change.id]]);
  assert.deepEqual(confirmed.changes[0].dispatchIds, confirmed.dispatches.map(item => item.id));
  assert.equal(confirmed.changes[0].status, 'running');
  await assert.rejects(studio.removeChangeItem(projectId, change.id, items[1].id), /照单开做/);

  await until(() => card(harness).changes[0].status === 'done', 'the change to run to the end', 30_000);
  assert.ok(task(harness, started.id).messages.some(message => message.role === 'user' && message.text.startsWith('照单开做。')), 'the change AI synced the design book before the run');
  assert.deepEqual(card(harness).dispatches.map(item => item.status), ['done', 'done', 'done']);
  const run = harness.snapshot().projects.find(project => project.id === projectId)?.cardRun;
  assert.equal(run?.scope, 'change');
  assert.equal(run?.changeId, change.id);
  assert.equal(run?.status, 'completed');
  assert.ok(run?.finalCheck, 'a change run ends with the assembly check');
});

test('a 改动单 on a card without a design book says so, and a single component is edited directly', async t => {
  const { root, harness, studio } = await setup(t);
  const { card: { projectId } } = await studio.create({ name: '汽灯与铜镜', kind: 'original', folder: join(root, 'direct') });
  const { change, task: started } = await studio.startChange(projectId, { kind: 'error', text: '创角页报错 CHANGE:direct' });
  assert.equal(change.noDesignBook, true);
  const first = task(harness, started.id).messages[0].text;
  assert.ok(first.startsWith('【报错】') && first.includes('（本卡没有设计书：以卡里现有的组件为准。）'), first);
  await until(() => card(harness).changes[0]?.status === 'done', 'the direct change');
  assert.deepEqual(card(harness).changes[0].direct, ['正则/创角页.json']);
  assert.deepEqual(card(harness).dispatches, []);
});
