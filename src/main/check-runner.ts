export interface CheckDefinition { id: string; name: string; command: string; paths?: string[]; timeoutMs?: number }
export type CheckStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'timed-out';
export interface CheckRun { id: string; checkId: string; name: string; command: string; cwd: string; revision: string; status: CheckStatus; startedAt: string; finishedAt?: string; durationMs?: number; exitCode?: number | null; output: string; truncated: boolean; error?: string }
export interface CheckExecutionResult { exitCode: number | null; signal?: string }
/** Resolves only after process-tree termination and cleanup; the native host bounds forced close to 10s. */
export type CheckExecutor = (command: string, cwd: string, onData: (chunk: string) => void, signal: AbortSignal) => Promise<CheckExecutionResult>;
export interface RunChecksOptions { checks: CheckDefinition[]; cwd: string; revision: string; changedPaths: string[]; execute: CheckExecutor; signal?: AbortSignal; force?: boolean; onRun?: (run: CheckRun) => void; maxOutputBytes?: number }
import { randomUUID } from 'node:crypto';

function pathMatches(path: string, pattern: string): boolean {
  if (!pattern || pattern.length > 500) return false;
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  let expression = '';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') { index++; if (normalized[index + 1] === '/') { index++; expression += '(?:.*/)?'; } else expression += '.*'; }
    else if (char === '*') expression += '[^/]*'; else if (char === '?') expression += '[^/]'; else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'i' : '').test(path.replaceAll('\\', '/'));
}
export function relevantChecks(checks: CheckDefinition[], changedPaths: string[], force = false): CheckDefinition[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (!check.id || ids.has(check.id) || !check.name?.trim() || !check.command?.trim() || check.command.length > 32000 || check.command.includes('\0')) throw new Error('Checks need unique identifiers, names and valid commands.');
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 3_600_000)) throw new Error('Check timeout must be between 1 ms and one hour.');
    if (check.paths && (check.paths.length > 100 || check.paths.some(pattern => typeof pattern !== 'string' || !pattern || pattern.length > 500))) throw new Error('Invalid check path patterns.');
    ids.add(check.id);
  }
  return checks.filter(check => force || changedPaths.length > 0 && (!check.paths?.length || changedPaths.some(path => check.paths!.some(pattern => pathMatches(path, pattern)))));
}
export async function runChecks(options: RunChecksOptions): Promise<CheckRun[]> {
  if (!options.revision) throw new Error('Checks must be tied to a workspace revision.');
  const selected = relevantChecks(options.checks, options.changedPaths, options.force); const runs: CheckRun[] = []; const maxBytes = Math.max(1024, Math.min(options.maxOutputBytes ?? 128 * 1024, 2 * 1024 * 1024));
  for (const check of selected) {
    if (options.signal?.aborted) break;
    const controller = new AbortController(); const started = Date.now(); let timedOut = false; let finished = false;
    const run: CheckRun = { id: randomUUID(), checkId: check.id, name: check.name, command: check.command, cwd: options.cwd, revision: options.revision, status: 'running', startedAt: new Date(started).toISOString(), output: '', truncated: false }; runs.push(run);
    const publish = () => options.onRun?.({ ...run }); publish();
    const parentAbort = () => controller.abort(options.signal?.reason || new Error('Check cancelled.')); options.signal?.addEventListener('abort', parentAbort, { once: true }); if (options.signal?.aborted) parentAbort();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('Check timed out.')); }, check.timeoutMs ?? 120_000);
    try {
      controller.signal.throwIfAborted();
      const execution = options.execute(check.command, options.cwd, chunk => {
        if (finished) return; const bytes = Buffer.from(run.output + String(chunk));
        if (bytes.length > maxBytes) { run.output = bytes.subarray(bytes.length - maxBytes).toString('utf8'); run.truncated = true; } else run.output = bytes.toString('utf8'); publish();
      }, controller.signal);
      // Cancellation requests shutdown; it must not release the workspace lease
      // while the command or its descendants can still write to that workspace.
      const result = await execution; run.exitCode = result.exitCode;
      run.status = controller.signal.aborted ? timedOut ? 'timed-out' : 'cancelled' : result.exitCode === 0 && !result.signal ? 'passed' : 'failed';
      if (result.signal) run.error = `Command terminated by ${result.signal}.`;
    } catch (error) { run.status = controller.signal.aborted ? timedOut ? 'timed-out' : 'cancelled' : 'failed'; run.error = error instanceof Error ? error.message : String(error); }
    finally { finished = true; clearTimeout(timeout); options.signal?.removeEventListener('abort', parentAbort); run.durationMs = Date.now() - started; run.finishedAt = new Date().toISOString(); publish(); }
    if (options.signal?.aborted) break;
  }
  return runs;
}
