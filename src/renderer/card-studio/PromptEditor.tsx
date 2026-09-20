import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw, Save } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import type { PromptOverrideDetail } from '../../shared/card-studio/types';

/**
 * Developer mode: edits built-in card studio prompts as prompt overrides (§5.6). Saving and restoring apply to
 * conversations started afterwards; the shipped default is shown for comparison.
 */
export function PromptEditor({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { api, t, run, notify } = useApp();
  const [current, setCurrent] = useState(ids[0]);
  const [details, setDetails] = useState<Record<string, PromptOverrideDetail>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all(ids.map(id => api.readCardPromptOverride(id))).then(values => { if (alive) setDetails(Object.fromEntries(values.map(value => [value.id, value]))); }, error => notify(error instanceof Error ? error.message : String(error)));
    return () => { alive = false; };
  }, [api, ids.join('|')]);
  const detail = details[current];
  const text = drafts[current] ?? detail?.text ?? '';
  const changed = !!detail && text !== detail.text;

  async function apply(action: 'save' | 'restore') {
    if (!detail || busy) return;
    setBusy(true);
    const next = await run(() => action === 'save' ? api.saveCardPromptOverride(detail.id, text) : api.restoreCardPromptOverride(detail.id));
    setBusy(false);
    if (!next) return;
    setDetails(value => ({ ...value, [next.id]: next }));
    setDrafts(value => { const rest = { ...value }; delete rest[next.id]; return rest; });
    notify(action === 'save' ? t('Saved. Conversations started from now on use it.', '已保存，之后新开的对话使用这一版。') : t('Restored to the default.', '已恢复默认版本。'));
  }

  return <Modal title={t('Built-in prompts · edit', '内置提示词 · 编辑')} className="studio-modal cs-prompt-editor" onClose={() => { if (!busy) onClose(); }}>
    <nav className="cs-prompt-tabs" role="tablist" aria-label={t('Prompts', '提示词')}>
      {ids.map(id => <button key={id} type="button" role="tab" aria-selected={id === current} className={id === current ? 'is-current' : ''} onClick={() => { setCurrent(id); setCompare(false); }}>
        {details[id]?.label ?? id}{details[id]?.overridden && <i className="cs-prompt-dot" title={t('Modified', '已修改')} />}
      </button>)}
    </nav>
    {!detail ? <p className="cs-note"><LoaderCircle size={13} className="spinning" /> {t('Loading…', '正在读取…')}</p> : <>
      <p className="cs-prompt-state">
        {detail.overridden ? <b className="is-modified">{t('Modified', '已修改')}</b> : <b>{t('Default', '默认版本')}</b>}
        {detail.stale && <b className="is-stale">{t('Default updated', '默认已更新')}</b>}
        <span>{detail.stale ? t('A newer version changed the default this edit was based on. Your version still applies; compare before deciding.', '新版本改了你修改时依据的默认内容。你的版本仍然生效，可以对照默认版本再决定。') : t('Changes apply to conversations started after saving.', '保存后，对之后新开的对话生效。')}</span>
      </p>
      <textarea className="cs-prompt-input" value={text} spellCheck={false} aria-label={detail.label} onChange={event => setDrafts(value => ({ ...value, [current]: event.target.value }))} />
      {compare && <pre className="cs-prompt-text" aria-label={t('Default version', '默认版本')}>{detail.defaultText}</pre>}
      <div className="modal-actions">
        <button type="button" className="cs-link" onClick={() => setCompare(value => !value)}>{compare ? t('Hide the default', '收起默认版本') : t('Compare with the default', '对照默认版本')}</button>
        <button type="button" className="cs-btn" disabled={busy || !detail.overridden} onClick={() => void apply('restore')}><RotateCcw size={13} />{t('Restore default', '恢复默认')}</button>
        <button type="button" className="cs-btn is-primary" disabled={busy || !changed || !text.trim()} onClick={() => void apply('save')}>{busy ? <LoaderCircle size={13} className="spinning" /> : <Save size={13} />}{t('Save', '保存')}</button>
      </div>
    </>}
  </Modal>;
}
