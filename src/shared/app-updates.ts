import type { AppSnapshot, ChatMessage, Task, ToolCall } from './types.ts';

export interface FieldUpdate {
  set?: Record<string, unknown>;
  unset?: string[];
  append?: Record<string, { length: number; text: string }>;
}
export interface RecordUpdate<T extends { id: string }> {
  added?: T[];
  changed?: Array<{ id: string; fields: FieldUpdate }>;
  removed?: string[];
  order?: string[];
}
export interface TaskUpdate {
  id: string;
  replacement?: Task;
  fields?: FieldUpdate;
  messages?: RecordUpdate<ChatMessage>;
  tools?: RecordUpdate<ToolCall>;
}
export type AppUpdate = {
  type: 'snapshot'; revision?: number; snapshot: AppSnapshot;
} | {
  type: 'patch'; revision?: number; baseRevision?: number; fields?: FieldUpdate;
  tasks?: { added?: Task[]; changed?: TaskUpdate[]; removed?: string[]; order?: string[] };
};

const revisions = new WeakMap<AppSnapshot, number>();
const taskLists = new Set(['messages', 'tools']);
const snapshotLists = new Set(['tasks']);
const appendFields = new Set(['text', 'thinking', 'output']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Structural equality without serializing large message strings. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

function fields(previous: object, next: object, omit = new Set<string>()): FieldUpdate | undefined {
  const a = previous as Record<string, unknown>; const b = next as Record<string, unknown>;
  const result: FieldUpdate = {};
  for (const key of Object.keys(a)) if (!omit.has(key) && !unsafeKeys.has(key) && !Object.hasOwn(b, key)) (result.unset ??= []).push(key);
  for (const key of Object.keys(b)) {
    if (omit.has(key) || unsafeKeys.has(key) || equal(a[key], b[key])) continue;
    if (appendFields.has(key) && typeof a[key] === 'string' && typeof b[key] === 'string' && b[key].startsWith(a[key])) {
      (result.append ??= {})[key] = { length: a[key].length, text: b[key].slice(a[key].length) };
    } else if (b[key] === undefined) (result.unset ??= []).push(key);
    else (result.set ??= {})[key] = structuredClone(b[key]);
  }
  return Object.keys(result).length ? result : undefined;
}

function ids<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) { if (map.has(item.id)) throw new Error('Duplicate snapshot record ID.'); map.set(item.id, item); }
  return map;
}

function orderChanged(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length !== b.length || a.some((item, index) => item.id !== b[index].id);
}

function records<T extends { id: string }>(previous: readonly T[], next: readonly T[]): RecordUpdate<T> | undefined {
  if (previous === next) return undefined;
  const old = ids(previous); const current = ids(next);
  const result: RecordUpdate<T> = {};
  for (const item of next) {
    const before = old.get(item.id);
    if (!before) (result.added ??= []).push(structuredClone(item));
    else { const patch = fields(before, item); if (patch) (result.changed ??= []).push({ id: item.id, fields: patch }); }
  }
  for (const id of old.keys()) if (!current.has(id)) (result.removed ??= []).push(id);
  if (orderChanged(previous, next)) result.order = next.map(item => item.id);
  return Object.keys(result).length ? result : undefined;
}

/** A history replacement is rare and must be delivered atomically, including old versions. */
function replacedHistory(before: Task, next: Task): boolean {
  return before.activeRevisionId !== next.activeRevisionId || before.sessionFile !== next.sessionFile
    || before.messages.length > next.messages.length || before.tools.length > next.tools.length
    || before.messages.some((message, index) => message.id !== next.messages[index]?.id)
    || before.tools.some((tool, index) => tool.id !== next.tools[index]?.id);
}

/** next may be a transient live view. The returned payload owns all changed values. */
export function createAppUpdate(previous: AppSnapshot | null | undefined, next: AppSnapshot, revision?: number): AppUpdate {
  if (!previous) return { type: 'snapshot', revision, snapshot: structuredClone(next) };
  const update: Extract<AppUpdate, { type: 'patch' }> = { type: 'patch', ...(revision === undefined ? {} : { revision, baseRevision: revision - 1 }) };
  const common = fields(previous, next, snapshotLists); if (common) update.fields = common;
  const old = ids(previous.tasks); const current = ids(next.tasks);
  const tasks: NonNullable<typeof update.tasks> = {};
  for (const task of next.tasks) {
    const before = old.get(task.id);
    if (!before) { (tasks.added ??= []).push(structuredClone(task)); continue; }
    if (before === task) continue;
    if (replacedHistory(before, task)) { (tasks.changed ??= []).push({ id: task.id, replacement: structuredClone(task) }); continue; }
    const metadata = fields(before, task, taskLists);
    const messages = records(before.messages, task.messages);
    const tools = records(before.tools, task.tools);
    if (metadata || messages || tools) (tasks.changed ??= []).push({ id: task.id, ...(metadata ? { fields: metadata } : {}), ...(messages ? { messages } : {}), ...(tools ? { tools } : {}) });
  }
  for (const id of old.keys()) if (!current.has(id)) (tasks.removed ??= []).push(id);
  if (orderChanged(previous.tasks, next.tasks)) tasks.order = next.tasks.map(task => task.id);
  if (Object.keys(tasks).length) update.tasks = tasks;
  return update;
}

function applyFields<T extends object>(previous: T, update: FieldUpdate): T {
  const next = { ...previous } as Record<string, unknown>;
  for (const key of update.unset ?? []) { if (unsafeKeys.has(key)) throw new Error('Invalid update key.'); delete next[key]; }
  for (const [key, value] of Object.entries(update.set ?? {})) { if (unsafeKeys.has(key)) throw new Error('Invalid update key.'); next[key] = value; }
  for (const [key, value] of Object.entries(update.append ?? {})) {
    if (!appendFields.has(key) || typeof next[key] !== 'string' || next[key].length !== value.length) throw new Error('Snapshot text prefix mismatch; refresh the snapshot.');
    next[key] += value.text;
  }
  return next as T;
}

function applyRecords<T extends { id: string }>(previous: T[], update: RecordUpdate<T>): T[] {
  const map = ids(previous);
  for (const id of update.removed ?? []) { if (!map.delete(id)) throw new Error('Removed record was absent; refresh the snapshot.'); }
  for (const item of update.added ?? []) { if (map.has(item.id)) throw new Error('Added record already exists; refresh the snapshot.'); map.set(item.id, item); }
  for (const item of update.changed ?? []) {
    const before = map.get(item.id); if (!before) throw new Error('Changed record was absent; refresh the snapshot.');
    map.set(item.id, applyFields(before, item.fields));
  }
  const order = update.order ?? previous.map(item => item.id).filter(id => map.has(id));
  if (order.length !== map.size || new Set(order).size !== order.length || order.some(id => !map.has(id))) throw new Error('Snapshot record order mismatch; refresh the snapshot.');
  return order.map(id => map.get(id)!);
}

/** Preserve untouched references so React inputs and unrelated panels can stay stable. */
export function applyAppUpdate(previous: AppSnapshot | null | undefined, update: AppUpdate): AppSnapshot {
  if (update.type === 'snapshot') {
    if (update.revision !== undefined) revisions.set(update.snapshot, update.revision);
    return update.snapshot;
  }
  if (!previous) throw new Error('A base snapshot is required.');
  const known = revisions.get(previous);
  if (known !== undefined && update.baseRevision !== undefined && known !== update.baseRevision) throw new Error('Snapshot revision mismatch; refresh the snapshot.');
  let next = update.fields ? applyFields(previous, update.fields) : previous;
  if (update.tasks) {
    const { changed, ...list } = update.tasks;
    let tasks = previous.tasks;
    if (list.added || list.removed || list.order) tasks = applyRecords(tasks, list);
    if (changed?.length) {
      const patches = new Map(changed.map(item => [item.id, item]));
      if (patches.size !== changed.length || changed.some(item => !tasks.some(task => task.id === item.id))) throw new Error('Changed task was absent; refresh the snapshot.');
      tasks = tasks.map(task => {
        const patch = patches.get(task.id); if (!patch) return task;
        if (patch.replacement) return patch.replacement;
        const updated = patch.fields ? applyFields(task, patch.fields) : { ...task };
        if (patch.messages) updated.messages = applyRecords(task.messages, patch.messages);
        if (patch.tools) updated.tools = applyRecords(task.tools, patch.tools);
        return updated;
      });
    }
    next = { ...next, tasks };
  }
  if (update.revision !== undefined) revisions.set(next, update.revision);
  return next;
}

export function appUpdateRevision(snapshot: AppSnapshot): number | undefined { return revisions.get(snapshot); }
