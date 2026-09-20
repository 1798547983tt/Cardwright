import { useState, type CSSProperties } from 'react';
import { useApp } from './context';
import { Mark } from './primitives';
import { AvatarCropper } from './AvatarCropper';

const memberHues = ['var(--accent)', 'var(--info)', 'var(--success)', 'var(--warning)'];
const hash = (value: string) => Array.from(value).reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 7);

/** Pick a local image, then crop it in the app. Shared by portraits and the appearance settings. */
export function useAvatarChanger(role: 'user' | 'assistant') {
  const { api, run } = useApp();
  const [source, setSource] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const change = () => void run(async () => { const picked = await api.pickAvatarImage(role); if (picked) setSource(picked); });
  return { change, element: source ? <AvatarCropper role={role} source={source} onClose={() => setSource(null)} /> : null };
}

/**
 * A framed portrait. Saved images apply to every message; `interactive` lets the player change it in place.
 * Squad members without their own image get a generated name portrait.
 */
export function Avatar({ role, size = 34, interactive = false, agentName }: { role: 'user' | 'assistant'; size?: number; interactive?: boolean; agentName?: string }) {
  const { data, t } = useApp();
  const changer = useAvatarChanger(role);
  const saved = data.preferences.avatars?.[role];
  const member = role === 'assistant' && agentName ? agentName : undefined;
  const name = role === 'assistant' ? member || 'Cardwright' : data.preferences.name || t('You', '你');
  const style = { '--avatar-size': `${size}px`, ...(member && !saved ? { '--member-hue': memberHues[hash(member) % memberHues.length] } : {}) } as CSSProperties;
  const className = `avatar avatar-${role} portrait is-${role} ${saved ? 'avatar-uploaded' : ''} ${member && !saved ? 'is-member' : ''} ${size >= 64 ? 'is-large' : ''}`;
  const content = <>
    {saved ? <img src={saved} alt={interactive ? '' : name} /> : role === 'assistant' ? member ? <span className="portrait-initial" role="img" aria-label={name}>{Array.from(member.trim())[0]}</span> : <Mark size={Math.round(size * 0.78)} /> : <span className="portrait-initial" role="img" aria-label={interactive ? undefined : name}>{Array.from(name.trim()).slice(0, 2).join('').toLocaleUpperCase()}</span>}
    <span className="portrait-corners" aria-hidden="true" />
  </>;
  if (!interactive) return <span className={className} style={style}>{content}</span>;
  const label = role === 'user' ? t('Change your avatar', '更换你的头像') : t('Change the AI avatar', '更换 AI 头像');
  return <>
    <button type="button" className={`${className} portrait-button`} style={style} aria-label={label} title={label} onClick={changer.change}>
      {content}<span className="portrait-change" aria-hidden="true">{t('Change', '更换')}</span>
    </button>
    {changer.element}
  </>;
}
