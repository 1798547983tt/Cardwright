import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_WRITE_END, BATCH_WRITE_START, BRIEF_READ_END, BRIEF_READ_START, DEFAULT_CARD_OPTIMIZATION, batchWriteRule, cardOptimizationFrom, cardOptimizationFromLegacy, effectiveContinueRounds, effectiveWritesPerRound, optimizationActive, optimizedBatchRule, sectionBriefEnabled, sectionBriefRule } from '../src/shared/card-studio/card-optimization.ts';
import { CONTINUE_LIMIT, continueRounds } from '../src/shared/card-studio/run.ts';

test('the shipped optimization is on with two files, 15 rounds, 100K and no brief', () => {
  assert.deepEqual(DEFAULT_CARD_OPTIMIZATION, { enabled: true, maxWritesPerRound: 2, maxContinueRounds: 15, handoffEnabled: false, handoffTokens: 100_000, sectionBrief: false, defaultsVersion: 2 });
  assert.equal(optimizationActive(DEFAULT_CARD_OPTIMIZATION), true);
  assert.equal(effectiveWritesPerRound(DEFAULT_CARD_OPTIMIZATION), 2);
  assert.equal(effectiveContinueRounds(DEFAULT_CARD_OPTIMIZATION), 15);
  assert.equal(continueRounds(DEFAULT_CARD_OPTIMIZATION), 15);
  assert.equal(sectionBriefEnabled(DEFAULT_CARD_OPTIMIZATION), false);
});

test('off restores one file, the shipped round limit and no section brief', () => {
  const off = { ...DEFAULT_CARD_OPTIMIZATION, enabled: false, sectionBrief: true };
  assert.equal(optimizationActive(off), false);
  assert.equal(effectiveWritesPerRound(off), 1);
  assert.equal(effectiveContinueRounds(off), undefined);
  assert.equal(continueRounds(off), CONTINUE_LIMIT);
  assert.equal(sectionBriefEnabled(off), false);
  assert.equal(continueRounds(undefined), CONTINUE_LIMIT);
});

test('the settings accept exactly the allowed ranges and reject everything else', () => {
  assert.deepEqual(cardOptimizationFrom({ enabled: true, maxWritesPerRound: null, maxContinueRounds: 10, handoffEnabled: false, handoffTokens: 50_000, sectionBrief: true })!.maxWritesPerRound, null);
  assert.equal(cardOptimizationFrom({ maxWritesPerRound: 8 })!.maxWritesPerRound, 8);
  assert.equal(cardOptimizationFrom({ maxContinueRounds: 50 })!.maxContinueRounds, 50);
  assert.equal(cardOptimizationFrom({ handoffTokens: 1_000_000 })!.handoffTokens, 1_000_000);
  for (const value of [{ maxWritesPerRound: 0 }, { maxWritesPerRound: 9 }, { maxWritesPerRound: 1.5 }, { maxContinueRounds: 9 }, { maxContinueRounds: 51 }, { handoffTokens: 49_999 }, { handoffTokens: 1_000_001 }, { enabled: 'yes' }, { sectionBrief: 1 }, null, []]) {
    assert.equal(cardOptimizationFrom(value), undefined, JSON.stringify(value));
  }
});

test('the first load after 1.3 seeds the configuration from the old switch and 换对话 settings', () => {
  assert.deepEqual(cardOptimizationFromLegacy({ tokenOptimizer: true, handoff: { tokens: 250_000, enabled: false } }), { ...DEFAULT_CARD_OPTIMIZATION, enabled: true, handoffTokens: 250_000, handoffEnabled: false });
  assert.deepEqual(cardOptimizationFromLegacy({ tokenOptimizer: false }), { ...DEFAULT_CARD_OPTIMIZATION, enabled: false });
  assert.deepEqual(cardOptimizationFromLegacy({ handoff: { tokens: 10_000 } }), { ...DEFAULT_CARD_OPTIMIZATION, handoffTokens: 50_000 }, 'an old value outside the new range is clamped');
  assert.deepEqual(cardOptimizationFromLegacy({ handoff: { tokens: 10_000_000 } }), { ...DEFAULT_CARD_OPTIMIZATION, handoffTokens: 1_000_000 });
  assert.deepEqual(cardOptimizationFromLegacy({}), DEFAULT_CARD_OPTIMIZATION, 'nothing saved means the new defaults');
});

test('the batch rule follows the configured number, with 不限 as its own rule', () => {
  assert.match(batchWriteRule(1), /一次只写一个文件/);
  assert.match(batchWriteRule(2), /一轮最多写 2 个文件/);
  assert.match(batchWriteRule(8), /一轮最多写 8 个文件/);
  assert.match(batchWriteRule(null), /一轮按需要写/);
  assert.doesNotMatch(batchWriteRule(null), /一次只写一个文件/);
});

test('the batch rule is replaced only inside its markers, and the markers disappear either way', () => {
  const text = `before\n${BATCH_WRITE_START}\n- old rule\n${BATCH_WRITE_END}\nafter`;
  const optimized = optimizedBatchRule(text, DEFAULT_CARD_OPTIMIZATION);
  assert.ok(optimized.includes('一轮最多写 2 个文件'));
  assert.ok(!optimized.includes('- old rule'));
  assert.ok(!optimized.includes(BATCH_WRITE_START));
  assert.ok(!optimized.includes(BATCH_WRITE_END));
  assert.ok(optimized.startsWith('before\n'));
  assert.ok(optimized.endsWith('\nafter'));
  assert.equal(optimizedBatchRule(text, { ...DEFAULT_CARD_OPTIMIZATION, enabled: false }), 'before\n- old rule\nafter');
  assert.equal(optimizedBatchRule('- 用户自己的规则。', DEFAULT_CARD_OPTIMIZATION), '- 用户自己的规则。');
  assert.equal(optimizedBatchRule(`${BATCH_WRITE_START}\n- 未闭合`, DEFAULT_CARD_OPTIMIZATION), `${BATCH_WRITE_START}\n- 未闭合`);
});

test('the section brief rule replaces the read-first list only when both switches are on', () => {
  const text = `## 开工必读\n\n${BRIEF_READ_START}\n每次开工先读：\n1. 设计书\n${BRIEF_READ_END}\n`;
  const on = sectionBriefRule(text, { ...DEFAULT_CARD_OPTIMIZATION, sectionBrief: true });
  assert.match(on, /先读派单里附的「本次派单摘要」和参考行/);
  assert.doesNotMatch(on, /每次开工先读/);
  assert.ok(!on.includes(BRIEF_READ_START));
  const off = sectionBriefRule(text, DEFAULT_CARD_OPTIMIZATION);
  assert.match(off, /每次开工先读/);
  assert.ok(!off.includes(BRIEF_READ_START));
});
