import { useState } from 'react';
import { ArrowRight, Check, FilePenLine, FileText, LoaderCircle, Play, X, Zap } from 'lucide-react';
import { useApp } from '../context';
import { sectionLabel, sortByDependency } from '../../shared/card-studio/boards';
import { runIsOpen, runnableSection } from '../../shared/card-studio/run';
import type { CardChange, CardDispatch, CardProjectView } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { useStudio } from './CardStudio';
import { RunDialog } from './RunPanel';

const ACTIVE = ['running', 'queued', 'waiting'];
const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';

export function changeStateLabel(change: Pick<CardChange, 'status' | 'syncing'>, t: (en: string, zh: string) => string): string {
  if (change.syncing) return t('Syncing the design book', '同步设计书');
  return { draft: t('Impact list', '影响清单待确认'), running: t('Running', '进行中'), paused: t('Paused', '已暂停'), done: t('Done', '已完成'), dropped: t('Dropped', '已放弃') }[change.status];
}

/**
 * The 改动单 of a change AI's conversation, above its thread: the 影响清单 to prune and 照单开做 while it is a draft,
 * where its run stands afterwards, 继续跑 when it paused, and what was changed once it is done.
 */
export function ChangePanel({ card, task }: { card: CardProjectView; task: Task }) {
  const { data, api, t, run: perform } = useApp();
  const studio = useStudio();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  const change = card.changes.find(item => item.id === task.card?.changeId);
  if (!change) return null;
  const act = (work: () => Promise<unknown>, done?: string) => { setBusy(true); void perform(work, done).finally(() => setBusy(false)); };
  const working = ACTIVE.includes(task.status) || !!task.workerActive;
  const run = card.run && runIsOpen(card.run) && card.run.changeId === change.id ? card.run : undefined;
  const items = sortByDependency(change.items);
  const dispatches = change.dispatchIds.flatMap(id => card.dispatches.filter(item => item.id === id));
  const drop = <button type="button" className="cs-link is-quiet" disabled={busy || working} onClick={() => act(() => api.dropCardChange(card.projectId, change.id), t('Change dropped', '已放弃这个改动'))}><X size={13} />{t('Drop this change', '放弃这个改动')}</button>;

  /** The conversation that works on a 改动派单, or its section when none has started. */
  function openDispatch(dispatch: CardDispatch) {
    if (!dispatch.sectionId) return;
    const conversation = data.tasks.filter(item => item.projectId === card.projectId && item.card?.dispatchId === dispatch.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    studio.openSection(card.projectId, dispatch.sectionId, conversation?.id);
  }

  let body;
  if (change.status === 'draft') body = <>
    {!items.length ? <p className="cs-note">{working ? <><LoaderCircle size={12} className="spinning" /> {t('The change AI is reading the card; the impact list shows here when it is written.', '改动 AI 正在读卡，影响清单写好后显示在这里。')}</> : t('No impact list yet. Tell the change AI more below, or drop this change.', '还没有影响清单。可以在下方接着和改动 AI 说，或者放弃这个改动。')}</p>
      : <ol className="cs-change-items" aria-label={t('Impact list', '影响清单')}>{items.map((item, index) => <li key={item.id} className={runnableSection(item.sectionId) ? '' : 'is-stray'}>
        <span className="no">{String(index + 1).padStart(2, '0')}</span>
        <span className="row">
          <span className="head"><em>{item.sectionId ? sectionLabel(item.sectionId) : `${item.target} · ${t('not a section one-click making can do', '一键制作去不了的分区')}`}</em><ArrowRight size={11} /><b>{item.title}</b></span>
          {firstLine(item.body) && <small>{firstLine(item.body)}</small>}
        </span>
        <button type="button" className="cs-icon" aria-label={t(`Take ${item.title} off the list`, `删掉「${item.title}」`)} title={t('Take off the list', '删掉这一条')} disabled={busy || working} onClick={() => act(() => api.removeCardChangeItem(card.projectId, change.id, item.id))}><X size={13} /></button>
      </li>)}</ol>}
    <div className="cs-change-actions">
      <button type="button" className="cs-btn is-small is-primary" disabled={busy || working || !items.length} onClick={() => setDialog(true)}><Zap size={12} />{t(`Go ahead · ${items.length}`, `照单开做 · ${items.length} 条`)}</button>
      {drop}
      {items.length > 0 && <span className="cs-note">{t('Nothing is written before you go ahead. Take out what you do not want.', '点「照单开做」之前什么都不会改；不要的条目先删掉。')}</span>}
    </div>
  </>;
  else if (change.status === 'running' || change.status === 'paused') body = <>
    {change.syncing ? <p className="cs-note"><LoaderCircle size={12} className="spinning" /> {t('The change AI is bringing the design book in line with the list; the run starts right after.', '改动 AI 正在把设计书改到与清单一致，改完就开跑。')}</p>
      : run ? <p className="cs-note">{run.status === 'paused' ? t('The run paused. The progress bar above says why and has Continue.', '一键制作暂停了，原因和【继续】在上方的进度条里。') : t(`Running: ${run.done.length} of ${run.total} done. The progress bar above follows it.`, `正在一键制作：已做完 ${run.done.length} / ${run.total} 条，进度看上方的进度条。`)}</p>
      : <>
        {change.note && <p className="cs-change-note">{change.note}</p>}
        <div className="cs-change-actions">
          <button type="button" className="cs-btn is-small is-primary" disabled={busy || working} onClick={() => setDialog(true)}><Play size={12} />{t('Carry on', '继续跑')}</button>
          {drop}
        </div>
      </>}
    {dispatches.length > 0 && <DispatchRows dispatches={dispatches} open={openDispatch} />}
  </>;
  else if (change.status === 'done') body = <>
    {change.direct?.length ? <>
      <p className="cs-note">{t('Only one component was affected, so the change AI edited it directly. To take it back, use 撤销本轮 on that turn below.', '只动了一个组件，改动 AI 已直接改好。不满意可以在下方那一轮点【撤销本轮】。')}</p>
      <ul className="cs-change-files">{change.direct.map(path => <li key={path}><button type="button" className="cs-link" onClick={() => void perform(() => api.openCardFolder(card.projectId, path))}><FileText size={12} />{path}</button></li>)}</ul>
    </> : dispatches.length > 0 && <DispatchRows dispatches={dispatches} open={openDispatch} />}
    {change.note && <p className="cs-change-note">{change.note} <button type="button" className="cs-link" onClick={() => studio.openSection(card.projectId, 'build')}>{t('Open the assembly bench', '打开拼装台')}<ArrowRight size={12} /></button></p>}
  </>;
  else body = <p className="cs-note">{t('This change was dropped; its unsent change dispatches were taken off the list.', '这个改动已放弃，还没派出的改动派单已从清单上撤下。')}</p>;

  return <section className={`cs-change is-${change.status}`} aria-label={t('Change order', '改动单')}>
    <header>
      <FilePenLine size={14} className="cs-change-icon" />
      <b>{change.kind === 'error' ? t('Error report', '报错') : t('Change order', '改动单')}</b>
      <span className="cs-change-state">{change.status === 'done' && <Check size={12} />}{changeStateLabel(change, t)}</span>
      {change.noDesignBook && <span className="cs-change-flag">{t('No design book: the components are the reference', '本卡没有设计书：以现有组件为准')}</span>}
    </header>
    <p className="cs-change-ask">{change.text}</p>
    {body}
    {dialog && <RunDialog card={card} scope="change" change={change} onClose={() => setDialog(false)} />}
  </section>;
}

/** The 改动派单 of a change and how far each got; a row opens the conversation that works on it. */
function DispatchRows({ dispatches, open }: { dispatches: CardDispatch[]; open: (dispatch: CardDispatch) => void }) {
  const { t } = useApp();
  return <ol className="cs-change-items is-dispatches" aria-label={t('Change dispatches', '改动派单')}>{dispatches.map((dispatch, index) => <li key={dispatch.id} className={`is-${dispatch.status}`}>
    <span className="no">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="row" disabled={!dispatch.sectionId} onClick={() => open(dispatch)}>
      <span className="head"><em>{dispatch.sectionId ? sectionLabel(dispatch.sectionId) : dispatch.target}</em><ArrowRight size={11} /><b>{dispatch.title}</b></span>
    </button>
    <em className="st">{dispatch.status === 'done' ? t('Done', '已完成') : dispatch.status === 'active' ? t('In progress', '进行中') : t('Not sent', '未派')}</em>
  </li>)}</ol>;
}
