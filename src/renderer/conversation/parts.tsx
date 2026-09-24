import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronRight, Copy, LoaderCircle, Terminal } from 'lucide-react';
import type { ToolCall } from '../../shared/types';
import { toolSummary } from '../../shared/tool-view';
import { statusText, useApp } from '../context';
import { toolGroupLabel } from './tool-groups';

export type Skin = 'workbench' | 'studio';

/** The quiet sign that the agent is at work (handoff §5.5 ⑨): three dots taking turns. */
export function WorkingDots({ className = '' }: { className?: string }) {
  return <span className={`conv-dots ${className}`.trim()} aria-hidden="true"><i /><i /><i /></span>;
}

/** A copy button that says it copied; the text goes through the bridge like every other copy in the app. */
export function useCopied(): [boolean, (text: string) => Promise<void>] {
  const { api, run } = useApp();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, async text => { if (await run(async () => { await api.copyText(text); return true; })) setCopied(true); }];
}

/** A failed run, in the 0.9.1 error-card language (handoff §5.5 ⑩): what happened, the error itself, what to do next. */
export function RunError({ message, skin = 'workbench' }: { message: string; skin?: Skin }) {
  const { t } = useApp();
  const [copied, copy] = useCopied();
  const title = t('This run needs attention', '本次执行需要处理');
  const note = t('Review your gateway settings, then send a follow-up to try again.', '请检查网关设置，再发送一条消息重试。');
  const copyLabel = copied ? t('Error copied', '已复制错误信息') : t('Copy error', '复制错误信息');
  const CopyIcon = copied ? Check : Copy;
  if (skin === 'studio') return <section className="conv-error is-studio" role="alert">
    <span className="cs-page-error-tag">ERROR · {t('run failed', '执行出错')}</span>
    <h4>{title}</h4>
    <p className="conv-error-message">{message}</p>
    <p className="cs-note">{note}</p>
    <div className="conv-error-actions"><button type="button" className="cs-btn is-small" onClick={() => void copy(message)}><CopyIcon size={13} />{copyLabel}</button></div>
  </section>;
  return <section className="error-card conv-error" role="alert">
    <AlertTriangle size={18} aria-hidden="true" />
    <div>
      <h3>{title}</h3>
      <p className="error-card-message conv-error-message">{message}</p>
      <p className="error-card-note">{note}</p>
      <div className="error-card-actions"><button type="button" className="button small" onClick={() => void copy(message)}><CopyIcon size={14} />{copyLabel}</button></div>
    </div>
  </section>;
}

/**
 * Consecutive calls of one tool as one row, 「读取 5 个文件」 (handoff §5.5 ③). While a call runs, the row names what it
 * is working on; opened, it shows the calls themselves, each still its own tool record.
 */
export function ToolGroup({ name, calls, children }: { name: string; calls: ToolCall[]; children: ReactNode }) {
  const { t, data } = useApp();
  const [open, setOpen] = useState(false);
  const running = calls.filter(call => call.status === 'running' || call.status === 'waiting');
  const failed = calls.filter(call => call.status === 'failed').length;
  const state = running.length ? 'running' : failed ? 'failed' : 'completed';
  const current = running[running.length - 1];
  return <div className={`tool-entry tool-group-entry ${data.ecosystem.compactTools ? 'compact-tool' : ''}`}>
    <details className={`tool-group ${state}`} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="tool-chevron"><ChevronRight size={15} /></span>
        {state === 'running' ? <LoaderCircle size={14} className="spinning" /> : state === 'failed' ? <Terminal size={14} /> : <Check size={14} />}
        <strong>{toolGroupLabel(name, calls.length, t)}</strong>
        <span className="tool-summary">{current ? toolSummary(current, t) : ''}</span>
        <span className="tool-state">{state === 'failed' ? t(`${failed} failed`, `${failed} 次失败`) : statusText(state, t)}</span>
      </summary>
      {open && <div className="tool-group-body">{children}</div>}
    </details>
  </div>;
}
