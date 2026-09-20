import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppStore } from '../src/core/store.ts';

const effortMap = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' };
const model = (id: string, maxTokens: number, contextWindow = 300000) => ({ id, reasoning: true, contextWindow, maxTokens, effortMap });

test('only legacy 8192 output limits migrate to 128K, bounded by context, once, with a notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-migrate-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, gateways: [{
      id: 'g', name: 'deepseek', baseUrl: 'https://example.invalid', modelId: 'a', protocol: 'openai-completions',
      reasoning: true, contextWindow: 300000, maxTokens: 8192, hasKey: true, defaultsVersion: 5, effortMap,
      models: [model('a', 8192), model('b', 4096), model('c', 8192, 64000)],
    }] }));
    const store = new AppStore(dir);
    const gateway = store.state.gateways[0];
    assert.deepEqual(gateway.models!.map(item => item.maxTokens), [128000, 4096, 64000]);
    assert.equal(gateway.maxTokens, 128000, 'the resolved default model follows its migrated limit');
    assert.deepEqual(store.state.preferences.migrationNotice, { kind: 'output-limit', models: ['deepseek / a', 'deepseek / c'] });
    store.save();
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.gateways[0].defaultsVersion, 6);
    assert.deepEqual(saved.preferences.migrationNotice, { kind: 'output-limit', models: ['deepseek / a', 'deepseek / c'] });

    // A later, deliberate 8192 must survive restarts: migration runs once per gateway.
    saved.gateways[0].models[1].maxTokens = 8192;
    delete saved.preferences.migrationNotice;
    await writeFile(join(dir, 'state.json'), JSON.stringify(saved));
    const again = new AppStore(dir);
    assert.deepEqual(again.state.gateways[0].models!.map(item => item.maxTokens), [128000, 8192, 64000]);
    assert.equal(again.state.preferences.migrationNotice, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy single-model gateways migrate and invalid notices are dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-migrate-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7,
      preferences: { migrationNotice: { kind: 'unknown', models: [1] } },
      gateways: [{ id: 'g', name: 'gpt', baseUrl: 'https://example.invalid/v1', modelId: 'm', protocol: 'openai-completions', reasoning: true, contextWindow: 300000, maxTokens: 8192, hasKey: true, defaultsVersion: 5, effortMap }] }));
    const store = new AppStore(dir);
    assert.equal(store.state.gateways[0].maxTokens, 128000);
    assert.deepEqual(store.state.preferences.migrationNotice, { kind: 'output-limit', models: ['gpt / m'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
