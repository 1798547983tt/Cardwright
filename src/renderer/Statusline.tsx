import { Database, GitBranch } from 'lucide-react';
import type { Task } from '../shared/types';
import { statusText, useApp } from './context';

export function Statusline({ task }: { task?: Task }) {
  const { data, t } = useApp();
  if (!data.ecosystem.showStatusline || !task) return null;
  const gateway = data.gateways.find(item => item.id === task.gatewayId);
  const latestUsage = [...task.messages].reverse().find(message => message.usage)?.usage;
  return <footer className="runtime-statusline" aria-label={t('Agent status', 'Agent 状态')}>
    <span className={task.truncation ? 'statusline-truncated' : undefined}><i className={`status-diamond ${task.truncation ? 'truncated' : task.status}`} />{task.truncation ? t('Output truncated', '输出被截断') : statusText(task.status, t)}</span>
    {(gateway || task.modelId) && <span title={gateway?.name}>{task.modelId || gateway?.modelId}</span>}
    {task.worktree && <span title={task.worktree.path}><GitBranch size={11} />{task.worktree.branch}</span>}
    {latestUsage && <span title={t('Last reported response: input / output tokens', '最近回复报告的输入 / 输出 Token')}>{latestUsage.input.toLocaleString()} / {latestUsage.output.toLocaleString()} Token</span>}
    {!!task.compactions && <span><Database size={11} />{t('Compactions', '压缩')} {task.compactions}</span>}
    {Object.entries(task.runtimeStatus || {}).filter(([, value]) => value).map(([key, value]) => <span key={key} title={t('Runtime status', '运行状态')}>{value}</span>)}
  </footer>;
}
