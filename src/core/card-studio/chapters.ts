/** Splits long material into chapters by 第X章/回/卷… headings, or into fixed-size parts when none are found. */
export type HeadingLevel = '部' | '卷' | '篇' | '集' | '章' | '回' | '节';
export interface Chapter { index: number; title: string; volume?: string; text: string; chars: number }
export interface SplitResult { mode: 'headings' | 'fixed'; level?: HeadingLevel; chapters: Chapter[] }

export const DEFAULT_PART_SIZE = 6000;
const PREFACE_LIMIT = 200;
const HEADING_LINE_LIMIT = 60;
const RANK: Record<HeadingLevel, number> = { 部: 0, 卷: 1, 篇: 2, 集: 2, 章: 3, 回: 3, 节: 4 };
const HEADING = /^[\t 　]*第([0-9０-９一二三四五六七八九十百千万零〇两]+)([部卷篇集章回节])(?:[\t 　:：.、·-]*)(.*)$/;

export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

function heading(line: string): { level: HeadingLevel; title: string } | null {
  const title = line.trim();
  if (!title || title.length > HEADING_LINE_LIMIT) return null;
  const match = HEADING.exec(line);
  if (!match || /[。！？!?…”」]$/.test(match[3].trim())) return null;
  return { level: match[2] as HeadingLevel, title };
}

function finish(parts: Array<{ title: string; volume?: string; lines: string[] }>): Chapter[] {
  return parts.map((part, index) => {
    const text = part.lines.join('\n');
    return { index: index + 1, title: part.title, ...(part.volume ? { volume: part.volume } : {}), text, chars: countChars(text) };
  }).filter(chapter => chapter.chars > 0).map((chapter, index) => ({ ...chapter, index: index + 1 }));
}

function splitFixed(lines: string[], size: number): SplitResult {
  const parts: string[][] = [];
  let current: string[] = []; let chars = 0;
  const flush = () => { if (chars > 0) parts.push(current); current = []; chars = 0; };
  for (const line of lines) {
    const length = countChars(line);
    if (length > size) {
      flush();
      const characters = Array.from(line);
      for (let start = 0; start < characters.length; start += size) {
        current = [characters.slice(start, start + size).join('')]; chars = countChars(current[0]);
        if (start + size < characters.length) flush();
      }
      continue;
    }
    if (chars > 0 && chars + length > size) flush();
    current.push(line); chars += length;
  }
  flush();
  return { mode: 'fixed', chapters: finish(parts.map((part, index) => ({ title: `第 ${index + 1} 份`, lines: part }))) };
}

export function splitChapters(text: string, options: { size?: number; mode?: 'auto' | 'fixed' } = {}): SplitResult {
  const size = options.size ?? DEFAULT_PART_SIZE;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (options.mode === 'fixed') return splitFixed(lines, size);
  const found = lines.map(heading);
  const counts = new Map<HeadingLevel, number>();
  for (const item of found) if (item) counts.set(item.level, (counts.get(item.level) ?? 0) + 1);
  const usable = [...counts].filter(([, count]) => count >= 2);
  if (!usable.length) return splitFixed(lines, size);
  const rank = Math.max(...usable.map(([level]) => RANK[level]));
  const level = usable.filter(([candidate]) => RANK[candidate] === rank).sort((a, b) => b[1] - a[1])[0][0];

  const parts: Array<{ title: string; volume?: string; lines: string[] }> = [];
  const preface: string[] = []; let pending: string[] = [];
  let current: { title: string; volume?: string; lines: string[] } | undefined; let volume: string | undefined;
  lines.forEach((line, index) => {
    const item = found[index];
    if (item && RANK[item.level] < rank) {
      if (current) { parts.push(current); current = undefined; }
      volume = item.title; pending.push(line);
    } else if (item && RANK[item.level] === rank) {
      if (current) parts.push(current);
      else if (!parts.length && countChars(preface.join('')) > PREFACE_LIMIT) { parts.push({ title: '前言', lines: [...preface] }); preface.length = 0; }
      current = { title: item.title, volume, lines: [...(parts.length ? [] : preface.splice(0)), ...pending, line] };
      pending = [];
    } else if (current) current.lines.push(line);
    else if (pending.length) pending.push(line);
    else preface.push(line);
  });
  if (current) parts.push(current);
  if (pending.length) parts.at(-1)?.lines.push(...pending);
  return { mode: 'headings', level, chapters: finish(parts) };
}
