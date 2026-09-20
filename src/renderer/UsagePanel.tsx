import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, X } from 'lucide-react';
import { buildUsageReport, type TokenTotals } from '../shared/usage';
import { useApp } from './context';
import { IconButton } from './primitives';
import './usage.css';

/** `compact` starts as totals plus a small activity strip; details expand in place. */
export function UsagePanel({ compact = false }: { compact?: boolean }) {
  const { data, t, navigate, usage, openStudio } = useApp();
  const tasks = usage?.tasks ?? data.tasks; const projects = usage?.projects ?? data.projects;
  const [expanded, setExpanded] = useState(!compact);
  const [period, setPeriod] = useState(0);
  const [tab, setTab] = useState<'activity' | 'models'>('activity');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null); const detail = useRef<HTMLElement>(null); const detailId = useId();
  useEffect(() => { if (selectedDate) detail.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [selectedDate]);
  const report = useMemo(() => buildUsageReport(tasks, { days: period }), [tasks, period]);
  const number = (value: number) => value.toLocaleString(data.preferences.language === 'zh' ? 'zh-CN' : 'en-US');
  const selected = report.days.find(day => day.date === selectedDate);
  const maxTokens = Math.max(1, ...report.days.map(day => day.tokens.total));
  const labels: [keyof Omit<TokenTotals, 'total'>, string][] = [['input', t('Input', '输入')], ['output', t('Output', '输出')], ['cacheRead', t('Cache read', '缓存读取')], ['cacheWrite', t('Cache write', '缓存写入')]];
  const breakdown = (tokens: TokenTotals, detail = false) => <dl className={`usage-breakdown ${detail ? 'detail-breakdown' : ''}`}>{labels.map(([key, label]) => <div key={key} className={`usage-part usage-part-${key}`}><dt><i aria-hidden="true" />{label}</dt><dd>{number(tokens[key])}</dd></div>)}</dl>;
  function closeDetail() { const date = selectedDate; setSelectedDate(null); grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`)?.focus(); }
  return <section className={`studio-usage ${compact ? 'is-compact' : ''} ${expanded ? 'is-expanded' : ''}`} aria-label={t('Token usage', 'Token 使用情况')}>
    <header className="usage-heading"><div><span className="code-tag" aria-hidden="true">LEDGER</span><h2>{t('Usage ledger', '用量记录')}</h2><p>{t('Every response leaves a trace.', '每次回复，都有据可查。')}</p></div>{compact && <button type="button" className="button small usage-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('Hide details', '收起明细') : t('View details', '查看明细')}</button>}<div className="usage-periods" aria-label={t('Usage time range', '用量统计时间范围')}>{[0, 30, 7].map(days => <button key={days} type="button" aria-pressed={period === days} onClick={() => { setPeriod(days); setSelectedDate(null); }}>{days ? `${days}${t('d', ' 天')}` : t('All time', '全部')}</button>)}</div></header>
    <div className="usage-summary"><div className="usage-total"><span>{t('Reported tokens', '已记录 Token')}</span><strong data-testid="usage-total">{number(report.tokens.total)}</strong><small>{number(report.sessions)} {t('conversations', '段会话')}<b aria-hidden="true">·</b>{number(report.messages)} {t('messages', '条消息')}</small></div>{breakdown(report.tokens)}</div>
    {report.tokens.total > 0 && <div className="usage-proportions" aria-label={t('Token composition', 'Token 组成')}>{labels.map(([key, label]) => <span key={key} className={`usage-part-${key}`} style={{ width: `${report.tokens[key] / report.tokens.total * 100}%` }} title={`${label}: ${number(report.tokens[key])} Tokens`} />)}</div>}
    {expanded && <div className="usage-tabs" role="tablist" aria-label={t('Usage view', '用量视图')}><button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>{t('Daily activity', '每日活动')}</button><button type="button" role="tab" aria-selected={tab === 'models'} onClick={() => setTab('models')}>{t('By model', '模型分布')}</button><span>{tab === 'activity' ? (period ? t('Select a day for details', '点选日期查看明细') : t('Last 20 weeks · select a day', '近 20 周 · 点选日期查看明细')) : t('From recorded responses', '按实际回复统计')}</span></div>}
    {tab === 'activity' || !expanded ? <><div className="usage-calendar"><div ref={grid} className={`usage-day-grid ${period ? 'usage-short-range' : ''}`} aria-label={t('Daily token activity', '每日 Token 活动')}>{report.days.map(day => {
      const level = day.tokens.total === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(day.tokens.total / maxTokens) * 4)));
      const description = `${day.date} · ${number(day.tokens.total)} Tokens · ${number(day.messages)} ${t('messages', '条消息')}`;
      return <button key={day.date} type="button" className="usage-day" data-date={day.date} data-level={level} data-active={day.messages > 0} data-selected={selectedDate === day.date} aria-label={description} aria-expanded={selectedDate === day.date} aria-controls={selectedDate === day.date ? detailId : undefined} disabled={day.future} title={description} onClick={() => setSelectedDate(day.date)}><span className="sr-only">{description}</span></button>;
    })}</div><div className="usage-calendar-footer"><span>{report.days[0]?.date}<span aria-hidden="true"> — </span>{report.days.findLast(day => !day.future)?.date}</span><span className="usage-legend">{t('Less', '少')}<i /><i /><i /><i />{t('More', '多')}</span></div></div>
      {selected && <section ref={detail} id={detailId} className="usage-day-detail" data-testid="usage-day-detail" aria-label={`${selected.date} ${t('token details', 'Token 明细')}`}><header><div><span>{selected.date}</span><h3><strong data-testid="daily-token-total">{number(selected.tokens.total)}</strong> Tokens</h3></div><IconButton label={t('Close day details', '关闭每日明细')} onClick={closeDetail}><X size={17} /></IconButton></header>{breakdown(selected.tokens, true)}<div className="usage-detail-meta">{number(selected.messages)} {t('messages', '条消息')}<span>·</span>{number(selected.tasks.length)} {t('conversations', '段会话')}{selected.unreported > 0 && <small>{number(selected.unreported)} {t('responses without usage data', '条回复未上报用量')}</small>}</div>{selected.tasks.length ? <div className="usage-day-tasks">{selected.tasks.map(task => <button type="button" key={task.id} onClick={event => tasks.find(item => item.id === task.id)?.card && openStudio ? openStudio(event.currentTarget) : navigate(task.id)}><span><strong>{task.title}</strong><small>{projects.find(project => project.id === task.projectId)?.name || t('Project unavailable', '项目不可用')}{tasks.find(item => item.id === task.id)?.card && ` · ${t('Card studio', '制卡工坊')}`}</small></span><span className="usage-task-tokens">{number(task.tokens.total)}<small>Tokens</small></span><ArrowUpRight size={16} /></button>)}</div> : <p className="usage-no-activity">{t('No messages recorded on this day.', '这一天没有已记录的消息。')}</p>}</section>}
    </> : <div className="usage-model-list">{report.models.length ? report.models.map(model => <div className="usage-model" key={JSON.stringify(model.model)}><div className="usage-model-title"><strong>{model.model || t('Model not reported', '未记录模型')}</strong><span>{number(model.responses)} {t('responses', '条回复')}{model.unreported > 0 && ` · ${number(model.unreported)} ${t('unreported', '条未上报用量')}`}</span></div><strong className="usage-model-total">{number(model.tokens.total)}<small>Tokens</small></strong>{breakdown(model.tokens, true)}</div>) : <div className="usage-empty"><ChevronRight size={18} /><p>{t('Model usage appears after the first response.', '第一条模型回复后，会在这里显示模型用量。')}</p></div>}</div>}
    <p className="usage-source-note">{t('Includes input, output, cache reads and cache writes reported by your gateway. Upstream reporting may vary.', '包含网关报告的输入、输出、缓存读取与缓存写入；不同上游的统计方式可能有所差异。')}{report.unreported > 0 && <span> {number(report.unreported)} {t('responses have no usage data; their tokens are not estimated.', '条回复未上报用量，未对其 Token 数作估算。')}</span>}</p>
  </section>;
}


