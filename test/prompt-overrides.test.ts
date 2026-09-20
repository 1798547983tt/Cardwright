import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptOverrides } from '../src/core/card-studio/prompt-overrides.ts';
import { buildSectionPrompt } from '../src/core/card-studio/prompts.ts';
import { KICKOFF } from '../src/shared/card-studio/markers.ts';

const shipped = fileURLToPath(new URL('../card-studio', import.meta.url));

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-prompt-overrides-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'resources');
  await cp(join(shipped, 'prompts'), join(resources, 'prompts'), { recursive: true });
  const overrides = new PromptOverrides(join(root, 'data'), resources);
  return { root, resources, overrides };
}

test('the editable prompts are the section prompts, the board rules, the common rules and the kickoff lines', async t => {
  const { overrides } = await setup(t);
  const items = await overrides.list();
  const ids = items.map(item => item.id);
  for (const id of ['prompts/通用规则.md', 'prompts/世界书-通用.md', 'prompts/正则-通用.md', 'prompts/脚本-通用.md', 'prompts/世界书-人设.md', 'prompts/规划-从零开始制卡.md', 'kickoff/scratch', 'kickoff/refine']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some(id => id.startsWith('knowledge/') || id.startsWith('styles/')), 'the knowledge base and style presets are not editable here');
  assert.ok(items.every(item => !item.overridden && !item.stale));
  assert.equal((await overrides.read('kickoff/scratch')).defaultText, KICKOFF.scratch);
});

test('a saved override wins over the default until it is restored', async t => {
  const { resources, overrides } = await setup(t);
  await overrides.save('prompts/通用规则.md', '## 通用规则\n\n覆盖版：只说中文。');
  const item = await overrides.read('prompts/通用规则.md');
  assert.equal(item.overridden, true);
  assert.equal(item.text, '## 通用规则\n\n覆盖版：只说中文。');
  assert.match(item.defaultText, /以下规则适用于制卡工坊的每个分区/);
  const prompt = await buildSectionPrompt(resources, { sectionId: 'lore-people', cardName: '测试卡', cardKind: 'original', projectRoot: 'E:/cards/test' }, { read: relative => overrides.effective(relative) });
  assert.match(prompt, /覆盖版：只说中文/);
  assert.doesNotMatch(prompt, /以下规则适用于制卡工坊的每个分区/);
  await overrides.restore('prompts/通用规则.md');
  assert.equal((await overrides.read('prompts/通用规则.md')).overridden, false);
  assert.match(await buildSectionPrompt(resources, { sectionId: 'lore-people', cardName: '测试卡', cardKind: 'original', projectRoot: 'E:/cards/test' }, { read: relative => overrides.effective(relative) }), /以下规则适用于制卡工坊的每个分区/);
});

test('an override is flagged when a newer version changes the default it was based on', async t => {
  const { resources, overrides } = await setup(t);
  await overrides.save('prompts/世界书-人设.md', '改过的人设提示词');
  assert.equal((await overrides.read('prompts/世界书-人设.md')).stale, false);
  const path = join(resources, 'prompts', '世界书-人设.md');
  await writeFile(path, `${await readFile(path, 'utf8')}\n新版本加的一句。`);
  const item = await overrides.read('prompts/世界书-人设.md');
  assert.equal(item.stale, true);
  assert.equal(item.text, '改过的人设提示词', 'the override still wins');
  assert.ok((await overrides.list()).find(entry => entry.id === 'prompts/世界书-人设.md')?.stale);
});

test('the kickoff lines can be overridden too', async t => {
  const { overrides } = await setup(t);
  await overrides.save('kickoff/scratch', '【开始规划 · 从零开始】请先读资料索引。');
  assert.equal(await overrides.effective('kickoff/scratch'), '【开始规划 · 从零开始】请先读资料索引。');
  assert.equal(await overrides.effective('kickoff/refine'), KICKOFF.refine);
});

test('only known prompts can be written, and not empty', async t => {
  const { overrides } = await setup(t);
  await assert.rejects(overrides.save('knowledge/README.md', 'x'), /不能修改/);
  await assert.rejects(overrides.save('prompts/../../escape.md', 'x'), /不能修改/);
  await assert.rejects(overrides.save('prompts/通用规则.md', '   '), /不能为空/);
});
