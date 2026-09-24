import { useState, type CSSProperties } from 'react';
import { ArrowRight, FilePenLine, FolderTree, Zap } from 'lucide-react';
import { useApp } from '../context';
import { BOARDS, findBoard, sectionLabel, type StudioBoard } from '../../shared/card-studio/boards';
import { formatDispatch } from '../../shared/card-studio/dispatch';
import { boardStats, dispatchCounts, nextStep, sectionState } from '../../shared/card-studio/progress';
import { RUN_BOARDS, runIsOpen, runQueue } from '../../shared/card-studio/run';
import { progressInputOf, relativeTime } from '../../shared/card-studio/view';
import type { CardDispatch, CardProjectView, CardRunScope } from '../../shared/card-studio/types';
import { useStudio } from './CardStudio';
import { changeStateLabel } from './ChangePanel';
import { CoverDialog } from './CoverDialog';
import { RunBar, RunDialog } from './RunPanel';
import { UnclassifiedDialog } from './UnclassifiedDialog';
import { CardCover, CoverStroke, kindLabel, stateLabel, Swatch, tilt, useNow } from './parts';

export function ProjectHome({ card }: { card: CardProjectView }) {
  const { data, api, t, run } = useApp();
  const studio = useStudio();
  const now = useNow();
  const input = progressInputOf(card, data.tasks);
  const step = nextStep(input);
  const counts = dispatchCounts(card.dispatches);
  const people = card.design.people;
  const [coverOpen, setCoverOpen] = useState(false);
  const [runScope, setRunScope] = useState<CardRunScope | null>(null);
  const [sorting, setSorting] = useState(false);
  const running = runIsOpen(card.run);
  const everything = runQueue(card.dispatches, 'all').length;
  const openChanges = card.changes.filter(change => change.status === 'draft' || change.status === 'running' || change.status === 'paused');

  /** 下一步 and dispatch rows: an unsent dispatch opens a draft with the dispatch filled in; a started one opens its conversation. */
  function openDispatch(dispatch: CardDispatch) {
    if (!dispatch.sectionId) return;
    const conversation = data.tasks.filter(task => task.projectId === card.projectId && task.card?.dispatchId === dispatch.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (conversation) { studio.openSection(card.projectId, dispatch.sectionId, conversation.id); return; }
    if (dispatch.status === 'todo') { studio.startDraft(card.projectId, dispatch.sectionId, { title: dispatch.title, text: formatDispatch(dispatch), dispatchId: dispatch.id }); studio.openSection(card.projectId, dispatch.sectionId, 'draft'); return; }
    studio.openSection(card.projectId, dispatch.sectionId);
  }
  function openBoard(board: StudioBoard) {
    const target = board.sections.find(section => sectionState(input, section.id) === 'active') ?? board.sections.find(section => sectionState(input, section.id) === 'todo') ?? board.sections[0];
    studio.openSection(card.projectId, target.id);
  }
  const stepTitle = step.kind === 'dispatch' ? `${sectionLabel(step.sectionId)}｜${step.dispatch.title}`
    : step.kind === 'build' ? t('Assembly｜all dispatches are done', '拼装｜派单已全部完成')
    : step.mode === 'refine' ? t('Planning｜refine this card', '规划｜完善优化卡') : t('Planning｜start from scratch', '规划｜从零开始制卡');

  return <main className="cs-project cs-scroll-page">
    <aside className="cs-dossier">
      <button type="button" className="cs-dossier-cover" onPointerMove={tilt.move} onPointerLeave={tilt.leave} onClick={() => setCoverOpen(true)} aria-label={t('Change the cover', '更换封面')}>
        <CardCover card={card} /><CoverStroke permanent /><i className="cs-sheen" />
        <span className="cs-cover-edit">{card.cover ? t('Cover image · change', '封面图片 · 更换') : t('Text cover · upload an image', '文字封面 · 上传图片')}</span>
      </button>
      <dl className="cs-facts">
        <dt>{t('Type', '类型')}</dt><dd>{kindLabel(card, t)}</dd>
        <dt>{t('Style preset', '风格预设')}</dt><dd><Swatch card={card} t={t} /></dd>
        <dt>{t('Folder', '文件夹')}</dt><dd><button type="button" className="cs-path" onClick={() => void run(() => api.openCardFolder(card.projectId))}>{card.path}</button></dd>
        <dt>{t('Last edited', '最近编辑')}</dt><dd>{relativeTime(card.lastEditedAt, now, data.preferences.language)}</dd>
      </dl>
      {card.error && <p className="cs-card-error" role="alert">{card.error}</p>}
    </aside>
    <section className="cs-desk">
      <header className="cs-desk-head">
        <span className="cs-kicker">DOSSIER · {t('Card project', '卡项目')}</span>
        <h1>{card.name}</h1>
        <div className="cs-next-row">
          <button type="button" className="cs-next" onClick={() => step.kind === 'dispatch' ? openDispatch(step.dispatch) : studio.openSection(card.projectId, step.sectionId)} onPointerEnter={() => studio.preview(findBoard(step.sectionId)?.color ?? null)} onPointerLeave={() => studio.preview(null)}>
            <span className="cs-next-label">{t('Next', '下一步')}</span>
            <b>{stepTitle}</b>
            {step.sectionId === 'lore-people' && people && <small>{t(`Written ${people.written} of ${people.total}`, `已写 ${people.written} / 名单 ${people.total}`)}</small>}
            <span className="cs-next-go">{t('Go', '前往')}<ArrowRight size={15} /></span>
          </button>
          <button type="button" className="cs-change-open" onClick={() => studio.openChange(card.projectId)} title={t('One sentence or an error log; the change AI lists what it affects and runs it section by section.', '一句话或一段报错：改动 AI 列出影响清单，确认后按分区一口气做完。')}>
            <FilePenLine size={16} /><span><b>{t('Ask for a change', '提改动')}</b><small>{t('or paste an error', '或贴报错')}</small></span>
          </button>
        </div>
        {openChanges.length > 0 && <ol className="cs-changes" aria-label={t('Open changes', '进行中的改动')}>{openChanges.map(change => <li key={change.id}>
          <button type="button" onClick={() => studio.openSection(card.projectId, 'plan', change.taskId && data.tasks.some(task => task.id === change.taskId) ? change.taskId : undefined)}>
            <FilePenLine size={13} /><b>{change.text.split('\n')[0]}</b>
            <em className={`is-${change.status}`}>{changeStateLabel(change, t)}{change.status === 'draft' && change.items.length > 0 ? t(` · ${change.items.length}`, ` · ${change.items.length} 条`) : ''}</em>
            <ArrowRight size={13} />
          </button>
        </li>)}</ol>}
        {card.unclassified > 0 && <button type="button" className="cs-unclassified-open" onClick={() => setSorting(true)}>
          <FolderTree size={13} /><span>{t(`${card.unclassified} unclassified entries`, `未分类条目 ${card.unclassified} 条`)}</span><em>· {t('Sort', '整理')}</em><ArrowRight size={13} />
        </button>}
        {card.design.exists && <div className="cs-desk-run">
          <button type="button" className="cs-btn is-primary" disabled={running || !everything} title={running ? t('A run is in progress.', '一键制作进行中。') : undefined} onClick={() => setRunScope('all')}><Zap size={14} />{t('Run everything', '全部开做')}<small>{t(`${everything} unsent`, `${everything} 条未派`)}</small></button>
          <span className="cs-note">{t('Sends every unsent world book, script, regex and greeting dispatch in order, then runs the assembly check.', '按顺序代发世界书、脚本、正则、开场白的全部未派派单，最后跑一次拼装检查。')}</span>
        </div>}
      </header>
      <RunBar card={card} />
      <div className="cs-boards">{BOARDS.map(board => {
        const stats = boardStats(input, board);
        return <article key={board.id} className={`cs-board ${stats.active ? 'is-active' : ''}`} style={{ '--c': board.color, gridArea: board.id } as CSSProperties} onPointerEnter={() => studio.preview(board.color)} onPointerLeave={() => studio.preview(null)}>
          <button type="button" className="cs-board-head" onClick={() => openBoard(board)}>
            <span className="cs-board-no">{board.no}</span>
            <span className="cs-board-name">{board.name}<small>{board.en}</small></span>
            <span className="cs-board-count">{stats.done} / {stats.total}</span>
          </button>
          {card.design.exists && (RUN_BOARDS as readonly string[]).includes(board.id) && (() => {
            const count = runQueue(card.dispatches, board.id as CardRunScope).length;
            return <button type="button" className="cs-board-run" disabled={running || !count} onClick={() => setRunScope(board.id as CardRunScope)}><Zap size={12} />{t('One-click making', '一键制作')}<small>{t(`${count} unsent`, `${count} 条未派`)}</small></button>;
          })()}
          <ul>{board.sections.map(section => {
            const state = sectionState(input, section.id);
            const optional = section.optional || (section.id === 'lore-plot' && card.kind === 'original');
            const label = section.id === 'lore-people' && people ? `${people.written} / ${people.total}` : stateLabel(state, t);
            return <li key={section.id}><button type="button" onClick={() => studio.openSection(card.projectId, section.id)}>
              <i className={`cs-state st-${state}`} aria-hidden="true" />
              <span>{section.name}{optional && <small>{t('Optional', '可选')}</small>}</span>
              <em>{label}</em>
            </button></li>;
          })}</ul>
        </article>;
      })}</div>
      <section className="cs-ledger" aria-label={t('Dispatch list', '派单清单')}>
        <header><h2>{t('Dispatch list', '派单清单')}</h2><span>{counts.total ? t(`${counts.done} of ${counts.total} done`, `${counts.done} / ${counts.total} 已完成`) : ''}</span></header>
        {card.dispatches.length ? <ol>{card.dispatches.map((dispatch, index) => <li key={dispatch.id} className={`is-${dispatch.status}`}>
          <button type="button" disabled={!dispatch.sectionId} onClick={() => openDispatch(dispatch)}>
            <span className="no">{String(index + 1).padStart(2, '0')}</span>
            <span className="tg">{dispatch.sectionId ? sectionLabel(dispatch.sectionId) : `${dispatch.target} · ${t('unknown section', '未知分区')}`}</span>
            <b>{dispatch.title}</b>
            <em>{dispatch.status === 'done' ? t('Done', '已完成') : dispatch.status === 'active' ? t('In progress', '进行中') : t('Not sent', '未派')}</em>
          </button>
        </li>)}</ol> : <p className="cs-ledger-empty">{t('No dispatches yet. Planning writes them once the design book is agreed.', '还没有派单。规划在设计书达成共识后写出派单。')}<button type="button" onClick={() => studio.openSection(card.projectId, 'plan')}>{t('Go to planning', '去规划')}<ArrowRight size={14} /></button></p>}
      </section>
    </section>
    {coverOpen && <CoverDialog card={card} onClose={() => setCoverOpen(false)} />}
    {runScope && <RunDialog card={card} scope={runScope} onClose={() => setRunScope(null)} />}
    {sorting && <UnclassifiedDialog card={card} onClose={() => setSorting(false)} />}
  </main>;
}
