import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Hand, LoaderCircle, X } from 'lucide-react';
import { useApp } from './context';
import { IconButton } from './primitives';

/**
 * 浏览器 (§6.4): the pages themselves are drawn by the window, on top of this element. All this pane does is
 * report where they go, and put the tabs, the address bar and the site question around them.
 */
export function BrowserPane({ active }: { active: boolean }) {
  const { api, data, t, run } = useApp();
  const browser = data.browser;
  const stage = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState('');
  const [opening, setOpening] = useState(false);
  const current = browser?.tabs.find(tab => tab.id === browser.activeId);

  // The window draws the page over this rectangle, so it has to follow the layout exactly.
  useLayoutEffect(() => {
    const report = () => {
      const box = stage.current?.getBoundingClientRect();
      void api.browserBounds(active && box && box.width > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null).catch(() => undefined);
    };
    report();
    if (!active) return;
    const observer = new ResizeObserver(report);
    if (stage.current) observer.observe(stage.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', report); window.removeEventListener('scroll', report, true); };
  }, [active, browser?.activeId, browser?.tabs.length, !!browser?.pending]);
  // While the pane is gone the page must go with it, or it floats over the conversation.
  useEffect(() => () => { void api.browserBounds(null).catch(() => undefined); }, []);

  const open = (event: React.FormEvent) => {
    event.preventDefault();
    if (!address.trim()) return;
    setOpening(true);
    void run(() => api.browserOpen(address.trim())).finally(() => setOpening(false));
  };
  return <div className="browser-pane">
    <div className="browser-tabs">
      {(browser?.tabs ?? []).map(tab => <span key={tab.id} className={`browser-tab ${tab.id === browser?.activeId ? 'is-current' : ''}`}>
        <button type="button" onClick={() => void api.browserSelect(tab.id)} title={tab.url}>
          {tab.loading ? <LoaderCircle size={12} className="spinning" /> : null}
          {tab.title || hostOf(tab.url) || t('New tab', '新标签页')}
        </button>
        <IconButton label={t('Close tab', '关闭标签页')} onClick={() => void api.browserClose(tab.id)}><X size={12} /></IconButton>
      </span>)}
    </div>
    <form className="browser-address" onSubmit={open}>
      <input value={address} onChange={event => setAddress(event.target.value)} placeholder={current?.url || 'localhost:3000'} aria-label={t('Address', '网址')} spellCheck={false} />
      <button type="submit" className="icon-button" aria-label={t('Open', '打开')} title={t('Open', '打开')} disabled={opening}><ArrowRight size={15} /></button>
    </form>
    {current && <div className={`browser-takeover ${current.takenOver ? 'is-taken' : ''}`}>
      <Hand size={13} />
      <span>{current.takenOver ? t('You have this page; the agent waits.', '这个页面归你，Agent 在等。') : t('The agent is working on this page.', 'Agent 正在操作此页面。')}</span>
      <button type="button" className="button small" onClick={() => void api.browserTakeOver(current.id, !current.takenOver)}>{current.takenOver ? t('Give it back', '交还') : t('Take over', '接手')}</button>
    </div>}
    {browser?.pending && <div className="browser-ask">
      <p>{t('Allow the built-in browser to open', '允许内置浏览器打开')} <strong>{browser.pending.origin}</strong>?</p>
      <small title={browser.pending.url}>{browser.pending.url}</small>
      <div className="browser-ask-actions">
        <button type="button" className="button primary small" onClick={() => void api.browserDecide('once')}>{t('Allow once', '允许一次')}</button>
        <button type="button" className="button small" onClick={() => void api.browserDecide('always')}>{t('Always allow this site', '始终允许此网站')}</button>
        <button type="button" className="button small" onClick={() => void api.browserDecide('deny')}>{t('Refuse', '拒绝')}</button>
      </div>
    </div>}
    <div className="browser-stage" ref={stage}>
      {!browser?.tabs.length && <p className="studio-empty">{t('Nothing open. Type an address, or let the agent open one.', '还没开网页。输入网址，或者让 Agent 自己打开。')}</p>}
    </div>
  </div>;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}
