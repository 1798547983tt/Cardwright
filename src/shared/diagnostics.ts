/**
 * Renderer error diagnostics (0.9.1): the text an error card copies and <资料目录>/logs/renderer.log keeps. It is built
 * from the fields below only — never the card, the conversation, a gateway address or a key — and the user's home
 * folder is written as ~ wherever a path shows it.
 */
import { sectionLabel } from './card-studio/boards.ts';

export type RendererErrorSource = 'boundary' | 'error' | 'rejection';
/** What the renderer reports about an error it caught: where the user was, and the error itself. */
export interface RendererErrorReport { source: RendererErrorSource; page: string; message: string; stack?: string; componentStack?: string }
export interface DiagnosticEnvironment { version: string; windows: string; home: string; at: Date }
export type PageLocation =
  | { area: 'workbench'; mode: 'code' | 'tasks' | 'settings'; task: boolean }
  | { area: 'studio'; page: 'library' | 'project' }
  | { area: 'studio'; page: 'section'; sectionId: string };

/** The log moves to renderer.log.1 before a record would take it past this size. */
export const LOG_LIMIT = 1024 * 1024;
const MESSAGE_LIMIT = 2000;
const STACK_LIMIT = 8000;
/** What the renderer sends at most per field; the desktop process cuts again after hiding paths and keys. */
const REPORT_LIMIT = 64_000;
const SOURCES: Record<RendererErrorSource, string> = { boundary: '错误边界', error: 'window.onerror', rejection: 'unhandledrejection' };

/** 「制卡工坊 · 拼装」: where the user was, in glossary terms. Never the name of a card or a task. */
export function pageLabel(location: PageLocation): string {
  if (location.area === 'studio') return `制卡工坊 · ${location.page === 'section' ? sectionLabel(location.sectionId) : location.page === 'project' ? '卡项目主页' : '卡库'}`;
  if (location.mode === 'settings') return '工作室设置';
  if (location.mode === 'tasks') return '工作台 · Agent 与计划';
  return location.task ? '工作台 · 任务' : '工作台 · 首页';
}

/** Windows 11 still calls itself Windows 10; its builds start at 22000. */
export function windowsLabel(name: string, release: string): string {
  const build = Number(release.split('.')[2]);
  return `${build >= 22000 ? name.replace(/^Windows 10\b/, 'Windows 11') : name} ${release}`.trim();
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The home folder in a path becomes ~, whether it is written with backslashes, slashes or URL-encoded, in any case. */
export function redactHome(text: string, home: string): string {
  const parts = home.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return text;
  const plain = parts.map(escapeRegExp).join('[\\\\/]+');
  const encoded = escapeRegExp(encodeURI(parts.join('/')));
  // A longer folder name (示例用户2 for 示例用户) is someone else's folder, so the match has to end where the name does.
  return text.replace(new RegExp(`(?:${plain}|${encoded})(?![\\p{L}\\p{N}_.%-])`, 'giu'), '~');
}

/** Web addresses (a gateway's among them) and anything shaped like an API key; React's own error links stay readable. */
function hideSecrets(text: string): string {
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s'"`<>()]+/gi, url => url.startsWith('https://react.dev/') ? url : '<网址已隐去>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<密钥已隐去>')
    .replace(/\b(Bearer)\s+[^\s'"`]+/gi, '$1 <密钥已隐去>');
}

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;
const lines = (text: string): string[] => text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());

/** One record: every line filled in, no blank line inside, so the log can put one blank line between records. */
export function diagnosticText(report: RendererErrorReport, environment: DiagnosticEnvironment): string {
  // Paths and keys go before the cut, so a cut can never leave half a home folder behind.
  const clean = (value: unknown, limit: number): string => clip(redactHome(hideSecrets(typeof value === 'string' ? value : ''), environment.home), limit);
  const block = (label: string, value: unknown): string[] => {
    const body = lines(clean(value, STACK_LIMIT));
    return body.length ? [`${label}：`, ...body] : [`${label}：（无）`];
  };
  return [
    'Cardwright 诊断信息',
    `时间：${environment.at.toISOString()}`,
    `应用版本：${environment.version}`,
    `Windows：${environment.windows}`,
    `页面：${lines(clean(report?.page, 200)).join(' ') || '（未知）'}`,
    `来源：${SOURCES[report?.source] ?? '（未知）'}`,
    `错误：${lines(clean(report?.message, MESSAGE_LIMIT)).join(' ') || '（无）'}`,
    ...block('调用栈', report?.stack),
    ...block('组件栈', report?.componentStack),
  ].join('\n');
}

/** Any thrown value as a report. Only an Error's message and stack or a string travel; an object is named by its type, never serialized. */
export function reportOf(source: RendererErrorSource, reason: unknown, page: string, componentStack?: string): RendererErrorReport {
  const error = reason instanceof Error ? reason : undefined;
  const message = error ? error.message || error.name : typeof reason === 'string' ? reason : reason !== null && typeof reason === 'object' ? Object.prototype.toString.call(reason) : String(reason);
  return {
    source, page, message: clip(message, REPORT_LIMIT),
    ...(error?.stack ? { stack: clip(error.stack, REPORT_LIMIT) } : {}),
    ...(componentStack ? { componentStack: clip(componentStack, REPORT_LIMIT) } : {}),
  };
}

/** A record that would take the log past the limit moves it aside first; an empty log is never moved. */
export function needsRotation(currentBytes: number, incomingBytes: number, limit = LOG_LIMIT): boolean {
  return currentBytes > 0 && currentBytes + incomingBytes > limit;
}
