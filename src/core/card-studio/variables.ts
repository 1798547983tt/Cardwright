/**
 * Running the card's own Zod schema. The code comes from the model, so it runs in a bare `node:vm` context
 * with no files, no network and no timers, with only `z` (Zod 4) and `_` (lodash) injected, under a timeout.
 */
import { spawn } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { parse as parseYaml } from 'yaml';
import _ from 'lodash';
import { z } from 'zod';

export interface EvaluatedSchema { schema: unknown; registered: boolean }
export interface ValidationIssue { path: string; message: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[]; value?: unknown }

/** Strips the module wrapper so the body can run as a plain script. */
export function schemaSource(code: string): string {
  return String(code ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^[ \t]*import\b[^;]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(?=(const|let|var|function|class)\b)/gm, '')
    .replace(/^[ \t]*export\s+default\s+/gm, 'const __default = ');
}

/** Runs the schema code in an isolated context and hands back the schema it defines. */
export function evaluateSchema(code: string, options: { timeoutMs?: number } = {}): EvaluatedSchema {
  const source = schemaSource(code);
  let registered: unknown;
  const sandbox: Record<string, unknown> = {
    z, _,
    registerMvuSchema: (schema: unknown) => { registered = schema; return schema; },
    $: (value: unknown) => { if (typeof value === 'function') (value as () => void)(); return value; },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  };
  const context = createContext(sandbox, { name: 'card-studio-schema' });
  try {
    runInContext(`${source}\n;globalThis.__cardwrightSchema = typeof Schema === 'undefined' ? undefined : Schema;`, context, { timeout: options.timeoutMs ?? 1000, displayErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out|Script execution timed out/i.test(message)) throw new Error(`变量结构代码执行超时（${options.timeoutMs ?? 1000} 毫秒）。检查有没有死循环。`);
    throw new Error(`变量结构代码执行失败：${message}`);
  }
  const schema = registered ?? (sandbox.__cardwrightSchema as unknown);
  if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
    throw new Error('变量结构代码里没有找到 Schema。按固定写法写：`export const Schema = z.object({...})`，结尾 `$(() => { registerMvuSchema(Schema); });`。');
  }
  return { schema, registered: registered !== undefined };
}

/** The [initvar] entry is YAML; it must describe a map of fields. */
export function parseInitialVariables(text: string): unknown {
  let value: unknown;
  try { value = parseYaml(String(text ?? '').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`初始变量不是有效的 YAML：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('初始变量应该是一组字段（YAML 映射），例如「世界:」下面跟着子字段。');
  return value;
}

export function validateInitialVariables(schema: unknown, value: unknown): ValidationResult {
  const parser = schema as { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } };
  const result = parser.safeParse(value);
  if (result.success) return { ok: true, issues: [], value: result.data };
  const issues = (result.error?.issues ?? []).map(issue => ({ path: issue.path.join('.') || '(根)', message: issue.message }));
  return { ok: false, issues };
}

export interface SandboxOptions {
  /** The sandbox entry: `dist/card-sandbox.mjs` in the application, the TypeScript file in tests. */
  entry: string;
  execPath?: string; execArgv?: string[]; allowRead?: string[]; timeoutMs?: number;
}
export interface SandboxResult extends ValidationResult { registered?: boolean; error?: string; restricted: boolean }

/**
 * Runs the schema in a separate short-lived process. Injecting `z` and `_` means a `node:vm` context alone
 * can be escaped through those host objects, so the process itself is the boundary: Node's permission model
 * denies the file system, and nothing of the application is reachable from it.
 */
export async function validateInSandbox(code: string, value: unknown, options: SandboxOptions): Promise<SandboxResult> {
  const attempt = async (restricted: boolean): Promise<SandboxResult & { startupFailed?: boolean }> => {
    const permission = restricted ? ['--permission', `--allow-fs-read=${options.entry}`, ...(options.allowRead ?? []).map(path => `--allow-fs-read=${path}`)] : [];
    const child = spawn(options.execPath ?? process.execPath, [...permission, ...(options.execArgv ?? []), options.entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => err.push(Buffer.from(chunk)));
    child.stdin.end(JSON.stringify({ code, value, timeoutMs: options.timeoutMs ?? 1000 }));
    const killer = setTimeout(() => child.kill('SIGKILL'), (options.timeoutMs ?? 1000) + 5000);
    const [exitCode] = await new Promise<[number | null, string | null]>(done => {
      child.on('error', error => done([-1, error.message]));
      child.on('close', (value2, signal) => done([value2, signal]));
    });
    clearTimeout(killer);
    const stdout = Buffer.concat(out).toString('utf8').trim();
    const stderr = Buffer.concat(err).toString('utf8').trim();
    if (!stdout) {
      const startupFailed = restricted && /bad option|not allowed|ERR_UNKNOWN|Permission|unsupported/i.test(stderr);
      return { ok: false, issues: [], restricted, startupFailed, error: stderr.split('\n')[0] || `变量结构沙箱进程退出（代码 ${exitCode}）。` };
    }
    try { return { ...(JSON.parse(stdout) as SandboxResult), restricted }; }
    catch { return { ok: false, issues: [], restricted, error: '变量结构沙箱返回了无法解析的结果。' }; }
  };
  const restricted = await attempt(true);
  if (!restricted.startupFailed) { delete restricted.startupFailed; return restricted; }
  const plain = await attempt(false);
  delete plain.startupFailed;
  return plain;
}
