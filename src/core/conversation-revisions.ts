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

export interface Withdrawal { text: string; turnId: string; dispatchIds: string[] }

/** Only the latest message that went out can be withdrawn; messages still queued behind it come back with it. */
export function assertWithdrawable(task: Task, userMessageId: string): void {
  const index = task.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (index < 0) throw new Error('找不到这条消息。');
  if (task.messages.slice(index + 1).some(item => item.role === 'user' && !item.pending)) throw new Error('只能撤回最后发出的那条消息。');
}

/**
 * 撤回 (Q16): the message and everything after it leave the conversation, and the next run continues from before it.
 * The caller checks assertWithdrawable and stops the run first (stopping marks queued messages as no longer pending);
 * files are not touched, the turn's checkpoint stays for 撤销本轮.
 */
export function withdrawTurn(task: Task, userMessageId: string): Withdrawal {
  const index = task.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (index < 0) throw new Error('找不到这条消息。');
  const message = task.messages[index];
  const withdrawn = task.messages.slice(index).filter(item => item.role === 'user');
  task.messages = task.messages.slice(0, index);
  const kept = new Set(task.messages.filter(item => item.role === 'user').map(item => item.turnId || item.id));
  task.tools = task.tools.filter(tool => tool.turnId ? kept.has(tool.turnId) : tool.at < message.at);
  if (task.chapters) task.chapters = task.chapters.filter(chapter => kept.has(chapter.turnId));
  // A message that reached the session is cut off there; one that never did has nothing to cut.
  if (message.sessionEntryId) task.branchBeforeEntryId = message.sessionEntryId;
  task.runtimeStatus = {}; task.contextUsage = undefined; task.contextCompacting = false; task.error = undefined; task.truncation = undefined;
  task.status = task.messages.length ? 'completed' : 'idle';
  return { text: withdrawn.map(item => item.text).join('\n\n'), turnId: message.turnId || message.id, dispatchIds: withdrawn.flatMap(item => item.dispatchId ? [item.dispatchId] : []) };
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
