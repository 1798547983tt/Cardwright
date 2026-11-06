import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_BATCH_LIMIT, dispatchKey, formatDispatch, mayAddDispatches, messageStartsDispatch, parseDispatches, planDispatchBatch } from '../src/shared/card-studio/dispatch.ts';
import { SECTION_IDS, SECTION_ORDER, boardOf, findBoard, sectionFromTarget, sectionLabel, sortByDependency, targetOf } from '../src/shared/card-studio/boards.ts';

const fence = '```';
const block = (target: string, title: string, requires: string, body: string) => `${fence}派单\n目标: ${target}\n标题: ${title}\n前置: ${requires}\n---\n${body}\n${fence}`;

test('parses a standard dispatch block into its target section, title, prerequisite and body', () => {
  const text = `设计书已写入。\n\n${block('世界书/人设', '写人物模板', '设计书已确认', '按本卡设计书量身定做人物模板。\n写完先交我确认。')}\n`;
  assert.deepEqual(parseDispatches(text), [{
    target: '世界书/人设', sectionId: 'lore-people', title: '写人物模板', requires: '设计书已确认',
    body: '按本卡设计书量身定做人物模板。\n写完先交我确认。',
  }]);
});

test('returns every dispatch in reply order and ignores other code blocks', () => {
  const text = [block('世界书/叙事规则', '写叙事规则', '设计书已确认', '正文一'), `${fence}yaml\na: 1\n${fence}`, block('世界书/总览', '写地点总览', '设计书已确认', '正文二'), block('拼装', '拼装与导出', '以上全部完成', '正文三')].join('\n\n');
  assert.deepEqual(parseDispatches(text).map(item => 'title' in item ? item.title : item.error), ['写叙事规则', '写地点总览', '拼装与导出']);
});

test('accepts full-width colons, padded field names and a later separator inside the body', () => {
  const text = `${fence}派单\n 目标 ： 世界书 / 人设 \n标题：逐个写人物\n前置：人物模板已确认\n---\n第一段\n---\n第二段仍属于正文\n${fence}`;
  const [dispatch] = parseDispatches(text);
  assert.ok(!('error' in dispatch));
  assert.equal(dispatch.target, '世界书/人设');
  assert.equal(dispatch.sectionId, 'lore-people');
  assert.equal(dispatch.body, '第一段\n---\n第二段仍属于正文');
});

test('the tool carries a brief and references while a block carries the brief', () => {
  const batch = planDispatchBatch([], [{ target: '世界书/人设', title: '写人设', body: '正文', brief: '先写主角', references: [{ path: '设计书.md', heading: '主角与配角', summary: '人物名单' }] }]);
  assert.equal(batch.accepted[0].brief, '先写主角');
  assert.deepEqual(batch.accepted[0].references, [{ path: '设计书.md', heading: '主角与配角', summary: '人物名单' }]);
  const [parsed] = parseDispatches(`${fence}派单\n目标: 世界书/人设\n标题: 写人设\n前置: 设计书\n摘要: 先写主角\n---\n正文\n${fence}`);
  assert.ok(!('error' in parsed));
  assert.equal(parsed.brief, '先写主角');
  assert.match(formatDispatch(parsed), /摘要: 先写主角/);
});

test('reports a malformed block instead of throwing', () => {
  const [missingTarget, missingTitle] = parseDispatches(`${fence}派单\n标题: 写设定\n---\n正文\n${fence}\n${fence}派单\n目标: 世界书/设定\n---\n正文\n${fence}`);
  assert.equal('error' in missingTarget && missingTarget.error, '派单缺少目标');
  assert.equal('error' in missingTitle && missingTitle.error, '派单缺少标题');
});

test('maps single-section boards, spaced targets and unknown targets', () => {
  assert.equal(sectionFromTarget('开场白'), 'greet');
  assert.equal(sectionFromTarget('拼装'), 'build');
  assert.equal(sectionFromTarget('规划'), 'plan');
  assert.equal(sectionFromTarget(' 正则 / 状态栏 '), 'regex-status');
  assert.equal(sectionFromTarget('脚本/变量结构'), 'script-schema');
  assert.equal(sectionFromTarget('世界书/不存在'), null);
  const [unknown] = parseDispatches(block('世界书/不存在', '写点什么', '无', '正文'));
  assert.ok(!('error' in unknown));
  assert.equal(unknown.sectionId, null);
  assert.equal(targetOf('lore-people'), '世界书/人设');
  assert.equal(targetOf('greet'), '开场白');
  assert.equal(sectionLabel('regex-status'), '正则 · 状态栏');
  assert.equal(sectionLabel('plan'), '规划');
});

test('sectionLabel never throws: unclassified entries have a label of their own, other ids come back as they are', () => {
  assert.equal(sectionLabel('lore-other'), '世界书 · 未分类');
  assert.equal(sectionLabel('随便什么'), '随便什么');
  assert.equal(sectionLabel(''), '');
});

test('findBoard looks a section up without throwing; boardOf still throws on an id no board has', () => {
  assert.equal(findBoard('lore-people')?.id, 'lore');
  assert.equal(findBoard('build')?.id, 'build');
  assert.equal(findBoard('lore-other'), undefined, 'unclassified entries have no section page of their own');
  assert.equal(findBoard('随便什么'), undefined);
  assert.throws(() => boardOf('随便什么'), /Unknown card studio section: 随便什么/);
});

test('formats a dispatch that parses back to the same fields', () => {
  const original = { target: '脚本/变量结构', title: '写变量结构与初始变量', requires: '人设、设定已完成', body: 'MVU 固定件原样使用。\n每个字段都有默认值。' };
  const [parsed] = parseDispatches(formatDispatch(original));
  assert.ok(!('error' in parsed));
  assert.deepEqual({ target: parsed.target, title: parsed.title, requires: parsed.requires, body: parsed.body }, original);
});

test('recognizes a sent message that starts a known dispatch', () => {
  const dispatch = { target: '世界书/人设', title: '写人物模板' };
  assert.equal(messageStartsDispatch(formatDispatch({ ...dispatch, requires: '设计书已确认', body: '正文' }), dispatch), true);
  assert.equal(messageStartsDispatch(`请开始。\n${block('世界书 / 人设', '写人物模板', '设计书已确认', '正文')}`, dispatch), true);
  assert.equal(messageStartsDispatch(block('世界书/人设', '写人物总览', '人物模板已确认', '正文'), dispatch), false);
  assert.equal(messageStartsDispatch('写人物模板', dispatch), false);
  assert.equal(dispatchKey({ target: '世界书 / 人设', title: ' 写人物模板 ' }), dispatchKey(dispatch));
});

test('改动派单 go in the sections\' dependency order: ties keep their order, unknown sections come last', () => {
  const items = [
    { sectionId: 'greet', title: '开场白' }, { sectionId: 'regex-start', title: '创角页' }, { sectionId: null, title: '未知' },
    { sectionId: 'script-schema', title: '变量表' }, { sectionId: 'lore-vars', title: '变量条目甲' }, { sectionId: 'nowhere', title: '别处' },
    { sectionId: 'lore-vars', title: '变量条目乙' }, { sectionId: 'regex-body', title: '正文美化' }, { sectionId: 'lore-rules', title: '叙事规则' },
  ];
  assert.deepEqual(sortByDependency(items).map(item => item.title), ['叙事规则', '变量表', '变量条目甲', '变量条目乙', '正文美化', '创角页', '开场白', '未知', '别处']);
  assert.equal(items[0].title, '开场白', 'the input is left as it was');
  assert.deepEqual([...SECTION_ORDER].sort(), SECTION_IDS.filter(id => id !== 'source').sort(), 'every section with conversations has a place');
});

// §5.6: card_add_dispatches checks each item the way a 派单 block is parsed, and answers for every item.
test('a batch from the tool is checked item by item, against the card and against itself', () => {
  assert.equal(DISPATCH_BATCH_LIMIT, 12, '§5.6: 1 to 12 at a time');
  const existing = [{ target: '世界书/人设', sectionId: 'lore-people', title: '写人物模板' }];
  const { accepted, results } = planDispatchBatch(existing, [
    { target: '世界书 / 叙事规则', title: ' 写叙事规则 ', prerequisite: '设计书已确认', body: '写四条叙事规则。\n' },
    { target: '世界书/人设', title: '写人物模板', body: '又来一次' },
    { target: '世界书/人物', title: '写点什么', body: '正文' },
    { target: '规划', title: '再规划一次', body: '正文' },
    { title: '没有目标', body: '正文' },
    { target: '开场白', title: '', body: '正文' },
    { target: '开场白', title: '写开场白', body: '两条普通开场白。' },
    { target: '开场白/开场白', title: '写开场白', body: '同一个分区的另一种写法' },
    { target: '世界书/设定', title: '写设定\n第二行', body: '' },
    '不是对象',
  ]);
  assert.deepEqual(accepted.map(item => [item.sectionId, item.title, item.requires, item.body]), [
    ['lore-rules', '写叙事规则', '设计书已确认', '写四条叙事规则。'],
    ['greet', '写开场白', '', '两条普通开场白。'],
    ['lore-setting', '写设定 第二行', '', ''],
  ]);
  assert.deepEqual(results.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(results.map(item => item.ok), [true, false, false, false, false, false, true, false, true, false]);
  assert.equal(results[0].target, '世界书/叙事规则');
  assert.equal(results[0].section, '世界书 · 叙事规则');
  assert.match(results[1].error ?? '', /已经有一条叫「写人物模板」的派单/);
  assert.match(results[2].error ?? '', /不是能派单的分区/);
  assert.match(results[2].error ?? '', /世界书\/人设/, 'the refusal lists the targets that work');
  assert.match(results[3].error ?? '', /不是能派单的分区/, 'planning does not dispatch to itself');
  assert.equal(results[4].error, '派单缺少目标');
  assert.equal(results[5].error, '派单缺少标题');
  assert.match(results[7].error ?? '', /已经有一条叫「写开场白」的派单/, 'the same section under another spelling is the same dispatch');
  assert.equal(results[9].error, '派单缺少目标');
});

test('only planning that starts or refines a card registers dispatches by tool', () => {
  assert.equal(mayAddDispatches({ sectionId: 'plan', mode: 'scratch' }), true);
  assert.equal(mayAddDispatches({ sectionId: 'plan', mode: 'refine' }), true);
  assert.equal(mayAddDispatches({ sectionId: 'plan', mode: 'change' }), false, 'the change AI\'s 派单 blocks are its 影响清单');
  assert.equal(mayAddDispatches({ sectionId: 'plan', mode: 'scratch', member: true }), false, 'squad members never register');
  assert.equal(mayAddDispatches({ sectionId: 'lore-people' }), false);
  assert.equal(mayAddDispatches(undefined), false);
});

test('a body that quotes a code block keeps it: the dispatch gets a longer fence', () => {
  const original = { target: '脚本/变量结构', title: '写变量表', requires: '', body: '变量表照这个开头：\n```yaml\n版本: 1\n```\n其余按设计书。' };
  const text = formatDispatch(original);
  assert.ok(text.startsWith('````派单\n'), text);
  const [parsed] = parseDispatches(text);
  assert.ok(!('error' in parsed));
  assert.equal(parsed.body, original.body);
  assert.equal(messageStartsDispatch(text, original), true);
  assert.ok(formatDispatch({ ...original, body: '没有代码块。' }).startsWith('```派单\n'), 'an ordinary body keeps the usual fence');
});
