import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SANDBOX_ROOT_LIMIT } from './sandbox-roots.ts';

export interface CommandPolicy {
  mode: 'sandbox' | 'host';
  /** No network capabilities are granted in sandbox mode. Host mode is explicitly unrestricted. */
  network: 'off';
  readOnly?: boolean;
  readRoots?: string[];
  writeRoots?: string[];
}
export interface SandboxCommandOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds, matching the SDK's shell operation contract. */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  policy?: CommandPolicy;
  helperPath?: string;
  interactive?: boolean;
  cols?: number;
  rows?: number;
  onStarted?: (pid: number) => void;
}
export interface RunningCommand {
  completion: Promise<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export function commandHostPath(explicit?: string): string {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('The command host path must be absolute.');
    return explicit;
  }
  // Both the packaged main bundle and worker live beside the helper. Do not resolve
  // through cwd: a project must never be able to substitute a command host binary.
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry)) throw new Error('Cannot locate the trusted command host.');
  const candidate = join(dirname(entry), 'Cardwright.CommandHost.exe');
  if (existsSync(candidate)) return candidate;
  const devCandidate = join(dirname(entry), 'dist', 'Cardwright.CommandHost.exe');
  if (existsSync(devCandidate)) return devCandidate;
  throw new Error('Windows command isolation is unavailable: Cardwright.CommandHost.exe is missing. Rebuild or reinstall Cardwright.');
}

function cleanEnvironment(env?: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'PSModulePath', 'LANG', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    const value = env?.[key] ?? process.env[key];
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

export function startSandboxCommand(command: string, cwd: string, options: SandboxCommandOptions): RunningCommand {
  if (process.platform !== 'win32') throw new Error('Native command isolation requires Windows.');
  if (!isAbsolute(cwd)) throw new Error('Command directory must be absolute.');
  if (options.signal?.aborted) throw new Error('Operation cancelled.');
  const policy = options.policy ?? { mode: 'sandbox', network: 'off' };
  if (!['sandbox', 'host'].includes(policy.mode) || policy.network !== 'off') throw new Error('Unsupported command execution policy.');
  const helper = commandHostPath(options.helperPath);
  if (!existsSync(helper)) throw new Error('Windows command isolation is unavailable: command host is missing.');
  const toolsDirectory = join(dirname(helper), 'tools'); const bundledNode = join(toolsDirectory, 'node.exe');
  const jobEnvironment = cleanEnvironment(options.env);
  if (existsSync(bundledNode)) { jobEnvironment.PATH = `${toolsDirectory};${jobEnvironment.PATH || jobEnvironment.Path || ''}`; delete jobEnvironment.Path; }
  let child: ChildProcessWithoutNullStreams;
  let exited = false, closing = false, helperError: Error | undefined;
  let reportedExit: number | undefined;
  let line = '';
  let stderr = '';
  let killTimer: NodeJS.Timeout | undefined;
  const decoder = new StringDecoder('utf8');
  const write = (value: unknown) => { if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`, error => { if (error && !closing) helperError = error; }); };
  const close = () => {
    if (closing || exited) return;
    closing = true;
    write({ type: 'close' });
    // The helper gets time to kill its Job Object, revoke SID ACLs and delete its
    // ephemeral profile. Kill is an emergency path; it never relaunches on host.
    killTimer = setTimeout(() => child.kill(), 10000);
    killTimer.unref();
  };
  const completion = new Promise<{ exitCode: number | null }>((resolvePromise, reject) => {
    child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnvironment() });
    const abort = () => close();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (buffer: Buffer) => {
      line += decoder.write(buffer);
      if (line.length > 4_000_000) { helperError = new Error('Invalid command host output.'); close(); return; }
      for (let index = line.indexOf('\n'); index >= 0; index = line.indexOf('\n')) {
        const raw = line.slice(0, index); line = line.slice(index + 1);
        if (!raw.trim()) continue;
        try {
          const event = JSON.parse(raw) as { type: string; data?: string; message?: string; pid?: number; exitCode?: number };
          if (event.type === 'data' && typeof event.data === 'string') options.onData(Buffer.from(event.data, 'base64'));
          else if (event.type === 'started' && typeof event.pid === 'number') options.onStarted?.(event.pid);
          else if (event.type === 'exit' && typeof event.exitCode === 'number') reportedExit = event.exitCode;
          else if (event.type === 'error' || event.type === 'cleanup_error') helperError = new Error(event.message || 'Windows command host failed.');
        } catch (error) { helperError = error instanceof Error ? error : new Error('Invalid command host event.'); close(); }
      }
    });
    child.stderr.on('data', (buffer: Buffer) => { stderr = `${stderr}${buffer.toString('utf8')}`.slice(-4000); });
    child.on('error', error => { helperError = error; });
    child.stdin.on('error', error => { if (!closing) helperError ??= error; });
    child.on('close', code => {
      exited = true;
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (helperError) reject(helperError);
      else if (options.signal?.aborted || closing) resolvePromise({ exitCode: null });
      else if (code !== 0 || reportedExit === undefined) reject(new Error(stderr || `Windows command host stopped unexpectedly (${code}).`));
      else resolvePromise({ exitCode: reportedExit });
    });
    // PowerShell resolves PATH commands by inspecting the containing directory.
    // Only the bundled tool directory is shared; no ancestor or user profile is.
    write({ ...policy, readRoots: [...new Set([...(existsSync(bundledNode) ? [toolsDirectory] : []), ...(policy.readRoots || [])])].slice(0, SANDBOX_ROOT_LIMIT), cwd: resolve(cwd), command, env: jobEnvironment, interactive: options.interactive === true, cols: options.cols ?? 100, rows: options.rows ?? 30, timeoutMs: options.timeout === undefined ? options.interactive ? 0 : 120000 : Math.max(1, Math.min(86400000, options.timeout * 1000)) });
  });
  return {
    completion,
    write: data => { if (data.length > 64_000 || child.stdin.writableLength > 1_000_000) throw new Error('Terminal input is too large or still pending.'); write({ type: 'input', data: Buffer.from(data, 'utf8').toString('base64') }); },
    resize: (cols, rows) => write({ type: 'resize', cols: Math.round(Math.max(10, Math.min(500, cols))), rows: Math.round(Math.max(3, Math.min(300, rows))) }),
    close,
  };
}

export async function runSandboxCommand(command: string, cwd: string, options: SandboxCommandOptions): Promise<{ exitCode: number | null }> {
  return startSandboxCommand(command, cwd, options).completion;
}
export function createSandboxOperations(policy: CommandPolicy = { mode: 'sandbox', network: 'off' }, helperPath?: string) {
  return { exec: (command: string, cwd: string, options: Pick<SandboxCommandOptions, 'onData' | 'signal' | 'timeout' | 'env'>) => runSandboxCommand(command, cwd, { ...options, policy, helperPath }) };
}
