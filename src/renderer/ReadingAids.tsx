import { useEffect, useState, type RefObject } from 'react';
import { ArrowDown } from 'lucide-react';
import { useApp } from './context';

// Code blocks (copy, language, highlighting, folding) are the conversation kernel's since 1.1: conversation/CodeView.tsx.

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
