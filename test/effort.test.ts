import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSimple, type Model } from '@earendil-works/pi-ai/compat';
import { availableEfforts, defaultEffortMap, effectiveEffort, validateGatewayEffort } from '../src/shared/effort.ts';
import type { Gateway, ThinkingLevel } from '../src/shared/types.ts';

const gateway: Gateway = { id: 'probe', name: 'Probe gateway', modelId: 'configured-model', baseUrl: 'https://invalid.example/v1', protocol: 'openai-completions', reasoning: true, maxTokens: 24000, contextWindow: 64000, hasKey: false };

test('all six reasoning tiers have request defaults, Ultra shares max and saved overrides remain explicit', () => {
  assert.deepEqual(availableEfforts(gateway), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  for (const [selected, providerValue] of Object.entries(defaultEffortMap)) assert.deepEqual(effectiveEffort(gateway, selected as ThinkingLevel), { level: selected === 'ultra' ? 'max' : selected, providerValue });
  const mapped = { ...gateway, effortMap: { xhigh: 'extra', max: 'maximum', ultra: 'maximum' } };
  assert.deepEqual(availableEfforts(mapped), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(effectiveEffort(mapped, 'ultra'), { level: 'max', providerValue: 'maximum' });
  assert.deepEqual(effectiveEffort(mapped, 'max'), { level: 'max', providerValue: 'maximum' });
  assert.deepEqual(effectiveEffort(mapped, 'xhigh'), { level: 'xhigh', providerValue: 'extra' });
  assert.throws(() => validateGatewayEffort({ ...gateway, effortMap: { ultra: 'bad\nvalue' } }), /provider value/);
  assert.throws(() => effectiveEffort({ ...gateway, effortMap: { high: null } }, 'high'), /does not declare support/);
  assert.deepEqual(availableEfforts({ ...gateway, reasoning: false }), ['off']);
});

test('legacy Anthropic remains budget based; extended tiers require explicit adaptive mode', () => {
  const legacy: Gateway = { ...gateway, protocol: 'anthropic-messages' };
  assert.deepEqual(availableEfforts(legacy), ['low', 'medium', 'high']);
  assert.deepEqual(effectiveEffort(legacy, 'high'), { level: 'high' });
  assert.throws(() => effectiveEffort(legacy, 'ultra'), /does not declare support/);
  assert.throws(() => validateGatewayEffort({ ...legacy, effortMap: { ultra: 'max' } }), /adaptive-thinking/);
  assert.deepEqual(effectiveEffort({ ...legacy, adaptiveThinking: true, effortMap: { ultra: 'max' } }, 'ultra'), { level: 'max', providerValue: 'max' });
});

test('installed runtime emits default provider effort for all six tiers without network access', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    for (const selected of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as ThinkingLevel[]) {
      const config: Gateway = { ...gateway, protocol: api, adaptiveThinking: api === 'anthropic-messages' };
      const effort = effectiveEffort(config, selected);
      const model: Model<typeof api> = { id: config.modelId, name: config.modelId, provider: 'cardwright-probe', api, baseUrl: config.baseUrl, reasoning: true, input: ['text'], contextWindow: config.contextWindow, maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { [effort.level]: effort.providerValue }, compat: api === 'anthropic-messages' ? { forceAdaptiveThinking: true } : {} };
      let payload: Record<string, unknown> | undefined;
      const response = await completeSimple(model, { messages: [{ role: 'user', content: 'Capture only', timestamp: 0 }] }, { apiKey: 'fixture-not-a-real-key', reasoning: effort.level === 'off' ? undefined : effort.level, onPayload: value => { payload = value as Record<string, unknown>; throw new Error('CAPTURE_ONLY_NO_NETWORK'); } });
      assert.equal(response.errorMessage, 'CAPTURE_ONLY_NO_NETWORK');
      const actual = api === 'openai-completions' ? payload?.reasoning_effort : api === 'openai-responses' ? (payload?.reasoning as { effort: string })?.effort : (payload?.output_config as { effort: string })?.effort;
      assert.equal(actual, effort.providerValue, `${api}/${selected}`);
      if (selected === 'ultra') assert.equal(actual, 'max');
    }
  }
});
