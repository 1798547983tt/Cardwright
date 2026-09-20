import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { FileText, FolderOpen, Scissors, Upload } from 'lucide-react';
import { useApp } from '../context';
import type { CardProjectView, SourceImportReport, SourceRecord } from '../../shared/card-studio/types';

const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const clean = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function kindText(record: SourceRecord, t: (en: string, zh: string) => string): string {
  if (record.kind === 'text') return t('Text', '文本');
  if (record.kind === 'json') return t(`JSON reference (${record.note ?? 'other'})`, `JSON 参考资料（${record.note ?? '其他'}）`);
  return record.kind === 'card-png' ? t('PNG character card (reference)', 'PNG 角色卡（参考资料）') : t('Image', '图片');
}

function splitText(record: SourceRecord, t: (en: string, zh: string) => string): string {
  const split = record.split;
  if (!split) return '';
  if (split.mode === 'headings') return t(`By ${split.level} headings · ${split.parts} parts`, `按「${split.level}」切分 · ${split.parts} 份`);
  return split.manual ? t(`Fixed size ${split.size} · ${split.parts} parts`, `固定字数 ${split.size} · ${split.parts} 份`)
    : t(`No headings found; fixed size ${split.size} · ${split.parts} parts`, `未识别到章节标题，按固定字数 ${split.size} 切分 · ${split.parts} 份`);
}

/** 资料 has no AI conversation: it only imports material into the card project. */
export function SourcesPage({ card }: { card: CardProjectView }) {
  const { api, t, run, notify } = useApp();
  const [records, setRecords] = useState<SourceRecord[] | null>(null);
  const [report, setReport] = useState<SourceImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.readCardSources(card.projectId).then(setRecords, reason => setError(clean(reason))), [api, card.projectId]);
  useEffect(() => { void load(); }, [load, card.sources]);

  async function importWith(action: () => Promise<SourceImportReport | null>) {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await action(); if (result) setReport(result); await load(); }
    catch (reason) { setError(clean(reason)); }
    finally { setBusy(false); }
  }
  function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false);
    const paths = [...event.dataTransfer.files].map(file => api.filePathForDrop(file)).filter(Boolean);
    if (paths.length) void importWith(() => api.importCardSources(card.projectId, paths));
  }
  async function resplit(record: SourceRecord, mode: 'auto' | 'fixed') {
    setBusy(true);
    const result = await run(() => api.resplitCardSource(card.projectId, record.name, mode));
    if (result) { notify(mode === 'fixed' ? t(`${record.name} was split again by fixed size.`, `「${record.name}」已按固定字数重新切分。`) : t(`${record.name} was split again by headings.`, `「${record.name}」已重新按章节标题切分。`)); await load(); }
    setBusy(false);
  }

  return <div className="cs-sources">
    <div className={`cs-drop ${dragging ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <Upload size={22} />
      <p><b>{t('Drop material here', '把资料拖到这里')}</b><small>{t('txt and md are converted to UTF-8 and split by chapter; json and images are kept as references. Convert docx, pdf and epub to txt first.', 'txt、md 转为 UTF-8 并按章节切分；json 和图片作为参考资料保存。docx、pdf、epub 请先转成 txt。')}</small></p>
      <button type="button" className="cs-btn is-primary" disabled={busy} onClick={() => void importWith(() => api.pickCardSources(card.projectId))}>{busy ? t('Importing…', '正在导入…') : t('Choose files…', '选择文件…')}</button>
    </div>
    {error && <p className="cs-form-error" role="alert">{error}</p>}
    {report && <section className="cs-report" aria-label={t('Import report', '导入报告')}>
      <header><h3>{t('Import report', '导入报告')}</h3><button type="button" className="cs-link" onClick={() => setReport(null)}>{t('Dismiss', '收起')}</button></header>
      {report.imported.length > 0 && <ul>{report.imported.map(record => <li key={record.name} className="is-ok"><b>{record.name}</b><span>{record.encoding ? `${record.encoding} · ` : ''}{record.split ? splitText(record, t) : kindText(record, t)}</span></li>)}</ul>}
      {report.rejected.length > 0 && <ul>{report.rejected.map(item => <li key={item.name} className="is-rejected"><b>{item.name}</b><span>{item.reason}</span></li>)}</ul>}
    </section>}
    <section className="cs-source-list" aria-label={t('Imported material', '已导入的资料')}>
      <header>
        <h3>{t('Imported material', '已导入的资料')}<em>{records?.length ?? 0}</em></h3>
        <span>
          <button type="button" className="cs-btn is-small" onClick={() => void run(() => api.openCardFolder(card.projectId, '资料'))}><FolderOpen size={13} />{t('Open folder', '打开资料文件夹')}</button>
          <button type="button" className="cs-btn is-small" disabled={!records?.length} onClick={() => void run(() => api.openCardFolder(card.projectId, '资料/索引.md'))}><FileText size={13} />{t('Open index', '打开资料索引')}</button>
        </span>
      </header>
      {records === null ? <p className="cs-note">{t('Loading…', '正在读取…')}</p> : records.length === 0 ? <p className="cs-note">{t('No material yet. Planning can start without it, but fan cards should import the source text first.', '还没有资料。规划可以先开始；同人卡建议先导入原作文本。')}</p>
        : <table>
          <thead><tr><th>{t('File', '文件')}</th><th>{t('Type', '类型')}</th><th>{t('Encoding', '编码')}</th><th>{t('Split', '切分')}</th><th>{t('Size', '大小')}</th><th /></tr></thead>
          <tbody>{records.map(record => <tr key={record.name}>
            <td><b>{record.name}</b><small>{new Date(record.importedAt).toLocaleString()}</small></td>
            <td>{kindText(record, t)}</td>
            <td>{record.encoding ?? '—'}</td>
            <td>{record.split ? splitText(record, t) : '—'}</td>
            <td>{record.chars ? t(`${record.chars.toLocaleString()} chars`, `${record.chars.toLocaleString()} 字`) : size(record.bytes)}</td>
            <td className="cs-source-actions">{record.kind === 'text' && (record.split?.mode === 'fixed' && record.split.manual
              ? <button type="button" className="cs-link" disabled={busy} onClick={() => void resplit(record, 'auto')}>{t('Split by headings again', '改回按章节标题切分')}</button>
              : <button type="button" className="cs-link" disabled={busy} onClick={() => void resplit(record, 'fixed')}><Scissors size={12} />{t('Split by fixed size', '改用固定字数重新切分')}</button>)}</td>
          </tr>)}</tbody>
        </table>}
    </section>
  </div>;
}
