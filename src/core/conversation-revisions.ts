import { randomUUID } from 'node:crypto';
import type { Task, TaskRevision } from '../shared/types.ts';

export function saveCurrentRevision(task: Task): TaskRevision {
  task.activeRevisionId ||= 'initial';
  const value: TaskRevision = structuredClone({ id: task.activeRevisionId, label: task.activeRevisionId === 'initial' ? 'Original' : `Version ${(task.revisions?.length || 0) + 1}`, createdAt: task.updatedAt,
    messages: task.messages, tools: task.tools, sessionFile: task.sessionFile, sessionLeafId: task.sessionLeafId, todos: task.todos, plan: task.plan, compactions: task.compactions });
  task.revisions = [...(task.revisions || []).filter(item => item.id !== value.id), value];
  return value;
}

export function startRevision(task: Task, userMessageId: string): string {
  const index = task.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (index < 0) throw new Error('Select a user message from this conversation.');
  const message = task.messages[index];
  if (!message.sessionEntryId || !task.sessionFile) throw new Error('This older message has no verified session cursor. Continue with a new message first.');
  saveCurrentRevision(task);
  task.activeRevisionId = randomUUID();
  task.messages = task.messages.slice(0, index);
  const allowedTurns = new Set(task.messages.filter(m => m.role === 'user').map(m => m.turnId || m.id));
  task.tools = task.tools.filter(tool => tool.turnId ? allowedTurns.has(tool.turnId) : tool.at < message.at);
  task.branchBeforeEntryId = message.sessionEntryId;
  task.todos = []; task.plan = undefined; task.runtimeStatus = {}; task.contextUsage = undefined; task.contextCompacting = false; task.error = undefined; task.status = 'idle';
  return message.text;
}

export function selectRevision(task: Task, id: string): void {
  if (id === (task.activeRevisionId || 'initial')) return;
  const chosen = task.revisions?.find(revision => revision.id === id);
  if (!chosen) throw new Error('Conversation version not found.');
  const next = structuredClone(chosen);
  task.contextUsage = undefined; task.contextCompacting = false;
  saveCurrentRevision(task);
  task.revisions = task.revisions!.filter(revision => revision.id !== id);
  Object.assign(task, { activeRevisionId: next.id, messages: next.messages, tools: next.tools, sessionFile: next.sessionFile, sessionLeafId: next.sessionLeafId, todos: next.todos, plan: next.plan, compactions: next.compactions, error: undefined, branchBeforeEntryId: undefined, runtimeStatus: {}, status: 'completed' });
}
