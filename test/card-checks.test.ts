import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a wrapper tag written the wrong way round is a warning', async () => {
  const root = await project([
    entry(1, '人物总览', '</人物总览>\n昴｜男｜主角\n</人物总览>'),
    entry(2, '地点总览', '<地点总览>\n王都｜城市｜首都\n</地点总览>'),
  ]);
  const report = await runChecks(root);
  const tag = report.findings.filter(item => item.code === 'wrap-tag');
  assert.equal(tag.length, 1);
  assert.equal(tag[0].level, 'warning', 'since 1.1.0 a wrapper problem no longer blocks the export');
  assert.equal(tag[0].uid, 1);
  assert.match(tag[0].message, /人物总览/);
  await clean(root);
});

test('a body that never closes its wrapper is a warning too', async () => {
  const root = await project([entry(1, '王都', '<王都>\n城。')]);
  const report = await runChecks(root);
  assert.equal(report.findings.filter(item => item.code === 'wrap-tag' && item.level === 'warning').length, 1);
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

const fullCard = (over: { regex?: unknown[]; scripts?: unknown[]; greetings?: string[]; initvar?: string; rules?: string; rulesName?: string; extra?: Array<ReturnType<typeof entry>> } = {}) => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡',
  data: {
    name: '样卡', first_mes: over.greetings?.[0] ?? ['<content>', '<time>雾港历1年01月01日</time>', '</content>'].join(NL),
    alternate_greetings: over.greetings?.slice(1) ?? [],
    character_book: { name: '样卡世界书', entries: [
      entry(0, '正文格式', formatEntry, { insertion_order: 0, position: 'after_char' }, { position: 4, depth: 0 }),
      entry(1, '[initvar] 初始', over.initvar ?? ['主角:', '  姓名: 林砚', '  生命: 90'].join(NL), { insertion_order: 1002 }),
      entry(2, '变量列表', FIXED_VARIABLE_LIST, { insertion_order: 9994 }),
      entry(3, over.rulesName ?? '变量规则', over.rules ?? ['总则：只按已发生的事实更新。', 'replace /主角/生命', 'replace /主角/不存在的字段'].join(NL), { insertion_order: 9995 }),
      ...(over.extra ?? []),
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

import { syncVariableArtifacts, writeDerivedTable, VARIABLE_TABLE_FILE } from '../src/core/card-studio/variable-artifacts.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

test('an enabled [initvar] is a warning: MVU treats it as a prompt', async () => {
  const root = await fullProject();
  const report = await runChecks(root, { sandbox });
  const params = report.findings.find(item => item.code === 'initvar-params');
  assert.equal(params?.level, 'warning');
  assert.match(params!.message, /没有关闭/);
  await clean(root);
});

test('a variable table that does not parse blocks the export, with every problem named', async () => {
  const root = await fullProject();
  await writeFile(join(root, VARIABLE_TABLE_FILE), ['版本: 1', '变量:', '  - 路径: /主角/生命', '    类型: 数值', '  - 路径: /主角/生命', '    类型: 文本'].join(NL));
  const report = await runChecks(root, { sandbox });
  const invalid = report.findings.filter(item => item.code === 'variable-table-invalid');
  assert.equal(invalid.length, 2, JSON.stringify(invalid));
  assert.ok(invalid.every(item => item.level === 'error' && item.path === VARIABLE_TABLE_FILE));
  assert.match(invalid.map(item => item.message).join('|'), /路径重复/);
  assert.match(invalid.map(item => item.message).join('|'), /上级 \/主角 没有在表里定义/);
  assert.equal(report.ok, false);
  await writeFile(join(root, VARIABLE_TABLE_FILE), ': : :');
  const broken = await runChecks(root, { sandbox });
  assert.equal(broken.findings.filter(item => item.code === 'variable-table-parse' && item.level === 'error').length, 1);
  await clean(root);
});

test('generated files that were edited by hand, and a table that changed since, are warnings', async () => {
  const root = await fullProject();
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  const before = await runChecks(root, { sandbox });
  assert.equal(before.findings.find(item => item.code === 'variable-table-stale')?.level, 'warning', 'a table nobody generated from yet');
  await syncVariableArtifacts(root, { cardName: '样卡' });
  const synced = await runChecks(root, { sandbox });
  assert.equal(synced.findings.some(item => item.code === 'variable-table-stale' || item.code === 'generated-edited'), false, JSON.stringify(synced.findings.filter(item => item.level !== 'info')));
  assert.ok(synced.findings.some(item => item.code === 'initvar-ok'), 'the generated [initvar] passes the generated Zod');
  assert.equal(synced.findings.some(item => item.code === 'initvar-params'), false, 'the generated [initvar] is disabled');
  const zod = join(root, '脚本', '01-ZOD.js');
  await writeFile(zod, `${await readFile(zod, 'utf8')}\n// 手改\n`);
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE.replace('上限: 12', '上限: 9'));
  const after = await runChecks(root, { sandbox });
  const edited = after.findings.find(item => item.code === 'generated-edited');
  assert.equal(edited?.level, 'warning');
  assert.equal(edited?.path, '脚本/01-ZOD.js');
  assert.equal(after.findings.find(item => item.code === 'variable-table-stale')?.level, 'warning');
  await clean(root);
});

const statusBar = (reads: string) => ({ id: 'r9', scriptName: '状态栏', findRegex: String.raw`/<StatusPlaceHolderImpl\/>/g`, replaceString: ['<!DOCTYPE html>', '<html><head><style>:root{--bg:#111;--text:#eee;--a:1;--b:2;--c:3;--d:4;--e:5;--f:6;--g:7;--h:8;--i:9;--j:10}body{color:var(--text);background:var(--bg)}button:hover{opacity:.9}@media(max-width:375px){body{display:block}}</style></head>', `<body><script>const data = { stat_data: {} }; const view = [${reads}]; document.body.textContent = view.join(' ');</script></body></html>`].join(NL), placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: 0 });

test('a hand-written status bar that reads a path the table lacks is an error with an authored table, a warning with a derived one', async () => {
  const reads = "data.stat_data.主角.生命, data.stat_data['主角']['姓名'].length, data.stat_data.主角.魔力.toFixed(1), data?.stat_data?.人物?.张三?.好感, data.stat_data.人物.张三.身高";
  const root = await fullProject({ regex: [statusBar(reads)] });
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  await syncVariableArtifacts(root, { cardName: '样卡' });
  const authored = await runChecks(root, { sandbox });
  const errors = authored.findings.filter(item => item.code === 'variable-binding');
  assert.deepEqual(errors.map(item => item.level), ['error', 'error'], JSON.stringify(errors));
  assert.match(errors[0].message, /正则「状态栏」读的 \/主角\/魔力 不在变量表里/);
  assert.match(errors[1].message, /\/人物\/张三\/身高/);
  assert.equal(errors[0].path, '正则/01-状态栏.html');
  await rm(join(root, VARIABLE_TABLE_FILE));
  await writeDerivedTable(root);
  const derived = await runChecks(root, { sandbox });
  const warnings = derived.findings.filter(item => item.code === 'variable-binding');
  assert.ok(warnings.length >= 1, JSON.stringify(derived.findings));
  assert.ok(warnings.every(item => item.level === 'warning' && /推导的变量表/.test(item.message)));
  await clean(root);
});

test('a rule that keeps a different number of records than the table is a warning', async () => {
  const root = await fullProject({ rules: '各容器规则：\n- 人物：只保留最近 10 条，超出删最早的。\n- 事件记录：最多 8 条。' });
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  await syncVariableArtifacts(root, { cardName: '样卡' });
  const report = await runChecks(root, { sandbox });
  const limits = report.findings.filter(item => item.code === 'variable-limit');
  assert.equal(limits.length, 1, JSON.stringify(limits));
  assert.equal(limits[0].level, 'warning');
  assert.match(limits[0].message, /「人物」保留 10 条，变量表的上限是 12 条/);
  await clean(root);
});

const updateFormatEntry = (patch: string) => entry(4, '变量输出格式', ['每次回复末尾输出：', '<UpdateVariable>', '<Analysis>', '一、主角：本轮变化', '</Analysis>', '<JSONPatch>', patch, '</JSONPatch>', '</UpdateVariable>'].join(NL), { insertion_order: 9996 });
const renderer = (findRegex: string) => ({ id: 'r7', scriptName: '变量更新完成', findRegex, replaceString: '<details><summary>本轮变量已更新</summary></details>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null });

test('an example patch in the output format that cannot apply to [initvar] is an error', async () => {
  const bad = await fullProject({ extra: [updateFormatEntry('[{"op":"replace","path":"/主角/魔力","value":1}]')] });
  const report = await runChecks(bad, { sandbox });
  const patch = report.findings.find(item => item.code === 'variable-patch');
  assert.equal(patch?.level, 'error');
  assert.match(patch!.message, /replace 的路径不存在/);
  await clean(bad);
  const good = await fullProject({ extra: [updateFormatEntry('[{"op":"replace","path":"/主角/生命","value":80}]')] });
  assert.equal((await runChecks(good, { sandbox })).findings.some(item => item.code === 'variable-patch'), false);
  await clean(good);
  const template = await fullProject({ extra: [updateFormatEntry('${只输出合法 JSON 数组；无变化时输出 []}')] });
  assert.equal((await runChecks(template, { sandbox })).findings.some(item => item.code === 'variable-patch'), false, 'a placeholder is not an example');
  await clean(template);
});

test('a display regex for the update block must match the block the output format defines', async () => {
  const miss = await fullProject({ extra: [updateFormatEntry('[]')], regex: [renderer(String.raw`/<UpdateVariable>\s*<analysis>[\s\S]*?<\/UpdateVariable>/g`)] });
  const report = await runChecks(miss, { sandbox });
  const render = report.findings.find(item => item.code === 'variable-render');
  assert.equal(render?.level, 'error');
  assert.match(render!.message, /「变量更新完成」/);
  await clean(miss);
  const hit = await fullProject({ extra: [updateFormatEntry('${只输出合法 JSON 数组}')], regex: [renderer(String.raw`/<UpdateVariable>\s*<Analysis>\s*([\s\S]*?)\s*<\/Analysis>\s*<JSONPatch>\s*(\[[\s\S]*?\])\s*<\/JSONPatch>\s*<\/UpdateVariable>/g`)] });
  assert.equal((await runChecks(hit, { sandbox })).findings.some(item => item.code === 'variable-render'), false, 'the placeholder inside <JSONPatch> is sampled as []');
  await clean(hit);
});

import { createComponent } from '../src/core/card-studio/components.ts';
import { FLOATING_SUFFIX } from '../src/core/card-studio/assembly.ts';
import { loadFrontendResources } from '../src/core/card-studio/frontend-resources.ts';
import { BODY_SHEET, STATUS_SHEET } from './assembly-sheet-samples.ts';

const frontend = await loadFrontendResources(fileURLToPath(new URL('../card-studio', import.meta.url)));
/** A card with an authored 变量表 and sheet-bodied regex; `params` patches each regex's parameters. */
async function sheetProject(sheets: Record<string, string>, params: Record<string, Record<string, unknown>> = {}, table: string | null = SAMPLE_TABLE): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-checks-sheet-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  if (table) await writeFile(join(root, '变量表.yaml'), table);
  for (const [name, body] of Object.entries(sheets)) {
    const made = await createComponent(root, { board: 'regex', name, format: 'sheet' });
    await writeFile(join(root, made.bodyPath), body);
    if (params[name]) { const file = join(root, made.paramsPath); await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...params[name] }, null, 2)); }
  }
  return root;
}

test('a placeholder status bar must render only the latest floor: maxDepth 0', async () => {
  const root = await sheetProject({ 状态栏: STATUS_SHEET });
  const report = await runChecks(root, { frontend });
  const form = report.findings.find(item => item.code === 'status-form');
  assert.equal(form?.level, 'error');
  assert.match(form!.message, /maxDepth: 0/);
  assert.ok(!report.findings.some(item => item.code.startsWith('frontend-') && item.level === 'error'), JSON.stringify(report.findings.filter(item => item.code.startsWith('frontend-'))));
  assert.ok(!report.findings.some(item => item.code === 'regex-empty'));
  await clean(root);
  const fixed = await sheetProject({ 状态栏: STATUS_SHEET }, { 状态栏: { maxDepth: 0 } });
  assert.ok(!(await runChecks(fixed, { frontend })).findings.some(item => item.code === 'status-form'));
  await clean(fixed);
});

test('sheet problems land on the component: parse errors, bindings by table source, a missing table', async () => {
  const root = await sheetProject({ 状态栏: STATUS_SHEET.replace('/主角/在逃', '/主角/魔力').replace('形态: placeholder', '形态: header'), 正文美化: BODY_SHEET.replace('状态头: false', '状态头: true').replace('楼层: 10', '楼层: 十') }, { 状态栏: { maxDepth: 0 } });
  const report = await runChecks(root, { frontend });
  const binding = report.findings.find(item => item.code === 'variable-binding');
  assert.equal(binding?.level, 'error', 'an authored table makes a missing path an error');
  assert.equal(binding?.path, '正则/01-状态栏.yaml');
  assert.match(binding!.message, /\/主角\/魔力/);
  const invalid = report.findings.filter(item => item.code === 'sheet-invalid');
  assert.ok(invalid.some(item => item.path === '正则/02-正文美化.yaml' && /楼层/.test(item.message)), JSON.stringify(invalid));
  assert.ok(invalid.some(item => item.path === '正则/01-状态栏.yaml' && /正文美化/.test(item.message)), 'a header status bar without a usable body sheet');
  assert.ok(!report.findings.some(item => item.code === 'regex-empty'), 'a header status bar is meant to be empty');
  await clean(root);
  const bare = await sheetProject({ 状态栏: STATUS_SHEET }, { 状态栏: { maxDepth: 0 } }, null);
  const missing = (await runChecks(bare, { frontend })).findings.find(item => item.code === 'variable-table-missing');
  assert.equal(missing?.level, 'warning');
  await clean(bare);
});

test('regex dialect and catastrophic backtracking are reported on the parameters', async () => {
  const root = await sheetProject({}, {});
  await createComponent(root, { board: 'regex', name: '方言' });
  const dialect = join(root, '正则/01-方言.json');
  await writeFile(dialect, JSON.stringify({ ...JSON.parse(await readFile(dialect, 'utf8')), findRegex: '/(?i)<mood>(.*?)<\\/mood>/' }, null, 2));
  await createComponent(root, { board: 'regex', name: '回溯' });
  const backtrack = join(root, '正则/02-回溯.json');
  await writeFile(backtrack, JSON.stringify({ ...JSON.parse(await readFile(backtrack, 'utf8')), findRegex: '/(a+)+$/' }, null, 2));
  // SillyTavern substitutes the macros before it compiles (substituteRegex 1). With this card name the expression no longer
  // compiles, so SillyTavern skips it and so does the probe; read unsubstituted, its (a+)+$ branch would hang.
  await createComponent(root, { board: 'regex', name: '宏' });
  const macro = join(root, '正则/03-宏.json');
  await writeFile(macro, JSON.stringify({ ...JSON.parse(await readFile(macro, 'utf8')), findRegex: '/{{char}}|(a+)+$/', substituteRegex: 1 }, null, 2));
  const report = await runChecks(root, { context: { frontend, table: null, cardName: '样卡(', preset: null } });
  const warned = report.findings.find(item => item.code === 'regex-dialect');
  assert.equal(warned?.level, 'warning'); assert.equal(warned?.path, '正则/01-方言.json');
  assert.ok(report.findings.some(item => item.code === 'regex-compile' && item.path === '正则/01-方言.json'), 'the dialect warning still explains an expression that does not compile');
  const hung = report.findings.filter(item => item.code === 'regex-backtrack');
  assert.deepEqual(hung.map(item => `${item.level}@${item.path}`), ['error@正则/02-回溯.json']);
  assert.match(hung[0].message, /300 毫秒/);
  assert.ok(!report.findings.some(item => item.code === 'regex-probe'), 'every probe started');
  await clean(root);
});

test('a body sheet renders the floors its regex reaches: maxDepth is 楼层 minus one', async () => {
  const three = await sheetProject({ 正文美化: BODY_SHEET.replace('楼层: 10', '楼层: 3') });
  const floors = (await runChecks(three, { frontend })).findings.filter(item => item.code === 'body-floors');
  assert.deepEqual(floors.map(item => `${item.level}@${item.path}`), ['warning@正则/01-正文美化.json']);
  assert.equal(floors[0].message, '「正文美化」的装配单写的是只渲染最近 3 楼，正则的 maxDepth 应是 2（现在是 9）。');
  await clean(three);
  const ten = await sheetProject({ 正文美化: BODY_SHEET });
  assert.ok(!(await runChecks(ten, { frontend })).findings.some(item => item.code === 'body-floors'), '楼层 10 with the maxDepth 9 a new body sheet starts with');
  await clean(ten);
  const open = await sheetProject({ 正文美化: BODY_SHEET }, { 正文美化: { maxDepth: null } });
  const unlimited = (await runChecks(open, { frontend })).findings.find(item => item.code === 'body-floors');
  assert.match(unlimited?.message ?? '', /应是 9（现在是没有限制）/);
  await clean(open);
});

test('a damaged skeleton is one finding without a path, and the checks still finish', async () => {
  const root = await sheetProject({ 状态栏: STATUS_SHEET }, { 状态栏: { maxDepth: 0 } });
  const report = await runChecks(root, { frontend: { ...frontend, core: `${frontend.core}\nconst broken = '$1';` } });
  const invalid = report.findings.filter(item => item.code === 'sheet-invalid');
  const damaged = invalid.filter(item => item.path === undefined);
  assert.equal(damaged.length, 1, JSON.stringify(invalid));
  assert.equal(damaged[0].level, 'error');
  assert.match(damaged[0].message, /^前端骨架资源损坏，装配单编译不了：运行时 core\.js里有会被酒馆正则替换掉的 \$ 写法，运行时不能这样写。请重新安装 Cardwright。$/);
  assert.equal(invalid.length, 1, 'the damaged skeleton is the one finding: the sheet is not reported again on its component');
  assert.ok(report.findings.some(item => item.code === 'export-readback' && item.level === 'info'), 'the card still reads back');
  await clean(root);
});

test('an empty sheet is sheet-invalid only, and a sheet in an .html body is not read for stat_data', async () => {
  const empty = await sheetProject({ 状态栏: '' }, { 状态栏: { maxDepth: 0 } });
  const report = await runChecks(empty, { frontend });
  assert.ok(report.findings.some(item => item.code === 'sheet-invalid' && item.path === '正则/01-状态栏.yaml'), JSON.stringify(report.findings));
  assert.ok(!report.findings.some(item => item.code === 'regex-empty'), 'an empty sheet is not an empty replacement');
  await clean(empty);
  const html = await sheetProject({});
  const made = await createComponent(html, { board: 'regex', name: '状态栏' });
  await writeFile(join(html, made.bodyPath), STATUS_SHEET.replace('标题: 样卡', '标题: stat_data.主角.魔力'));
  await writeFile(join(html, made.paramsPath), JSON.stringify({ ...JSON.parse(await readFile(join(html, made.paramsPath), 'utf8')), findRegex: String.raw`/<StatusPlaceHolderImpl\/>/g`, maxDepth: 0 }, null, 2));
  const bindings = (await runChecks(html, { frontend })).findings.filter(item => item.code === 'variable-binding');
  assert.deepEqual(bindings, [], 'the compiler checks a sheet against the table; its title is not a stat_data read');
  await clean(html);
});

test('a synthesized floating script joins the script id check, and a hand-written script of its name is a warning', async () => {
  const root = await sheetProject({ 状态栏: STATUS_SHEET.replace('形态: placeholder', '形态: floating') });
  const regex = JSON.parse(await readFile(join(root, '正则/01-状态栏.json'), 'utf8')) as { id: string };
  const copy = `脚本/01-状态栏${FLOATING_SUFFIX}`;
  await writeFile(join(root, `${copy}.json`), JSON.stringify({ type: 'script', enabled: true, name: `状态栏${FLOATING_SUFFIX}`, id: `${regex.id}-floating`, info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }));
  await writeFile(join(root, `${copy}.js`), 'console.log(1);');
  const found = (await runChecks(root, { frontend })).findings.filter(item => item.code === 'script-id');
  assert.deepEqual(found.map(item => `${item.level}@${item.path}`), [`error@${copy}.json`, `warning@${copy}.json`], JSON.stringify(found));
  assert.match(found[0].message, /由装配单合成/);
  assert.match(found[1].message, /同名/);
  await clean(root);
});

test('the checks use the assembly context they are given', async () => {
  const root = await sheetProject({ 状态栏: STATUS_SHEET }, { 状态栏: { maxDepth: 0 } });
  const given = await runChecks(root, { context: { frontend, table: null, cardName: '样卡', preset: 'sakura' } });
  assert.equal(given.findings.find(item => item.code === 'variable-table-missing')?.path, '正则/01-状态栏.yaml', 'the given context has no table, though the card has one');
  assert.ok(!(await runChecks(root, { frontend })).findings.some(item => item.code === 'variable-table-missing'));
  await clean(root);
});

test('a container name inside running prose is not a limit statement; the second block of a two-shape format is checked too', async () => {
  const table = SAMPLE_TABLE.replace('  - 路径: /事件记录\n    类型: 列表\n    元素: 文本\n    上限: 8', '  - 路径: /事件\n    类型: 列表\n    元素: 文本\n    上限: 8');
  const prose = await fullProject({ rules: '各容器规则：\n- 人物：每个事件最多 3 个人物参与，保留最近 12 条。\n- 事件：只保留最近 8 条。' });
  await writeFile(join(prose, VARIABLE_TABLE_FILE), table);
  await syncVariableArtifacts(prose, { cardName: '样卡' });
  assert.equal((await runChecks(prose, { sandbox })).findings.some(item => item.code === 'variable-limit'), false, '「事件最多 3 个人物」 is about participants, not the 事件 list');
  await clean(prose);
  const twoBlocks = await fullProject({ extra: [entry(4, '变量输出格式', ['生成中：', '<UpdateVariable>', '<Analysis>', '${分析}', '</Analysis>', '<JSONPatch>', '${数组}', '</JSONPatch>', '</UpdateVariable>', '完成后：', '<UpdateVariable>', '<Analysis>', '一、主角', '</Analysis>', '<JSONPatch>', '[{"op":"replace","path":"/主角/魔力","value":1}]', '</JSONPatch>', '</UpdateVariable>'].join(NL), { insertion_order: 9996 })] });
  const report = await runChecks(twoBlocks, { sandbox });
  assert.equal(report.findings.find(item => item.code === 'variable-patch')?.level, 'error', 'the finished block carries the real example');
  await clean(twoBlocks);
});
