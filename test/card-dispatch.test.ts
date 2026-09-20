import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchKey, formatDispatch, messageStartsDispatch, parseDispatches } from '../src/shared/card-studio/dispatch.ts';
import { sectionFromTarget, sectionLabel, targetOf } from '../src/shared/card-studio/boards.ts';

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
