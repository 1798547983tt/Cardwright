import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { createComponent, readProject } from '../src/core/card-studio/components.ts';
import { buildCardFromCompiled, buildCardFromProject, buildPiece, compileProject, isSheetComponent, regexReplacement, FLOATING_SUFFIX, NO_SKELETON_MESSAGE, type AssemblyContext } from '../src/core/card-studio/assembly.ts';
import { loadFrontendResources } from '../src/core/card-studio/frontend-resources.ts';
import { parseVariableTable } from '../src/shared/card-studio/variable-table.ts';
import { frontendDocument } from '../src/shared/card-studio/frontend.ts';
import { BODY_SHEET, START_SHEET, STATUS_SHEET } from './assembly-sheet-samples.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

const NL = String.fromCharCode(10);
const resources = await loadFrontendResources(fileURLToPath(new URL('../card-studio', import.meta.url)));
const context = (over: Partial<AssemblyContext> = {}): AssemblyContext => ({ frontend: resources, table: parseVariableTable(SAMPLE_TABLE), cardName: '样卡', preset: 'sakura', ...over });

async function project(sheets: Record<string, string>, extra: Record<string, string> = {}) {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-assembly-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  await writeFile(join(root, '变量表.yaml'), SAMPLE_TABLE);
  for (const [name, body] of Object.entries(sheets)) { const made = await createComponent(root, { board: 'regex', name, format: 'sheet' }); await writeFile(join(root, made.bodyPath), body); }
  for (const [name, body] of Object.entries(extra)) { const made = await createComponent(root, { board: 'regex', name }); await writeFile(join(root, made.bodyPath), body); }
  return { root, components: await readProject(root), clean: () => rm(join(root, '..'), { recursive: true, force: true }) };
}

test('sheets compile into fenced documents and hand-written bodies pass through as before', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET, 正文美化: BODY_SHEET, 开局创角页: START_SHEET }, { 旧楼层: '$1' });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues, []);
  assert.deepEqual(compiled.regex.map(item => item.component.name), ['01-状态栏', '02-正文美化', '03-开局创角页', '04-旧楼层']);
  assert.match(compiled.regex[0].replacement, new RegExp('^```html' + NL + '<!DOCTYPE html>'));
  assert.ok(compiled.regex[0].replacement.trimEnd().endsWith('```'));
  assert.equal(compiled.regex[0].form, 'placeholder');
  assert.equal(compiled.regex[3].replacement, '$1');
  assert.equal(regexReplacement(components.regex[3], compiled), '$1');
  assert.equal(regexReplacement(components.regex[0], compiled), compiled.regex[0].replacement);
  const card = buildCardFromProject(components, context());
  const scripts = (card.data as { extensions: { regex_scripts: Array<{ scriptName: string; replaceString: string }> } }).extensions.regex_scripts;
  assert.equal(scripts[0].scriptName, '状态栏');
  assert.ok(frontendDocument(scripts[0].replaceString)?.includes('CardwrightHost.boot()'));
  assert.equal(compiled.scripts.length, 0, 'no floating app, no synthesized script');
  await clean();
});

test('a header status bar empties its own regex and rides in the body document', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET.replace('形态: placeholder', '形态: header'), 正文美化: BODY_SHEET.replace('状态头: false', '状态头: true') });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues, []);
  assert.equal(compiled.regex[0].replacement, '');
  assert.match(compiled.regex[1].replacement, /cw-status-head/);
  await clean();
});

test('a status head path the table lacks is reported once, on the status sheet', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET.replace('形态: placeholder', '形态: header').replace('/主角/在逃', '/主角/魔力'), 正文美化: BODY_SHEET.replace('状态头: false', '状态头: true') });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues.map(issue => `${issue.code}@${issue.bodyPath}`), ['variable-binding@正则/01-状态栏.yaml']);
  assert.match(compiled.regex[1].replacement, /cw-status-head/);
  await clean();
});

test('buildCardFromCompiled builds the card of a project already compiled; isSheetComponent tells a 装配单 body from a document', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET, 空的: '' }, { 旧楼层: '$1', 前端开头: STATUS_SHEET });
  const compiled = compileProject(components, context());
  assert.deepEqual(buildCardFromCompiled(components, compiled), buildCardFromProject(components, context()));
  assert.deepEqual(components.regex.map(item => [item.name, isSheetComponent(item)]), [['01-状态栏', true], ['02-空的', true], ['03-旧楼层', false], ['04-前端开头', true]]);
  await clean();
});

test('a floating status bar synthesizes a 酒馆助手 script the card and the pieces carry', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET.replace('形态: placeholder', '形态: floating') });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues, []);
  assert.equal(compiled.regex[0].replacement, '');
  assert.equal(compiled.scripts.length, 1);
  const script = compiled.scripts[0];
  assert.equal(script.name, `01-状态栏${FLOATING_SUFFIX}`);
  assert.equal(script.params.id, `${components.regex[0].params.id}-floating`);
  assert.equal(script.params.name, `状态栏${FLOATING_SUFFIX}`);
  assert.match(script.body, /CardwrightFloating\.mount/);
  const card = buildCardFromProject(components, context());
  const helper = (card.data as { extensions: { tavern_helper: { scripts: Array<{ name: string; content: string }> } } }).extensions.tavern_helper.scripts;
  assert.equal(helper.at(-1)?.name, `状态栏${FLOATING_SUFFIX}`);
  const piece = buildPiece(components, 'script', script.name, context());
  assert.equal(piece.name, `状态栏${FLOATING_SUFFIX}`);
  assert.match(String(piece.content), /Cardwright skeleton/);
  await clean();
});

test('a sheet that does not parse or bind is an issue on its component, and the card still builds', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET.replace('前端: 状态栏', '前端: 舞台'), 开局创角页: START_SHEET.replace('/主角/姓名', '/主角/称号') });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues.map(issue => `${issue.code}@${issue.bodyPath}`), ['sheet-invalid@正则/01-状态栏.yaml', 'variable-binding@正则/02-开局创角页.yaml']);
  assert.equal(compiled.regex[0].replacement, '');
  assert.ok(compiled.regex[1].replacement.startsWith('```html'));
  assert.doesNotThrow(() => buildCardFromProject(components, context()));
  const none = compileProject(components, context({ frontend: null }));
  assert.deepEqual(none.issues.map(issue => `${issue.code}@${issue.bodyPath}`), ['sheet-invalid@正则/01-状态栏.yaml', 'sheet-invalid@'], 'without the skeleton a parse error stays on its sheet, and the rest is one issue without a path');
  assert.equal(none.issues[1].message, NO_SKELETON_MESSAGE);
  assert.equal(none.regex[1].replacement, '');
  await clean();
});

test('the second sheet of a kind is reported on the later component and still compiles on its own', async () => {
  const { components, clean } = await project({ 状态栏: STATUS_SHEET, 备用状态栏: STATUS_SHEET });
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues.map(issue => `${issue.code}@${issue.bodyPath}`), ['sheet-invalid@正则/02-备用状态栏.yaml']);
  assert.match(compiled.issues[0].message, /第 2 个「状态栏」装配单/);
  assert.ok(compiled.regex[0].replacement.startsWith('```html'));
  assert.ok(compiled.regex[1].replacement.startsWith('```html'), 'the extra sheet still compiles on its own');
  await clean();
});

test('a disabled regex synthesizes a floating script that starts disabled', async () => {
  const { root, components, clean } = await project({ 状态栏: STATUS_SHEET.replace('形态: placeholder', '形态: floating') });
  const params = JSON.parse(await readFile(join(root, components.regex[0].paramsPath), 'utf8')) as Record<string, unknown>;
  await writeFile(join(root, components.regex[0].paramsPath), JSON.stringify({ ...params, disabled: true }, null, 2));
  const compiled = compileProject(await readProject(root), context());
  assert.equal(compiled.scripts.length, 1);
  assert.equal(compiled.scripts[0].params.enabled, false);
  await clean();
});

test('an .html body that opens with 前端: is treated as a sheet and compiled', async () => {
  const { components, clean } = await project({}, { 状态栏: STATUS_SHEET });
  assert.equal(components.regex[0].format, 'html');
  const compiled = compileProject(components, context());
  assert.deepEqual(compiled.issues, []);
  assert.ok(compiled.regex[0].replacement.startsWith('```html'));
  assert.equal(compiled.regex[0].form, 'placeholder');
  const none = compileProject(components, context({ frontend: null }));
  assert.equal(none.regex[0].replacement, '');
  assert.equal(none.regex[0].form, 'placeholder', 'the form comes from the sheet, skeleton or not');
  assert.deepEqual(none.issues.map(issue => `${issue.code}@${issue.component}@${issue.bodyPath}`), ['sheet-invalid@@']);
  await clean();
});
