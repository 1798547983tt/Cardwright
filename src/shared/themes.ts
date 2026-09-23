/**
 * 主题 (Q15, Q20, ADR 0018): a theme is a set of workbench colours. The three built-in ones live in tokens.css; a 主题包
 * in `<资料目录>/themes/<id>/theme.json` starts from the dark or light one and changes colours, the pet, a background
 * and the entrance. Layout, type sizes and control shapes belong to the workbench and are not a theme's to change.
 */
import { PET_EVENTS, PET_ID, PET_STATES, type PetEvent, type PetState } from './pets.ts';

export type ThemeBase = 'dark' | 'light';
export const THEME_COLOR_KEYS = ['canvas', 'rail', 'railText', 'panel', 'panel2', 'panel3', 'line', 'lineStrong', 'text', 'muted', 'dim', 'accent', 'accentInk', 'info', 'success', 'warning', 'danger'] as const;
export type ThemeColorKey = typeof THEME_COLOR_KEYS[number];
export interface ThemePet { id?: string; actions?: Partial<Record<PetEvent, PetState>> }
export interface ThemeDefinition {
  id: string; name: string; base: ThemeBase; builtIn?: boolean;
  colors: Partial<Record<ThemeColorKey, string>>;
  /** A picture in the theme folder, shown faintly behind the conversation. */
  background?: string;
  /** Plays the theme's short entrance when it is chosen or the window opens; never under reduced motion. */
  entrance?: boolean;
  pet?: ThemePet;
  /** Canvas, accent and text, for the theme picker. */
  swatch: [string, string, string];
}

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  { id: 'dark', name: '深色', base: 'dark', builtIn: true, colors: {}, swatch: ['#111316', '#d4b856', '#e4e7eb'] },
  { id: 'light', name: '浅色', base: 'light', builtIn: true, colors: {}, swatch: ['#f3f2ee', '#8a7420', '#1a1c1f'] },
  { id: 'sakura', name: '红粉白', base: 'light', builtIn: true, colors: {}, entrance: true, pet: { id: 'erii' }, swatch: ['#fbf6f5', '#d0386a', '#8a1c2b'] },
];
const RESERVED = new Set(['system', ...BUILT_IN_THEMES.map(theme => theme.id)]);
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ResolvedTheme { id: string; dataTheme: string; theme: ThemeDefinition; variables: Record<string, string>; missing?: boolean }

/** The theme to apply for a preference: 跟随系统 picks dark or light; a pack that has gone falls back to dark. */
export function resolveTheme(preference: string, context: { systemDark: boolean; packs: readonly ThemeDefinition[] }): ResolvedTheme {
  const id = preference === 'system' ? context.systemDark ? 'dark' : 'light' : preference;
  const builtIn = BUILT_IN_THEMES.find(theme => theme.id === id);
  if (builtIn) return { id, dataTheme: id, theme: builtIn, variables: {} };
  const pack = context.packs.find(theme => theme.id === id);
  if (pack) return { id, dataTheme: pack.base, theme: pack, variables: themeVariables(pack) };
  return { id: 'dark', dataTheme: 'dark', theme: BUILT_IN_THEMES[0], variables: {}, missing: true };
}

const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/deg]+\))$/i;
const IMAGE = /^[^\\/:*?"<>|]+\.(png|jpe?g|webp)$/i;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Reads one theme.json. A pack that is not right is refused with a reason the settings page can show. */
export function parseThemePack(json: string, context: { folder: string; files: readonly string[] }): { theme: ThemeDefinition } | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(json.replace(/^\uFEFF/, '')); } catch { return { error: 'theme.json 不是合法的 JSON。' }; }
  if (!plain(raw)) return { error: 'theme.json 应该是一个对象。' };
  const id = raw.id;
  if (typeof id !== 'string' || id !== context.folder) return { error: `主题 id「${String(id ?? '')}」要和它的文件夹名「${context.folder}」一致。` };
  if (RESERVED.has(id)) return { error: `「${id}」是内置主题的名字，换一个文件夹名和 id。` };
  if (!THEME_ID.test(id)) return { error: '主题 id 只能用小写字母、数字和 -，最长 40 个字符。' };
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 40) return { error: '缺少主题名称（name），或超过 40 个字。' };
  if (raw.base !== 'dark' && raw.base !== 'light') return { error: 'base 只能是 dark 或 light：主题从这两套里的一套开始改。' };
  const colors = raw.colors ?? {};
  if (!plain(colors)) return { error: 'colors 应该是一个对象。' };
  const foreign = Object.keys(colors).filter(key => !(THEME_COLOR_KEYS as readonly string[]).includes(key));
  if (foreign.length) return { error: `这些项主题不能改：${foreign.join('、')}。主题只能改颜色（${THEME_COLOR_KEYS.join('、')}），布局、字号和控件形状不变。` };
  for (const [key, value] of Object.entries(colors)) if (typeof value !== 'string' || !COLOR.test(value.trim())) return { error: `颜色 ${key} 的值「${String(value)}」不是颜色：用 #rrggbb、rgb() 或 hsl()。` };
  const theme: ThemeDefinition = { id, name: raw.name.trim(), base: raw.base, colors: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, String(value).trim()])), swatch: ['', '', ''] };
  if (raw.background !== undefined) {
    if (typeof raw.background !== 'string' || !IMAGE.test(raw.background)) return { error: '背景图要是主题文件夹里的一张 .png、.jpg 或 .webp，只写文件名。' };
    if (!context.files.includes(raw.background)) return { error: `找不到背景图 ${raw.background}。` };
    theme.background = raw.background;
  }
  if (raw.entrance !== undefined) {
    if (typeof raw.entrance !== 'boolean') return { error: 'entrance 只能是 true 或 false。' };
    theme.entrance = raw.entrance;
  }
  if (raw.pet !== undefined) {
    if (!plain(raw.pet)) return { error: 'pet 应该是一个对象：{ "id": 宠物 id, "actions": 动作表 }。' };
    const pet: ThemePet = {};
    if (raw.pet.id !== undefined) {
      if (typeof raw.pet.id !== 'string' || !PET_ID.test(raw.pet.id)) return { error: 'pet.id 不是合法的宠物 id。' };
      pet.id = raw.pet.id;
    }
    if (raw.pet.actions !== undefined) {
      if (!plain(raw.pet.actions)) return { error: 'pet.actions 应该是一个对象：事件 → 动作。' };
      const actions: Partial<Record<PetEvent, PetState>> = {};
      for (const [event, state] of Object.entries(raw.pet.actions)) {
        if (!(PET_EVENTS as readonly string[]).includes(event)) return { error: `动作表里的事件「${event}」不认识，可用的有：${PET_EVENTS.join('、')}。` };
        if (typeof state !== 'string' || !(PET_STATES as readonly string[]).includes(state)) return { error: `动作「${String(state)}」不是桌宠包里的动作，可用的有：${PET_STATES.join('、')}。` };
        actions[event as PetEvent] = state as PetState;
      }
      pet.actions = actions;
    }
    theme.pet = pet;
  }
  const base = BUILT_IN_THEMES.find(item => item.id === theme.base)!;
  theme.swatch = [theme.colors.canvas ?? base.swatch[0], theme.colors.accent ?? base.swatch[1], theme.colors.text ?? base.swatch[2]];
  return { theme };
}

/** The workbench variables each theme colour sets; the tinted ones follow the colour they come from. */
const TARGETS: Record<ThemeColorKey, string[]> = {
  canvas: ['--canvas'],
  rail: ['--rail'],
  railText: ['--rail-text'],
  panel: ['--panel', '--stats-panel'],
  panel2: ['--panel-2', '--input', '--floating', '--button', '--stat-tile', '--settings-input', '--user-message'],
  panel3: ['--panel-3', '--selected', '--hover', '--settings-active', '--segmented-active'],
  line: ['--line'],
  lineStrong: ['--line-strong', '--scrollbar'],
  text: ['--text'],
  muted: ['--muted', '--stat-label'],
  dim: ['--dim', '--inactive-dot'],
  accent: ['--accent', '--accent-text', '--primary', '--focus', '--composer-focus', '--effort', '--effort-end', '--heat-4', '--theme-accent'],
  accentInk: ['--accent-ink', '--primary-text'],
  info: ['--info', '--link', '--permission-ask'],
  success: ['--success'],
  warning: ['--warning', '--permission-edit'],
  danger: ['--danger', '--permission-full'],
};
const SOFT: Partial<Record<ThemeColorKey, Array<[string, number]>>> = {
  accent: [['--accent-soft', 12], ['--focus-soft', 20], ['--selection', 26], ['--effort-soft', 12]],
  info: [['--info-soft', 12], ['--permission-ask-soft', 12]],
  success: [['--success-soft', 12]],
  warning: [['--warning-soft', 12], ['--permission-edit-soft', 12], ['--approval-bg', 8], ['--approval-line', 50]],
  danger: [['--danger-soft', 12], ['--permission-full-soft', 12]],
};

/** The CSS variables a theme pack sets on top of its base. */
export function themeVariables(theme: ThemeDefinition): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    const value = theme.colors[key];
    if (!value) continue;
    for (const name of TARGETS[key]) variables[name] = value;
    for (const [name, percent] of SOFT[key] ?? []) variables[name] = `color-mix(in srgb, ${value} ${percent}%, transparent)`;
  }
  if (theme.colors.accent) variables['--primary-hover'] = `color-mix(in srgb, ${theme.colors.accent} 86%, ${theme.base === 'dark' ? 'white' : 'black'})`;
  return variables;
}
