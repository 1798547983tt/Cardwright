import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseStylePreset, STYLE_PRESETS } from '../src/shared/card-studio/style-presets.ts';
import { contrastRatio, cssDeclarations } from '../src/shared/card-studio/frontend.ts';

const styles = fileURLToPath(new URL('../card-studio/styles', import.meta.url));
const NL = String.fromCharCode(10);

test('the design book names its style preset by id or by name, in its 风格预设 section', () => {
  assert.deepEqual(parseStylePreset(['## 风格预设', '预设：粉樱（sakura）'].join(NL)), { id: 'sakura', name: '粉樱' });
  assert.deepEqual(parseStylePreset(['# 设计书', '## 14 风格预设', '- 和纸，朱红只给当前项', '## 派单'].join(NL)), { id: 'washi', name: '和纸' });
  assert.deepEqual(parseStylePreset(['## 风格预设', 'neon'].join(NL)), { id: 'neon', name: '霓虹夜' });
  assert.deepEqual(parseStylePreset(['## 风格预设', '题材自定（custom）：底色……'].join(NL)), { id: 'custom', name: '题材自定' });
  assert.equal(parseStylePreset(['## 风格预设', '待定'].join(NL)), null);
  assert.equal(parseStylePreset(['## 前端', '霓虹夜的感觉'].join(NL)), null, 'only the 风格预设 section counts');
});

test('seven presets and 题材自定; each preset document is complete and its tokens meet the minimum it asks of every front-end', () => {
  assert.deepEqual(STYLE_PRESETS.map(preset => preset.id), ['tactical', 'gilded', 'terminal', 'cinema', 'sakura', 'washi', 'neon', 'custom']);
  const readme = readFileSync(join(styles, 'README.md'), 'utf8');
  for (const preset of STYLE_PRESETS) {
    assert.ok(readme.includes(`\`${preset.id}\``) && readme.includes(preset.name), `README lists ${preset.id}`);
    const doc = readFileSync(join(styles, `${preset.name}.md`), 'utf8');
    assert.ok(doc.startsWith(`# ${preset.name} · ${preset.id}`), `${preset.name}.md opens with its name and id`);
    if (preset.id === 'custom') continue;
    for (const section of ['令牌', '版式', '装饰', '动效', '禁用']) assert.match(doc, new RegExp(`^## .*${section}`, 'm'), `${preset.name}: ${section}`);
    const css = new RegExp('```css\\n([\\s\\S]*?)```').exec(doc)?.[1] ?? '';
    const tokens = new Map(cssDeclarations(css).filter(item => item.property.startsWith('--')).map(item => [item.property, item.value]));
    assert.ok(tokens.size >= 12, `${preset.name}: ${tokens.size} tokens`);
    for (const name of ['--bg', '--panel', '--line', '--text', '--text-2', '--text-3', '--accent', '--accent-2', '--ok', '--warn', '--danger']) assert.ok(tokens.has(name), `${preset.name} defines ${name}`);
    for (const background of ['--bg', '--panel']) {
      const ratio = contrastRatio(tokens.get('--text')!, tokens.get(background)!);
      assert.ok(ratio !== null && ratio >= 4.5, `${preset.name}: --text on ${background} is ${ratio?.toFixed(2)}:1`);
    }
    assert.deepEqual(preset.swatch, [tokens.get('--bg'), tokens.get('--accent'), tokens.get('--text')], `${preset.name}: the card library swatch shows its own colours`);
  }
});

test('the shared bans keep only rules with a reason, and drop the ones the Re0 card itself breaks', () => {
  const bans = readFileSync(join(styles, '反八股清单.md'), 'utf8');
  for (const kept of ['Google Fonts', 'emoji', '占位', 'base64', '强调色', '一次交互']) assert.ok(bans.includes(kept), kept);
  for (const dropped of ['圆角大于 2px', '圆角不超过 2px', '只有一个强调色', '一个强调色，其余']) assert.ok(!bans.includes(dropped), `still bans: ${dropped}`);
  const readme = readFileSync(join(styles, 'README.md'), 'utf8');
  assert.ok(!readme.includes('圆角不超过 2px') && !readme.includes('只有一个强调色'), 'the shared baseline no longer bans what Re0 does');
  for (const required of [':root', 'prefers-reduced-motion', '375px', '4.5:1', ':hover', '空值']) assert.ok(readme.includes(required), `the baseline requires ${required}`);
});
