import { memo, useState } from 'react';
import { Archive, CalendarClock, ChevronRight, FolderPlus, GalleryVerticalEnd, MoreHorizontal, Moon, Pin, Plus, Search, Settings2, Sun, X } from 'lucide-react';
import type { Task } from '../shared/types';
import { sessionGroups } from '../shared/sessions';
import { statusText, useApp } from './context';
import { IconButton, Mark, MenuItem, Popover } from './primitives';
import { Avatar } from './Avatar';
import { isMenuKey, useNavActions } from './NavActions';
import { runIsOpen } from '../shared/card-studio/run';

interface Props {
  mode: 'code' | 'tasks' | 'settings';
  selectedId: string | null;
  onNewTask: (projectId?: string) => void;
  onMode: (mode: 'code' | 'tasks' | 'settings') => void;
  onStudio: (origin: HTMLElement) => void;
}

/** The left column (§6.3): conversations grouped by project, with the ways out of the workbench at the bottom. */
export const Sidebar = memo(function Sidebar({ mode, selectedId, onNewTask, onMode, onStudio }: Props) {
  const { data, api, t, run, navigate, settings } = useApp();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { openMenu, element } = useNavActions({ selectedId, onNewTask });
  const { groups, archived } = sessionGroups({ tasks: data.tasks, projects: data.projects, query });
  const theme = data.preferences.theme;
  const needsInput = (task: Task) => data.approvals.some(item => item.taskId === task.id) || data.interactions.some(item => item.taskId === task.id);
  const state = (task: Task) => task.truncation ? 'truncated' : task.status;
  // One-click making keeps going while the user is in the workbench (0.9 §5.1).
  const making = (data.cardStudio?.cards ?? []).map(card => card.run).filter(run => runIsOpen(run));
  const makingNote = !making.length ? undefined : making.some(run => run!.status !== 'paused') ? t('One-click making', '一键制作中') : t('One-click making paused', '一键制作已暂停');

  const row = (task: Task) => <div key={task.id} className={`session-row ${selectedId === task.id ? 'is-current' : ''}`}
    onContextMenu={event => { event.preventDefault(); openMenu({ kind: 'task', id: task.id }, event.currentTarget, { x: event.clientX, y: event.clientY }); }}>
    <button type="button" className="session-open" title={task.title} aria-label={task.title} aria-current={selectedId === task.id ? 'page' : undefined}
      aria-description={`${statusText(task.status, t)}${needsInput(task) ? ` · ${t('Needs your input', '需要你的回应')}` : ''}`}
      onClick={() => navigate(task.id)}
      onKeyDown={event => { if (isMenuKey(event)) { event.preventDefault(); openMenu({ kind: 'task', id: task.id }, event.currentTarget); } }}>
      {task.pinned && <Pin size={11} className="session-pin" aria-label={t('Pinned', '已置顶')} />}
      <span className="session-title">{task.title}</span>
      {needsInput(task) && <span className="session-alert" title={t('Needs your input', '需要你的回应')}>!</span>}
      <span className={`session-dot is-${state(task)}`} title={task.truncation ? t('Output truncated', '输出被截断') : statusText(task.status, t)} />
    </button>
    <IconButton className="session-menu" label={`${t('Conversation actions', '会话操作')} ${task.title}`} onClick={event => openMenu({ kind: 'task', id: task.id }, event.currentTarget)}><MoreHorizontal size={15} /></IconButton>
  </div>;

  return <aside className="desk-sidebar" aria-label={t('Conversations', '会话')}>
    <div className="sidebar-brand">
      <button type="button" className="sidebar-mark" aria-label={t('Cardwright home', 'Cardwright 主页')} onClick={() => navigate(null)}><Mark size={22} /></button>
      <span className="sidebar-wordmark">CARDWRIGHT</span>
      <IconButton label={theme === 'dark' ? t('Light theme', '浅色主题') : t('Dark theme', '深色主题')} onClick={() => void run(() => api.savePreferences({ theme: theme === 'dark' ? 'light' : 'dark' }))}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</IconButton>
    </div>
    <button type="button" className="sidebar-new" onClick={() => onNewTask()}><Plus size={16} /><span>{t('New task', '新建任务')}</span><kbd>Ctrl ⇧ O</kbd></button>
    <div className="sidebar-search">
      <Search size={14} />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search conversations…', '搜索任务…')} aria-label={t('Search conversations', '搜索任务')} />
      {query && <IconButton label={t('Clear search', '清除搜索')} onClick={() => setQuery('')}><X size={13} /></IconButton>}
    </div>
    <div className="sidebar-list">
      {!data.projects.filter(project => project.kind !== 'card').length && <div className="sidebar-empty">
        <p>{t('Add a folder to begin working with your local agent.', '添加一个文件夹，开始与本地 Agent 协作。')}</p>
        <button type="button" className="button small" onClick={() => void run(() => api.pickProject())}><FolderPlus size={15} />{t('Add a project', '添加项目')}</button>
      </div>}
      {groups.map(group => <section key={group.projectId} className="session-group">
        <button type="button" className="session-group-head" aria-expanded={!group.collapsed} aria-controls={`sessions-${group.projectId}`} title={group.path}
          onClick={() => void run(() => api.updateProject(group.projectId, { collapsed: !group.collapsed }))}
          onContextMenu={event => { event.preventDefault(); openMenu({ kind: 'project', id: group.projectId }, event.currentTarget, { x: event.clientX, y: event.clientY }); }}
          onKeyDown={event => { if (isMenuKey(event)) { event.preventDefault(); openMenu({ kind: 'project', id: group.projectId }, event.currentTarget); } }}>
          <ChevronRight size={13} className="session-chevron" />
          <span className="session-group-name">{group.name}</span>
          {group.pinned && <Pin size={10} />}
          <span className="session-group-count">{group.count}</span>
        </button>
        <div id={`sessions-${group.projectId}`} className={`session-group-body ${group.collapsed ? 'is-collapsed' : ''}`} inert={group.collapsed}>
          <div className="session-group-rows">
            {group.tasks.map(row)}
            {!group.tasks.length && <button type="button" className="session-start" onClick={() => onNewTask(group.projectId)}><Plus size={13} />{t('Start a task', '开始新任务')}</button>}
          </div>
        </div>
      </section>)}
      {archived.length > 0 && <section className="session-group session-archived">
        <button type="button" className="session-group-head" aria-expanded={showArchived} onClick={() => setShowArchived(value => !value)}>
          <ChevronRight size={13} className="session-chevron" />
          <span className="session-group-name">{t('Archived', '已归档')}</span>
          <span className="session-group-count">{archived.length}</span>
        </button>
        <div className={`session-group-body ${showArchived ? '' : 'is-collapsed'}`} inert={!showArchived}><div className="session-group-rows">{archived.map(row)}</div></div>
      </section>}
    </div>
    <nav className="sidebar-foot" aria-label={t('Elsewhere in Cardwright', 'Cardwright 的其他地方')}>
      <button type="button" onClick={event => onStudio(event.currentTarget)}><GalleryVerticalEnd size={15} /><span>{t('Card studio', '制卡工坊')}</span>{makingNote && <span className={`nav-note ${making.some(run => run!.status !== 'paused') ? 'is-running' : 'is-paused'}`} title={makingNote}><i aria-hidden="true" /><span>{makingNote}</span></span>}</button>
      <button type="button" className={mode === 'tasks' ? 'is-current' : ''} aria-current={mode === 'tasks' ? 'page' : undefined} onClick={() => onMode('tasks')}><CalendarClock size={15} /><span>{t('Agents & schedules', 'Agent 与计划')}</span></button>
      <button type="button" className={mode === 'settings' ? 'is-current' : ''} aria-current={mode === 'settings' ? 'page' : undefined} onClick={() => settings('general')}><Settings2 size={15} /><span>{t('Studio settings', '工作室设置')}</span></button>
      <Popover label={t('Account and settings', '个人偏好与设置')} className="sidebar-account" trigger={<><Avatar role="user" size={28} /><span className="sidebar-account-copy"><strong>{data.preferences.name || t('Your profile', '个人账户')}</strong><small>{t('Local workspace', '本地工作区')}</small></span></>}>{close => <>
        <MenuItem onClick={() => { settings('general'); close(); }}><Settings2 size={16} />{t('Profile & appearance', '头像与外观')}</MenuItem>
        <MenuItem onClick={() => { settings('code'); close(); }}><GalleryVerticalEnd size={16} />{t('Model gateways', '模型网关')}</MenuItem>
        <MenuItem onClick={() => { settings('export'); close(); }}><Archive size={16} />{t('Data & archived tasks', '数据与归档任务')}</MenuItem>
        <div className="menu-divider" /><div className="menu-footnote">Cardwright {data.version}</div>
      </>}</Popover>
    </nav>
    {element}
  </aside>;
});
