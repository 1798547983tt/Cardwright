import { createContext, useContext } from 'react';
import type { AppSnapshot, Bridge, Project, Task } from '../shared/types';
import type { PanelTab } from './SidePanel';

export type SettingsTab = 'general' | 'privacy' | 'usage' | 'code' | 'search' | 'schedules' | 'export' | 'desktop' | 'developer' | 'skills' | 'extensions' | 'workbench' | 'card-studio';
export interface AppContextValue {
  data: AppSnapshot;
  api: Bridge;
  t: (english: string, chinese: string) => string;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  settings: (tab?: SettingsTab) => void;
  navigate: (id: string | null) => void;
  notify: (message: string) => void;
  /** Enters the card studio; the transition grows from `origin`. Absent inside the studio. */
  openStudio?: (origin: HTMLElement | null) => void;
  /** What the slash commands need from the surrounding views: the task search, and a panel of the open task. */
  view?: (action: { kind: 'search' } | { kind: 'panel'; tab: PanelTab } | { kind: 'file'; path: string; line?: number; endLine?: number }) => void;
  /** Token usage counts every conversation, including the card conversations the workbench hides. */
  usage?: { tasks: Task[]; projects: Project[] };
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() { const value = useContext(AppContext); if (!value) throw new Error('App context is unavailable'); return value; }
export function shortNumber(n: number): string { return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n); }
export function statusText(status: string, t: AppContextValue['t']) {
  const zh: Record<string, string> = { idle: '待开始', queued: '排队中', running: '执行中', waiting: '等待审批', completed: '已完成', failed: '失败', cancelled: '已停止' };
  return t(status.charAt(0).toUpperCase() + status.slice(1), zh[status] || status);
}
