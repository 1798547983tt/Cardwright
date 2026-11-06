/**
 * Regenerates src/shared/model-snapshot.json from models.dev.
 *
 * The runtime ships this file so that model parameters can be filled in offline.
 * Only the model families Cardwright cares about are kept, and only the fields the
 * editor needs, which keeps the bundled snapshot around 40 KB instead of 6 MB.
 *
 * Run with: npm run snapshot:models
 */
import { writeFile } from 'node:fs/promises';
import { EFFORT_ORDER, REFERENCE_PROVIDERS, clampContext, clampOutput, effortValues } from '../src/shared/models-dev.ts';

const MODELS_URL = 'https://models.dev/models.json';
const API_URL = 'https://models.dev/api.json';

/** Families the snapshot keeps. `name` is the last path segment, e.g. "gpt-5.6-sol". */
const FAMILIES = [
  { family: 'deepseek', test: name => /^(?:deepseek-(?:v3|v4)|deepseek-chat-v3|deepseek-chat|deepseek-reasoner)/.test(name) },
  { family: 'openai', test: name => name.startsWith('gpt-5') },
  { family: 'claude', test: name => /^claude-(?:[a-z]+-)?(?:4|5)(?:-|$)/.test(name) },
  { family: 'gemini', test: name => /^gemini-(?:2\.5-(?:pro|flash)|3|4)/.test(name) },
  { family: 'glm', test: name => name.startsWith('glm-5') },
  { family: 'kimi', test: name => /^kimi-k(?:2\.[5-9]|3)/.test(name) },
  { family: 'qwen', test: name => /^qwen3\.[7-9]/.test(name) },
];

/** Non-chat endpoints that share a model family name but cannot be used in a conversation. */
const EXCLUDED = /(?:embedding|reranker|tts|transcribe|live-translate|computer-use|robotics|nano-banana|veo|imagen|realtime|whisper|-image)/;

// The bundled snapshot keeps a more generous output default than the editor's unmatched
// fallback, because a snapshot row has a real context window to fill into.
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 32_768;

/** API aliases whose own api.json row carries no effort list but that resolve to a known base model. */
const EFFORT_ALIASES = { 'deepseek-reasoner': 'deepseek-v4-pro' };

/** "claude-opus-4-1-20250805" and "gpt-4o-2024-08-06" resolve to their undated row. */
const stripDateSuffix = name => name.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');

async function readJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
      return JSON.parse(await response.text());
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Every api.json entry that describes this catalog row, including dated aliases. */
function apiCandidates(api, key, name) {
  const candidates = [];
  for (const [provider, entry] of Object.entries(api)) {
    for (const [modelKey, model] of Object.entries(entry?.models ?? {})) {
      const canonical = model?.canonical_model_id;
      if (modelKey === name || model?.id === key || canonical === key || canonical === name) candidates.push({ provider, model });
    }
  }
  return candidates;
}

/** Prefer the vendor's own entry; fall back to any provider that documents effort levels. */
function referenceEffort(api, key, name) {
  const aliased = EFFORT_ALIASES[name] ?? name;
  let candidates = apiCandidates(api, key, aliased);
  if (!candidates.some(candidate => effortValues(candidate.model).length)) {
    const undated = stripDateSuffix(aliased);
    if (undated !== aliased) candidates = candidates.concat(apiCandidates(api, key, undated));
  }
  for (const provider of REFERENCE_PROVIDERS) {
    for (const candidate of candidates) {
      if (candidate.provider !== provider) continue;
      const values = effortValues(candidate.model);
      if (values.length) return values;
    }
  }
  const union = new Set();
  for (const candidate of candidates) for (const value of effortValues(candidate.model)) union.add(value);
  return EFFORT_ORDER.filter(value => union.has(value));
}

function clampLimit(limit) {
  const context = clampContext(limit?.context, DEFAULT_CONTEXT);
  return { context, output: clampOutput(limit?.output, context, DEFAULT_OUTPUT) };
}

const [catalog, api] = await Promise.all([readJson(MODELS_URL), readJson(API_URL)]);
const models = [];
const seen = new Set();

for (const [key, model] of Object.entries(catalog)) {
  const name = key.split('/').pop();
  if (!name || seen.has(name) || EXCLUDED.test(name)) continue;
  const match = FAMILIES.find(entry => entry.test(name));
  if (!match) continue;

  seen.add(name);
  const { context, output } = clampLimit(model.limit);
  models.push({
    id: key,
    name: model.name || name,
    group: match.family,
    family: model.family || match.family,
    release: model.release_date,
    context,
    output,
    reasoning: model.reasoning === true,
    effort: referenceEffort(api, key, name),
    input: Array.isArray(model.modalities?.input) ? [...model.modalities.input] : ['text'],
  });
}

models.sort((a, b) => (a.id < b.id ? -1 : 1));

await writeFile(
  new URL('../src/shared/model-snapshot.json', import.meta.url),
  `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), source: 'https://models.dev', models }, null, 2)}\n`,
  'utf8',
);

console.log(`Wrote ${models.length} models to src/shared/model-snapshot.json.`);
