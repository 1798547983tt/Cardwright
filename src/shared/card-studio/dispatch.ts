import { normalizeTarget, sectionFromTarget } from './boards.ts';
import { fenceKind, findFences, normalizeNewlines } from './fences.ts';

/** A dispatch written by the planning AI for one section. The user copies it or opens the section; the app never sends it. */
export interface ParsedDispatch { target: string; sectionId: string | null; title: string; requires: string; body: string }
export type DispatchParse = ParsedDispatch | { error: string; raw: string };

export const DISPATCH_FENCE = '派单';
const FIELD = /^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/;

export function parseDispatchContent(content: string): DispatchParse {
  const lines = normalizeNewlines(content).split('\n');
  const separator = lines.findIndex(line => line.trim() === '---');
  const header = separator < 0 ? lines : lines.slice(0, separator);
  const fields = new Map<string, string>();
  for (const line of header) {
    const match = FIELD.exec(line);
    if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
  }
  const target = normalizeTarget(fields.get('目标') ?? '');
  const title = (fields.get('标题') ?? '').trim();
  if (!target) return { error: '派单缺少目标', raw: content };
  if (!title) return { error: '派单缺少标题', raw: content };
  return { target, sectionId: sectionFromTarget(target), title, requires: (fields.get('前置') ?? '').trim(), body: separator < 0 ? '' : lines.slice(separator + 1).join('\n').trim() };
}

export function parseDispatches(text: string): DispatchParse[] {
  const normalized = normalizeNewlines(text);
  return findFences(normalized).filter(fence => fenceKind(fence) === DISPATCH_FENCE).map(fence => parseDispatchContent(fence.content));
}

export function formatDispatch(dispatch: Pick<ParsedDispatch, 'target' | 'title' | 'requires' | 'body'>): string {
  return ['```' + DISPATCH_FENCE, `目标: ${normalizeTarget(dispatch.target)}`, `标题: ${dispatch.title.trim()}`, `前置: ${dispatch.requires.trim()}`, '---', dispatch.body.trim(), '```'].join('\n');
}

/** Identity of a dispatch inside one card project: the same target and title are the same dispatch. */
export function dispatchKey(dispatch: { target: string; title: string }): string {
  return `${normalizeTarget(dispatch.target)}|${dispatch.title.trim()}`;
}

export function messageStartsDispatch(text: string, dispatch: { target: string; title: string }): boolean {
  const key = dispatchKey(dispatch);
  return parseDispatches(text).some(item => !('error' in item) && dispatchKey(item) === key);
}
