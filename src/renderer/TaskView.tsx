import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileDiff, Globe, GitBranch, GitMerge, LoaderCircle, MoreHorizontal, PanelRight, Pencil, Play, RefreshCw, Square, Terminal, Users, X } from 'lucide-react';
import type { DiffResult, Task, ToolCall } from '../shared/types';
import { statusText, useApp } from './context';
import { Field, IconButton, Mark, MenuItem, Modal, Popover } from './primitives';
import { Avatar } from './Avatar';
import { DiffView } from './DiffView';
import { Conversation } from './Conversation';
import { RevisionBar } from './RevisionBar';
import { InteractionDialog } from './InteractionDialog';
import { AgentSquad } from './AgentSquad';
import { DeliveryCard } from './Workbench';
import type { PanelTab } from './SidePanel';
import { usableAgents } from '../shared/agents';
import { JumpToLatest } from './ReadingAids';

export function TaskView({ task, onPanel }: { task: Task; onPanel: (tab: PanelTab) => void }) {
  const { api, data, t, run, navigate } = useApp();

  function openWorkbench(tab: PanelTab) { onPanel(tab); setDiffOpen(false); setSquadOpen(false); }
  const [diff, setDiff] = useState<DiffResult | null>(null); const [diffOpen, setDiffOpen] = useState(false); const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('unified');
  const [squadOpen, setSquadOpen] = useState(false); const [squadFocus, setSquadFocus] = useState(true); const knownChildren = useRef({ taskId: task.id, count: 0 });
  const [rename, setRename] = useState(false); const [title, setTitle] = useState(task.title);
  const [parallel, setParallel] = useState(false); const [childPrompt, setChildPrompt] = useState(''); const [isolated, setIsolated] = useState(true); const [creating, setCreating] = useState(false);
  const [childRole, setChildRole] = useState('general-purpose');
  const usableRoles = usableAgents(data.ecosystem.roles, task.projectId);
  const availableChildRole = usableRoles.some(role => role.id === childRole) ? childRole : usableRoles.find(role => role.id === 'general-purpose')?.id || usableRoles[0]?.id || 'general-purpose';
  useEffect(() => { if (childRole !== availableChildRole) setChildRole(availableChildRole); }, [childRole, availableChildRole]);
  const [merge, setMerge] = useState(false); const [merging, setMerging] = useState(false);
  const end = useRef<HTMLDivElement>(null); const scroller = useRef<HTMLDivElement>(null); const follows = useRef(true);
  const children = data.tasks.filter(item => item.parentId === task.id && !item.archived);
  const activeChildren = children.filter(child => ['running', 'queued', 'waiting'].includes(child.status) || child.workerActive);
  const waitingChildren = children.filter(child => data.approvals.some(item => item.taskId === child.id) || data.interactions.some(item => item.taskId === child.id));
  const approvals = data.approvals.filter(approval => approval.taskId === task.id);
  const active = ['running', 'queued', 'waiting'].includes(task.status);
  const project = data.projects.find(item => item.id === task.projectId);
  useEffect(() => { if (follows.current) end.current?.scrollIntoView({ block: 'end' }); }, [task.messages, task.tools, approvals.length]);
  // Esc interrupts this round; a second Esc within a moment opens the last message for editing (§6.2).
  const [editSignal, setEditSignal] = useState(0);
  const lastEscape = useRef(0);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], .popover')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.terminal-host, .message-editor, input, select')) return;
      const now = Date.now();
      const again = now - lastEscape.current < 800;
      lastEscape.current = now;
      if (again) { setEditSignal(value => value + 1); return; }
      if (['running', 'queued', 'waiting'].includes(task.status) || task.workerActive) void run(() => api.cancelTask(task.id));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [task.id, task.status, task.workerActive]);
  useEffect(() => { setTitle(task.title); setDiff(null); setDiffOpen(false); setSquadOpen(false); setDiffLayout('unified'); follows.current = true; }, [task.id]);
  useEffect(() => { const previous = knownChildren.current; if (previous.taskId === task.id && previous.count === 0 && children.length > 0) { setSquadFocus(false); setSquadOpen(true); setDiffOpen(false); } knownChildren.current = { taskId: task.id, count: children.length }; }, [task.id, children.length]);
  async function loadDiff() { setLoadingDiff(true); setSquadOpen(false); setDiffOpen(true); const result = await run(() => api.diff(task.id)); if (result) setDiff(result); setLoadingDiff(false); }
  async function createChild() {
    if (!childPrompt.trim()) return; setCreating(true);
    const result = await run(() => api.createTask({ projectId: task.projectId, parentId: task.id, prompt: childPrompt.trim(), role: availableChildRole, gatewayId: task.gatewayId, modelId: task.modelId, contextWindow: task.contextWindow, permission: task.permission, thinking: task.thinking, isolated: !!project?.isGit && isolated }));
    if (result) { setParallel(false); setChildPrompt(''); setSquadOpen(true); setDiffOpen(false); } setCreating(false);
  }
  return <div className={`task-view ${diffOpen ? 'with-diff' : ''} ${squadOpen ? 'with-squad' : ''}`}><div className="conversation-column"><header className="task-header"><div className="task-identity">{task.parentId && <IconButton label={t('Back to parent task', '返回主任务')} onClick={() => navigate(task.parentId!)}><ArrowLeft size={17} /></IconButton>}<h1 key={task.id}>{task.title}</h1><span className={`task-status status-tag ${task.truncation ? 'truncated' : task.status}`}><span className={`status-diamond ${task.truncation ? 'truncated' : task.status}`} />{task.truncation ? t('Output truncated', '输出被截断') : statusText(task.status, t)}</span></div><div className="task-header-actions"><IconButton label={t('Open the side panel', '打开侧栏面板')} onClick={() => openWorkbench('files')}><PanelRight size={17} /></IconButton><button type="button" className="squad-toggle" aria-label={t('Agent squad', '子代理小队')} aria-expanded={task.parentId ? undefined : squadOpen} onClick={() => { if (task.parentId) navigate(task.parentId); else { setSquadFocus(true); setSquadOpen(!squadOpen); setDiffOpen(false); } }}><Users size={17} /><span>{t('Squad', '小队')}</span>{activeChildren.length > 0 && <b>{activeChildren.length}</b>}</button>{project?.isGit && <IconButton label={t('Review changes', '查看修改')} onClick={() => void loadDiff()}><FileDiff size={18} /></IconButton>}<Popover label={t('Task actions', '任务操作')} align="right" className="task-action-menu" trigger={<MoreHorizontal size={19} />}>{close => <><MenuItem onClick={() => { setTitle(task.title); setRename(true); close(); }}><Pencil size={16} />{t('Rename task', '重命名任务')}</MenuItem><MenuItem onClick={() => { void run(() => api.openPath(task.cwd)); close(); }}><GitBranch size={16} />{t('Open working folder', '打开工作目录')}</MenuItem>{active && <MenuItem onClick={() => { void run(() => api.cancelTask(task.id)); close(); }}><Square size={15} />{t('Stop task', '停止任务')}</MenuItem>}<MenuItem disabled={active} onClick={() => { void run(async () => { await api.updateTask(task.id, { archived: true }); navigate(null); }); close(); }}><Archive size={16} />{t('Archive task', '归档任务')}</MenuItem></>}</Popover></div></header>
      <RevisionBar task={task} />
      {children.length > 0 && <button type="button" className="squad-summary" onClick={() => { setSquadFocus(true); setSquadOpen(true); setDiffOpen(false); }}><span><Users size={14} /><strong>{t('Agent squad', '子代理小队')}</strong><span>{activeChildren.length} {t('working', '位工作中')} · {children.length - activeChildren.length} {t('closed', '位已关闭')}</span></span><span className={waitingChildren.length ? 'squad-alert' : ''}>{waitingChildren.length ? `${waitingChildren.length} ${t('need your input', '位等待你的回应')}` : t('View assignments', '查看分工')}<ChevronRight size={14} /></span></button>}
      <div className="conversation-scroll" ref={scroller} onScroll={() => { const el = scroller.current; if (el) follows.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}><div className="conversation-content">
        {task.messages.length === 0 && task.tools.length === 0 && <div className="conversation-empty"><Mark size={30} /><p>{t('Ready when you are.', '准备好了，随时开始。')}</p></div>}
        <Conversation task={task} editSignal={editSignal} /><DeliveryCard task={task} onOpen={() => openWorkbench('checks')} />
        {data.interactions.filter(interaction => interaction.taskId === task.id).map(interaction => <InteractionDialog key={interaction.id} interaction={interaction} inline />)}
        {approvals.map(approval => <section className="approval-panel" key={approval.id} aria-label={t('Approval required', '需要审批')}><div className="approval-heading"><Terminal size={19} /><h3>{t('Permission to continue', '允许继续执行')}</h3></div><p>{approval.reason}</p><div className="approval-tool"><strong>{approval.toolName}</strong><pre>{JSON.stringify(approval.args, null, 2)}</pre></div><div className="approval-actions"><button className="button" onClick={() => void run(() => api.approve(approval.id, false))}>{t('Deny', '拒绝')}</button><button className="button primary" onClick={() => void run(() => api.approve(approval.id, true))}>{t('Allow once', '允许本次')}</button></div></section>)}
        {task.error && !task.truncation && <div className="task-error" role="alert"><strong>{t('This run needs attention', '本次执行需要处理')}</strong><p>{task.error}</p><span>{t('Review your gateway settings, then send a follow-up to try again.', '请检查网关设置，再发送一条消息重试。')}</span></div>}
        {active && !approvals.length && <div className="working-indicator"><span className="working-cells" aria-hidden="true"><i /><i /><i /></span><span>{task.status === 'queued' ? t('Queued · waiting for an available agent slot', '已排队 · 等待空闲 Agent 名额') : task.status === 'waiting' ? t('Waiting for an agent or approval…', '等待 Agent 或审批…') : t('Working…', '正在处理…')}</span></div>}
        <div ref={end} />
      </div><JumpToLatest scroller={scroller} /></div>
    </div>{squadOpen && <AgentSquad task={task} members={children} focusOnOpen={squadFocus} onClose={() => setSquadOpen(false)} onCreate={() => setParallel(true)} />}{diffOpen && <aside className={`diff-panel ${diffLayout === 'split' ? 'diff-panel-split' : ''}`} aria-label={t('Code changes', '代码修改')}><header><h2><FileDiff size={17} />{t('Changes', '修改')}</h2><div><IconButton label={t('Refresh diff', '刷新修改')} disabled={loadingDiff} onClick={() => void loadDiff()}><RefreshCw size={16} className={loadingDiff ? 'spinning' : ''} /></IconButton><IconButton label={t('Close changes', '关闭修改')} onClick={() => setDiffOpen(false)}><X size={17} /></IconButton></div></header>{loadingDiff ? <div className="diff-loading"><LoaderCircle className="spinning" size={20} /></div> : diff && <><div className="diff-meta"><GitBranch size={14} /><span>{diff.branch || t('Working tree', '工作树')}</span></div>{diff.status && <pre className="git-status">{diff.status}</pre>}{diff.patch ? <DiffView patch={diff.patch} mode={diffLayout} onModeChange={setDiffLayout} /> : <p className="diff-empty">{t('No tracked file changes.', '没有已跟踪文件的修改。')}</p>}{diff.untracked.length > 0 && <div className="untracked"><h3>{t('New files', '新文件')}</h3>{diff.untracked.map(path => <div key={path}>{path}</div>)}</div>}{task.worktree && <div className="merge-area"><p>{t('Apply this agent’s changes to the project branch.', '将此 Agent 的修改合并到项目分支。')}</p><button className="button" disabled={active} onClick={() => setMerge(true)}><GitMerge size={16} />{t('Merge into project', '合并到项目')}</button>{active && <small>{t('Stop or finish the task before merging.', '任务结束或停止后可合并。')}</small>}</div>}</> }</aside>}
    {rename && <Modal title={t('Rename task', '重命名任务')} onClose={() => setRename(false)} className="small-modal"><form onSubmit={e => { e.preventDefault(); void run(async () => { await api.updateTask(task.id, { title: title.trim() }); setRename(false); }); }}><Field label={t('Task name', '任务名称')}><input autoFocus value={title} onChange={e => setTitle(e.target.value)} required maxLength={180} /></Field><div className="modal-actions"><button type="button" className="button" onClick={() => setRename(false)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={!title.trim()}>{t('Save', '保存')}</button></div></form></Modal>}
    {parallel && <Modal title={t('Start a parallel agent', '启动并行 Agent')} onClose={() => setParallel(false)} className="small-modal"><p className="modal-intro">{t('Give this agent a focused task. Its progress stays linked to this conversation.', '分配一项明确任务。此 Agent 的进度将关联到当前对话。')}</p><form onSubmit={e => { e.preventDefault(); void createChild(); }}><Field label={t('Subagent', '子代理')}><select aria-label={t('Parallel subagent', '并行子代理')} value={availableChildRole} onChange={e => setChildRole(e.target.value)}>{usableRoles.map(role => <option key={role.id} value={role.id}>{role.name}{role.readOnly ? t(' · read only', ' · 只读') : ''}</option>)}</select></Field><Field label={t('Task', '任务')}><textarea autoFocus required value={childPrompt} onChange={e => setChildPrompt(e.target.value)} rows={5} placeholder={t('For example: inspect the API and report integration risks.', '例如：检查 API 并汇报集成风险。')} /></Field><label className="checkbox-row"><input type="checkbox" checked={!!project?.isGit && isolated} disabled={!project?.isGit} onChange={e => setIsolated(e.target.checked)} /><span>{t('Use an isolated Git worktree', '使用独立 Git 工作树')}<small>{project?.isGit ? t('Changes stay separate until you choose to merge.', '修改相互隔离，由你决定何时合并。') : t('This project is not a Git repository; the agent will share its folder.', '此项目不是 Git 仓库，Agent 将使用同一目录。')}</small></span></label><div className="modal-actions"><button type="button" className="button" onClick={() => setParallel(false)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={!childPrompt.trim() || creating}><Play size={15} />{creating ? t('Starting…', '启动中…') : t('Start agent', '启动 Agent')}</button></div></form></Modal>}
    {merge && <Modal title={t('Merge agent changes?', '合并 Agent 的修改？')} onClose={() => { if (!merging) setMerge(false); }} className="small-modal"><p className="modal-intro">{t('Merge the reviewed changes from this isolated worktree into the project. Cardwright checks the project state and reports conflicts before completing the merge.', '将已查看的独立工作树修改合并到项目。Cardwright 会检查项目状态，并在出现冲突时报告。')}</p><div className="merge-branches"><GitBranch size={16} /><code>{task.worktree?.branch}</code><span>→</span><code>{task.worktree?.baseBranch}</code></div><div className="modal-actions"><button className="button" disabled={merging} onClick={() => setMerge(false)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={merging} onClick={() => { setMerging(true); void run(() => api.mergeTask(task.id)).then(result => { setMerging(false); if (result) { setMerge(false); void loadDiff(); } }); }}><GitMerge size={16} />{merging ? t('Merging…', '正在合并…') : t('Merge changes', '合并修改')}</button></div></Modal>}
  </div>;
}
