import type { PermissionMode } from './types.ts';

/** What the workbench composer is set to: a permission mode, with plan mode as a step of its own (§6.2). */
export interface ComposerMode { permission: PermissionMode; planMode: boolean }

/** The four steps Shift+Tab cycles through, in order. */
export const MODES: readonly ComposerMode[] = [
  { permission: 'ask', planMode: false },
  { permission: 'edit', planMode: false },
  { permission: 'edit', planMode: true },
  { permission: 'full', planMode: false },
];

/** Where a state sits in the cycle: plan mode is the third step whatever permission it was switched on from. */
export function modeIndex(mode: ComposerMode): number {
  if (mode.planMode) return 2;
  const found = MODES.findIndex(item => !item.planMode && item.permission === mode.permission);
  return found < 0 ? 0 : found;
}

export function nextMode(mode: ComposerMode): ComposerMode {
  return { ...MODES[(modeIndex(mode) + 1) % MODES.length] };
}

export function modeLabel(mode: ComposerMode, t: (en: string, zh: string) => string): string {
  if (mode.planMode) return t('Plan', '计划');
  return mode.permission === 'ask' ? t('Ask permissions', '默认审批') : mode.permission === 'edit' ? t('Auto-edit', '自动编辑') : t('Full access', '完全访问');
}
