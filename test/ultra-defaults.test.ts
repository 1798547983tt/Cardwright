import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../src/core/store.ts';

test('0.5 migrates older gateway defaults once and preserves later explicit choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-defaults-'));
  try {
    const gateway = { id: 'old', name: 'Old gateway', baseUrl: 'http://localhost:1234/v1', modelId: 'fixture', protocol: 'openai-completions', reasoning: true, contextWindow: 128000, maxTokens: 4096, hasKey: false, effortMap: { xhigh: null, max: null, ultra: 'ultra' } };
    await writeFile(join(root, 'state.json'), JSON.stringify({ gateways: [gateway, { ...gateway, id: 'new', defaultsVersion: 5, contextWindow: 500000, effortMap: { xhigh: null, max: 'highest', ultra: 'max' } }] }));
    const store = new AppStore(root);
    assert.equal(store.state.gateways[0].contextWindow, 300000);
    assert.deepEqual(store.state.gateways[0].effortMap, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' });
    assert.equal(store.state.gateways[1].contextWindow, 500000);
    assert.equal(store.state.gateways[1].effortMap?.xhigh, null);
    store.save();
    assert.deepEqual(new AppStore(root).state.gateways, store.state.gateways);
  } finally { await rm(root, { recursive: true, force: true }); }
});
