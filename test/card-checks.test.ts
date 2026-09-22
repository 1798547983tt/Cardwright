import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importCard } from '../src/core/card-studio/components.ts';
import { runChecks } from '../src/core/card-studio/checks.ts';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RE0_CARD } from './reference-cards.ts';

const entry = (id: number, comment: string, content: string, over: Record<string, unknown> = {}, extensions: Record<string, unknown> = {}) => ({
  id, keys: [], secondary_keys: [], comment, content, constant: true, selective: true, insertion_order: 10, enabled: true,
  position: 'before_char', use_regex: true, extensions: { position: 0, depth: 4, display_index: id, exclude_recursion: true, prevent_recursion: true, probability: 100, useProbability: true, ...extensions },
  ...over,
});

const card = (entries: Array<ReturnType<typeof entry>>) => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡',
  data: { name: '样卡', first_mes: '开场', character_book: { name: '样卡世界书', entries }, extensions: { world: '样卡世界书' } },
});

async function project(entries: Array<ReturnType<typeof entry>>): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-checks-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  await importCard(root, card(entries));
  return root;
}
const clean = (root: string) => rm(join(root, '..'), { recursive: true, force: true });
const codes = (findings: Array<{ code: string }>) => [...new Set(findings.map(item => item.code))].sort();

test('a wrapper tag written the wrong way round is an error', async () => {
  const root = await project([
    entry(1, '人物总览', '</人物总览>\n昴｜男｜主角\n</人物总览>'),
    entry(2, '地点总览', '<地点总览>\n王都｜城市｜首都\n</地点总览>'),
  ]);
  const report = await runChecks(root);
  const tag = report.findings.filter(item => item.code === 'wrap-tag');
  assert.equal(tag.length, 1);
  assert.equal(tag[0].level, 'error');
  assert.equal(tag[0].uid, 1);
  assert.match(tag[0].message, /人物总览/);
  assert.equal(report.ok, false, 'errors block the export');
  await clean(root);
});

test('a body that never closes its wrapper is an error too', async () => {
  const root = await project([entry(1, '王都', '<王都>\n城。')]);
  const report = await runChecks(root);
  assert.equal(report.findings.filter(item => item.code === 'wrap-tag' && item.level === 'error').length, 1);
  await clean(root);
});

test('keyword counts and collisions are warnings', async () => {
  const root = await project([
    entry(1, '爱蜜莉雅', '<爱蜜莉雅>\n人。\n</爱蜜莉雅>', { keys: ['爱蜜莉雅', '九神将', '艾米', '爱米', '艾蜜', '莉雅'], constant: false, insertion_order: 100 }),
    entry(2, '莱茵哈鲁特', '<莱茵哈鲁特>\n人。\n</莱茵哈鲁特>', { keys: ['莱茵哈鲁特', '九神将'], constant: false, insertion_order: 100 }),
    entry(3, '王都', '<王都>\n城。\n</王都>', { keys: ['王都', '露格尼卡', '首都', '王城'], constant: false, insertion_order: 52 }),
  ]);
  const report = await runChecks(root);
  const counts = report.findings.filter(item => item.code === 'key-count');
  assert.deepEqual(counts.map(item => item.uid).sort(), [1, 3], 'six keys on a person and four on a setting are both out of range');
  const collision = report.findings.find(item => item.code === 'key-collision');
  assert.equal(collision?.level, 'warning');
  assert.match(collision!.message, /九神将/);
  assert.equal(report.ok, true, 'warnings do not block the export');
  await clean(root);
});

test('character entries are matched against the template and the source index', async () => {
  const root = await project([entry(1, '爱蜜莉雅', '<爱蜜莉雅>\n姓名：爱蜜莉雅\n外貌：银发。\n</爱蜜莉雅>', { keys: ['爱蜜莉雅'], constant: false, insertion_order: 100 })]);
  await writeFile(join(root, '世界书/人设/人物模板.md'), ['# 人物模板', '', '## 字段清单', '', '- 姓名：本名', '- 外貌：外形描写', '- 行为指导：日常与压力下的反应', ''].join('\n'));
  await writeFile(join(root, '世界书/人设/出处索引.md'), ['# 出处索引', '', '| uid | 人物 | 分章 | 章节 | 锚点 | 缺口 |', '| --- | --- | --- | --- | --- | --- |', '| 9 | 别人 | 资料/分章/x/0001.txt | 第一章 | 原文 | 无 |', ''].join('\n'));
  const report = await runChecks(root);
  const missing = report.findings.find(item => item.code === 'template-field');
  assert.equal(missing?.level, 'warning');
  assert.match(missing!.message, /行为指导/);
  const source = report.findings.find(item => item.code === 'source-index');
  assert.equal(source?.uid, 1);
  await clean(root);
});

test('plot entries are matched against the title index', async () => {
  const root = await project([
    entry(1, '标题剧情索引', '<标题剧情索引>\n第01卷｜王都的开始：魔女历1000年01月01日\n</标题剧情索引>', { insertion_order: 15 }),
    entry(2, '第01卷｜王都的开始', '<第01卷｜王都的开始>\n【事件01】开始\n</第01卷｜王都的开始>', { keys: ['第01卷｜王都的开始', '魔女历1000年01月01日'], constant: false, insertion_order: 300, position: 'after_char' }, { position: 4 }),
    entry(3, '第02卷｜宅邸', '<第02卷｜宅邸>\n【事件01】到达\n</第02卷｜宅邸>', { keys: ['第02卷｜宅邸'], constant: false, insertion_order: 301, position: 'after_char' }, { position: 4 }),
  ]);
  const report = await runChecks(root);
  const index = report.findings.filter(item => item.code === 'plot-index');
  assert.deepEqual(index.map(item => item.uid), [3], 'the second volume is missing from the title index');
  const dates = report.findings.filter(item => item.code === 'plot-date');
  assert.deepEqual(dates.map(item => item.uid), [3], 'a plot entry without a full date keyword is flagged');
  await clean(root);
});

test('the report counts entries and estimates the always-on budget', async () => {
  const root = await project([
    entry(1, '叙事基调', `<叙事基调>\n${'必须保持克制。'.repeat(20)}\n</叙事基调>`, { insertion_order: 2 }),
    entry(2, '爱蜜莉雅', '<爱蜜莉雅>\n人。\n</爱蜜莉雅>', { keys: ['爱蜜莉雅'], constant: false, insertion_order: 100 }),
  ]);
  const report = await runChecks(root);
  assert.equal(report.stats.entries, 2);
  assert.equal(report.stats.sections['lore-rules'], 1);
  assert.equal(report.stats.sections['lore-people'], 1);
  assert.ok(report.stats.constantChars > 100);
  assert.ok(report.stats.constantTokens > 50);
  assert.ok(report.findings.some(item => item.code === 'budget' && item.level === 'info'));
  await clean(root);
});

test('entries no section takes are counted as 未分类 and reported as information that does not block the export', async () => {
  const root = await project([
    entry(1, '地点总览', '<地点总览>\n王都｜城市｜首都\n</地点总览>'),
    entry(2, '杂项·二百', '排序 200、位置 0 的条目。', { insertion_order: 200 }),
    entry(3, '杂项·一百', '排序 100、位置 4 的条目。', { insertion_order: 100, position: 'after_char' }, { position: 4 }),
  ]);
  const report = await runChecks(root);
  assert.equal(report.stats.sections['lore-other'], 2);
  assert.equal(report.stats.sections['lore-overview'], 1);
  const unclassified = report.findings.filter(item => item.code === 'lore-unclassified');
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0].level, 'info');
  assert.equal(unclassified[0].message, '有 2 条世界书条目没有归入任何分区（世界书/未分类），会照常导出。');
  assert.equal(report.ok, true, 'information never blocks the export');
  await clean(root);
});

test('a card whose entries all have a section gets no 未分类 note', async () => {
  const root = await project([entry(1, '地点总览', '<地点总览>\n王都｜城市｜首都\n</地点总览>')]);
  const report = await runChecks(root);
  assert.equal(report.stats.sections['lore-other'], undefined);
  assert.ok(!report.findings.some(item => item.code === 'lore-unclassified'));
  await clean(root);
});

test('a uid the application never handed out is an error', async () => {
  const root = await project([entry(1, '王都', '<王都>\n城。\n</王都>')]);
  await writeFile(join(root, '世界书/总览/10-王都.json'), JSON.stringify({ uid: 999, key: [], comment: '王都', constant: true, order: 10, position: 0 }));
  const report = await runChecks(root);
  const finding = report.findings.find(item => item.code === 'uid-unallocated');
  assert.equal(finding?.level, 'error');
  assert.equal(finding?.uid, 999);
  await clean(root);
});

test('broken component files come through as errors', async () => {
  const root = await project([entry(1, '王都', '<王都>\n城。\n</王都>')]);
  await writeFile(join(root, '世界书/设定/20-坏的.json'), '{ 坏');
  const report = await runChecks(root);
  assert.ok(codes(report.findings).includes('params-parse'));
  assert.equal(report.ok, false);
  await clean(root);
});

test('a clean project passes with only information', async () => {
  const root = await project([
    entry(1, '叙事基调', '<叙事基调>\n必须保持克制。\n</叙事基调>', { insertion_order: 2 }),
    entry(2, '爱蜜莉雅', '<爱蜜莉雅>\n姓名：爱蜜莉雅\n</爱蜜莉雅>', { keys: ['爱蜜莉雅', '艾米莉亚'], constant: false, insertion_order: 100 }),
  ]);
  await writeFile(join(root, '世界书/人设/出处索引.md'), ['| uid | 人物 | 分章 | 章节 | 锚点 | 缺口 |', '| --- | --- | --- | --- | --- | --- |', '| 2 | 爱蜜莉雅 | 资料/分章/x/0001.txt | 第一章 | 原文 | 无 |'].join('\n'));
  const report = await runChecks(root);
  assert.deepEqual(report.findings.filter(item => item.level !== 'info').map(item => `${item.code}:${item.message}`), []);
  assert.equal(report.ok, true);
  await clean(root);
});

test('the known problems of the Re0 card are found', { skip: existsSync(RE0_CARD) ? false : 'reference card not available' }, async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-checks-re0-')), '卡项目');
  await createCardFolder({ folder: root, name: 'Re0', kind: 'fan', source: 'Re:从零开始的异世界生活', random: () => 0 });
  await importCard(root, JSON.parse(readFileSync(RE0_CARD, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>);
  const report = await runChecks(root);
  const wrap = report.findings.filter(item => item.code === 'wrap-tag');
  assert.ok(wrap.some(item => item.message.includes('人物总览')), '人物总览 opens with a closing tag');
  const collision = report.findings.find(item => item.code === 'key-collision' && item.message.includes('九神将'));
  assert.equal(collision?.level, 'warning');
  assert.equal(report.stats.entries, 290);
  assert.ok(report.stats.constantTokens > 1000);
  assert.equal(report.findings.some(item => item.code === 'key-collision' && /魔女历\d+年/.test(item.message)), false, 'plot entries may share the dates they cover');
  await clean(root);
});

const NL = String.fromCharCode(10);
const sandboxEntry = fileURLToPath(new URL('../src/core/card-studio/sandbox-entry.ts', import.meta.url));
const sandbox = { entry: sandboxEntry, execArgv: ['--import', 'tsx'] };
const FIXED_VARIABLE_LIST = ['---', '<status_current_variables>', '{{format_message_variable::stat_data}}', '</status_current_variables>'].join(NL);
const zodScript = [
  'const percent = (fallback = 0) => z.coerce.number().catch(fallback).transform(value => _.clamp(value, 0, 100)).prefault(fallback);',
  'export const Schema = z.object({ 主角: z.object({ 姓名: z.string().prefault("未知"), 生命: percent(100) }).prefault({}) });',
  '$(() => { registerMvuSchema(Schema); });',
].join(NL);
const formatEntry = ['<customize_format>', '根标签 content', '</customize_format>', '', '```示例输出', '<content>', '<time>雾港历1年01月01日</time>', '主角「走吧。」', '</content>', '```'].join(NL);

const fullCard = (over: { regex?: unknown[]; scripts?: unknown[]; greetings?: string[]; initvar?: string; rules?: string; rulesName?: string } = {}) => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡',
  data: {
    name: '样卡', first_mes: over.greetings?.[0] ?? ['<content>', '<time>雾港历1年01月01日</time>', '</content>'].join(NL),
    alternate_greetings: over.greetings?.slice(1) ?? [],
    character_book: { name: '样卡世界书', entries: [
      entry(0, '正文格式', formatEntry, { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 }),
      entry(1, '[initvar] 初始', over.initvar ?? ['主角:', '  姓名: 林砚', '  生命: 90'].join(NL), { insertion_order: 1002 }),
      entry(2, '变量列表', FIXED_VARIABLE_LIST, { insertion_order: 9994 }),
      entry(3, over.rulesName ?? '变量规则', over.rules ?? ['总则：只按已发生的事实更新。', 'replace /主角/生命', 'replace /主角/不存在的字段'].join(NL), { insertion_order: 9995 }),
    ] },
    extensions: {
      world: '样卡世界书',
      regex_scripts: over.regex ?? [{ id: 'r1', scriptName: '正文美化', findRegex: String.raw`/<content>([\s\S]*?)<\/content>/is`, replaceString: '<div>$1</div>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: 0, maxDepth: null }],
      tavern_helper: { scripts: over.scripts ?? [{ type: 'script', enabled: true, name: 'ZOD', id: 's1', content: zodScript, info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: {} },
    },
  },
});

async function fullProject(over: Parameters<typeof fullCard>[0] = {}): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-checks-full-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  await importCard(root, fullCard(over));
  return root;
}

test('the initial variables are validated with the card own schema in the sandbox', async () => {
  const root = await fullProject();
  const report = await runChecks(root, { sandbox });
  assert.ok(report.findings.some(item => item.code === 'initvar-ok' && item.level === 'info'), JSON.stringify(report.findings.filter(i => i.code.startsWith('initvar'))));
  const path = report.findings.find(item => item.code === 'variable-path');
  assert.equal(path?.level, 'warning');
  assert.match(path!.message, /不存在的字段/);
  await clean(root);
});

test('a path in Chinese prose ends at full-width punctuation', async () => {
  const root = await fullProject({ rules: ['- /主角/生命：受伤后更新。', '- 先看 /主角/生命，再看 /主角/不存在的字段。', '（/主角/生命）'].join(NL) });
  const report = await runChecks(root, { sandbox });
  const paths = report.findings.filter(item => item.code === 'variable-path').map(item => item.message);
  assert.equal(paths.length, 1, JSON.stringify(paths));
  assert.match(paths[0], /\/主角\/不存在的字段 在变量结构里不存在/);
  await clean(root);
});

test('rule entries named the way MVU cards name them are checked too', async () => {
  for (const rulesName of ['[mvu_update]变量更新规则', '变量更新规则', '[mvu_update]变量输出格式']) {
    const root = await fullProject({ rulesName });
    const report = await runChecks(root, { sandbox });
    assert.ok(report.findings.some(item => item.code === 'variable-path' && item.message.includes('不存在的字段')), rulesName);
    await clean(root);
  }
});

test('a placeholder segment stands for any key of a record that exists', async () => {
  const rules = ['- /主角/{字段}：任意字段', '- /主角/<键>/子项', '- /主角/-', '- /主角/*', '- /不存在的容器/{键}'].join(NL);
  const root = await fullProject({ rules });
  const report = await runChecks(root, { sandbox });
  const paths = report.findings.filter(item => item.code === 'variable-path').map(item => item.message);
  assert.deepEqual(paths.map(message => /路径 (\S+) 在/.exec(message)?.[1]), ['/不存在的容器/{键}'], 'only the container that does not exist is reported');
  await clean(root);
});

test('initial variables the schema rejects are errors', async () => {
  const root = await fullProject({ initvar: ['主角:', '  姓名:', '    嵌套: 不对'].join(NL) });
  const report = await runChecks(root, { sandbox });
  const bad = report.findings.filter(item => item.code === 'initvar-invalid');
  assert.equal(bad[0]?.level, 'error');
  assert.equal(report.ok, false);
  await clean(root);
});

test('regex components are compiled and tried against the sample output', async () => {
  const root = await fullProject({ regex: [
    { id: 'r1', scriptName: '坏正则', findRegex: '/(未闭合/g', replaceString: '', placement: [2], markdownOnly: true, promptOnly: false, disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null },
    { id: 'r1', scriptName: '命不中', findRegex: String.raw`/<content>\s*<story>/i`, replaceString: '', placement: [2], markdownOnly: true, promptOnly: false, disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null },
    { id: 'r3', scriptName: '变量更新完成', findRegex: String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g`, replaceString: '<details></details>', placement: [2], markdownOnly: true, promptOnly: false, disabled: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null },
  ] });
  const report = await runChecks(root, { sandbox });
  const codes = report.findings.map(item => item.code);
  assert.ok(codes.includes('regex-compile'), JSON.stringify(codes));
  assert.ok(codes.includes('regex-id'), 'the duplicated id is reported');
  const samples = report.findings.filter(item => item.code === 'regex-sample').map(item => item.message);
  assert.ok(samples.some(message => message.includes('命不中')), 'a display regex aimed at the body that misses the sample output is a warning');
  assert.ok(!samples.some(message => message.includes('变量更新完成')), 'a regex for output the body sample does not define is not held against it');
  assert.equal(report.ok, false);
  await clean(root);
});

const sampleFormat = (...sample: string[]) => ['<customize_format>', '根标签 content', '</customize_format>', '', '```示例输出', ...sample, '```'].join(NL);

test('the sample output must be well formed', async () => {
  for (const [label, sample, message] of [
    ['two roots', ['<content>', '雾。', '</content>', '<extra>尾巴</extra>'], /只能有一个根/],
    ['an unclosed tag', ['<content>', '<time>雾港历1年01月01日', '</content>'], /<time>/],
    ['crossed tags', ['<content>', '<a><b>x</a></b>', '</content>'], /<b>/],
  ] as const) {
    const root = await project([entry(0, '正文格式', sampleFormat(...sample), { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 })]);
    const report = await runChecks(root);
    const shape = report.findings.filter(item => item.code === 'format-sample-shape');
    assert.equal(shape[0]?.level, 'error', label);
    assert.match(shape[0].message, message, label);
    await clean(root);
  }
  const good = await project([entry(0, '正文格式', sampleFormat('<content>', '<time>雾港历1年01月01日</time>', '<StatusPlaceHolderImpl/>', '</content>'), { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 })]);
  assert.equal((await runChecks(good)).findings.filter(item => item.code === 'format-sample-shape').length, 0, 'a self-closing placeholder is fine');
  await clean(good);
});

test('a volume heading in the sample output must come from the title index', async () => {
  const root = await project([
    entry(0, '正文格式', sampleFormat('<content>', '<story volume="02">第02卷｜宅邸</story>', '<time>魔女历1000年01月01日</time>', '</content>'), { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 }),
    entry(1, '标题剧情索引', '<标题剧情索引>\n第01卷｜王都的开始：魔女历1000年01月01日\n</标题剧情索引>', { insertion_order: 15 }),
  ]);
  const report = await runChecks(root);
  const story = report.findings.find(item => item.code === 'format-sample-story');
  assert.equal(story?.level, 'error');
  assert.match(story!.message, /第02卷｜宅邸/);
  await clean(root);
});

test('the world book controller must point at entries that exist, by uid and name', async () => {
  const controller = [
    'const TARGETS = [',
    "  Object.freeze({ uid: 1, name: '正文格式', group: 'rendering' }),",
    "  Object.freeze({ uid: 2, name: '改名前的条目', group: 'rendering' }),",
    "  Object.freeze({ uid: 99, name: '不存在', group: 'rendering' }),",
    '];',
    'await updateWorldbookWith(name, entries => entries);',
  ].join(NL);
  const root = await project([
    entry(1, '正文格式', sampleFormat('<content>', '雾。', '</content>'), { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 }),
    entry(2, '正文格式·极简', '<content_lite>雾。</content_lite>', { insertion_order: 0, position: 'after_char', enabled: false }, { position: 4, depth: 0 }),
  ]);
  await writeFile(join(root, '脚本/01-世界书控制器.json'), JSON.stringify({ type: 'script', enabled: true, name: '世界书控制器', id: 'c1', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }));
  await writeFile(join(root, '脚本/01-世界书控制器.js'), controller);
  const report = await runChecks(root);
  const found = report.findings.filter(item => item.code === 'controller-uid').map(item => item.message);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.some(message => /uid 2/.test(message) && /改名前的条目/.test(message) && /正文格式·极简/.test(message)), 'a renamed entry is reported with both names');
  assert.ok(found.some(message => /uid 99/.test(message)), 'a missing entry is reported');
  assert.ok(report.findings.filter(item => item.code === 'controller-uid').every(item => item.level === 'error'));
  await clean(root);
});

test('plot date keywords use the calendar the sample output writes', async () => {
  const root = await project([
    entry(0, '正文格式', sampleFormat('<content>', '<time>魔女历1000年01月01日</time>', '</content>'), { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 }),
    entry(1, '标题剧情索引', '<标题剧情索引>\n第01卷｜开始：魔女历1000年01月01日\n第02卷｜宅邸：魔女历1000年01月05日\n</标题剧情索引>', { insertion_order: 15 }),
    entry(2, '第01卷｜开始', '<第01卷｜开始>\n【事件01】开始\n</第01卷｜开始>', { keys: ['第01卷｜开始', '魔女历1000年01月01日'], constant: false, insertion_order: 300, position: 'after_char' }, { position: 4 }),
    entry(3, '第02卷｜宅邸', '<第02卷｜宅邸>\n【事件01】到达\n</第02卷｜宅邸>', { keys: ['第02卷｜宅邸', '1000年01月05日'], constant: false, insertion_order: 301, position: 'after_char' }, { position: 4 }),
  ]);
  const report = await runChecks(root);
  const calendar = report.findings.filter(item => item.code === 'plot-calendar');
  assert.deepEqual(calendar.map(item => item.uid), [3], 'the second entry dates without 魔女历');
  assert.equal(calendar[0].level, 'warning');
  await clean(root);
});

test('greetings are matched against the text format', async () => {
  const root = await fullProject({ greetings: ['普通开场，没有按格式写。', '<start>创角开场</start>'] });
  const report = await runChecks(root, { sandbox });
  const greeting = report.findings.filter(item => item.code === 'greeting-format');
  assert.equal(greeting.length, 1, '创角开场 is exempt, the plain one is not');
  await clean(root);
});

test('the fixed pieces are compared with their exact text', async () => {
  const root = await fullProject();
  await writeFile(join(root, '世界书/变量/9994-变量列表.md'), '被改过的变量列表');
  const report = await runChecks(root, { sandbox });
  assert.ok(report.findings.some(item => item.code === 'fixed-piece' && item.message.includes('变量列表')));
  await clean(root);
});
