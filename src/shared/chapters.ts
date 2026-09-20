import type { TaskChapter } from './types.ts';

const MAX_TITLE = 40;

/** A chapter name is one short line; anything else is trimmed down to that (§6.3). */
export function chapterTitle(value: string): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** The chapter each turn starts, in the order the turns happened; a second mark on one turn replaces the first. */
export function chaptersByTurn(chapters: readonly TaskChapter[] | undefined): Map<string, TaskChapter> {
  const byTurn = new Map<string, TaskChapter>();
  for (const chapter of [...(chapters ?? [])].sort((a, b) => a.at.localeCompare(b.at))) byTurn.set(chapter.turnId, chapter);
  return byTurn;
}
