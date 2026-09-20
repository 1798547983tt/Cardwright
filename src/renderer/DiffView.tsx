import { useMemo } from 'react';
import { Columns2, Rows3 } from 'lucide-react';
import { useApp } from './context';

type DiffKind = 'context' | 'added' | 'removed';
export interface DiffLine { number: number; text: string; kind: DiffKind; noNewline?: boolean }
export type SplitDiffRow = { kind: 'pair'; left?: DiffLine; right?: DiffLine } | { kind: 'meta' | 'hunk' | 'binary'; text: string };
export interface ParsedDiff { unified: Array<{ text: string; kind: DiffKind | 'meta' | 'hunk' | 'binary' | 'note' }>; split: SplitDiffRow[] }

/** Interpret only ordinary Git hunks; unknown metadata never becomes numbered code. */
export function parseDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = { unified: [], split: [] };
  const lines = patch.split('\n'); if (lines.at(-1) === '') lines.pop();
  let oldLine = 0; let newLine = 0; let oldRemaining = 0; let newRemaining = 0;
  let inHunk = false; let binary = false;
  let removed: DiffLine[] = []; let added: DiffLine[] = []; let previous: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) result.split.push({ kind: 'pair', left: removed[index], right: added[index] });
    removed = []; added = [];
  };
  const metadata = (text: string, kind: 'meta' | 'hunk' | 'binary' = 'meta') => {
    result.unified.push({ text, kind }); result.split.push({ text, kind }); previous = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (/^diff --(?:git|cc|combined) /.test(line)) { flush(); inHunk = false; binary = false; metadata(line); continue; }
    if (binary) continue;
    if (line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line)) {
      flush(); inHunk = false; binary = true; metadata(line, 'binary'); continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]); newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true; metadata(line, 'hunk'); continue;
    }
    if (line.startsWith('\\ ')) {
      if (line === '\\ No newline at end of file') previous.forEach(item => { item.noNewline = true; });
      result.unified.push({ text: line, kind: 'note' });
      if (!previous.length) result.split.push({ text: line, kind: 'meta' });
      continue;
    }
    if (inHunk && line.startsWith('-') && oldRemaining > 0) {
      const item: DiffLine = { number: oldLine++, text: line.slice(1), kind: 'removed' }; oldRemaining--;
      removed.push(item); previous = [item]; result.unified.push({ text: line, kind: 'removed' }); continue;
    }
    if (inHunk && line.startsWith('+') && newRemaining > 0) {
      const item: DiffLine = { number: newLine++, text: line.slice(1), kind: 'added' }; newRemaining--;
      added.push(item); previous = [item]; result.unified.push({ text: line, kind: 'added' }); continue;
    }
    if (inHunk && line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      flush();
      const left: DiffLine = { number: oldLine++, text: line.slice(1), kind: 'context' };
      const right: DiffLine = { number: newLine++, text: line.slice(1), kind: 'context' };
      oldRemaining--; newRemaining--; previous = [left, right];
      result.split.push({ kind: 'pair', left, right }); result.unified.push({ text: line, kind: 'context' }); continue;
    }
    flush(); inHunk = false; metadata(line);
  }
  flush(); return result;
}

export function DiffView({ patch, mode, onModeChange }: { patch: string; mode: 'unified' | 'split'; onModeChange: (mode: 'unified' | 'split') => void }) {
  const { t } = useApp();
  const parsed = useMemo(() => parseDiff(patch), [patch]);
  const binaryNotice = t('Binary file changed. A text diff is unavailable.', '二进制文件已修改，无法显示文本差异。');
  const renderSide = (line: DiffLine | undefined) => <>
    <td className={`diff-line-number ${line?.kind || 'diff-missing'}`}>{line?.number}</td>
    <td className={`diff-line-marker ${line?.kind || 'diff-missing'}`} aria-hidden="true">{line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ''}</td>
    <td className={`diff-line-text ${line?.kind || 'diff-missing'}`}>{line ? <><code>{line.text || ' '}</code>{line.noNewline && <span className="diff-newline-note">{t('No newline at end of file', '文件末尾无换行')}</span>}</> : <span className="sr-only">{t('No corresponding line', '没有对应行')}</span>}</td>
  </>;
  return <div className="diff-view"><div className="diff-layout-control" role="group" aria-label={t('Diff layout', '差异布局')}><button aria-label={t('Unified diff', '统一差异')} aria-pressed={mode === 'unified'} className={mode === 'unified' ? 'active' : ''} onClick={() => onModeChange('unified')}><Rows3 size={13} />{t('Unified', '统一')}</button><button aria-label={t('Split diff', '并排差异')} aria-pressed={mode === 'split'} className={mode === 'split' ? 'active' : ''} onClick={() => onModeChange('split')}><Columns2 size={13} />{t('Split', '并排')}</button></div>
    {mode === 'unified' ? <div className="diff-code" aria-label={t('Unified changes', '统一修改视图')}>{parsed.unified.map((line, index) => <div key={index} className={line.kind}>{line.kind === 'binary' ? binaryNotice : line.text || ' '}</div>)}</div> : <div className="diff-split-scroll"><table className="diff-split" aria-label={t('Side-by-side changes', '并排修改视图')}><colgroup><col className="diff-number-col" /><col className="diff-marker-col" /><col /><col className="diff-number-col" /><col className="diff-marker-col" /><col /></colgroup><thead><tr><th colSpan={3}>{t('Original', '修改前')}</th><th colSpan={3}>{t('Modified', '修改后')}</th></tr></thead><tbody>{parsed.split.map((row, index) => row.kind === 'pair' ? <tr key={index}>{renderSide(row.left)}{renderSide(row.right)}</tr> : <tr key={index} className={`diff-split-${row.kind}`}><td colSpan={6}>{row.kind === 'binary' ? binaryNotice : row.text || ' '}</td></tr>)}</tbody></table></div>}
  </div>;
}
