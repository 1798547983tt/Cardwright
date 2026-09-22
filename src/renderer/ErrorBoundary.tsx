import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Check, Copy, RotateCw } from 'lucide-react';
import { reportRendererError } from './diagnostics';

/** What a boundary guards: one workbench page, the card studio's content, or the whole window. */
export type BoundaryKind = 'workbench' | 'studio' | 'app';
type Translate = (english: string, chinese: string) => string;

/** The whole-window card may have lost the app context; App keeps <html lang> in step with the language preference. */
const documentLanguage: Translate = (english, chinese) => document.documentElement.lang.startsWith('zh') ? chinese : english;

interface BoundaryProps { kind: BoundaryKind; page?: string; t?: Translate; onBack: () => void; children?: ReactNode }
interface BoundaryState { error: Error | null; diagnostic: Promise<string> | null }

/**
 * An error boundary (0.9.1): a page that fails to render shows an error card in its place, and the rest of the window
 * keeps working. Render it under the page's key, so another page starts clean.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, diagnostic: null };
  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const diagnostic = reportRendererError('boundary', error, info.componentStack ?? undefined, this.props.page);
    diagnostic.catch(() => undefined);
    this.setState({ diagnostic });
  }
  // Going back to the same page (the error was on the home page itself) has to try it again.
  private back = (): void => {
    if (this.props.kind !== 'app') this.setState({ error: null, diagnostic: null });
    this.props.onBack();
  };
  render(): ReactNode {
    const { error, diagnostic } = this.state;
    if (!error) return this.props.children;
    return <ErrorCard kind={this.props.kind} message={error.message || error.name} diagnostic={diagnostic} t={this.props.t ?? documentLanguage} onBack={this.back} />;
  }
}

function ErrorCard({ kind, message, diagnostic, t, onBack }: { kind: BoundaryKind; message: string; diagnostic: Promise<string> | null; t: Translate; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    let alive = true;
    diagnostic?.then(value => { if (alive) setText(value); }, () => { if (alive) setCopy('failed'); });
    return () => { alive = false; };
  }, [diagnostic]);
  async function copyDiagnostics() {
    if (!text) return;
    try { await window.cardwright.copyText(text); setCopy('copied'); } catch { setCopy('failed'); }
  }
  const title = t('This page ran into an error', '这个页面出错了');
  const note = copy === 'failed' ? t('The diagnostics could not be prepared or copied.', '诊断信息没能生成或复制。')
    : t('The diagnostics leave out card and conversation content, and are also saved in the local log.', '诊断信息不含卡和对话的内容，也已记入本地日志。');
  const copyLabel = copy === 'copied' ? t('Diagnostics copied', '已复制诊断信息') : t('Copy diagnostics', '复制诊断信息');
  const CopyIcon = copy === 'copied' ? Check : Copy;
  const backLabel = kind === 'studio' ? t('Back to the card library', '返回卡库') : kind === 'workbench' ? t('Back to the workbench home', '回到工作台首页') : t('Reload', '重新加载');

  if (kind === 'studio') return <section className="cs-page-error" role="alert">
    <span className="cs-page-error-tag">ERROR · {t('page error', '页面出错')}</span>
    <h2>{title}</h2>
    <p className="cs-page-error-message" title={message}>{message}</p>
    <p className="cs-note">{note}</p>
    <div className="cs-page-error-actions">
      <button type="button" className="cs-btn" disabled={!text} onClick={() => void copyDiagnostics()}><CopyIcon size={14} />{copyLabel}</button>
      <button type="button" className="cs-btn is-primary" onClick={onBack}><ArrowLeft size={14} />{backLabel}</button>
    </div>
  </section>;

  const card = <section className="error-card" role="alert">
    <AlertTriangle size={18} aria-hidden="true" />
    <div>
      <h2>{title}</h2>
      <p className="error-card-message" title={message}>{message}</p>
      <p className="error-card-note">{note}</p>
      <div className="error-card-actions">
        <button type="button" className="button small" disabled={!text} onClick={() => void copyDiagnostics()}><CopyIcon size={14} />{copyLabel}</button>
        <button type="button" className="button small primary" onClick={onBack}>{kind === 'app' ? <RotateCw size={14} /> : <ArrowLeft size={14} />}{backLabel}</button>
      </div>
    </div>
  </section>;
  return kind === 'app' ? <div className="error-screen">{card}</div> : card;
}

/** True only for a start with CARDWRIGHT_SMOKE_RENDER_FAULT=1 (the desktop process passes the switch to the preload). */
export const smokeFaults = (): boolean => window.cardwright?.smokeRenderFault === true;

/**
 * Mounted only under `smokeFaults()`: a `cardwright-smoke-fault` event naming this surface makes it throw while
 * rendering, so the packaged smoke can see a real error card. Ordinary starts never mount it.
 */
export function SmokeFault({ where }: { where: BoundaryKind }) {
  const [fault, setFault] = useState('');
  useEffect(() => {
    const arm = (event: Event) => {
      const detail = (event as CustomEvent<{ where?: string; message?: string }>).detail;
      if (detail?.where === where) setFault(detail.message || 'Cardwright smoke fault');
    };
    window.addEventListener('cardwright-smoke-fault', arm);
    return () => window.removeEventListener('cardwright-smoke-fault', arm);
  }, [where]);
  if (fault) throw new Error(fault);
  return null;
}
