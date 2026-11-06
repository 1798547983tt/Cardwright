import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMemberPrompt, buildSectionPrompt, readKnowledgeIndex } from '../src/core/card-studio/prompts.ts';
import { DEFAULT_CARD_OPTIMIZATION } from '../src/shared/card-studio/card-optimization.ts';
import { SECTION_IDS, targetOf } from '../src/shared/card-studio/boards.ts';
import { planDispatchBatch } from '../src/shared/card-studio/dispatch.ts';
import { squadDispatchPrompt } from '../src/shared/card-studio/squad.ts';

const resources = fileURLToPath(new URL('../card-studio', import.meta.url));
const card = { cardName: '西游·八十一难', cardKind: 'fan' as const, source: '西游记', projectRoot: 'E:\\Cards\\西游·八十一难' };

test('assembles the planning prompt for starting from scratch', async () => {
  const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'scratch' });
  for (const expected of ['# 制卡工坊 · 规划', '同人卡 · 《西游记》', card.projectRoot, resources, '## 通用规则', '# 规划 · 从零开始制卡', '```派单', '<!-- cardwright:accept-all -->', '## 人物名单']) assert.ok(prompt.includes(expected), expected);
  assert.ok(!prompt.includes('# 规划 · 完善优化卡'));
});

test('assembles the planning prompt for refining an imported card', async () => {
  const prompt = await buildSectionPrompt(resources, { ...card, cardKind: 'original', source: undefined, sectionId: 'plan', mode: 'refine' });
  assert.ok(prompt.includes('# 规划 · 完善优化卡'));
  assert.ok(prompt.includes('原创卡'));
  assert.ok(!prompt.includes('# 规划 · 从零开始制卡'));
});

test('reports missing built-in resources and lists the knowledge base', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'cardwright-card-prompts-'));
  try { await assert.rejects(buildSectionPrompt(empty, { ...card, sectionId: 'plan', mode: 'scratch' }), /内置提示词缺失/); }
  finally { await rm(empty, { recursive: true, force: true }); }
  const index = await readKnowledgeIndex(resources);
  assert.ok(index.includes('适用版本'));
  assert.ok(index.includes('00-卡项目与文件约定.md'));
});

test('world book sections get the common rules, the board rules and their own', async () => {
  const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' });
  for (const expected of ['# 制卡工坊 · 世界书 · 人设', '## 通用规则', '## 世界书通用规则', 'card_new_component', '# 世界书 · 人设', '人物模板', '出处索引']) assert.ok(prompt.includes(expected), expected);
  assert.ok(!prompt.includes('本分区的专用提示词尚未内置'));
});

test('the optimization switches the one-file rule for the two-file rule', async () => {
  const current = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' });
  const optimized = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' }, { optimization: { ...DEFAULT_CARD_OPTIMIZATION, maxWritesPerRound: 2 } });
  assert.match(current, /一次只写一个文件/);
  assert.doesNotMatch(current, /一轮最多写/);
  assert.match(optimized, /一轮最多写 2 个文件/);
  assert.doesNotMatch(optimized, /一次只写一个文件/);
  assert.doesNotMatch(optimized, /cardwright:batch-write/);
});

test('the section brief replaces the full read-first list only when it is on', async () => {
  const current = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' });
  const briefed = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' }, { optimization: { ...DEFAULT_CARD_OPTIMIZATION, sectionBrief: true } });
  assert.match(current, /每次开工先读/);
  assert.doesNotMatch(current, /cardwright:brief-read/);
  assert.match(briefed, /先读派单里附的「本次派单摘要」和参考行/);
  assert.doesNotMatch(briefed, /每次开工先读/);
  assert.doesNotMatch(briefed, /cardwright:brief-read/);
});

test('a prompt override without the batch markers keeps its own rule', async () => {
  const read = async (relative: string) => relative === 'prompts/通用规则.md'
    ? '## 通用规则\n\n- 用户自己的单文件规则。'
    : readFile(join(resources, ...relative.split('/')), 'utf8');
  const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' }, { read, optimization: DEFAULT_CARD_OPTIMIZATION });
  assert.match(prompt, /用户自己的单文件规则/);
  assert.doesNotMatch(prompt, /一轮最多写/);
});

// One-click making reads these lines to tell a question or a refusal from a delivery.
test('every section is told to end a question round and a refusal with their markers', async () => {
  for (const sectionId of ['lore-people', 'script-schema', 'regex-body', 'greet']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(prompt.includes('<!-- cardwright:accept-all -->'), sectionId);
    assert.ok(prompt.includes('<!-- cardwright:refuse -->'), sectionId);
  }
});

test('every world book section has its own built-in prompt', async () => {
  for (const sectionId of ['lore-rules', 'lore-overview', 'lore-setting', 'lore-people', 'lore-plot', 'lore-vars', 'lore-format']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(!prompt.includes('本分区的专用提示词尚未内置'), sectionId);
    assert.ok(prompt.includes('## 世界书通用规则'), sectionId);
    assert.ok(prompt.includes('## 自检'), sectionId);
  }
});

test('every script section gets the script board rules, its own prompt and the error loop', async () => {
  for (const sectionId of ['script-schema', 'script-controller', 'script-mechanism']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(!prompt.includes('本分区的专用提示词尚未内置'), sectionId);
    assert.ok(prompt.includes('## 脚本通用规则'), sectionId);
    assert.ok(prompt.includes('## 自检'), sectionId);
    assert.ok(prompt.includes('## 报错回路'), sectionId);
    assert.ok(!prompt.includes('## 世界书通用规则'), sectionId);
  }
});

test('every regex section gets the regex board rules, its own prompt and the error loop', async () => {
  for (const sectionId of ['regex-update', 'regex-status', 'regex-body', 'regex-start']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(!prompt.includes('本分区的专用提示词尚未内置'), sectionId);
    assert.ok(prompt.includes('## 正则通用规则'), sectionId);
    assert.ok(prompt.includes('## 自检'), sectionId);
    assert.ok(prompt.includes('## 报错回路'), sectionId);
  }
  const body = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-body' });
  assert.ok(body.includes('示例输出'), 'the body regex works against the sample the format section wrote');
  const start = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-start' });
  assert.ok(start.includes('聊天世界书'), 'the start page writes the player into the chat world book');
  assert.ok(start.includes('不收集 API Key'), 'and is told never to ask for a key');
});

test('the greeting section has its own prompt', async () => {
  const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'greet' });
  assert.ok(prompt.includes('# 开场白'), 'greet');
  assert.ok(!prompt.includes('本分区的专用提示词尚未内置'));
  assert.ok(prompt.includes('<start>'), 'the creation greeting carries the start block');
});

test('sections without a built-in prompt still say so', async () => {
  const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'build' });
  assert.ok(prompt.includes('本分区的专用提示词尚未内置'));
  assert.ok(!prompt.includes('## 世界书通用规则'), 'the board rules belong to the world book board only');
});

test('regex sections get the card preset and the token names; other boards do not', async () => {
  const status = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-status', stylePreset: { id: 'washi', name: '和纸' } });
  assert.ok(status.includes('## 本卡的风格预设与前端骨架'));
  assert.ok(status.includes('预设：和纸（washi）'));
  for (const token of ['--bg', '--panel', '--text-3', '--accent-2', '--danger']) assert.ok(status.includes(token), token);
  assert.ok(status.includes('frontend/blocks/词汇.md'));
  assert.ok(status.includes('装配单'));
  const custom = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-body', stylePreset: { id: 'custom', name: '题材自定' } });
  assert.ok(custom.includes('令牌:') && custom.includes('设计书'), 'a custom preset tells the section to copy the tokens from the design book');
  const none = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-start', stylePreset: null });
  assert.ok(none.includes('还没有定风格预设'));
  const lore = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people', stylePreset: { id: 'washi', name: '和纸' } });
  assert.ok(!lore.includes('## 本卡的风格预设与前端骨架'));
});

test('the regex prompts ask for sheets and name the new checks', async () => {
  const shared = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-status', stylePreset: null });
  for (const expected of ['.yaml', "format: 'sheet'", 'sheet-invalid', 'variable-binding', 'status-form', 'frontend-external', 'regex-dialect', 'regex-backtrack', '形态']) assert.ok(shared.includes(expected), expected);
  const body = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-body', stylePreset: null });
  assert.ok(body.includes('状态头') && body.includes('模块'));
  const start = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-start', stylePreset: null });
  assert.ok(start.includes('自定义开局') && start.includes('将写入'));
  const plan = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'scratch' });
  assert.ok(plan.includes('状态栏形态'));
  assert.ok(plan.includes('正则/正文美化 → 正则/状态栏') || plan.includes('正文美化 → 状态栏'), 'the body beautifier is dispatched before the status bar, since the default form rides inside it');
});

// ADR 0022: one identity per request. The system prompt says who; the studio prompt says what this conversation is for.
test('the planning prompts say what this conversation is responsible for, with no second identity', async () => {
  const scratch = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'scratch' });
  const refine = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'refine' });
  const change = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'change' });
  assert.ok(scratch.includes('你这次负责制卡工坊的规划。你只做两件事：'));
  assert.ok(refine.includes('你这次负责制卡工坊的规划，改进一张导入的角色卡。你只做四件事：'));
  assert.ok(change.includes('你这次负责制卡工坊的改动单。用户用一句话提出一处修改'));
  for (const prompt of [scratch, refine, change]) assert.ok(!prompt.includes('你是制卡工坊'), prompt.slice(0, 80));
});

test('a squad member is told its duty, not given a second identity', async () => {
  const reader = await buildMemberPrompt(resources, { ...card, sectionId: 'plan', mode: 'scratch', role: 'researcher', files: [], create: [] });
  const writer = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'writer', files: [], create: ['黄袍怪'] });
  assert.ok(reader.includes('你这次负责查资料。'));
  assert.ok(writer.includes('你这次负责写组件。'));
  for (const prompt of [reader, writer]) assert.ok(!prompt.includes('你是'), prompt.slice(0, 80));
});

test('a 查资料 member gets its own prompt and nothing of the section', async () => {
  const prompt = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'researcher', files: [], create: [] });
  for (const expected of ['# 制卡工坊 · 世界书 · 人设 · 小队成员', '你这次负责查资料', '资料未提及', card.projectRoot, '（只读）']) assert.ok(prompt.includes(expected), expected);
  assert.ok(!prompt.includes('## 通用规则'));
  assert.ok(!prompt.includes('## 分给你的组件'));
});

test('a 写组件 member gets its prompt, the components it was given, then the section rules', async () => {
  const prompt = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'writer', files: ['世界书/人设/120-红孩儿.md'], create: ['黄袍怪'] });
  const order = ['你这次负责写组件', '## 分给你的组件', '`世界书/人设/120-红孩儿.md`', '「黄袍怪」', '## 通用规则', '## 世界书通用规则', '# 世界书 · 人设'].map(text => prompt.indexOf(text));
  assert.ok(order.every(index => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
});

test('a 写组件 sent again is told which components it already created', async () => {
  const fresh = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'writer', files: [], create: ['黄袍怪'] });
  assert.ok(!fresh.includes('已经新建好的组件'));
  const again = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'writer', files: [], create: ['黄袍怪'], created: [{ name: '黄袍怪', paths: ['世界书/人设/130-黄袍怪.md', '世界书/人设/130-黄袍怪.json'] }] });
  assert.ok(again.includes('已经新建好的组件（直接改它们的文件）：「黄袍怪」`世界书/人设/130-黄袍怪.md`、`世界书/人设/130-黄袍怪.json`'), again.slice(again.indexOf('## 分给你的组件'), again.indexOf('## 分给你的组件') + 300));
});

test('the shipped 派发 rules have both 自行组队 variants, the tools and the incomplete marker', async () => {
  const text = await readFile(join(resources, 'prompts', '小队-派发.md'), 'utf8');
  const on = squadDispatchPrompt(text, { selfDispatch: true });
  const off = squadDispatchPrompt(text, { selfDispatch: false });
  assert.match(on, /3 个以上、彼此不依赖的组件/); assert.match(on, /超过 10 章/); assert.doesNotMatch(on, /只有用户在消息里明确要求/);
  assert.match(off, /只有用户在消息里明确要求时才派小队/); assert.doesNotMatch(off, /3 个以上/);
  for (const variant of [on, off]) {
    assert.doesNotMatch(variant, /自行组队：/);
    for (const expected of ['dispatch_member', 'dispatch_team', 'member_result', '`files`', '`create`', '<!-- cardwright:incomplete -->']) assert.ok(variant.includes(expected), expected);
  }
});

test('people and plot write one item a reply alone, and one item a 写组件 member', async () => {
  const people = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' });
  assert.ok(people.includes('**自己写时，一次回复只写一个人物**'));
  assert.ok(people.includes('**派了「写组件」时，一个成员只写一个人物**'));
  const plot = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-plot' });
  assert.ok(plot.includes('**自己写时，一次回复只写一条剧情**'));
  assert.ok(plot.includes('**派了「写组件」时，一个成员只写一条剧情**'));
  const rules = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-rules' });
  assert.ok(!rules.includes('不启用小队'));
  assert.ok(rules.includes('能不能派小队，看提示词最后有没有「小队」一节'));
});

// 分批写 (ADR 0024): a relay that cuts a long reply off loses less when each request writes one file, and one-click
// making reads the continue marker to carry an unfinished dispatch on.
test('every section writes one file per request and marks a dispatch it has not finished', async () => {
  for (const sectionId of ['lore-rules', 'lore-people', 'lore-plot', 'lore-setting', 'script-schema', 'script-mechanism', 'regex-body', 'greet']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(prompt.includes('### 分批写'), sectionId);
    assert.ok(prompt.includes('同一条消息里最多调用一次 `write` 或 `edit`'), sectionId);
    assert.ok(prompt.includes('<!-- cardwright:continue -->'), sectionId);
  }
  const people = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-people' });
  assert.ok(people.includes('人物条目写完后，再一个一个更新共享文件'));
  assert.ok(people.includes('N 小于 M 时，回复最后一行单独写 `<!-- cardwright:continue -->`'));
  const plot = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-plot' });
  assert.ok(plot.includes('剧情条目写完后，再一个一个更新共享文件'));
  assert.ok(!plot.includes('是否建议换对话'), 'the app, not the AI, proposes a new conversation');
  const setting = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-setting' });
  assert.ok(setting.includes('清单还没写完时，交付回复最后一行单独写 `<!-- cardwright:continue -->`'));
  const schema = await buildSectionPrompt(resources, { ...card, sectionId: 'script-schema' });
  assert.ok(schema.includes('再用 `edit` 每次在末尾接上一个顶层容器'));
  const mechanism = await buildSectionPrompt(resources, { ...card, sectionId: 'script-mechanism' });
  assert.ok(mechanism.includes('要写几个脚本时一个一个来'));
  const status = await buildSectionPrompt(resources, { ...card, sectionId: 'regex-status', stylePreset: null });
  assert.ok(status.includes('文件长时分几次写'));
});

// A reply with no marker and no writes is a delivery to one-click making, which marks the dispatch done: a list put to the user for confirmation must not end a round that way.
test('the sections that open with a list for confirmation do not end a one-click round on the list', async () => {
  const rules = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-rules' });
  assert.ok(rules.includes('一键制作里，收到派单就是确认：列出清单后，同一轮直接往下写，不要停下来等用户回复。'));
  assert.ok(!rules.includes('一次回复只列清单不写正文'), 'no rule left that ends a round on the list');
  // 设定 and 地点总览 put an outline to the user first; the round that only lists it is not a delivery, so it carries the continue marker, and a hand-run conversation still waits.
  for (const sectionId of ['lore-setting', 'lore-overview']) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId });
    assert.ok(prompt.includes('只列了清单、还没写条目的这一轮，也算没做完：回复最后一行单独写 `<!-- cardwright:continue -->`'), sectionId);
    assert.ok(prompt.includes('手动对话里照常等用户确认清单'), sectionId);
  }
  // The next round then writes the entry: the app's 继续 message is the confirmation, as it is for the people and plot sections.
  const overview = await buildSectionPrompt(resources, { ...card, sectionId: 'lore-overview' });
  assert.ok(overview.includes('一键制作里，收到「继续做这条派单」就是确认'));
});

// The common rules reach a 写组件 member as well (§6.4): the paragraph on the continue marker says the marker is the lead's.
test('a 写组件 member is told the continue marker is not its to write', async () => {
  const prompt = await buildMemberPrompt(resources, { ...card, sectionId: 'lore-people', role: 'writer', files: [], create: ['黄袍怪'] });
  assert.ok(prompt.includes('小队成员不写这一行，没做完的写进交回结果'));
  // The section's own 交付 paragraphs say "write this line when N is less than M"; the member's own rules say that is the lead's call.
  assert.ok(prompt.includes('不写 `<!-- cardwright:continue -->`、`<!-- cardwright:incomplete -->` 这类标记行：做没做完、有没有缺口由主 AI 判断'));
});

test('the knowledge base describes how dispatches are registered and the four reply markers', async () => {
  const text = await readFile(join(resources, 'knowledge', '00-卡项目与文件约定.md'), 'utf8');
  for (const expected of ['card_add_dispatches', '<!-- cardwright:accept-all -->', '<!-- cardwright:refuse -->', '<!-- cardwright:incomplete -->', '<!-- cardwright:continue -->']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('规划 AI 在回复里输出派单，应用解析后登记'), 'planning registers by tool; a 派单 block in a reply still works but is no longer the way');
  assert.ok(text.includes('回复里的派单块'), 'the old way is named as still read');
});

// 分批写 (ADR 0024): the design book first, then the dispatches a board at a time through the tool; the last reply only sums up.
test('planning registers its dispatches through card_add_dispatches, a board at a time', async () => {
  for (const mode of ['scratch', 'refine'] as const) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode });
    assert.ok(prompt.includes('用 `card_add_dispatches` 工具分批登记派单'), mode);
    assert.ok(prompt.includes('每次只放同一个板块里挨着的几条（最多 12 条）'), mode);
    assert.ok(prompt.includes('不要把派单正文再写一遍'), mode);
    // The order they are registered in is the order one-click making sends them in; a model that calls the tool twice in one message could not tell which came first.
    assert.ok(prompt.includes('一条消息只登记一次，看到结果再登记下一批。'), mode);
    assert.ok(!prompt.includes('在同一条回复里按顺序给出全部派单'), mode);
    assert.ok(!prompt.includes('点第一条派单上的【去这个分区】'), mode);
  }
  const change = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode: 'change' });
  assert.ok(!change.includes('card_add_dispatches'), 'the change AI still answers with 派单 blocks: they are its 影响清单');
  assert.ok(change.includes('```派单'));
});

// card_add_dispatches turns away a target it cannot send to, and both planning prompts spell the targets out: they must name exactly the sections a dispatch can go to.
test('the targets the planning prompts name are the sections card_add_dispatches takes', async () => {
  const takes = (target: string) => planDispatchBatch([], [{ target, title: '标题', body: '正文' }]).results[0].ok;
  const targets = SECTION_IDS.map(targetOf).filter(takes);
  assert.ok(targets.length >= 16, targets.join('、'));
  for (const mode of ['scratch', 'refine'] as const) {
    const prompt = await buildSectionPrompt(resources, { ...card, sectionId: 'plan', mode });
    for (const target of targets) assert.ok(prompt.includes(`\`${target}\``), `${mode} names ${target}`);
    for (const match of prompt.matchAll(/`((?:世界书|脚本|正则)\/[^`]+)`/g)) assert.ok(takes(match[1]), `${mode} names ${match[1]}, which the tool turns away`);
  }
});
