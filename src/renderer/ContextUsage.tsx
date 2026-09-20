import { Database, LoaderCircle } from 'lucide-react';
import type { Task } from '../shared/types';
import { useApp } from './context';
import { Popover } from './primitives';
import { selectedModel } from './model-resolution';

const compact = (value: number) => value >= 1000000 ? `${Number((value / 1000000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : value.toLocaleString();

export function ContextUsage({ task }: { task: Task }) {
  const { data, t } = useApp();
  const usage = task.contextUsage;
  const model = selectedModel(data.gateways.find(gateway => gateway.id === task.gatewayId), task.modelId);
  const windowSize = task.contextWindow || model?.contextWindow || usage?.window || 300000;
  const reported = typeof usage?.tokens === 'number' && typeof usage?.percent === 'number';
  const percent = reported ? Math.max(0, usage.tokens! / windowSize * 100) : null;
  const visualPercent = percent === null ? 0 : Math.min(100, percent);
  const label = task.contextCompacting ? t('Compacting context…', '正在压缩上下文…') : reported ? `${compact(usage.tokens!)} / ${compact(windowSize)}` : t('Waiting for usage', '等待用量报告');
  return <Popover className={`context-meter ${task.contextCompacting ? 'is-compacting' : percent !== null && percent >= 85 ? 'is-near-limit' : ''}`} align="right" label={t('Current context usage', '当前上下文用量')} trigger={<>{task.contextCompacting ? <LoaderCircle size={13} className="spinning" /> : <Database size={13} />}<span className="context-meter-label">{t('Context', '上下文')}</span><span className="context-meter-rail" role="progressbar" aria-label={t('Context window used', '上下文窗口已用')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : visualPercent} aria-valuetext={label}><i style={{ width: `${visualPercent}%` }} /></span><span className="context-meter-numbers">{label}{reported && !task.contextCompacting && <b>{Number(percent!.toFixed(1))}%</b>}</span></>}>
    <div className="context-usage-detail"><h3>{t('Current context', '当前上下文')}</h3><dl><div><dt>{t('Used tokens', '已用 Token')}</dt><dd>{reported ? usage.tokens!.toLocaleString() : t('Not reported yet', '尚未报告')}</dd></div><div><dt>{t('Context window', '窗口容量')}</dt><dd>{windowSize.toLocaleString()}</dd></div><div><dt>{t('Automatic compaction', '自动压缩阈值')}</dt><dd>90% · {Math.floor(windowSize * .9).toLocaleString()}</dd></div>{!!task.compactions && <div><dt>{t('Compactions', '已压缩次数')}</dt><dd>{task.compactions}</dd></div>}</dl><p>{t('Shows this conversation’s current context. It decreases after compaction and is separate from cumulative token usage.', '显示本次对话当前占用的上下文。压缩后会减少，与累计消耗的 Token 分开统计。')}</p></div>
  </Popover>;
}
