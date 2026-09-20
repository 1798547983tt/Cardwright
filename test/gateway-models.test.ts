import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AppStore } from '../src/core/store.ts';
import { gatewayModels, normalizeGatewayModels, resolveGatewayModel } from '../src/shared/gateway-models.ts';
import type { Gateway, GatewayModel } from '../src/shared/types.ts';

const gateway = (changes: Partial<Gateway> = {}): Gateway => ({
  id: 'connection-a', name: 'Connection A', baseUrl: 'https://example.invalid/v1',
  protocol: 'openai-completions', modelId: 'model-a', reasoning: true,
  contextWindow: 300000, maxTokens: 8192, hasKey: true, defaultsVersion: 5,
  effortMap: { high: 'high', xhigh: null, max: 'highest', ultra: 'max' }, ...changes,
});
const model = (id: string, changes: Partial<GatewayModel> = {}): GatewayModel => ({
  id, reasoning: true, contextWindow: 300000, maxTokens: 8192, ...changes,
});

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cardwright-model-catalog-'));
  t.after(async () => {
    assert.ok(relative(tmpdir(), path).startsWith('cardwright-model-catalog-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test('legacy single-model state gains a catalog and pins task, schedule, and default selections', async t => {
  const path = await directory(t);
  const message = { id: 'response', role: 'assistant', text: 'Original answer', model: 'historic-provider-alias', at: '2026-09-16T01:00:00Z' };
  const task = { id: 'task', gatewayId: 'connection-a', status: 'completed', messages: [message], tools: [], sessionFile: 'session.jsonl' };
  await writeFile(join(path, 'state.json'), JSON.stringify({
    preferences: { name: 'My name', defaultGatewayId: 'connection-a' },
    gateways: [gateway({ contextWindow: 500000 }), gateway({ id: 'connection-b', name: 'Separate credentials' })],
    tasks: [task], schedules: [{ id: 'schedule', gatewayId: 'connection-a', prompt: 'Keep the schedule', enabled: true }],
  }));
  const store = new AppStore(path);
  assert.deepEqual(store.state.gateways.map(item => item.id), ['connection-a', 'connection-b']);
  assert.deepEqual(store.state.gateways[0].models?.map(item => item.id), ['model-a']);
  assert.equal(store.state.gateways[0].hasKey, true);
  assert.equal(store.state.gateways[0].models?.[0].effortMap?.xhigh, null);
  assert.equal(store.state.tasks[0].modelId, 'model-a');
  assert.equal(store.state.tasks[0].contextWindow, 500000);
  assert.deepEqual(store.state.tasks[0].messages, [message]);
  assert.equal(store.state.tasks[0].sessionFile, task.sessionFile);
  assert.equal(store.state.schedules[0].modelId, 'model-a');
  assert.equal(store.state.schedules[0].contextWindow, 500000);
  assert.equal(store.state.preferences.defaultModelId, 'model-a');
  assert.equal(store.state.preferences.defaultContextWindow, 500000);
  store.save();
  const reopened = new AppStore(path);
  assert.deepEqual(reopened.state, store.state);
});

test('model capability and context selection stay local to the chosen model and connection', () => {
  const a = model('shared-name', { contextWindow: 500000, effortMap: { max: 'model-a-max' }, nativeSearch: { enabled: true, responsesUrl: 'https://example.invalid/v1/responses' } });
  const b = model('model-b', { reasoning: false, contextWindow: 1000000, maxTokens: 32000 });
  const source = gateway({ modelId: a.id, models: [a, b] });
  const before = structuredClone(source);
  const selected = resolveGatewayModel(source, b.id, 300000);
  assert.equal(selected.id, source.id);
  assert.equal(selected.baseUrl, source.baseUrl);
  assert.equal(selected.modelId, b.id);
  assert.equal(selected.reasoning, false);
  assert.equal(selected.nativeSearch, undefined);
  assert.equal(selected.effortMap, undefined);
  assert.equal(selected.contextWindow, 300000);
  assert.equal(selected.maxTokens, 32000);
  assert.equal(resolveGatewayModel(source).modelId, a.id);
  assert.equal(resolveGatewayModel(source, a.id).contextWindow, 500000);
  assert.equal(resolveGatewayModel(gateway({ id: 'connection-b', modelId: a.id, models: [model(a.id, { contextWindow: 1000000 })] }), a.id).id, 'connection-b');
  assert.deepEqual(source, before);
  selected.effortMap = { high: 'changed' };
  const listed = gatewayModels(source); listed[0].effortMap!.max = 'mutated'; listed[0].nativeSearch!.enabled = false;
  assert.deepEqual(source, before);
});

test('an explicit removed model never falls back to a different model', async t => {
  const source = gateway({ models: [model('model-a')] });
  assert.throws(() => resolveGatewayModel(source, 'removed'), /no longer configured/);
  assert.throws(() => resolveGatewayModel(source, ''), /no longer configured/);
  assert.throws(() => resolveGatewayModel(gateway({ models: [] })), /no configured models/);
  const path = await directory(t);
  await writeFile(join(path, 'state.json'), JSON.stringify({
    gateways: [source], preferences: { defaultGatewayId: source.id, defaultModelId: 'removed', defaultContextWindow: 1000000 },
    tasks: [{ id: 'task', gatewayId: source.id, modelId: 'removed', contextWindow: 500000, status: 'completed', messages: [], tools: [] }],
    schedules: [{ id: 'schedule', gatewayId: source.id, modelId: 'removed', contextWindow: 1000000 }],
  }));
  const store = new AppStore(path); store.save();
  const reopened = new AppStore(path);
  assert.equal(reopened.state.preferences.defaultModelId, 'removed');
  assert.equal(reopened.state.tasks[0].modelId, 'removed');
  assert.equal(reopened.state.tasks[0].contextWindow, 500000);
  assert.equal(reopened.state.schedules[0].modelId, 'removed');
  assert.equal(reopened.state.schedules[0].contextWindow, 1000000);
});

test('catalog validation rejects duplicate or invalid entries without accepting model credentials', async t => {
  const source = gateway();
  assert.throws(() => normalizeGatewayModels({ ...source, models: [] }), /between 1 and 200/);
  assert.throws(() => normalizeGatewayModels({ ...source, models: Array.from({ length: 201 }, (_, index) => model(`m${index}`)) }), /between 1 and 200/);
  assert.throws(() => normalizeGatewayModels({ ...source, models: [model('a'), model(' a ')] }), /already included/);
  for (const invalid of ['', '  ', 'bad\nmodel', 'x'.repeat(201)]) assert.throws(() => normalizeGatewayModels({ ...source, models: [model(invalid)] }), /model ID/);
  assert.throws(() => normalizeGatewayModels({ ...source, models: [model('a', { contextWindow: 1000 })] }), /Context window/);
  assert.throws(() => normalizeGatewayModels({ ...source, models: [model('a', { maxTokens: 999999 })] }), /output tokens/);
  const injected = { ...model(' provider/model:1 '), apiKey: 'model-secret', nativeSearch: { enabled: false, token: 'nested-secret' } };
  const normalized = normalizeGatewayModels({ ...source, models: [injected] });
  assert.equal(normalized[0].id, 'provider/model:1');
  assert.equal(normalized[0].effortMap?.ultra, 'max');
  assert.ok(!JSON.stringify(normalized).includes('secret'));
  const path = await directory(t);
  const store = new AppStore(path);
  store.state.gateways.push({ ...source, models: [injected] }); store.save();
  assert.ok(!(await readFile(store.filePath, 'utf8')).includes('secret'));
  assert.equal(new AppStore(path).state.gateways[0].modelId, 'provider/model:1');
});

test('context presets and custom values resolve without changing model defaults', () => {
  const source = gateway({ maxTokens: 65536 });
  for (const value of [300000, 500000, 1000000, 128000]) assert.equal(resolveGatewayModel(source, undefined, value).contextWindow, value);
  assert.equal(resolveGatewayModel(source, undefined, 8192).maxTokens, 8192);
  assert.equal(source.maxTokens, 65536);
  assert.equal(source.contextWindow, 300000);
  for (const value of [0, -1, 1023, 10_000_001, 300000.5, NaN, Infinity]) assert.throws(() => resolveGatewayModel(source, undefined, value), /Context window/);
});

test('new catalog models preserve independent Anthropic reasoning capabilities', () => {
  const source = gateway({ protocol: 'anthropic-messages', models: [
    model('legacy'), model('adaptive', { adaptiveThinking: true, effortMap: { max: 'max' } }),
  ] });
  const normalized = normalizeGatewayModels(source);
  assert.equal(normalized[0].effortMap, undefined);
  assert.equal(normalized[1].effortMap?.xhigh, 'xhigh');
  assert.throws(() => normalizeGatewayModels({ ...source, models: [model('legacy', { effortMap: { max: 'max' } })] }), /adaptive-thinking/);
});
