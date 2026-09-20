import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_ALL_MARKER, KICKOFF, REFUSE_MARKER, isKickoff, segmentReply, stripMarkers } from '../src/shared/card-studio/markers.ts';

const fence = '```';

test('strips the accept-all marker and reports it', () => {
  const result = stripMarkers(`第 1 轮\n1. 采用范围？推荐：B\n\n${ACCEPT_ALL_MARKER}\n`);
  assert.equal(result.hasAcceptAll, true);
  assert.equal(result.refused, false);
  assert.equal(result.text, '第 1 轮\n1. 采用范围？推荐：B');
});

test('strips the refuse marker and reports it', () => {
  const result = stripMarkers(`缺少设计书，请先回规划。\n${REFUSE_MARKER}`);
  assert.equal(result.refused, true);
  assert.equal(result.hasAcceptAll, false);
  assert.equal(result.text, '缺少设计书，请先回规划。');
});

test('ignores a marker quoted inside a code block', () => {
  const text = `提示词示例：\n${fence}text\n${ACCEPT_ALL_MARKER}\n${REFUSE_MARKER}\n${fence}`;
  const result = stripMarkers(text);
  assert.equal(result.hasAcceptAll, false);
  assert.equal(result.refused, false);
  assert.equal(result.text, text);
});

test('recognizes the two planning kickoff instructions', () => {
  assert.equal(isKickoff(KICKOFF.scratch), 'scratch');
  assert.equal(isKickoff(`  ${KICKOFF.refine}\n`), 'refine');
  assert.equal(isKickoff('开始规划'), null);
});

test('splits a reply into markdown, dispatch and handoff segments in order', () => {
  const text = `设计书已写入。\n\n${fence}派单\n目标: 世界书/叙事规则\n标题: 写叙事规则\n前置: 设计书已确认\n---\n正文\n${fence}\n\n另外：\n\n${fence}交接摘要\n已定: A\n已写: B\n未完成: C\n第一步: D\n${fence}\n结束。`;
  const segments = segmentReply(text);
  assert.deepEqual(segments.map(segment => segment.type), ['markdown', 'dispatch', 'markdown', 'handoff', 'markdown']);
  assert.equal(segments[0].type === 'markdown' && segments[0].text, '设计书已写入。');
  assert.equal(segments[1].type === 'dispatch' && 'title' in segments[1].dispatch && segments[1].dispatch.title, '写叙事规则');
  assert.equal(segments[3].type === 'handoff' && segments[3].handoff?.first, 'D');
  assert.equal(segments[4].type === 'markdown' && segments[4].text, '结束。');
});

test('keeps a reply without special blocks as one markdown segment', () => {
  assert.deepEqual(segmentReply('只是一段话。'), [{ type: 'markdown', text: '只是一段话。' }]);
  assert.deepEqual(segmentReply(''), []);
});
