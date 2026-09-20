import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { buildPiece, importCard, importPiece, pieceFileName, readProject } from '../src/core/card-studio/components.ts';

async function project(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-pieces-')), '卡项目');
  await createCardFolder({ folder: root, name: '雾港档案', kind: 'original', random: () => 0 });
  return root;
}

const regexPiece = { id: 'r1', scriptName: '正文美化', findRegex: '/<content>([\\s\\S]*?)<\\/content>/i', replaceString: '<div class="mist">$1</div>', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
const scriptPiece = { type: 'script', enabled: true, name: '变量结构', id: 's1', content: 'import "mvu";\nconsole.log(1);', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } };
const sampleCard = () => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '雾港档案', first_mes: '雾。',
  data: {
    name: '雾港档案', description: '', first_mes: '雾。', alternate_greetings: [], group_only_greetings: [],
    character_book: { name: '雾港档案世界书', entries: [] },
    extensions: { regex_scripts: [regexPiece], tavern_helper: { scripts: [scriptPiece], variables: {} } },
  },
});

test('a piece exports exactly what the card carried', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  const components = await readProject(root);
  assert.deepEqual(buildPiece(components, 'regex', '01-正文美化'), regexPiece, 'the body goes back into replaceString, in the same field order');
  assert.deepEqual(buildPiece(components, 'script', '01-变量结构'), scriptPiece, 'the body goes back into content');
  assert.ok(Object.keys(buildPiece(components, 'regex', '01-正文美化')).join(',').includes('scriptName,replaceString'), 'the body is written back right after the name, as buildCard does');
  assert.throws(() => buildPiece(components, 'regex', '没有这个'), /没有这个/);
});

test('the export file name carries the piece, the version and the date', () => {
  assert.equal(pieceFileName('regex', '01-正文美化', 'v2', '20260917'), '正则-01-正文美化-v2-20260917.json');
  assert.equal(pieceFileName('script', '01-变量结构', '', '20260917'), '脚本-01-变量结构-20260917.json');
});

test('an exported piece imports into another project', async () => {
  const root = await project();
  const report = await importPiece(root, regexPiece);
  assert.deepEqual({ kind: report.kind, name: report.name, replaced: report.replaced }, { kind: 'regex', name: '01-正文美化', replaced: false });
  assert.equal(report.paramsPath, '正则/01-正文美化.json');
  assert.equal(report.bodyPath, '正则/01-正文美化.html');
  assert.equal(await readFile(join(root, '正则/01-正文美化.html'), 'utf8'), regexPiece.replaceString, 'the body is a file of its own');
  assert.equal(JSON.parse(await readFile(join(root, '正则/01-正文美化.json'), 'utf8')).replaceString, undefined, 'and never stays in the parameters');
  assert.deepEqual(buildPiece(await readProject(root), 'regex', '01-正文美化'), regexPiece, 'the round trip is lossless');

  const script = await importPiece(root, scriptPiece);
  assert.equal(script.bodyPath, '脚本/01-变量结构.js');
  assert.deepEqual(buildPiece(await readProject(root), 'script', '01-变量结构'), scriptPiece);
});

test('importing a piece again replaces the one with the same id', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  const changed = { ...regexPiece, scriptName: '正文美化 v2', replaceString: '<div class="mist2">$1</div>', disabled: true };
  const report = await importPiece(root, changed);
  assert.equal(report.replaced, true, 'the same id replaces the component in place');
  assert.equal(report.name, '01-正文美化', 'and keeps the file it already had');
  assert.deepEqual((await readdir(join(root, '正则'))).sort(), ['01-正文美化.html', '01-正文美化.json'], 'no second copy appears');
  assert.deepEqual(buildPiece(await readProject(root), 'regex', '01-正文美化'), changed);
});

test('a piece with a new id is added next to the ones already there', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  const other = { ...regexPiece, id: 'r2', scriptName: '状态栏' };
  const report = await importPiece(root, other);
  assert.deepEqual({ name: report.name, replaced: report.replaced }, { name: '02-状态栏', replaced: false });
  assert.equal((await readProject(root)).regex.length, 2);
});

test('only regex and script pieces are accepted', async () => {
  const root = await project();
  await assert.rejects(() => importPiece(root, { name: '世界书', entries: {} }), /正则|脚本/);
  await assert.rejects(() => importPiece(root, 'not an object'), /正则|脚本/);
  await assert.rejects(() => importPiece(root, { id: 'x' }), /正则|脚本/);
});
