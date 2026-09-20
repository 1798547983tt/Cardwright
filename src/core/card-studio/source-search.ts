import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isWithinRoot } from '../../runtime/permissions.ts';
import { readSourceManifest } from './sources.ts';

/** 搜资料: a read-only search of the material chapters, so section AIs look things up without running commands. */
export interface SourceSearchInput { query: string; regex?: boolean; limit?: number; source?: string }
export interface SourceSearchHit { file: string; source: string; chapter: string; volume?: string; line: number; snippet: string }
export interface SourceSearchResult { query: string; results: SourceSearchHit[]; total: number; truncated: boolean; note?: string }

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PATTERN = 200;
const MAX_LINE = 4000;
const SNIPPET = 160;
/** Counting stops here; the AI only needs to know that there are many more. */
const MAX_COUNT = 5000;

function matcher(input: SourceSearchInput): (line: string) => number {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('请给出要搜的词。');
  if (input.regex) {
    if (query.length > MAX_PATTERN) throw new Error(`正则不超过 ${MAX_PATTERN} 个字符。`);
    let pattern: RegExp;
    try { pattern = new RegExp(query, 'iu'); }
    catch (error) { throw new Error(`正则写法有误：${error instanceof Error ? error.message : String(error)}`); }
    return line => line.search(pattern);
  }
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return line => {
    const lower = line.toLocaleLowerCase();
    return words.every(word => lower.includes(word)) ? lower.indexOf(words[0]) : -1;
  };
}

function snippet(line: string, at: number): string {
  const text = line.trim();
  if (text.length <= SNIPPET) return text;
  const offset = Math.max(0, line.length - line.trimStart().length);
  const start = Math.max(0, Math.min(at - offset - SNIPPET / 3, text.length - SNIPPET));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + SNIPPET)}${start + SNIPPET < text.length ? '…' : ''}`;
}

export async function searchSources(root: string, input: SourceSearchInput): Promise<SourceSearchResult> {
  const match = matcher(input);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(Number(input.limit) || DEFAULT_LIMIT)));
  const query = String(input.query).trim();
  const records = (await readSourceManifest(root)).filter(record => record.chapters?.length && (!input.source || record.name === input.source));
  if (!records.length) return { query, results: [], total: 0, truncated: false, note: input.source ? `没有叫「${input.source}」的资料。` : '这张卡还没有导入资料。' };
  const chapters = resolve(root, '资料', '分章');
  const results: SourceSearchHit[] = [];
  let total = 0;
  for (const record of records) {
    for (const chapter of record.chapters ?? []) {
      const path = resolve(join(root, ...String(chapter.path).split('/')));
      if (!isWithinRoot(chapters, path) || path === chapters) continue;
      const text = await readFile(path, 'utf8').catch(() => '');
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].length > MAX_LINE ? lines[index].slice(0, MAX_LINE) : lines[index];
        if (!line.trim()) continue;
        const at = match(line);
        if (at < 0) continue;
        total++;
        if (results.length < limit) results.push({ file: chapter.path, source: record.name, chapter: chapter.title, ...(chapter.volume ? { volume: chapter.volume } : {}), line: index + 1, snippet: snippet(line, at) });
        if (total >= MAX_COUNT) return { query, results, total, truncated: true };
      }
    }
  }
  return { query, results, total, truncated: total > results.length };
}
