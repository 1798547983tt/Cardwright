import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, CircleCheck, FileDown, FolderOpen, Image, Info, LoaderCircle, Package, Save, ShieldAlert } from 'lucide-react';
import { useApp } from '../context';
import { UNCLASSIFIED_SECTION, sectionLabel } from '../../shared/card-studio/boards';
import { renderCoverPng } from './cover-canvas';
import { PreviewPanel } from './PreviewPanel';
import { UnclassifiedDialog } from './UnclassifiedDialog';
import type { CardCheckReport, CardExportResult, CardMeta, CardProjectView } from '../../shared/card-studio/types';

const LEVEL_ICON = { error: ShieldAlert, warning: AlertTriangle, info: Info } as const;
type Busy = 'check' | 'card' | 'lorebook' | 'png' | 'pieces' | 'meta' | null;

/** The name, author, version, notes and tags SillyTavern shows (§3.6 step 3), confirmed before the export. */
function MetaForm({ card, busy, setBusy }: { card: CardProjectView; busy: Busy; setBusy: (value: Busy) => void }) {
  const { api, t, run } = useApp();
  const [meta, setMeta] = useState<CardMeta | null>(null);
  const [tags, setTags] = useState('');
  useEffect(() => {
    let alive = true;
    void api.readCardMeta(card.projectId).then(value => { if (alive) { setMeta(value); setTags(value.tags.join('，')); } }, () => undefined);
    return () => { alive = false; };
  }, [api, card.projectId]);
  if (!meta) return null;
  const field = (key: 'name' | 'creator' | 'version') => ({ value: meta[key], onChange: (event: { target: { value: string } }) => setMeta({ ...meta, [key]: event.target.value }) });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!meta) return;
    setBusy('meta');
    const saved = await run(() => api.saveCardMeta(card.projectId, { ...meta, tags: tags.split(/[，,、\s]+/) }), t('Card details saved', '卡片信息已保存'));
    if (saved) { setMeta(saved); setTags(saved.tags.join('，')); }
    setBusy(null);
  }
  return <details className="cs-meta">
    <summary>{t('Card details', '卡片信息')}<small>{[meta.name, meta.version, meta.creator].filter(Boolean).join(' · ')}</small></summary>
    <form onSubmit={event => void save(event)}>
      <label className="cs-field"><span>{t('Card name', '卡名')}<small>{t('what SillyTavern shows', '酒馆里显示的名字')}</small></span><input required maxLength={60} {...field('name')} /></label>
      <label className="cs-field"><span>{t('Author', '作者')}</span><input maxLength={60} {...field('creator')} /></label>
      <label className="cs-field"><span>{t('Version', '版本')}<small>{t('also used in the export file names', '也用在导出文件名里')}</small></span><input maxLength={24} placeholder="v1" {...field('version')} /></label>
      <label className="cs-field cs-meta-wide"><span>{t("Creator's notes", '创作者备注')}</span><textarea rows={3} value={meta.notes} onChange={event => setMeta({ ...meta, notes: event.target.value })} /></label>
      <label className="cs-field cs-meta-wide"><span>{t('Tags', '标签')}<small>{t('separated by commas', '用逗号隔开')}</small></span><input value={tags} onChange={event => setTags(event.target.value)} /></label>
      <div className="cs-meta-actions"><button type="submit" className="cs-btn" disabled={busy !== null}><Save size={14} />{t('Save card details', '保存卡片信息')}</button></div>
    </form>
  </details>;
}

/** 拼装台: run the deterministic checks, confirm the card details, then export. Errors block the export. */
export function AssemblyPanel({ card }: { card: CardProjectView }) {
  const { api, t, run, notify } = useApp();
  const [report, setReport] = useState<CardCheckReport | null>(null);
  const [exported, setExported] = useState<CardExportResult[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [sorting, setSorting] = useState(false);

  const check = useCallback(async (quiet = false) => {
    setBusy('check');
    const result = await run(() => api.runCardChecks(card.projectId), quiet ? undefined : t('Checks finished', '检查完成'));
    if (result) setReport(result);
    setBusy(null);
  }, [api, card.projectId, run, t]);
  useEffect(() => { void check(true); }, [check]);

  async function exportAs(kind: 'card' | 'lorebook' | 'png') {
    setBusy(kind);
    const result = await run(async () => {
      if (kind !== 'png') return api.exportCardProject(card.projectId, kind);
      // The cover is drawn here: an uploaded image when there is one, the text cover otherwise.
      const uploaded = card.cover ? await api.readCardCover(card.projectId) : null;
      const png = await renderCoverPng({ style: card.coverStyle, name: card.name, kind: card.kind, source: card.source }, uploaded);
      return api.exportCardPng(card.projectId, png);
    });
    if (result) { setExported(current => [result, ...current].slice(0, 6)); notify(t(`Exported ${result.file}`, `已导出 ${result.file}`)); }
    setBusy(null);
  }

  async function exportPieces() {
    setBusy('pieces');
    const result = await run(() => api.exportAllCardPieces(card.projectId));
    if (result) {
      setExported(current => [{ kind: 'pieces' as const, file: result.folder, bytes: 0, entries: result.files.length, at: new Date().toISOString() }, ...current].slice(0, 6));
      notify(t(`Exported ${result.files.length} pieces to ${result.folder}`, `已把 ${result.files.length} 个单件导出到 ${result.folder}`));
    }
    setBusy(null);
  }

  const errors = report?.findings.filter(item => item.level === 'error') ?? [];
  const warnings = report?.findings.filter(item => item.level === 'warning') ?? [];
  const info = report?.findings.filter(item => item.level === 'info') ?? [];
  const blocked = !report || !report.ok;
  const latestReport = exported.find(item => item.report)?.report;
  const kindLabel = (item: CardExportResult) => item.kind === 'card' ? t('Whole card', '整卡 JSON') : item.kind === 'png' ? t('PNG card', 'PNG 卡') : item.kind === 'pieces' ? t('All single pieces', '全部单件') : item.kind === 'lorebook' ? t('World book', '世界书') : t('Single piece', '单件');
  return <section className="cs-assembly" aria-label={t('Assembly', '拼装台')}>
    <header>
      <h2>{t('Assembly bench', '拼装台')}</h2>
      <p>{t('The checks are deterministic: the same components always give the same findings. Errors block the export.', '拼装检查是确定性的：同样的组件永远给出同样的结果。有错误时禁止导出。')}</p>
      <div className="cs-assembly-actions">
        <button type="button" className="cs-btn is-primary" disabled={busy !== null} onClick={() => void check()}>{busy === 'check' ? <LoaderCircle size={14} className="spinning" /> : <CircleCheck size={14} />}{t('Run checks', '运行拼装检查')}</button>
        <button type="button" className="cs-btn" disabled={busy !== null || blocked} title={blocked ? t('Fix the errors first', '先修掉错误再导出') : undefined} onClick={() => void exportAs('card')}><FileDown size={14} />{t('Export card JSON', '导出整卡 JSON')}</button>
        <button type="button" className="cs-btn" disabled={busy !== null || blocked} onClick={() => void exportAs('png')}><Image size={14} />{t('Export PNG card', '导出 PNG 卡')}</button>
        <button type="button" className="cs-btn" disabled={busy !== null || blocked} onClick={() => void exportAs('lorebook')}><FileDown size={14} />{t('Export world book', '导出世界书')}</button>
        <button type="button" className="cs-btn" disabled={busy !== null || blocked} onClick={() => void exportPieces()}><Package size={14} />{t('Export all pieces', '导出全部单件')}</button>
        <button type="button" className="cs-link" onClick={() => void run(() => api.openCardFolder(card.projectId, '导出'))}><FolderOpen size={13} />{t('Open the export folder', '打开导出文件夹')}</button>
      </div>
    </header>

    <MetaForm card={card} busy={busy} setBusy={setBusy} />

    {report && <dl className="cs-assembly-stats">
      <div><dt>{t('Entries', '条目')}</dt><dd>{report.stats.entries}</dd></div>
      <div><dt>{t('Always-on characters', '常驻字数')}</dt><dd>{report.stats.constantChars.toLocaleString()}</dd></div>
      <div><dt>{t('Estimated tokens', '估算 Token')}</dt><dd>{report.stats.constantTokens.toLocaleString()}</dd></div>
      <div><dt>{t('Errors', '错误')}</dt><dd className={errors.length ? 'is-bad' : ''}>{errors.length}</dd></div>
      <div><dt>{t('Warnings', '警告')}</dt><dd>{warnings.length}</dd></div>
    </dl>}

    {report && Object.entries(report.stats.sections).length > 0 && <p className="cs-assembly-sections">{Object.entries(report.stats.sections).map(([section, count], index) => <Fragment key={section}>
      {index > 0 && ' ｜ '}
      {section === UNCLASSIFIED_SECTION && count > 0
        ? <button type="button" className="cs-link" title={t('Move these entries into sections', '把这些条目移到分区')} onClick={() => setSorting(true)}>{`${sectionLabel(section)} ${count} · ${t('Sort', '整理')}`}</button>
        : `${sectionLabel(section)} ${count}`}
    </Fragment>)}</p>}

    {report && <ol className="cs-findings">
      {[...errors, ...warnings, ...info].map((finding, index) => {
        const Icon = LEVEL_ICON[finding.level];
        return <li key={`${finding.code}-${index}`} className={`is-${finding.level}`}>
          <Icon size={14} />
          <span>{finding.message}{finding.path && <small>{finding.path}</small>}</span>
          <em>{finding.code}</em>
        </li>;
      })}
      {!report.findings.length && <li className="is-info"><Info size={14} /><span>{t('Nothing to report.', '没有需要处理的问题。')}</span></li>}
    </ol>}

    <PreviewPanel card={card} kind="body" open={false} />
    <PreviewPanel card={card} kind="update" open={false} />
    <PreviewPanel card={card} kind="status" open={false} />
    <PreviewPanel card={card} kind="start" open={false} />

    {exported.length > 0 && <section className="cs-exported">
      <h3>{t('Exported this session', '本次导出')}</h3>
      <ul>{exported.map(item => <li key={`${item.file}-${item.at}`}>
        <b>{item.file}</b>
        <span>{kindLabel(item)} · {item.kind === 'pieces' ? t(`${item.entries} files`, `${item.entries} 个文件`) : `${item.entries} ${t('entries', '条条目')} · ${(item.bytes / 1024).toFixed(1)} KB`}</span>
      </li>)}</ul>
      {latestReport && <article className="cs-export-report" aria-label={t('Export report', '导出报告')}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{latestReport.text}</ReactMarkdown>
        <p className="cs-note">{t(`Also saved as ${latestReport.file}.`, `报告也存成了 ${latestReport.file}。`)}</p>
      </article>}
    </section>}
    {sorting && <UnclassifiedDialog card={card} onClose={moved => { setSorting(false); if (moved) void check(true); }} />}
  </section>;
}
