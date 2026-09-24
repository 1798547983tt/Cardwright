import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../shared/types';
import { useApp } from '../context';
import { Markdown, type MarkdownProps } from './Markdown';

/** Seconds of thinking: counted while it lasts, the recorded total once done, unknown for messages from before 1.1. */
function useThinkingSeconds(message: ChatMessage, live: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);
  if (message.thinkingMs !== undefined) return Math.max(1, Math.round(message.thinkingMs / 1000));
  if (!live) return undefined;
  const start = Date.parse(message.thinkingStartedAt ?? message.at);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : undefined;
}

/**
 * The model's thinking (handoff §5.5 ②). While the model thinks it is open and live, 「思考中 N 秒」 beside a quietly
 * flowing rail, its newest lines in view; once done it folds to 「思考了 N 秒」 and opens on a click.
 */
export function ThinkingBlock({ message, live, ...markdown }: { message: ChatMessage; live: boolean } & Omit<MarkdownProps, 'text' | 'streaming'>) {
  const { t } = useApp();
  // Unset, it follows the thinking (open while live, folded when done); a click decides from then on.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? live;
  const seconds = useThinkingSeconds(message, live);
  const text = message.thinking ?? '';
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && live && pinned.current) element.scrollTop = element.scrollHeight;
  }, [text, live, open]);
  const label = live
    ? seconds === undefined ? t('Thinking', '思考中') : t(`Thinking ${seconds}s`, `思考中 ${seconds} 秒`)
    : seconds === undefined ? t('Thought process', '思考过程') : t(`Thought for ${seconds}s`, `思考了 ${seconds} 秒`);
  return <div className={`conv-thinking${live ? ' is-live' : ''}${open ? ' is-open' : ''}${markdown.skin === 'studio' ? ' is-studio' : ''}`}>
    <button type="button" className="conv-thinking-head" aria-expanded={open} onClick={() => setChosen(!open)}><ChevronRight size={13} /><span>{label}</span></button>
    {open && text.trim() && <div className="conv-thinking-frame">
      {live && <span className="conv-thinking-rail" aria-hidden="true" />}
      <div ref={body} className={`conv-thinking-body${live ? ' conv-live' : ''}`} onScroll={event => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
        <Markdown text={text} streaming={live} {...markdown} />
      </div>
    </div>}
  </div>;
}
