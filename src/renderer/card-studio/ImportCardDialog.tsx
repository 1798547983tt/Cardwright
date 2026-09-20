import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileImage, FileJson, FolderOpen } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import type { CardImportPreview, CardImportReport, CardKind, CardProjectView } from '../../shared/card-studio/types';

const clean = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Import a V2/V3 character card (JSON or PNG) or a standalone world book: pick the file, then answer the same three questions. */
export function ImportCardDialog({ onClose, onImported }: { onClose: () => void; onImported: (view: CardProjectView, report: CardImportReport) => void }) {
  const { api, t } = useApp();
  const [preview, setPreview] = useState<CardImportPreview | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CardKind>('fan');
  const [source, setSource] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folderTouched = useRef(false);

  useEffect(() => {
    if (folderTouched.current || !name.trim()) return;
    let alive = true;
    const timer = setTimeout(() => { void api.defaultCardFolder(name.trim()).then(path => { if (alive && !folderTouched.current) setFolder(path); }, () => undefined); }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [name, api]);

  async function choose() {
    setError('');
    try {
      const picked = await api.pickCardImportFile();
      if (!picked) return;
      setPreview(picked);
      setName(current => current.trim() || picked.name.slice(0, 40));
    } catch (reason) { setError(clean(reason)); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !preview) return;
    setBusy(true); setError('');
    try {
      const result = await api.createCardProjectFromFile({ name, kind, source: kind === 'fan' ? source : undefined, folder: folder.trim(), file: preview.file });
      onImported(result.card, result.report);
    } catch (reason) { setError(clean(reason)); }
    finally { setBusy(false); }
  }

  return <Modal title={t('Import a character card', '导入角色卡')} className="studio-modal cs-new-card" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <div className="cs-field">
        <span>{t('File', '文件')}<small>{t('V2 / V3 card as JSON or PNG, or a world book JSON', 'V2 / V3 角色卡 JSON 或 PNG，或世界书 JSON')}</small></span>
        <span className="cs-folder">
          <input readOnly value={preview?.file ?? ''} placeholder={t('No file chosen yet', '还没有选择文件')} />
          <button type="button" className="cs-btn" onClick={() => void choose()}><FolderOpen size={14} />{t('Choose…', '选择…')}</button>
        </span>
        {preview && <p className="cs-import-preview">{preview.format === 'png' ? <FileImage size={14} /> : <FileJson size={14} />}{preview.kind === 'card'
          ? t(`${preview.format === 'png' ? 'PNG card' : 'Character card'} 「${preview.name}」 · ${preview.entries} world book entries · ${preview.regex} regex · ${preview.scripts} scripts · ${preview.greetings} greetings`, `${preview.format === 'png' ? 'PNG 角色卡' : '角色卡'}「${preview.name}」· 世界书 ${preview.entries} 条 · 正则 ${preview.regex} 条 · 脚本 ${preview.scripts} 个 · 开场白 ${preview.greetings} 条`)
          : t(`World book 「${preview.name}」 · ${preview.entries} entries`, `独立世界书「${preview.name}」· ${preview.entries} 条条目`)}</p>}
        {preview?.format === 'png' && <p className="cs-note">{t('The card art becomes the cover.', '卡图会作为这张卡的封面。')}</p>}
        {preview?.mismatch && <p className="cs-form-error" role="alert">{t('The two copies of the card inside this PNG differ. The V3 copy (ccv3) is the one imported.', '这张 PNG 里两份角色卡数据不一致，导入的是 V3 那一份（ccv3）。')}</p>}
      </div>
      <label className="cs-field"><span>{t('Card name', '卡名')}</span><input required maxLength={40} value={name} onChange={event => setName(event.target.value)} placeholder={t('Taken from the file; you can change it', '默认取自文件，可以改')} /></label>
      <fieldset className="cs-field">
        <legend>{t('Fan card or original', '同人还是原创')}</legend>
        <span className="cs-segments">
          <label className="cs-segment"><input type="radio" name="import-kind" checked={kind === 'fan'} onChange={() => setKind('fan')} /><span>{t('Fan card', '同人卡')}</span></label>
          <label className="cs-segment"><input type="radio" name="import-kind" checked={kind === 'original'} onChange={() => setKind('original')} /><span>{t('Original card', '原创卡')}</span></label>
        </span>
      </fieldset>
      {kind === 'fan' && <label className="cs-field"><span>{t('Source work', '原作名')}</span><input required maxLength={60} value={source} onChange={event => setSource(event.target.value)} /></label>}
      <label className="cs-field">
        <span>{t('Folder', '文件夹')}</span>
        <span className="cs-folder"><input required value={folder} onChange={event => { folderTouched.current = true; setFolder(event.target.value); }} /><button type="button" className="cs-btn" onClick={() => void api.pickCardFolder().then(path => { if (path) { folderTouched.current = true; setFolder(path); } }, () => undefined)}>{t('Choose…', '选择…')}</button></span>
        <small>{t('The card is split into component files here; the original file is not changed.', '角色卡会拆成组件文件放进这个文件夹，原文件不会被改动。')}</small>
      </label>
      {error && <p className="cs-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="cs-btn" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button>
        <button type="submit" className="cs-btn is-primary" disabled={busy || !preview}>{busy ? t('Importing…', '正在导入…') : t('Import', '导入')}</button>
      </div>
    </form>
  </Modal>;
}
