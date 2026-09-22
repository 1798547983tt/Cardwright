import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, FileDown, FileText, Import, LoaderCircle, Plus } from 'lucide-react';
import { useApp } from '../context';
import { boardOf, sectionLabel, sectionOf } from '../../shared/card-studio/boards';
import { formatDispatch } from '../../shared/card-studio/dispatch';
import { dispatchCounts, sectionState } from '../../shared/card-studio/progress';
import { conversationsOf, markableDispatch, progressInputOf, relativeTime, runningConversation } from '../../shared/card-studio/view';
import type { CardComponentSummary, CardDispatch, CardPieceSummary, CardProjectView, PlanMode } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { useStudio } from './CardStudio';
import { stateLabel, useNow } from './parts';
import { AssemblyPanel } from './AssemblyPanel';
import { PreviewPanel } from './PreviewPanel';
import { DispatchCard, SectionThread } from './SectionThread';
import { SourcesPage } from './SourcesPage';
import { StudioComposer } from './StudioComposer';
import { KickoffOptions, useKickoffChoice } from './Kickoff';
import { PromptEditor } from './PromptEditor';
import { RunBar } from './RunPanel';
import { runIsOpen } from '../../shared/card-studio/run';
import { sectionPromptIds } from '../../shared/card-studio/prompt-files';

const ACTIVE = ['running', 'queued', 'waiting'];
const isActive = (task: Task) => ACTIVE.includes(task.status) || !!task.workerActive;
const NO_DESIGN_OK = ['plan', 'source', 'build'];

function contextPercent(task: Task): string {
  const usage = task.contextUsage;
  if (typeof usage?.tokens !== 'number') return '';
  const window = task.contextWindow || usage.window;
  return window ? `${Math.round(usage.tokens / window * 100)}%` : '';
}

/** What this section has written so far, straight from the component files. */
function ComponentList({ card, sectionId }: { card: CardProjectView; sectionId: string }) {
  const { api, t, run } = useApp();
  const [items, setItems] = useState<CardComponentSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.readCardComponents(card.projectId).then(all => { if (alive) setItems(all.filter(item => item.section === sectionId)); }, () => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [api, card.projectId, card.updatedAt, sectionId]);
  if (!items) return null;
  return <section>
    <h3>{t('Components here', '本分区组件')}<em className="cs-count">{items.length}</em></h3>
    {items.length === 0 ? <p className="cs-note">{t('Nothing written in this section yet.', '这个分区还没有写出组件。')}</p>
      : <ol className="cs-components">{items.map(item => <li key={item.uid}>
        <button type="button" onClick={() => void run(() => api.openCardFolder(card.projectId, item.bodyPath))} title={item.bodyPath}>
          <b>{item.name || t('Unnamed', '未命名')}</b>
          <small>uid {item.uid} · {item.constant ? t('always on', '常驻') : t(`${item.keys} keywords`, `关键词 ${item.keys}`)} · {item.chars.toLocaleString()} {t('chars', '字')}{item.disabled ? ` · ${t('off', '已关闭')}` : ''}</small>
        </button>
      </li>)}</ol>}
  </section>;
}

/** The regex or script pieces this card holds: open one, export it on its own, or import one back. */
function PieceList({ card, kind }: { card: CardProjectView; kind: 'regex' | 'script' }) {
  const { api, t, run, notify } = useApp();
  const [items, setItems] = useState<CardPieceSummary[] | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let alive = true;
    void api.readCardPieces(card.projectId).then(all => { if (alive) setItems(all.filter(item => item.kind === kind)); }, () => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [api, card.projectId, card.updatedAt, kind, reload]);
  if (!items) return null;
  const label = kind === 'regex' ? t('regex', '正则') : t('script', '脚本');

  async function exportOne(name: string) {
    setBusy(name);
    const result = await run(() => api.exportCardPiece(card.projectId, kind, name));
    if (result) notify(t(`Exported ${result.file}`, `已导出 ${result.file}`));
    setBusy('');
  }
  async function importOne() {
    setBusy('import');
    const report = await run(() => api.importCardPiece(card.projectId));
    if (report) notify(report.replaced
      ? t(`Replaced ${report.name}`, `已替换「${report.name}」`)
      : t(`Imported ${report.name}`, `已导入「${report.name}」`));
    setBusy('');
    setReload(value => value + 1);
  }

  return <section className="cs-pieces">
    <h3>
      {t(`The card's ${kind === 'regex' ? 'regex' : 'scripts'}`, `本卡的${label}`)}<em className="cs-count">{items.length}</em>
      <button type="button" className="cs-link" disabled={busy !== ''} onClick={() => void importOne()}><Import size={13} />{t('Import one', '导入单件')}</button>
    </h3>
    <p className="cs-note">{t(`Pieces belong to the whole card, so every ${kind === 'regex' ? 'regex' : 'script'} section shows all of them.`, `单件属于整张卡，所以${label}板块的每个分区都能看到全部${label}。`)}</p>
    {items.length === 0 ? <p className="cs-note">{t('Nothing written yet.', '还没有写出组件。')}</p>
      : <ol className="cs-components">{items.map(item => <li key={item.name}>
        <button type="button" onClick={() => void run(() => api.openCardFolder(card.projectId, item.bodyPath))} title={item.bodyPath}>
          <b>{item.title}</b>
          <small>{item.name} · {item.chars.toLocaleString()} {t('chars', '字')}{item.disabled ? ` · ${t('off', '已关闭')}` : ''}</small>
        </button>
        <button type="button" className="cs-link" disabled={busy !== ''} onClick={() => void exportOne(item.name)}>{busy === item.name ? <LoaderCircle size={13} className="spinning" /> : <FileDown size={13} />}{t('Export', '导出单件')}</button>
      </li>)}</ol>}
  </section>;
}

export function SectionPage({ card, sectionId, conversation }: { card: CardProjectView; sectionId: string; conversation?: string }) {
  const { data, api, t, run } = useApp();
  const studio = useStudio();
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState<PlanMode | null>(null);
  // The studio only navigates to sections a board has (CardStudio's openSection), so an unknown id here is a programming error.
  const board = boardOf(sectionId);
  const section = sectionOf(sectionId);
  const input = progressInputOf(card, data.tasks);
  const state = sectionState(input, sectionId);
  const conversations = conversationsOf(data.tasks, card.projectId, sectionId);
  const draft = studio.draft(card.projectId, sectionId);
  const fresh = conversation === 'new' || conversation === 'draft';
  const selected = fresh ? undefined : conversations.find(task => task.id === conversation) ?? conversations[0];
  const running = runningConversation(data.tasks, card.projectId);
  const runOpen = runIsOpen(card.run);
  const runConversation = !!running && runOpen && (card.run?.current?.taskId === running.id || card.run?.handoff?.fromTaskId === running.id);
  const markable = markableDispatch(card, sectionId, selected);
  const people = sectionId === 'lore-people' ? card.design.people : null;
  const own = card.dispatches.filter(dispatch => dispatch.sectionId === sectionId);
  const waiting = own.filter(dispatch => dispatch.status === 'todo');
  const refused = !card.design.exists && !NO_DESIGN_OK.includes(sectionId);
  const language = data.preferences.language;
  const choice = useKickoffChoice(card, !conversationsOf(data.tasks, card.projectId, 'plan').length);
  const squad = sectionId === 'plan' && selected ? data.tasks.filter(item => item.parentId === selected.id) : [];

  async function kickoff(mode: PlanMode) {
    if (starting) return;
    setStarting(mode);
    const task = await run(() => api.startCardConversation({ projectId: card.projectId, sectionId: 'plan', mode, kickoff: true, thinking: choice.thinking, ...(choice.gatewayId ? { gatewayId: choice.gatewayId } : {}), ...(choice.modelId ? { modelId: choice.modelId } : {}) }));
    setStarting(null);
    if (task) studio.openSection(card.projectId, 'plan', task.id);
  }
  function openDispatch(dispatch: CardDispatch) {
    const existing = data.tasks.filter(task => task.projectId === card.projectId && task.card?.dispatchId === dispatch.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (existing) { studio.openSection(card.projectId, sectionId, existing.id); return; }
    if (dispatch.status !== 'todo') return;
    studio.startDraft(card.projectId, sectionId, { title: dispatch.title, text: formatDispatch(dispatch), dispatchId: dispatch.id });
    studio.openSection(card.projectId, sectionId, 'draft');
  }
  const refineReason = card.origin === 'import' ? '' : t('Refining starts from an imported character card. Import arrives with component files.', '完善优化卡要从导入的角色卡开始；导入会和组件文件一起提供。');
  const kickoffButtons = <>{<KickoffOptions card={card} choice={choice} />}<div className="cs-kickoff-buttons">
    <button type="button" className="cs-btn is-plan" disabled={!!starting || !!running} onClick={() => void kickoff('scratch')}>{starting === 'scratch' ? <LoaderCircle size={14} className="spinning" /> : <Plus size={14} />}{t('Start from scratch', '从零开始制卡')}</button>
    <button type="button" className="cs-btn" disabled={!!starting || card.origin !== 'import'} title={refineReason || undefined} onClick={() => void kickoff('refine')}>{starting === 'refine' ? <LoaderCircle size={14} className="spinning" /> : <BookOpen size={14} />}{t('Refine this card', '完善优化卡')}</button>
    {refineReason && <small>{refineReason}</small>}
  </div></>;

  const previewKind = sectionId === 'regex-body' ? 'body' : sectionId === 'regex-update' ? 'update' : null;
  const preview = previewKind && <PreviewPanel key={previewKind} card={card} kind={previewKind} open={!selected} />;

  let body;
  if (sectionId === 'source') body = <div className="cs-stage-scroll"><SourcesPage card={card} /></div>;
  else if (refused) body = <div className="cs-stage-scroll"><div className="cs-refusal">
    <span className="cs-refusal-tag">{t('Design book · not written', '设计书 · 未写')}</span>
    <h2>{t('This section waits for the design book', '这个分区要等设计书')}</h2>
    <p>{t('Apart from material and assembly, sections start only after planning has written the design book, so every section works from the same decisions.', '除资料和拼装外，其他分区要等规划写出设计书才能开工，这样每个分区都按同一套决定来写。')}</p>
    <button type="button" className="cs-btn is-primary" onClick={() => studio.openSection(card.projectId, 'plan')}><ArrowLeft size={14} />{t('Back to planning', '回到规划')}</button>
  </div></div>;
  else if (selected) body = <>
    <div className="cs-stage-scroll" ref={scroller}>{sectionId === 'build' && <AssemblyPanel card={card} />}{preview}<SectionThread task={selected} card={card} scroller={scroller} /></div>
    <StudioComposer card={card} sectionId={sectionId} task={selected} />
  </>;
  else body = <>
    <div className="cs-stage-scroll" ref={scroller}><div className="cs-fresh">
      {sectionId === 'build' && <AssemblyPanel card={card} />}
      {preview}
      {sectionId === 'plan' && !draft?.text && <div className="cs-fresh-plan">
        <h2>{conversations.length ? t('Start another planning conversation', '再开一个规划对话') : t('Planning speaks first', '规划 AI 先发言')}</h2>
        <p>{t('Pick how to start. The planning AI explains the process, then asks questions in rounds, each with a recommended answer.', '选一种开始方式。规划 AI 会先说明流程，再按轮提问，每题都给推荐答案。')}</p>
        {kickoffButtons}
      </div>}
      {sectionId !== 'plan' && !draft && waiting.length > 0 && <div className="cs-fresh-dispatches">
        <h2>{t(`${waiting.length} dispatches wait here`, `这个分区有 ${waiting.length} 条未派的派单`)}</h2>
        {waiting.map(dispatch => <DispatchCard key={dispatch.id} dispatch={dispatch} card={card} />)}
      </div>}
      {draft && <p className="cs-draft-note">{draft.dispatchId ? t('A new conversation for this dispatch. Review the text below and press Send; sending starts the dispatch.', '这是这条派单的新对话。确认下方内容后按发送，发送后派单变为进行中。') : draft.title ? t(`New conversation · ${draft.title}. Nothing has been sent yet.`, `新对话 · ${draft.title}。还没有发送。`) : t('New conversation. Nothing has been sent yet.', '新对话，还没有发送。')}</p>}
      {sectionId !== 'plan' && !draft && !waiting.length && <p className="cs-note">{t('Type below to start a new conversation in this section.', '在下方输入，开始这个分区的新对话。')}</p>}
    </div></div>
    <StudioComposer card={card} sectionId={sectionId} />
  </>;

  return <main className="cs-section">
    <aside className="cs-rail" aria-label={t('Board', '板块')}>
      <header><span className="cs-rail-no">{board.no}</span><span className="cs-rail-name">{board.name}<small>{board.en}</small></span></header>
      <ul className="cs-rail-sections">{board.sections.map(item => {
        const itemState = sectionState(input, item.id);
        return <li key={item.id}><button type="button" aria-current={item.id === sectionId ? 'page' : undefined} onClick={() => studio.openSection(card.projectId, item.id)}>
          <i className={`cs-state st-${itemState}`} aria-hidden="true" /><span>{item.name}</span><em>{item.id === 'lore-people' && card.design.people ? `${card.design.people.written} / ${card.design.people.total}` : stateLabel(itemState, t)}</em>
        </button></li>;
      })}</ul>
      {sectionId !== 'source' && <section className="cs-rail-conversations">
        <header><span>{t('Conversations', '对话')}</span><button type="button" className="cs-link" disabled={refused} onClick={() => studio.openSection(card.projectId, sectionId, 'new')}><Plus size={13} />{t('New', '新对话')}</button></header>
        <ol>
          {draft && <li><button type="button" className={fresh ? 'is-current' : ''} onClick={() => studio.openSection(card.projectId, sectionId, 'draft')}><b>{draft.title || t('Unsent conversation', '未发送的新对话')}</b><small>{t('Draft · not sent', '草稿 · 未发送')}</small></button></li>}
          {conversations.map(task => <li key={task.id}><button type="button" className={task === selected ? 'is-current' : ''} onClick={() => studio.openSection(card.projectId, sectionId, task.id)}>
            <b>{isActive(task) && <LoaderCircle size={11} className="spinning" />}{task.title}</b>
            <small>{relativeTime(task.updatedAt, now, language)}{contextPercent(task) && ` · ${t('context', '上下文')} ${contextPercent(task)}`}</small>
          </button></li>)}
          {!draft && !conversations.length && <li className="cs-rail-empty">{t('No conversations yet', '还没有对话')}</li>}
        </ol>
      </section>}
      <button type="button" className="cs-rail-home" onClick={() => studio.openProject(card.projectId)}><ArrowLeft size={13} />{t('Card project home', '卡项目主页')}</button>
    </aside>

    <section className="cs-stage">
      <header className="cs-stage-head">
        <span className="cs-kicker is-board">{board.no} · {board.en.toUpperCase()}</span>
        <h1>{sectionLabel(sectionId)}</h1>
        <span className={`cs-state-tag st-${state}`}><i className={`cs-state st-${state}`} aria-hidden="true" />{stateLabel(state, t)}{section?.optional && ` · ${t('optional', '可选')}`}</span>
        {people && <span className="cs-people">{t(`Written ${people.written} of ${people.total}`, `已写 ${people.written} / 名单 ${people.total}`)}</span>}
        {markable && <button type="button" className="cs-btn is-small is-done" onClick={() => void run(() => api.markDispatchDone(card.projectId, markable.id), t('Dispatch marked done', '派单已标记完成'))}><Check size={13} />{t('Mark done', '标记完成')}</button>}
      </header>
      {card.run && sectionId !== 'source' && <RunBar card={card} here={selected?.id} />}
      {running && running.id !== selected?.id && sectionId !== 'source' && !runConversation && <div className="cs-busy" role="status">
        <LoaderCircle size={13} className="spinning" />
        <span>{t(`Another conversation of this card is running: ${sectionLabel(running.card!.sectionId)} · ${running.title}. One conversation runs per card at a time.`, `这张卡的另一个对话正在运行：${sectionLabel(running.card!.sectionId)} · ${running.title}。同一张卡同一时间只运行一个对话。`)}</span>
        <button type="button" className="cs-link" onClick={() => studio.openSection(card.projectId, running.card!.sectionId, running.id)}>{t('Go', '前往')}<ArrowRight size={12} /></button>
      </div>}
      {body}
    </section>

    <aside className="cs-brief" aria-label={t('Brief', '简报')}>
      {sectionId === 'plan' ? <>
        <section>
          <h3>{t('Design book', '设计书')}</h3>
          <p className={`cs-design ${card.design.exists ? 'is-written' : ''}`}>{card.design.exists ? t('Written', '已写') : t('Not written yet', '还没写')}</p>
          {card.design.exists && <button type="button" className="cs-link" onClick={() => void run(() => api.openCardFolder(card.projectId, '设计书.md'))}><FileText size={12} />{t('Open 设计书.md', '打开设计书.md')}</button>}
          {card.design.people && <p className="cs-note">{t(`People roster: ${card.design.people.total}`, `人物名单：${card.design.people.total} 人`)}</p>}
        </section>
        <section>
          <h3>{t('Dispatches', '派单')}</h3>
          <p className="cs-note">{card.dispatches.length ? t(`${dispatchCounts(card.dispatches).done} of ${card.dispatches.length} done`, `${dispatchCounts(card.dispatches).done} / ${card.dispatches.length} 已完成`) : t('Planning writes dispatches once the design book is agreed.', '设计书达成共识后，规划会写出派单。')}</p>
        </section>
        <section><h3>{t('Start planning', '开始规划')}</h3>{kickoffButtons}</section>
        {squad.length > 0 && <section><h3>{t('Reading squad', '读资料小队')}<em className="cs-count">{squad.length}</em></h3><ol className="cs-squad">{squad.map(member => <li key={member.id}><b>{member.agentName || member.title}</b><em>{['running', 'queued', 'waiting'].includes(member.status) || member.workerActive ? t('Reading', '读资料中') : member.status === 'completed' ? t('Back', '已归队') : member.status === 'failed' ? t('Failed', '失败') : t('Stopped', '已停止')}</em></li>)}</ol></section>}
      </> : sectionId === 'source' ? <section>
        <h3>{t('About material', '关于资料')}</h3>
        <p className="cs-note">{t('Section AIs read the design book and the material index first, then read only the chapters a task needs.', '分区 AI 开工时先读设计书和资料索引，再按任务精读相关章节，不整本通读。')}</p>
      </section> : <>
        <section>
          <h3>{t('Current dispatch', '当前派单')}</h3>
          {own.length ? <ol className="cs-brief-dispatches">{own.map(dispatch => <li key={dispatch.id} className={`is-${dispatch.status}`}><button type="button" onClick={() => openDispatch(dispatch)}>
            <b>{dispatch.title}</b><em>{dispatch.status === 'done' ? t('Done', '已完成') : dispatch.status === 'active' ? t('In progress', '进行中') : t('Not sent', '未派')}</em>
          </button>{dispatch.status === 'active' && <button type="button" className="cs-link cs-brief-done" onClick={() => void run(() => api.markDispatchDone(card.projectId, dispatch.id), t('Dispatch marked done', '派单已标记完成'))}><Check size={12} />{t('Mark done', '标记完成')}</button>}</li>)}</ol> : <p className="cs-note">{t('No dispatch targets this section yet.', '还没有派到这个分区的派单。')}</p>}
        </section>
        {people && <section><h3>{t('People roster', '人物名单')}</h3><p className="cs-note">{t(`${people.written} written, ${people.total} on the roster in 设计书.md.`, `设计书的人物名单共 ${people.total} 人，已写 ${people.written} 人。`)}</p><button type="button" className="cs-link" onClick={() => void run(() => api.openCardFolder(card.projectId, '设计书.md'))}><FileText size={12} />{t('Open 设计书.md', '打开设计书.md')}</button></section>}
      </>}
      {sectionId.startsWith('lore-') && <ComponentList card={card} sectionId={sectionId} />}
      {(board.id === 'regex' || board.id === 'script') && <PieceList card={card} kind={board.id} />}
      {data.preferences.developerMode && sectionId !== 'source' && sectionId !== 'build' && <section><h3>{t('Built-in prompt', '内置提示词')}</h3><button type="button" className="cs-link" onClick={() => setEditing(true)}><BookOpen size={12} />{t('Edit (developer mode)', '编辑（开发者模式）')}</button></section>}
    </aside>
    {editing && <PromptEditor ids={sectionPromptIds(sectionId, sectionId === 'plan' ? selected?.card?.mode ?? (card.origin === 'import' ? 'refine' : 'scratch') : undefined)} onClose={() => setEditing(false)} />}
  </main>;
}
