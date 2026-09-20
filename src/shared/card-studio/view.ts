import type { AppSnapshot, Task, ToolCall } from '../types.ts';
import { componentName } from './components.ts';
import type { ProgressInput } from './progress.ts';
import type { CardDispatch, CardProjectView } from './types.ts';

/** Small, pure helpers for the card studio pages. */
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** How wide a card name runs, in CJK character widths; Latin letters, digits and punctuation count about half. */
export function titleUnits(name: string): number {
  let units = 0;
  for (const char of name) units += char.codePointAt(0)! < 0x250 ? 0.55 : 1;
  return units;
}

/** Text covers step long names down: 1 is the full size, 2 and 3 are smaller. */
export function coverFit(name: string): 1 | 2 | 3 {
  const units = titleUnits(name);
  return units <= 12 ? 1 : units <= 24 ? 2 : 3;
}

export function relativeTime(iso: string, now: Date, language: 'zh' | 'en'): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  const zh = language === 'zh';
  if (seconds < 60) return zh ? '刚刚' : 'just now';
  if (seconds < 3600) { const minutes = Math.floor(seconds / 60); return zh ? `${minutes} 分钟前` : `${minutes} min ago`; }
  if (dayKey(then) === dayKey(now)) { const hours = Math.floor(seconds / 3600); return zh ? `${hours} 小时前` : `${hours} h ago`; }
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const clock = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
  if (dayKey(then) === dayKey(yesterday)) return zh ? `昨天 ${clock}` : `Yesterday ${clock}`;
  if (zh) return then.getFullYear() === now.getFullYear() ? `${then.getMonth() + 1}月${then.getDate()}日` : `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** A tool path relative to the card project with `/` separators, or null when it points outside. */
export function projectRelativePath(root: string, path: string): string | null {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/');
  const base = normalize(root).replace(/\/$/, '');
  let target = normalize(path.trim());
  if (/^[a-zA-Z]:\//.test(target) || target.startsWith('/')) {
    if (target.toLowerCase() === base.toLowerCase()) return '';
    if (!target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null;
    target = target.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

export interface TurnWrite { name: string; op: 'write' | 'edit'; paths: string[]; patch?: string; preview?: string }

/** 本轮写入: completed write/edit tool calls of one turn inside the card project, grouped by component. */
export function turnWrites(tools: ToolCall[], turnId: string, root: string): TurnWrite[] {
  const groups = new Map<string, TurnWrite>();
  for (const tool of tools) {
    if (tool.turnId !== turnId || tool.status !== 'completed' || (tool.name !== 'write' && tool.name !== 'edit')) continue;
    const relative = projectRelativePath(root, String(tool.args.path ?? ''));
    if (!relative) continue;
    const name = componentName(relative);
    const group = groups.get(name) ?? { name, op: tool.name, paths: [] };
    if (tool.name === 'edit') group.op = 'edit';
    if (!group.paths.includes(relative)) group.paths.push(relative);
    if (tool.patch) group.patch = tool.patch;
    if (tool.name === 'write' && typeof tool.args.content === 'string') group.preview = tool.args.content.split('\n').slice(0, 8).join('\n').slice(0, 600);
    groups.set(name, group);
  }
  return [...groups.values()];
}

export function conversationsOf(tasks: Task[], projectId: string, sectionId: string): Task[] {
  return tasks.filter(task => task.projectId === projectId && task.card?.sectionId === sectionId && !task.card.member && !task.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Only one conversation runs per card at a time; this is the one, if any. */
export function runningConversation(tasks: Task[], projectId: string): Task | undefined {
  return tasks.find(task => task.projectId === projectId && task.card && !task.card.member && (ACTIVE.has(task.status) || task.workerActive));
}

export function progressInputOf(view: CardProjectView, tasks: Task[]): ProgressInput {
  return { dispatches: view.dispatches, designExists: view.design.exists, planStarted: tasks.some(task => task.projectId === view.projectId && task.card?.sectionId === 'plan'), sources: view.sources, origin: view.origin };
}

/** The dispatch that 标记完成 applies to: the conversation's own active dispatch, else the section's first active one. */
export function markableDispatch(view: CardProjectView, sectionId: string, task?: Task): CardDispatch | undefined {
  const own = task?.card?.dispatchId ? view.dispatches.find(item => item.id === task.card!.dispatchId && item.status === 'active') : undefined;
  return own ?? view.dispatches.find(item => item.sectionId === sectionId && item.status === 'active');
}

/** 去下一条派单 and /下一步: the first dispatch not yet sent, in the order planning wrote them, whose section is known. */
export function nextDispatch(view: CardProjectView): CardDispatch | undefined {
  return view.dispatches.find(item => item.status === 'todo' && item.sectionId);
}

/** Whether the dispatch this conversation works on is marked done; then it offers the next dispatch instead of a new conversation. */
export function dispatchDone(view: CardProjectView, task: Task): boolean {
  const id = task.card?.dispatchId;
  return !!id && view.dispatches.some(item => item.id === id && item.status === 'done');
}

const sameItems = <T>(next: T[], previous: T[] | undefined): T[] => previous && previous.length === next.length && next.every((item, index) => item === previous[index]) ? previous : next;

/**
 * What the ordinary workbench sees: card projects, their conversations and the approvals and questions of those
 * conversations stay in the card studio. Unchanged lists keep their identity so card activity does not re-render the workbench.
 */
export function workbenchSnapshot(snapshot: AppSnapshot, previous?: AppSnapshot): AppSnapshot {
  const cardProjects = new Set(snapshot.projects.filter(project => project.kind === 'card').map(project => project.id));
  const cardTasks = new Set(snapshot.tasks.filter(task => task.card || cardProjects.has(task.projectId)).map(task => task.id));
  if (!cardProjects.size && !cardTasks.size) return snapshot;
  return {
    ...snapshot,
    projects: sameItems(snapshot.projects.filter(project => !cardProjects.has(project.id)), previous?.projects),
    tasks: sameItems(snapshot.tasks.filter(task => !cardTasks.has(task.id)), previous?.tasks),
    approvals: sameItems(snapshot.approvals.filter(approval => !cardTasks.has(approval.taskId)), previous?.approvals),
    interactions: sameItems(snapshot.interactions.filter(interaction => !cardTasks.has(interaction.taskId)), previous?.interactions),
  };
}
