import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSectionPrompt, readKnowledgeIndex } from '../src/core/card-studio/prompts.ts';

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
