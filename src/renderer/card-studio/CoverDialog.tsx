import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { COVER_HEIGHT, COVER_WIDTH, drawCover } from './cover-canvas';
import type { CardProjectView, CoverSaveRequest, CoverSource } from '../../shared/card-studio/types';

const VIEW_WIDTH = 280;
const VIEW_HEIGHT = VIEW_WIDTH * COVER_HEIGHT / COVER_WIDTH;
/** The output sizes the dialog offers; the largest is the 4K ceiling for a 2:3 portrait. */
const OUTPUTS = [
  { label: '标准 960×1440', width: 960, height: 1440 },
  { label: '高清 1920×2880', width: 1920, height: 2880 },
  { label: '超清 2560×3840', width: 2560, height: 3840 },
];
const QUALITY_DEFAULT = 85;
const clean = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Upload and crop a 2:3 cover, or fall back to the text cover the card was created with.
    The crop itself runs in the main process on the retained original, so neither the
    source nor the encoded result ever crosses the IPC channel. */
export function CoverDialog({ card, onClose }: { card: CardProjectView; onClose: () => void }) {
  const { api, t, run } = useApp();
  const [source, setSource] = useState<CoverSource | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [output, setOutput] = useState(0);
  const [quality, setQuality] = useState(QUALITY_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  const cover = source ? Math.max(VIEW_WIDTH / source.width, VIEW_HEIGHT / source.height) : 1;
  const scale = cover * zoom;
  const clamp = (x: number, y: number, size = scale) => source
    ? { x: Math.min(0, Math.max(VIEW_WIDTH - source.width * size, x)), y: Math.min(0, Math.max(VIEW_HEIGHT - source.height * size, y)) }
    : { x, y };

  useEffect(() => {
    if (source || !preview.current) return;
    const context = preview.current.getContext('2d');
    if (context) drawCover(context, { style: card.coverStyle, name: card.name, kind: card.kind, source: card.source });
  }, [source, card.coverStyle, card.name, card.kind, card.source]);
  useEffect(() => { setOffset(current => clamp(current.x, current.y)); }, [zoom, source]);

  const release = (picked: CoverSource | null) => { if (picked) void api.releaseCardCoverSource(picked.sourceId).catch(() => undefined); };
  useEffect(() => () => release(source), [source]);

  async function choose() {
    setError('');
    try {
      const picked = await api.pickCardCover();
      if (!picked) return;
      release(source);
      setSource(picked);
      setZoom(1);
      const fit = Math.max(VIEW_WIDTH / picked.width, VIEW_HEIGHT / picked.height);
      setOffset({ x: (VIEW_WIDTH - picked.width * fit) / 2, y: (VIEW_HEIGHT - picked.height * fit) / 2 });
    } catch (reason) { setError(clean(reason)); }
  }
  async function save() {
    const element = image.current;
    if (!element || !source) return;
    setBusy(true);
    // The displayed rectangle, scaled back into the source image's own pixels.
    const x = Math.round(-offset.x / scale);
    const y = Math.round(-offset.y / scale);
    const width = Math.round(VIEW_WIDTH / scale);
    const height = Math.round(VIEW_HEIGHT / scale);
    const request: CoverSaveRequest = { sourceId: source.sourceId, crop: { x, y, width, height }, output: OUTPUTS[output], quality };
    const done = await run(() => api.saveCardCover(card.projectId, request), t('Cover saved', '封面已保存'));
    setBusy(false);
    if (done) { setSource(null); onClose(); }
  }
  async function clear() {
    setBusy(true);
    const done = await run(() => api.clearCardCover(card.projectId), t('Back to the text cover', '已改回文字封面'));
    setBusy(false);
    if (done) onClose();
  }

  const down = (event: PointerEvent<HTMLDivElement>) => { if (!source) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; };
  const move = (event: PointerEvent<HTMLDivElement>) => { const start = drag.current; if (!start || start.id !== event.pointerId) return; setOffset(clamp(start.ox + event.clientX - start.x, start.oy + event.clientY - start.y)); };
  const up = () => { drag.current = null; };
  const wheel = (event: WheelEvent<HTMLDivElement>) => { if (source) setZoom(current => Math.min(4, Math.max(1, current * (event.deltaY < 0 ? 1.08 : 1 / 1.08)))); };

  return <Modal title={t('Card cover', '卡的封面')} className="studio-modal cs-cover-modal" onClose={() => { if (!busy) onClose(); }}>
    <p className="modal-intro">{t('An uploaded image always wins. Without one the card keeps the text cover it was created with; the cover itself may be up to 4K.', '优先用上传的图片；没有上传时用新建时选定的文字封面。封面支持 300px 至 4K（最长边 3840）的任意分辨率。')}</p>
    <div className="cs-cover-stage" tabIndex={0} role="application" aria-label={t('Cover crop area', '封面裁剪区域')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} style={{ width: VIEW_WIDTH, height: VIEW_HEIGHT }}>
      {source
        ? <img ref={image} src={source.dataUrl} alt="" draggable={false} style={{ width: source.width * scale, height: source.height * scale, transform: `translate(${offset.x}px, ${offset.y}px)` }} />
        : <canvas ref={preview} width={COVER_WIDTH} height={COVER_HEIGHT} style={{ width: VIEW_WIDTH, height: VIEW_HEIGHT }} />}
    </div>
    {source && <label className="cs-cover-zoom"><span>{t('Zoom', '缩放')}</span><input type="range" min={1} max={4} step={0.01} value={zoom} onChange={event => setZoom(Number(event.target.value))} /><b>{Math.round(zoom * 100)}%</b></label>}
    {source && <label className="cs-cover-zoom"><span>{t('Size', '尺寸')}</span>
      <select className="cs-cover-size" value={output} onChange={event => setOutput(Number(event.target.value))}>
        {OUTPUTS.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}
      </select>
      <b>{OUTPUTS[output].height}p</b>
    </label>}
    {source && <label className="cs-cover-zoom"><span>{t('Quality', '画质')}</span><input type="range" min={60} max={100} step={1} value={quality} onChange={event => setQuality(Number(event.target.value))} /><b>{quality === 100 ? 'PNG' : `JPEG ${quality}%`}</b></label>}
    {error && <p className="cs-form-error" role="alert">{error}</p>}
    <div className="modal-actions">
      <button type="button" className="cs-btn" disabled={busy} onClick={() => void choose()}><ImageUp size={14} />{source ? t('Choose another image', '换一张图片') : t('Upload an image', '上传图片')}</button>
      {card.cover && !source && <button type="button" className="cs-btn is-danger" disabled={busy} onClick={() => void clear()}><Trash2 size={14} />{t('Remove the image', '删除图片')}</button>}
      <button type="button" className="cs-btn" disabled={busy} onClick={onClose}>{t('Close', '关闭')}</button>
      {source && <button type="button" className="cs-btn is-primary" disabled={busy} onClick={() => void save()}>{busy ? t('Saving…', '保存中…') : t('Use this cover', '使用这张封面')}</button>}
    </div>
  </Modal>;
}
