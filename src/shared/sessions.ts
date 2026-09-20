import type { Project, Task } from './types.ts';

/** One project's conversations in the sidebar (§6.3): pinned first, then the most recent. */
export interface SessionGroup { projectId: string; name: string; path: string; pinned: boolean; collapsed: boolean; count: number; tasks: Task[] }

/**
 * What the sidebar lists: top-level conversations grouped by project, archived ones apart, card projects left to the
 * studio. A search matches the task title or its project's name, and empty groups drop out while searching.
 */
export function sessionGroups(input: { tasks: readonly Task[]; projects: readonly Project[]; query?: string }): { groups: SessionGroup[]; archived: Task[] } {
  const query = (input.query ?? '').trim().toLocaleLowerCase();
  const projects = input.projects.filter(project => project.kind !== 'card')
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name));
  const own = input.tasks.filter(task => !task.parentId && !task.card && projects.some(project => project.id === task.projectId));
  const matches = (task: Task, project: Project) => !query || task.title.toLocaleLowerCase().includes(query) || project.name.toLocaleLowerCase().includes(query);
  const groups: SessionGroup[] = [];
  const archived: Task[] = [];
  for (const project of projects) {
    const mine = own.filter(task => task.projectId === project.id && matches(task, project));
    archived.push(...mine.filter(task => task.archived));
    const tasks = mine.filter(task => !task.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    if (query && !tasks.length) continue;
    groups.push({ projectId: project.id, name: project.name, path: project.path, pinned: !!project.pinned, collapsed: !!project.collapsed, count: tasks.length, tasks });
  }
  archived.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { groups, archived };
}
