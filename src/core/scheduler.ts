import type { Schedule } from '../shared/types.ts';

export const SCHEDULE_GRACE_MS = 90_000;

function timestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

/** Use lastTick = 0 on application startup to mark past occurrences as missed. */
export function evaluateSchedule(schedule: Schedule, now: Date | number, lastTick: Date | number): 'run' | 'missed' | null {
  if (!schedule.enabled || schedule.missed) return null;
  const due = Date.parse(schedule.nextRunAt);
  const current = timestamp(now);
  const previous = timestamp(lastTick);
  if (![due, current, previous].every(Number.isFinite) || current < previous || due > current) return null;
  if (schedule.lastRunAt && Date.parse(schedule.lastRunAt) >= due) return null;
  if (current - due > SCHEDULE_GRACE_MS || current - previous > SCHEDULE_GRACE_MS) return 'missed';
  return 'run';
}

/** Advance directly to a future occurrence; skipped intervals are never replayed. */
export function nextRunAfter(schedule: Schedule, now: Date | number): string | null {
  if (schedule.intervalMinutes === null) return null;
  const interval = schedule.intervalMinutes * 60_000;
  const due = Date.parse(schedule.nextRunAt);
  const current = timestamp(now);
  if (!Number.isFinite(interval) || interval < 60_000 || !Number.isFinite(due) || !Number.isFinite(current)) return null;
  const count = Math.max(0, Math.floor((current - due) / interval) + 1);
  const next = due + count * interval;
  return Number.isFinite(next) && Math.abs(next) <= 8.64e15 ? new Date(next).toISOString() : null;
}
