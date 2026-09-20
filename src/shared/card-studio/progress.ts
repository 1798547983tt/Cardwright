import type { StudioBoard } from './boards.ts';
import type { CardDispatch, PlanMode, SectionState } from './types.ts';

/** Progress is derived, never stored: dispatch states, the design book and imported material decide it. */
export interface ProgressInput { dispatches: CardDispatch[]; designExists: boolean; planStarted?: boolean; sources?: number; origin?: 'new' | 'import' }
export type NextStep = { kind: 'dispatch'; sectionId: string; dispatch: CardDispatch } | { kind: 'plan'; sectionId: 'plan'; mode: PlanMode } | { kind: 'build'; sectionId: 'build' };

export function sectionState(input: ProgressInput, sectionId: string): SectionState {
  if (sectionId === 'plan') return input.designExists ? 'done' : input.planStarted ? 'active' : 'todo';
  if (sectionId === 'source') return (input.sources ?? 0) > 0 ? 'done' : 'todo';
  const own = input.dispatches.filter(dispatch => dispatch.sectionId === sectionId);
  if (!own.length) return 'todo';
  if (own.every(dispatch => dispatch.status === 'done')) return 'done';
  return own.some(dispatch => dispatch.status !== 'todo') ? 'active' : 'todo';
}

export function boardStats(input: ProgressInput, board: StudioBoard): { done: number; total: number; active: boolean } {
  const counted = board.sections.filter(section => !section.optional || input.dispatches.some(dispatch => dispatch.sectionId === section.id));
  const states = counted.map(section => sectionState(input, section.id));
  return { done: states.filter(state => state === 'done').length, total: counted.length, active: states.includes('active') };
}

export function dispatchCounts(dispatches: CardDispatch[]): { done: number; total: number } {
  return { done: dispatches.filter(dispatch => dispatch.status === 'done').length, total: dispatches.length };
}

export function nextStep(input: ProgressInput): NextStep {
  const pending = input.dispatches.find(dispatch => dispatch.status !== 'done' && dispatch.sectionId);
  if (pending) return { kind: 'dispatch', sectionId: pending.sectionId!, dispatch: pending };
  if (input.dispatches.length && input.dispatches.every(dispatch => dispatch.status === 'done')) return { kind: 'build', sectionId: 'build' };
  return { kind: 'plan', sectionId: 'plan', mode: input.origin === 'import' ? 'refine' : 'scratch' };
}
