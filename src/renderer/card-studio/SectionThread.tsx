import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { Components } from 'react-markdown';
import { ArrowRight, Check, ChevronRight, Copy, LoaderCircle, MessageSquarePlus, Pencil, RotateCcw, Terminal, Undo2 } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { groupConversation, ToolRecord } from '../Conversation';
import { InteractionDialog } from '../InteractionDialog';
import { TruncationNotice } from '../Notices';
import { sectionLabel } from '../../shared/card-studio/boards';
import { dispatchKey, formatDispatch, type DispatchParse } from '../../shared/card-studio/dispatch';
import { handoffOffer, type Handoff } from '../../shared/card-studio/handoff';
import { ACCEPT_ALL_TEXT, isHandoffRequest, isKickoff, segmentReply, stripMarkers } from '../../shared/card-studio/markers';
import { dispatchDone, messageAction, nextDispatch, turnWrites } from '../../shared/card-studio/view';
import { runOwns } from '../../shared/card-studio/run';
import { RevisionBar } from '../RevisionBar';
import { Markdown as KernelMarkdown } from '../conversation/Markdown';
import { ThinkingBlock } from '../conversation/Thinking';
import { RunError, ToolGroup, WorkingDots } from '../conversation/parts';
import { groupToolRuns } from '../conversation/tool-groups';
import { useArrivals, useFollowScroll } from '../conversation/motion';
import { tokenCount, undoTurnWrites, useCardActions } from './actions';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { ChatMessage, Task } from '../../shared/types';
import { useStudio } from './CardStudio';

type Turn = ReturnType<typeof groupConversation>[number];
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A web address opens in the browser; any other link stays text. */
function StudioLink({ children, href }: ComponentProps<'a'>) {
  const { api, run } = useApp();
  return href && /^https?:\/\//i.test(href)
    ? <a href={href} onClick={event => { event.preventDefault(); void run(() => api.openExternal(href)); }}>{children}</a>
    : <span>{children}</span>;
}

/** The studio skin of the conversation kernel: plain GFM, its own links; code blocks and tables are the kernel's. */
const STUDIO_MARKDOWN = { skin: 'studio' as const, components: { a: StudioLink } satisfies Components };

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return <KernelMarkdown text={text} streaming={streaming} {...STUDIO_MARKDOWN} />;
}

/** The records the conversation had when it was opened: only what arrives after fades in (handoff §5.5 ⑦). */
const Arrivals = createContext<ReadonlySet<string>>(new Set());

/**
 * A dispatch in a reply: 复制 copies it; 去这个分区 opens a draft in the target section. Neither sends anything. In a
 * change AI's conversation (`listed`) the dispatches are its 影响清单, pruned and started from the 改动单 above the
 * thread, so the card says so instead of offering 去这个分区.
 */
export function DispatchCard({ dispatch, card, listed }: { dispatch: DispatchParse; card: CardProjectView; listed?: boolean }) {
  const { api, t, notify } = useApp();
  const studio = useStudio();
  if ('error' in dispatch) return <div className="cs-dispatch is-broken"><header><span className="cs-dispatch-no">{t('Dispatch', '派单')}</span><em>{dispatch.error}</em></header><pre>{dispatch.raw}</pre></div>;
  const parsed = dispatch;
  const registered = card.dispatches.find(item => dispatchKey(item) === dispatchKey(parsed));
  const index = registered ? card.dispatches.indexOf(registered) + 1 : 0;
  const status = registered?.status;
  function go() {
    const sectionId = parsed.sectionId;
    if (!sectionId) return;
    studio.startDraft(card.projectId, sectionId, { title: parsed.title, text: formatDispatch(parsed), dispatchId: registered?.id });
    studio.openSection(card.projectId, sectionId, 'draft');
    notify(t(`Opened a new conversation in ${sectionLabel(sectionId)}. The dispatch is in the composer; press Send when ready.`, `已在「${sectionLabel(sectionId)}」开新对话，派单填进了输入框，确认后按发送。`));
  }
  return <article className={`cs-dispatch ${status ? `is-${status}` : ''}`}>
    <header>
      <span className="cs-dispatch-no">{index ? t(`Dispatch ${String(index).padStart(2, '0')}`, `派单 ${String(index).padStart(2, '0')}`) : t('Dispatch', '派单')}</span>
      <span className="cs-dispatch-target">{dispatch.sectionId ? sectionLabel(dispatch.sectionId) : `${dispatch.target} · ${t('unknown section', '未知分区')}`}</span>
      {status && <em>{status === 'done' ? t('Done', '已完成') : status === 'active' ? t('In progress', '进行中') : t('Not sent', '未派')}</em>}
    </header>
    <h4>{dispatch.title}</h4>
    {dispatch.requires && <p className="cs-dispatch-requires">{t('Requires', '前置')}：{dispatch.requires}</p>}
    <div className="cs-dispatch-body">{dispatch.body}</div>
    <footer>
      <button type="button" className="cs-btn is-small" onClick={() => void api.copyText(formatDispatch(dispatch)).then(() => notify(t('Dispatch copied', '已复制派单')), () => notify(t('Could not copy', '复制失败')))}><Copy size={13} />{t('Copy', '复制')}</button>
      {listed
        ? <span className="cs-note cs-dispatch-listed">{t('On the impact list: prune it in the change order above, then Go ahead.', '已列入影响清单：在上面的改动单里删减后照单开做')}</span>
        : <button type="button" className="cs-btn is-small is-primary" disabled={!dispatch.sectionId} onClick={go}>{t('Go to this section', '去这个分区')}<ArrowRight size={13} /></button>}
    </footer>
  </article>;
}

/** A handoff summary in a reply. The app decides when to change conversations, so the summary itself offers no button. */
function HandoffCard({ handoff, raw, requested }: { handoff: Handoff | null; raw: string; requested: boolean }) {
  const { t } = useApp();
  if (!handoff) return <div className="cs-handoff is-broken"><p>{t('This handoff summary is incomplete; it needs 已定, 已写, 未完成 and 第一步.', '这份交接摘要不完整，需要「已定、已写、未完成、第一步」四项。')}</p><pre>{raw}</pre></div>;
  return <section className="cs-handoff">
    <h4>{t('Handoff summary', '交接摘要')}</h4>
    <dl>
      <dt>{t('Decided', '已定的决定')}</dt><dd>{handoff.decided}</dd>
      <dt>{t('Written', '已写的组件')}</dt><dd>{handoff.written}</dd>
      <dt>{t('Pending', '未完成事项')}</dt><dd>{handoff.pending}</dd>
      <dt>{t('First step', '新对话第一步')}</dt><dd>{handoff.first}</dd>
    </dl>
    {requested && <p className="cs-note">{t('A new conversation in this section starts from this summary.', '这个分区的新对话会从这份摘要开始。')}</p>}
  </section>;
}

/**
 * The end of a finished conversation: once its dispatch is done, the way to the next dispatch; before that, the app's
 * offer of a new conversation when the context reaches the threshold (§5.2).
 */
function ConversationEnd({ task, card }: { task: Task; card: CardProjectView }) {
  const { data, t } = useApp();
  const actions = useCardActions(card);
  const [asking, setAsking] = useState(false);
  if (dispatchDone(card, task)) {
    const next = nextDispatch(card);
    return <div className="cs-end-bar"><span><Check size={13} />{t('This dispatch is done.', '这条派单已完成。')}</span>
      {next ? <button type="button" className="cs-btn is-small is-primary" onClick={actions.openNextDispatch}>{t('Next dispatch', '去下一条派单')}<ArrowRight size={13} /></button> : <small>{t('Every dispatch has been sent.', '派单都已经发出去了。')}</small>}
    </div>;
  }
  const handoff = task.card?.handoff;
  const offer = handoffOffer({ tokens: task.contextUsage?.tokens, window: task.contextWindow || task.contextUsage?.window || 0, settings: data.preferences.cardHandoff, dispatchDone: false, active: false, handoff });
  if (!offer.offer) return null;
  return <div className="cs-end-bar is-offer" role="status">
    <span><MessageSquarePlus size={13} />{t(`Context used: ${tokenCount(offer.used)}. A new conversation is suggested.`, `上下文已用 ${tokenCount(offer.used)}，建议换对话`)}</span>
    <small>{handoff?.status === 'failed' ? t('The last request returned no summary; try again.', '上次没有拿到交接摘要，可以再试一次。') : t(`Threshold ${tokenCount(offer.threshold)}`, `阈值 ${tokenCount(offer.threshold)}`)}</small>
    <button type="button" className="cs-btn is-small is-primary" disabled={asking} onClick={() => { setAsking(true); void actions.requestHandoff(task).finally(() => setAsking(false)); }}>{asking ? <LoaderCircle size={13} className="spinning" /> : null}{t('New conversation', '换对话')}</button>
  </div>;
}

/**
 * A message the user sent. `started` marks the first message of a conversation that began with the kickoff, whose line an
 * override may have changed. 撤回 (Q16): while its turn runs, the latest message is withdrawn; once written, a message is
 * edited into a new conversation version. The unsent draft is withdrawn from the composer.
 */
function UserMessage({ message, started, task, card, editSignal }: { message: ChatMessage; started?: 'scratch' | 'refine'; task: Task; card: CardProjectView; editSignal?: number }) {
  const { api, t, run, notify } = useApp();
  const studio = useStudio();
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(message.text);
  const [asking, setAsking] = useState(false); const [busy, setBusy] = useState(false);
  const entering = useContext(Arrivals).has(message.id) ? '' : ' conv-enter';
  // A double Esc in the thread opens the latest written message for editing, as in the workbench.
  useEffect(() => { if (editSignal && messageAction(task, message.id, { runOwned: runOwns(card.run, task.id) }) === 'edit') { setDraft(message.text); setEditing(true); } }, [editSignal]);
  const kickoff = started ?? isKickoff(message.text);
  if (isHandoffRequest(message.text)) return <div className={`cs-kickoff is-handoff${entering}`}>{t('Asked the AI for a handoff summary', '已请 AI 写交接摘要')}<time>{clock(message.at)}</time></div>;
  if (kickoff) return <div className={`cs-kickoff${entering}`}>{kickoff === 'refine' ? t('Planning started · refine this card', '已开始规划 · 完善优化卡') : t('Planning started · start from scratch', '已开始规划 · 从零开始制卡')}<time>{clock(message.at)}</time></div>;
  const action = messageAction(task, message.id, { runOwned: runOwns(card.run, task.id) });
  const writes = turnWrites(task.tools, message.turnId || message.id, card.path);

  async function withdraw(undoWrites: boolean) {
    setBusy(true);
    const result = await run(() => api.withdrawCardMessage(task.id, message.id));
    if (result) {
      const waiting = studio.composerText(task.id).trim();
      studio.setComposerText(task.id, waiting ? `${result.text}\n\n${waiting}` : result.text);
      const undone = undoWrites ? await run(() => undoTurnWrites(api, t, task.id, result.turnId)) : undefined;
      notify([t('Withdrawn; the text is back in the composer.', '已撤回，文字放回了输入框。'), undone].filter(Boolean).join(' '));
    }
    setBusy(false); setAsking(false);
  }
  async function regenerate() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    const done = await run(async () => { await api.regenerate(task.id, message.id, text); return true; });
    setBusy(false);
    if (done) setEditing(false);
  }

  return <article className={`cs-msg is-user ${editing ? 'is-editing' : ''}${entering}`} data-message-id={message.id}>
    <header><b>{t('You', '你')}</b>{message.pending && <em>{t('Queued', '等待发送')}</em>}<time>{clock(message.at)}</time>
      {!editing && <span className="cs-msg-actions">
        <button type="button" className="cs-icon" aria-label={t('Copy message', '复制消息')} title={t('Copy message', '复制消息')} onClick={() => void run(() => api.copyText(message.text), t('Message copied', '消息已复制'))}><Copy size={13} /></button>
        {!action ? null : action === 'withdraw'
          ? <button type="button" className="cs-icon" aria-label={t('Withdraw this message', '撤回这条消息')} title={t('Withdraw: stop this turn and put the text back', '撤回：停下这一轮，文字放回输入框')} disabled={busy} onClick={() => setAsking(true)}><Undo2 size={13} /></button>
          : <button type="button" className="cs-icon" aria-label={t('Edit message & regenerate', '编辑消息并重新生成')} title={t('Edit message & regenerate', '编辑消息并重新生成')} disabled={busy} onClick={() => { setDraft(message.text); setEditing(true); }}><Pencil size={13} /></button>}
      </span>}
    </header>
    {editing ? <form className="cs-edit" onSubmit={event => { event.preventDefault(); void regenerate(); }}>
      <textarea aria-label={t('Edit your message', '编辑你的消息')} autoFocus value={draft} disabled={busy} rows={Math.min(12, Math.max(3, draft.split('\n').length))} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void regenerate(); } }} />
      <p className="cs-note">{t('Creates a new conversation version from this message. Files already written stay as they are; use 撤销本轮 to take them back.', '从这条消息开一个新的对话版本。已经写进卡项目的文件保持现状，要退回用【撤销本轮】。')}</p>
      <div className="cs-edit-actions"><span>Ctrl Enter</span><button type="button" className="cs-btn is-small" disabled={busy} onClick={() => setEditing(false)}>{t('Cancel', '取消')}</button><button className="cs-btn is-small is-primary" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle size={13} className="spinning" /> : null}{t('Save & regenerate', '保存并重新生成')}</button></div>
    </form> : segmentReply(message.text).map((segment, index) => segment.type === 'markdown' ? <div key={index} className="cs-user-text">{segment.text}</div>
      : segment.type === 'dispatch' ? <div key={index} className="cs-sent-block">{t('Dispatch sent', '已发送派单')}：{'error' in segment.dispatch ? segment.dispatch.error : `${segment.dispatch.sectionId ? sectionLabel(segment.dispatch.sectionId) : segment.dispatch.target} · ${segment.dispatch.title}`}</div>
      : <div key={index} className="cs-sent-block">{t('Handoff summary sent', '已发送交接摘要')}{segment.handoff ? `：${segment.handoff.first}` : ''}</div>)}
    {asking && <Modal title={t('Withdraw this message?', '撤回这条消息？')} className="studio-modal small-modal" onClose={() => { if (!busy) setAsking(false); }}>
      <p className="modal-intro">{t('The AI stops this turn. The message and this turn’s reply leave the conversation, and the text goes back to the composer.', 'AI 会停下这一轮，这条消息和这一轮的回复从对话里移走，文字放回输入框。')}{message.dispatchId ? t(' The dispatch it sent goes back to Not sent.', '它发出的派单回到「未派」。') : ''}</p>
      {writes.length > 0 && <p className="modal-intro">{t(`This turn has already written ${writes.length} components: ${writes.map(item => item.name).join(', ')}. Withdrawing does not take files back by itself.`, `这一轮已经写入了 ${writes.length} 个组件：${writes.map(item => item.name).join('、')}。撤回不会自动退回文件。`)}</p>}
      <div className="modal-actions">
        <button type="button" className="cs-btn" disabled={busy} onClick={() => setAsking(false)}>{t('Cancel', '取消')}</button>
        {writes.length > 0 && <button type="button" className="cs-btn" disabled={busy} onClick={() => void withdraw(true)}>{t('Withdraw and undo this turn', '撤回并撤销本轮写入')}</button>}
        <button type="button" className="cs-btn is-danger" disabled={busy} onClick={() => void withdraw(false)}>{busy ? <LoaderCircle size={13} className="spinning" /> : <Undo2 size={13} />}{t('Withdraw', '撤回')}</button>
      </div>
    </Modal>}
  </article>;
}

function WrittenThisTurn({ task, turn, card, canUndo }: { task: Task; turn: Turn; card: CardProjectView; canUndo: boolean }) {
  const { api, t, run, notify } = useApp();
  const writes = turnWrites(task.tools, turn.id, card.path);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  if (!writes.length) return null;
  async function undo() { notify(await undoTurnWrites(api, t, task.id, turn.id)); }
  return <section className="cs-writes">
    <header><span>{t('Written this turn', '本轮写入')}</span><em>{writes.length}</em>{canUndo && <button type="button" className="cs-undo" onClick={() => setConfirm(true)}><RotateCcw size={12} />{t('Undo this turn', '撤销本轮')}</button>}</header>
    {writes.map(write => <details key={write.name} className="cs-write">
      <summary><ChevronRight size={13} /><b>{write.name}</b><span>{write.op === 'edit' ? t('Edited', '修改') : t('Written', '写入')}</span><small>{write.paths.join(' · ')}</small></summary>
      {(write.patch || write.preview) ? <pre className="cs-diff">{write.patch ?? write.preview}</pre> : <p className="cs-note">{t('No preview for this change.', '这次改动没有预览。')}</p>}
    </details>)}
    {confirm && <Modal title={t('Undo this turn?', '撤销本轮？')} className="studio-modal small-modal" onClose={() => { if (!busy) setConfirm(false); }}>
      <p className="modal-intro">{t('Files changed in this turn go back to how they were before it started. Later manual edits to the same files are not overwritten; those files are reported instead.', '这一轮改过的文件会恢复到本轮开始前的样子。之后又手动改过的文件不会被覆盖，会提示你。')}</p>
      <div className="modal-actions"><button type="button" className="cs-btn" disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel', '取消')}</button><button type="button" className="cs-btn is-danger" disabled={busy} onClick={() => { setBusy(true); void run(undo).then(() => { setBusy(false); setConfirm(false); }); }}>{t('Undo', '撤销')}</button></div>
    </Modal>}
  </section>;
}

function TurnView({ task, turn, card, last, editSignal }: { task: Task; turn: Turn; card: CardProjectView; last: boolean; editSignal?: number }) {
  const { api, t, run } = useApp();
  const studio = useStudio();
  const active = ['running', 'queued', 'waiting'].includes(task.status) || !!task.workerActive;
  const assistant = turn.entries.filter(entry => entry.type === 'message' && entry.item.role === 'assistant');
  const final = assistant.findLast(entry => entry.type === 'message' && entry.item.text.trim());
  const finalMessage = final?.type === 'message' ? final.item : undefined;
  const tools = turn.entries.filter(entry => entry.type === 'tool');
  const notices = turn.entries.flatMap(entry => entry.type === 'message' && entry.item.role === 'system' && !entry.item.usage && entry.item.text ? [entry.item] : []);
  // The reply being written: the turn's newest record while the task runs. Its thinking (else the reply's) shows in the
  // thread, live while the model thinks; the other thoughts stay in the work log with the tools (handoff §5.5 ②④).
  const newest = turn.entries[turn.entries.length - 1];
  const streaming = task.status === 'running' && last && newest?.type === 'message' && newest.item.role === 'assistant' ? newest.item : undefined;
  const featured = streaming ?? finalMessage;
  const thinkingLive = !!streaming && streaming.thinkingMs === undefined && !streaming.text.trim();
  const logged = turn.entries.filter(entry => entry.type === 'tool' || (!!entry.item.thinking && entry.item.id !== featured?.id));
  const thinking = logged.filter(entry => entry.type === 'message').length;
  const logEntry = (entry: Turn['entries'][number]) => entry.type === 'tool' ? <ToolRecord key={entry.item.id} tool={entry.item} /> : <ThinkingBlock key={entry.item.id} message={entry.item} live={false} {...STUDIO_MARKDOWN} />;
  const thinkingView = featured?.thinking ? <ThinkingBlock key={featured.id} message={featured} live={thinkingLive} {...STUDIO_MARKDOWN} /> : null;
  const thinkingFirst = !finalMessage || featured === finalMessage;
  const replyStreaming = !!streaming && streaming === finalMessage;
  const arrived = useContext(Arrivals);
  const entering = (turn.entries[0] ? arrived.has(turn.entries[0].item.id) : !turn.user || arrived.has(turn.user.id)) ? '' : ' conv-enter';
  const reply = finalMessage ? stripMarkers(finalMessage.text) : undefined;
  const truncatedHere = task.truncation && !active && (task.truncation.turnId ? task.truncation.turnId === turn.id : last);
  return <section className="cs-turn">
    {turn.user && <UserMessage message={turn.user} task={task} card={card} editSignal={editSignal} started={task.card?.kickoff && turn.user.id === task.messages.find(message => message.role === 'user')?.id ? task.card.mode === 'refine' ? 'refine' : 'scratch' : undefined} />}
    {(turn.entries.length > 0 || (last && active)) && <article className={`cs-msg is-ai${entering}`}>
      <header><b>{t(`${sectionLabel(task.card!.sectionId)} AI`, `${sectionLabel(task.card!.sectionId)} AI`)}</b>{last && active && <em className="cs-live-label">{t('Working', '处理中')}</em>}{turn.entries[0] && <time>{clock(turn.entries[0].at)}</time>}
        {reply && <span className="cs-msg-actions"><button type="button" className="cs-icon" aria-label={t('Copy response', '复制回复')} title={t('Copy response', '复制回复')} onClick={() => void run(() => api.copyText(reply.text), t('Response copied', '已复制回复'))}><Copy size={13} /></button></span>}
      </header>
      {logged.length > 0 && <details className="cs-process"><summary><ChevronRight size={13} />{t('Work log', '处理过程')}<small>{tools.length ? t(`${tools.length} tool calls`, `${tools.length} 次工具调用`) : t(`${thinking} reasoning steps`, `${thinking} 段思考`)}</small>{last && active && <LoaderCircle size={12} className="spinning" />}</summary>
        <div className="cs-process-body">{groupToolRuns(logged, entry => entry.type === 'tool' ? { tool: entry.item.name } : 'quiet').map(item => item.kind === 'group'
          ? <ToolGroup key={`group-${item.items[0].item.id}`} name={item.name} calls={item.calls.flatMap(entry => entry.type === 'tool' ? [entry.item] : [])}>{item.items.map(logEntry)}</ToolGroup>
          : logEntry(item.item))}</div>
      </details>}
      {thinkingFirst && thinkingView}
      {notices.map(notice => <p key={notice.id} className="cs-notice">{notice.text}</p>)}
      {reply && segmentReply(reply.text).map((segment, index, segments) => segment.type === 'markdown' ? <div key={index} className={`cs-md${replyStreaming && index === segments.length - 1 ? ' conv-live' : ''}`}><Markdown text={segment.text} streaming={replyStreaming && index === segments.length - 1} /></div>
        : segment.type === 'dispatch' ? <DispatchCard key={index} dispatch={segment.dispatch} card={card} listed={!!task.card?.changeId} />
        : <HandoffCard key={index} handoff={segment.handoff} raw={segment.raw} requested={!!turn.user && isHandoffRequest(turn.user.text)} />)}
      {!thinkingFirst && thinkingView}
      <WrittenThisTurn task={task} turn={turn} card={card} canUndo={last && !active} />
      {truncatedHere && <TruncationNotice task={task} userMessageId={turn.user?.id} />}
      {last && !active && reply?.hasAcceptAll && <div className="cs-accept">
        <button type="button" className="cs-btn is-plan" onClick={() => studio.setComposerText(task.id, ACCEPT_ALL_TEXT)}><Check size={14} />{t('Accept all recommendations', '全部按推荐')}</button>
        <small>{t('Only fills the composer; you press Send.', '只填进输入框，由你按发送')}</small>
      </div>}
    </article>}
  </section>;
}

export function SectionThread({ task, card, scroller }: { task: Task; card: CardProjectView; scroller: React.RefObject<HTMLDivElement | null> }) {
  const { data, api, t, run } = useApp();
  const turns = useMemo(() => groupConversation(task), [task.messages, task.tools]);
  const active = ['running', 'queued', 'waiting'].includes(task.status) || !!task.workerActive;
  const lastTurn = turns.findLastIndex(turn => !turn.user?.pending);
  const approvals = data.approvals.filter(approval => approval.taskId === task.id);
  // The stage eases after the reply while the reader is at the bottom and lets go when they scroll up (handoff §5.5 ⑤).
  useFollowScroll(scroller, [task.messages, task.tools, approvals.length, task.status], task.id);
  const arrived = useArrivals(`${task.id}:${task.activeRevisionId ?? ''}`, task);
  // Esc stops this turn and a second Esc within a moment edits the latest message, as in the workbench; one-click
  // making's conversations are stopped from its own bar.
  const [editSignal, setEditSignal] = useState(0);
  const lastEscape = useRef(0);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], .popover')) return;
      if ((event.target as HTMLElement | null)?.closest('.cs-edit, input, select')) return;
      const now = Date.now(); const again = now - lastEscape.current < 800; lastEscape.current = now;
      if (again) { setEditSignal(value => value + 1); return; }
      if (active && !runOwns(card.run, task.id)) void run(() => api.cancelTask(task.id));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [task.id, active, card.run]);
  return <Arrivals.Provider value={arrived}><div className="cs-thread">
    <RevisionBar task={task} className="cs-revisions" />
    {turns.length === 0 && <p className="cs-note cs-thread-empty">{t('This conversation has no messages yet.', '这个对话还没有消息。')}</p>}
    {turns.map((turn, index) => <TurnView key={`${task.activeRevisionId || 'original'}-${turn.id}`} task={task} turn={turn} card={card} last={index === lastTurn} editSignal={index === lastTurn ? editSignal : undefined} />)}
    {data.interactions.filter(interaction => interaction.taskId === task.id).map(interaction => <InteractionDialog key={interaction.id} interaction={interaction} inline />)}
    {approvals.map(approval => <section key={approval.id} className="cs-approval" aria-label={t('Approval required', '需要审批')}>
      <h4><Terminal size={15} />{t('Permission to continue', '允许继续执行')}</h4>
      <p>{approval.reason}</p>
      <pre>{approval.toolName}{'\n'}{JSON.stringify(approval.args, null, 2)}</pre>
      <div className="modal-actions"><button type="button" className="cs-btn" onClick={() => void run(() => api.approve(approval.id, false))}>{t('Deny', '拒绝')}</button><button type="button" className="cs-btn is-primary" onClick={() => void run(() => api.approve(approval.id, true))}>{t('Allow once', '允许本次')}</button></div>
    </section>)}
    {task.error && !task.truncation && !active && <RunError message={task.error} skin="studio" />}
    {!active && !task.error && <ConversationEnd task={task} card={card} />}
    {active && !approvals.length && <div className="cs-working"><WorkingDots />{task.status === 'queued' ? t('Queued · waiting for an agent slot', '已排队 · 等待空闲名额') : task.status === 'waiting' ? t('Waiting for your answer or approval', '等待你的回答或审批') : t('Working…', '正在处理…')}</div>}
  </div></Arrivals.Provider>;
}
