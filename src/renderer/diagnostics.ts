import { pageLabel, reportOf, type RendererErrorSource } from '../shared/diagnostics';

// Where the user is (a pageLabel), for errors that come without a page of their own: window.onerror, unhandled rejections, the whole-window card.
let currentPage = pageLabel({ area: 'workbench', mode: 'code', task: false });
export function setDiagnosticPage(label: string): void { currentPage = label; }

/** Sends an error to the desktop process, which writes it to the local log; resolves to the diagnostic text. */
export function reportRendererError(source: RendererErrorSource, reason: unknown, componentStack?: string, page = currentPage): Promise<string> {
  const api = window.cardwright;
  if (!api?.reportRendererError) return Promise.reject(new Error('The desktop bridge is unavailable.'));
  return api.reportRendererError(reportOf(source, reason, page, componentStack));
}

// The same error repeating (a timer, a stream) is logged once per quiet spell instead of on every repeat.
const REPEAT_QUIET_MS = 10_000;
const lastSeen = new Map<string, number>();
function firstInAWhile(key: string): boolean {
  const now = Date.now(); const last = lastSeen.get(key);
  lastSeen.set(key, now);
  if (lastSeen.size > 50) lastSeen.delete(lastSeen.keys().next().value!);
  return last === undefined || now - last > REPEAT_QUIET_MS;
}

/** window.onerror and unhandled rejections only go to the log; an error card is for what an error boundary catches. */
export function installErrorLogging(): () => void {
  const log = (source: RendererErrorSource, reason: unknown) => {
    const key = `${source}:${reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)}`;
    if (firstInAWhile(key)) void reportRendererError(source, reason).catch(() => undefined);
  };
  const onError = (event: ErrorEvent) => log('error', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => log('rejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
}
