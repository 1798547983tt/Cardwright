import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ChevronDown, Eraser, Globe, ShieldCheck, Square, SquareSlash, Users } from 'lucide-react';
import { useApp } from '../context';
import { MenuItem, Popover } from '../primitives';
import { ContextUsage } from '../ContextUsage';
import { ModelPicker } from '../ModelPicker';
import { thinkingLabel } from '../effort';
import { selectedModel } from '../model-resolution';
import { playCue } from '../sound';
import { availableEfforts } from '../../shared/effort';
import { sectionOf } from '../../shared/card-studio/boards';
import { runningConversation } from '../../shared/card-studio/view';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { PermissionMode, Task, ThinkingLevel } from '../../shared/types';
import { useStudio } from './CardStudio';
import { CommandPanelView, SlashMenu, useStudioSlash } from './StudioSlash';

const ACTIVE = ['running', 'queued', 'waiting'];
const MODES: PermissionMode[] = ['ask', 'edit', 'full'];

/** The card studio's three permission modes, as the workbench names them. */
export function cardPermissionLabels(t: (en: string, zh: string) => string): Record<PermissionMode, { name: string; description: string }> {
  return {
    ask: { name: t('Ask first', '默认审批'), description: t('Reads freely; asks before writing files or running commands.', '读取不用批准；写文件、运行命令前逐次批准。') },
    edit: { name: t('Auto-edit in project', '项目内自动编辑'), description: t('Writes inside the card project without asking; asks before commands or anything outside it.', '卡项目内写文件不用批准；运行命令、访问项目外内容前批准。') },
    full: { name: t('Full access', '完全访问'), description: t('Tools and commands run on this computer without approval, including outside the project.', '工具和命令直接在本机执行，不再批准，也可以访问项目外内容。') },
  };
}

/**
 * The section composer. With a task it continues that conversation; without one it holds the unsent draft
 * of a new conversation, which is created only when the user presses Send.
 */
export function StudioComposer({ card, sectionId, task }: { card: CardProjectView; sectionId: string; task?: Task }) {
  const { data, api, t, run } = useApp();
  const studio = useStudio();
  const draft = task ? undefined : studio.draft(card.projectId, sectionId);
  const text = task ? studio.composerText(task.id) : draft?.text ?? '';
  const [web, setWeb] = useState(false);
  const [thinking, setThinking] = useState<ThinkingLevel>(data.preferences.defaultThinking);
  const [draftModel, setDraftModel] = useState<{ gatewayId: string; modelId: string } | null>(null);
  const settings = data.projects.find(project => project.id === card.projectId)?.cardSettings;
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const running = !!task && (ACTIVE.includes(task.status) || !!task.workerActive);
  const other = runningConversation(data.tasks, card.projectId);
  const blocked = !!other && other.id !== task?.id;
  const draftGatewayId = draftModel?.gatewayId ?? (data.gateways.find(item => item.id === data.preferences.defaultGatewayId) ?? data.gateways[0])?.id ?? '';
  const gateway = task ? selectedModel(data.gateways.find(item => item.id === task.gatewayId), task.modelId, task.contextWindow)
    : selectedModel(data.gateways.find(item => item.id === draftGatewayId), draftModel?.modelId ?? (draftGatewayId === data.preferences.defaultGatewayId ? data.preferences.defaultModelId : undefined));
  // Ultra belongs to planning, where it brings the read-only reading squad.
  const efforts = gateway ? availableEfforts(gateway).filter(level => level !== 'ultra' || sectionId === 'plan') : ['off' as ThinkingLevel];
  const permission: PermissionMode = task ? task.permission : settings?.permission ?? 'edit';
  const labels = cardPermissionLabels(t);
  const currentThinking = task ? task.thinking : efforts.includes(thinking) ? thinking : efforts.includes('medium') ? 'medium' : efforts[0];
  const webOn = task ? !!task.card?.web : web;
  const high = !!sectionOf(sectionId)?.high || sectionId === 'plan';

  useEffect(() => { const element = textarea.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 260)}px`; } }, [text]);
  useEffect(() => { if (draft) textarea.current?.focus(); }, [draft?.title, draft?.dispatchId]);

  function setText(value: string) {
    if (task) studio.setComposerText(task.id, value);
    else if (draft) studio.updateDraft(card.projectId, sectionId, value);
    else studio.startDraft(card.projectId, sectionId, { title: '', text: value });
  }
  /** 撤回 of what is not sent yet (Q16 ①): the composer empties, and an unsent new conversation is dropped. */
  function clear() {
    if (task) studio.setComposerText(task.id, '');
    else studio.clearDraft(card.projectId, sectionId);
    textarea.current?.focus();
  }
  const slash = useStudioSlash({ card, sectionId, task, text, setText, root });
  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    if (slash.runIfCommand(value)) return;
    if (blocked) return;
    playCue('send');
    setSending(true);
    const created = await run(async () => {
      if (task) { await api.prompt(task.id, value, running ? 'followUp' : undefined); return task; }
      const started = await api.startCardConversation({ projectId: card.projectId, sectionId, title: draft?.title || undefined, dispatchId: draft?.dispatchId, prompt: value, web, thinking: currentThinking, ...(gateway ? { gatewayId: gateway.id, modelId: gateway.modelId } : {}) });
      if (draft?.handoffFrom) await api.consumeCardHandoff(draft.handoffFrom).catch(() => undefined);
      return started;
    });
    setSending(false);
    if (!created) return;
    if (task) studio.setComposerText(task.id, '');
    else { studio.clearDraft(card.projectId, sectionId); studio.openSection(card.projectId, sectionId, created.id); }
  }
  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    // Shift+Tab cycles the three permission modes, as in the workbench (the card studio has no plan mode).
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); void changePermission(MODES[(MODES.indexOf(permission) + 1) % MODES.length]); return; }
    if (slash.onKeyDown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }
  async function changeWeb(enabled: boolean) {
    if (task) await run(() => api.setCardConversationWeb(task.id, enabled));
    else setWeb(enabled);
  }
  async function changePermission(mode: PermissionMode) {
    await run(async () => {
      if (task) await api.updateTask(task.id, { permission: mode });
      await api.saveCardSettings(card.projectId, { permission: mode });
    });
  }
  async function changeThinking(level: ThinkingLevel) {
    if (task) await run(() => api.updateTask(task.id, { thinking: level }));
    else setThinking(level);
  }

  return <section ref={root} className={`cs-composer ${running ? 'is-running' : ''}`} aria-label={t('Section composer', '分区输入')}>
    {slash.panel && <CommandPanelView panel={slash.panel} task={task} onClose={slash.closePanel} onOpenBuild={slash.openBuild} />}
    <div className="cs-composer-box">
      {slash.suggestions.length > 0 && <SlashMenu items={slash.suggestions} active={slash.active} onChoose={slash.choose} />}
      <textarea ref={textarea} rows={3} value={text} disabled={sending} onChange={event => setText(event.target.value)} onKeyDown={keys}
        aria-label={t('Message this section', '给这个分区发消息')} aria-autocomplete="list" aria-controls={slash.suggestions.length ? 'cs-slash-menu' : undefined} aria-activedescendant={slash.suggestions.length ? `cs-slash-${slash.active}` : undefined}
        placeholder={task ? t('Reply, or guide the next step…', '回复，或引导下一步…') : t('Describe what this conversation should do…', '说说这个对话要做什么…')} />
      <div className="cs-composer-bar">
        <Popover label={t('Permission mode · Shift+Tab', '权限模式 · Shift+Tab 切换')} className="cs-chip-menu" trigger={<span className={`cs-chip cs-perm is-${permission}`} title={labels[permission].description}><ShieldCheck size={13} />{labels[permission].name}<ChevronDown size={12} /></span>}>{close => <>
          <div className="menu-heading">{t('Permission mode', '权限模式')}</div>
          {MODES.map(mode => <MenuItem key={mode} className={`cs-perm-item is-${mode}`} selected={mode === permission} onClick={() => { close(); void changePermission(mode); }}><span className="menu-stacked"><span>{labels[mode].name}</span><small>{labels[mode].description}</small></span></MenuItem>)}
          <div className="menu-footnote">{t('Shift+Tab switches. This card remembers the choice.', 'Shift+Tab 切换；这张卡会记住所选的档位。')}</div>
        </>}</Popover>
        <button type="button" className={`cs-chip is-toggle ${webOn ? 'is-on' : ''}`} aria-pressed={webOn} onClick={() => void changeWeb(!webOn)}><Globe size={13} />{webOn ? t('Web · on', '联网 · 开') : t('Web · off', '联网 · 关')}</button>
        {sectionId === 'plan' && currentThinking === 'ultra'
          ? <span className="cs-chip is-on" title={t('Ultra planning sends a read-only squad to read the material.', 'Ultra 规划会派只读小队读资料。')}><Users size={13} />{t('Squad · reads', '小队 · 只读读资料')}</span>
          : <span className="cs-chip is-muted" title={t('Only Ultra planning sends a read-only squad.', '只有规划选 Ultra 时才派只读小队。')}><Users size={13} />{t('Squad · off', '小队 · 关')}</span>}
        <button type="button" className="cs-chip is-toggle" title={t('Skills and commands', '技能与命令')} onClick={() => { setText('/'); textarea.current?.focus(); }}><SquareSlash size={13} />{t('Commands', '命令')}</button>
        <Popover label={t('Reasoning effort', '思考强度')} className="cs-chip-menu" trigger={<span className="cs-chip">{t('Effort', '思考')} · {thinkingLabel(currentThinking, t)}<ChevronDown size={12} /></span>}>{close => <>
          <div className="menu-heading">{t('Reasoning effort', '思考强度')}</div>
          {efforts.map(level => <MenuItem key={level} disabled={running} selected={level === currentThinking} onClick={() => { close(); void changeThinking(level); }}>{thinkingLabel(level, t)}</MenuItem>)}
          {running && <div className="menu-footnote">{t('Change it after this run ends.', '本次执行结束后可调整。')}</div>}
        </>}</Popover>
        {high && <span className="cs-hint">{t('High effort recommended', '建议高强度')}</span>}
        {task ? <span className="cs-model"><ModelPicker gatewayId={task.gatewayId} modelId={task.modelId} disabled={running} onChange={(gatewayId, modelId) => run(() => api.updateTask(task.id, { gatewayId, modelId }))} /></span>
          : <span className="cs-model"><ModelPicker gatewayId={draftGatewayId} modelId={gateway?.modelId} onChange={(gatewayId, modelId) => setDraftModel({ gatewayId, modelId })} /></span>}
        {task && <ContextUsage task={task} />}
        <span className="cs-composer-actions">
          {text && !sending && <button type="button" className="cs-icon" aria-label={t('Clear the composer', '清空输入框')} title={t('Clear: this text is not sent', '清空：这段文字不发送')} onClick={clear}><Eraser size={14} /></button>}
          {running && <button type="button" className="cs-btn is-small" onClick={() => void run(() => api.cancelTask(task!.id))}><Square size={12} />{t('Stop', '停止')}</button>}
          <button type="button" className="cs-btn is-primary cs-send" disabled={!text.trim() || sending || blocked} onClick={() => void send()}><ArrowUp size={15} />{running ? t('Queue', '排队发送') : t('Send', '发送')}</button>
        </span>
      </div>
    </div>
    {blocked && <p className="cs-composer-note is-warn">{t('Another conversation of this card is running. Wait for it to finish or stop it first.', '这张卡有另一个对话正在运行。等它结束或先停止它，再发送。')}</p>}
    {!gateway && <p className="cs-composer-note is-warn">{t('Configure a model gateway in settings before sending.', '请先在设置里配置模型网关，再发送。')}</p>}
  </section>;
}
