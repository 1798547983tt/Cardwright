/**
 * 制卡 Agent 优化: one switch and a few policies that decide how much a section
 * conversation writes, how long it goes on by itself, when it changes conversation,
 * and how much of the project it reads at the start.
 *
 * The policies only change prompts, the card runner and the section brief. They never
 * change the Pi runtime or the tools themselves.
 */

export interface CardAgentOptimization {
  /** Master switch. Off restores the pre-optimization behavior everywhere. */
  enabled: boolean;
  /** 每轮最多派单次数: how many `write` / `edit` calls one reply may make. `null` means 不限. */
  maxWritesPerRound: number | null;
  /** 自动写卡的最多对话轮数: automatic 继续 rounds for one dispatch before pausing. */
  maxContinueRounds: number;
  /** 分区上下文达阈值后更换对话. Off means the app never offers a new conversation. */
  handoffEnabled: boolean;
  /** The token threshold for a new conversation; the model window fallback may lower it. */
  handoffTokens: number;
  /** 分区项目摘要: preload a short project brief and reference lines when a section starts. */
  sectionBrief: boolean;
}

export const CARD_OPTIMIZATION_LIMITS = {
  writesPerRound: { min: 1, max: 8 },
  continueRounds: { min: 10, max: 50 },
  handoffTokens: { min: 50_000, max: 1_000_000 },
} as const;

/** The model window fallback keeps this share for compression and the reply itself. */
export const HANDOFF_WINDOW_FALLBACK = 0.8;

export const DEFAULT_CARD_OPTIMIZATION: CardAgentOptimization = {
  enabled: true,
  maxWritesPerRound: 2,
  maxContinueRounds: 15,
  handoffEnabled: true,
  handoffTokens: 100_000,
  sectionBrief: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Fill a saved or incoming configuration over `base`. A field that is present but has
 * the wrong type or is out of range makes the whole value invalid, so a settings write
 * cannot store a half-applied policy.
 */
export function cardOptimizationFrom(value: unknown, base: CardAgentOptimization = DEFAULT_CARD_OPTIMIZATION): CardAgentOptimization | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const next = { ...base };
  if ('enabled' in value) { if (typeof value.enabled !== 'boolean') return undefined; next.enabled = value.enabled; }
  if ('maxWritesPerRound' in value) {
    const writes = value.maxWritesPerRound;
    if (writes !== null && !(Number.isInteger(writes) && (writes as number) >= CARD_OPTIMIZATION_LIMITS.writesPerRound.min && (writes as number) <= CARD_OPTIMIZATION_LIMITS.writesPerRound.max)) return undefined;
    next.maxWritesPerRound = writes as number | null;
  }
  if ('maxContinueRounds' in value) {
    const rounds = value.maxContinueRounds;
    if (!Number.isInteger(rounds) || (rounds as number) < CARD_OPTIMIZATION_LIMITS.continueRounds.min || (rounds as number) > CARD_OPTIMIZATION_LIMITS.continueRounds.max) return undefined;
    next.maxContinueRounds = rounds as number;
  }
  if ('handoffEnabled' in value) { if (typeof value.handoffEnabled !== 'boolean') return undefined; next.handoffEnabled = value.handoffEnabled; }
  if ('handoffTokens' in value) {
    const tokens = value.handoffTokens;
    if (!Number.isInteger(tokens) || (tokens as number) < CARD_OPTIMIZATION_LIMITS.handoffTokens.min || (tokens as number) > CARD_OPTIMIZATION_LIMITS.handoffTokens.max) return undefined;
    next.handoffTokens = tokens as number;
  }
  if ('sectionBrief' in value) { if (typeof value.sectionBrief !== 'boolean') return undefined; next.sectionBrief = value.sectionBrief; }
  return next;
}

/** The 1.3 experiment's switch and the old 换对话 thresholds seed the new configuration once. */
export function cardOptimizationFromLegacy(input: { tokenOptimizer?: unknown; handoff?: { tokens?: unknown; enabled?: unknown } }): CardAgentOptimization {
  const next = { ...DEFAULT_CARD_OPTIMIZATION };
  if (typeof input.tokenOptimizer === 'boolean') next.enabled = input.tokenOptimizer;
  const tokens = input.handoff?.tokens;
  if (Number.isInteger(tokens)) {
    next.handoffTokens = Math.min(CARD_OPTIMIZATION_LIMITS.handoffTokens.max, Math.max(CARD_OPTIMIZATION_LIMITS.handoffTokens.min, tokens as number));
  }
  if (input.handoff?.enabled === false) next.handoffEnabled = false;
  return next;
}

/** Whether the policy, rather than the old fixed behavior, is in force. */
export function optimizationActive(config: CardAgentOptimization | undefined): config is CardAgentOptimization {
  return config?.enabled === true;
}

/** How many files one reply may write; 1 is the shipped rule, `null` means 不限. */
export function effectiveWritesPerRound(config: CardAgentOptimization | undefined): number | null {
  if (!config?.enabled) return 1;
  return config.maxWritesPerRound;
}

/** Automatic rounds for one dispatch. `undefined` means the caller keeps its old limit. */
export function effectiveContinueRounds(config: CardAgentOptimization | undefined): number | undefined {
  return config?.enabled ? config.maxContinueRounds : undefined;
}

/** 分区项目摘要 is on only when the master switch is on too. */
export function sectionBriefEnabled(config: CardAgentOptimization | undefined): boolean {
  return config?.enabled === true && config.sectionBrief;
}

/** The shipped rule is the single-file rule; the markers let the app replace it. */
export const BATCH_WRITE_START = '<!-- cardwright:batch-write:start -->';
export const BATCH_WRITE_END = '<!-- cardwright:batch-write:end -->';

export const SINGLE_FILE_RULE = '- **一次只写一个文件**：同一条消息里最多调用一次 `write` 或 `edit`。写完一个、看到结果，再写下一个。';
const noLimitRule = '- **一轮按需要写**：同一条消息里可以写多个文件，每写完一个、看到结果再写下一个。单个组件很长、预计超过本轮输出上限时，只写一个。';

export function batchWriteRule(writes: number | null): string {
  if (writes === null) return noLimitRule;
  if (writes <= 1) return SINGLE_FILE_RULE;
  return `- **一轮最多写 ${writes} 个文件**：同一条消息里最多调用 ${writes} 次 \`write\` 或 \`edit\`；写完一个、看到结果，再写下一个。单个组件很长、预计超过本轮输出上限时，只写一个。`;
}

function replaceBetween(text: string, start: string, end: string, body: string | null): string {
  const at = text.indexOf(start);
  if (at < 0) return text;
  const close = text.indexOf(end, at + start.length);
  if (close < 0) return text;
  const before = text.slice(0, at);
  const after = text.slice(close + end.length);
  if (body === null) {
    const inner = text.slice(at + start.length, close).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return `${before}${inner}${after}`;
  }
  return `${before}${body}${after}`;
}

/**
 * Replace the one-file bullet inside the markers. A user prompt override that lost the
 * markers is left untouched: the model keeps following the text the user saved.
 */
export function optimizedBatchRule(text: string, config: CardAgentOptimization | undefined): string {
  if (!config?.enabled) return replaceBetween(text, BATCH_WRITE_START, BATCH_WRITE_END, null);
  return replaceBetween(text, BATCH_WRITE_START, BATCH_WRITE_END, batchWriteRule(config.maxWritesPerRound));
}

export const BRIEF_READ_START = '<!-- cardwright:brief-read:start -->';
export const BRIEF_READ_END = '<!-- cardwright:brief-read:end -->';

const BRIEF_READ_RULE = '开工时，先读派单里附的「本次派单摘要」和参考行。先读参考行；摘要没写到的细节，再用 `read` 的 `offset` / `limit` 读原文件的对应段落。不要整本通读设计书、变量表或资料索引。派单「前置」写到的上游产物，按同样方式只读相关段落。';

/**
 * 分区项目摘要: replace the full 开工必读 list with the read-the-brief-first rule.
 * The markers live around the whole list, so an override without them keeps its own text.
 */
export function sectionBriefRule(text: string, config: CardAgentOptimization | undefined): string {
  if (!sectionBriefEnabled(config)) return replaceBetween(text, BRIEF_READ_START, BRIEF_READ_END, null);
  return replaceBetween(text, BRIEF_READ_START, BRIEF_READ_END, BRIEF_READ_RULE);
}
