import { SECTION_IDS, normalizeTarget, sectionFromTarget, sectionLabel, targetOf } from './boards.ts';
import { fenceKind, findFences, normalizeNewlines } from './fences.ts';
import type { CardDispatch, CardDispatchReference, CardDispatchReferenceInput, CardTaskInfo } from './types.ts';

/** A dispatch written by the planning AI for one section. The user copies it or opens the section; the app never sends it. */
export interface ParsedDispatch { target: string; sectionId: string | null; title: string; requires: string; body: string; brief?: string; references?: CardDispatchReferenceInput[] }
export type DispatchParse = ParsedDispatch | { error: string; raw: string };

export const DISPATCH_FENCE = '派单';
const FIELD = /^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/;

/** What a 派单 block and a card_add_dispatches item share: the target and the title are required, the rest is trimmed. */
function dispatchFields(fields: { target: string; title: string; requires: string; body: string; brief?: string; references?: CardDispatchReferenceInput[] }, raw: string): DispatchParse {
  const target = normalizeTarget(fields.target);
  const title = fields.title.trim();
  if (!target) return { error: '派单缺少目标', raw };
  if (!title) return { error: '派单缺少标题', raw };
  const brief = fields.brief?.trim();
  return { target, sectionId: sectionFromTarget(target), title, requires: fields.requires.trim(), body: fields.body.trim(), ...(brief ? { brief } : {}), ...(fields.references?.length ? { references: fields.references } : {}) };
}

export function parseDispatchContent(content: string): DispatchParse {
  const lines = normalizeNewlines(content).split('\n');
  const separator = lines.findIndex(line => line.trim() === '---');
  const header = separator < 0 ? lines : lines.slice(0, separator);
  const fields = new Map<string, string>();
  for (const line of header) {
    const match = FIELD.exec(line);
    if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
  }
  return dispatchFields({ target: fields.get('目标') ?? '', title: fields.get('标题') ?? '', requires: fields.get('前置') ?? '', body: separator < 0 ? '' : lines.slice(separator + 1).join('\n'), brief: fields.get('摘要') }, content);
}

export function parseDispatches(text: string): DispatchParse[] {
  const normalized = normalizeNewlines(text);
  return findFences(normalized).filter(fence => fenceKind(fence) === DISPATCH_FENCE).map(fence => parseDispatchContent(fence.content));
}

/** One reference line, as the dispatch message shows it: the file and the exact lines to read. */
export function referenceLine(reference: Pick<CardDispatchReference, 'path' | 'offset' | 'lines' | 'summary'> & { heading?: string }): string {
  const range = reference.lines > 1 ? `第 ${reference.offset}–${reference.offset + reference.lines - 1} 行` : `第 ${reference.offset} 行`;
  // A summary from the tool can carry line breaks; folding them keeps the reference on one list line.
  const label = (reference.summary?.trim() || reference.heading?.trim() || '').replace(/\s+/g, ' ');
  return `- \`${reference.path}\` ${range}${label ? `：${label}` : ''}`;
}

/** A reference as the dispatch message can show it: only resolved line ranges are printed. */
export type DispatchReferenceLike = Partial<Pick<CardDispatchReference, 'path' | 'offset' | 'lines' | 'summary'>> & { heading?: string };

/** The fence is one backtick longer than any fence line in the body, so a code block the body quotes stays inside the dispatch. */
export function formatDispatch(dispatch: Pick<ParsedDispatch, 'target' | 'title' | 'requires' | 'body'> & { brief?: string; references?: readonly DispatchReferenceLike[] }): string {
  const body = dispatch.body.trim();
  const longest = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map(match => match[1].length));
  const fence = '`'.repeat(longest + 1);
  const brief = dispatch.brief?.trim();
  const references = (dispatch.references ?? []).filter((reference): reference is DispatchReferenceLike & Required<Pick<CardDispatchReference, 'path' | 'offset' | 'lines'>> => typeof reference.path === 'string' && !!reference.path.trim() && typeof reference.offset === 'number' && typeof reference.lines === 'number' && reference.lines > 0);
  return [
    fence + DISPATCH_FENCE,
    `目标: ${normalizeTarget(dispatch.target)}`,
    `标题: ${dispatch.title.trim()}`,
    `前置: ${dispatch.requires.trim()}`,
    ...(brief ? [`摘要: ${brief.replace(/\s*\n\s*/g, ' ')}`] : []),
    ...(references.length ? ['参考（先读这些行，不要整本读）:', ...references.map(referenceLine)] : []),
    '---',
    body,
    fence,
  ].join('\n');
}

/** Identity of a dispatch inside one card project: the same target and title are the same dispatch. */
export function dispatchKey(dispatch: { target: string; title: string }): string {
  return `${normalizeTarget(dispatch.target)}|${dispatch.title.trim()}`;
}

export function messageStartsDispatch(text: string, dispatch: { target: string; title: string }): boolean {
  const key = dispatchKey(dispatch);
  return parseDispatches(text).some(item => !('error' in item) && dispatchKey(item) === key);
}

/** One card_add_dispatches item's outcome, in the order the items came (§5.6). */
export interface DispatchItemResult {
  index: number; ok: boolean; target: string; title: string; section?: string; error?: string;
  /** 分区项目摘要: references planning gave that could not be resolved and were dropped from this dispatch. */
  droppedReferences?: number;
}
/** What card_add_dispatches answers. */
export interface DispatchBatchResult { added: number; results: DispatchItemResult[] }
/** card_add_dispatches takes 1 to this many at a time (§5.6): about one board's dispatches. */
export const DISPATCH_BATCH_LIMIT = 12;
/** The sections a dispatch can go to: every section with conversations except planning itself. */
const DISPATCH_SECTIONS = SECTION_IDS.filter(id => id !== 'plan' && id !== 'source');

/** Planning that starts or refines a card registers dispatches by tool; the change AI's 派单 blocks are its 影响清单 instead (§5.6). */
export function mayAddDispatches(card: Pick<CardTaskInfo, 'sectionId' | 'mode' | 'member'> | undefined): boolean {
  return !!card && card.sectionId === 'plan' && !card.member && (card.mode === 'scratch' || card.mode === 'refine');
}

/**
 * Identity of a dispatch for registering it: one section's dispatches are told apart by their titles, so `开场白` and
 * `开场白/开场白` are the same dispatch; one whose target named no section falls back to its target. The tool and a 派单
 * block in a reply both register by this.
 */
export function sectionDispatchKey(dispatch: Pick<CardDispatch, 'target' | 'sectionId' | 'title'>): string {
  return dispatch.sectionId ? `${dispatch.sectionId}|${dispatch.title.trim()}` : dispatchKey(dispatch);
}

/** Reference items the planning AI gave, cleaned before the app resolves them against the files. */
export function dispatchReferenceInputs(value: unknown): CardDispatchReferenceInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references = value.flatMap((entry): CardDispatchReferenceInput[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (!path) return [];
    const fold = (value: string) => value.trim().replace(/\s+/g, ' ');
    const headingText = typeof item.heading === 'string' ? fold(item.heading) : '';
    const summaryText = typeof item.summary === 'string' ? fold(item.summary) : '';
    const heading = headingText ? headingText.slice(0, 120) : undefined;
    const summary = summaryText ? summaryText.slice(0, 240) : undefined;
    const offset = Number.isInteger(item.offset) ? item.offset as number : undefined;
    const lines = Number.isInteger(item.lines) ? item.lines as number : undefined;
    return [{ path: path.slice(0, 300), ...(heading ? { heading } : {}), ...(offset !== undefined ? { offset } : {}), ...(lines !== undefined ? { lines } : {}), ...(summary ? { summary } : {}) }];
  });
  return references.length ? references : undefined;
}

/**
 * card_add_dispatches (§5.6): every item goes through the same checks as a 派单 block, then two more a tool can answer at
 * once: the target names a section that takes dispatches, and the title is new in its section, among the card's
 * dispatches and the items before it. Line breaks in the one-line fields (target, title, prerequisite) are folded, so the
 * dispatch formats back into a block that parses to the same fields.
 */
export function planDispatchBatch(existing: readonly Pick<CardDispatch, 'target' | 'sectionId' | 'title'>[], items: readonly unknown[]): { accepted: ParsedDispatch[]; results: DispatchItemResult[] } {
  const taken = new Set(existing.map(sectionDispatchKey));
  const accepted: ParsedDispatch[] = [];
  const results = items.map((value, index): DispatchItemResult => {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const text = (key: string) => typeof item[key] === 'string' ? item[key] as string : '';
    const line = (key: string) => text(key).replace(/\s*[\r\n]+\s*/g, ' ');
    const parsed = dispatchFields({ target: line('target'), title: line('title'), requires: line('prerequisite'), body: text('body'), brief: text('brief'), references: dispatchReferenceInputs(item.references) }, JSON.stringify(value) ?? '');
    if ('error' in parsed) return { index, ok: false, target: normalizeTarget(line('target')), title: line('title').trim(), error: parsed.error };
    const { target, title, sectionId } = parsed;
    if (!sectionId || !DISPATCH_SECTIONS.includes(sectionId)) return { index, ok: false, target, title, error: `目标「${target}」不是能派单的分区。目标写「板块/分区」，只有一个分区的板块只写板块名：${DISPATCH_SECTIONS.map(targetOf).join('、')}。` };
    const key = sectionDispatchKey(parsed);
    if (taken.has(key)) return { index, ok: false, target, title, error: `「${sectionLabel(sectionId)}」已经有一条叫「${title}」的派单。登记过的不要再登记；是另一件事就换个标题。` };
    taken.add(key);
    accepted.push(parsed);
    return { index, ok: true, target, title, section: sectionLabel(sectionId) };
  });
  return { accepted, results };
}
