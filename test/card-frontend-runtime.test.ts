// test/card-frontend-runtime.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtime = fileURLToPath(new URL('../card-studio/frontend/runtime/', import.meta.url));
const NL = String.fromCharCode(10);
/** core.js in a bare context: no window, no document. */
function loadCore(): Record<string, (...args: any[]) => any> & { version: string; ICONS: string[] } {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(readFileSync(join(runtime, 'core.js'), 'utf8'), sandbox);
  return sandbox.CardwrightCore as never;
}
const core = loadCore();
const data = { 主角: { 姓名: '林砚', 生命: 62, 状态: '受伤', 在逃: true }, 人物: { 老周: { 好感: 40, 所在: '码头' }, 阿七: { 好感: -20, 所在: '未知' } }, 货币: { 银币: 12, 铜钱: 300 }, 事件记录: ['入港', '遇见老周', '码头斗殴', '被通缉', '藏身酒馆'], 任务: [{ 标题: '找到船票' }, { 标题: '避开巡逻' }] };
const item = (path: string, over: Record<string, unknown> = {}) => ({ path, ...over });

test('the core is a bare module with a version and the icon set', () => {
  assert.match(core.version, /^\d+\.\d+\.\d+$/);
  // Spread into a host-realm array: strict deepEqual compares prototypes, and a vm-realm Array can never match.
  assert.deepEqual([...core.ICONS], ['heart', 'map', 'clock', 'users', 'bag', 'sword', 'star', 'book', 'flag', 'bolt', 'shield', 'moon', 'sun', 'leaf', 'gear', 'pin', 'eye', 'scroll']);
  for (const name of core.ICONS) assert.match(core.icon(name), /^<svg class="cw-icon"/, name);
  assert.equal(core.icon('dragon'), '');
});

test('values are resolved by pointer, unwrapped from MVU pairs and formatted by kind', () => {
  assert.equal(core.resolve(data, '/主角/生命'), 62);
  assert.equal(core.resolve(data, '/任务/1/标题'), '避开巡逻');
  assert.equal(core.resolve(data, '/主角/不存在'), undefined);
  assert.equal(core.resolve(data, '/主角/姓名/x'), undefined, 'a primitive has no members');
  assert.equal(core.resolve(data, '/主角/constructor'), undefined, 'only own properties are followed');
  assert.equal(core.resolve(data, '/__proto__/x'), undefined);
  assert.equal(core.formatValue(62, item('/主角/生命', { kind: '数值', range: [0, 100] })), '62 / 100');
  assert.equal(core.formatValue(true, item('/主角/在逃', { kind: '布尔' })), '是');
  assert.equal(core.formatValue(undefined, item('/主角/x')), '未知');
  assert.equal(core.formatValue('', item('/主角/x')), '—');
  assert.equal(core.formatValue([7, '当前体力'], item('/主角/体力', { kind: '数值' })), '7', 'an MVU [value, note] pair shows the value');
  assert.equal(core.formatValue(['a', 'b'], item('/x', { kind: '列表' })), 'a、b');
  assert.equal(core.formatValue(['fire', 'ice'], item('/x')), 'fire', 'without a kind, two entries with a string second read as an MVU [value, note] pair');
  assert.equal(core.formatValue(['fire', 'ice'], item('/x', { kind: '列表' })), 'fire、ice', 'the kind from the variable table keeps a real two-entry list whole');
  assert.equal(core.formatValue({ a: 1 }, item('/x')), '{…}', 'an object is never dumped as JSON');
});

test('stats, bars, gauge and delta render items with escaping and ranges', () => {
  const stats = core.renderBlock({ type: 'stats', title: '主角', items: [item('/主角/姓名', { label: '姓名', kind: '文本' }), item('/主角/生命', { kind: '数值', range: [0, 100] }), item('/主角/在逃', { kind: '布尔' }), item('/主角/无')] }, data, null);
  assert.match(stats, /<section class="cw-block cw-stats"/);
  assert.match(stats, /<h3 class="cw-block-title">主角<\/h3>/);
  assert.match(stats, /<dt>姓名<\/dt><dd[^>]*>林砚<\/dd>/);
  assert.match(stats, /<dt>生命<\/dt><dd[^>]*>62 \/ 100<\/dd>/, 'the last path segment names an item without 显示');
  assert.match(stats, /<dd class="cw-value is-missing">未知<\/dd>/);
  const hostile = core.renderBlock({ type: 'stats', items: [item('/主角/姓名')] }, { 主角: { 姓名: '<b>x</b>' } }, null);
  assert.ok(hostile.includes('&lt;b&gt;x&lt;/b&gt;') && !hostile.includes('<b>x</b>'));

  const bars = core.renderBlock({ type: 'bars', items: [item('/主角/生命', { label: '生命', kind: '数值', range: [0, 100] })] }, data, null);
  assert.match(bars, /class="cw-bar-fill" style="width: 62%"/);
  assert.match(bars, /62 \/ 100/);
  const gauge = core.renderBlock({ type: 'gauge', items: [item('/人物/老周/好感', { kind: '数值', range: [-100, 100] })] }, data, null);
  assert.match(gauge, /<svg class="cw-gauge"/);
  assert.match(gauge, /data-percent="70"/, '40 on a -100..100 scale is 70%');
  const delta = core.renderBlock({ type: 'delta', items: [item('/主角/生命', { kind: '数值' })] }, data, { 主角: { 生命: 70 } });
  assert.match(delta, /class="cw-delta is-down">-8</);
  const first = core.renderBlock({ type: 'delta', items: [item('/主角/生命', { kind: '数值' })] }, data, null);
  assert.match(first, /class="cw-delta is-same">62</);
});

test('tags, list, relation, timeline, crisis, text, fold and custom render their shapes', () => {
  assert.match(core.renderBlock({ type: 'tags', path: '/货币' }, data, null), /<span class="cw-tag">银币<\/span><span class="cw-tag">铜钱<\/span>/, 'a record shows its keys');
  assert.match(core.renderBlock({ type: 'tags', path: '/事件记录' }, data, null), /(<span class="cw-tag">[^<]+<\/span>){5}/);
  assert.match(core.renderBlock({ type: 'tags', path: '/主角/状态' }, data, null), /<span class="cw-tag">受伤<\/span>/);
  const list = core.renderBlock({ type: 'list', path: '/事件记录', recent: 2 }, data, null);
  assert.ok(list.includes('藏身酒馆') && list.includes('被通缉') && !list.includes('入港'), 'only the newest entries');
  const objects = core.renderBlock({ type: 'list', path: '/任务', fields: { 标题: '/任务/-/标题' }, recent: 5 }, data, null);
  assert.match(objects, /找到船票/); assert.match(objects, /避开巡逻/);
  const relation = core.renderBlock({ type: 'relation', path: '/人物', fields: { 好感: '/人物/{键}/好感', 所在: '/人物/{键}/所在' }, bar: '/人物/{键}/好感', barRange: [-100, 100] }, data, null);
  assert.match(relation, /<span class="cw-avatar" style="--hue: \d+">老<\/span>/);
  assert.match(relation, /阿七/);
  assert.match(relation, /style="width: 70%"/, 'the bar follows the record row range');
  const timeline = core.renderBlock({ type: 'timeline', path: '/事件记录', recent: 3 }, data, null);
  assert.ok(timeline.indexOf('藏身酒馆') < timeline.indexOf('被通缉'), 'newest first');
  assert.ok(!timeline.includes('入港'));
  const crisis = core.renderBlock({ type: 'crisis', path: '/主角/生命', tiers: [{ upTo: 30, name: '濒死', tone: 'danger' }, { upTo: 70, name: '受伤', tone: 'warn' }, { name: '安好', tone: 'ok' }] }, data, null);
  assert.match(crisis, /class="cw-tier is-warn is-current">受伤/);
  const enumCrisis = core.renderBlock({ type: 'crisis', path: '/主角/状态', tiers: [{ name: '正常', tone: 'ok' }, { name: '受伤', tone: 'warn' }] }, data, null);
  assert.match(enumCrisis, /class="cw-tier is-warn is-current">受伤/);
  assert.match(core.renderBlock({ type: 'text', text: '记录只显示最近几条。' }, data, null), /<p class="cw-text">记录只显示最近几条。<\/p>/);
  assert.match(core.renderBlock({ type: 'text', path: '/主角/姓名' }, data, null), /林砚/);
  const fold = core.renderBlock({ type: 'fold', title: '任务', open: false, blocks: [{ type: 'text', text: '内' }] }, data, null);
  assert.match(fold, /^<details class="cw-fold"><summary>任务<\/summary>/);
  assert.match(core.renderBlock({ type: 'fold', title: '任务', open: true, blocks: [] }, data, null), /<details class="cw-fold" open>/);
  assert.equal(core.renderBlock({ type: 'custom', html: '<div class="cw-seal">样卡</div>' }, data, null), '<section class="cw-block cw-custom"><div class="cw-seal">样卡</div></section>');
});

test('record keys written by the model are escaped wherever they reach the output', () => {
  const hostile = { p: { '<img onerror=alert(1)>': { x: 1 } } };
  const relation = core.renderBlock({ type: 'relation', path: '/p', fields: { x: '/p/{键}/x' } }, hostile, null);
  assert.ok(!relation.includes('<img') && relation.includes('&lt;img'), 'a relation shows the key escaped');
  const tags = core.renderBlock({ type: 'tags', path: '/p' }, hostile, null);
  assert.ok(!tags.includes('<img') && tags.includes('&lt;img'), 'a tag list shows the key escaped');
  const list = core.renderBlock({ type: 'list', path: '/p', fields: { x: '/p/{键}/x' }, recent: 5 }, hostile, null);
  assert.ok(!list.includes('<img'), 'a list renders field labels and values, never the raw key');
});

test('pages and the summary come out in sheet order with icons', () => {
  const sheet = { kind: '状态栏', form: 'placeholder', title: '样卡', collapsed: true, summary: [item('/主角/生命', { label: '生命', kind: '数值', range: [0, 100] })], pages: [{ name: '状态', icon: 'heart', blocks: [{ type: 'text', text: '一' }] }, { name: '人物', blocks: [{ type: 'text', text: '二' }] }] };
  const pages = core.renderPages(sheet, data, null);
  assert.deepEqual(pages.pages.map((page: { name: string }) => page.name), ['状态', '人物']);
  assert.match(pages.pages[0].icon, /^<svg/); assert.equal(pages.pages[1].icon, '');
  assert.match(pages.pages[0].html, /一/);
  assert.equal(core.renderSummary(sheet, data), '<span class="cw-summary-item"><b>生命</b>62 / 100</span>');
});

test('the body renderer follows the modules and falls back to readable text', () => {
  const sheet = { kind: '正文美化', root: 'content', floors: 10, statusHead: false, playerMark: '#', custom: [], modules: [{ tag: 'time', role: '页眉' }, { tag: 'story', role: '正文' }, { tag: 'now_plot', role: '折叠', label: '当前剧情' }] };
  const source = ['<time>雾港历1年01月01日</time>', '<story>', '海雾很重。', '', '{老周}「你来了。」', '{#}「嗯。」', '</story>', '<now_plot>船票</now_plot>', '<mood>紧张</mood>'].join(NL);
  const html = core.renderBody(sheet, source);
  assert.match(html, /<header class="cw-head">雾港历1年01月01日<\/header>/);
  assert.match(html, /<p class="cw-para">海雾很重。<\/p>/);
  assert.match(html, /<p class="cw-say"><b class="cw-speaker">老周<\/b><q>你来了。<\/q><\/p>/);
  assert.match(html, /<p class="cw-say is-player"><b class="cw-speaker">你<\/b><q>嗯。<\/q><\/p>/);
  assert.match(html, /<details class="cw-fold"><summary>当前剧情<\/summary><p class="cw-para">船票<\/p><\/details>/);
  assert.match(html, /<p class="cw-para">紧张<\/p>/, 'an unlisted tag shows its text');
  const broken = core.renderBody(sheet, '没有标签的一段话' + NL + '第二段');
  assert.match(broken, /<div class="cw-fallback">/);
  assert.match(broken, /没有标签的一段话/);
  assert.match(core.renderBody(sheet, '<story>&lt;b&gt;</story>'), /&amp;lt;b&amp;gt;/, 'text is escaped, never trusted');
});

test('the creation page renders a step, the review and the navigation', () => {
  const sheet = { kind: '创角页', title: '登记', steps: [{ name: '身份', custom: false, fields: [{ key: '姓名', type: '文本', required: true, hint: '你的名字' }, { key: '出身', type: '单选', required: false, options: ['渔民', '商贾'] }, { key: '体质', type: '滑杆', required: false, range: [1, 10] }, { key: '熟人', type: '人物列表', required: false, options: ['林砚', '老周'], max: 2 }] }, { name: '补充', custom: true, fields: [{ key: '补充', type: '长文本', required: false }] }], writes: { entry: null, opening: null, variables: false } };
  const first = core.renderStart(sheet, { 姓名: '林', 出身: '渔民', 熟人: ['老周'] }, 0);
  assert.match(first, /<ol class="cw-steps">(<li[^>]*>[^<]*<\/li>){3}<\/ol>/, 'two steps plus the review');
  assert.match(first, /<li class="cw-step is-current">身份<\/li>/);
  assert.match(first, /<input class="cw-input" type="text" data-cw-field="姓名" value="林" placeholder="你的名字" required>/);
  assert.match(first, /<label class="cw-choice is-on"><input type="radio" name="出身" value="渔民" data-cw-field="出身" checked>渔民<\/label>/);
  assert.match(first, /<input class="cw-slider" type="range" min="1" max="10" value="1" data-cw-field="体质">/);
  assert.match(first, /<label class="cw-choice is-on"><input type="checkbox" value="老周" data-cw-field="熟人" data-cw-max="2" checked>老周<\/label>/);
  assert.match(first, /<button type="button" class="cw-btn" data-cw-nav="back" disabled>上一步<\/button>/);
  assert.match(first, /<button type="button" class="cw-btn is-primary" data-cw-nav="next">下一步<\/button>/);
  const review = core.renderStart(sheet, { 姓名: '林', 补充: '想当船长' }, 2);
  assert.match(review, /<dt>姓名<\/dt><dd>林<\/dd>/);
  assert.match(review, /<dt>出身<\/dt><dd class="is-missing">未填<\/dd>/);
  assert.match(review, /<dd>想当船长<\/dd>/);
  assert.match(review, /data-cw-nav="submit">开始<\/button>/);
  const reviewList = core.renderStart(sheet, { 姓名: '林', 熟人: ['老周', '阿七'] }, 2);
  assert.match(reviewList, /<dd>老周、阿七<\/dd>/, 'an array answer reads as an enumeration');
});

import { cssDeclarations } from '../src/shared/card-studio/frontend.ts';

/** host.js needs core.js and timers; document and window stay absent so nothing DOM-bound can leak into the helpers. */
function loadHost() {
  const sandbox: Record<string, unknown> = { setTimeout, clearTimeout, console };
  runInNewContext(readFileSync(join(runtime, 'core.js'), 'utf8') + NL + readFileSync(join(runtime, 'host.js'), 'utf8'), sandbox);
  return { host: sandbox.CardwrightHost as Record<string, any>, sandbox };
}
/** Objects made inside the vm carry that realm's prototypes, and strict deepEqual compares prototypes: compare plain copies. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('the host fills templates, upserts world book entries and clamps positions without a DOM', () => {
  const { host } = loadHost();
  const { fillTemplate, upsertEntry, clampPosition, entryOf } = host.helpers;
  assert.equal(fillTemplate('玩家：{姓名}，熟人：{熟人}。{补充}', { 姓名: '林砚', 熟人: ['老周', '阿七'] }), '玩家：林砚，熟人：老周、阿七。');
  assert.equal(fillTemplate('{姓名}', {}), '', 'a missing field leaves nothing behind');
  const entry = entryOf('[样卡] 初始人物设定', '内容');
  assert.deepEqual(plain(entry), { name: '[样卡] 初始人物设定', enabled: true, strategy: { type: 'constant' }, position: { type: 'before_character_definition', order: 100 }, content: '内容' });
  const once = upsertEntry([{ name: '别的', content: 'x' }], entry);
  assert.equal(once.length, 2);
  const twice = upsertEntry(once, entryOf('[样卡] 初始人物设定', '新内容'));
  assert.equal(twice.length, 2, 'the managed entry is updated, not added again');
  assert.equal(twice[1].content, '新内容');
  assert.deepEqual(plain(clampPosition({ x: -20, y: 5000 }, { width: 400, height: 800 }, 56)), { x: 0, y: 744 });
});

test('waiting for MVU gives up after the timeout and still probes', async () => {
  const { host, sandbox } = loadHost();
  sandbox.waitGlobalInitialized = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await host.helpers.waitMvu(40), false, 'no Mvu global after the wait');
  assert.ok(Date.now() - started >= 35);
  sandbox.Mvu = { getMvuData: () => ({ stat_data: { 主角: { 生命: 1 } } }) };
  assert.equal(await host.helpers.waitMvu(40), true);
  assert.deepEqual(plain(host.helpers.readData()), { 主角: { 生命: 1 } });
  delete sandbox.Mvu;
  sandbox.getVariables = () => ({ stat_data: { 主角: { 生命: 2 } } });
  assert.deepEqual(plain(host.helpers.readData()), { 主角: { 生命: 2 } }, 'getVariables is the fallback');
  delete sandbox.getVariables;
  assert.deepEqual(plain(host.helpers.readData()), {}, 'nothing at all gives an empty object, not an error');
});

test('base.css is structural: colours only through tokens, one media query for phones and one for reduced motion', () => {
  const css = readFileSync(join(runtime, '..', 'base.css'), 'utf8');
  const declarations = cssDeclarations(css);
  const hard = declarations.filter(item => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(item.value) && !/var\(/.test(item.value) && !/^--/.test(item.property));
  assert.deepEqual(hard.map(item => `${item.selector} ${item.property}`), [], 'no hard-coded colours outside tokens');
  assert.ok(declarations.some(item => item.media.some(media => /prefers-reduced-motion/.test(media))));
  assert.ok(declarations.some(item => item.media.some(media => /max-width/.test(media))));
  assert.ok(/:focus-visible/.test(css) && /:hover/.test(css) && /:active/.test(css));
  const accent = (css.match(/var\(\s*--accent\s*[,)]/g) ?? []).length;
  assert.ok(accent <= 5, `base.css uses --accent ${accent} times; the quality check allows 8 for the whole document and the skins need room`);
  assert.ok(css.length <= 12 * 1024, `base.css is ${css.length} bytes`);
});

test('setAt builds nested objects by pointer and refuses prototype keys', () => {
  const { host } = loadHost();
  const { setAt } = host.helpers;
  const made: Record<string, unknown> = {};
  setAt(made, '/a/b', 1);
  assert.deepEqual(plain(made), { a: { b: 1 } });
  setAt(made, '/a/b', 2);
  assert.deepEqual(plain(made), { a: { b: 2 } }, 'a leaf is overwritten in place');
  setAt(made, '/__proto__/x', 'polluted');
  setAt(made, '/constructor/prototype/x', 'polluted');
  assert.equal(({} as Record<string, unknown>).x, undefined, 'prototype segments are ignored, nothing leaks');
  assert.deepEqual(plain(made), { a: { b: 2 } }, 'the refused writes changed nothing');
});

test('isLatest trusts the floor ids and stays true when the interface is missing or throws', () => {
  const { host, sandbox } = loadHost();
  const { isLatest } = host.helpers;
  assert.equal(isLatest(), true, 'no floor interface means acting as the latest floor');
  sandbox.getCurrentMessageId = () => 3;
  sandbox.getLastMessageId = () => 3;
  assert.equal(isLatest(), true);
  sandbox.getLastMessageId = () => 5;
  assert.equal(isLatest(), false);
  sandbox.getCurrentMessageId = () => { throw new Error('boom'); };
  assert.equal(isLatest(), true, 'a throwing interface never hides the view');
});
