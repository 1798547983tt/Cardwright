import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendQuality } from '../src/shared/card-studio/frontend.ts';

const NL = String.fromCharCode(10);
/** Twelve tokens, a panel, two text levels, an accent used a few times, feedback, motion that respects reduced motion. */
const TOKENS = ['--bg: #f7f1ea;', '--panel: #fffaf5;', '--line: #e8d6cc;', '--text: #3b2a2a;', '--text-2: #6b5550;', '--text-3: #8e7a74;', '--accent: #c2185b;', '--accent-2: #7b61a8;', '--ok: #2e7d57;', '--warn: #a66300;', '--danger: #b3261e;', '--radius: 14px;'];
const style = (extra = '') => [
  `:root { ${TOKENS.join(' ')} }`,
  'body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.7 system-ui, sans-serif; }',
  '.card { max-width: 640px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }',
  '.tab { color: var(--accent); transition: transform .2s; }',
  '.tab:hover, .tab:focus-visible { transform: translateY(-1px); }',
  '.tab.is-on { border-bottom: 2px solid var(--accent); }',
  '@keyframes glow { from { opacity: .6; } to { opacity: 1; } }',
  '.badge { animation: glow 2s ease-in-out infinite alternate; }',
  '@media (prefers-reduced-motion: reduce) { .badge { animation: none; } }',
  '@media (max-width: 480px) { .card { padding: 12px; } }',
  extra,
].join(NL);
const doc = (css = style(), body = '<main class="card"><button class="tab">状态</button><span class="badge">新</span></main>', script = 'document.querySelector(".tab").addEventListener("click", () => {});') =>
  ['<!DOCTYPE html>', '<html lang="zh-CN">', '<head><meta charset="utf-8"><style>', css, '</style></head>', `<body>${body}<script>${script}</script></body>`, '</html>'].join(NL);
const codes = (html: string) => frontendQuality(html).map(item => `${item.level}:${item.code}`).sort();

test('a front-end that meets the minimum passes without findings', () => {
  assert.deepEqual(frontendQuality(doc()), []);
});

test('a fixed width wider than a 375px phone is an error, unless only wider screens get it', () => {
  assert.deepEqual(codes(doc(style('.sheet { width: 480px; }'))), ['error:frontend-mobile']);
  // Decoration out of the flow is clipped by the iframe, not scrolled to: an absolutely placed glow, a pseudo-element.
  assert.deepEqual(codes(doc(style('.rays { position: absolute; pointer-events: none; } .rays { width: 520px; } .blk .rays { width: 700px; }'))), []);
  assert.deepEqual(codes(doc(style('.stage::before { content: ""; width: 28rem; }'))), []);
  assert.deepEqual(codes(doc(style('.rays { position: absolute; } .panel { width: 520px; }'))), ['error:frontend-mobile'], 'only the positioned selector is spared');
  assert.deepEqual(codes(doc(style('.sheet { min-width: 30rem; }'))), ['error:frontend-mobile'], '30rem is 480px');
  assert.deepEqual(codes(doc(style('.grid { display: grid; grid-template-columns: repeat(3, 160px); }'))), ['error:frontend-mobile']);
  assert.deepEqual(codes(doc(style('@media (min-width: 720px) { .sheet { width: 640px; } }'))), []);
  assert.deepEqual(codes(doc(style('.sheet { max-width: 900px; width: 100%; }'))), [], 'a max-width never forces scrolling');
  assert.deepEqual(codes(doc(undefined, '<div style="width: 520px">宽</div><button class="tab">状态</button>')), ['error:frontend-mobile'], 'inline styles count too');
});

test('a table too wide for a phone needs a scroll container', () => {
  const row = (cell: string) => `<tr>${Array.from({ length: 8 }, (_, index) => `<${cell}>${index}</${cell}>`).join('')}</tr>`;
  const table = `<table>${row('th')}${row('td')}</table><button class="tab">状态</button>`;
  assert.deepEqual(codes(doc(undefined, table)), ['error:frontend-mobile']);
  assert.deepEqual(codes(doc(style('.scroll { overflow-x: auto; }'), `<div class="scroll">${table}</div>`)), []);
});

test('a front-end with no interaction feedback at all is an error', () => {
  const quiet = style().replace('.tab:hover, .tab:focus-visible { transform: translateY(-1px); }', '');
  assert.deepEqual(codes(doc(quiet, undefined, 'const now = Date.now();')), ['error:frontend-interaction']);
  assert.deepEqual(codes(doc(quiet)), [], 'an event listener is feedback');
  assert.deepEqual(codes(doc(style(), undefined, 'const now = Date.now();')), [], ':hover and :focus are feedback');
});

test('body text below 4.5:1 against its background is an error, judged from the :root tokens', () => {
  assert.deepEqual(codes(doc(style().replace('--text: #3b2a2a;', '--text: #b9a39c;'))), ['error:frontend-contrast']);
  assert.deepEqual(codes(doc(style().replace('--panel: #fffaf5;', '--panel: #9c8a84;'))), ['error:frontend-contrast'], 'text on the panel counts too');
  assert.deepEqual(codes(doc(style().replace('--text: #3b2a2a;', '--text: var(--ink); --ink: #3b2a2a;'))), [], 'a token pointing at another token is followed');
  assert.deepEqual(codes(doc(style().replace('--text: #3b2a2a;', '--text: rgba(59, 42, 42, .35);'))), ['error:frontend-contrast'], 'a translucent text colour is mixed with its background');
  const prefixed = style().replace(/--(bg|panel|line|text|accent|ok|warn|danger|radius)/g, '--mf-$1');
  assert.deepEqual(codes(doc(prefixed.replace('--mf-text: #3b2a2a;', '--mf-text: #d8c9c4;'))), ['error:frontend-contrast'], 'card-prefixed tokens are paired by their last part');
});

test('Google Fonts and big base64 images are warnings (relaxed in 1.1.0)', () => {
  assert.deepEqual(codes(doc(style('@import url("https://fonts.googleapis.com/css2?family=Noto+Serif+SC");'))), ['warning:frontend-fonts']);
  const big = `<img alt="" src="data:image/png;base64,${'A'.repeat(20_000)}"><button class="tab">状态</button>`;
  assert.deepEqual(codes(doc(undefined, big)), ['warning:frontend-base64']);
  const icon = `<img alt="" src="data:image/svg+xml;base64,${'A'.repeat(800)}"><button class="tab">状态</button>`;
  assert.deepEqual(codes(doc(undefined, icon)), [], 'a small inline icon is fine');
});

test('few tokens, no @media, endless motion without reduced motion and an overused accent are warnings', () => {
  const few = style().replace(TOKENS.slice(8).join(' '), '');
  assert.deepEqual(codes(doc(few)), ['warning:frontend-tokens']);
  assert.deepEqual(codes(doc(style().replace('@media (max-width: 480px) { .card { padding: 12px; } }', '').replace('@media (prefers-reduced-motion: reduce) { .badge { animation: none; } }', '.x { transition: none; }'))), ['warning:frontend-media', 'warning:frontend-motion']);
  const loud = style(Array.from({ length: 8 }, (_, index) => `.c${index} { color: var(--accent); }`).join(NL));
  assert.deepEqual(codes(doc(loud)), ['warning:frontend-accent'], 'ten uses of the accent');
});

test('Google font domains, mirrors, CDN fonts and raw GitHub media are all warnings', () => {
  assert.deepEqual(codes(doc(style(), '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC">')).filter(code => /font|external/.test(code)), ['warning:frontend-fonts']);
  for (const url of ['https://fonts.loli.net/css2?family=Noto+Serif+SC', 'https://fonts.googleapis.cn/css?family=Ma+Shan+Zheng', 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css', 'https://fastly.jsdelivr.net/gh/someone/fonts/LXGW.woff2']) {
    assert.deepEqual(codes(doc(style(), `<link rel="stylesheet" href="${url}">`)).filter(code => /font|external/.test(code)), ['warning:frontend-external'], url);
  }
  assert.deepEqual(codes(doc(style(), '<img src="https://raw.githubusercontent.com/someone/cards/main/hero.png"><audio src="https://raw.githubusercontent.com/someone/cards/main/theme.mp3"></audio>')).filter(code => /external/.test(code)), ['warning:frontend-external']);
  const finding = frontendQuality(doc(style(), '<link rel="stylesheet" href="https://fonts.loli.net/css2?family=X">')).find(item => item.code === 'frontend-external');
  assert.match(finding!.message, /fonts\.loli\.net/);
  assert.match(finding!.message, /可能加载慢或失效/);
  assert.deepEqual(codes(doc(style(), '<script src="https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js"></script>')).filter(code => /external/.test(code)), [], 'a script address is not a font or a media file');
});

test('a commented-out link loads nothing; protocol-relative CDN fonts and every GitHub raw address are warnings (Q23)', () => {
  const external = (html: string) => codes(html).filter(code => /font|external/.test(code));
  assert.deepEqual(external(doc(style(), '<!-- <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC"> --><button class="tab">状态</button>')), [], 'Google Fonts inside an HTML comment');
  assert.deepEqual(external(doc(style('/* @import url("https://fonts.googleapis.com/css2?family=X"); */'))), [], 'Google Fonts inside a CSS comment');
  assert.deepEqual(external(doc(style(), '<script src="https://cdn.jsdelivr.net/npm/animate.css@4.1.1/animate.min.js"></script><button class="tab">状态</button>')), [], 'a jsDelivr script, even from a package whose name ends in .css');
  assert.deepEqual(external(doc(style('@font-face { font-family: LXGW; src: url(//cdn.jsdelivr.net/gh/someone/fonts/LXGW.woff2) format("woff2"); }'))), ['warning:frontend-external'], 'a protocol-relative jsDelivr font');
  const built = frontendQuality(doc(undefined, undefined, 'const avatar = `https://raw.githubusercontent.com/someone/cards/${commit}/avatars/${file}`; document.querySelector(".tab").addEventListener("click", () => {});')).find(item => item.code === 'frontend-external');
  assert.equal(built?.level, 'warning', 'a raw address a script puts together');
  assert.match(built!.message, /raw\.githubusercontent\.com\/someone\/cards\/\$\{commit\}\/avatars/);
  assert.match(built!.message, /CDN 上的样式表或字体/);
});
