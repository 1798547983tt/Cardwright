import type { CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { useApp } from '../context';
import { runIsOpen } from '../../shared/card-studio/run';
import { relativeTime } from '../../shared/card-studio/view';
import { CardCover, useNow } from './parts';

/** The card studio entry in the workbench deck: purpose, the way in, and a fan of the three most recently edited covers. */
export function StudioEntry() {
  const { data, t, openStudio } = useApp();
  const now = useNow();
  if (!openStudio) return null;
  const cards = [...(data.cardStudio?.cards ?? [])].sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
  const latest = cards[0];
  const making = cards.find(card => runIsOpen(card.run));
  const run = making?.run;
  const enter = (element: HTMLElement) => openStudio(element.closest<HTMLElement>('.studio-entry') ?? element);
  return <section className="studio-entry reveal-5" aria-label={t('Card studio', '制卡工坊')}>
    <div className="studio-entry-copy">
      <span className="studio-entry-kicker">CARD STUDIO · {t('SEPARATE MODE', '独立模式')}</span>
      <h2>{t('Card studio', '制卡工坊')}</h2>
      <p>{t('Plan with AI step by step and turn your material into a SillyTavern character card.', '跟着规划 AI 一步一步，把资料做成一张 SillyTavern 角色卡。')}</p>
      {making && run && <p className={`studio-entry-run is-${run.status}`} role="status"><i aria-hidden="true" />{run.status === 'paused'
        ? t(`One-click making paused: ${making.name}. Continue it in the studio.`, `一键制作已暂停：「${making.name}」，进工坊点【继续】。`)
        : t(`One-click making: ${making.name} · ${run.done.length} of ${run.total} done`, `一键制作中：「${making.name}」· 已完成 ${run.done.length} / ${run.total} 条`)}</p>}
      <div className="studio-entry-actions">
        <button type="button" className="studio-entry-go" onClick={event => enter(event.currentTarget)}>{t('Enter the studio', '进入工坊')}<ArrowRight size={15} /></button>
        <small>{latest
          ? t(`${cards.length} card projects · last edited: ${latest.name}, ${relativeTime(latest.lastEditedAt, now, 'en')}`, `${cards.length} 张卡项目 · 最近编辑「${latest.name}」${relativeTime(latest.lastEditedAt, now, 'zh')}`)
          : t('No card projects yet', '还没有卡项目')}</small>
      </div>
    </div>
    <button type="button" className="studio-entry-fan" tabIndex={-1} aria-hidden="true" onClick={event => enter(event.currentTarget)}>
      {cards.length ? cards.slice(0, 3).map((card, index) => <span key={card.projectId} className="studio-entry-cover" style={{ '--i': index } as CSSProperties}><CardCover card={card} /></span>)
        : [0, 1, 2].map(index => <span key={index} className="studio-entry-cover"><i className="studio-entry-blank" /></span>)}
    </button>
  </section>;
}
