import type { ThinkingLevel } from './types.ts';

/** Reasoning and the visible answer share this budget, so reasoning models need far more than a chat default. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128000;
/** The pre-0.7.1 editor default; only this exact value migrates automatically. */
export const LEGACY_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const order: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** 128K first, then doubling, never beyond the model's context window. */
export function nextOutputLimit(current: number, contextWindow: number): number | undefined {
  const target = current < DEFAULT_MAX_OUTPUT_TOKENS ? DEFAULT_MAX_OUTPUT_TOKENS : current * 2;
  const bounded = Math.min(target, contextWindow);
  return bounded > current ? bounded : undefined;
}

/** The next lower available level whose provider value actually differs from the current one. */
export function lowerEffort(current: ThinkingLevel, map: Partial<Record<ThinkingLevel, string | null>>, available: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  const value = (level: ThinkingLevel) => map[level] ?? level;
  for (let index = order.indexOf(current) - 1; index >= 0; index--) {
    const candidate = order[index];
    if (available.includes(candidate) && value(candidate) !== value(current)) return candidate;
  }
  return undefined;
}
