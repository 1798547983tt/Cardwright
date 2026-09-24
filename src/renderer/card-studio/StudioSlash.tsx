import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { BookOpen, SquareSlash, X } from 'lucide-react';
import { useApp } from '../context';
import { changeCommandText, commandsFor, matchCommand, slashSuggestions, type SlashCommand, type SlashItem } from '../../shared/slash-commands';
import { DEFAULT_HANDOFF, handoffThreshold } from '../../shared/card-studio/handoff';
import { markableDispatch } from '../../shared/card-studio/view';
import type { CardCheckReport, CardProjectView } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { selectedModel } from '../model-resolution';
import { tokenCount, useCardActions } from './actions';
import { useStudio } from './CardStudio';

/** What a local command shows above the composer; it is not written into the conversation. */
export type CommandPanel = { kind: 'context' | 'cost' | 'help' } | { kind: 'check'; report: CardCheckReport };

const ACTIVE = ['running', 'queued', 'waiting'];
const CARD_COMMANDS = commandsFor('card');

/**
 * The card composer's slash menu: enabled skills first, then the common and card commands. Choosing a skill fills it in;
 * choosing a command, or sending a message that is exactly a command, runs it.
 */
export function useStudioSlash({ card, sectionId, task, text, setText, root }: { card: CardProjectView; sectionId: string; task?: Task; text: string; setText: (value: string) => void; root: RefObject<HTMLElement | null> }) {
  const { data, api, t, run, notify } = useApp();
  const studio = useStudio();
  const actions = useCardActions(card);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);
  const [panel, setPanel] = useState<CommandPanel | null>(null);
  const priority: Record<string, number> = { project: 0, custom: 1, user: 2, bundled: 3 };
  const skills = data.skills.filter(skill => skill.enabled !== false && (!skill.projectId || skill.projectId === card.projectId))
    .sort((a, b) => (priority[a.source || 'user'] ?? 2) - (priority[b.source || 'user'] ?? 2))
    .filter((skill, position, all) => all.findIndex(item => item.name === skill.name) === position);
  const items = closed ? null : slashSuggestions(text, { skills, commands: CARD_COMMANDS, language: data.preferences.language });
  const suggestions = items && items.length ? items : [];
  useEffect(() => { setIndex(0); setClosed(false); }, [text]);
  useEffect(() => { document.getElementById(`cs-slash-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index]);

  /** `argument`: what followed `/改动` in the message, which the change dialog starts with. */
  async function execute(command: SlashCommand, argument = ''): Promise<void> {
    setText('');
    const running = !!task && (ACTIVE.includes(task.status) || !!task.workerActive);
    switch (command.name) {
      case 'compact':
        if (!task) { notify(t('A new conversation has nothing to compact yet.', '新对话还没有内容，无需压缩。')); return; }
        if (running) { notify(t('Compact after this run ends.', '这一轮结束后再压缩。')); return; }
        await run(() => api.command(task.id, '/compact'));
        return;
      case 'context': case 'cost': case 'help':
        setPanel({ kind: command.name });
        return;
      case 'model': {
        const trigger = root.current?.querySelector<HTMLButtonElement>('.model-picker .popover-trigger');
        if (trigger && !trigger.disabled) trigger.click();
        else notify(running ? t('Change the model after this run ends.', '这一轮结束后再换模型。') : t('Pick the model in the composer below.', '在输入框下方选择模型。'));
        return;
      }
      case '检查': {
        const report = await run(() => api.runCardChecks(card.projectId));
        if (report) setPanel({ kind: 'check', report });
        return;
      }
      case '标记完成': {
        const markable = markableDispatch(card, sectionId, task);
        if (!markable) { notify(t('This conversation has no dispatch in progress.', '这个对话没有进行中的派单。')); return; }
        await run(() => api.markDispatchDone(card.projectId, markable.id), t('Dispatch marked done', '派单已标记完成'));
        return;
      }
      case '换对话':
        if (!task) { notify(t('This is already a new conversation.', '这已经是新对话了。')); return; }
        if (running) { notify(t('Change conversations after this run ends.', '这一轮结束后再换对话。')); return; }
        await actions.requestHandoff(task);
        return;
      case '下一步':
        actions.openNextDispatch();
        return;
      case '改动':
        studio.openChange(card.projectId, argument);
        return;
    }
  }

  function choose(position: number) {
    const item = suggestions[position];
    if (!item) return;
    const command = item.command ? CARD_COMMANDS.find(entry => entry.name === item.command) : undefined;
    if (command) void execute(command);
    else { setText(item.insert); setClosed(true); }
  }

  return {
    suggestions, active: Math.min(index, Math.max(0, suggestions.length - 1)), panel, closePanel: () => setPanel(null), choose,
    /** Handles the menu's keys; true when the key was used. */
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!suggestions.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(Math.min(index, suggestions.length - 1)); return true; }
      if (event.key === 'Escape') { event.preventDefault(); setClosed(true); return true; }
      return false;
    },
    /** A message that is exactly a card command runs that command instead of being sent; `/改动 …` opens the change dialog with the rest. */
    runIfCommand(value: string): boolean {
      const change = changeCommandText(value);
      const changeCommand = CARD_COMMANDS.find(entry => entry.name === '改动');
      if (change !== null && changeCommand) { void execute(changeCommand, change); return true; }
      const command = matchCommand(value, CARD_COMMANDS);
      if (!command) return false;
      void execute(command);
      return true;
    },
    openBuild: () => studio.openSection(card.projectId, 'build'),
  };
}

export function SlashMenu({ items, active, onChoose }: { items: SlashItem[]; active: number; onChoose: (index: number) => void }) {
  const { t } = useApp();
  return <div className="cs-slash" id="cs-slash-menu" role="listbox" aria-label={t('Skills and commands', '技能与命令')}>
    <div className="cs-slash-head"><span>{t('Skills & commands', '技能与命令')}</span><small>↑ ↓ · Enter · Esc</small></div>
    {items.map((item, index) => <button key={item.id} id={`cs-slash-${index}`} type="button" role="option" aria-selected={index === active} className={index === active ? 'is-active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => onChoose(index)}>
      {item.kind === 'skill' ? <BookOpen size={14} /> : <SquareSlash size={14} />}
      <span><b>{item.label}</b><small>{item.description}</small></span>
      {item.manual && <em>{t('Manual', '手动')}</em>}
    </button>)}
  </div>;
}

/** The answer to /context, /cost, /help or /检查, shown above the composer until closed. */
export function CommandPanelView({ panel, task, onClose, onOpenBuild }: { panel: CommandPanel; task?: Task; onClose: () => void; onOpenBuild: () => void }) {
  const { data, t } = useApp();
  const gateway = task ? selectedModel(data.gateways.find(item => item.id === task.gatewayId), task.modelId, task.contextWindow) : undefined;
  let title = ''; let body;
  if (panel.kind === 'context') {
    title = t('Context', '上下文');
    const window = task?.contextWindow || task?.contextUsage?.window || gateway?.contextWindow || 0;
    const used = task?.contextUsage?.tokens;
    const threshold = handoffThreshold(window, data.preferences.cardHandoff ?? DEFAULT_HANDOFF);
    body = <dl>
      <dt>{t('Used', '已用')}</dt><dd>{typeof used === 'number' ? `${tokenCount(used)} / ${window ? tokenCount(window) : '—'}${window ? `（${Math.round(used / window * 100)}%）` : ''}` : t('Known after the next reply', '下一轮回复后可知')}</dd>
      <dt>{t('New conversation offered at', '提议换对话')}</dt><dd>{window ? tokenCount(threshold) : '—'}</dd>
      <dt>{t('Automatic compaction at', '自动压缩')}</dt><dd>{window ? `${tokenCount(Math.floor(window * 0.9))}（90%）` : '—'}</dd>
    </dl>;
  } else if (panel.kind === 'cost') {
    title = t('Cost of this conversation', '这次对话的花费');
    const totals = (task?.messages ?? []).reduce((sum, message) => message.usage ? { input: sum.input + message.usage.input, output: sum.output + message.usage.output, cacheRead: sum.cacheRead + message.usage.cacheRead, cacheWrite: sum.cacheWrite + message.usage.cacheWrite, cost: sum.cost + message.usage.cost } : sum, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const currency = gateway?.pricing?.currency;
    body = <dl>
      <dt>{t('Input', '输入')}</dt><dd>{totals.input.toLocaleString()}</dd>
      <dt>{t('Output', '输出')}</dt><dd>{totals.output.toLocaleString()}</dd>
      <dt>{t('Cache read / write', '缓存读取 / 写入')}</dt><dd>{totals.cacheRead.toLocaleString()} / {totals.cacheWrite.toLocaleString()}</dd>
      <dt>{t('Cost', '花费')}</dt><dd>{currency ? `${totals.cost.toFixed(4)} ${currency}` : t('No price configured for this model', '这个模型没有配置价格')}</dd>
    </dl>;
  } else if (panel.kind === 'help') {
    title = t('Commands and shortcuts', '命令与快捷键');
    body = <dl>
      {CARD_COMMANDS.map(command => <div key={command.name} className="cs-panel-row"><dt><code>{command.label}</code></dt><dd>{data.preferences.language === 'zh' ? command.description.zh : command.description.en}</dd></div>)}
      <div className="cs-panel-row"><dt><kbd>Enter</kbd></dt><dd>{t('Send', '发送')}</dd></div>
      <div className="cs-panel-row"><dt><kbd>Shift</kbd>+<kbd>Enter</kbd></dt><dd>{t('New line', '换行')}</dd></div>
      <div className="cs-panel-row"><dt><kbd>Shift</kbd>+<kbd>Tab</kbd></dt><dd>{t('Switch the permission mode', '切换权限模式')}</dd></div>
      <div className="cs-panel-row"><dt><kbd>/</kbd></dt><dd>{t('Skills and commands', '技能与命令')}</dd></div>
    </dl>;
  } else if (panel.kind === 'check') {
    const { report } = panel;
    const errors = report.findings.filter(item => item.level === 'error'); const warnings = report.findings.filter(item => item.level === 'warning');
    title = t('Assembly check', '拼装检查');
    body = <>
      <p className={errors.length ? 'is-bad' : 'is-good'}>{errors.length ? t(`${errors.length} errors, ${warnings.length} warnings. Errors block the export.`, `${errors.length} 个错误，${warnings.length} 个警告。有错误时不能导出。`) : t(`No errors, ${warnings.length} warnings.`, `没有错误，${warnings.length} 个警告。`)}</p>
      {[...errors, ...warnings].slice(0, 5).length > 0 && <ul>{[...errors, ...warnings].slice(0, 5).map((finding, index) => <li key={index} className={`is-${finding.level}`}><b>{finding.level === 'error' ? t('Error', '错误') : t('Warning', '警告')}</b>{finding.message}{finding.path && <small>{finding.path}</small>}</li>)}</ul>}
      <button type="button" className="cs-link" onClick={onOpenBuild}>{t('Open the assembly bench', '打开拼装台')}</button>
    </>;
  }
  return <section className="cs-command-panel" aria-label={title}>
    <header><b>{title}</b><button type="button" aria-label={t('Close', '关闭')} onClick={onClose}><X size={13} /></button></header>
    {body}
  </section>;
}
