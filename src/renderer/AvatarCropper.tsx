import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { useApp } from './context';
import { Modal } from './primitives';

const VIEW = 320;
const OUTPUT = 512;

/** Drag and zoom a local image into a square portrait; the main process re-encodes the result. */
export function AvatarCropper({ role, source, onClose }: { role: 'user' | 'assistant'; source: { dataUrl: string; width: number; height: number }; onClose: () => void }) {
  const { api, t, run } = useApp();
  const cover = Math.max(VIEW / source.width, VIEW / source.height);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(() => ({ x: (VIEW - source.width * cover) / 2, y: (VIEW - source.height * cover) / 2 }));
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const scale = cover * zoom;
  const clamp = (x: number, y: number, s = scale) => ({ x: Math.min(0, Math.max(VIEW - source.width * s, x)), y: Math.min(0, Math.max(VIEW - source.height * s, y)) });
  useEffect(() => { setOffset(current => clamp(current.x, current.y)); }, [zoom]);
  function zoomTo(next: number) {
    const bounded = Math.min(4, Math.max(1, next)); const nextScale = cover * bounded; const center = VIEW / 2;
    setOffset(current => clamp(center - (center - current.x) * (nextScale / scale), center - (center - current.y) * (nextScale / scale), nextScale));
    setZoom(bounded);
  }
  const down = (event: PointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; };
  const move = (event: PointerEvent<HTMLDivElement>) => { const start = drag.current; if (!start || start.id !== event.pointerId) return; setOffset(clamp(start.ox + event.clientX - start.x, start.oy + event.clientY - start.y)); };
  const up = () => { drag.current = null; };
  const wheel = (event: WheelEvent<HTMLDivElement>) => zoomTo(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 16 : 4; const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) { event.preventDefault(); const [dx, dy] = moves[event.key]; setOffset(current => clamp(current.x + dx, current.y + dy)); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomTo(zoom + 0.1); }
    if (event.key === '-') { event.preventDefault(); zoomTo(zoom - 0.1); }
  };
  async function save() {
    const element = image.current; if (!element) return;
    setSaving(true);
    const canvas = document.createElement('canvas'); canvas.width = OUTPUT; canvas.height = OUTPUT;
    const context = canvas.getContext('2d'); if (!context) { setSaving(false); return; }
    const k = OUTPUT / VIEW; context.imageSmoothingQuality = 'high';
    context.drawImage(element, offset.x * k, offset.y * k, source.width * scale * k, source.height * scale * k);
    const done = await run(async () => { await api.saveAvatarImage(role, canvas.toDataURL('image/png')); return true; }, t('Avatar updated', '头像已更新'));
    setSaving(false); if (done) onClose();
  }
  return <Modal title={role === 'user' ? t('Crop your avatar', '裁剪你的头像') : t('Crop the AI avatar', '裁剪 AI 头像')} className="avatar-cropper-modal" onClose={() => { if (!saving) onClose(); }}>
    <p className="modal-intro">{t('Drag to position, scroll or use the slider to zoom. Arrow keys move, + and − zoom.', '拖动调整位置，滚轮或滑杆缩放；方向键移动，+ / − 缩放。')}</p>
    <div className="avatar-crop-stage" tabIndex={0} role="application" aria-label={t('Avatar crop area', '头像裁剪区域')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onKeyDown={key} style={{ width: VIEW, height: VIEW }}>
      <img ref={image} src={source.dataUrl} alt="" draggable={false} style={{ width: source.width * scale, height: source.height * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }} />
      <span className="avatar-crop-grid" aria-hidden="true" /><span className="portrait-corners" aria-hidden="true" />
    </div>
    <label className="avatar-crop-zoom"><span>{t('Zoom', '缩放')}</span><input type="range" min={1} max={4} step={0.01} value={zoom} onChange={event => zoomTo(Number(event.target.value))} aria-valuetext={`${Math.round(zoom * 100)}%`} /><b>{Math.round(zoom * 100)}%</b></label>
    <div className="modal-actions"><button type="button" className="button" disabled={saving} onClick={onClose}>{t('Cancel', '取消')}</button><button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? t('Saving…', '保存中…') : t('Use this avatar', '使用这个头像')}</button></div>
  </Modal>;
}
