import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Globe, LoaderCircle, Pencil, RefreshCw, Terminal } from 'lucide-react';
import type { ChatMessage, Task, ToolCall, Usage } from '../shared/types';
import { statusText, useApp } from './context';
import { DiffView } from './DiffView';
import { foldOutput, toolSummary } from '../shared/tool-view';
import { parseFileRefs } from '../shared/file-refs';
import { chaptersByTurn } from '../shared/chapters';
import { Avatar } from './Avatar';
import { IconButton } from './primitives';
import { MessageAttachments } from './AttachmentComposer';
import { TruncationNotice } from './Notices';
import { Markdown as KernelMarkdown } from './conversation/Markdown';
import { ThinkingBlock } from './conversation/Thinking';
import { ToolGroup } from './conversation/parts';
import { groupToolRuns } from './conversation/tool-groups';
import { useArrivals } from './conversation/motion';

type TimelineItem = { type: 'message'; item: ChatMessage; at: string } | { type: 'tool'; item: ToolCall; at: string };
type MessageEntry = TimelineItem & { type: 'message' };
interface ConversationTurn { id: string; user?: ChatMessage; entries: TimelineItem[] }

/** Preserve transport records; group their presentation around the consumed user turn. */
export function groupConversation(task: Pick<Task, 'messages' | 'tools'>): ConversationTurn[] {
  const turns: ConversationTurn[] = []; const byId = new Map<string, ConversationTurn>();
  for (const message of task.messages) if (message.role === 'user') {
    const turn = { id: message.turnId || message.id, user: message, entries: [] }; turns.push(turn); byId.set(turn.id, turn); byId.set(message.id, turn);
  }
  const orphan: ConversationTurn = { id: 'before-conversation', entries: [] };
  const messageOwners = new Map<string, ConversationTurn>(); let owner = orphan;
  for (const message of task.messages) { if (message.role === 'user') owner = byId.get(message.id) || orphan; else messageOwners.set(message.id, owner); }
  const entries: TimelineItem[] = [...task.messages.filter(message => message.role !== 'user').map(item => ({ type: 'message' as const, item, at: item.at })), ...task.tools.map(item => ({ type: 'tool' as const, item, at: item.at }))].sort((a, b) => a.at.localeCompare(b.at));
  for (const entry of entries) {
    const match = entry.item.turnId ? byId.get(entry.item.turnId) : undefined;
    const turn = match || (entry.type === 'message' ? messageOwners.get(entry.item.id) : turns.findLast(turn => turn.user!.at <= entry.at)) || orphan;
    turn.entries.push(entry);
  }
  return orphan.entries.length ? [orphan, ...turns] : turns;
}

const FILE_LINK = 'cardwright-file:';
/** Turns every `路径:行号` in the prose into a link the side panel can open (§6.3). */
function fileReferences() {
  return (tree: { children?: unknown[] }) => {
    const walk = (node: { type?: string; value?: string; children?: unknown[] }) => {
      if (!Array.isArray(node.children)) return;
      const next: unknown[] = [];
      for (const raw of node.children) {
        const child = raw as { type?: string; value?: string; children?: unknown[] };
        if (child.type === 'text' && typeof child.value === 'string') {
          const refs = parseFileRefs(child.value);
          if (!refs.length) { next.push(child); continue; }
          let cursor = 0;
          for (const ref of refs) {
            if (ref.start > cursor) next.push({ type: 'text', value: child.value.slice(cursor, ref.start) });
            next.push({ type: 'link', url: `${FILE_LINK}${ref.line}:${ref.endLine ?? ''}:${ref.path}`, children: [{ type: 'text', value: child.value.slice(ref.start, ref.end) }] });
            cursor = ref.end;
          }
          if (cursor < child.value.length) next.push({ type: 'text', value: child.value.slice(cursor) });
          continue;
        }
        if (child.type !== 'code' && child.type !== 'inlineCode') walk(child);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}

/** A `路径:行号` opens in the side panel, a web address in the browser; anything else stays text. */
function WorkbenchLink({ children: content, href }: ComponentProps<'a'>) {
  const { run, api, view } = useApp();
  return href && href.startsWith(FILE_LINK)
    ? <button type="button" className="file-ref" onClick={() => { const [line, endLine, ...rest] = href.slice(FILE_LINK.length).split(':'); view?.({ kind: 'file', path: rest.join(':'), line: Number(line) || undefined, endLine: Number(endLine) || undefined }); }}>{content}</button>
    : href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void run(() => api.openExternal(href)); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void run(() => api.openExternal(href)); }}>{content}</a> : <span>{content}</span>;
}

/** Inline code that is exactly a file reference opens the file. */
function WorkbenchCode({ children: content, className }: ComponentProps<'code'>) {
  const { view } = useApp();
  const text = String(content ?? '');
  const ref = !className ? parseFileRefs(text)[0] : undefined;
  if (ref && ref.start === 0 && ref.end === text.length) return <button type="button" className="file-ref is-code" onClick={() => view?.({ kind: 'file', path: ref.path, line: ref.line, endLine: ref.endLine })}>{text}</button>;
  return <code className={className}>{content}</code>;
}

/** The workbench skin of the conversation kernel: its remark plugins and elements; code blocks and tables are the kernel's. */
const WORKBENCH_MARKDOWN = {
  remarkPlugins: [remarkGfm, fileReferences],
  components: { a: WorkbenchLink, code: WorkbenchCode } satisfies Components,
  urlTransform: (url: string) => url.startsWith(FILE_LINK) ? url : defaultUrlTransform(url),
};

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return <KernelMarkdown text={text} streaming={streaming} {...WORKBENCH_MARKDOWN} />;
}

export function ToolRecord({ tool }: { tool: ToolCall }) {
  const { t, api, run, data, view } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const summary = toolSummary(tool, t);
  const args = JSON.stringify(tool.args, null, 2);
  const foldedArgs = foldOutput(args, { lines: 20, chars: 2_000 });
  const foldedOutput = foldOutput(tool.output || '');
  const hidden = foldedArgs.folded || foldedOutput.folded;
  return <div className={`tool-entry ${data.ecosystem.compactTools ? 'compact-tool' : ''} ${tool.name === 'web_search' ? 'search-tool-entry' : ''}`}><details className={`tool-record ${tool.status}`} onToggle={event => setExpanded(event.currentTarget.open)}><summary><span className="tool-chevron"><ChevronRight size={15} /></span>{tool.status === 'running' ? <LoaderCircle size={14} className="spinning" /> : tool.status === 'completed' ? <Check size={14} /> : <Terminal size={14} />}<strong>{tool.name === 'web_search' ? t('Web search', '联网搜索') : tool.name}</strong>{typeof tool.args.path === "string" && ["read", "write", "edit", "ls"].includes(tool.name) ? <button type="button" className="tool-summary file-ref" onClick={event => { event.preventDefault(); event.stopPropagation(); view?.({ kind: "file", path: String(tool.args.path) }); }}>{summary}</button> : <span className="tool-summary">{summary}</span>}<span className="tool-state">{statusText(tool.status, t)}</span></summary>{expanded && <div className="tool-detail">
    <div className="tool-detail-label">{t('Arguments', '参数')}</div><pre>{showAll ? args : foldedArgs.head}</pre>
    {tool.patch && <><div className="tool-detail-label">{t('Changes', '改动')}</div><div className="tool-patch-view"><DiffView patch={tool.patch} mode="unified" onModeChange={() => undefined} /></div></>}
    {tool.output && <><div className="tool-detail-label">{t('Output', '输出')}</div><pre>{showAll ? tool.output : foldedOutput.head}</pre></>}
    {hidden && !showAll && <button type="button" className="button small tool-show-all" onClick={() => setShowAll(true)}>{foldedOutput.hiddenLines ? t(`Show all · ${foldedOutput.hiddenLines} more lines`, `显示全部 · 还有 ${foldedOutput.hiddenLines} 行`) : t('Show all', '显示全部')}</button>}
  </div>}</details>{tool.search && <div className="search-sources"><div className="search-sources-heading"><Globe size={14} /><span>{t('Sources', '搜索来源')} · {tool.search.results.length}</span><small>{{ native: t('Gateway search', '网关搜索'), exa: 'Exa', brave: 'Brave Search', searxng: 'SearXNG' }[tool.search.provider]}</small></div>{tool.search.answer && <p className="search-native-answer">{tool.search.answer}</p>}{tool.search.results.length ? <ol>{tool.search.results.map((source, index) => <li key={`${source.url}-${index}`}><button onClick={() => void run(() => api.openExternal(source.url))}><span className="source-number">{index + 1}</span><span><strong>{source.title || source.url}</strong><small>{source.url}</small>{source.snippet && <p>{source.snippet}</p>}</span><ExternalLink size={14} /></button></li>)}</ol> : <p className="search-no-results">{t('No results for this query.', '没有找到匹配的网页。')}</p>}</div>}</div>;
}

function UsageDetail({ usage }: { usage: Usage }) {
  const { t } = useApp();
  return <details className="message-usage"><summary>{(usage.input + usage.output + usage.cacheRead + usage.cacheWrite).toLocaleString()} Token <ChevronDown size={11} /></summary><dl>{([{ key: 'input', label: t('Input', '输入') }, { key: 'output', label: t('Output', '输出') }, { key: 'cacheRead', label: t('Cache read', '缓存读取') }, { key: 'cacheWrite', label: t('Cache write', '缓存写入') }] as const).map(item => <div key={item.key}><dt>{item.label}</dt><dd>{usage[item.key].toLocaleString()}</dd></div>)}</dl></details>;
}

function Turn({ turn, task, last, editSignal, chapter, arrived }: { turn: ConversationTurn; task: Task; last: boolean; editSignal?: number; chapter?: string; arrived: ReadonlySet<string> }) {
  const { data, api, run, t } = useApp();
  const [processOpen, setProcessOpen] = useState(false);
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(turn.user?.text || ''); const [busy, setBusy] = useState(false);
  const active = ['running', 'waiting', 'queued'].includes(task.status);
  const assistant = turn.entries.filter((entry): entry is MessageEntry => entry.type === 'message' && entry.item.role === 'assistant');
  const final = assistant.findLast(entry => entry.item.text.trim());
  const finalIndex = final ? turn.entries.indexOf(final) : -1;
  const finalHasLaterTool = finalIndex >= 0 && turn.entries.slice(finalIndex + 1).some(entry => entry.type === 'tool');
  const visibleFinal = final && (!finalHasLaterTool || (!active && last)) ? final : undefined;
  // The reply being written: the turn's newest record while the task runs. Its thinking (else the answer's) shows above
  // the answer, live while the model thinks; every other thought stays in the work log (handoff §5.5 ②④).
  const newest = turn.entries[turn.entries.length - 1];
  const streaming = task.status === 'running' && last && newest?.type === 'message' && newest.item.role === 'assistant' ? newest.item : undefined;
  const featured = streaming ?? visibleFinal?.item;
  const thinkingLive = !!streaming && streaming.thinkingMs === undefined && !streaming.text.trim();
  const logThinking = (message: ChatMessage) => !!message.thinking && message.id !== featured?.id;
  const logText = (entry: MessageEntry) => entry !== visibleFinal && !!entry.item.text && !(entry.item.role === 'system' && entry.item.usage);
  const process = turn.entries.filter(entry => entry.type === 'tool' || logThinking(entry.item) || logText(entry));
  const runs = groupToolRuns(process, entry => entry.type === 'tool' ? { tool: entry.item.name } : logText(entry) ? 'visible' : 'quiet');
  const tools = turn.entries.filter(entry => entry.type === 'tool');
  const thinking = process.filter(entry => entry.type === 'message' && logThinking(entry.item)).length;
  const logEntry = (entry: TimelineItem) => entry.type === 'tool' ? <ToolRecord key={entry.item.id} tool={entry.item} /> : <div key={entry.item.id} className="process-message">
    {logThinking(entry.item) && <ThinkingBlock message={entry.item} live={false} {...WORKBENCH_MARKDOWN} />}
    {logText(entry) && <div className={`message-body ${entry.item.role === 'system' ? 'process-notice' : ''}`}><Markdown text={entry.item.text} /></div>}
  </div>;
  const thinkingView = featured?.thinking ? <ThinkingBlock key={featured.id} message={featured} live={thinkingLive} {...WORKBENCH_MARKDOWN} /> : null;
  const thinkingFirst = !visibleFinal || featured === visibleFinal.item;
  const usageRecords = turn.entries.flatMap(entry => entry.type === 'message' && entry.item.usage ? [entry.item.usage] : []);
  const usage = usageRecords.reduce<Usage>((sum, current) => ({ input: sum.input + current.input, output: sum.output + current.output, cacheRead: sum.cacheRead + current.cacheRead, cacheWrite: sum.cacheWrite + current.cacheWrite, cost: sum.cost + current.cost }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const hasResponse = turn.entries.length > 0;
  // Double Esc in the task view opens this message for editing, the same as the pencil.
  useEffect(() => { if (!editSignal || !turn.user || active || busy) return; setDraft(turn.user.text); setEditing(true); }, [editSignal]);
  async function regenerate(text?: string) { if (!turn.user || active || busy) return; setBusy(true); const result = await run(async () => { await api.regenerate(task.id, turn.user!.id, text); return true; }); if (result) setEditing(false); setBusy(false); }
  return <section className="conversation-turn" data-turn-id={turn.id}>
    {chapter && <div className="chapter-rule" id={`chapter-${turn.id}`}><span>{chapter}</span></div>}
    {turn.user && <article className={`message message-user turn-row is-user ${editing ? 'message-editing' : ''}${arrived.has(turn.user.id) ? '' : ' conv-enter'}`}><Avatar role="user" size={34} interactive /><div className="turn-card"><div className="message-author"><span>{data.preferences.name || t('You', '你')}</span>{turn.user.pending && <span className="queued-message-label">{t('Queued', '等待发送')}</span>}<time dateTime={turn.user.at}>{new Date(turn.user.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>{editing ? <form className="message-editor" onSubmit={event => { event.preventDefault(); void regenerate(draft.trim()); }}><textarea aria-label={t('Edit your message', '编辑你的消息')} autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void regenerate(draft.trim()); } }} rows={Math.min(9, Math.max(3, draft.split('\n').length))} disabled={busy} /><p>{t('Creates a new conversation version from this message. Existing file changes stay in place.', '从这条消息创建新对话版本。已执行的文件修改保持现状。')}</p><div className="message-editor-actions"><span>Ctrl Enter</span><button type="button" className="button small" disabled={busy} onClick={() => setEditing(false)}>{t('Cancel', '取消')}</button><button className="button primary small" disabled={busy || !draft.trim()}>{busy ? t('Starting…', '启动中…') : t('Save & regenerate', '保存并重新生成')}</button></div></form> : <><div className="message-body"><Markdown text={turn.user.text} /></div><MessageAttachments attachments={turn.user.attachments} /><div className="user-message-actions"><IconButton label={t('Copy message', '复制消息')} onClick={() => void run(() => api.copyText(turn.user!.text), t('Message copied', '消息已复制'))}><Copy size={14} /></IconButton><IconButton label={t('Edit message & regenerate', '编辑消息并重新生成')} disabled={active || busy} onClick={() => { setDraft(turn.user!.text); setEditing(true); }}><Pencil size={14} /></IconButton></div></>}</div></article>}
    {hasResponse && <article className={`message message-assistant assistant-turn turn-row is-assistant ${task.truncation && !active && (task.truncation.turnId ? task.truncation.turnId === turn.id : last) ? 'is-truncated' : ''}${arrived.has(turn.entries[0].item.id) ? '' : ' conv-enter'}`}><Avatar role="assistant" size={34} interactive={!task.agentName} agentName={task.agentName} /><div className="turn-card"><div className="message-author"><span>{task.agentName || 'Cardwright'}</span>{active && last && <span className="turn-running-label">{t('Working', '处理中')}</span>}<time dateTime={turn.entries[0].at}>{new Date(turn.entries[0].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
      {process.length > 0 && <details className="turn-process" onToggle={event => setProcessOpen(event.currentTarget.open)}><summary><ChevronRight size={14} /><span>{t('Work log', '处理过程')}</span><small>{tools.length > 0 ? `${tools.length} ${t('tool calls', '次工具调用')}` : `${thinking} ${t('reasoning steps', '段思考')}`}</small>{active && last && <LoaderCircle size={13} className="spinning" />}</summary>{processOpen && <div className="turn-process-body">{runs.map(item => item.kind === 'group'
        ? <ToolGroup key={`group-${item.items[0].item.id}`} name={item.name} calls={item.calls.flatMap(entry => entry.type === 'tool' ? [entry.item] : [])}>{item.items.map(logEntry)}</ToolGroup>
        : logEntry(item.item))}</div>}</details>}
      {thinkingFirst && thinkingView}
      {visibleFinal && <div className={`message-body final-response${visibleFinal.item === streaming ? ' conv-live' : ''}`}><Markdown text={visibleFinal.item.text} streaming={visibleFinal.item === streaming} /></div>}
      {!thinkingFirst && thinkingView}
      {task.truncation && !active && (task.truncation.turnId ? task.truncation.turnId === turn.id : last) && <TruncationNotice task={task} userMessageId={turn.user?.id} />}
      {(visibleFinal || usageRecords.length > 0) && <div className="message-footer">{visibleFinal && <IconButton label={t('Copy response', '复制回复')} onClick={() => void run(() => api.copyText(visibleFinal.item.text), t('Response copied', '已复制回复'))}><Copy size={14} /></IconButton>}{turn.user && <IconButton label={t('Regenerate response', '重新生成回复')} disabled={active || busy} onClick={() => void regenerate()}><RefreshCw size={14} className={busy ? 'spinning' : ''} /></IconButton>}{usageRecords.length > 0 && <UsageDetail usage={usage} />}{visibleFinal?.item.model && <span className="response-model">{visibleFinal.item.model}</span>}</div>}
    </div></article>}
  </section>;
}

export function Conversation({ task, editSignal }: { task: Task; editSignal?: number }) {
  const { t } = useApp();
  const turns = useMemo(() => groupConversation(task), [task.messages, task.tools]);
  const arrived = useArrivals(`${task.id}:${task.activeRevisionId ?? ''}`, task);
  const [visible, setVisible] = useState(40); const root = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ element: HTMLElement; anchor: string; top: number } | null>(null);
  useLayoutEffect(() => { setVisible(40); pendingScroll.current = null; }, [task.id, task.activeRevisionId]);
  // Keep the turn the reader was looking at exactly where it was. Measuring that one turn beats measuring the whole
  // column, because the 「加载更早的对话」 button leaves with the last batch. The newly mounted turns also settle over the
  // next few frames as avatars and text lay out, so the position is held until they stop moving or the reader takes over.
  useLayoutEffect(() => {
    const previous = pendingScroll.current;
    if (!previous) return;
    pendingScroll.current = null;
    let holding = true;
    const settle = () => {
      if (!holding) return;
      const anchor = previous.element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(previous.anchor)}"]`);
      if (!anchor) return;
      const drift = anchor.getBoundingClientRect().top - previous.top;
      if (Math.abs(drift) > 0.5) previous.element.scrollTop += drift;
    };
    const release = () => { holding = false; };
    settle();
    const observer = new ResizeObserver(() => settle());
    observer.observe(previous.element);
    for (const child of previous.element.children) observer.observe(child);
    const frame = requestAnimationFrame(settle);
    const stop = setTimeout(release, 800);
    for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown']) previous.element.addEventListener(event, release, { passive: true });
    return () => {
      release(); observer.disconnect(); clearTimeout(stop); cancelAnimationFrame(frame);
      for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown']) previous.element.removeEventListener(event, release);
    };
  }, [visible]);
  const offset = Math.max(0, turns.length - visible); const workingTurn = turns.findLastIndex(turn => !turn.user?.pending);
  const editable = turns.findLastIndex(turn => turn.user && !turn.user.pending);
  const chapters = chaptersByTurn(task.chapters);
  function loadOlder() {
    const element = root.current?.closest<HTMLElement>('.conversation-scroll');
    const anchor = element?.querySelector<HTMLElement>('[data-turn-id]');
    if (element && anchor?.dataset.turnId) pendingScroll.current = { element, anchor: anchor.dataset.turnId, top: anchor.getBoundingClientRect().top };
    setVisible(value => value + 40);
  }
  return <div ref={root} className="conversation-history">
    {chapters.size > 0 && <nav className="chapter-rail" aria-label={t('Chapters', '章节')}>{[...chapters.entries()].map(([turnId, chapter]) => <button key={chapter.id} type="button" title={chapter.title} onClick={() => document.getElementById(`chapter-${turnId}`)?.scrollIntoView({ block: 'start' })}><i aria-hidden="true" /><span>{chapter.title}</span></button>)}</nav>}{offset > 0 && <button className="load-older-turns button small" onClick={loadOlder}>{t('Load older turns', '加载更早的对话')} · {offset}</button>}{turns.slice(offset).map((turn, index) => <Turn key={`${task.activeRevisionId || 'original'}-${turn.id}`} turn={turn} task={task} last={index + offset === workingTurn} editSignal={index + offset === editable ? editSignal : undefined} chapter={chapters.get(turn.id)?.title} arrived={arrived} />)}</div>;
}
