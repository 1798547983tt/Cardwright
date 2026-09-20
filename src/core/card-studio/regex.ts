/**
 * Regex components: parsing SillyTavern's `/pattern/flags` strings, compiling them, and checking the
 * parameters that decide where a regex runs (verified against SillyTavern 1.19.0 regex engine fields).
 */
import { fenceKind, findFences, normalizeNewlines } from '../../shared/card-studio/fences.ts';
import type { CardCheckFinding } from '../../shared/card-studio/types.ts';

export interface RegexSpec { source: string; flags: string }
/** `placement` values a card may use; 0 is retired and 4 is unused. */
export const PLACEMENTS: Record<number, string> = { 1: '用户输入', 2: 'AI 输出', 3: '斜杠命令', 5: '世界书', 6: '推理' };
export const SAMPLE_FENCE = '示例输出';

export function parseFindRegex(value: unknown): RegexSpec {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('这条正则没有填查找表达式。');
  const match = /^\/(.*)\/([a-z]*)$/s.exec(text);
  return match ? { source: match[1], flags: match[2] } : { source: text, flags: '' };
}

export function compileRegex(value: unknown): RegExp {
  const spec = parseFindRegex(value);
  try { return new RegExp(spec.source, spec.flags); }
  catch (error) { throw new Error(`正则无法编译：${error instanceof Error ? error.message : String(error)}`); }
}

/** The example output the 正文格式 entry carries, written in a ```示例输出 block. */
export function sampleOutputFrom(formatContent: string): string | null {
  const text = normalizeNewlines(String(formatContent ?? ''));
  for (const fence of findFences(text)) if (fenceKind(fence) === SAMPLE_FENCE) return fence.content.trim() || null;
  return null;
}

export function regexHits(regex: RegExp, sample: string): boolean {
  const copy = new RegExp(regex.source, regex.flags.replace('g', ''));
  return copy.test(sample);
}

/** Parameter checks that do not need the rest of the card. */
export function checkRegexParams(params: Record<string, unknown>): CardCheckFinding[] {
  const findings: CardCheckFinding[] = [];
  const name = String(params.scriptName ?? '').trim();
  const label = name || '（未命名正则）';
  if (!name) findings.push({ level: 'error', code: 'regex-name', message: '正则没有名称（scriptName），酒馆里无法分辨。' });
  const placement = Array.isArray(params.placement) ? params.placement.map(Number) : [];
  if (!placement.length || placement.some(value => !PLACEMENTS[value])) {
    findings.push({ level: 'error', code: 'regex-placement', message: `「${label}」的作用位置 ${JSON.stringify(params.placement)} 不在可用取值里：${Object.entries(PLACEMENTS).map(([value, text]) => `${value} ${text}`).join('、')}。` });
  }
  if (placement.includes(5) && params.promptOnly !== true) {
    findings.push({ level: 'error', code: 'regex-world-book', message: `「${label}」作用于世界书（5），必须同时打开「只改提示词」（promptOnly）。` });
  }
  if (params.markdownOnly !== true && params.promptOnly !== true) {
    findings.push({ level: 'warning', code: 'regex-effect', message: `「${label}」既不是只改显示，也不是只改提示词，会同时改动两边。确认这是有意的。` });
  }
  const min = params.minDepth === null || params.minDepth === undefined ? null : Number(params.minDepth);
  const max = params.maxDepth === null || params.maxDepth === undefined ? null : Number(params.maxDepth);
  if (min !== null && max !== null && min > max) {
    findings.push({ level: 'error', code: 'regex-depth', message: `「${label}」的最小深度 ${min} 大于最大深度 ${max}，这条正则永远不会命中。` });
  }
  return findings;
}
