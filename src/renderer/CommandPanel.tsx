import { X } from 'lucide-react';
import { useApp } from './context';
import { selectedModel } from './model-resolution';
import { commandsFor } from '../shared/slash-commands';
import type { Task } from '../shared/types';

export type WorkbenchPanel = 'context' | 'cost' | 'help';

const compact = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);

/** The answer to /context, /cost or /help, shown above the composer until it is closed (§6.2). */
export function CommandPanel({ panel, task, onClose }: { panel: WorkbenchPanel; task?: Task; onClose: () => void }) {
  const { data, t } = useApp();
  const gateway = task ? selectedModel(data.gateways.find(item => item.id === task.gatewayId), task.modelId, task.contextWindow) : undefined;
  let title = ''; let body;
  if (panel === 'context') {
    title = t('Context', '上下文');
    const window = task?.contextWindow || task?.contextUsage?.window || gateway?.contextWindow || 0;
    const used = task?.contextUsage?.tokens;
    body = <dl>
      <div><dt>{t('Used', '已用')}</dt><dd>{typeof used === 'number' ? `${compact(used)} / ${window ? compact(window) : '—'}${window ? ` (${Math.round(used / window * 100)}%)` : ''}` : t('Known after the next reply', '下一轮回复后可知')}</dd></div>
      <div><dt>{t('Automatic compaction at', '自动压缩')}</dt><dd>{window ? `${compact(Math.floor(window * 0.9))} (90%)` : '—'}</dd></div>
      <div><dt>{t('Compactions so far', '已压缩次数')}</dt><dd>{task?.compactions || 0}</dd></div>
    </dl>;
  } else if (panel === 'cost') {
    title = t('Cost of this conversation', '这次对话的花费');
    const totals = (task?.messages ?? []).reduce((sum, message) => message.usage ? { input: sum.input + message.usage.input, output: sum.output + message.usage.output, cacheRead: sum.cacheRead + message.usage.cacheRead, cacheWrite: sum.cacheWrite + message.usage.cacheWrite, cost: sum.cost + message.usage.cost } : sum, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const currency = gateway?.pricing?.currency;
    body = <dl>
      <div><dt>{t('Input', '输入')}</dt><dd>{totals.input.toLocaleString()}</dd></div>
      <div><dt>{t('Output', '输出')}</dt><dd>{totals.output.toLocaleString()}</dd></div>
      <div><dt>{t('Cache read / write', '缓存读取 / 写入')}</dt><dd>{totals.cacheRead.toLocaleString()} / {totals.cacheWrite.toLocaleString()}</dd></div>
      <div><dt>{t('Cost', '花费')}</dt><dd>{currency ? `${totals.cost.toFixed(4)} ${currency}` : t('No price configured for this model', '这个模型没有配置价格')}</dd></div>
    </dl>;
  } else {
    title = t('Commands and shortcuts', '命令与快捷键');
    const keys: Array<[string, string]> = [
      ['Enter', t('Send', '发送')], ['Shift Enter', t('New line', '换行')], ['Shift Tab', t('Switch mode', '切换模式')],
      ['/', t('Skills and commands', '技能与命令')], ['Esc', t('Interrupt this turn', '中断这一轮')], ['Esc Esc', t('Edit your last message', '编辑上一条消息')],
      ['Ctrl K', t('Find a task', '查找任务')], ['Ctrl ⇧ O', t('New task', '新建任务')], ['Ctrl ,', t('Settings', '设置')],
    ];
    body = <dl>
      {commandsFor('workbench').map(command => <div key={command.name}><dt><code>{command.label}</code></dt><dd>{data.preferences.language === 'zh' ? command.description.zh : command.description.en}</dd></div>)}
      {keys.map(([key, description]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{description}</dd></div>)}
    </dl>;
  }
  return <section className="command-panel" aria-label={title}>
    <header><b>{title}</b><button type="button" aria-label={t('Close', '关闭')} onClick={onClose}><X size={14} /></button></header>
    {body}
  </section>;
}
