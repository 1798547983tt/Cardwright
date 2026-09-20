import { DISPATCH_FENCE, parseDispatchContent, type DispatchParse } from './dispatch.ts';
import { fenceKind, findFences, normalizeNewlines } from './fences.ts';
import { HANDOFF_FENCE, parseHandoffContent, type Handoff } from './handoff.ts';

/** A section AI ends a question round with this line; the interface then offers 【全部按推荐】. */
export const ACCEPT_ALL_MARKER = '<!-- cardwright:accept-all -->';
export const ACCEPT_ALL_TEXT = '全部按推荐';
/** A section AI that will not start (no design book, a conflict, a missing prerequisite) ends its reply with this line. */
export const REFUSE_MARKER = '<!-- cardwright:refuse -->';
/** Instructions the app sends when the user starts planning; the AI speaks first in reply. */
export const KICKOFF = { scratch: '【开始规划 · 从零开始制卡】', refine: '【开始规划 · 完善优化卡】' } as const;
/** The first line of the app's request for a handoff summary; the AI writes one only after this. */
export const HANDOFF_REQUEST = '【换对话 · 请写交接摘要】';

/** The whole request: the marker, then the format, so the reply parses even if the section rules were edited. */
export function handoffRequestText(): string {
  return [
    HANDOFF_REQUEST,
    '应用要为这个分区开一个新对话。请只写一份交接摘要，不再做别的事，严格用下面的格式：',
    '',
    '```交接摘要',
    '已定: 已经确定的决定',
    '已写: 已写的组件（名称与 uid）',
    '未完成: 还没做完的事项',
    '第一步: 新对话开始后第一件要做的事',
    '```',
    '',
    '一个字段写不下时换行，续行前面缩进两个空格。',
  ].join('\n');
}

export function isHandoffRequest(text: string): boolean {
  return normalizeNewlines(text).trim().split('\n')[0]?.trim() === HANDOFF_REQUEST;
}

export type ReplySegment = { type: 'markdown'; text: string } | { type: 'dispatch'; dispatch: DispatchParse; raw: string } | { type: 'handoff'; handoff: Handoff | null; raw: string };

/** Hides the marker lines outside code blocks and reports which ones the reply carried; a quoted marker is left alone. */
export function stripMarkers(text: string): { text: string; hasAcceptAll: boolean; refused: boolean } {
  const normalized = normalizeNewlines(text);
  const fences = findFences(normalized);
  const inFence = (offset: number) => fences.some(fence => offset >= fence.start && offset < fence.end);
  let offset = 0; let hasAcceptAll = false; let refused = false;
  const kept: string[] = [];
  for (const line of normalized.split('\n')) {
    const start = offset; offset += line.length + 1;
    if (inFence(start) || (!line.includes(ACCEPT_ALL_MARKER) && !line.includes(REFUSE_MARKER))) { kept.push(line); continue; }
    hasAcceptAll ||= line.includes(ACCEPT_ALL_MARKER);
    refused ||= line.includes(REFUSE_MARKER);
    const rest = line.replace(ACCEPT_ALL_MARKER, '').replace(REFUSE_MARKER, '');
    if (rest.trim()) kept.push(rest);
  }
  return hasAcceptAll || refused ? { text: kept.join('\n').trimEnd(), hasAcceptAll, refused } : { text, hasAcceptAll, refused };
}

export function isKickoff(text: string): 'scratch' | 'refine' | null {
  const first = normalizeNewlines(text).trim().split('\n')[0]?.trim();
  return first === KICKOFF.scratch ? 'scratch' : first === KICKOFF.refine ? 'refine' : null;
}

export function segmentReply(text: string): ReplySegment[] {
  const normalized = normalizeNewlines(text);
  const segments: ReplySegment[] = [];
  const pushMarkdown = (value: string) => { const trimmed = value.trim(); if (trimmed) segments.push({ type: 'markdown', text: trimmed }); };
  let cursor = 0;
  for (const fence of findFences(normalized)) {
    const kind = fenceKind(fence);
    if (kind !== DISPATCH_FENCE && kind !== HANDOFF_FENCE) continue;
    pushMarkdown(normalized.slice(cursor, fence.start));
    const raw = normalized.slice(fence.start, fence.end).trimEnd();
    segments.push(kind === DISPATCH_FENCE ? { type: 'dispatch', dispatch: parseDispatchContent(fence.content), raw } : { type: 'handoff', handoff: parseHandoffContent(fence.content), raw });
    cursor = fence.end;
  }
  pushMarkdown(normalized.slice(cursor));
  return segments;
}
