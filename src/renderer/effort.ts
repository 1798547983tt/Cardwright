import type { ThinkingLevel } from '../shared/types';

export const thinkingLevels: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const thinkingLabel = (level: string, t: (en: string, zh: string) => string) => t(
  ({ off: 'Off', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', ultra: 'Ultra' } as Record<string, string>)[level] || level,
  ({ off: '关闭', minimal: '轻度', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' } as Record<string, string>)[level] || level,
);
