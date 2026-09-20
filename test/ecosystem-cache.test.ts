import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createResources } from '../src/runtime/resources.ts';
import { loadCacheOptimizer } from '../src/runtime/ecosystem-cache.ts';

test('actual cache optimizer preserves prompts, strips unsupported proxy retention, persists actual cache usage locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cardwright-cache-'));
  const savedEnv = { ...process.env };
  let cleanup: (() => void) | undefined;
  try {
    const loaded = await loadCacheOptimizer({ cwd: dir, agentDir: dir });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].handlers.has('before_provider_request'));
    const resources = createResources(dir, dir, [], '');
    resources.getExtensions = () => loaded;
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('cardwright-test', async () => ({ type: 'api_key', key: 'test-only-key' }));
    const models = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    models.registerProvider('cardwright-test', { api: 'openai-completions', baseUrl: 'https://example.invalid/v1', authHeader: true, models: [{ id: 'gpt-test', name: 'GPT test', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    await models.refresh({ providers: ['cardwright-test'], allowNetwork: false });
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: models, model: models.getModel('cardwright-test', 'gpt-test'), tools: [], resourceLoader: resources, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory() });
    cleanup = () => session.dispose();
    await session.bindExtensions({ mode: 'rpc' });
    const runner = session.extensionRunner;
    const prompt = 'You are Cardwright. Permissions are enforced by the host.\n<session-overview>Do not reorder me.</session-overview>';
    const transformed = await runner.emitBeforeAgentStart('Hi', undefined, prompt, { cwd: dir });
    assert.ok(!transformed?.systemPrompt || transformed.systemPrompt === prompt);
    const payload = { model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], prompt_cache_retention: '24h' };
    const result = await runner.emitBeforeProviderRequest(payload) as Record<string, unknown>;
    assert.equal(result.prompt_cache_retention, undefined);
    assert.equal(result.prompt_cache_key, undefined);
    assert.deepEqual(result.messages, [{ role: 'user', content: 'Hi' }]);
    await runner.emitMessageEnd({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture response' }], api: 'openai-completions', provider: 'cardwright-test', model: 'gpt-test', timestamp: Date.now(), stopReason: 'stop', usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    const shards = readdirSync(join(dir, 'pi-cache-optimizer-stats.d', 'shards'));
    assert.ok(shards.length > 0);
    const data = shards.map(file => readFileSync(join(dir, 'pi-cache-optimizer-stats.d', 'shards', file), 'utf8')).join('');
    assert.match(data, /cardwright-test/);
    assert.doesNotMatch(data, /test-only-key|fixture response/);
  } finally {
    cleanup?.();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});
