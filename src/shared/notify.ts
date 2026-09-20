import type { Preferences } from './types.ts';

/** What a system notification is about; the first two have a switch of their own in settings (§6.3). */
export type NotifyKind = 'finished' | 'approval' | 'other';

/**
 * A system notification is for when the user is elsewhere: with the window in front the interface already shows what
 * happened. `notifications` is the master switch; `notifyFinished` and `notifyApproval` turn one kind off.
 */
export function shouldNotify(input: { kind: NotifyKind; focused: boolean; preferences: Preferences }): boolean {
  if (!input.preferences.notifications || input.focused) return false;
  if (input.kind === 'finished') return input.preferences.notifyFinished !== false;
  if (input.kind === 'approval') return input.preferences.notifyApproval !== false;
  return true;
}
