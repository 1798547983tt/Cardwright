import { useCallback, useEffect, useState } from 'react';
import { FolderInput, ListChecks, LoaderCircle, Sparkles } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { UNCLASSIFIED_SECTION } from '../../shared/card-studio/boards';
import { LORE_SUGGESTION_LIMIT, LORE_TARGETS } from '../../shared/card-studio/lore-suggest';
import type { CardComponentSummary, CardLoreSuggestion, CardProjectView } from '../../shared/card-studio/types';
import './card-studio-unclassified.css';

const errorText = (reason: unknown) => reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason);
const targetName = (section: string) => LORE_TARGETS.find(target => target.id === section)?.name ?? section;
type Busy = 'load' | 'move' | 'suggest' | null;

/**
 * 整理未分类 (1.1 Q22): the world book entries no section took on import. Tick rows and move them to one section, or pick
 * a section per row (「AI 归类建议」 fills them in) and move them the way the rows say. Only the folder changes: the
 * uid, the order and the body stay, so the exported card is the same. Nothing moves until a move button is pressed.
 */
export function UnclassifiedDialog({ card, onClose }: { card: CardProjectView; onClose: (moved: boolean) => void }) {
  const { api, t } = useApp();
  const [rows, setRows] = useState<CardComponentSummary[]>([]);
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set());
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [suggestions, setSuggestions] = useState<Record<number, CardLoreSuggestion>>({});
  const [bulk, setBulk] = useState('lore-people');
  const [busy, setBusy] = useState<Busy>('load');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [moved, setMoved] = useState(0);

  const load = useCallback(async () => {
    const all = await api.readCardComponents(card.projectId);
    const left = all.filter(item => item.section === UNCLASSIFIED_SECTION);
    const present = new Set(left.map(item => item.uid));
    setRows(left);
    setChecked(current => new Set([...current].filter(uid => present.has(uid))));
  }, [api, card.projectId]);
  useEffect(() => {
    load().catch(reason => setError(errorText(reason))).finally(() => setBusy(null));
  }, [load]);

  const picked = rows.filter(row => checked.has(row.uid));
  const planned = rows.filter(row => targets[row.uid]);
  const allChecked = rows.length > 0 && picked.length === rows.length;
  const toggle = (uid: number) => setChecked(current => { const next = new Set(current); if (!next.delete(uid)) next.add(uid); return next; });

  /** One move per section; what moved leaves the list, the rest keeps its choices. */
  async function move(groups: Array<{ section: string; rows: CardComponentSummary[] }>) {
    setBusy('move'); setError(''); setNote('');
    let count = 0;
    try {
      for (const group of groups) if (group.rows.length) count += (await api.moveCardLore(card.projectId, group.rows.map(row => row.paramsPath), group.section)).length;
    } catch (reason) { setError(errorText(reason)); }
    if (count) { setMoved(total => total + count); setNote(t(`Moved ${count} entries.`, `已移动 ${count} 条。`)); }
    await load().catch(reason => setError(errorText(reason)));
    setBusy(null);
  }
  const moveTicked = () => void move([{ section: bulk, rows: picked }]);
  const movePlanned = () => void move(LORE_TARGETS.map(target => ({ section: target.id, rows: planned.filter(row => targets[row.uid] === target.id) })));

  /** Asks about the rows without a section yet (all of them when every row has one), at most one request's worth. */
  async function suggest() {
    const open = rows.filter(row => !targets[row.uid]);
    const asked = (open.length ? open : rows).slice(0, LORE_SUGGESTION_LIMIT).map(row => row.uid);
    if (!asked.length) return;
    setBusy('suggest'); setError(''); setNote('');
    try {
      const answer = await api.suggestCardLoreSections(card.projectId, asked);
      setSuggestions(current => ({ ...current, ...Object.fromEntries(answer.map(item => [item.uid, item])) }));
      setTargets(current => ({ ...current, ...Object.fromEntries(answer.map(item => [item.uid, item.section])) }));
      setNote(answer.length
        ? t(`The AI suggested a section for ${answer.length} of ${asked.length} entries. Check the 「Move to」 column, then move.`, `AI 给 ${asked.length} 条里的 ${answer.length} 条填了建议。看一遍「移到」这一列，再点「照建议移」。`)
        : t('The AI gave no usable suggestion. Try again, or pick the sections yourself.', 'AI 没有给出能用的建议。可以再试一次，或者自己选。'));
    } catch (reason) { setError(errorText(reason)); }
    setBusy(null);
  }

  const close = () => { if (busy !== 'move') onClose(moved > 0); };
  const working = busy !== null;
  return <Modal title={t('Sort the unclassified entries', '整理未分类')} className="studio-modal cs-sort-dialog" onClose={close}>
    <p className="modal-intro">{t(
      'No section took these entries on import. Moving one only puts its files in the folder of that section: the uid, the order and the body stay, and the exported card does not change.',
      '这些条目导入时没能按顺序号归进任何分区。移到分区只是把文件搬进那个分区的文件夹：uid、顺序和正文都不变，导出的卡也不变。')}</p>
    <div className="cs-sort-tools">
      <button type="button" className="cs-btn is-small" disabled={working || !rows.length} onClick={() => void suggest()}>{busy === 'suggest' ? <LoaderCircle size={13} className="spinning" /> : <Sparkles size={13} />}{busy === 'suggest' ? t('Asking the AI…', 'AI 正在归类…') : t('AI suggestions', 'AI 归类建议')}</button>
      <span className="cs-note">{t(`One model call for up to ${LORE_SUGGESTION_LIMIT} entries, on the model this card plans with (else the default one). It only fills in the rows; nothing moves until you press a move button.`, `一次模型调用，最多 ${LORE_SUGGESTION_LIMIT} 条，用这张卡规划用的模型（没有就用默认模型）。只填建议，按下面的按钮才会移动。`)}</span>
    </div>
    {busy === 'load' ? <p className="cs-note cs-sort-empty"><LoaderCircle size={14} className="spinning" />{t('Reading the entries…', '正在读取条目…')}</p>
      : !rows.length ? <p className="cs-note cs-sort-empty">{t('Nothing is left unclassified.', '未分类已经清空了。')}</p>
      : <div className="cs-sort-table">
        <table>
          <thead><tr>
            <th className="is-check"><input type="checkbox" aria-label={t('Select all', '全选')} checked={allChecked} disabled={working} ref={element => { if (element) element.indeterminate = picked.length > 0 && !allChecked; }} onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map(row => row.uid)))} /></th>
            <th>{t('Name', '名称')}</th>
            <th className="is-num">{t('Order', '顺序')}</th>
            <th className="is-num">{t('Keys', '关键词')}</th>
            <th>{t('Move to', '移到')}</th>
            <th>{t('Reason', '理由')}</th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const suggestion = suggestions[row.uid];
            const target = targets[row.uid] ?? '';
            return <tr key={row.uid} className={checked.has(row.uid) ? 'is-checked' : undefined}>
              <td className="is-check"><input type="checkbox" aria-label={row.name || t('Unnamed', '未命名')} checked={checked.has(row.uid)} disabled={working} onChange={() => toggle(row.uid)} /></td>
              <td className="cs-sort-name"><b title={row.bodyPath}>{row.name || t('Unnamed', '未命名')}</b><small>uid {row.uid}{row.constant ? t(' · always on', ' · 常驻') : ''}{row.disabled ? t(' · off', ' · 已关闭') : ''}</small></td>
              <td className="is-num">{row.order}</td>
              <td className="is-num">{row.keys}</td>
              <td><select aria-label={t(`Move ${row.name} to`, `「${row.name}」移到`)} value={target} disabled={working} onChange={event => { const value = event.target.value; setTargets(current => { const next = { ...current }; if (value) next[row.uid] = value; else delete next[row.uid]; return next; }); }}>
                <option value="">{t('Stay', '不动')}</option>
                {LORE_TARGETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></td>
              <td className="cs-sort-reason">{suggestion ? suggestion.section === target ? suggestion.reason : t(`AI said ${targetName(suggestion.section)}: ${suggestion.reason}`, `AI 原建议${targetName(suggestion.section)}：${suggestion.reason}`) : ''}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    {rows.length > 0 && <div className="cs-sort-actions">
      <span className="cs-note">{t(`${picked.length} of ${rows.length} ticked`, `已勾选 ${picked.length} / ${rows.length} 条`)}</span>
      <label className="cs-sort-bulk"><span>{t('Ticked rows to', '勾选的移到')}</span>
        <select value={bulk} disabled={working} onChange={event => setBulk(event.target.value)}>{LORE_TARGETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </label>
      <button type="button" className="cs-btn is-small" disabled={working || !picked.length} onClick={moveTicked}>{busy === 'move' ? <LoaderCircle size={13} className="spinning" /> : <FolderInput size={13} />}{t(`Move to ${targetName(bulk)} · ${picked.length}`, `移到${targetName(bulk)} · ${picked.length} 条`)}</button>
      <button type="button" className="cs-btn is-small is-primary" disabled={working || !planned.length} title={t('Moves every row whose 「Move to」 column is set.', '按「移到」这一列移动所有选了分区的行。')} onClick={movePlanned}><ListChecks size={13} />{t(`Move as suggested · ${planned.length}`, `照建议移 · ${planned.length} 条`)}</button>
    </div>}
    {note && <p className="cs-note cs-sort-note" role="status">{note}</p>}
    {error && <p className="cs-form-error" role="alert">{error}</p>}
    <div className="modal-actions">
      <button type="button" className="cs-btn" disabled={busy === 'move'} onClick={close}>{t('Close', '关闭')}</button>
    </div>
  </Modal>;
}
