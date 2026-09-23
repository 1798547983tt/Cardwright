/**
 * 桌宠 in its own window (ADR 0018, revised 2026-09-23). It draws the pet and its bubble from what the main process sends,
 * tells it when the mouse is over something drawn (everywhere else the mouse goes through to the desktop), and asks it to
 * open what the pet reports (a click), to move the window (a drag), for the menu (right click) or to put the pet away (×).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { X } from 'lucide-react';
import { PET_ROWS, type PetEvent, type PetState, type SpriteLayout } from '../../shared/pets';
import type { PetView } from '../../shared/pet-view';

/** Cells are 192×208; drawn at 120×130, whole pixels, so no frame shows a sliver of the next. */
const SCALE = 0.625;
const POKE_MS = 1400;
const BUBBLE_MS = 6000;
/** A press that moves less than this is a click. */
const DRAG_START = 4;

/** The leading non-empty cells of each row, read from the sheet's alpha; a row that reads empty keeps the published count. */
function countFrames(image: HTMLImageElement, layout: SpriteLayout): number[] {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return PET_ROWS.map(row => row.frames);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return PET_ROWS.map((row, index) => {
    let frames = 0;
    for (let column = 0; column < layout.columns; column++) {
      let filled = false;
      for (let y = 6; y < layout.cellHeight && !filled; y += 10) {
        for (let x = 6; x < layout.cellWidth && !filled; x += 10) {
          const at = ((index * layout.cellHeight + y) * canvas.width + column * layout.cellWidth + x) * 4 + 3;
          if (pixels[at] > 16) filled = true;
        }
      }
      if (!filled) break;
      frames++;
    }
    return frames || row.frames;
  });
}

type Translate = (english: string, chinese: string) => string;
const LINES: Array<[string, string]> = [
  ['I am right here.', '我就在这儿陪着你。'],
  ['Take a sip of water?', '喝口水吧？'],
  ['One step at a time.', '一步一步来。'],
  ['You are doing fine.', '你做得很好。'],
];
const MOOD_LINES: Partial<Record<PetEvent, [string, string]>> = {
  running: ['Still working on it; I am watching.', '还在忙，我替你盯着。'],
  waiting: ['It is waiting for you.', '它在等你点头。'],
  failed: ['Something went wrong. Take a look?', '出了点问题，去看看吧？'],
  complete: ['Done!', '做完啦！'],
  making: ['The card is coming together.', '卡在一点点成形。'],
};
const line = (event: PetEvent, t: Translate, count: number) => {
  const [english, chinese] = MOOD_LINES[event] && count % 2 === 0 ? MOOD_LINES[event]! : LINES[count % LINES.length];
  return t(english, chinese);
};

export function PetWindow() {
  const api = window.cardwrightPet;
  const [view, setView] = useState<PetView | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.view().then(value => { if (value) setView(current => current ?? value); });
    return api.onView(setView);
  }, [api]);

  const petId = view?.petId;
  const [sprite, setSprite] = useState<{ petId: string; url: string; layout: SpriteLayout; frames: number[] } | null>(null);
  useEffect(() => {
    if (!api || !petId) return;
    let alive = true;
    void api.sprite().then(result => {
      if (!result || !alive) return;
      const image = new Image();
      image.onload = () => { if (alive) setSprite({ petId, url: result.dataUrl, layout: result.layout, frames: countFrames(image, result.layout) }); };
      image.src = result.dataUrl;
    }, () => undefined);
    return () => { alive = false; };
  }, [api, petId]);

  // The app's theme, sent with the view, so the bubble matches the window it belongs to.
  const applied = useRef<string[]>([]);
  useEffect(() => {
    if (!view) return;
    const root = document.documentElement;
    root.dataset.theme = view.theme.dataTheme;
    root.lang = view.language === 'zh' ? 'zh-CN' : 'en';
    for (const name of applied.current) root.style.removeProperty(name);
    for (const [name, value] of Object.entries(view.theme.variables)) root.style.setProperty(name, value);
    applied.current = Object.keys(view.theme.variables);
  }, [view?.theme, view?.language]);

  const language = view?.language ?? 'zh';
  const t = useCallback<Translate>((english, chinese) => language === 'zh' ? chinese : english, [language]);
  const event = view?.mood.event ?? 'idle';

  // Hovering over what is drawn catches the mouse; anywhere else it goes through to the desktop.
  const [hovering, setHovering] = useState(false);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    if (!api) return;
    let inside = false;
    const set = (next: boolean) => { if (next === inside) return; inside = next; setHovering(next); api.interactive(next); };
    const moved = (e: MouseEvent) => set(press.current !== null || (e.target instanceof Element && !!e.target.closest('.pet-hit')));
    const left = () => { if (!press.current) set(false); };
    document.addEventListener('mousemove', moved);
    document.documentElement.addEventListener('mouseleave', left);
    return () => { document.removeEventListener('mousemove', moved); document.documentElement.removeEventListener('mouseleave', left); };
  }, [api]);

  const [bubble, setBubble] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [poked, setPoked] = useState<number | null>(null);
  const pokes = useRef(0);
  const lastEvent = useRef(event);
  // A new state is news: the bubble opens by itself for a moment.
  useEffect(() => { if (lastEvent.current === event) return; lastEvent.current = event; if (event !== 'idle') { setSaid(null); setBubble(true); } }, [event]);
  useEffect(() => { if (!bubble) return; const timer = setTimeout(() => setBubble(false), BUBBLE_MS); return () => clearTimeout(timer); }, [bubble, said, event]);
  useEffect(() => { if (poked === null) return; const timer = setTimeout(() => setPoked(null), POKE_MS); return () => clearTimeout(timer); }, [poked]);
  const poke = useCallback(() => { pokes.current += 1; setPoked(Date.now()); setSaid(line(event, t, pokes.current)); setBubble(true); }, [event, t]);
  useEffect(() => api?.onPoke(poke), [api, poke]);

  const [dragging, setDragging] = useState<{ left: boolean } | null>(null);
  function pointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.screenX, y: e.screenY, moved: false };
  }
  function pointerMove(e: PointerEvent<HTMLButtonElement>) {
    const start = press.current;
    if (!start) return;
    const dx = e.screenX - start.x; const dy = e.screenY - start.y;
    if (!start.moved) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      start.moved = true;
      api?.dragStart();
    }
    api?.drag(dx, dy);
    setDragging(current => ({ left: e.movementX < 0 || (e.movementX === 0 && !!current?.left) }));
  }
  /** Ends a press; a drag keeps the spot it reached, even when the pointer capture is lost on the way. */
  function finishPress() {
    const start = press.current; press.current = null;
    if (start?.moved) { setDragging(null); void api?.dragEnd(); }
    return start;
  }
  function pointerUp() {
    const start = finishPress();
    if (start && !start.moved) void api?.open();
  }

  const actions = view?.actions;
  const state: PetState = dragging && actions ? actions[dragging.left ? 'drag-left' : 'drag-right'] : poked !== null && actions ? actions.poke : view?.mood.state ?? 'idle';
  const row = Math.max(0, PET_ROWS.findIndex(item => item.state === state));
  const frames = sprite?.frames[row] ?? PET_ROWS[row].frames;
  const reduced = !!view?.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (reduced || !sprite) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % frames), PET_ROWS[row].loop / frames);
    return () => clearInterval(timer);
  }, [row, frames, reduced, sprite?.petId]);

  if (!view || !sprite || sprite.petId !== view.petId) return null;
  const { layout } = sprite;
  const width = layout.cellWidth * SCALE; const height = layout.cellHeight * SCALE;
  const mood = view.mood;
  const showBubble = bubble || hovering;
  const summary = [mood.title && `${mood.title} · ${mood.status}`, mood.progress].filter(Boolean).join('，');
  return <div className="pet-root" data-pet-state={state} data-pet-event={mood.event} data-dragging={dragging ? '' : undefined}>
    <div className={`pet-bubble${showBubble ? ' pet-hit' : ''}`} role="status" aria-live="polite" hidden={!showBubble}>
      <b>{view.name}</b>
      {said && <p className="pet-line">{said}</p>}
      {mood.title && <p className="pet-task"><span>{mood.title}</span><em>{mood.status}</em></p>}
      {mood.progress && <p className="pet-progress">{mood.progress}</p>}
      <small>{mood.usage}</small>
    </div>
    <div className="pet-body">
      <button type="button" className="pet-sprite pet-hit"
        aria-label={t(`${view.name}, desk pet. ${summary || 'Idle'}. Click to open it in Cardwright; drag to move.`, `${view.name}，桌宠。${summary || '空闲'}。单击在 Cardwright 里打开，拖动换位置。`)}
        style={{ width, height, backgroundImage: `url("${sprite.url}")`, backgroundSize: `${layout.columns * width}px ${layout.rows * height}px`, backgroundPosition: `-${frame * width}px -${row * height}px` }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={() => { finishPress(); }} onLostPointerCapture={() => { finishPress(); }}
        onContextMenu={e => { e.preventDefault(); void api?.menu(); }} />
      <button type="button" className="pet-close pet-hit" aria-label={t('Hide the desk pet', '收起桌宠')} title={t('Hide the desk pet', '收起桌宠')} onClick={() => void api?.hide()}><X size={12} /></button>
    </div>
  </div>;
}
