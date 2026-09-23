import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Copy, Minus, X } from 'lucide-react';
import { useApp } from '../context';
import { installClickSounds } from '../sound';
import { findBoard, sectionLabel } from '../../shared/card-studio/boards';
import { pageLabel } from '../../shared/diagnostics';
import { setDiagnosticPage } from '../diagnostics';
import { ErrorBoundary, SmokeFault, smokeFaults } from '../ErrorBoundary';
import type { CardProjectView } from '../../shared/card-studio/types';
import { Library } from './Library';
import { ProjectHome } from './ProjectHome';
import { SectionPage } from './SectionPage';

export type StudioView = { page: 'library' } | { page: 'project'; projectId: string } | { page: 'section'; projectId: string; sectionId: string; conversation?: string };
/** An unsent new conversation. Dispatches and handoff summaries only ever land here; the user presses Send. */
export interface Draft { title: string; text: string; dispatchId?: string; /** The conversation whose handoff summary this draft carries. */ handoffFrom?: string }
export const DEFAULT_LIGHT = '#b0915c';

interface StudioNavigation {
  view: StudioView;
  openLibrary(): void;
  openProject(projectId: string): void;
  openSection(projectId: string, sectionId: string, conversation?: string): void;
  draft(projectId: string, sectionId: string): Draft | undefined;
  startDraft(projectId: string, sectionId: string, draft: Draft): void;
  updateDraft(projectId: string, sectionId: string, text: string): void;
  clearDraft(projectId: string, sectionId: string): void;
  composerText(taskId: string): string;
  setComposerText(taskId: string, text: string): void;
  preview(color: string | null): void;
}

const StudioContext = createContext<StudioNavigation | null>(null);
export function useStudio(): StudioNavigation {
  const value = useContext(StudioContext);
  if (!value) throw new Error('Card studio context is unavailable');
  return value;
}

/** Where the desk pet asks the studio to go (ADR 0018): a section's conversation, or the card's home. */
export interface StudioTarget { projectId: string; sectionId?: string; conversation?: string; at: number }

export function CardStudio({ onExit, target }: { onExit: (origin: HTMLElement | null) => void; target?: StudioTarget | null }) {
  const { data, api, t, run, notify } = useApp();
  const [view, setView] = useState<StudioView>({ page: 'library' });
  const currentView = useRef(view); currentView.current = view;
  const handedOver = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [previewColor, setPreviewColor] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cards = data.cardStudio?.cards ?? [];
  useEffect(() => (root.current ? installClickSounds(root.current) : undefined), []);
  useEffect(() => { if (view.page !== 'library' && !cards.some(card => card.projectId === view.projectId)) setView({ page: 'library' }); }, [cards, view]);
  useEffect(() => { setPreviewColor(null); }, [view]);
  // The desk pet opens the conversation it reported, or the card it is making.
  useEffect(() => {
    if (!target) return;
    setView(target.sectionId && findBoard(target.sectionId) ? { page: 'section', projectId: target.projectId, sectionId: target.sectionId, conversation: target.conversation } : { page: 'project', projectId: target.projectId });
  }, [target]);

  const key = (projectId: string, sectionId: string) => `${projectId}:${sectionId}`;
  // §5.2: a handoff summary the app asked for becomes the draft of a new conversation in the same section. It stays a
  // draft until sent, and the old conversation is marked consumed only then, so leaving the studio does not lose it.
  useEffect(() => {
    for (const task of data.tasks) {
      const handoff = task.card?.handoff;
      // One-click making sends the summaries it asked for itself.
      if (handoff?.status !== 'ready' || !handoff.summary || handoff.auto || handedOver.current.has(task.id)) continue;
      handedOver.current.add(task.id);
      const sectionId = task.card!.sectionId;
      setDrafts(current => ({ ...current, [key(task.projectId, sectionId)]: { title: t('Continued with handoff', '带交接的新对话'), text: handoff.summary!, handoffFrom: task.id } }));
      const view = currentView.current;
      if (view.page === 'section' && view.projectId === task.projectId && view.sectionId === sectionId && (!view.conversation || view.conversation === task.id)) setView({ page: 'section', projectId: task.projectId, sectionId, conversation: 'draft' });
      else notify(t(`The handoff summary is ready as a new conversation draft in ${sectionLabel(sectionId)}.`, `交接摘要已写好，「${sectionLabel(sectionId)}」的新对话草稿已填好，确认后按发送。`));
    }
  }, [data.tasks]);
  const draft = useCallback((projectId: string, sectionId: string) => drafts[key(projectId, sectionId)], [drafts]);
  const composerText = useCallback((taskId: string) => texts[taskId] ?? '', [texts]);
  const navigation = useMemo<StudioNavigation>(() => ({
    view, draft, composerText,
    openLibrary: () => setView({ page: 'library' }),
    openProject: projectId => { setView({ page: 'project', projectId }); void api.refreshCardProject(projectId).catch(() => undefined); },
    // A section id from card data that no board has (a hand-edited dispatch, a newer version's section) opens the project home.
    openSection: (projectId, sectionId, conversation) => setView(findBoard(sectionId) ? { page: 'section', projectId, sectionId, conversation } : { page: 'project', projectId }),
    startDraft: (projectId, sectionId, value) => setDrafts(current => ({ ...current, [key(projectId, sectionId)]: value })),
    updateDraft: (projectId, sectionId, text) => setDrafts(current => { const existing = current[key(projectId, sectionId)]; return existing ? { ...current, [key(projectId, sectionId)]: { ...existing, text } } : current; }),
    clearDraft: (projectId, sectionId) => setDrafts(current => { const next = { ...current }; delete next[key(projectId, sectionId)]; return next; }),
    setComposerText: (taskId, text) => setTexts(current => ({ ...current, [taskId]: text })),
    preview: color => setPreviewColor(color),
  }), [view, draft, composerText, api]);

  const card: CardProjectView | undefined = view.page === 'library' ? undefined : cards.find(item => item.projectId === view.projectId);
  const light = previewColor ?? (view.page === 'section' ? findBoard(view.sectionId)?.color ?? DEFAULT_LIGHT : DEFAULT_LIGHT);
  const pageKey = view.page === 'library' ? 'library' : view.page === 'project' ? `project:${view.projectId}` : `section:${view.projectId}:${view.sectionId}`;
  // The page as the diagnostics name it: 「制卡工坊 · 拼装」, never the card's name.
  const page = pageLabel(view.page === 'library' || !card ? { area: 'studio', page: 'library' } : view.page === 'project' ? { area: 'studio', page: 'project' } : { area: 'studio', page: 'section', sectionId: view.sectionId });
  useEffect(() => { setDiagnosticPage(page); }, [page]);
  const smoke = smokeFaults();
  return <StudioContext.Provider value={navigation}>
    {/* A theme with its own accent tints the board light a little; without one the mix is the board colour itself. */}
    <div ref={root} className="card-studio" style={{ '--board': `color-mix(in srgb, ${light} 72%, var(--theme-accent, ${light}))` } as CSSProperties}>
      <header className="cs-top">
        <span className="cs-mark" aria-hidden="true"><i /></span>
        <span className="cs-brand">{t('Card studio', '制卡工坊')}<small>CARD STUDIO</small></span>
        <nav className="cs-crumbs" aria-label={t('Location', '位置')}>
          {view.page === 'library' ? <b aria-current="page">{t('Card library', '卡库')}</b> : <button type="button" onClick={() => setView({ page: 'library' })}>{t('Card library', '卡库')}</button>}
          {card && <><i aria-hidden="true">／</i>{view.page === 'project' ? <b aria-current="page">{card.name}</b> : <button type="button" onClick={() => navigation.openProject(card.projectId)}>{card.name}</button>}</>}
          {card && view.page === 'section' && <><i aria-hidden="true">／</i><b aria-current="page">{sectionLabel(view.sectionId)}</b></>}
        </nav>
        <button type="button" className="cs-exit" onClick={event => onExit(event.currentTarget)}><ArrowLeft size={14} />{t('Back to workspace', '返回工作台')}</button>
        <span className="cs-window">
          <button type="button" aria-label={t('Minimize', '最小化')} onClick={() => void run(() => api.window('minimize'))}><Minus size={15} /></button>
          <button type="button" aria-label={t('Maximize', '最大化')} onClick={() => void run(() => api.window('maximize'))}><Copy size={12} /></button>
          <button type="button" className="is-close" aria-label={t('Close', '关闭')} onClick={() => void run(() => api.window('close'))}><X size={15} /></button>
        </span>
      </header>
      <div className="cs-page" key={pageKey}>
        {/* A page that fails shows its error card here; the top bar with 返回工作台 stays usable. */}
        <ErrorBoundary kind="studio" page={page} t={t} onBack={navigation.openLibrary}>
          {view.page === 'library' || !card ? <Library />
            : view.page === 'project' ? <ProjectHome card={card} />
            : <SectionPage card={card} sectionId={view.sectionId} conversation={view.conversation} />}
          {smoke && <SmokeFault where="studio" />}
        </ErrorBoundary>
      </div>
    </div>
  </StudioContext.Provider>;
}
