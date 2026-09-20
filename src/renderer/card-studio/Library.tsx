import { useState, type CSSProperties } from 'react';
import { FolderOpen, Import, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../context';
import { MenuItem, Modal, Popover } from '../primitives';
import { dispatchCounts } from '../../shared/card-studio/progress';
import { runIsOpen } from '../../shared/card-studio/run';
import { relativeTime } from '../../shared/card-studio/view';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { useStudio } from './CardStudio';
import { ImportCardDialog } from './ImportCardDialog';
import { NewCardDialog } from './NewCardDialog';
import { CardCover, CoverStroke, kindLabel, Swatch, tilt, useNow } from './parts';

function progressText(card: CardProjectView, tasks: Task[], t: (en: string, zh: string) => string): string | null {
  if (card.dispatches.length) return null;
  if (card.design.exists) return t('Dispatches pending', '待写派单');
  return tasks.some(task => task.projectId === card.projectId && task.card?.sectionId === 'plan') ? t('Planning', '规划中') : t('Not planned', '未规划');
}

export function Library() {
  const { data, api, t, run, notify } = useApp();
  const studio = useStudio();
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<CardProjectView | null>(null);
  const [busy, setBusy] = useState(false);
  const cards = [...(data.cardStudio?.cards ?? [])].sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
  const language = data.preferences.language;
  return <main className="cs-library cs-scroll-page">
    <header className="cs-lib-head">
      <div>
        <span className="cs-kicker">VAULT · {t('Card projects', '卡项目陈列')}</span>
        <h1>{t('Card library', '卡库')}</h1>
        <p>{cards.length ? t(`${cards.length} card projects · most recently edited first`, `${cards.length} 张卡项目 · 按最近编辑排列`) : t('No card projects yet', '还没有卡项目')}</p>
      </div>
      <div className="cs-lib-actions">
        <button type="button" className="cs-btn is-primary" onClick={() => setCreating(true)}><Plus size={15} />{t('New card project', '新建卡项目')}</button>
        <button type="button" className="cs-btn" onClick={() => setImporting(true)}><Import size={15} />{t('Import character card', '导入角色卡')}</button>
      </div>
    </header>
    {cards.length ? <ol className="cs-wall">{cards.map((card, index) => {
      const counts = dispatchCounts(card.dispatches); const status = progressText(card, data.tasks, t);
      return <li key={card.projectId} className="cs-item" style={{ '--i': index } as CSSProperties}>
        <button type="button" className="cs-cover-button" onClick={() => studio.openProject(card.projectId)} onPointerMove={tilt.move} onPointerLeave={tilt.leave} aria-label={t(`Open ${card.name}`, `打开卡项目「${card.name}」`)}>
          <CardCover card={card} /><CoverStroke /><i className="cs-sheen" />
        </button>
        <div className="cs-caption">
          <b>{card.name}</b>
          <time dateTime={card.lastEditedAt}>{relativeTime(card.lastEditedAt, now, language)}</time>
          <span className="cs-kind">{kindLabel(card, t)}</span>
          <Swatch card={card} t={t} />
          {status ? <span className="cs-progress is-text">{status}</span> : <span className="cs-progress"><i style={{ '--p': counts.total ? counts.done / counts.total : 0 } as CSSProperties} /><em>{t(`Dispatches ${counts.done} / ${counts.total}`, `派单 ${counts.done} / ${counts.total}`)}</em></span>}
          {runIsOpen(card.run) && <span className={`cs-run-chip is-${card.run!.status}`}>{card.run!.status === 'paused' ? t('One-click making paused', '一键制作已暂停') : t('One-click making', '一键制作中')}</span>}
          {card.error && <span className="cs-card-error" role="alert">{card.error}</span>}
          <Popover label={t(`Actions for ${card.name}`, `「${card.name}」的操作`)} align="right" className="cs-card-menu" trigger={<MoreHorizontal size={16} />}>{close => <>
            <MenuItem onClick={() => { close(); void run(() => api.openCardFolder(card.projectId)); }}><FolderOpen size={15} />{t('Open folder', '打开文件夹')}</MenuItem>
            <MenuItem onClick={() => { close(); setRemoving(card); }}><Trash2 size={15} />{t('Remove from library', '移除登记')}</MenuItem>
          </>}</Popover>
        </div>
      </li>;
    })}</ol> : <div className="cs-empty-library">
      <p>{t('A card project is a folder for one character card: material, design book, components and exports.', '卡项目是一张角色卡的工作文件夹，放资料、设计书、组件和导出的卡。')}</p>
      <button type="button" className="cs-btn is-primary" onClick={() => setCreating(true)}><Plus size={15} />{t('New card project', '新建卡项目')}</button>
    </div>}
    {importing && <ImportCardDialog onClose={() => setImporting(false)} onImported={(view, report) => {
      setImporting(false);
      notify(t(`Imported: ${report.lore} world book entries, ${report.regex} regex, ${report.scripts} scripts.`, `已导入：世界书 ${report.lore} 条、正则 ${report.regex} 条、脚本 ${report.scripts} 个。`));
      studio.openProject(view.projectId);
    }} />}
    {creating && <NewCardDialog onClose={() => setCreating(false)} onCreated={(view, reused) => { setCreating(false); if (reused) notify(t('This folder was already a card project; it is back in the library.', '这个文件夹已经是卡项目，已登记回卡库。')); studio.openProject(view.projectId); }} />}
    {removing && <Modal title={t('Remove this card from the library?', '从卡库移除这张卡？')} className="studio-modal small-modal" onClose={() => { if (!busy) setRemoving(null); }}>
      <p className="modal-intro">{t(`「${removing.name}」 leaves the card library and its conversation records are removed. The folder and every file in it stay where they are:`, `「${removing.name}」会从卡库移除，这张卡的对话记录也会一并移除。文件夹和里面的文件都原样保留：`)}</p>
      <p className="cs-path">{removing.path}</p>
      <div className="modal-actions">
        <button type="button" className="cs-btn" disabled={busy} onClick={() => setRemoving(null)}>{t('Cancel', '取消')}</button>
        <button type="button" className="cs-btn is-danger" disabled={busy} onClick={() => { setBusy(true); void run(() => api.removeCardProject(removing.projectId), t('Removed from the library. The folder is kept.', '已从卡库移除，文件夹保留。')).then(() => { setBusy(false); setRemoving(null); }); }}>{t('Remove', '移除登记')}</button>
      </div>
    </Modal>}
  </main>;
}
