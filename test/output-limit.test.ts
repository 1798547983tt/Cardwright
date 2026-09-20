import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS, lowerEffort, nextOutputLimit } from '../src/shared/output-limit.ts';

test('raising the output limit goes to 128K first, then doubles within the context window', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 128000);
  assert.equal(LEGACY_DEFAULT_MAX_OUTPUT_TOKENS, 8192);
  assert.equal(nextOutputLimit(8192, 300000), 128000);
  assert.equal(nextOutputLimit(128000, 300000), 256000);
  assert.equal(nextOutputLimit(256000, 300000), 300000);
  assert.equal(nextOutputLimit(300000, 300000), undefined);
  assert.equal(nextOutputLimit(8192, 64000), 64000);
});

test('lowering effort moves to the next level that sends a different provider value', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
  const map = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' };
  assert.equal(lowerEffort('ultra', map, [...all]), 'xhigh');
  assert.equal(lowerEffort('max', map, [...all]), 'xhigh');
  assert.equal(lowerEffort('high', map, [...all]), 'medium');
  assert.equal(lowerEffort('low', map, ['low', 'medium']), undefined);
  assert.equal(lowerEffort('high', { ...map, medium: 'high' }, ['low', 'medium', 'high']), 'low');
  assert.equal(lowerEffort('max', { ...map, xhigh: 'max' }, [...all]), 'high');
  assert.equal(lowerEffort('high', map, ['high']), undefined);
});
