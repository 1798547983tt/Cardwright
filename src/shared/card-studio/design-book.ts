import { normalizeNewlines } from './fences.ts';

const SEPARATOR = /^\|?\s*:?-{3,}/;
const LIST_ITEM = /^([-*+]|\d+[.、)])\s+/;

/** 「已写 N / 名单 M」 from the design book's 人物名单 section (a table or a list with ｜-separated fields). */
export function parsePeople(markdown: string): { written: number; total: number } | null {
  const lines = normalizeNewlines(markdown).split('\n').map(line => line.trim());
  const start = lines.findIndex(line => /^#{1,6}\s+.*人物名单/.test(line));
  if (start < 0) return null;
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line) rows.push(line);
  }
  let written = 0; let total = 0;
  rows.forEach((line, index) => {
    let cells: string[] | undefined;
    if (line.startsWith('|')) {
      if (SEPARATOR.test(line) || SEPARATOR.test(rows[index + 1] ?? '')) return;
      cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
    } else if (LIST_ITEM.test(line)) {
      cells = line.replace(LIST_ITEM, '').split(/[｜|]/).map(cell => cell.trim());
    }
    if (!cells?.length) return;
    total++;
    if (cells.includes('已写')) written++;
  });
  return { written, total };
}
