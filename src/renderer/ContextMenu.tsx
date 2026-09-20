import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextAction { label: string; icon?: ReactNode; action: () => void; disabled?: boolean; separator?: boolean }
export interface MenuPosition { x: number; y: number; origin: HTMLElement }

/** Row menus escape scroll containers and share pointer and keyboard behavior. */
export function ContextMenu({ position, actions, onClose, label }: { position: MenuPosition; actions: ContextAction[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x: position.x, y: position.y });
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current!; const rect = panel.getBoundingClientRect();
    setPoint({ x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)) });
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); if (document.activeElement === document.body || panel.contains(document.activeElement)) position.origin.focus(); };
  }, [position]);
  return createPortal(<div ref={ref} className="context-menu" role="menu" aria-label={label} style={{ left: point.x, top: point.y }} onKeyDown={event => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); onClose(); position.origin.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
  }}>{actions.map((entry, index) => <div key={`${entry.label}-${index}`}>{entry.separator && <div className="menu-divider" role="separator" />}<button role="menuitem" className="menu-item" disabled={entry.disabled} onClick={() => { onClose(); position.origin.focus(); entry.action(); }}>{entry.icon}<span>{entry.label}</span></button></div>)}</div>, document.body);
}
