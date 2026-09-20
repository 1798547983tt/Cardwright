import { useEffect, useRef, useState } from 'react';
import { Mark } from './primitives';
import { playCue } from './sound';

/** Plays once per renderer load (application start). Restoring from the tray keeps the page and never replays it. */
export function BootSequence({ language, reducedMotion, onDone }: { language: 'en' | 'zh'; reducedMotion: boolean; onDone: () => void }) {
  const [done, setDone] = useState(false);
  const finished = useRef(false); const callback = useRef(onDone); callback.current = onDone;
  useEffect(() => {
    const finish = () => {
      if (finished.current) return; finished.current = true;
      setDone(true); callback.current(); playCue('boot');
    };
    if (reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches) { finished.current = true; setDone(true); callback.current(); return; }
    const timer = setTimeout(finish, 1500);
    window.addEventListener('keydown', finish, true);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', finish, true); };
  }, []);
  return <div className={`boot-overlay ${done ? 'is-done' : ''}`} aria-hidden="true" onClick={() => { if (!finished.current) { finished.current = true; setDone(true); callback.current(); playCue('boot'); } }}>
    <div className="boot-core">
      <span className="boot-mark"><Mark size={84} /></span>
      <div className="boot-text"><b>CARDWRIGHT</b><small>{language === 'zh' ? '本地 Agent 工作室 · 正在载入' : 'LOCAL AGENT STUDIO · LOADING'}</small></div>
      <div className="boot-bar"><i /></div>
    </div>
    <div className="boot-scan" />
    <small className="boot-skip">{language === 'zh' ? '点击或按任意键跳过' : 'Click or press any key to skip'}</small>
  </div>;
}
