import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import type { CardKind, CardProjectView } from '../../shared/card-studio/types';

/** Only three questions: the card name, fan card or original (with the source work), and the cover, which may be skipped. */
export function NewCardDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (view: CardProjectView, reused: boolean) => void }) {
  const { api, t } = useApp();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CardKind>('fan');
  const [source, setSource] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folderTouched = useRef(false);
  useEffect(() => {
    if (folderTouched.current) return;
    let alive = true;
    const timer = setTimeout(() => { void api.defaultCardFolder(name.trim()).then(path => { if (alive && !folderTouched.current) setFolder(path); }, () => undefined); }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [name, api]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.createCardProject({ name, kind, source: kind === 'fan' ? source : undefined, folder: folder.trim() });
      onCreated(result.card, result.reused);
    } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)); }
    finally { setBusy(false); }
  }
  async function choose() {
    const path = await api.pickCardFolder().catch(() => null);
    if (path) { folderTouched.current = true; setFolder(path); }
  }
  return <Modal title={t('New card project', '新建卡项目')} className="studio-modal cs-new-card" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <label className="cs-field"><span>{t('Card name', '卡名')}</span><input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)} placeholder={t('For example: 西游·八十一难', '例如：西游·八十一难')} /></label>
      <fieldset className="cs-field">
        <legend>{t('Fan card or original', '同人还是原创')}</legend>
        <span className="cs-segments">
          <label className="cs-segment"><input type="radio" name="card-kind" checked={kind === 'fan'} onChange={() => setKind('fan')} /><span>{t('Fan card', '同人卡')}</span></label>
          <label className="cs-segment"><input type="radio" name="card-kind" checked={kind === 'original'} onChange={() => setKind('original')} /><span>{t('Original card', '原创卡')}</span></label>
        </span>
      </fieldset>
      {kind === 'fan' && <label className="cs-field"><span>{t('Source work', '原作名')}</span><input required maxLength={60} value={source} onChange={event => setSource(event.target.value)} placeholder={t('For example: 西游记', '例如：西游记')} /></label>}
      <div className="cs-field">
        <span>{t('Cover', '封面')}<small>{t('Optional', '可以跳过')}</small></span>
        <p className="cs-note">{t('Cover upload and cropping come with PNG export. Until then the card uses a cover style picked at random when it is created.', '上传和裁剪封面会和 PNG 导出一起提供。在那之前，新建时会随机选一种封面样式。')}</p>
      </div>
      <label className="cs-field">
        <span>{t('Folder', '文件夹')}</span>
        <span className="cs-folder"><input required value={folder} onChange={event => { folderTouched.current = true; setFolder(event.target.value); }} /><button type="button" className="cs-btn" onClick={() => void choose()}>{t('Choose…', '选择…')}</button></span>
        <small>{t('If this folder is already a card project, it is added back to the library unchanged.', '如果这个文件夹已经是卡项目，会原样登记回卡库。')}</small>
      </label>
      {error && <p className="cs-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="cs-btn" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button>
        <button type="submit" className="cs-btn is-primary" disabled={busy}>{busy ? t('Creating…', '正在创建…') : t('Create card project', '创建卡项目')}</button>
      </div>
    </form>
  </Modal>;
}
