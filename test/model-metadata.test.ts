import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelMetadataService } from '../src/main/model-metadata-service.ts';
import {
  CODEX_PROXY_CONTEXT, MATCH_THRESHOLD, UNMATCHED_CONTEXT, UNMATCHED_OUTPUT,
  applyModelMatch, deriveModelDefaults, looksLikeChatGpt, matchModelSnapshot, modelNameSegment,
  normalizeModelName, toModelMatch, unmatchedModelDefaults, type ModelSnapshot, type ModelSnapshotEntry,
} from '../src/shared/model-metadata.ts';
import type { GatewayModel } from '../src/shared/types.ts';

const snapshot = JSON.parse(readFileSync(new URL('../src/shared/model-snapshot.json', import.meta.url), 'utf8')) as ModelSnapshot;

const entry = (changes: Partial<ModelSnapshotEntry> = {}): ModelSnapshotEntry => ({
  id: 'vendor/model-a', name: 'Model A', group: 'vendor',
  context: 200_000, output: 16_000, reasoning: true,
  effort: ['low', 'medium', 'high'], input: ['text', 'image'], ...changes,
});

test('model names are compared after trimming, dropping whitespace and lowercasing', () => {
  assert.equal(normalizeModelName(' GPT-5.6\n\tSol '), 'gpt-5.6sol');
  assert.equal(modelNameSegment('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(modelNameSegment('  openai/gpt-5.6-sol/  '), 'gpt-5.6-sol');
  assert.equal(modelNameSegment('bare-model'), 'bare-model');
});

test('exact, provider-prefixed, dated and fuzzy names all resolve deterministically', () => {
  const models = [entry(), entry({ id: 'vendor/model-a-20250101', name: 'Model A' })];

  const exact = matchModelSnapshot(models, 'vendor/model-a');
  assert.equal(exact?.entry.id, 'vendor/model-a');
  assert.equal(exact?.method, 'exact');
  assert.equal(exact?.confidence, 1);

  // A bare name selects the `provider/model` row by comparing the model segment.
  const segment = matchModelSnapshot(models, ' model-a ');
  assert.equal(segment?.entry.id, 'vendor/model-a');
  assert.equal(segment?.method, 'segment');

  // A date the snapshot does not list falls back to the undated row.
  const suffix = matchModelSnapshot([entry()], 'model-a-20990101');
  assert.equal(suffix?.entry.id, 'vendor/model-a');
  assert.equal(suffix?.method, 'suffix');

  // Whitespace inside the user's name is removed, then the fuzzy comparison runs.
  const fuzzy = matchModelSnapshot([entry({ id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' })], 'GPT-5.6 Sol');
  assert.equal(fuzzy?.entry.id, 'openai/gpt-5.6-sol');
  assert.equal(fuzzy?.method, 'fuzzy');
  assert.ok(fuzzy!.confidence >= MATCH_THRESHOLD);

  assert.equal(matchModelSnapshot([entry()], 'model-a-but-completely-different'), null);
  assert.equal(matchModelSnapshot([entry()], 'xy'), null);
  assert.equal(matchModelSnapshot([entry()], '   '), null);
  // A different version number blocks fuzzy matching even when the names are close.
  assert.equal(matchModelSnapshot([entry({ id: 'vendor/model-2.5-pro' })], 'model-1.5-pro'), null);
});

test('fuzzy matches are scored by similarity and ties break deterministically', () => {
  const long = entry({ id: 'vendor/model-a-extra', name: 'Model A extra' });
  const short = entry({ id: 'vendor/model-a', name: 'Model A' });
  // The closer id wins even though it is longer.
  assert.equal(matchModelSnapshot([long, short], 'model-a-extr')?.entry.id, 'vendor/model-a-extra');
  // Equal scores fall back to the lexicographically smaller id, whatever the snapshot order.
  const tied = [entry({ id: 'vendor/model-a1y' }), entry({ id: 'vendor/model-a1x' })];
  assert.equal(matchModelSnapshot(tied, 'model-a1z')?.entry.id, 'vendor/model-a1x');
  assert.equal(matchModelSnapshot([...tied].reverse(), 'model-a1z')?.entry.id, 'vendor/model-a1x');
});

test('derived defaults clamp output to context and keep only text and image inputs', () => {
  const derived = deriveModelDefaults(entry({ context: 100_000, output: 500_000, input: ['text', 'image', 'pdf', 'audio', 'video'] }));
  assert.equal(derived.contextWindow, 100_000);
  assert.equal(derived.maxTokens, 100_000);
  assert.deepEqual(derived.inputModalities, ['text', 'image']);

  assert.deepEqual(deriveModelDefaults(entry({ input: ['pdf', 'audio'] })).inputModalities, ['text']);
  assert.deepEqual(deriveModelDefaults(entry({ input: [] })).inputModalities, ['text']);
  assert.deepEqual(deriveModelDefaults(entry({ input: ['text', 'text'] })).inputModalities, ['text']);
  assert.equal(deriveModelDefaults(entry({ context: Number.NaN })).contextWindow, UNMATCHED_CONTEXT);
  assert.equal(deriveModelDefaults(entry({ context: 0 })).contextWindow, 1_024);
  assert.equal(deriveModelDefaults(entry({ output: 0 })).maxTokens, 1);
  assert.ok(UNMATCHED_OUTPUT <= UNMATCHED_CONTEXT);
  assert.equal(CODEX_PROXY_CONTEXT, 258_000);
});

test('effort maps only promise levels the provider documents', () => {
  const derived = deriveModelDefaults(entry({ effort: ['none', 'low', 'high', 'max'] }));
  assert.equal(derived.reasoning, true);
  assert.deepEqual(derived.effortMap, {
    off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max', ultra: 'max',
  });

  // Toggle-only and budget-only models are reported as non-reasoning, because the UI
  // has no separate switch for them; a note explains why.
  for (const effort of [[], ['minimal'], ['none']]) {
    const toggleOnly = deriveModelDefaults(entry({ effort }));
    assert.equal(toggleOnly.reasoning, false, effort.join(','));
    assert.equal(toggleOnly.effortMap, undefined);
    assert.equal(toggleOnly.reasoningNote, 'effort-levels-unavailable');
  }
  assert.equal(deriveModelDefaults(entry({ reasoning: false, effort: [] })).reasoningNote, undefined);
  assert.equal(deriveModelDefaults(entry({ reasoning: false, effort: ['low', 'high'] })).reasoning, false);
});

test('toModelMatch carries provenance for the editor hint', () => {
  const matched = matchModelSnapshot([entry({ id: 'vendor/model-a', release: '2026-01-02' })], 'model-a');
  assert.ok(matched);
  const result = toModelMatch(matched!, 'online', '2026-11-05T00:00:00.000Z');
  assert.equal(result.matchedId, 'vendor/model-a');
  assert.equal(result.matchedName, 'Model A');
  assert.equal(result.source, 'online');
  assert.equal(result.generatedAt, '2026-11-05T00:00:00.000Z');
  assert.equal(result.release, '2026-01-02');
  assert.equal(result.contextWindow, 200_000);
});

test('ChatGPT-family detection drives the Codex proxy hint', () => {
  for (const name of ['gpt-5.6-sol', 'GPT 5.6 Sol', 'openai/gpt-5-codex', 'codex-mini', 'o3', 'o4-mini']) {
    assert.equal(looksLikeChatGpt(name), true, name);
  }
  for (const name of ['claude-opus-4-5', 'gemini-3-pro', 'glm-5.3', 'qwen3.8-max']) {
    assert.equal(looksLikeChatGpt(name), false, name);
  }
});

test('bundled snapshot answers famous families without any network access', () => {
  for (const id of ['gpt-5.6-sol', 'claude-opus-4-5', 'gemini-2.5-pro', 'glm-5.3', 'kimi-k2.5', 'qwen3.7-max', 'deepseek-v4-pro']) {
    assert.ok(matchModelSnapshot(snapshot.models, id), id);
  }
  // Models older than the supported families stay unmatched instead of fuzzy-matching a successor.
  for (const id of ['gpt-4o', 'claude-3-5-sonnet-20241022', 'gemini-1.5-pro', 'glm-4-plus', 'qwen2.5-max']) {
    assert.equal(matchModelSnapshot(snapshot.models, id), null, id);
  }
});

test('the metadata service reports bundled matches and stays silent on a miss', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const service = new ModelMetadataService(directory);
  const match = await service.matchModel('openai/gpt-5.6-sol', false);
  assert.equal(match?.source, 'bundled');
  assert.equal(match?.matchedId, 'openai/gpt-5.6-sol');
  assert.ok(match!.confidence >= MATCH_THRESHOLD);
  assert.equal(await service.matchModel('   ', false), null);
  assert.equal(await service.matchModel('not-a-real-model-zzzz', false), null);
  // An offline miss must not create the online cache.
  assert.deepEqual(await readdir(directory), []);
});

test('a forced refresh downloads the catalog and later lookups use it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-online-'));
  let calls = 0;
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({
      openai: { models: { 'future-model': {
        name: 'Future Model', family: 'gpt-future', limit: { context: 500_000, output: 64_000 },
        reasoning: true, modalities: { input: ['text', 'image', 'pdf'] },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const service = new ModelMetadataService(directory, fetchImpl);
  const refreshed = await service.refresh();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.models, 1);
  assert.ok(await readdir(directory).then(files => files.includes('model-metadata-cache.json')));

  const match = await service.matchModel('future-model', true);
  assert.equal(match?.source, 'online');
  assert.equal(match?.matchedId, 'openai/future-model');
  assert.equal(match?.contextWindow, 500_000);
  assert.equal(match?.maxTokens, 64_000);
  assert.deepEqual(match?.inputModalities, ['text', 'image']);
  assert.deepEqual(match?.effortMap, { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null, ultra: null });

  // Forcing again must not stop at the fresh cache written by the first download.
  await service.refresh();
  assert.equal(calls, 2);
});

test('a failed refresh reports failure while a stale cache still answers lookups', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-stale-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (async () => { throw new Error('offline'); }) as typeof fetch;
  await writeFile(join(directory, 'model-metadata-cache.json'), JSON.stringify({
    version: 1, fetchedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    models: [entry({ id: 'vendor/cache-only', name: 'Cache only', context: 320_000, output: 16_000 })],
  }));

  const service = new ModelMetadataService(directory, fetchImpl);
  const refreshed = await service.refresh();
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.models, 1);
  assert.equal((await service.matchModel('cache-only', true))?.source, 'online');
});

test('a fresh cache answers an online lookup without a request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-cache-'));
  let calls = 0;
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (async () => { calls++; throw new Error('the cache should have answered'); }) as typeof fetch;
  await writeFile(join(directory, 'model-metadata-cache.json'), JSON.stringify({
    version: 1, fetchedAt: new Date().toISOString(),
    models: [entry({ id: 'vendor/cache-only', name: 'Cache only', context: 320_000, output: 16_000 })],
  }));

  const service = new ModelMetadataService(directory, fetchImpl);
  const match = await service.matchModel('cache-only', true);
  assert.equal(match?.source, 'online');
  assert.equal(match?.contextWindow, 320_000);
  assert.equal(calls, 0);
});

test('a failed online lookup is retried after the cooldown instead of failing for the session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-retry-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let now = Date.parse('2026-11-05T00:00:00.000Z');
  let calls = 0;
  let offline = true;
  const fetchImpl = (async () => {
    calls++;
    if (offline) throw new Error('offline');
    return new Response(JSON.stringify({
      openai: { models: { 'future-model': { name: 'Future Model', limit: { context: 500_000, output: 64_000 } } } },
    }), { status: 200 });
  }) as typeof fetch;

  const service = new ModelMetadataService(directory, fetchImpl, () => now);
  assert.equal(await service.matchModel('future-model', true), null);
  assert.equal(calls, 1);
  // Inside the cooldown the failed attempt is not repeated.
  assert.equal(await service.matchModel('future-model', true), null);
  assert.equal(calls, 1);

  offline = false;
  now += 10 * 60 * 1000;
  const match = await service.matchModel('future-model', true);
  assert.equal(match?.source, 'online');
  assert.equal(match?.matchedId, 'openai/future-model');
  assert.equal(calls, 2);
});

test('a stale cache answers during the cooldown and a later lookup retries the download', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-stale-retry-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let now = Date.parse('2026-11-05T00:00:00.000Z');
  let calls = 0;
  let offline = true;
  const fetchImpl = (async () => {
    calls++;
    if (offline) throw new Error('offline');
    return new Response(JSON.stringify({
      openai: { models: { 'fresh-model': { name: 'Fresh Model', limit: { context: 400_000, output: 32_000 } } } },
    }), { status: 200 });
  }) as typeof fetch;
  await writeFile(join(directory, 'model-metadata-cache.json'), JSON.stringify({
    version: 1, fetchedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    models: [entry({ id: 'vendor/cache-only', name: 'Cache only', context: 320_000, output: 16_000 })],
  }));

  const service = new ModelMetadataService(directory, fetchImpl, () => now);
  // The stale cache answers even though the refresh failed, and the request was attempted once.
  assert.equal((await service.matchModel('cache-only', true))?.source, 'online');
  assert.equal(calls, 1);
  assert.equal((await service.matchModel('cache-only', true))?.source, 'online');
  assert.equal(calls, 1);

  offline = false;
  now += 10 * 60 * 1000;
  assert.equal((await service.matchModel('fresh-model', true))?.source, 'online');
  assert.equal(calls, 2);
});

test('refresh waits for an in-flight lookup and then forces a new download', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-model-metadata-refresh-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) await gate;
    return new Response(JSON.stringify({
      openai: { models: { 'future-model': { name: 'Future Model', limit: { context: 500_000, output: 64_000 } } } },
    }), { status: 200 });
  }) as typeof fetch;

  const service = new ModelMetadataService(directory, fetchImpl);
  const first = service.matchModel('future-model', true);
  const refreshed = service.refresh();
  release();
  await first;
  const result = await refreshed;
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

const gatewayModel = (changes: Partial<GatewayModel> = {}): GatewayModel => ({
  id: 'vendor/model-a', reasoning: false, contextWindow: 128_000, maxTokens: 8_192, autoMatch: true, ...changes,
});

test('applying a match respects Codex proxies and leaves unchecked models alone', () => {
  const matched = matchModelSnapshot([entry({ context: 200_000, output: 16_000, input: ['text'] })], 'model-a');
  const match = toModelMatch(matched!, 'bundled', '2026-11-05T00:00:00.000Z');

  const plain = applyModelMatch(gatewayModel(), match);
  assert.equal(plain.contextWindow, 200_000);
  assert.equal(plain.maxTokens, 16_000);
  assert.deepEqual(plain.inputModalities, ['text']);

  const codex = applyModelMatch(gatewayModel({ codexProxy: true, contextWindow: 300_000 }), match);
  assert.equal(codex.contextWindow, CODEX_PROXY_CONTEXT);
  assert.equal(codex.maxTokens, Math.min(16_000, CODEX_PROXY_CONTEXT));

  const manual = gatewayModel({ autoMatch: false, contextWindow: 300_000 });
  assert.equal(applyModelMatch(manual, match), manual);
});

test('unmatched defaults keep a Codex window and clear reasoning', () => {
  const plain = unmatchedModelDefaults(gatewayModel({ contextWindow: 300_000 }));
  assert.equal(plain.contextWindow, UNMATCHED_CONTEXT);
  assert.equal(plain.maxTokens, Math.min(UNMATCHED_OUTPUT, UNMATCHED_CONTEXT));
  assert.equal(plain.reasoning, false);
  assert.equal(plain.effortMap, undefined);
  assert.deepEqual(plain.inputModalities, ['text', 'image']);

  const codex = unmatchedModelDefaults(gatewayModel({ codexProxy: true }));
  assert.equal(codex.contextWindow, CODEX_PROXY_CONTEXT);
  assert.equal(codex.maxTokens, Math.min(UNMATCHED_OUTPUT, CODEX_PROXY_CONTEXT));
});
