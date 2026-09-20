import { spawn } from 'node:child_process';
import { BLOCKING_EVENTS, hooksFor, type HookCommand, type HookEvent, type HooksConfig } from '../core/hooks-config.ts';

/** What the hooks of one event came to: whether the thing may go ahead, why not, and what they said. */
export interface HookOutcome { decision: 'allow' | 'deny'; reason?: string; messages: string[] }
export interface HookInput {
  event: HookEvent; cwd: string; taskId?: string; projectDir?: string;
  toolName?: string; toolInput?: unknown; toolResponse?: unknown; prompt?: string; message?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT = 60;
const MAX_OUTPUT = 32 * 1024;
/** Hooks are the user's own commands; they run in PowerShell, like every other command Cardwright runs on Windows. */
const SHELL = process.platform === 'win32' ? (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe') : '/bin/sh';
const SHELL_ARGS = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command'] : ['-c'];
/** PowerShell writes in the console codepage unless told otherwise, and hook output is often Chinese. */
const ENCODING_PREFIX = process.platform === 'win32' ? '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' : '';

/** The worker's own variables never reach a hook, exactly as with the terminal and the agent's commands. */
function hookEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('PI_') && value !== undefined) clean[key] = value;
  return clean;
}

/** The JSON a hook reads on stdin; the names Claude Code uses, plus what Cardwright can add. */
function payload(input: HookInput): string {
  return JSON.stringify({
    hook_event_name: input.event, cwd: input.cwd,
    ...(input.taskId ? { task_id: input.taskId, session_id: input.taskId } : {}),
    ...(input.projectDir ? { project_dir: input.projectDir } : {}),
    ...(input.toolName ? { tool_name: input.toolName } : {}),
    ...(input.toolInput !== undefined ? { tool_input: input.toolInput } : {}),
    ...(input.toolResponse !== undefined ? { tool_response: input.toolResponse } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  });
}

interface CommandResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; failed?: string }

function runCommand(hook: HookCommand, input: HookInput): Promise<CommandResult> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const finish = (result: CommandResult) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => { timedOut = true; child?.kill(); }, Math.round((hook.timeout ?? DEFAULT_TIMEOUT) * 1000));
    timer.unref();
    try { child = spawn(SHELL, [...SHELL_ARGS, `${ENCODING_PREFIX}${hook.command}`], { cwd: input.cwd, env: hookEnvironment(input.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ code: null, stdout: '', stderr: '', timedOut: false, failed: error instanceof Error ? error.message : String(error) }); return; }
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_OUTPUT) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += String(chunk); });
    child.on('error', error => finish({ code: null, stdout, stderr, timedOut, failed: error.message }));
    child.on('close', code => finish({ code, stdout, stderr, timedOut }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(payload(input));
  });
}

/**
 * Runs the hooks of one event in order (§6.2). Exit code 0 passes, and what it printed is kept; 2 blocks the events
 * that can be blocked, with what it printed on stderr as the reason; anything else is an error the user is told about
 * while the work goes on. A hook that runs past its timeout is killed and counts as an error.
 */
export async function runHooks(hooks: HooksConfig, input: HookInput): Promise<HookOutcome> {
  const commands = hooksFor(hooks, input.event, input.toolName);
  if (!commands.length) return { decision: 'allow', messages: [] };
  const messages: string[] = [];
  let reason: string | undefined;
  for (const hook of commands) {
    const result = await runCommand(hook, input);
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    if (result.timedOut) { messages.push(`钩子超时（${hook.timeout ?? DEFAULT_TIMEOUT} 秒）：${hook.command}`); continue; }
    if (result.failed) { messages.push(`钩子无法运行：${hook.command}（${result.failed}）`); continue; }
    if (result.code === 2 && BLOCKING_EVENTS.includes(input.event)) { reason = stderr || stdout || `钩子拒绝了这一步：${hook.command}`; break; }
    if (result.code !== 0) { messages.push(stderr || stdout || `钩子退出码 ${result.code}：${hook.command}`); continue; }
    if (stdout) messages.push(stdout);
    if (stderr) messages.push(stderr);
  }
  return reason ? { decision: 'deny', reason, messages } : { decision: 'allow', messages };
}
