import { useMemo } from 'react';
import { ArrowUpRight, Folder, FolderGit2, FolderPlus, SlidersHorizontal } from 'lucide-react';
import { buildUsageReport } from '../shared/usage';
import { statusText, useApp } from './context';
import { UsagePanel } from './UsagePanel';
import { thinkingLabel } from './effort';
import { StudioEntry } from './card-studio/StudioEntry';

/** The home page: resume work first, then projects, then a compact usage ledger. Quiet since 0.9 (§6.5). */
export function Home({ compact = false }: { compact?: boolean }) {
  const { data, t, api, run, navigate, settings } = useApp();
  const recent = useMemo(() => buildUsageReport(data.tasks.filter(task => !task.archived && !task.parentId)).tasks.slice(0, 4), [data.tasks]);
  const locale = data.preferences.language === 'zh' ? 'zh-CN' : 'en-US';
  if (compact) return <UsagePanel />;
  const taskCount = (projectId: string) => data.tasks.filter(task => task.projectId === projectId && !task.archived && !task.parentId).length;
  return <div className="command-deck">
    <header className="deck-heading">
      <div><h1>{t('Your workspace', '工作台')}</h1><p>{data.preferences.name || t('Your', '你的')}{t('’s local workspace', '的本地工作空间')}<span aria-hidden="true"> / </span>{new Date().toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'short' })}</p></div>
      <button type="button" className="button" onClick={() => void run(() => api.pickProject())}><FolderPlus size={16} />{t('Add project', '添加项目')}</button>
    </header>

    <StudioEntry />

    <section className="deck-section" aria-label={t('Pick up where you left off', '继续上次的工作')}>
      <div className="deck-section-head"><h2>{t('Pick up where you left off', '继续上次的工作')}</h2></div>
      {recent.length ? <div className="resume-grid">{recent.map(item => {
        const task = data.tasks.find(entry => entry.id === item.id)!;
        const state = task.truncation ? 'truncated' : task.status;
        return <button type="button" key={item.id} className={`resume-card is-${state}`} onClick={() => navigate(item.id)}>
          <span className="resume-state"><span className={`status-diamond ${state}`} />{task.truncation ? t('Output truncated', '输出被截断') : statusText(task.status, t)}</span>
          <strong>{item.title}</strong>
          <small>{data.projects.find(project => project.id === item.projectId)?.name} · {new Date(item.lastMessageAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</small>
          <span className="resume-model">{task.modelId}{task.thinking !== 'off' && ` · ${thinkingLabel(task.thinking, t)}`}</span>
          <ArrowUpRight size={16} className="resume-arrow" />
        </button>;
      })}</div> : <div className="deck-empty"><p>{t('Your conversations will appear here. Describe a task below to get started.', '会话将出现在这里。在下方描述任务，即可开始。')}</p>{!data.gateways.length && <button type="button" className="button small" onClick={() => settings('code')}><SlidersHorizontal size={15} />{t('Connect a model', '连接模型')}</button>}</div>}
    </section>

    <section className="deck-section" aria-label={t('Projects', '项目')}>
      <div className="deck-section-head"><h2>{t('Projects', '项目')}</h2><span className="deck-count">{data.projects.length.toLocaleString(locale)}</span></div>
      {data.projects.length ? <div className="project-cards">{data.projects.map(project => <button type="button" key={project.id} className="project-card" onClick={() => void run(() => api.openPath(project.path))} title={project.path} aria-label={`${t('Open project folder', '打开项目文件夹')} ${project.name}`}>
        <span className="project-card-icon">{project.isGit ? <FolderGit2 size={18} /> : <Folder size={18} />}</span>
        <span className="project-card-copy"><strong>{project.name}</strong><small>{project.isGit ? t('Git project', 'Git 项目') : t('Local folder', '本地文件夹')} · {taskCount(project.id)} {t('tasks', '个任务')}</small></span>
        <ArrowUpRight size={15} />
      </button>)}</div> : <div className="deck-empty"><Folder size={20} /><p>{t('Choose a folder. Give your next idea a place to take shape.', '添加一个文件夹，让下一项工作从这里开始。')}</p></div>}
    </section>

    <UsagePanel compact />
  </div>;
}
