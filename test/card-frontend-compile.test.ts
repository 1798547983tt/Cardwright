// test/card-frontend-compile.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { loadFrontendResources } from '../src/core/card-studio/frontend-resources.ts';
import { compileSheet, compress, enrichSheet, type CompileContext } from '../src/shared/card-studio/frontend-compile.ts';
import { parseAssemblySheet, type BodySheet, type StatusSheet } from '../src/shared/card-studio/assembly-sheet.ts';
import { parseVariableTable } from '../src/shared/card-studio/variable-table.ts';
import { frontendQuality, isHtmlDocument } from '../src/shared/card-studio/frontend.ts';
import { STYLE_PRESETS } from '../src/shared/card-studio/style-presets.ts';
import { BODY_SHEET, START_SHEET, STATUS_SHEET } from './assembly-sheet-samples.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

const resourcesDir = fileURLToPath(new URL('../card-studio', import.meta.url));
const NL = String.fromCharCode(10);
const table = parseVariableTable(SAMPLE_TABLE);
const resources = await loadFrontendResources(resourcesDir);
const context = (over: Partial<CompileContext> = {}): CompileContext => ({ resources, table, cardName: '样卡', regexId: 'r-status', ...over });
const errors = (html: string) => frontendQuality(html).filter(item => item.level === 'error').map(item => `${item.code}: ${item.message}`);
const TOKENS = Object.fromEntries(['--bg', '--panel', '--panel-2', '--line', '--line-strong', '--text', '--text-2', '--text-3', '--accent', '--accent-2', '--ok', '--warn', '--danger', '--radius', '--radius-sm', '--shadow', '--sans', '--serif', '--mono'].map((name, index) => [name, name.startsWith('--radius') ? '6px' : name === '--shadow' ? 'none' : name.startsWith('--sans') || name.startsWith('--serif') || name.startsWith('--mono') ? 'sans-serif' : name === '--bg' ? '#101214' : name === '--panel' ? '#171a1e' : name === '--text' ? '#e9ecee' : `#${(index * 37 % 200 + 40).toString(16).padStart(2, '0')}8899`]));

test('the resources load with the runtime version and every skin', () => {
  assert.match(resources.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(resources.skins).sort(), STYLE_PRESETS.map(preset => preset.id).sort());
  assert.ok(resources.core.includes('CardwrightCore') && resources.host.includes('CardwrightHost') && resources.floating.includes('CardwrightFloating') && resources.base.includes('.cw-app'));
});

test('the shipped runtime never carries what SillyTavern would substitute in a replacement', () => {
  for (const [name, text] of Object.entries({ core: resources.core, host: resources.host, floating: resources.floating, base: resources.base, ...resources.skins })) {
    assert.ok(!/\$(?:\d|<)/.test(text), `${name} contains a $-group that the regex engine would replace`);
    assert.ok(!text.includes('{{'), `${name} contains {{ which SillyTavern treats as a macro`);
    assert.ok(!/^\s*`{3}/m.test(text), `${name} contains a line of three backticks that would close the fence`);
  }
});

test('a placeholder status bar compiles into a document that passes the quality check under every skin', () => {
  const sheet = parseAssemblySheet(STATUS_SHEET) as StatusSheet;
  for (const preset of STYLE_PRESETS) {
    const withPreset = { ...sheet, preset: preset.id, ...(preset.id === 'custom' ? { tokens: TOKENS } : {}) };
    const result = compileSheet(withPreset, context());
    assert.deepEqual(result.issues, [], preset.id);
    assert.equal(result.kind, '状态栏'); assert.equal(result.form, 'placeholder');
    assert.ok(isHtmlDocument(result.html), preset.id);
    assert.deepEqual(errors(result.html), [], `${preset.id}: ${errors(result.html).join(' | ')}`);
    assert.match(result.html, new RegExp(`^<!DOCTYPE html>${NL}<!-- Cardwright skeleton ${resources.version} · ${preset.id} · placeholder -->`));
    assert.ok(result.html.length <= 64 * 1024, `${preset.id}: ${result.html.length} bytes`);
  }
  const html = compileSheet(sheet, context()).html;
  const embedded = JSON.parse(/<script id="cw-sheet" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
  assert.equal(embedded.cardName, '样卡');
  assert.deepEqual(embedded.pages[0].blocks[0].items[1], { path: '/主角/生命', kind: '数值', range: [0, 100] }, 'items carry the table row');
  assert.deepEqual(embedded.pages[1].blocks[0].barRange, [-100, 100], 'a relation bar takes the record row range');
  assert.ok(!html.includes('$1'), 'a status bar captures nothing');
  assert.match(html, /<main id="cw-app" class="cw-app is-status is-placeholder">/);
  assert.match(html, /CardwrightHost\.boot\(\)/);
});

test('a header status bar leaves the regex empty and rides inside the body beautifier', () => {
  const status = { ...parseAssemblySheet(STATUS_SHEET), form: 'header' } as StatusSheet;
  const alone = compileSheet(status, context());
  assert.equal(alone.html, '');
  assert.deepEqual(alone.issues.map(issue => issue.code), ['sheet-invalid']);
  assert.match(alone.issues[0].message, /正文美化/);
  const body = { ...(parseAssemblySheet(BODY_SHEET) as BodySheet), statusHead: true };
  assert.deepEqual(compileSheet(status, context({ bodySheet: body })).issues, []);
  const compiled = compileSheet(body, context({ statusSheet: status }));
  assert.deepEqual(compiled.issues, []);
  assert.match(compiled.html, /<div id="cw-status-head" class="cw-status-head"><\/div>/);
  assert.match(compiled.html, /<textarea id="cw-source" hidden>\$1<\/textarea>/);
  const embedded = JSON.parse(/<script id="cw-sheet" type="application\/json">([\s\S]*?)<\/script>/.exec(compiled.html)![1]);
  assert.equal(embedded.statusHead.kind, '状态栏');
  assert.deepEqual(errors(compiled.html), []);
  const orphan = compileSheet(body, context());
  assert.deepEqual(orphan.issues.map(issue => issue.code), ['sheet-invalid']);
});

test('the body sheet embeds the status head and leaves its paths to the status sheet', () => {
  const status = { ...parseAssemblySheet(STATUS_SHEET.replace('/主角/在逃', '/主角/魔力')), form: 'header' } as StatusSheet;
  const body = { ...(parseAssemblySheet(BODY_SHEET) as BodySheet), statusHead: true };
  assert.deepEqual(compileSheet(status, context({ bodySheet: body })).issues.map(issue => `${issue.code}:${issue.path}`), ['variable-binding:/主角/魔力'], 'the status sheet reports its own path');
  const compiled = compileSheet(body, context({ statusSheet: status }));
  assert.deepEqual(compiled.issues, [], 'the body sheet does not report it a second time');
  const embedded = JSON.parse(/<script id="cw-sheet" type="application\/json">([\s\S]*?)<\/script>/.exec(compiled.html)![1]);
  assert.equal(embedded.statusHead.pages[0].blocks[0].items[1].kind, '数值', 'the embedded head still carries the table rows');
});

test('a floating status bar becomes a 酒馆助手 script that mounts once on the page', () => {
  const status = { ...parseAssemblySheet(STATUS_SHEET), form: 'floating' } as StatusSheet;
  const result = compileSheet(status, context());
  assert.deepEqual(result.issues, []);
  assert.equal(result.html, '');
  assert.match(result.script ?? '', /^\/\/ Cardwright skeleton \d+\.\d+\.\d+ · sakura · floating/);
  assert.match(result.script ?? '', /CardwrightFloating\.mount\(\{ hostDocument, id: 'r-status'/);
  assert.match(result.script ?? '', /:host/, 'the skin tokens sit on :host inside the shadow root');
  assert.ok(!/\$(?:\d|<)/.test(result.script ?? '') && !(result.script ?? '').includes('{{'));
  assert.doesNotThrow(() => new Script(result.script ?? ''), 'the floating script parses as JavaScript');
  assert.ok((result.script ?? '').length <= 64 * 1024, `floating script is ${(result.script ?? '').length} chars`);
});

test('the floating script never carries a closing script tag, whatever the sheet says', () => {
  const text = STATUS_SHEET.replace('形态: placeholder', '形态: floating').replace(`HTML: '<div class="cw-seal">样卡</div>'`, `HTML: '<div class="cw-seal">样卡</script><b>x</b></div>'`);
  const result = compileSheet(parseAssemblySheet(text), context());
  assert.deepEqual(result.issues, []);
  assert.ok(!/<\/script/i.test(result.script ?? ''), 'no closing script tag in the floating script');
  assert.doesNotThrow(() => new Script(result.script ?? ''));
});

test('the creation page and the body beautifier compile and pass the quality check', () => {
  const start = compileSheet(parseAssemblySheet(START_SHEET), context());
  assert.deepEqual(start.issues, []);
  assert.deepEqual(errors(start.html), []);
  assert.match(start.html, /class="cw-app is-start"/);
  const body = compileSheet(parseAssemblySheet(BODY_SHEET), context());
  assert.deepEqual(body.issues, []);
  assert.deepEqual(errors(body.html), []);
  assert.match(body.html, /\.cw-note \{ color: var\(--text-3\)/, 'custom css rides along');
});

test('paths outside the table, missing tables and bars on the wrong rows are reported', () => {
  const sheet = parseAssemblySheet(STATUS_SHEET.replace('/主角/在逃', '/主角/魔力')) as StatusSheet;
  const result = compileSheet(sheet, context());
  assert.deepEqual(result.issues, [{ code: 'variable-binding', path: '/主角/魔力', message: '状态栏读的 /主角/魔力 不在变量表里，会显示「未知」。' }]);
  assert.ok(isHtmlDocument(result.html), 'the document still compiles so the preview can show the gap');
  const none = compileSheet(parseAssemblySheet(STATUS_SHEET), context({ table: null }));
  assert.deepEqual(none.issues.map(issue => issue.code), ['variable-table-missing']);
  const bars = parseAssemblySheet(STATUS_SHEET.replace('- 变量: /主角/生命' + NL + '            显示: 生命', '- 变量: /主角/姓名' + NL + '            显示: 生命')) as StatusSheet;
  const wrong = compileSheet(bars, context());
  assert.ok(wrong.issues.some(issue => issue.code === 'sheet-invalid' && /bars/.test(issue.message) && /\/主角\/姓名/.test(issue.message)), JSON.stringify(wrong.issues));
  assert.equal(compileSheet({ ...parseAssemblySheet(STATUS_SHEET), preset: undefined } as StatusSheet, context({ preset: 'custom' })).issues[0]?.code, 'sheet-invalid', 'a custom card preset needs tokens in the sheet');
  const noResources = compileSheet(parseAssemblySheet(STATUS_SHEET), context({ resources: null }));
  assert.deepEqual(noResources.issues.map(issue => issue.code), ['sheet-invalid']);
  assert.equal(noResources.html, '');
});

test('enrichSheet and compress are plain helpers', () => {
  const { sheet, missing } = enrichSheet(parseAssemblySheet(START_SHEET), table);
  assert.deepEqual(missing, []);
  assert.equal(sheet.kind, '创角页');
  assert.equal(compress(['// comment', '  const a = 1; // keep', '', '  /* block', '  */', "  const u = 'https://x';"].join(NL)), ["const a = 1; // keep", "const u = 'https://x';"].join(NL));
  assert.ok(compress(resources.core).length < resources.core.length);
  assert.equal(compress(['const kept = 1;', '* 2;'].join(NL)), 'const kept = 1;', 'a line starting with * is dropped as a comment: runtime code never begins a line with *');
  const original = parseAssemblySheet(STATUS_SHEET) as StatusSheet;
  const snapshot = JSON.stringify(original);
  enrichSheet(original, table);
  assert.equal(JSON.stringify(original), snapshot, 'enrichSheet copies the sheet rather than mutating it');
});

test('user content carrying $-sequences and a missing skin are reported, not shipped corrupted', () => {
  const status = parseAssemblySheet(STATUS_SHEET) as StatusSheet;
  const dollar = compileSheet({ ...status, title: '赏金$1章' }, context());
  assert.deepEqual(dollar.issues.map(issue => issue.code), ['sheet-invalid']);
  assert.match(dollar.issues[0].message, /\$/);
  assert.equal(dollar.html, '');
  const thinned = { ...resources, skins: { sakura: resources.skins.sakura, custom: resources.skins.custom } };
  const missing = compileSheet({ ...status, preset: 'neon' }, context({ resources: thinned }));
  assert.ok(missing.issues.some(issue => issue.code === 'sheet-invalid' && issue.message.includes('neon')), JSON.stringify(missing.issues));
  assert.ok(isHtmlDocument(missing.html), 'a missing skin still compiles on the fallback skin');
});
