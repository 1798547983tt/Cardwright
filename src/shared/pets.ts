/**
 * 桌宠 (Q14, ADR 0018): packs use the Codex pet format — pet.json (id, displayName, description, spritesheetPath) and a
 * spritesheet of 192×208 cells, 8 columns. Version 1 has 9 rows, one per action; version 2 adds two rows of look
 * directions, which Cardwright does not use. The pet only reports local state: it never calls a model.
 */
import type { Task } from './types.ts';

export const PET_STATES = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'] as const;
export type PetState = typeof PET_STATES[number];

/** The rows of the atlas in order, with the frames each uses and how long one loop takes (the Codex pet format's table). */
export const PET_ROWS: ReadonlyArray<{ state: PetState; frames: number; loop: number }> = [
  { state: 'idle', frames: 6, loop: 1100 },
  { state: 'running-right', frames: 8, loop: 1060 },
  { state: 'running-left', frames: 8, loop: 1060 },
  { state: 'waving', frames: 4, loop: 700 },
  { state: 'jumping', frames: 5, loop: 840 },
  { state: 'failed', frames: 8, loop: 1220 },
  { state: 'waiting', frames: 6, loop: 1010 },
  { state: 'running', frames: 6, loop: 820 },
  { state: 'review', frames: 6, loop: 1030 },
];

/** What happens in the app, which a theme may map onto other rows (its 动作表). */
export const PET_EVENTS = ['idle', 'running', 'waiting', 'complete', 'failed', 'making', 'poke', 'drag-left', 'drag-right'] as const;
export type PetEvent = typeof PET_EVENTS[number];
export const DEFAULT_PET_ACTIONS: Record<PetEvent, PetState> = {
  idle: 'idle', running: 'running', waiting: 'waiting', complete: 'jumping', failed: 'failed', making: 'review', poke: 'waving', 'drag-left': 'running-left', 'drag-right': 'running-right',
};

export interface PetManifest { id: string; displayName: string; description: string; spritesheetPath: string; spriteVersionNumber?: number }
export interface SpriteLayout { version: 1 | 2; columns: 8; rows: 9 | 11; cellWidth: 192; cellHeight: 208 }

export const PET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parsePetManifest(json: string): { pet: PetManifest } | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(json.replace(/^\uFEFF/, '')); } catch { return { error: 'pet.json 不是合法的 JSON。' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'pet.json 应该是一个对象。' };
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !PET_ID.test(value.id)) return { error: 'pet.json 的 id 只能用字母、数字、点、- 和 _，最长 64 个字符。' };
  if (typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 60) return { error: 'pet.json 缺少显示名称（displayName）。' };
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 400)) return { error: 'pet.json 的说明（description）要是 400 字以内的文字。' };
  const path = value.spritesheetPath;
  if (typeof path !== 'string' || !/^[^\\/:*?"<>|]+\.(webp|png)$/i.test(path) || path.startsWith('.')) return { error: 'pet.json 的 spritesheetPath 要指向宠物包里的一张 .webp 或 .png。' };
  const pet: PetManifest = { id: value.id, displayName: value.displayName.trim(), description: typeof value.description === 'string' ? value.description.trim() : '', spritesheetPath: path };
  if (value.spriteVersionNumber !== undefined) {
    if (value.spriteVersionNumber !== 1 && value.spriteVersionNumber !== 2) return { error: 'pet.json 的 spriteVersionNumber 只能是 1 或 2。' };
    pet.spriteVersionNumber = value.spriteVersionNumber;
  }
  return { pet };
}

/** The atlas a spritesheet of this size is, or null: 1536×1872 is version 1, 1536×2288 version 2. */
export function spriteLayout(width: number, height: number): SpriteLayout | null {
  if (width === 1536 && height === 1872) return { version: 1, columns: 8, rows: 9, cellWidth: 192, cellHeight: 208 };
  if (width === 1536 && height === 2288) return { version: 2, columns: 8, rows: 11, cellWidth: 192, cellHeight: 208 };
  return null;
}

type Translate = (english: string, chinese: string) => string;
export interface PetRun { card: string; projectId: string; status: string; done: number; total: number }
/** What a click on the pet opens: the workbench task it reports, a card studio conversation or card, or just the app. */
export type PetTarget = { kind: 'task'; taskId: string } | { kind: 'card'; projectId: string; sectionId?: string; taskId?: string } | { kind: 'app' };
export interface PetInput {
  now: Date;
  tasks: Task[];
  approvals: Array<{ taskId: string }>;
  interactions: Array<{ taskId: string }>;
  runs: PetRun[];
  usageToday: number;
  actions?: Partial<Record<PetEvent, PetState>>;
  t?: Translate;
}
export interface PetMood { event: PetEvent; state: PetState; taskId?: string; title?: string; status?: string; progress?: string; usage: string; open: PetTarget }
const targetOf = (task: Task): PetTarget => task.card ? { kind: 'card', projectId: task.projectId, sectionId: task.card.sectionId, taskId: task.id } : { kind: 'task', taskId: task.id };

/** How long a finished or failed run stays news. */
export const PET_NEWS_MS = 90_000;
const ACTIVE = new Set(['running', 'queued', 'waiting']);

/**
 * What the pet shows for the app's state, in the order Codex's own pets use: something that needs the user first, then a
 * failure, then a result, then work in progress. One-click making counts as work, shown with its progress.
 */
export function petMood(input: PetInput): PetMood {
  const t: Translate = input.t ?? ((_english, chinese) => chinese);
  const usage = t(`${input.usageToday.toLocaleString('en-US')} tokens today`, `今天 ${input.usageToday.toLocaleString('en-US')} Token`);
  const actions = { ...DEFAULT_PET_ACTIONS, ...input.actions };
  const tasks = input.tasks.filter(task => !task.parentId && !task.card?.member);
  const mood = (event: PetEvent, rest: Partial<Omit<PetMood, 'event' | 'state' | 'usage'>> = {}): PetMood => ({ event, state: actions[event], usage, open: { kind: 'app' }, ...rest });
  // A result is news for a short while, and only until a later run has started: then the user has moved on.
  const latestStart = Math.max(0, ...tasks.filter(task => ACTIVE.has(task.status) || task.workerActive).map(task => Date.parse(task.startedAt ?? task.updatedAt) || 0));
  const recent = (task: Task) => {
    const finished = task.completedAt ? Date.parse(task.completedAt) : NaN;
    return Number.isFinite(finished) && input.now.getTime() - finished <= PET_NEWS_MS && finished >= latestStart;
  };
  const newest = (list: Task[]) => [...list].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))[0];

  const asking = new Set([...input.approvals, ...input.interactions].map(item => item.taskId));
  const waiting = tasks.find(task => asking.has(task.id));
  if (waiting) return mood('waiting', { taskId: waiting.id, title: waiting.title, status: input.approvals.some(item => item.taskId === waiting.id) ? t('Needs approval', '等待审批') : t('Needs your answer', '等你回答'), open: targetOf(waiting) });
  const failed = newest(tasks.filter(task => task.status === 'failed' && recent(task)));
  if (failed) return mood('failed', { taskId: failed.id, title: failed.title, status: t('Failed', '失败'), open: targetOf(failed) });
  const done = newest(tasks.filter(task => task.status === 'completed' && recent(task)));
  if (done) return mood('complete', { taskId: done.id, title: done.title, status: t('Done', '已完成'), open: targetOf(done) });
  const run = input.runs.find(item => item.status === 'running' || item.status === 'pausing');
  if (run) return mood('making', { progress: t(`One-click making · ${run.card} ${run.done} / ${run.total}`, `一键制作 · ${run.card} ${run.done} / ${run.total}`), open: { kind: 'card', projectId: run.projectId } });
  const working = tasks.find(task => ACTIVE.has(task.status) || task.workerActive);
  if (working) return mood('running', { taskId: working.id, title: working.title, status: working.status === 'queued' ? t('Queued', '排队中') : t('Running', '运行中'), open: targetOf(working) });
  return mood('idle');
}

/** The floating pet window keeps this far from the screen's edge when it goes to the corner. */
export const PET_MARGIN = 24;
export interface PetArea { x: number; y: number; width: number; height: number }
/**
 * Where the floating pet window goes: the spot it was dragged to, pulled inside the screen its middle is on; or, the first
 * time or when that screen is gone, the bottom-right corner of the primary screen's work area.
 */
export function petPlacement(saved: { x: number; y: number } | undefined, size: { width: number; height: number }, screens: { primary: PetArea; all: readonly PetArea[] }): { x: number; y: number } {
  const corner = { x: Math.round(screens.primary.x + screens.primary.width - size.width - PET_MARGIN), y: Math.round(screens.primary.y + screens.primary.height - size.height - PET_MARGIN) };
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return corner;
  const middle = { x: saved.x + size.width / 2, y: saved.y + size.height / 2 };
  const home = screens.all.find(area => middle.x >= area.x && middle.x < area.x + area.width && middle.y >= area.y && middle.y < area.y + area.height);
  if (!home) return corner;
  return {
    x: Math.round(Math.min(Math.max(saved.x, home.x), home.x + home.width - size.width)),
    y: Math.round(Math.min(Math.max(saved.y, home.y), home.y + home.height - size.height)),
  };
}
