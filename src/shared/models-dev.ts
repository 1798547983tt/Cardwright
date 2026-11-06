/**
 * models.dev's catalog is derived in two places: `scripts/build-model-snapshot.mjs`
 * writes the bundled snapshot, and `ModelMetadataService` parses the online fallback.
 * The provider-shaped mapping stays in each caller; these primitives are shared so a
 * change in the source schema is handled once.
 */

/** The order writers and the UI expect. */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Effort values are taken from a vendor's own entry before a reseller's, so the
 * snapshot never promises a level the official API rejects.
 */
export const REFERENCE_PROVIDERS = ['openai', 'anthropic', 'google', 'deepseek', 'zhipuai', 'zai', 'moonshotai', 'alibaba'];

export interface ReasoningOption {
  type?: string;
  values?: string[];
}

/** Every documented effort value, in `EFFORT_ORDER`. Unknown values are dropped. */
export function effortValues(model: { reasoning_options?: ReasoningOption[] } | undefined): string[] {
  const values = new Set<string>();
  for (const option of model?.reasoning_options ?? []) {
    if (option?.type !== 'effort') continue;
    for (const value of option.values ?? []) values.add(value);
  }
  return EFFORT_ORDER.filter(value => values.has(value));
}

/** Unknown providers sort after the reference ones, so their data never wins a tie. */
export function providerRank(provider: string): number {
  const rank = REFERENCE_PROVIDERS.indexOf(provider);
  return rank < 0 ? REFERENCE_PROVIDERS.length : rank;
}

export const MIN_CONTEXT = 1_024;
export const MAX_CONTEXT = 10_000_000;

export function clampContext(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_CONTEXT
    ? Math.min(value, MAX_CONTEXT)
    : fallback;
}

export function clampOutput(value: unknown, context: number, fallback: number): number {
  const output = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(output, context);
}
