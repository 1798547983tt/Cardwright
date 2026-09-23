import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { resolveTheme, type ResolvedTheme } from '../shared/themes';
import type { AppearanceSnapshot, Bridge, Preferences } from '../shared/types';

/** The window's light or dark setting, for 跟随系统. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return dark;
}

/**
 * Puts the chosen theme on the document (ADR 0018): `data-theme` for the built-in token blocks, a pack's colours as
 * inline variables over its base, `data-studio-tint` when the theme brings its own accent, and a pack's background.
 */
export function useThemeApplication(api: Bridge | undefined, preferences: Preferences | undefined, packs: AppearanceSnapshot['themes']): ResolvedTheme | null {
  const systemDark = useSystemDark();
  const resolved = useMemo(() => preferences ? resolveTheme(preferences.theme, { systemDark, packs }) : null, [preferences?.theme, systemDark, packs]);
  const applied = useRef<string[]>([]);
  useEffect(() => {
    if (!resolved) return;
    const root = document.documentElement;
    root.dataset.theme = resolved.dataTheme;
    root.dataset.themeId = resolved.id;
    for (const name of applied.current) root.style.removeProperty(name);
    for (const [name, value] of Object.entries(resolved.variables)) root.style.setProperty(name, value);
    applied.current = Object.keys(resolved.variables);
    if (resolved.dataTheme === 'sakura' || resolved.theme.colors.accent) root.dataset.studioTint = '';
    else delete root.dataset.studioTint;
  }, [resolved]);
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => { root.style.removeProperty('--theme-background'); delete root.dataset.themeBackground; };
    if (!api || !resolved?.theme.background) { clear(); return; }
    let alive = true;
    void api.themeBackground(resolved.id).then(url => {
      if (!alive) return;
      root.style.setProperty('--theme-background', `url("${url}")`);
      root.dataset.themeBackground = '';
    }, clear);
    return () => { alive = false; };
  }, [api, resolved?.id, resolved?.theme.background]);
  return resolved;
}

/**
 * 登场动画: a short fall of petals for 红粉白, a wash of the accent for a pack that asks for it. It plays when such a
 * theme is chosen and when the window opens with it, and never under reduced motion.
 */
export function ThemeEntrance({ theme, reduced }: { theme: ResolvedTheme | null; reduced: boolean }) {
  const [play, setPlay] = useState<{ id: string; key: number } | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!theme || last.current === theme.id) return;
    last.current = theme.id;
    if (theme.theme.entrance && !reduced) setPlay({ id: theme.id, key: Date.now() });
  }, [theme?.id, reduced]);
  useEffect(() => {
    if (!play) return;
    const timer = setTimeout(() => setPlay(null), 2400);
    return () => clearTimeout(timer);
  }, [play]);
  if (!play) return null;
  const petals = play.id === 'sakura';
  return <div key={play.key} className={`theme-entrance ${petals ? 'is-petals' : 'is-wash'}`} aria-hidden="true" data-theme-entrance={play.id}>
    {petals && Array.from({ length: 16 }, (_, index) => <i key={index} style={{ '--petal': index } as CSSProperties} />)}
  </div>;
}
