import { fenceKind, findFences, normalizeNewlines } from './fences.ts';
import type { CardHandoffState } from './types.ts';

/** 交接摘要: what a new conversation in the same section needs. The AI writes it only when the app asks. */
export interface Handoff { decided: string; written: string; pending: string; first: string }

export const HANDOFF_FENCE = '交接摘要';
const LABELS: Array<[keyof Handoff, string]> = [['decided', '已定'], ['written', '已写'], ['pending', '未完成'], ['first', '第一步']];
const START = new RegExp(`^\\s*(${LABELS.map(([, label]) => label).join('|')})\\s*[:：]\\s*(.*)$`);

export function parseHandoffContent(content: string): Handoff | null {
  const values = new Map<keyof Handoff, string[]>();
  let current: keyof Handoff | undefined;
  for (const line of normalizeNewlines(content).split('\n')) {
    const match = START.exec(line);
    if (match) {
      current = LABELS.find(([, label]) => label === match[1])![0];
      values.set(current, match[2].trim() ? [match[2].trim()] : []);
    } else if (current && line.trim()) values.get(current)!.push(line.trim());
  }
  const result = Object.fromEntries(LABELS.map(([key]) => [key, (values.get(key) ?? []).join('\n')])) as unknown as Handoff;
  return LABELS.every(([key]) => result[key]) ? result : null;
}

export function parseHandoff(text: string): Handoff | null {
  const blocks = findFences(normalizeNewlines(text)).filter(fence => fenceKind(fence) === HANDOFF_FENCE);
  return blocks.length ? parseHandoffContent(blocks.at(-1)!.content) : null;
}

export function formatHandoff(handoff: Handoff): string {
  const lines = LABELS.map(([key, label]) => {
    const [first, ...rest] = handoff[key].trim().split('\n');
    return [`${label}: ${first.trim()}`, ...rest.map(line => `  ${line.trim()}`)].join('\n');
  });
  return ['```' + HANDOFF_FENCE, ...lines, '```'].join('\n');
}

/** When the app offers a new conversation: at this many tokens, or at this share of the model window, whichever comes first. */
export interface HandoffSettings { tokens: number; windowPercent: number }
export const DEFAULT_HANDOFF: HandoffSettings = { tokens: 200_000, windowPercent: 50 };

export function handoffThreshold(window: number, settings: HandoffSettings = DEFAULT_HANDOFF): number {
  const share = window > 0 ? Math.floor(window * settings.windowPercent / 100) : Infinity;
  return Math.min(settings.tokens, share);
}

/**
 * The app, not the AI, decides when to offer a new conversation: the context has reached the threshold, the conversation's
 * dispatch is still open, it is not running, and no handoff is pending or already used. A failed request can be retried.
 */
export function handoffOffer(input: { tokens: number | null | undefined; window: number; settings?: HandoffSettings; dispatchDone: boolean; active: boolean; handoff?: CardHandoffState }): { offer: boolean; used: number; threshold: number } {
  const threshold = handoffThreshold(input.window, input.settings);
  const used = typeof input.tokens === 'number' && Number.isFinite(input.tokens) ? input.tokens : 0;
  const pending = !!input.handoff && input.handoff.status !== 'failed';
  return { offer: used > 0 && used >= threshold && !input.dispatchDone && !input.active && !pending, used, threshold };
}

/** The handoff summary the AI wrote in reply to the app's request with this message id, if it wrote one. */
export function handoffFromReply(messages: ReadonlyArray<{ id: string; role: string; text: string }>, requestId: string | undefined): Handoff | null {
  const index = requestId ? messages.findIndex(message => message.id === requestId) : -1;
  if (index < 0) return null;
  const replies = messages.slice(index + 1).filter(message => message.role === 'assistant' && message.text.trim());
  for (const reply of replies.reverse()) {
    const handoff = parseHandoff(reply.text);
    if (handoff) return handoff;
  }
  return null;
}
