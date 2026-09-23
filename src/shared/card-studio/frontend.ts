/**
 * 前端围栏 (Q2, handoff §4.1). The status bar, the body beautifier and the start page are HTML documents that 酒馆助手
 * renders in an iframe of their own, and it only does that for a code block: without the fence the scripts never run and
 * SillyTavern sanitizes the document into the message text. Their component files hold the bare document; the fence is
 * added when the card is assembled, the way the Re0 card writes it: ```html, the document, </html>, the closing fence.
 * The variable update receipt is inline (a section and its style, no script) and stays unfenced.
 */
import { normalizeNewlines } from './fences.ts';

const FENCE = '`'.repeat(3);
const DOCUMENT_START = /^<!doctype\s+html\b[^>]*>|^<html(?=[\s>])/i;
const DOCUMENT_END = /<\/html\s*>$/i;
const DOCUMENT_TAGS = /<!doctype\s+html|<\/?html(?=[\s>])|<head(?=[\s>])|<body(?=[\s>])/i;

/** A whole HTML document: <!DOCTYPE html> or <html> first, </html> last, nothing around them. */
export function isHtmlDocument(text: string): boolean {
  const trimmed = text.trim();
  return DOCUMENT_START.test(trimmed) && DOCUMENT_END.test(trimmed);
}

/** The text inside a code block that spans the whole replacement, or null when the replacement is not one fenced block. */
function fencedBlock(text: string): { info: string; content: string } | null {
  const lines = normalizeNewlines(text).trim().split('\n');
  if (lines.length < 2) return null;
  const open = /^(`{3,}|~{3,})(.*)$/.exec(lines[0]);
  if (!open) return null;
  const last = lines[lines.length - 1];
  if (!last.startsWith(open[1][0].repeat(open[1].length)) || last.replace(/[`~]/g, '').trim()) return null;
  return { info: open[2].trim(), content: lines.slice(1, -1).join('\n') };
}

/** The replacement a regex component contributes to the card: a bare document gets the fence, anything else stays as written. */
export function withFrontendFence(body: string): string {
  if (fencedBlock(body) || !isHtmlDocument(body)) return body;
  return `${FENCE}html\n${body.trim()}\n${FENCE}`;
}

/**
 * What is wrong with the fence of an assembled replacement, or null. Checked on what the export writes, so a bare
 * document the app fences passes, while a document with text around it (which the app cannot fence), a fenced inline
 * receipt and a fenced document that does not end at </html> are reported.
 */
export function frontendFenceProblem(replacement: string): string | null {
  const text = normalizeNewlines(replacement).trim();
  if (!text) return null;
  const block = fencedBlock(text);
  if (block) {
    const content = block.content.trim();
    if (!DOCUMENT_TAGS.test(content)) return '围栏里不是 HTML 文档。变量更新回执这类内联替换内容不加围栏，直接写 <section> 与 <style>。';
    if (!DOCUMENT_START.test(content)) return '围栏里的文档没有从 <!DOCTYPE html> 开始。围栏里只放一个完整的 HTML 文档。';
    if (!DOCUMENT_END.test(content)) return '围栏里的文档没有以 </html> 结尾。结尾必须是 </html> 加闭合围栏，酒馆助手才会把它渲染成 iframe。';
    if (block.info.toLowerCase() !== 'html') return `围栏开头写的是 ${FENCE}${block.info}，要写成 ${FENCE}html。`;
    if (content.split('\n').some(line => /^ {0,3}`{3,}\s*$/.test(line))) return '文档里有单独一行三个反引号，会让围栏提前结束，后半个文档变成消息正文。改掉这一行（例如写进 <pre> 时用 &#96;）。';
    return null;
  }
  if (text.includes(FENCE) && DOCUMENT_TAGS.test(text)) return '替换内容在围栏外还有文字。开头必须是 ```html，结尾必须是 </html> 加闭合围栏，前后不留别的内容。';
  if (DOCUMENT_TAGS.test(text)) return '替换内容像是一个 HTML 文档，但 <!DOCTYPE html> 之前或 </html> 之后还有文字，应用没法给它补围栏：酒馆会把它当成消息正文净化，脚本不跑、点不动。删掉文档前后的内容。';
  if (/<script(?=[\s>])/i.test(text)) return '替换内容里有 <script>，但它不是完整的 HTML 文档：酒馆会删掉脚本，点什么都没有反应。要么写成完整文档（应用会补围栏），要么去掉脚本、写成内联回执。';
  return null;
}

/** The document an iframe front-end renders: the inside of a fenced replacement, when that is an HTML document. */
export function frontendDocument(replacement: string): string | null {
  const block = fencedBlock(replacement);
  return block && DOCUMENT_START.test(block.content.trim()) ? block.content : null;
}

/*
 * 前端质量检查 (Q17, handoff §5.4). Deterministic: string and style-sheet statistics, no rendering and no guessing. What
 * breaks use is an error and blocks the export; what only looks poor is a warning.
 */
export interface FrontendFinding { level: 'error' | 'warning'; code: string; message: string }
interface Declaration { property: string; value: string; selector: string; media: string[] }

const PHONE = 375;
const REM = 16;
const WIDE_TABLE = 7;
const TOKEN_MINIMUM = 12;
const ACCENT_LIMIT = 8;
const BASE64_LIMIT = 16 * 1024;
const CONTRAST_MINIMUM = 4.5;

/** Every declaration of a style sheet with its selector and the @media conditions around it. */
export function cssDeclarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Declaration[] = [];
  const closing = (open: number): number => {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) return index;
    }
    return text.length;
  };
  const walk = (start: number, end: number, media: string[]): void => {
    let cursor = start;
    while (cursor < end) {
      const open = text.indexOf('{', cursor);
      if (open < 0 || open >= end) return;
      const close = Math.min(closing(open), end);
      const prelude = text.slice(cursor, open).split(';').pop()!.trim();
      if (/^@media\b/i.test(prelude)) walk(open + 1, close, [...media, prelude.slice(6).trim()]);
      else if (/^@(supports|layer|container|document)\b/i.test(prelude)) walk(open + 1, close, media);
      else if (!prelude.startsWith('@')) found.push(...declarationsOf(text.slice(open + 1, close), prelude, media));
      cursor = close + 1;
    }
  };
  walk(0, text.length, []);
  return found;
}

function declarationsOf(block: string, selector: string, media: string[]): Declaration[] {
  return block.split(';').flatMap(part => {
    const colon = part.indexOf(':');
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    return colon > 0 && property && value ? [{ property, value, selector, media }] : [];
  });
}

/** A length in CSS pixels (rem and em taken at 16px), or null for anything relative. */
function pixels(value: string): number | null {
  const match = /^(-?\d*\.?\d+)(px|rem|em)$/i.exec(value.trim());
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'px' ? 1 : REM) : null;
}

/** Declarations in `@media (min-width: …)` wider than a phone, or in print, never reach a 375px screen. */
function phoneSees(media: string[]): boolean {
  return !media.some(condition => {
    if (/\bprint\b/i.test(condition) && !/\bscreen\b/i.test(condition)) return true;
    const min = /min-width\s*:\s*(\d*\.?\d+(?:px|rem|em))/i.exec(condition);
    return !!min && (pixels(min[1]) ?? 0) > PHONE;
  });
}

/** The fixed width a grid's columns add up to, or null when any column can shrink. */
function gridWidth(value: string): number | null {
  const expanded = value.replace(/repeat\(\s*(\d+)\s*,\s*([^()]+?)\s*\)/gi, (_whole, count: string, track: string) => Array(Number(count)).fill(track).join(' '));
  if (/fr\b|%|auto|min-content|max-content|fit-content|minmax|repeat|var\(|calc\(/i.test(expanded)) return null;
  const tracks = expanded.split(/\s+/).filter(Boolean).map(pixels);
  return tracks.length && tracks.every(track => track !== null) ? tracks.reduce((sum, track) => sum! + track!, 0) : null;
}

function mobileProblems(declarations: Declaration[], markup: string): string[] {
  const problems: string[] = [];
  for (const item of declarations) {
    if (!phoneSees(item.media)) continue;
    const width = ['width', 'min-width', 'flex-basis'].includes(item.property) ? pixels(item.value)
      : item.property === 'flex' ? pixels(item.value.split(/\s+/).at(-1) ?? '')
      : item.property === 'grid-template-columns' ? gridWidth(item.value) : null;
    if (width !== null && width > PHONE) problems.push(`「${item.selector}」的 ${item.property}: ${item.value} 比 375px 的手机屏幕宽`);
  }
  const columns = Math.max(0, ...[...markup.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/gi)].map(row => (row[0].match(/<t[hd]\b/gi) ?? []).length));
  const scrolls = declarations.some(item => /^overflow(-x)?$/.test(item.property) && /\b(auto|scroll)\b/i.test(item.value));
  if (columns >= WIDE_TABLE && !scrolls) problems.push(`有一张 ${columns} 列的表格，却没有 overflow-x: auto 的容器`);
  return problems;
}

/** A colour as RGBA 0–255 with alpha 0–1, or null for what cannot be read without rendering. */
function parseColor(value: string): [number, number, number, number] | null {
  const text = value.trim().toLowerCase();
  if (text === 'white') return [255, 255, 255, 1];
  if (text === 'black') return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map(char => char + char) : hex[1].match(/../g)!;
    const [r, g, b, a] = digits.map(pair => parseInt(pair, 16));
    return [r, g, b, a === undefined ? 1 : a / 255];
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const number = (part: string, scale: number) => part.endsWith('%') ? Number(part.slice(0, -1)) / 100 * scale : Number(part);
  const alpha = parts[3] === undefined ? 1 : number(parts[3], 1);
  if (fn[1].startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map(part => number(part, 255));
    return rgb.every(Number.isFinite) && Number.isFinite(alpha) ? [rgb[0], rgb[1], rgb[2], alpha] : null;
  }
  const hue = Number(parts[0].replace(/deg$/, '')); const saturation = number(parts[1], 1); const lightness = number(parts[2], 1);
  if (![hue, saturation, lightness, alpha].every(Number.isFinite)) return null;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => { const k = (n + hue / 30) % 12; return 255 * (lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [channel(0), channel(8), channel(4), alpha];
}

/** WCAG 2 relative luminance of an opaque colour. */
function luminance([r, g, b]: [number, number, number, number]): number {
  const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(foreground: string, background: string): number | null {
  const back = parseColor(background); const fore = parseColor(foreground);
  // A see-through background shows whatever is behind the frame, which only rendering knows.
  if (!back || !fore || back[3] < 1) return null;
  const mixed: [number, number, number, number] = [0, 1, 2].map(index => fore[index] * fore[3] + back[index] * (1 - fore[3])) as never;
  mixed[3] = 1;
  const [light, dark] = [luminance(mixed), luminance(back)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** The tokens the base :root declares (not the ones a media query swaps in), with var() references followed. */
function rootTokens(declarations: Declaration[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const item of declarations) if (!item.media.length && item.property.startsWith('--') && item.selector.split(',').some(part => part.trim() === ':root')) tokens.set(item.property, item.value);
  const resolve = (value: string, depth = 0): string => {
    const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(value.trim());
    if (!reference || depth > 6) return value;
    const next = tokens.get(reference[1]) ?? reference[2];
    return next === undefined ? value : resolve(next, depth + 1);
  };
  return new Map([...tokens].map(([name, value]) => [name, resolve(value)]));
}

const EXCLUDED = new Set(['accent', 'primary', 'brand', 'ok', 'warn', 'warning', 'danger', 'error', 'success', 'info', 'line', 'border', 'shadow', 'glow', 'hover', 'active', 'focus', 'overlay', 'scrim', 'grad', 'gradient', 'on']);
/** The main token of a role: `--text` before `--text-2`, `--mf-bg` before `--mf-bg-soft`; card prefixes are fine. */
function mainToken(tokens: Map<string, string>, words: string[], excluded = EXCLUDED): string | undefined {
  const candidates = [...tokens.keys()].map(name => ({ name, parts: name.slice(2).toLowerCase().split(/[-_]/) }))
    .filter(item => item.parts.some(part => words.includes(part)) && !item.parts.some(part => excluded.has(part)));
  return candidates.sort((a, b) => a.parts.length - b.parts.length)[0]?.name;
}

function contrastProblems(tokens: Map<string, string>): string[] {
  const text = mainToken(tokens, ['text', 'fg', 'foreground']);
  if (!text) return [];
  return [mainToken(tokens, ['bg', 'background', 'surface', 'paper', 'canvas']), mainToken(tokens, ['panel', 'card', 'sheet'])].flatMap(background => {
    if (!background) return [];
    const ratio = contrastRatio(tokens.get(text)!, tokens.get(background)!);
    return ratio !== null && ratio < CONTRAST_MINIMUM ? [`正文色 ${text}（${tokens.get(text)}）在 ${background}（${tokens.get(background)}）上的对比度只有 ${ratio.toFixed(2)}:1`] : [];
  });
}

/** The front-end's style sheets, inline styles, scripts and the markup around them. */
function partsOf(html: string): { css: string; inline: string; scripts: string; markup: string } {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => match[1]).join('\n');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]).join('\n');
  const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const inline = [...markup.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(match => `[style] { ${match[1] ?? match[2] ?? ''} }`).join('\n');
  return { css, inline, scripts, markup };
}

const summary = (items: string[]) => `${items.slice(0, 3).join('；')}${items.length > 3 ? `；另有 ${items.length - 3} 处` : ''}`;

/** The quality findings for one iframe front-end document (Q17). One finding per kind, naming up to three places. */
export function frontendQuality(html: string): FrontendFinding[] {
  const { css, inline, scripts, markup } = partsOf(html);
  const declarations = [...cssDeclarations(css), ...cssDeclarations(inline)];
  const tokens = rootTokens(declarations);
  const findings: FrontendFinding[] = [];
  const add = (level: FrontendFinding['level'], code: string, message: string) => findings.push({ level, code, message });

  const mobile = mobileProblems(declarations, markup);
  if (mobile.length) add('error', 'frontend-mobile', `375px 手机上会横向滚动：${summary(mobile)}。宽度改用 max-width 或百分比，定宽只写进 @media (min-width: …)，宽表格外面包一层 overflow-x: auto 的容器。`);
  const pseudo = /:(hover|active|focus|focus-visible|focus-within)\b/i.test(css);
  const listens = /addEventListener\s*\(|\.on[a-z]+\s*=|\beventOn\w*\s*\(|\.on\s*\(|\.click\s*\(/i.test(scripts) || /\son[a-z]+\s*=/i.test(markup);
  if (!pseudo && !listens) add('error', 'frontend-interaction', '整个前端没有任何交互反馈：没有 :hover、:active、:focus，也没有事件监听。可以点的东西要让人看出来能点、点了有反应。');
  const contrast = contrastProblems(tokens);
  if (contrast.length) add('error', 'frontend-contrast', `正文对比度低于 4.5:1：${summary(contrast)}。加深文字或调整底色。`);
  if (/fonts\.(googleapis|gstatic)\.com/i.test(html)) add('error', 'frontend-fonts', '用了 Google Fonts：国内经常加载不出来，还会拖慢整个页面。改用系统字体栈。');
  const images = [...html.matchAll(/data:(?:image|audio|video|font)\/[\w.+-]+(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/=\s]+)/gi)].filter(match => match[1].length >= BASE64_LIMIT);
  if (images.length) add('error', 'frontend-base64', `把 ${images.length} 个大文件（最大约 ${Math.round(Math.max(...images.map(match => match[1].length)) * 0.75 / 1024)} KB）以 base64 塞进了替换内容：每一楼都要重新解析它，卡会变慢、变大。图片用设计书里给的链接。`);

  // Tokens count wherever the sheet declares them: Re0 keeps its set on the app's mount element rather than :root.
  const declared = new Set(cssDeclarations(css).filter(item => item.property.startsWith('--')).map(item => item.property));
  if (declared.size < TOKEN_MINIMUM) add('warning', 'frontend-tokens', `只定义了 ${declared.size} 个设计令牌（CSS 自定义属性），少于 12 个。底色、面板、线、三级文字、强调色、状态色要在 :root 里成套定义，别处都用 var() 取。`);
  if (!/@media\b/i.test(css)) add('warning', 'frontend-media', '没有任何 @media：窄屏、宽屏和减少动画都没有照顾到。');
  const loops = declarations.some(item => (item.property === 'animation' || item.property === 'animation-iteration-count') && /\binfinite\b/i.test(item.value));
  if (loops && !/prefers-reduced-motion/i.test(`${css}\n${scripts}`)) add('warning', 'frontend-motion', '有循环动画，却没有写 @media (prefers-reduced-motion: reduce)：系统设了减少动画的玩家也会一直看到它在动。');
  const accent = mainToken(tokens, ['accent', 'primary', 'brand'], new Set(['on', 'text', 'fg', 'bg', 'soft', 'dim', 'muted', 'line', 'border', 'glow', 'shadow', '2', '3']));
  const uses = accent ? (`${css}\n${inline}`.match(new RegExp(`var\\(\\s*${accent}\\s*[,)]`, 'g')) ?? []).length : 0;
  if (uses > ACCENT_LIMIT) add('warning', 'frontend-accent', `强调色 ${accent} 用了 ${uses} 处，超过 8 处：到处都强调就等于没有强调。只留给当前状态、主要操作和关键数字。`);
  return findings;
}
