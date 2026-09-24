import { useDeferredValue, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useApp } from '../context';
import { highlightCode } from './highlight';
import { useCopied, type Skin } from './parts';

/** A block longer than this folds to its first lines behind 「展开全部 N 行」. */
const FOLD_OVER = 30;
const FOLD_SHOW = 16;

/**
 * A code block (handoff §5.5 ①): the language, a copy button, highlighted code, and long blocks folded. While the
 * reply is still writing the block it ends in the streaming cursor.
 */
export function CodeView({ code, language, streaming = false, skin = 'workbench' }: { code: string; language?: string; streaming?: boolean; skin?: Skin }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [copied, copy] = useCopied();
  const lines = useMemo(() => code.split('\n').length, [code]);
  const folds = lines > FOLD_OVER;
  const folded = folds && !expanded;
  const shown = useMemo(() => folded ? code.split('\n', FOLD_SHOW).join('\n') : code, [code, folded]);
  // While a block streams in, its colours may trail the text by a frame rather than hold the reply up.
  const deferred = useDeferredValue(shown);
  const html = useMemo(() => highlightCode(deferred, language), [deferred, language]);
  return <div className={`code-block conv-code${skin === 'studio' ? ' is-studio' : ''}${folded ? ' is-folded' : ''}${streaming ? ' is-streaming' : ''}`}>
    <div className="conv-code-head">
      <span className="conv-code-lang">{language || 'text'}</span>
      <button type="button" className="code-copy" aria-label={t('Copy code', '复制代码')} title={t('Copy code', '复制代码')} onClick={() => void copy(code)}>
        {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? t('Copied', '已复制') : t('Copy', '复制')}</span>
      </button>
    </div>
    <pre className="conv-pre">{html === null ? <code>{shown}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />}{streaming && !folded && <span className="conv-cursor" aria-hidden="true" />}</pre>
    {folds && <button type="button" className="conv-code-fold" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? <><ChevronUp size={13} />{t('Collapse', '收起')}</> : <><ChevronDown size={13} />{t(`Show all ${lines} lines`, `展开全部 ${lines} 行`)}</>}
    </button>}
  </div>;
}
