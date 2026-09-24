// test/card-frontend-skins.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, cssDeclarations } from '../src/shared/card-studio/frontend.ts';
import { STYLE_PRESETS } from '../src/shared/card-studio/style-presets.ts';
import { REQUIRED_TOKENS, parseAssemblySheet } from '../src/shared/card-studio/assembly-sheet.ts';

const resources = fileURLToPath(new URL('../card-studio', import.meta.url));
const read = (relative: string) => readFileSync(join(resources, ...relative.split('/')), 'utf8');
const PRESET_FILES: Record<string, string> = { tactical: '战术档案', gilded: '鎏金典狱', terminal: '工业终端', cinema: '复古电影', sakura: '粉樱', washi: '和纸', neon: '霓虹夜' };
const tokensOf = (css: string) => new Map(cssDeclarations(css).filter(item => item.property.startsWith('--') && !item.media.length && item.selector.trim() === ':root').map(item => [item.property, item.value]));

test('every preset has a skin whose :root tokens are the ones its style page declares', () => {
  for (const [id, name] of Object.entries(PRESET_FILES)) {
    const skin = read(`frontend/skins/${id}.css`);
    const page = read(`styles/${name}.md`);
    const block = /```css\s*([\s\S]*?)```/.exec(page);
    assert.ok(block, `${name}.md has a css block`);
    const expected = tokensOf(block![1]);
    const actual = tokensOf(skin);
    for (const [token, value] of expected) assert.equal(actual.get(token), value, `${id}.css ${token}`);
    for (const token of REQUIRED_TOKENS) assert.ok(actual.has(token), `${id}.css defines ${token}`);
    assert.ok(actual.size >= 12, `${id}.css declares ${actual.size} tokens`);
    for (const background of ['--bg', '--panel']) {
      const ratio = contrastRatio(actual.get('--text')!, actual.get(background)!);
      assert.ok(ratio !== null && ratio >= 4.5, `${id}.css --text on ${background} is ${ratio}`);
    }
  }
});

test('skins decorate through tokens and stay within the accent budget', () => {
  for (const preset of STYLE_PRESETS) {
    const css = read(`frontend/skins/${preset.id}.css`);
    const declarations = cssDeclarations(css).filter(item => !item.property.startsWith('--'));
    const hard = declarations.filter(item => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(item.value) && !/var\(--/.test(item.value));
    assert.deepEqual(hard.map(item => `${item.selector} ${item.property}: ${item.value}`), [], `${preset.id}.css hard-codes colours`);
    const accent = (css.match(/var\(\s*--accent\s*[,)]/g) ?? []).length;
    assert.ok(accent <= 3, `${preset.id}.css uses --accent ${accent} times`);
    const loops = declarations.filter(item => (item.property === 'animation' || item.property === 'animation-iteration-count') && /\binfinite\b/i.test(item.value));
    assert.ok(loops.length <= 1, `${preset.id}.css has ${loops.length} looping animations`);
    if (loops.length) assert.match(css, /prefers-reduced-motion/);
    assert.ok(css.length <= 8 * 1024, `${preset.id}.css is ${css.length} bytes`);
    assert.ok(!/@import|url\(\s*["']?https?:/i.test(css), `${preset.id}.css loads nothing from the network`);
  }
  assert.equal(tokensOf(read('frontend/skins/custom.css')).size, 0, 'the custom skin gets its tokens from the sheet');
});

test('skins declare the shadow panel and avoid document-level selectors, and combined accent stays within budget', () => {
  const base = read('frontend/base.css');
  const baseAccent = (base.match(/var\(\s*--accent\s*[,)]/g) ?? []).length;
  for (const preset of STYLE_PRESETS) {
    const css = read(`frontend/skins/${preset.id}.css`);
    const declarations = cssDeclarations(css);
    const panelBg = declarations.some(item => item.selector.trim() === '.cw-panel' && item.property === 'background');
    const panelColor = declarations.some(item => item.selector.trim() === '.cw-panel' && item.property === 'color');
    assert.ok(panelBg, `${preset.id}.css .cw-panel declares background`);
    assert.ok(panelColor, `${preset.id}.css .cw-panel declares color`);
    const nonToken = declarations.filter(item => !item.property.startsWith('--'));
    const badSelectors = nonToken.filter(item => /(?:^|,)\s*(?:html|body)\s*(?:$|,|\{)/i.test(item.selector));
    assert.deepEqual(badSelectors.map(item => item.selector), [], `${preset.id}.css uses html/body selectors outside :root`);
    const rootOutsideTokenBlock = declarations.filter(item => !item.property.startsWith('--') && item.selector.split(',').some(part => part.trim() === ':root'));
    assert.deepEqual(rootOutsideTokenBlock.map(item => `${item.selector} ${item.property}`), [], `${preset.id}.css has non-token :root declarations`);
    if (preset.id === 'custom') {
      assert.equal(tokensOf(css).size, 0, 'custom.css has no :root token block');
    }
    const skinAccent = (css.match(/var\(\s*--accent\s*[,)]/g) ?? []).length;
    assert.ok(baseAccent + skinAccent <= 8, `${preset.id}.css combined accent uses ${baseAccent} + ${skinAccent} = ${baseAccent + skinAccent}`);
  }
});

test('the vocabulary names every block, icon, role and field type, and the shipped samples parse', () => {
  const vocabulary = read('frontend/blocks/词汇.md');
  for (const word of ['stats', 'bars', 'gauge', 'tags', 'fold', 'list', 'relation', 'timeline', 'crisis', 'delta', 'text', 'custom', 'placeholder', 'header', 'floating', '人物列表', '滑杆', '自定义开局', '令牌']) assert.ok(vocabulary.includes(word), word);
  for (const name of ['样例-状态栏', '样例-正文美化', '样例-创角页']) {
    const sheet = parseAssemblySheet(read(`frontend/blocks/${name}.yaml`));
    assert.ok(sheet.kind, name);
  }
  const floating = read('frontend/runtime/floating.js');
  assert.match(floating, /attachShadow/); assert.match(floating, /setPointerCapture/); assert.match(floating, /localStorage/); assert.match(floating, /data-cardwright-floating/);
  assert.ok(floating.length <= 10 * 1024);
});
