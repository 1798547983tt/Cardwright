import { Children, isValidElement, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, Copy } from 'lucide-react';
import { useApp } from './context';

/** The plain text inside rendered Markdown children. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** A code block with a copy button, as the desktop chat apps have it; the text goes through the bridge. */
export function CodeBlock({ children, className = '' }: { children?: ReactNode; className?: string }) {
  const { api, t, run } = useApp();
  const text = textOf(Children.toArray(children)).replace(/\n$/, '');
  return <div className={`code-block ${className}`.trim()}>
    <pre>{children}</pre>
    <button type="button" className="code-copy" aria-label={t('Copy code', '复制代码')} title={t('Copy code', '复制代码')} onClick={() => void run(() => api.copyText(text), t('Code copied', '已复制代码'))}><Copy size={13} /></button>
  </div>;
}

/**
 * 回到最新: once the reader has scrolled well above the latest message, a button takes them back down. It sits in the
 * scrolling column itself and stays at the bottom of the view.
 */
export function JumpToLatest({ scroller, className = '' }: { scroller: RefObject<HTMLElement | null>; className?: string }) {
  const { t, data } = useApp();
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setAway(element.scrollHeight - element.scrollTop - element.clientHeight > 480);
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { element.removeEventListener('scroll', measure); observer.disconnect(); };
  }, [scroller]);
  if (!away) return null;
  const reduced = data.preferences.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  return <div className={`jump-latest ${className}`.trim()}>
    <button type="button" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })}><ArrowDown size={14} />{t('Back to latest', '回到最新')}</button>
  </div>;
}
