import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import snapshotData from '../shared/model-snapshot.json';
import {
  matchModelSnapshot, toModelMatch, UNMATCHED_CONTEXT, UNMATCHED_OUTPUT,
  type ModelMatch, type ModelSnapshot, type ModelSnapshotEntry,
} from '../shared/model-metadata.ts';

/**
 * Resolves model parameters from models.dev.
 *
 * The bundled snapshot answers offline for the model families Cardwright targets. When a
 * model is not in it, `matchModel` may download models.dev once, cache a derived catalog
 * next to state.json, and look again. Every network failure is silent: the editor keeps
 * its safe defaults and the user can type the values by hand.
 */
const API_URL = 'https://models.dev/api.json';
const CACHE_FILE = 'model-metadata-cache.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REFERENCE_PROVIDERS = ['openai', 'anthropic', 'google', 'deepseek', 'zhipuai', 'zai', 'moonshotai', 'alibaba'];

interface CacheFile {
  version: number;
  fetchedAt: string;
  models: ModelSnapshotEntry[];
}

const bundled = snapshotData as ModelSnapshot;

function effortValues(model: { reasoning_options?: Array<{ type?: string; values?: string[] }> }): string[] {
  const values = new Set<string>();
  for (const option of model.reasoning_options ?? []) {
    if (option?.type !== 'effort') continue;
    for (const value of option.values ?? []) values.add(value);
  }
  return EFFORT_ORDER.filter(value => values.has(value));
}

function entryFromApiModel(provider: string, key: string, model: Record<string, unknown>): ModelSnapshotEntry {
  const limit = (model.limit ?? {}) as { context?: unknown; output?: unknown };
  const context = typeof limit.context === 'number' && limit.context >= 1_024 ? Math.min(limit.context, 10_000_000) : UNMATCHED_CONTEXT;
  const output = typeof limit.output === 'number' && limit.output > 0 ? limit.output : UNMATCHED_OUTPUT;
  const modalities = model.modalities as { input?: unknown } | undefined;
  return {
    id: `${provider}/${key}`,
    name: typeof model.name === 'string' ? model.name : key,
    group: typeof model.family === 'string' ? model.family : provider,
    family: typeof model.family === 'string' ? model.family : undefined,
    release: typeof model.release_date === 'string' ? model.release_date : undefined,
    context,
    output: Math.min(output, context),
    reasoning: model.reasoning === true,
    effort: effortValues(model as { reasoning_options?: Array<{ type?: string; values?: string[] }> }),
    input: Array.isArray(modalities?.input) ? (modalities.input as string[]) : ['text'],
  };
}

/**
 * api.json is provider-shaped and contains duplicates. The first provider that documents
 * a model wins, with the vendor's own provider tried first so limits and effort levels
 * come from the primary source rather than a reseller.
 */
function catalogFromApi(api: Record<string, { models?: Record<string, Record<string, unknown>> }>): ModelSnapshotEntry[] {
  const providers = Object.keys(api).sort((left, right) => {
    const leftRank = REFERENCE_PROVIDERS.indexOf(left);
    const rightRank = REFERENCE_PROVIDERS.indexOf(right);
    return (leftRank < 0 ? REFERENCE_PROVIDERS.length : leftRank) - (rightRank < 0 ? REFERENCE_PROVIDERS.length : rightRank);
  });
  const seen = new Set<string>();
  const models: ModelSnapshotEntry[] = [];
  for (const provider of providers) {
    for (const [key, model] of Object.entries(api[provider]?.models ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(entryFromApiModel(provider, key, model));
    }
  }
  return models;
}

export class ModelMetadataService {
  private cacheFile: string;
  private online?: ModelSnapshotEntry[];
  private onlineFetchedAt = 0;
  private loaded = false;
  private loading?: Promise<void>;
  private failedAt = 0;

  constructor(dataDir: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.cacheFile = join(dataDir, CACHE_FILE);
  }

  /** Bundled data, then one online attempt when allowed and needed. Never throws. */
  async matchModel(modelId: string, allowNetwork = true): Promise<ModelMatch | null> {
    const id = modelId.trim();
    if (!id) return null;

    const bundledMatch = matchModelSnapshot(bundled.models, id);
    if (bundledMatch) return toModelMatch(bundledMatch, 'bundled', bundled.generatedAt);

    if (!allowNetwork) return null;
    const online = await this.loadOnline();
    if (!online?.length) return null;
    const onlineMatch = matchModelSnapshot(online, id);
    return onlineMatch ? toModelMatch(onlineMatch, 'online', new Date(this.onlineFetchedAt || Date.now()).toISOString()) : null;
  }

  /** Forces one download and reports how many models the derived catalog holds. */
  async refresh(): Promise<{ ok: boolean; models: number; generatedAt?: string }> {
    this.failedAt = 0;
    this.online = undefined;
    this.loaded = false;
    const models = await this.loadOnline(true);
    // A failed download may still return the stale cache; only report success when the
    // request itself worked, so a caller can tell "refreshed" from "fell back".
    return models && !this.failedAt
      ? { ok: true, models: models.length, generatedAt: new Date(this.onlineFetchedAt).toISOString() }
      : { ok: false, models: models?.length ?? 0 };
  }

  private async loadOnline(force = false): Promise<ModelSnapshotEntry[] | null> {
    if (!force) {
      if (this.loaded) return this.online?.length ? this.online : null;
      if (this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_FAILURE_MS) return null;
    }
    if (this.loading) {
      await this.loading;
      return this.online?.length ? this.online : null;
    }
    this.loading = this.load(force);
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
    return this.online?.length ? this.online : null;
  }

  private async load(force = false): Promise<void> {
    if (!this.loaded) {
      this.loaded = true;
      const cached = await this.readCache();
      if (cached) {
        this.online = cached.models;
        this.onlineFetchedAt = Date.parse(cached.fetchedAt) || Date.now();
        // A forced refresh uses the cache as a fallback but still downloads.
        if (!force && Date.now() - this.onlineFetchedAt < CACHE_TTL_MS) return;
      }
    }
    try {
      const response = await this.fetchImpl(API_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}.`);
      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error('models.dev response is larger than expected.');
      const models = catalogFromApi(JSON.parse(text));
      if (!models.length) throw new Error('models.dev returned no models.');
      this.online = models;
      this.onlineFetchedAt = Date.now();
      this.failedAt = 0;
      await this.writeCache();
    } catch {
      // Offline, a proxy, or a schema change: keep the bundled answer and stay quiet.
      this.failedAt = Date.now();
      if (!this.online) {
        this.loaded = true;
      }
    }
  }

  private async readCache(): Promise<CacheFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as CacheFile;
      if (parsed?.version !== 1 || typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.models)) return null;
      // A truncated or hand-edited cache must not crash a lookup.
      const models = parsed.models.filter(model => model && typeof model === 'object'
        && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.group === 'string'
        && Number.isFinite(model.context) && Number.isFinite(model.output) && typeof model.reasoning === 'boolean'
        && Array.isArray(model.effort) && Array.isArray(model.input));
      return models.length ? { version: 1, fetchedAt: parsed.fetchedAt, models } : null;
    } catch {
      return null;
    }
  }

  private async writeCache(): Promise<void> {
    if (!this.online) return;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      const payload: CacheFile = { version: 1, fetchedAt: new Date(this.onlineFetchedAt).toISOString(), models: this.online };
      await writeFile(this.cacheFile, JSON.stringify(payload), 'utf8');
    } catch {
      // A cache that cannot be written still leaves the in-memory catalog usable.
    }
  }
}

export type { ModelMatch };
