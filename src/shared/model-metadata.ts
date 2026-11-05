import type { ModelInputModality, ThinkingLevel } from './types.ts';

/**
 * Model parameters from models.dev, distilled to the fields Cardwright's editor needs.
 * `scripts/build-model-snapshot.mjs` generates the bundled file; the online fallback
 * produces the same shape, so matching and derivation stay in one place.
 */
export interface ModelSnapshotEntry {
  /** Full models.dev id, e.g. "openai/gpt-5.6-sol". */
  id: string;
  name: string;
  /** Coarse family: deepseek, openai, claude, gemini, glm, kimi, qwen. Kept for inspection; matching uses ids. */
  group: string;
  family?: string;
  release?: string;
  context: number;
  output: number;
  reasoning: boolean;
  /** models.dev effort values, already ordered none → max. Empty when the vendor documents none. */
  effort: string[];
  /** Raw input modalities; only text and image are usable by the runtime. */
  input: string[];
}

export interface ModelSnapshot {
  version: number;
  generatedAt: string;
  source: string;
  models: ModelSnapshotEntry[];
}

export type MatchMethod = 'exact' | 'segment' | 'suffix' | 'fuzzy';

export interface MatchedModel {
  entry: ModelSnapshotEntry;
  /** 1 for exact matches, otherwise the normalized edit similarity. */
  confidence: number;
  method: MatchMethod;
}

export interface DerivedModelDefaults {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  effortMap?: Partial<Record<ThinkingLevel, string | null>>;
  inputModalities: ModelInputModality[];
  /** Set when the model reasons but exposes only a toggle or token budget, which this UI cannot drive. */
  reasoningNote?: 'effort-levels-unavailable';
}

export interface ModelMatch extends DerivedModelDefaults {
  /** models.dev id that produced these values. */
  matchedId: string;
  matchedName: string;
  confidence: number;
  method: MatchMethod;
  source: 'bundled' | 'online';
  generatedAt: string;
  release?: string;
}

/** Below this the matcher returns nothing rather than guessing. */
export const MATCH_THRESHOLD = 0.85;
/** Values written when nothing matched; the user can uncheck auto-match and edit them. */
export const UNMATCHED_CONTEXT = 128_000;
export const UNMATCHED_OUTPUT = 8_192;
/** Codex reverse proxies front a 258K window regardless of what models.dev reports. */
export const CODEX_PROXY_CONTEXT = 258_000;

const MATCHABLE_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const TAG_SUFFIX = /-(?:latest|preview)$/;

/** Trim, drop whitespace and newlines, then lowercase: the comparison the requirement asks for. */
export function normalizeModelName(value: string): string {
  return value.replace(/[\s\u0000-\u001f\u007f]+/g, '').toLowerCase();
}

/** "openai/gpt-5.6-sol" → "gpt-5.6-sol"; a bare name is returned unchanged. */
export function modelNameSegment(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

/** Repeats date/tag stripping so "gpt-5-latest-20250101" collapses to "gpt-5". */
function withoutSuffix(name: string): string {
  let current = name;
  for (;;) {
    const next = current.replace(DATE_SUFFIX, '').replace(TAG_SUFFIX, '');
    if (next === current) return current;
    current = next;
  }
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
}

/**
 * The first version number in a model name ("gemini-2.5-pro" → "2.5").
 *
 * Fuzzy matching alone cannot tell a predecessor from a typo: "gemini-1.5-pro" is
 * within edit distance of "gemini-2.5-pro". Requiring the leading version to agree
 * keeps an outdated name unmatched instead of borrowing a successor's limits.
 */
function leadingVersion(name: string): string | undefined {
  return /\d+(?:\.\d+)*/.exec(name)?.[0];
}

function versionConflict(left: string, right: string): boolean {
  const a = leadingVersion(left);
  const b = leadingVersion(right);
  return a !== undefined && b !== undefined && a !== b;
}

interface PreparedEntry {
  entry: ModelSnapshotEntry;
  full: string;
  segment: string;
  base: string;
}

function prepare(entry: ModelSnapshotEntry): PreparedEntry {
  const segment = normalizeModelName(modelNameSegment(entry.id));
  return { entry, full: normalizeModelName(entry.id), segment, base: withoutSuffix(segment) };
}

/**
 * Matches a provider's model id against the snapshot.
 *
 * Order: the full id (a "provider/model" input), then the model segment, then the
 * segment without date/preview tags, and only then a fuzzy comparison above
 * MATCH_THRESHOLD. Fuzzy candidates must share the leading version number, so a
 * legacy name does not borrow its successor's limits. Ties prefer the shorter id,
 * then the smaller id, so the result does not depend on snapshot order.
 */
export function matchModelSnapshot(models: ModelSnapshotEntry[], raw: string): MatchedModel | null {
  const normalized = normalizeModelName(modelNameSegment(raw));
  if (!normalized) return null;
  const base = withoutSuffix(normalized);
  const prepared = models.map(prepare);
  const fullNormalized = normalizeModelName(raw);

  const exact = prepared.find(item => item.full === fullNormalized);
  if (exact) return { entry: exact.entry, confidence: 1, method: 'exact' };

  const segment = prepared.find(item => item.segment === normalized);
  if (segment) return { entry: segment.entry, confidence: 1, method: 'segment' };

  const suffix = prepared.find(item => item.base === base);
  if (suffix) return { entry: suffix.entry, confidence: 1, method: 'suffix' };

  if (normalized.length < 3) return null;
  let best: { item: PreparedEntry; score: number } | null = null;
  for (const item of prepared) {
    if (versionConflict(base, item.base)) continue;
    const score = Math.max(similarity(normalized, item.segment), similarity(base, item.base));
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score
      || (score === best.score && item.entry.id.length < best.item.entry.id.length)
      || (score === best.score && item.entry.id.length === best.item.entry.id.length && item.entry.id < best.item.entry.id)) {
      best = { item, score };
    }
  }
  return best ? { entry: best.item.entry, confidence: best.score, method: 'fuzzy' } : null;
}

function clampContext(value: number): number {
  if (!Number.isFinite(value)) return UNMATCHED_CONTEXT;
  return Math.min(Math.max(Math.round(value), 1_024), 10_000_000);
}

/** Only text and image reach pi-ai; pdf, audio and video are ignored (requirement: drop unsupported inputs). */
export function inputModalitiesOf(entry: ModelSnapshotEntry): ModelInputModality[] {
  const supported = entry.input.filter((value): value is ModelInputModality => value === 'text' || value === 'image');
  return supported.length ? [...new Set(supported)] : ['text'];
}

/**
 * Turns one snapshot row into editor values.
 *
 * - `maxTokens` never exceeds the context window, which `normalizeGatewayModels` enforces.
 * - A model with no effort list (toggle-only, budget-only, or undocumented) is reported as
 *   not supporting reasoning with `reasoningNote`, because the existing UI has no way to
 *   express "on/off only", and showing a level the provider rejects would fail at request time.
 * - `ultra` mirrors `max`, because the runtime sends Maximum's provider value for Ultra.
 */
export function deriveModelDefaults(entry: ModelSnapshotEntry): DerivedModelDefaults {
  const contextWindow = clampContext(entry.context);
  const output = Number.isFinite(entry.output) ? Math.round(entry.output) : 1;
  const maxTokens = Math.max(1, Math.min(output, contextWindow));
  const inputModalities = inputModalitiesOf(entry);
  const effort = new Set(entry.effort);
  const canReason = entry.reasoning && [...MATCHABLE_EFFORT].some(level => effort.has(level));

  if (!canReason) {
    return {
      contextWindow, maxTokens, reasoning: false, inputModalities,
      ...(entry.reasoning ? { reasoningNote: 'effort-levels-unavailable' as const } : {}),
    };
  }

  const mapped = (level: string) => (effort.has(level) ? level : null);
  return {
    contextWindow,
    maxTokens,
    reasoning: true,
    inputModalities,
    effortMap: {
      off: effort.has('none') ? 'none' : null,
      minimal: null,
      low: mapped('low'),
      medium: mapped('medium'),
      high: mapped('high'),
      xhigh: mapped('xhigh'),
      max: mapped('max'),
      ultra: mapped('max'),
    },
  };
}

/** ChatGPT-family detection for the "来自 Codex 反代" hint. Names are checked after normalization. */
export function looksLikeChatGpt(value: string): boolean {
  // A hand-typed "GPT 5.6 Sol" keeps its separator, so treat runs of spaces as a dash.
  const name = modelNameSegment(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return /^gpt-?5/.test(name) || name.includes('codex') || /^o[134](?:-|$)/.test(name);
}

/** Full match result for the renderer; null means "nothing matched, keep the safe defaults". */
export function toModelMatch(matched: MatchedModel, source: ModelMatch['source'], generatedAt: string): ModelMatch {
  return {
    ...deriveModelDefaults(matched.entry),
    matchedId: matched.entry.id,
    matchedName: matched.entry.name,
    confidence: matched.confidence,
    method: matched.method,
    source,
    generatedAt,
    release: matched.entry.release,
  };
}
