import type { CardKind, CoverStyleId } from '../../shared/card-studio/types';
import { coverFit } from '../../shared/card-studio/view';

/** Text cover drawn with CSS only. It shows real card data: the name, and the source work or 原创. Long names step down in size. */
export function CoverArt({ style, name, kind, source, className = '', cover }: { style: CoverStyleId; name: string; kind: CardKind; source?: string; className?: string; cover?: string | null }) {
  const sub = kind === 'fan' ? `《${source || '原作'}》` : '原创';
  const kindWord = kind === 'fan' ? '同人' : '原创';
  const base = `studio-cover cv-${style} cv-fit-${coverFit(name)} ${className}`;
  // An uploaded image always wins over the text cover (handoff §3.6).
  if (cover) return <div className={`studio-cover cv-photo ${className}`} aria-hidden="true"><img src={cover} alt="" /></div>;
  switch (style) {
    case 'archive': return <div className={base} aria-hidden="true"><span className="cv-ghost">ARCHIVE</span><span className="cv-code">档案 // {kindWord}卡</span><i className="cv-dots" /><b className="cv-title">{name}</b><small className="cv-sub">{sub}</small><i className="cv-bar" /></div>;
    case 'terminal': return <div className={base} aria-hidden="true"><span className="cv-tag">[ 角色卡 ]</span><span className="cv-page">[ {kindWord} ]</span><i className="cv-hatch" /><i className="cv-cross" /><b className="cv-title">{name}</b><small className="cv-sub">{sub}</small></div>;
    case 'theatre': return <div className={base} aria-hidden="true"><i className="cv-orbit" /><i className="cv-orbit b" /><i className="cv-star" /><span className="cv-tagline">剧院 · THÉÂTRE</span><b className="cv-title">{name}</b><small className="cv-sub">{sub}</small><i className="cv-grain" /></div>;
    case 'gilded': return <div className={base} aria-hidden="true"><i className="cv-frame" /><i className="cv-oval" /><span className="cv-no">CARD · 角色卡</span><b className="cv-title">{name}</b><small className="cv-sub">{sub}</small><span className="cv-stamp">{kindWord}</span></div>;
    default: return <div className={base} aria-hidden="true"><i className="cv-sun" /><i className="cv-rules" /><b className="cv-title">{name}</b><small className="cv-sub">{sub}</small><span className="cv-seal">{kindWord}</span></div>;
  }
}
