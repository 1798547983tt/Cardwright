import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HANDOFF, formatHandoff, handoffFromReply, handoffOffer, handoffThreshold, parseHandoff } from '../src/shared/card-studio/handoff.ts';
import { HANDOFF_REQUEST, handoffRequestText, isHandoffRequest } from '../src/shared/card-studio/markers.ts';

const fence = '```';

test('parses the four handoff fields and joins continuation lines', () => {
  const text = `这个对话已经写完 2 个人物，建议换对话。\n\n${fence}交接摘要\n已定: 人物模板 v2；三档长度\n已写: 红孩儿 uid 120\n  白骨夫人 uid 121\n未完成: 名单剩余 19 人\n第一步: 写第 13 人「黄袍怪」\n${fence}`;
  assert.deepEqual(parseHandoff(text), {
    decided: '人物模板 v2；三档长度',
    written: '红孩儿 uid 120\n白骨夫人 uid 121',
    pending: '名单剩余 19 人',
    first: '写第 13 人「黄袍怪」',
  });
});

test('accepts full-width colons', () => {
  const handoff = parseHandoff(`${fence}交接摘要\n已定：A\n已写：B\n未完成：C\n第一步：D\n${fence}`);
  assert.deepEqual(handoff, { decided: 'A', written: 'B', pending: 'C', first: 'D' });
});

test('returns null when a field is missing or there is no handoff block', () => {
  assert.equal(parseHandoff(`${fence}交接摘要\n已定: A\n已写: B\n第一步: D\n${fence}`), null);
  assert.equal(parseHandoff('已定: A\n已写: B\n未完成: C\n第一步: D'), null);
});

test('uses the last handoff block in a reply', () => {
  const first = `${fence}交接摘要\n已定: 旧\n已写: 旧\n未完成: 旧\n第一步: 旧\n${fence}`;
  const last = `${fence}交接摘要\n已定: 新\n已写: 新\n未完成: 新\n第一步: 新\n${fence}`;
  assert.equal(parseHandoff(`${first}\n修正如下：\n${last}`)?.decided, '新');
});

test('formats a handoff that parses back to the same fields', () => {
  const handoff = { decided: '人物模板 v2', written: '红孩儿 uid 120\n白骨夫人 uid 121', pending: '名单剩余 19 人', first: '写黄袍怪' };
  assert.deepEqual(parseHandoff(formatHandoff(handoff)), handoff);
});

test('the threshold is 200K tokens or half the window, whichever comes first', () => {
  assert.equal(handoffThreshold(1_000_000), 200_000);
  assert.equal(handoffThreshold(300_000), 150_000);
  assert.equal(handoffThreshold(128_000, { tokens: 200_000, windowPercent: 50 }), 64_000);
  assert.equal(handoffThreshold(1_000_000, { tokens: 500_000, windowPercent: 80 }), 500_000);
  assert.equal(handoffThreshold(0), DEFAULT_HANDOFF.tokens);
});

test('a new conversation is offered at the threshold, while the dispatch is open, once', () => {
  const base = { tokens: 150_000, window: 300_000, dispatchDone: false, active: false };
  assert.deepEqual(handoffOffer(base), { offer: true, used: 150_000, threshold: 150_000 });
  assert.equal(handoffOffer({ ...base, tokens: 149_999 }).offer, false);
  assert.equal(handoffOffer({ ...base, tokens: null }).offer, false);
  assert.equal(handoffOffer({ ...base, dispatchDone: true }).offer, false);
  assert.equal(handoffOffer({ ...base, active: true }).offer, false);
  for (const status of ['requested', 'ready', 'consumed'] as const) assert.equal(handoffOffer({ ...base, handoff: { status, at: '' } }).offer, false, status);
  assert.equal(handoffOffer({ ...base, handoff: { status: 'failed', at: '' } }).offer, true);
  assert.equal(handoffOffer({ ...base, tokens: 90_000, settings: { tokens: 80_000, windowPercent: 50 } }).offer, true);
});

test('the app request is recognised, and only the reply after it yields the summary', () => {
  const request = handoffRequestText();
  assert.equal(isHandoffRequest(request), true);
  assert.equal(isHandoffRequest(`${HANDOFF_REQUEST}\n补一句`), true);
  assert.equal(isHandoffRequest('请继续写人设。'), false);
  const summary = `${fence}交接摘要\n已定: A\n已写: B\n未完成: C\n第一步: D\n${fence}`;
  const at = '2026-09-19T00:00:00.000Z';
  const messages = [
    { id: 'u1', role: 'assistant' as const, text: summary, at },
    { id: 'r', role: 'user' as const, text: request, at },
    { id: 'a1', role: 'assistant' as const, text: `好的。\n\n${summary.replace('A', '新决定')}`, at },
  ];
  assert.equal(handoffFromReply(messages, 'r')?.decided, '新决定');
  assert.equal(handoffFromReply([...messages.slice(0, 2), { id: 'a1', role: 'assistant' as const, text: '我不写。', at }], 'r'), null);
  assert.equal(handoffFromReply(messages, 'missing'), null);
});
