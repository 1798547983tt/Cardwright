import type { CheckDefinition, CheckRun } from '../main/check-runner.ts';
import { relevantChecks } from '../main/check-runner.ts';
import type { ReviewSnapshot } from './checkpoints.ts';

export type VerificationStatus = 'not-run' | 'running' | 'passed' | 'failed' | 'stale';
export interface DeliveryEvidence { taskId: string; turnId: string; execution: 'completed' | 'failed' | 'cancelled' | 'running'; verification: VerificationStatus; revision: string; changedFiles: Array<{ path: string; kind: 'added' | 'modified' | 'deleted'; accepted: boolean }>; checks: CheckRun[]; unverified: string[]; createdAt: string }
export function verificationStatus(checks: CheckRun[], revision: string, requiredIds?: string[]): VerificationStatus {
  const latest = new Map<string, CheckRun>(); for (const run of checks) latest.set(run.checkId, run);
  const relevant = requiredIds ? requiredIds.map(id => latest.get(id)).filter((run): run is CheckRun => !!run) : [...latest.values()];
  if (relevant.some(run => run.status === 'running' && run.revision === revision)) return 'running';
  if (!relevant.length) return 'not-run';
  if (relevant.some(run => run.revision !== revision)) return 'stale';
  if (relevant.some(run => run.status !== 'passed')) return 'failed';
  if (requiredIds && requiredIds.some(id => !latest.has(id))) return 'not-run';
  return 'passed';
}
export function buildDelivery(input: { taskId: string; turnId: string; execution: DeliveryEvidence['execution']; review: ReviewSnapshot; checks: CheckRun[]; configuredChecks: CheckDefinition[] }): DeliveryEvidence {
  const required = relevantChecks(input.configuredChecks, input.review.files.map(file => file.path)); const requiredIds = required.map(check => check.id); const verification = verificationStatus(input.checks, input.review.revision, requiredIds);
  const latest = new Map<string, CheckRun>(); for (const run of input.checks) latest.set(run.checkId, run);
  const unverified: string[] = [];
  if (!required.length) unverified.push('No applicable project checks are configured.');
  for (const check of required) { const run = latest.get(check.id); if (!run) unverified.push(`${check.name}: not run.`); else if (run.revision !== input.review.revision) unverified.push(`${check.name}: files changed after this check.`); else if (run.status !== 'passed') unverified.push(`${check.name}: ${run.status}.`); }
  if (input.review.coverage.omitted.length) unverified.push('Generated files and symbolic links are outside checkpoint coverage.');
  return { taskId: input.taskId, turnId: input.turnId, execution: input.execution, verification, revision: input.review.revision, changedFiles: input.review.files.map(({ path, kind, accepted }) => ({ path, kind, accepted })), checks: [...input.checks], unverified, createdAt: new Date().toISOString() };
}
