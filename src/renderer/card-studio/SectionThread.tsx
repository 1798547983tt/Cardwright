import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Check, ChevronRight, Copy, LoaderCircle, MessageSquarePlus, RotateCcw, Terminal } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { groupConversation, ToolRecord } from '../Conversation';
import { InteractionDialog } from '../InteractionDialog';
import { TruncationNotice } from '../Notices';
import { sectionLabel } from '../../shared/card-studio/boards';
import { dispatchKey, formatDispatch, type DispatchParse } from '../../shared/card-studio/dispatch';
import { handoffOffer, type Handoff } from '../../shared/card-studio/handoff';
import { ACCEPT_ALL_TEXT, isHandoffRequest, isKickoff, segmentReply, stripMarkers } from '../../shared/card-studio/markers';
import { dispatchDone, nextDispatch, turnWrites } from '../../shared/card-studio/view';
import { tokenCount, useCardActions } from './actions';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { ChatMessage, Task } from '../../shared/types';
import { useStudio } from './CardStudio';

type Turn = ReturnType<typeof groupConversation>[number];
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Markdown({ text }: { text: string }) {
  const { api, run } = useApp();
  return useMemo(() => <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => href && /^https?:\/\//i.test(href)
    ? <a href={href} onClick={event => { event.preventDefault(); void run(() => api.openExternal(href)); }}>{children}</a>
    : <span>{children}</span> }}>{text}</ReactMarkdown>, [text, api, run]);
}

/** A dispatch in a reply: 复制 copies it; 去这个分区 opens a draft in the target section. Neither sends anything. */
export function DispatchCard({ dispatch, card }: { dispatch: DispatchParse; card: CardProjectView }) {
  const { t, notify } = useApp();
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
      <button type="button" className="cs-btn is-small" onClick={() => void navigator.clipboard.writeText(formatDispatch(dispatch)).then(() => notify(t('Dispatch copied', '已复制派单')), () => notify(t('Could not copy', '复制失败')))}><Copy size={13} />{t('Copy', '复制')}</button>
      <button type="button" className="cs-btn is-small is-primary" disabled={!dispatch.sectionId} onClick={go}>{t('Go to this section', '去这个分区')}<ArrowRight size={13} /></button>
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

/** `started` marks the first message of a conversation that began with the kickoff, whose line an override may have changed. */
function UserMessage({ message, started }: { message: ChatMessage; started?: 'scratch' | 'refine' }) {
  const { t } = useApp();
  const kickoff = started ?? isKickoff(message.text);
  if (isHandoffRequest(message.text)) return <div className="cs-kickoff is-handoff">{t('Asked the AI for a handoff summary', '已请 AI 写交接摘要')}<time>{clock(message.at)}</time></div>;
  if (kickoff) return <div className="cs-kickoff">{kickoff === 'refine' ? t('Planning started · refine this card', '已开始规划 · 完善优化卡') : t('Planning started · start from scratch', '已开始规划 · 从零开始制卡')}<time>{clock(message.at)}</time></div>;
  return <article className="cs-msg is-user">
    <header><b>{t('You', '你')}</b>{message.pending && <em>{t('Queued', '等待发送')}</em>}<time>{clock(message.at)}</time></header>
    {segmentReply(message.text).map((segment, index) => segment.type === 'markdown' ? <div key={index} className="cs-user-text">{segment.text}</div>
      : segment.type === 'dispatch' ? <div key={index} className="cs-sent-block">{t('Dispatch sent', '已发送派单')}：{'error' in segment.dispatch ? segment.dispatch.error : `${segment.dispatch.sectionId ? sectionLabel(segment.dispatch.sectionId) : segment.dispatch.target} · ${segment.dispatch.title}`}</div>
      : <div key={index} className="cs-sent-block">{t('Handoff summary sent', '已发送交接摘要')}{segment.handoff ? `：${segment.handoff.first}` : ''}</div>)}
  </article>;
}

function WrittenThisTurn({ task, turn, card, canUndo }: { task: Task; turn: Turn; card: CardProjectView; canUndo: boolean }) {
  const { api, t, run, notify } = useApp();
  const writes = turnWrites(task.tools, turn.id, card.path);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  if (!writes.length) return null;
  async function undo() {
    const checkpoint = (await api.checkpoints(task.id)).find(item => item.turnId === turn.id);
    if (!checkpoint) throw new Error(t('This turn has no checkpoint, so it cannot be undone here.', '这一轮没有检查点，无法在这里撤销。'));
    const review = await api.checkpointDiff(task.id, checkpoint.id) as { checkpointId: string; files: Array<{ path: string; afterHash: string | null }> };
    const kept: string[] = [];
    for (const file of review.files) {
      try { await api.reviewAction(task.id, { checkpointId: review.checkpointId, path: file.path, action: 'revert', expectedHash: file.afterHash }); }
      catch { kept.push(file.path); }
    }
    const reverted = review.files.length - kept.length;
    notify(kept.length
      ? t(`Reverted ${reverted} files. ${kept.length} changed again after this turn and were kept: ${kept.join(', ')}`, `已撤销 ${reverted} 个文件。有 ${kept.length} 个文件在本轮之后又改过，已保留：${kept.join('、')}`)
      : t(`Reverted ${reverted} files from this turn.`, `已撤销本轮对 ${reverted} 个文件的改动。`));
  }
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

function TurnView({ task, turn, card, last }: { task: Task; turn: Turn; card: CardProjectView; last: boolean }) {
  const { t } = useApp();
  const studio = useStudio();
  const active = ['running', 'queued', 'waiting'].includes(task.status) || !!task.workerActive;
  const assistant = turn.entries.filter(entry => entry.type === 'message' && entry.item.role === 'assistant');
  const final = assistant.findLast(entry => entry.type === 'message' && entry.item.text.trim());
  const finalMessage = final?.type === 'message' ? final.item : undefined;
  const tools = turn.entries.filter(entry => entry.type === 'tool');
  const notices = turn.entries.flatMap(entry => entry.type === 'message' && entry.item.role === 'system' && !entry.item.usage && entry.item.text ? [entry.item] : []);
  const thinking = assistant.filter(entry => entry.type === 'message' && entry.item.thinking).length;
  const reply = finalMessage ? stripMarkers(finalMessage.text) : undefined;
  const truncatedHere = task.truncation && !active && (task.truncation.turnId ? task.truncation.turnId === turn.id : last);
  return <section className="cs-turn">
    {turn.user && <UserMessage message={turn.user} started={task.card?.kickoff && turn.user.id === task.messages.find(message => message.role === 'user')?.id ? task.card.mode ?? 'scratch' : undefined} />}
    {(turn.entries.length > 0 || (last && active)) && <article className="cs-msg is-ai">
      <header><b>{t(`${sectionLabel(task.card!.sectionId)} AI`, `${sectionLabel(task.card!.sectionId)} AI`)}</b>{last && active && <em className="cs-working-label">{t('Working', '处理中')}</em>}{turn.entries[0] && <time>{clock(turn.entries[0].at)}</time>}</header>
      {(tools.length > 0 || thinking > 0) && <details className="cs-process"><summary><ChevronRight size={13} />{t('Work log', '处理过程')}<small>{tools.length ? t(`${tools.length} tool calls`, `${tools.length} 次工具调用`) : t(`${thinking} reasoning steps`, `${thinking} 段思考`)}</small>{last && active && <LoaderCircle size={12} className="spinning" />}</summary>
        <div className="cs-process-body">{turn.entries.map(entry => entry.type === 'tool' ? <ToolRecord key={entry.item.id} tool={entry.item} /> : entry.item.thinking ? <details key={entry.item.id} className="cs-thinking"><summary>{t('Reasoning', '思考')}</summary><div>{entry.item.thinking}</div></details> : null)}</div>
      </details>}
      {notices.map(notice => <p key={notice.id} className="cs-notice">{notice.text}</p>)}
      {reply && segmentReply(reply.text).map((segment, index) => segment.type === 'markdown' ? <div key={index} className="cs-md"><Markdown text={segment.text} /></div>
        : segment.type === 'dispatch' ? <DispatchCard key={index} dispatch={segment.dispatch} card={card} />
        : <HandoffCard key={index} handoff={segment.handoff} raw={segment.raw} requested={!!turn.user && isHandoffRequest(turn.user.text)} />)}
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
  useEffect(() => {
    const element = scroller.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) element.scrollTop = element.scrollHeight;
  }, [task.messages, task.tools, approvals.length, scroller]);
  useEffect(() => { const element = scroller.current; if (element) element.scrollTop = element.scrollHeight; }, [task.id, scroller]);
  return <div className="cs-thread">
    {turns.length === 0 && <p className="cs-note cs-thread-empty">{t('This conversation has no messages yet.', '这个对话还没有消息。')}</p>}
    {turns.map((turn, index) => <TurnView key={`${task.activeRevisionId || 'original'}-${turn.id}`} task={task} turn={turn} card={card} last={index === lastTurn} />)}
    {data.interactions.filter(interaction => interaction.taskId === task.id).map(interaction => <InteractionDialog key={interaction.id} interaction={interaction} inline />)}
    {approvals.map(approval => <section key={approval.id} className="cs-approval" aria-label={t('Approval required', '需要审批')}>
      <h4><Terminal size={15} />{t('Permission to continue', '允许继续执行')}</h4>
      <p>{approval.reason}</p>
      <pre>{approval.toolName}{'\n'}{JSON.stringify(approval.args, null, 2)}</pre>
      <div className="modal-actions"><button type="button" className="cs-btn" onClick={() => void run(() => api.approve(approval.id, false))}>{t('Deny', '拒绝')}</button><button type="button" className="cs-btn is-primary" onClick={() => void run(() => api.approve(approval.id, true))}>{t('Allow once', '允许本次')}</button></div>
    </section>)}
    {task.error && !task.truncation && !active && <div className="cs-error" role="alert"><strong>{t('This run needs attention', '本次执行需要处理')}</strong><p>{task.error}</p></div>}
    {!active && !task.error && <ConversationEnd task={task} card={card} />}
    {active && !approvals.length && <div className="cs-working"><LoaderCircle size={14} className="spinning" />{task.status === 'queued' ? t('Queued · waiting for an agent slot', '已排队 · 等待空闲名额') : task.status === 'waiting' ? t('Waiting for your answer or approval', '等待你的回答或审批') : t('Working…', '正在处理…')}</div>}
  </div>;
}
