import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, BookOpen, ChevronDown, Database, Folder, FolderPlus, GitBranch, Globe, Laptop, Plus, ShieldCheck, SlidersHorizontal, Square } from 'lucide-react';
import type { PermissionMode, Task, ThinkingLevel } from '../shared/types';
import { useApp } from './context';
import { IconButton, MenuItem, Popover } from './primitives';
import { ContextUsage } from './ContextUsage';
import { availableEfforts } from '../shared/effort';
import { selectedModel } from './model-resolution';
import { ModelPicker } from './ModelPicker';
import { AttachmentComposer } from './AttachmentComposer';
import { CommandPanel, type WorkbenchPanel } from './CommandPanel';
import { commandsFor, matchCommand, slashSuggestions } from '../shared/slash-commands';
import { usableAgents } from '../shared/agents';
import { MODES, modeIndex, modeLabel, nextMode, type ComposerMode } from '../shared/permission-modes';
import { playCue } from './sound';
import type { AttachmentInfo } from '../shared/studio-types';

export const permissionLabels = (t: (en: string, zh: string) => string) => ({ ask: t('Ask permissions', '审批模式'), edit: t('Auto-edit', '自动编辑'), full: t('Full access', '完全访问') });
export const permissionDescriptions = (t: (en: string, zh: string) => string) => ({ ask: t('Read directly. Ask before writing files or running commands.', '直接读取项目；写文件和运行命令前请求审批。'), edit: t('Edit project files automatically. Ask before shell commands or access outside the project.', '自动编辑项目文件；运行命令或访问项目外内容前请求审批。'), full: t('Tools and commands run directly on this device without approval, including outside the project. Restricted execution is bypassed.', '工具和命令直接在本机执行，无需审批，可访问项目外内容，并跳过受限执行。') });
import { thinkingLevels, thinkingLabel } from './effort';
export { thinkingLevels, thinkingLabel } from './effort';

export function Composer({ task, projectId, setProjectId }: { task?: Task; projectId: string; setProjectId: (id: string) => void }) {
  const { data, api, run, t, settings, navigate, view } = useApp();
  const [panel, setPanel] = useState<WorkbenchPanel | null>(null);
  const root = useRef<HTMLElement>(null);
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [isolated, setIsolated] = useState(false);
  const [gatewayId, setGatewayId] = useState(task?.gatewayId || data.preferences.defaultGatewayId || data.gateways[0]?.id || '');
  const [modelId, setModelId] = useState(task?.modelId || data.preferences.defaultModelId || '');
  const [contextWindow, setContextWindow] = useState(task?.contextWindow || data.preferences.defaultContextWindow || 300000);
  const contextChosen = useRef(!!task?.contextWindow);
  const [permission, setPermission] = useState<PermissionMode>(task?.permission || data.preferences.defaultPermission);
  const [thinking, setThinking] = useState<ThinkingLevel>(task?.thinking || data.preferences.defaultThinking);
  const [role, setRole] = useState('general-purpose'); const [planMode, setPlanMode] = useState(false);
  const usable = usableAgents(data.ecosystem.roles, task?.projectId ?? projectId);
  const availableRole = usable.some(item => item.id === role) ? role : usable.find(item => item.id === 'general-purpose')?.id || usable[0]?.id || 'general-purpose';
  useEffect(() => { if (role !== availableRole) setRole(availableRole); }, [role, availableRole]);
  const [behavior, setBehavior] = useState<'steer' | 'followUp'>('followUp');
  const permissionChosen = useRef(false); const thinkingChosen = useRef(false); const modelChosen = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0); const [slashClosed, setSlashClosed] = useState(false);
  const baseGateway = data.gateways.find(g => g.id === gatewayId);
  const selectedGateway = selectedModel(baseGateway, modelId || undefined, contextWindow);
  const project = data.projects.find(p => p.id === (task?.projectId || projectId));
  const sourcePriority: Record<string, number> = { project: 0, custom: 1, user: 2, bundled: 3 };
  const availableSkills = data.skills.filter(skill => skill.enabled !== false && (!skill.projectId || skill.projectId === project?.id)).sort((a, b) => (sourcePriority[a.source || 'user'] ?? 2) - (sourcePriority[b.source || 'user'] ?? 2)).filter((skill, index, all) => all.findIndex(item => item.name === skill.name) === index);
  const commands = commandsFor('workbench', { task: !!task });
  const suggestions = (slashClosed ? null : slashSuggestions(text, { skills: availableSkills, commands, language: data.preferences.language })) ?? [];
  useEffect(() => { setSuggestionIndex(0); setSlashClosed(false); }, [text]);
  const activeSuggestion = suggestions[Math.min(suggestionIndex, Math.max(0, suggestions.length - 1))];
  useEffect(() => { document.getElementById(`slash-option-${suggestionIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [suggestionIndex]);
  /** Picking a command from the menu runs it; picking a skill fills the composer, as before. */
  function chooseSuggestion(index: number) {
    const item = suggestions[index]; if (!item) return;
    if (item.command) { setText(''); setSlashClosed(true); void runCommand(item.command); requestAnimationFrame(() => textarea.current?.focus()); return; }
    setText(item.insert); setSlashClosed(true); requestAnimationFrame(() => textarea.current?.focus());
  }
  const running = task && (['running', 'queued', 'waiting'].includes(task.status) || task.workerActive);
  const readOnlyTask = !!(task?.planMode || (!task && planMode) || data.ecosystem.roles.find(item => item.id === (task?.role || availableRole))?.readOnly);
  const descriptions = permissionDescriptions(t);
  useEffect(() => {
    if (task) return;
    const valid = data.gateways.some(gateway => gateway.id === gatewayId);
    const preferred = data.gateways.find(gateway => gateway.id === data.preferences.defaultGatewayId)?.id || data.gateways[0]?.id || '';
    if (!valid || !modelChosen.current) { if (!valid) modelChosen.current = false; setGatewayId(preferred); const next = data.gateways.find(item => item.id === preferred); setModelId(next && preferred === data.preferences.defaultGatewayId && selectedModel(next, data.preferences.defaultModelId) ? data.preferences.defaultModelId || next.modelId : next?.modelId || ''); if (!contextChosen.current) setContextWindow(data.preferences.defaultContextWindow || next?.contextWindow || 300000); }
    else if (!selectedGateway && baseGateway) { setModelId(baseGateway.modelId); if (!contextChosen.current) setContextWindow(baseGateway.contextWindow); }
  }, [data.gateways, data.preferences.defaultGatewayId, data.preferences.defaultModelId, data.preferences.defaultContextWindow, gatewayId, modelId, task?.id]);
  useEffect(() => { if (!task && !permissionChosen.current) setPermission(data.preferences.defaultPermission); }, [data.preferences.defaultPermission, task?.id]);
  useEffect(() => {
    if (task || !selectedGateway) return;
    const available = availableEfforts(selectedGateway);
    const preferred = thinkingChosen.current ? thinking : data.preferences.defaultThinking;
    const next = available.includes(preferred) ? preferred : available.includes('medium') ? 'medium' : available[0] || 'off';
    if (next !== thinking) setThinking(next);
  }, [selectedGateway, thinking, data.preferences.defaultThinking, task?.id]);
  useEffect(() => { if (task) { setPermission(task.permission); setGatewayId(task.gatewayId); setModelId(task.modelId || ''); setContextWindow(task.contextWindow || 300000); setThinking(task.thinking); } }, [task?.permission, task?.gatewayId, task?.modelId, task?.contextWindow, task?.thinking]);
  useEffect(() => { const el = textarea.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; } }, [text]);
  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    // Shift+Tab cycles 默认审批 → 自动编辑 → 计划 → 完全访问, as in Claude Code.
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); void changeMode(nextMode(mode)); return; }
    if (suggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSuggestionIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseSuggestion(Math.min(suggestionIndex, suggestions.length - 1)); return; }
      if (event.key === 'Escape') { event.preventDefault(); setSlashClosed(true); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }
  /** What a slash command does: a panel here, a view elsewhere, or a round with the agent. */
  async function runCommand(name: string) {
    if (name === 'context' || name === 'cost' || name === 'help') { setPanel(name); return; }
    if (name === 'clear') { navigate(null); return; }
    if (name === 'resume') { view?.({ kind: 'search' }); return; }
    if (name === 'rewind') { view?.({ kind: 'panel', tab: 'changes' }); return; }
    // The model picker is a popover; open it where the user can see what they are choosing between.
    if (name === 'model') { root.current?.querySelector<HTMLElement>('.composer-footer-end .model-picker .popover-trigger')?.click(); return; }
    if (task) await run(() => api.command(task.id, `/${name}`));
  }
  async function send() {
    if ((!text.trim() && !attachments.length) || sending || !project) return;
    const command = attachments.length ? undefined : matchCommand(text, commands);
    if (command) { setText(''); await runCommand(command.name); textarea.current?.focus(); return; }
    if (!selectedGateway) return;
    playCue('send');
    setSending(true); const promptText = text.trim() ? text : t('Please review these attachments.', '请查看这些附件。'); const attachmentIds = attachments.map(item => item.id);
    const result = await run(async () => {
      if (task) await api.prompt(task.id, promptText, running ? behavior : undefined, attachmentIds);
      else { const created = await api.createTask({ projectId: project.id, prompt: promptText, gatewayId, modelId: selectedGateway.modelId, contextWindow, permission, thinking: selectedGateway?.reasoning ? thinking : 'off', isolated, role: availableRole, planMode, attachments: attachmentIds }); navigate(created.id); }
      return true;
    });
    if (result) { setText(''); setAttachments([]); } setSending(false); textarea.current?.focus();
  }
  async function changePermission(value: PermissionMode) { if (task) await run(() => api.updateTask(task.id, { permission: value })); else { permissionChosen.current = true; setPermission(value); } }
  const mode: ComposerMode = { permission: task ? task.permission : permission, planMode: task ? !!task.planMode : planMode };
  async function changeMode(next: ComposerMode) {
    if (task) await run(async () => {
      if (next.permission !== task.permission) await api.updateTask(task.id, { permission: next.permission });
      if (!!task.planMode !== next.planMode) await api.setPlanMode(task.id, next.planMode);
    });
    else { permissionChosen.current = true; setPermission(next.permission); setPlanMode(next.planMode); }
  }
  async function changeModel(nextGatewayId: string, nextModelId: string) {
    const base = data.gateways.find(item => item.id === nextGatewayId); const next = selectedModel(base, nextModelId);
    if (!next) return;
    const available = availableEfforts(next); const nextThinking = (available.includes(thinking) ? thinking : available.includes('medium') ? 'medium' : available[0] || 'off') as ThinkingLevel;
    const nextContext = contextChosen.current ? contextWindow : next.contextWindow;
    if (task) await run(() => api.updateTask(task.id, { gatewayId: nextGatewayId, modelId: nextModelId, contextWindow: nextContext, thinking: nextThinking }));
    else { modelChosen.current = true; setGatewayId(nextGatewayId); setModelId(nextModelId); setContextWindow(nextContext); setThinking(nextThinking); }
  }
  async function changeContext(size: number) {
    if (task) await run(() => api.updateTask(task.id, { contextWindow: size }));
    else { contextChosen.current = true; setContextWindow(size); await run(() => api.savePreferences({ defaultContextWindow: size })); }
  }
  async function changeThinking(value: ThinkingLevel) { if (task) await run(() => api.updateTask(task.id, { thinking: value })); else { thinkingChosen.current = true; setThinking(value); } }
  return <section ref={root} className={`composer-region ${running ? 'composer-running' : ''}`} aria-label={t('Task composer', '任务输入')}><div className="composer-context"><span className="context-chip"><Laptop size={16} />{t('Local', '本地')}</span>{task ? <button className="context-chip" title={task.cwd} onClick={() => void run(() => api.openPath(task.cwd))}><Folder size={16} />{project?.name || task.cwd}</button> : <Popover label={t('Choose project', '选择项目')} className="project-picker" trigger={<><Folder size={16} /><span>{project?.name || t('Choose a project', '选择项目')}</span></>}>{close => <><div className="menu-heading">{t('Projects', '项目')}</div>{data.projects.map(item => <MenuItem key={item.id} selected={item.id === projectId} onClick={() => { setProjectId(item.id); setIsolated(false); close(); }}><span className="menu-stacked"><span>{item.name}</span><small>{item.path}</small></span></MenuItem>)}<div className="menu-divider" /><MenuItem onClick={() => { close(); void run(async () => { const next = await api.pickProject(); if (next) setProjectId(next.id); }); }}><FolderPlus size={16} />{t('Add project folder', '添加项目文件夹')}</MenuItem></>}</Popover>}{!task && <IconButton label={t('Add project folder', '添加项目文件夹')} className="context-chip" onClick={() => void run(async () => { const next = await api.pickProject(); if (next) setProjectId(next.id); })}><FolderPlus size={17} /></IconButton>}{task?.worktree && <span className="worktree-label" title={task.worktree.path}><GitBranch size={14} />{task.worktree.branch}</span>}{!task && project?.isGit && <label className="isolation-option"><input type="checkbox" checked={isolated} onChange={e => setIsolated(e.target.checked)} /><GitBranch size={14} />{t('Isolated worktree', '独立工作树')}</label>}{!task && <select className="composer-role" aria-label={t('Subagent', '子代理')} value={availableRole} onChange={e => setRole(e.target.value)}>{usable.map(item => <option key={item.id} value={item.id}>{item.name}{item.readOnly ? t(' · read only', ' · 只读') : ''}</option>)}</select>}{running && <select className="queue-select" value={behavior} onChange={e => setBehavior(e.target.value as 'steer' | 'followUp')} aria-label={t('Message behavior', '消息发送方式')}><option value="followUp">{t('Queue follow-up', '排队跟进')}</option><option value="steer">{t('Steer current task', '引导当前任务')}</option></select>}{task && <ContextUsage task={task} />}</div>
    {panel && <CommandPanel panel={panel} task={task} onClose={() => setPanel(null)} />}
    <AttachmentComposer taskId={task?.id} projectId={project?.id} attachments={attachments} onChange={setAttachments} text={text} onText={setText} textareaRef={textarea} disabled={sending} /><div className="composer-box">{suggestions.length > 0 && <div className="slash-suggestions" id="composer-suggestions" role="listbox" aria-label={t('Skills and commands', '技能与命令')}><div className="slash-heading"><span>{t('Skills & commands', '技能与命令')}</span><small>↑ ↓ · Enter · Esc</small></div>{suggestions.map((item, index) => <button key={item.id} id={'slash-option-' + index} role="option" aria-selected={item === activeSuggestion} className={item === activeSuggestion ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => chooseSuggestion(index)}><BookOpen size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span>{item.manual && <em>{t('Manual', '手动')}</em>}</button>)}</div>}<span className="composer-prompt" aria-hidden="true">&gt;_</span><textarea ref={textarea} aria-label={t('Describe a task or ask a question', '描述一个任务，或提出问题')} placeholder={task ? t('Add a follow-up or guide the next step…', '继续交流，或引导下一步…') : t('Describe a task or ask a question', '描述一个任务，或提出问题')} value={text} aria-autocomplete="list" aria-controls={suggestions.length ? "composer-suggestions" : undefined} aria-activedescendant={suggestions.length ? "slash-option-" + suggestions.indexOf(activeSuggestion) : undefined} onChange={e => setText(e.target.value)} onKeyDown={composerKey} rows={1} /><div className="composer-actions">{running && <IconButton label={t('Stop task', '停止任务')} className="stop-button" onClick={() => void run(() => api.cancelTask(task.id))}><Square size={15} fill="currentColor" /></IconButton>}<button type="button" aria-label={running ? t('Send follow-up', '发送跟进消息') : t('Send task', '发送任务')} title={`${running ? t('Send follow-up', '发送跟进消息') : t('Send task', '发送任务')} · Enter`} className="send-button" disabled={(!text.trim() && !attachments.length) || !project || !selectedGateway || sending} onClick={() => void send()}><span>{t('Send', '发送')}</span><ArrowUp size={16} /></button></div></div>
    <div className="composer-footer"><div className="composer-footer-start"><Popover label={t('Task mode · Shift+Tab', '任务模式 · Shift+Tab 切换')} className={`permission-picker permission-${mode.planMode ? 'plan' : mode.permission}`} trigger={<><small className="module-label">{t('Mode', '模式')}</small><span className="module-value"><ShieldCheck size={14} /><span>{modeLabel(mode, t)}</span><ChevronDown size={13} /></span></>}>{close => <><div className="menu-heading">{t('Mode', '模式')}<small>Shift Tab</small></div>{MODES.map((item, index) => <MenuItem key={index} className={`permission-${item.planMode ? 'plan' : item.permission}`} selected={modeIndex(mode) === index} onClick={() => { void changeMode(item); close(); }}><span className="menu-stacked"><span className="permission-name"><span className="permission-symbol" />{modeLabel(item, t)}</span><small>{item.planMode ? t('Reads and plans only; nothing is written until you approve the plan.', '只读、只出计划；计划批准前不写文件。') : descriptions[item.permission]}</small></span></MenuItem>)}<div className="menu-footnote"><ShieldCheck size={14} />{readOnlyTask ? t('Read-only task · writes are blocked', '只读任务 · 禁止写入') : permission === 'full' ? t('Full access · host execution', '完全访问 · 本机执行') : data.studio?.preferences.sandboxEnabled ? t('Approved commands use restricted execution', '已批准的命令使用受限执行') : t('Host execution · task approvals still apply', '本机执行 · 仍遵循任务审批')}</div></>}</Popover><IconButton label={t('Choose a skill', '选择技能')} onClick={() => { setText('/'); setSlashClosed(false); textarea.current?.focus(); }}><BookOpen size={16} /></IconButton><button type="button" className={`composer-search ${data.search.enabled ? 'enabled' : ''}`} onClick={() => settings('search')} aria-label={t('Web search settings', '联网搜索设置')} title={data.search.enabled ? t('Web search enabled · configure', '已启用联网搜索 · 配置') : t('Configure web search', '配置联网搜索')}><small className="module-label">{t('Web', '联网')}</small><span className="module-value"><Globe size={14} /><span>{data.search.enabled ? t('On', '已开') : t('Off', '未开')}</span></span></button></div><div className="composer-footer-end"><Popover label={t('Choose context window', '选择上下文窗口')} align="right" className="context-picker" trigger={<><small className="module-label">{t('Window', '窗口')}</small><span className="module-value"><Database size={14} /><span>{contextWindow === 1000000 ? '1M' : `${Math.round(contextWindow / 1000)}K`}</span><ChevronDown size={12} /></span></>}>{close => <><div className="menu-heading">{t('Context window', '上下文窗口')}</div>{[300000, 500000, 1000000].map(size => <MenuItem key={size} selected={contextWindow === size} disabled={!!running || !selectedGateway} onClick={() => { void changeContext(size); close(); }}><span className="context-choice"><strong>{size === 1000000 ? '1M' : `${size / 1000}K`}</strong><small>{size.toLocaleString()} Token</small></span></MenuItem>)}<div className="menu-footnote">{running ? t('Change the window after this run ends.', '本次执行结束后可切换窗口。') : t('Automatically compacts near 90% usage.', '用量接近 90% 时自动压缩。')}</div></>}</Popover><ModelPicker gatewayId={gatewayId} modelId={selectedGateway?.modelId || modelId} disabled={!!running} onChange={changeModel} />{selectedGateway?.reasoning && <label className="effort-select"><small className="module-label">{t('Effort', '强度')}</small><select aria-label={t('Reasoning effort', '推理强度')} value={thinking} disabled={!!running} onChange={event => void changeThinking(event.target.value as ThinkingLevel)}>{availableEfforts(selectedGateway).map(level => <option key={level} value={level}>{thinkingLabel(level, t)}</option>)}</select></label>}<span className={`connection-indicator ${selectedGateway ? 'connected' : ''}`} title={selectedGateway ? t('Model configured', '已配置模型') : t('No model configured', '尚未配置模型')} /></div></div>
    {(!project || !selectedGateway) && text.length > 0 && <div className="composer-hint">{!project ? t('Choose a project folder to continue.', '请选择项目文件夹以继续。') : baseGateway && modelId ? t('This model is no longer configured. Choose another model to continue.', '此模型已不在网关配置中，请选择其他模型继续。') : t('Configure a model gateway to send this task.', '请先配置模型网关，再发送任务。')}</div>}
  </section>;
}
