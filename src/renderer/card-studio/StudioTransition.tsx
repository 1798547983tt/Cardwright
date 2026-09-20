import { useEffect, useRef, type CSSProperties } from 'react';
import { BOARDS } from '../../shared/card-studio/boards';

export type TransitionDirection = 'in' | 'out';
export interface TransitionOrigin { left: number; top: number; width: number; height: number }

/** 「卷宗展开」: about 1.8 s, skippable by click or any key; reduced motion turns it into a 0.3 s fade. */
export function StudioTransition({ direction, origin, reduced, language, onSwap, onDone }: { direction: TransitionDirection; origin: TransitionOrigin | null; reduced: boolean; language: 'en' | 'zh'; onSwap: () => void; onDone: () => void }) {
  const swapped = useRef(false); const done = useRef(false);
  const callbacks = useRef({ onSwap, onDone }); callbacks.current = { onSwap, onDone };
  const finish = useRef(() => {});
  finish.current = () => {
    if (done.current) return;
    if (!swapped.current) { swapped.current = true; callbacks.current.onSwap(); }
    done.current = true; callbacks.current.onDone();
  };
  useEffect(() => {
    const swapAt = reduced ? 150 : direction === 'in' ? 1150 : 900;
    const total = reduced ? 300 : 1800;
    const swap = setTimeout(() => { if (!swapped.current) { swapped.current = true; callbacks.current.onSwap(); } }, swapAt);
    const end = setTimeout(() => finish.current(), total);
    const skip = (event: KeyboardEvent) => { event.preventDefault(); event.stopPropagation(); finish.current(); };
    window.addEventListener('keydown', skip, true);
    return () => { clearTimeout(swap); clearTimeout(end); window.removeEventListener('keydown', skip, true); };
  }, []);
  const box = origin ?? { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2 };
  const style = { '--ox': `${Math.round(box.left)}px`, '--oy': `${Math.round(box.top)}px`, '--ow': `${Math.round(box.width)}px`, '--oh': `${Math.round(box.height)}px`, '--vw': `${innerWidth}px`, '--vh': `${innerHeight}px` } as CSSProperties;
  const zh = language === 'zh';
  return <div className={`studio-transition tx-${direction} ${reduced ? 'is-reduced' : ''}`} style={style} role="presentation" onClick={() => finish.current()}>
    {!reduced && (direction === 'in'
      ? <>
        <div className="tx-ink" /><i className="tx-line t" /><i className="tx-line b" /><i className="tx-line l" /><i className="tx-line r" />
        <div className="tx-title"><span>CARD STUDIO · 角色卡工坊</span><b>{zh ? '制卡工坊' : 'Card studio'}</b><em className="tx-dots">{BOARDS.map((board, index) => <i key={board.id} style={{ '--c': board.color, '--i': index } as CSSProperties} />)}</em></div>
        <div className="tx-door l" /><div className="tx-door r" />
      </>
      : <>
        <div className="tx-door l" /><div className="tx-door r" />
        <div className="tx-title"><span>WORKBENCH · 工作台</span><b>{zh ? '返回工作台' : 'Back to workspace'}</b></div>
        <div className="tx-ink" />
      </>)}
    {!reduced && <small className="tx-skip">{zh ? '点击或按任意键跳过' : 'Click or press any key to skip'}</small>}
  </div>;
}
