import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionGroups } from '../src/shared/sessions.ts';
import type { Project, Task } from '../src/shared/types.ts';

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({ id, name, path: `E:/${name}`, isGit: false, createdAt: '2026-09-01T00:00:00.000Z', ...extra });
const task = (id: string, projectId: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, projectId, title, cwd: 'E:/x', status: 'completed', permission: 'ask', gatewayId: 'g', thinking: 'medium',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messages: [], tools: [], ...extra,
});

const projects = [project('p1', 'cardwright'), project('p2', 'my-website', { pinned: true }), project('c1', '西游·卡', { kind: 'card' })];
const tasks = [
  task('t1', 'p1', '修复 harness 子代理权限检查', { updatedAt: '2026-09-19T10:00:00.000Z', pinned: true }),
  task('t2', 'p1', '重构 git.ts 的 worktree 逻辑', { updatedAt: '2026-09-19T11:00:00.000Z' }),
  task('t3', 'p1', '已经归档的任务', { archived: true }),
  task('t4', 'p2', '首页响应式布局', { updatedAt: '2026-09-19T09:00:00.000Z' }),
  task('t5', 'p1', '子任务不在列表里', { parentId: 't2' }),
  task('t6', 'c1', '制卡对话', { card: { sectionId: 'plan' } }),
];

test('sessions are grouped by project, pinned first, with the card studio left out', () => {
  const { groups, archived } = sessionGroups({ tasks, projects });
  assert.deepEqual(groups.map(group => group.name), ['my-website', 'cardwright'], 'a pinned project comes first');
  assert.deepEqual(groups[1].tasks.map(item => item.id), ['t1', 't2'], 'a pinned task comes before a newer one');
  assert.deepEqual(groups[1].count, 2);
  assert.deepEqual(archived.map(item => item.id), ['t3']);
  assert.equal(groups.some(group => group.projectId === 'c1'), false, 'card projects belong to the studio');
});

test('a search filters the tasks and drops the groups with nothing in them', () => {
  const { groups } = sessionGroups({ tasks, projects, query: 'worktree' });
  assert.deepEqual(groups.map(group => group.tasks.map(item => item.id)), [['t2']]);
  assert.deepEqual(sessionGroups({ tasks, projects, query: '布局' }).groups.map(group => group.name), ['my-website']);
  assert.deepEqual(sessionGroups({ tasks, projects, query: 'CARDWRIGHT' }).groups.map(group => group.name), ['cardwright'], 'the project name counts too');
  assert.deepEqual(sessionGroups({ tasks, projects, query: '找不到' }).groups, []);
  // An archived task only shows up in a search when it matches.
  assert.deepEqual(sessionGroups({ tasks, projects, query: '归档' }).archived.map(item => item.id), ['t3']);
});

test('a project with no tasks keeps its place so a task can be started there', () => {
  const { groups } = sessionGroups({ tasks: [], projects });
  assert.deepEqual(groups.map(group => [group.name, group.count]), [['my-website', 0], ['cardwright', 0]]);
});
