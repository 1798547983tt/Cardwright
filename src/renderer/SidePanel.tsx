import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, Columns2, FileDiff, Folder, Globe, ListTodo, LoaderCircle, MessageSquare, Rows2, ShieldCheck, Terminal, X } from 'lucide-react';
import type { Task } from '../shared/types';
import type { FilePreview } from '../shared/studio-types';
import { languageOf, tokenizeLine } from '../shared/code-view';
import { useApp } from './context';
import { IconButton } from './primitives';
import { ChangesPane, ChecksPane, TerminalPane } from './Workbench';
import { BrowserPane } from './BrowserPane';

export type PanelTab = 'files' | 'changes' | 'checks' | 'terminal' | 'browser' | 'plan' | 'todos';
/** What a click on `路径:行号` asks the panel to show. */
export interface FileTarget { path: string; line?: number; endLine?: number; at: number }
export interface PanelState { panes: [PanelTab, PanelTab | null]; target?: FileTarget }

export function panelTabs(t: (en: string, zh: string) => string) {
  return [
    { id: 'files' as const, title: t('Files', '文件'), icon: Folder },
    { id: 'changes' as const, title: t('Changes', '改动'), icon: FileDiff },
    { id: 'checks' as const, title: t('Checks', '检查'), icon: ShieldCheck },
    { id: 'terminal' as const, title: t('Terminal', '终端'), icon: Terminal },
    { id: 'browser' as const, title: t('Browser', '浏览器'), icon: Globe },
    { id: 'plan' as const, title: t('Plan', '计划'), icon: Check },
    { id: 'todos' as const, title: t('Todos', '待办'), icon: ListTodo },
  ];
}

/** The right column (§6.3): one or two panes, each with its own tabs. */
export function SidePanel({ task, state, onState, onClose }: { task: Task; state: PanelState; onState: (state: PanelState) => void; onClose: () => void }) {
  const { t } = useApp();
  const tabs = panelTabs(t);
  const split = state.panes[1] !== null;
  const setTab = (index: 0 | 1, tab: PanelTab) => {
    const panes: [PanelTab, PanelTab | null] = [...state.panes] as [PanelTab, PanelTab | null];
    panes[index] = tab;
    onState({ ...state, panes });
  };
  const pane = (index: 0 | 1) => {
    const tab = state.panes[index];
    if (!tab) return null;
    return <section className="panel-pane" key={index}>
      <div className="panel-tabs" role="tablist" aria-label={t('Side panel', '侧边面板')}>
        {tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-current' : ''} onClick={() => setTab(index, item.id)}>{item.title}</button>)}
        <span className="panel-tab-actions">
          {index === 0 && <IconButton label={split ? t('Merge panes', '合并') : t('Split the panel', '拆分')} onClick={() => onState({ ...state, panes: [state.panes[0], split ? null : state.panes[0] === 'files' ? 'terminal' : 'files'] })}>{split ? <Rows2 size={15} /> : <Columns2 size={15} />}</IconButton>}
          {index === 0 && <IconButton label={t('Close the panel', '关闭面板')} onClick={onClose}><X size={15} /></IconButton>}
        </span>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === 'files' ? <FileViewer task={task} target={state.target} />
          : tab === 'changes' ? <ChangesPane task={task} />
          : tab === 'checks' ? <ChecksPane task={task} />
          : tab === 'plan' ? <PlanPane task={task} />
          : tab === 'todos' ? <TodoPane task={task} />
          : null}
        <TerminalPane task={task} active={tab === 'terminal'} />
        {tab === 'browser' && (index === 0 || state.panes[0] !== 'browser') && <BrowserPane active />}
      </div>
    </section>;
  };
  return <aside className={`desk-panel ${split ? 'is-split' : ''}`} aria-label={t('Side panel', '侧边面板')}>{pane(0)}{pane(1)}</aside>;
}

/** The plan the agent proposed, and the approval that lets it act on it. */
function PlanPane({ task }: { task: Task }) {
  const { api, t, run } = useApp();
  if (!task.plan) return <p className="studio-empty">{t('No plan yet. Switch the composer to 计划 and ask for one.', '还没有计划。把输入框切到「计划」再让它出一份。')}</p>;
  return <div className="panel-plan">
    <div className="panel-plan-head"><strong>{t('Proposed plan', '执行计划')}</strong><span className={`plan-${task.plan.status}`}>{task.plan.status === 'approved' ? t('Approved', '已批准') : task.plan.status === 'pending' ? t('Review required', '等待审核') : t('Draft', '草案')}</span></div>
    <div className="panel-plan-text">{task.plan.text}</div>
    {task.plan.status === 'pending' && <button className="button primary small" onClick={() => void run(() => api.approvePlan(task.id))}><Check size={14} />{t('Approve plan', '批准计划')}</button>}
  </div>;
}

/** The agent's own checklist for this task. */
function TodoPane({ task }: { task: Task }) {
  const { t } = useApp();
  const todos = task.todos || [];
  if (!todos.length) return <p className="studio-empty">{t('No checklist yet; the agent writes one for longer work.', '还没有清单；活儿长了 Agent 会自己列一份。')}</p>;
  const labels = { pending: t('Pending', '待处理'), in_progress: t('In progress', '进行中'), completed: t('Completed', '已完成'), cancelled: t('Cancelled', '已取消') };
  return <ul className="panel-todos">{todos.map(todo => <li key={todo.id} className={`todo-${todo.status}`}>
    {todo.status === 'completed' ? <Check size={14} /> : todo.status === 'in_progress' ? <LoaderCircle size={14} className="spinning" /> : <Circle size={11} />}
    <span>{todo.content}</span><small>{labels[todo.status]}</small>
  </li>)}</ul>;
}

/** 文件: the project tree beside the viewer, which opens at the line a reference named (§6.3). */
function FileViewer({ task, target }: { task: Task; target?: FileTarget }) {
  const { api, t, run } = useApp();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Array<{ path: string; name: string; directory: boolean; bytes?: number }>>([]);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [question, setQuestion] = useState('');
  const viewer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.workspaceFiles(task.projectId, path, '', task.id).then(values => { if (alive) setEntries(values); }).catch(reason => { if (alive) setError(String(reason?.message ?? reason)); });
    return () => { alive = false; };
  }, [api, task.projectId, task.id, path]);

  // A reference from the conversation opens its file and scrolls to the line.
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true); setError('');
    void api.previewFile(task.projectId, target.path, task.id)
      .then(value => { if (alive) { setPreview(value); setRange(target.line ? { start: target.line, end: target.endLine ?? target.line } : null); } })
      .catch(reason => { if (alive) setError(String(reason?.message ?? reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, task.projectId, task.id, target?.path, target?.at]);

  useEffect(() => {
    if (!preview || !range) return;
    const element = viewer.current?.querySelector<HTMLElement>(`[data-line="${range.start}"]`);
    element?.scrollIntoView({ block: 'center' });
  }, [preview?.path, range?.start]);

  async function open(entry: { path: string; directory: boolean }) {
    if (entry.directory) { setPath(entry.path); setPreview(null); return; }
    setLoading(true); setRange(null);
    const value = await run(() => api.previewFile(task.projectId, entry.path, task.id));
    if (value) setPreview(value);
    setLoading(false);
  }
  async function ask() {
    if (!preview || !range || !question.trim()) return;
    const sent = await run(async () => { await api.prompt(task.id, `${question.trim()}\n\n${preview.path}:${range.start}${range.end !== range.start ? `-${range.end}` : ''}`, ['running', 'waiting', 'queued'].includes(task.status) ? 'followUp' : undefined); return true; });
    if (sent) setQuestion('');
  }

  const language = preview ? languageOf(preview.path) : 'text';
  const lines = useMemo(() => (preview?.text ?? '').split('\n'), [preview?.path, preview?.text]);

  return <div className="panel-files">
    <div className="panel-tree">
      <div className="panel-tree-head">
        <button type="button" className="panel-up" disabled={!path} onClick={() => setPath(path.replace(/[\\/][^\\/]+$/, '').replace(/^[^\\/]+$/, ''))}>..</button>
        <span title={path}>{path || t('Project root', '项目根目录')}</span>
      </div>
      <ul>{entries.map(entry => <li key={entry.path}>
        <button type="button" className={preview?.path === entry.path ? 'is-current' : ''} onClick={() => void open(entry)}>
          {entry.directory ? <Folder size={13} /> : <FileDiff size={13} />}<span>{entry.name}</span>
        </button>
      </li>)}</ul>
    </div>
    <div className="panel-viewer" ref={viewer}>
      {error && <p className="studio-error" role="alert">{error}</p>}
      {loading && <p className="studio-loading"><LoaderCircle size={15} className="spinning" />{t('Loading…', '加载中…')}</p>}
      {!preview && !loading && <p className="studio-empty">{t('Pick a file, or click a 路径:行号 in the conversation.', '选一个文件，或点对话里的「路径:行号」。')}</p>}
      {preview && preview.kind === 'text' && <>
        <div className="panel-viewer-head"><strong title={preview.path}>{preview.path}</strong>{preview.truncated && <small>{t('beginning of the file', '仅文件开头')}</small>}</div>
        <div className="code-view">{lines.map((line, index) => {
          const number = index + 1;
          const inRange = !!range && number >= range.start && number <= range.end;
          return <div key={number} data-line={number} className={`code-line ${inRange ? 'is-target' : ''}`}>
            <button type="button" className="code-gutter" onClick={event => setRange(current => event.shiftKey && current ? { start: Math.min(current.start, number), end: Math.max(current.end, number) } : { start: number, end: number })}>{number}</button>
            <code>{tokenizeLine(line, language).map((part, position) => part.kind === 'text' ? part.text : <span key={position} className={`tok-${part.kind}`}>{part.text}</span>)}</code>
          </div>;
        })}</div>
        {range && <div className="panel-ask">
          <label>{t(`Ask about lines ${range.start}–${range.end}`, `询问第 ${range.start}–${range.end} 行`)}
            <input value={question} onChange={event => setQuestion(event.target.value)} placeholder={t('What would you like to know?', '想了解或修改什么？')} />
          </label>
          <button type="button" className="button small" disabled={!question.trim()} onClick={() => void ask()}><MessageSquare size={14} />{t('Ask agent', '发送提问')}</button>
        </div>}
      </>}
      {preview && preview.kind === 'image' && preview.dataUrl && <img className="panel-image" src={preview.dataUrl} alt={preview.name} />}
      {preview && preview.kind !== 'text' && preview.kind !== 'image' && <p className="studio-empty">{t('Binary file; no text preview.', '二进制文件，无法显示文本。')}</p>}
    </div>
  </div>;
}

export { ChevronDown };
