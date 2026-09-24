import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';
import type { Task } from '../../shared/types';

/** 减少动态效果 is on, or the app follows the system and the system asks for less motion. */
export function motionReduced(): boolean {
  const setting = document.documentElement.dataset.motion;
  return setting === 'reduced' || (setting !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** How close to the bottom still counts as reading the latest. */
const NEAR = 96;

/**
 * Follows the newest content of a scrolling column (handoff §5.5 ⑤). While the reader is at the bottom, every change
 * eases the view down over a few frames, re-aiming at the bottom each frame as the reply grows; under reduced motion it
 * moves at once. Scrolling up lets go, and it follows again once the reader is back at the bottom (回到最新 does that).
 * A new `resetKey` (another conversation) starts at the bottom.
 */
export function useFollowScroll(scroller: RefObject<HTMLElement | null>, deps: DependencyList, resetKey?: unknown): void {
  const follow = useRef(true);
  // Let go by a gesture: only the very bottom picks the reader up again, not just "near" it.
  const detached = useRef(false);
  const frame = useRef(0);
  // The position the last eased step set, so its own scroll event is not taken for the reader's.
  const expected = useRef<number | null>(null);
  const stop = () => { if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; };

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let touchY = 0;
    const letGo = () => { detached.current = true; follow.current = false; stop(); };
    const onScroll = () => {
      const top = element.scrollTop;
      if (expected.current !== null && Math.abs(top - expected.current) <= 1.5) return;
      expected.current = null;
      const distance = element.scrollHeight - top - element.clientHeight;
      follow.current = distance <= (detached.current ? 4 : NEAR);
      if (follow.current) detached.current = false; else stop();
    };
    // A box inside the column that scrolls up itself (the live thinking, a long tool output) keeps the column following.
    const innerScrolls = (target: EventTarget | null) => {
      for (let node = target instanceof HTMLElement ? target : null; node && node !== element; node = node.parentElement) {
        if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return true;
      }
      return false;
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0 && !innerScrolls(event.target)) letGo(); };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const onTouchMove = (event: TouchEvent) => { if ((event.touches[0]?.clientY ?? 0) > touchY + 4) letGo(); };
    // A press on the column's own scrollbar (right of its content box) takes over the scrolling.
    const onPointerDown = (event: PointerEvent) => { if (event.target === element && event.offsetX >= element.clientWidth) letGo(); };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('pointerdown', onPointerDown);
    return () => {
      stop();
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('pointerdown', onPointerDown);
    };
  }, [scroller]);

  useLayoutEffect(() => {
    follow.current = true; detached.current = false; stop();
    const jump = () => {
      const element = scroller.current;
      if (element) { element.scrollTop = element.scrollHeight; expected.current = element.scrollTop; }
    };
    if (scroller.current) { jump(); return; }
    // A column owned by a parent gets its ref after this child's layout effects; jump before the next paint instead.
    const next = requestAnimationFrame(jump);
    return () => cancelAnimationFrame(next);
  }, [resetKey, scroller]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !follow.current) return;
    if (motionReduced()) { element.scrollTop = element.scrollHeight; expected.current = element.scrollTop; return; }
    if (frame.current) return;
    const step = () => {
      frame.current = 0;
      const current = scroller.current;
      if (!current || !follow.current) return;
      const target = current.scrollHeight - current.clientHeight;
      const gap = target - current.scrollTop;
      if (gap <= 1) return;
      // A long way down (a burst of text, a new conversation) is not worth watching go by.
      current.scrollTop = gap > current.clientHeight ? target : current.scrollTop + Math.max(1, Math.ceil(gap * 0.22));
      expected.current = current.scrollTop;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, deps);
}

/**
 * The records a conversation already had when it was opened (or switched to another version). Anything not in the set
 * arrived while the reader watched, and only that fades in; history, including older pages, appears as it is.
 */
export function useArrivals(key: string, task: Pick<Task, 'messages' | 'tools'>): ReadonlySet<string> {
  const known = useRef<{ key: string; ids: Set<string> } | null>(null);
  if (!known.current || known.current.key !== key) known.current = { key, ids: new Set([...task.messages.map(item => item.id), ...task.tools.map(item => item.id)]) };
  return known.current.ids;
}
