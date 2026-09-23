/**
 * The style presets of card front-ends (card-studio/styles). Planning names one in the design book's 风格预设 section;
 * the card library and the project home show it as a swatch of the preset's page background, main colour and text.
 */
import { normalizeNewlines } from './fences.ts';

export interface StylePreset { id: string; name: string; swatch?: [string, string, string] }

export const STYLE_PRESETS: readonly StylePreset[] = [
  { id: 'tactical', name: '战术档案', swatch: ['#101214', '#19a7e8', '#e9ecee'] },
  { id: 'gilded', name: '鎏金典狱', swatch: ['#141a14', '#d9bb7a', '#efe6d2'] },
  { id: 'terminal', name: '工业终端', swatch: ['#f1f1ee', '#ffe100', '#121212'] },
  { id: 'cinema', name: '复古电影', swatch: ['#15110e', '#d8742f', '#efe4d6'] },
  { id: 'sakura', name: '粉樱', swatch: ['#fff7f9', '#e2517f', '#3f2a33'] },
  { id: 'washi', name: '和纸', swatch: ['#f3ede1', '#c23a2b', '#2a2420'] },
  { id: 'neon', name: '霓虹夜', swatch: ['#0a0b12', '#2fe0f0', '#e7eaf6'] },
  { id: 'custom', name: '题材自定' },
];

export function stylePresetOf(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find(preset => preset.id === id);
}

/**
 * The preset the design book's 风格预设 section names, by name or by id; the first one mentioned wins, and one right
 * after 不 or 非 (「不用战术档案」) does not count. Null when the section is missing or names none.
 */
export function parseStylePreset(markdown: string): { id: string; name: string } | null {
  const lines = normalizeNewlines(markdown).split('\n');
  const start = lines.findIndex(line => /^#{1,6}\s.*风格预设/.test(line.trim()));
  if (start < 0) return null;
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    section.push(line);
  }
  const text = section.join('\n');
  let best: { at: number; preset: StylePreset } | undefined;
  for (const preset of STYLE_PRESETS) {
    const pattern = new RegExp(`${preset.name}|(?<![A-Za-z])${preset.id}(?![A-Za-z])`, 'gi');
    for (const match of text.matchAll(pattern)) {
      if (/[不非]/.test(text.slice(Math.max(0, match.index - 3), match.index))) continue;
      if (!best || match.index < best.at) best = { at: match.index, preset };
      break;
    }
  }
  return best ? { id: best.preset.id, name: best.preset.name } : null;
}
