import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X, AlertCircle, LoaderCircle } from 'lucide-react';
import type { AppearanceSnapshot, AppSnapshot } from '../shared/types';
import { AppContext, type AppContextValue, type SettingsTab } from './context';
import { IconButton, Mark, Modal } from './primitives';
import { Home } from './Home';
import { Composer } from './Composer';
import { TaskView } from './TaskView';
import { Settings } from './Settings';
import { Schedules } from './Schedules';
import { Statusline } from './Statusline';
import { Sidebar } from './Sidebar';
import { SidePanel, type PanelState, type PanelTab } from './SidePanel';
export type ShellMode = 'code' | 'tasks' | 'settings';
import { BootSequence } from './BootSequence';
import { UpgradeNotice } from './Notices';
import { configureSound, installClickSounds, playCue } from './sound';
import { watchWindowActivity } from './window-activity';
import { preloadFonts } from './fonts';
import { applyAppUpdate, appUpdateRevision, type AppUpdate } from '../shared/app-updates';
import { workbenchSnapshot } from '../shared/card-studio/view';
import { CardStudio, type StudioTarget } from './card-studio/CardStudio';
import { StudioTransition, type TransitionDirection, type TransitionOrigin } from './card-studio/StudioTransition';
import { ErrorBoundary, SmokeFault, smokeFaults } from './ErrorBoundary';
import { setDiagnosticPage } from './diagnostics';
import { pageLabel } from '../shared/diagnostics';
import { ThemeEntrance, useThemeApplication } from './ThemeLayer';

// Navigation follows metadata, not streamed bodies, so rows do not re-render on every token.
const NavigationSurface = memo(function NavigationSurface({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
});

const rectOf = (element: HTMLElement | null): TransitionOrigin | null => { if (!element) return null; const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height }; };

export function App() {
  const api = window.cardwright;
  const [data, setData] = useState<AppSnapshot | null>(null);
  const [fatal, setFatal] = useState(''); const [toast, setToast] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(''); const [mode, setMode] = useState<ShellMode>('code');
  const [settingTab, setSettingTab] = useState<SettingsTab>('general');
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState(false); const [query, setQuery] = useState('');
  // The card studio is a separate mode: it starts closed on every launch and owns card projects and their conversations.
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTarget, setStudioTarget] = useState<StudioTarget | null>(null);
  const [transition, setTransition] = useState<{ id: number; direction: TransitionDirection; origin: TransitionOrigin | null } | null>(null);
  const transitioning = useRef(false); const studioOpenRef = useRef(false); studioOpenRef.current = studioOpen;
  const [bootMounted, setBootMounted] = useState(true);
  const latestData = useRef(data); latestData.current = data;
  const workbenchPrevious = useRef<AppSnapshot | null>(null);
  const workbench = useMemo(() => {
    if (!data) return null;
    const next = workbenchSnapshot(data, workbenchPrevious.current ?? undefined); workbenchPrevious.current = next; return next;
  }, [data]);
  const shell = useRef<HTMLDivElement>(null);
  // 主题包 and 桌宠 packs; refreshed when the theme or the pet setting changes, and after the settings page installs one.
  const [appearance, setAppearance] = useState<AppearanceSnapshot | null>(null);
  const refreshAppearance = useCallback(() => { void api?.appearance().then(setAppearance, () => undefined); }, [api]);
  useEffect(() => { refreshAppearance(); }, [refreshAppearance, data?.preferences.theme, data?.preferences.petEnabled]);
  const themePacks = useMemo(() => appearance?.themes ?? [], [appearance]);
  const theme = useThemeApplication(api, data?.preferences, themePacks);
  const appearanceContext = useMemo(() => ({ snapshot: appearance, refresh: refreshAppearance }), [appearance, refreshAppearance]);
  const t = useCallback((en: string, zh: string) => data?.preferences.language === 'zh' ? zh : en, [data?.preferences.language]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    let receivedLive = false;
    let applied = latestData.current;
    const acceptSnapshot = (snapshot: AppSnapshot) => {
      if (!alive || applied && (snapshot.publicationRevision ?? 0) <= (appUpdateRevision(applied) ?? -1)) return;
      applied = applyAppUpdate(null, { type: 'snapshot', snapshot, revision: snapshot.publicationRevision }); setData(applied);
    };
    const acceptUpdate = (update: AppUpdate) => {
      if (!alive) return;
      receivedLive = true;
      if (applied && update.revision !== undefined && update.revision <= (appUpdateRevision(applied) ?? -1)) return;
      try { applied = applyAppUpdate(applied, update); setData(applied); }
      catch { void api.snapshot().then(acceptSnapshot).catch(error => { if (alive) setFatal(String(error)); }); }
    };
    const unsubscribe = api.subscribeUpdates ? api.subscribeUpdates(acceptUpdate) : api.subscribe(s => { receivedLive = true; if (alive) { applied = s; setData(s); } });
    // A slow bootstrap response must never overwrite a newer live publication.
    void api.snapshot().then(s => { if (alive && !receivedLive) { if (api.subscribeUpdates) acceptSnapshot(s); else setData(s); } }).catch(e => { if (alive && !receivedLive) setFatal(String(e)); });
    return () => { alive = false; unsubscribe(); };
  }, [api]);
  useEffect(() => { void preloadFonts(); return watchWindowActivity(); }, []);
  // Without the startup animation the workbench is live as soon as the first snapshot arrives.
  useEffect(() => { if (data && data.preferences.bootSequence !== true && !live) { setLive(true); setBootMounted(false); } }, [data, live]);
  useEffect(() => { if (workbench && !projectId && workbench.projects.length) setProjectId(workbench.projects.find(project => project.kind !== 'card')?.id || ''); }, [workbench?.projects, projectId]);
  useEffect(() => {
    if (!data) return;
    const prefs = data.preferences;
    document.documentElement.lang = prefs.language === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.motion = prefs.reducedMotion ? 'reduced' : 'system';
    document.documentElement.dataset.font = prefs.font;
    configureSound({ enabled: prefs.soundEnabled, volume: prefs.soundVolume });
  }, [data?.preferences]);
  useEffect(() => { const root = shell.current; return root ? installClickSounds(root) : undefined; }, [!!data, studioOpen]);
  // Event cues compare consecutive snapshots: completion, new approvals and new truncations.
  const previous = useRef<AppSnapshot | null>(null);
  useEffect(() => {
    const before = previous.current; previous.current = data;
    if (!before || !data || !live) return;
    const old = new Map(before.tasks.map(task => [task.id, task]));
    if (data.tasks.some(task => task.truncation && !old.get(task.id)?.truncation)) playCue('truncated');
    else if (data.approvals.length > before.approvals.length || data.interactions.length > before.interactions.length) playCue('approval');
    else if (data.tasks.some(task => task.status === 'completed' && ['running', 'queued', 'waiting'].includes(old.get(task.id)?.status ?? ''))) playCue('complete');
  }, [data, live]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 7000); return () => clearTimeout(timer); }, [toast]);
  const run = useCallback(async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try { const result = await action(); if (success) setToast(success); return result; }
    catch (e) { setToast(e instanceof Error ? e.message : String(e)); return undefined; }
  }, []);
  const navigate = useCallback((id: string | null) => {
    setSelectedId(id); setMode('code');
    const task = latestData.current?.tasks.find(item => item.id === id);
    if (task) setProjectId(task.projectId);
  }, []);
  const settings = useCallback((tab: SettingsTab = 'general') => { setSettingTab(tab); setMode('settings'); }, []);
  const newTask = useCallback((id?: string) => { if (id) setProjectId(id); navigate(null); }, [navigate]);
  const openStudio = useCallback((origin: HTMLElement | null) => {
    if (transitioning.current || studioOpenRef.current) return;
    transitioning.current = true; setSearch(false);
    setTransition({ id: Date.now(), direction: 'in', origin: rectOf(origin) });
  }, []);
  const exitStudio = useCallback((origin: HTMLElement | null) => {
    if (transitioning.current || !studioOpenRef.current) return;
    transitioning.current = true;
    setTransition({ id: Date.now(), direction: 'out', origin: rectOf(origin) });
  }, []);
  const finishTransition = useCallback(() => { transitioning.current = false; setTransition(null); }, []);
  // Inside the studio, settings and workbench tasks leave the studio first.
  const studioSettings = useCallback((tab: SettingsTab = 'general') => { setSettingTab(tab); setMode('settings'); exitStudio(null); }, [exitStudio]);
  // The desk pet's click (ADR 0018): what it reported, a task in the workbench or a conversation or card in the studio.
  useEffect(() => api?.onOpen(target => {
    if (target.kind === 'task') { if (studioOpenRef.current) exitStudio(null); navigate(target.taskId); }
    else if (target.kind === 'card') {
      setStudioTarget({ projectId: target.projectId, sectionId: target.sectionId, conversation: target.taskId, at: Date.now() });
      if (!studioOpenRef.current) openStudio(null);
    }
  }), [api, navigate, openStudio, exitStudio]);
  const studioNavigate = useCallback((id: string | null) => { if (id && latestData.current?.tasks.find(task => task.id === id)?.card) return; navigate(id); exitStudio(null); }, [navigate, exitStudio]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (studioOpenRef.current || transitioning.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(current => !current); }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); settings('general'); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); navigate(null); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [navigate, settings]);
  const pageKey = `${mode}:${mode === 'code' ? selectedId ?? 'home' : mode === 'settings' ? settingTab : ''}`;
  // Where an error happened, for the diagnostics; the studio names its own pages while it is open.
  const workbenchPage = pageLabel({ area: 'workbench', mode, task: !!selectedId && !!workbench?.tasks.some(task => task.id === selectedId) });
  useEffect(() => { if (!studioOpen) setDiagnosticPage(workbenchPage); }, [studioOpen, workbenchPage]);
  const firstPage = useRef(true);
  useEffect(() => { if (firstPage.current) { firstPage.current = false; return; } if (live) playCue('page'); }, [pageKey]);
  // The side panel: the composer's commands and the conversation's 路径:行号 links both ask for it through the context.
  const [panel, setPanel] = useState<PanelState | null>(null);
  const view = useCallback((action: { kind: 'search' } | { kind: 'panel'; tab: PanelTab } | { kind: 'file'; path: string; line?: number; endLine?: number }) => {
    if (action.kind === 'search') { setSearch(true); return; }
    if (action.kind === 'panel') { setPanel(current => ({ panes: [action.tab, current?.panes[1] ?? null], target: current?.target })); return; }
    setPanel(current => ({ panes: ['files', current?.panes[1] ?? null], target: { path: action.path, line: action.line, endLine: action.endLine, at: Date.now() } }));
  }, []);
  // A page the agent opened, or a site it is asking about, has to be where the user can see it.
  const browserCall = `${data?.browser?.tabs.length ?? 0}:${data?.browser?.pending?.origin ?? ''}`;
  useEffect(() => {
    if (!data?.browser?.tabs.length && !data?.browser?.pending) return;
    setPanel(current => current?.panes.includes('browser') ? current : { panes: ['browser', current?.panes[1] ? current.panes[0] : null], target: current?.target });
  }, [browserCall]);
  const usage = useMemo(() => data ? { tasks: data.tasks, projects: data.projects } : undefined, [data?.tasks, data?.projects]);
  const context = useMemo(() => workbench && ({ data: workbench, api, t, run, settings, navigate, notify: setToast, openStudio, usage, view, appearance: appearanceContext }), [workbench, api, t, run, settings, navigate, openStudio, usage, view, appearanceContext]);
  const studioContext = useMemo(() => data && ({ data, api, t, run, settings: studioSettings, navigate: studioNavigate, notify: setToast }), [data, api, t, run, studioSettings, studioNavigate]);
  const navigationKey = workbench?.tasks.map(task => JSON.stringify([task.id, task.title, task.projectId, task.parentId, task.cwd, task.status, task.archived, task.pinned, !!task.truncation, task.updatedAt.slice(0, 16)])).join('\n');
  const navigationTasks = useMemo(() => workbench?.tasks, [navigationKey]);
  const navigationData = useMemo(() => workbench && ({ ...workbench, tasks: navigationTasks || [] }), [navigationTasks, workbench?.preferences, workbench?.projects, workbench?.approvals, workbench?.interactions, workbench?.version, workbench?.cardStudio]);
  const navigationContext = useMemo(() => navigationData && ({ data: navigationData, api, t, run, settings, navigate, notify: setToast, openStudio }), [navigationData, api, t, run, settings, navigate, openStudio]);
  const openSearch = useCallback(() => setSearch(true), []);
  if (!api) return <div className="startup"><Mark size={56} /><h1>Cardwright</h1><p>Open Cardwright as a desktop application to connect to your local agent workspace.</p><p>请启动 Cardwright 桌面应用，连接本地 Agent 工作区。</p></div>;
  if (!context || !data || !workbench || !studioContext || !navigationContext) return <div className="startup"><Mark size={56} /><h1>Cardwright</h1>{fatal ? <><p role="alert">{fatal}</p><button className="button" onClick={() => void api.window('reload').catch(() => location.reload())}>Retry / 重试</button></> : <><LoaderCircle size={22} className="spinning" /><p>Opening your workspace… / 正在打开工作区…</p></>}</div>;
  const selectedTask = workbench.tasks.find(task => task.id === selectedId);
  const searchTasks = search ? workbench.tasks.filter(task => !task.archived && task.title.toLowerCase().includes(query.toLowerCase())) : [];
  const reducedMotion = data.preferences.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const smoke = smokeFaults();
  const transitionLayer = transition && <StudioTransition key={transition.id} direction={transition.direction} origin={transition.origin} reduced={reducedMotion} language={data.preferences.language} onSwap={() => setStudioOpen(transition.direction === 'in')} onDone={finishTransition} />;
  const toastLayer = toast && <div className={`toast ${studioOpen ? 'studio-toast' : ''}`} role="status"><AlertCircle size={18} /><span>{toast}</span><IconButton label={t('Dismiss', '关闭')} onClick={() => setToast('')}><X size={16} /></IconButton></div>;
  const windowTitle = mode === 'settings' ? t('Studio settings', '工作室设置') : mode === 'tasks' ? t('Agents & schedules', 'Agent 与计划') : selectedTask?.title || t('Workspace', '工作台');
  // The transition and the toast stay outside both pages: swapping the page underneath them must not remount them,
  // or the 卷宗 animation starts over halfway through and the user sees it twice.
  const page = studioOpen
    ? <AppContext.Provider key="studio" value={studioContext}><CardStudio onExit={exitStudio} target={studioTarget} /></AppContext.Provider>
    : <AppContext.Provider key="workbench" value={context}><div ref={shell} className={`app-shell desk-shell ${live ? 'is-live' : ''} ${panel && selectedTask && mode === 'code' ? 'with-panel' : ''}`}>
    <div className="desk-titlebar">
      <span className="desk-titlebar-name">{windowTitle}</span>
      <div className="window-controls">
        <button type="button" aria-label={t('Minimize window', '最小化窗口')} onClick={() => void run(() => api.window('minimize'))}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" /></svg></button>
        <button type="button" aria-label={t('Maximize window', '最大化窗口')} onClick={() => void run(() => api.window('maximize'))}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5h9v9h-9z" fill="none" stroke="currentColor" /></svg></button>
        <button type="button" className="window-close" aria-label={t('Close to tray', '关闭到托盘')} title={t('Close to tray · schedules keep running', '关闭到托盘 · 计划继续运行')} onClick={() => void run(() => api.window('close'))}><X size={16} /></button>
      </div>
    </div>
    <NavigationSurface value={navigationContext}><Sidebar mode={mode} selectedId={selectedId} onNewTask={newTask} onMode={setMode} onStudio={openStudio} /></NavigationSurface>
    <main className="desk-main">
      {data.storageError && <div className="task-error" role="alert">{t('Changes could not be saved. Free disk space or export your data before closing.', '修改尚未保存。请释放磁盘空间或导出资料后再关闭。')}<small>{data.storageError}</small></div>}
      <UpgradeNotice />
      {workbench.interactions.some(interaction => interaction.taskId !== selectedId || mode !== 'code') && <div className="pending-interactions" role="status"><span>{t('Waiting for your input', '等待你的回应')}</span>{workbench.interactions.filter((interaction, index, all) => (interaction.taskId !== selectedId || mode !== 'code') && all.findIndex(item => item.taskId === interaction.taskId) === index).map(interaction => <button key={interaction.taskId} onClick={() => navigate(interaction.taskId)}>{workbench.tasks.find(task => task.id === interaction.taskId)?.title || t('Open task', '打开任务')}</button>)}</div>}
      <div className="page-enter workspace-page" key={pageKey}>
        <ErrorBoundary kind="workbench" page={workbenchPage} t={t} onBack={() => navigate(null)}>
          {mode === 'tasks' ? <Schedules projectId={projectId} />
            : mode === 'settings' ? <Settings initialTab={settingTab} onClose={() => setMode('code')} />
            : <><div className="workspace-body">{selectedTask ? <TaskView task={selectedTask} onPanel={tab => view({ kind: 'panel', tab })} /> : <Home />}</div><Composer key={selectedId || 'new'} task={selectedTask} projectId={projectId} setProjectId={setProjectId} /><Statusline task={selectedTask} /></>}
          {smoke && <SmokeFault where="workbench" />}
        </ErrorBoundary>
      </div>
    </main>
    {panel && selectedTask && mode === 'code' && <SidePanel task={selectedTask} state={panel} onState={setPanel} onClose={() => setPanel(null)} />}
    {search && <Modal title={t('Find a task', '查找任务')} onClose={() => setSearch(false)} className="search-modal"><div className="search-field"><Search size={20} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search task names…', '搜索任务名称…')} aria-label={t('Search tasks', '搜索任务')} /><kbd>Ctrl K</kbd></div><div className="search-results">{searchTasks.length ? searchTasks.map(task => <button key={task.id} onClick={() => { navigate(task.id); setSearch(false); }}><span className={`status-diamond ${task.truncation ? 'truncated' : task.status}`} /><div><strong>{task.title}</strong><small>{data.projects.find(p => p.id === task.projectId)?.name} · {new Date(task.updatedAt).toLocaleDateString()}</small></div></button>) : <p className="muted">{t('No matching tasks.', '没有匹配的任务。')}</p>}</div></Modal>}
    <ThemeEntrance theme={theme} reduced={reducedMotion} />
    {bootMounted && data.preferences.bootSequence === true && <BootSequence language={data.preferences.language} reducedMotion={data.preferences.reducedMotion} onDone={() => { setLive(true); setTimeout(() => setBootMounted(false), 600); }} />}
  </div></AppContext.Provider>;
  return <>{page}{toastLayer}{transitionLayer}{smoke && <SmokeFault where="app" />}</>;
}
