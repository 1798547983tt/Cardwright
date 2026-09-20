import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronDown } from 'lucide-react';

/** Chamfered signal tile with an angular C; scripts/build.mjs mirrors this geometry for the app icons. */
export const MARK_TILE = 'M16 4H60V48L48 60H4V16Z';
export const MARK_LETTER = 'M47 17H26L17 26V38L26 47H47V39H30L25 34V30L30 25H47Z';
export function Mark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <svg aria-hidden="true" className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" fill="none"><path d={MARK_TILE} fill="currentColor" /><path d={MARK_LETTER} fill="#111111" /><path d="M51 9h4v4h-4z" fill="#111111" /></svg>;
}
export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} className={`icon-button ${className}`} {...props}>{children}</button>;
}
export function Modal({ title, children, onClose, className = '', labelled = true }: { title: string; children: ReactNode; onClose: () => void; className?: string; labelled?: boolean }) {
  const id = useId(); const panel = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const selectors = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
    requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('[autofocus],input:not(:disabled):not([type="checkbox"]):not([type="radio"]),textarea:not(:disabled),select:not(:disabled)') || panel.current?.querySelector<HTMLElement>(selectors) || panel.current)?.focus());
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>(selectors) || [])].filter(el => el.getClientRects().length);
        const first = items[0]; const last = items[items.length - 1];
        if (!first) { event.preventDefault(); panel.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className={`modal ${className}`}>
    <h2 id={id} className={labelled ? 'modal-title' : 'sr-only'}>{title}</h2><IconButton label="Close / 关闭" className="modal-close" onClick={onClose}><X size={21} /></IconButton>{children}
  </div></div>, document.body);
}
export function Popover({ label, trigger, children, className = '', align = 'left' }: { label: string; trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => {
    if (!open) return;
    function outside(e: PointerEvent) { if (!root.current?.contains(e.target as Node)) setOpen(false); }
    function key(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return <div ref={root} className={`popover-root ${className}`}><button ref={button} type="button" className="popover-trigger" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>{trigger}</button>{open && <div id={id} className={`popover popover-${align}`} role="group" aria-label={label}>{typeof children === 'function' ? children(() => { setOpen(false); button.current?.focus(); }) : children}</div>}</div>;
}
export function MenuItem({ children, selected, onClick, disabled = false, className = '' }: { children: ReactNode; selected?: boolean; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button className={`menu-item ${className}`} type="button" disabled={disabled} aria-pressed={selected} onClick={onClick}><span>{children}</span>{selected && <Check size={16} className="selected-check" />}</button>;
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className="toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
export function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-row-copy"><span className="setting-label">{title}</span>{description && <p>{description}</p>}</div><div className="setting-control">{children}</div></div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Empty({ icon, title, text, children }: { icon?: ReactNode; title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}<h3>{title}</h3><p>{text}</p>{children}</div>;
}
export const Down = () => <ChevronDown size={14} />;
