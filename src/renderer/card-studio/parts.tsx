import { useEffect, useState, type PointerEvent } from 'react';
import { useApp } from '../context';
import { CoverArt } from './CoverArt';
import type { AppContextValue } from '../context';
import type { CardProjectView, SectionState } from '../../shared/card-studio/types';
import { stylePresetOf } from '../../shared/card-studio/style-presets';

type T = AppContextValue['t'];

export function kindLabel(card: Pick<CardProjectView, 'kind' | 'source'>, t: T): string {
  return card.kind === 'fan' ? t(`Fan card · ${card.source ?? ''}`, `同人 · 《${card.source ?? ''}》`) : t('Original card', '原创');
}

export function stateLabel(state: SectionState, t: T): string {
  return state === 'done' ? t('Done', '已完成') : state === 'active' ? t('In progress', '进行中') : t('Not started', '未开始');
}

/** The preset's page background, main colour and text; 题材自定 has no fixed colours until its design book spec exists. */
export function Swatch({ card, t }: { card: Pick<CardProjectView, 'stylePreset'>; t: T }) {
  const colors = card.stylePreset ? stylePresetOf(card.stylePreset.id)?.swatch : undefined;
  return <span className="cs-swatch">
    <span className="cs-swatch-chips" aria-hidden="true">{colors ? colors.map(color => <i key={color} style={{ background: color }} />) : <i className="is-empty" />}</span>
    <span className="cs-swatch-name">{card.stylePreset ? card.stylePreset.name : t('To be planned', '待规划')}</span>
  </span>;
}

/** A chamfered frame drawn around a 2:3 cover; the stroke animates on hover unless permanent. */
export function CoverStroke({ permanent = false }: { permanent?: boolean }) {
  const points = '12,0 200,0 200,288 188,300 0,300 0,12';
  return <svg className={`cs-stroke ${permanent ? 'is-permanent' : ''}`} viewBox="0 0 200 300" preserveAspectRatio="none" aria-hidden="true">
    <polygon className="base" points={points} /><polygon className="draw" points={points} pathLength={100} /><polygon className="run" points={points} pathLength={100} />
  </svg>;
}

function motionReduced(): boolean {
  const setting = document.documentElement.dataset.motion;
  return setting === 'reduced' || (setting !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

export const tilt = {
  move(event: PointerEvent<HTMLElement>) {
    if (motionReduced()) return;
    const element = event.currentTarget; const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width; const y = (event.clientY - box.top) / box.height;
    element.classList.add('is-tilting');
    element.style.setProperty('--ry', `${((x - 0.5) * 12).toFixed(2)}deg`); element.style.setProperty('--rx', `${((0.5 - y) * 10).toFixed(2)}deg`);
    element.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`); element.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  },
  leave(event: PointerEvent<HTMLElement>) {
    const element = event.currentTarget;
    element.classList.remove('is-tilting'); element.style.removeProperty('--rx'); element.style.removeProperty('--ry');
  },
};

const coverImages = new Map<string, string | null>();

/** The cover of one card: the uploaded image when there is one, the text cover otherwise. */
export function CardCover({ card, className }: { card: Pick<CardProjectView, 'projectId' | 'cover' | 'updatedAt' | 'coverStyle' | 'name' | 'kind' | 'source'>; className?: string }) {
  const { api } = useApp();
  const key = `${card.projectId}:${card.updatedAt}`;
  const [image, setImage] = useState<string | null>(() => coverImages.get(key) ?? null);
  useEffect(() => {
    if (!card.cover) { setImage(null); return; }
    if (coverImages.has(key)) { setImage(coverImages.get(key) ?? null); return; }
    let alive = true;
    void api.readCardCover(card.projectId).then(value => { coverImages.set(key, value); if (alive) setImage(value); }, () => undefined);
    return () => { alive = false; };
  }, [api, card.projectId, card.cover, key]);
  return <CoverArt style={card.coverStyle} name={card.name} kind={card.kind} source={card.source} cover={card.cover ? image : null} className={className ?? ''} />;
}

/** Re-renders relative times once a minute. */
export function useNow(interval = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}
