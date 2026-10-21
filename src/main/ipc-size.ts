/** The IPC guard: how big a request each cardwright: channel may carry.
    Data-URL channels need more than the default — the guard measures the whole
    JSON.stringify(args), and a 960×1440 photo PNG base64 runs 4–9 million characters. */
import type { Bridge } from '../shared/types.ts';

const DEFAULT_LIMIT = 2_000_000;

export const ARG_LIMITS: Partial<Record<keyof Bridge, number>> = {
  /** The rendered card face for a PNG export: a lossless 960×1440 photo is far above the default. */
  exportCardPng: 32_000_000,
};

/** Throws when the request is over the channel's limit; the message matches the historical guard. */
export function assertArgSize(name: keyof Bridge, args: unknown[]): void {
  const limit = ARG_LIMITS[name] ?? DEFAULT_LIMIT;
  if (JSON.stringify(args).length > limit) throw new Error('Request exceeds the allowed size.');
}

export function argLimit(name: keyof Bridge): number {
  return ARG_LIMITS[name] ?? DEFAULT_LIMIT;
}
