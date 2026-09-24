import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importCard, readProject } from '../src/core/card-studio/components.ts';
import { buildCardFromProject, buildPiece } from '../src/core/card-studio/assembly.ts';
import { runChecks } from '../src/core/card-studio/checks.ts';

const CTX = { frontend: null, table: null, cardName: '样卡' };

const FENCE = '`'.repeat(3);
const NL = String.fromCharCode(10);
/** An iframe front-end as the regex sections write it: one HTML document, no fence (Q2). */
const documentBody = [
  '<!DOCTYPE html>', '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><style>:root { --bg: #111; } .bar:hover { color: #fff; }</style></head>',
  '<body><button class="bar">状态栏</button><script>document.querySelector(".bar").addEventListener("click", () => {});</script></body>',
  '</html>',
].join(NL);
/** The variable update receipt is inline: a section and its style, no script, no fence. */
const inlineReceipt = ['<section data-update>', '<details><summary>变量更新</summary><pre>$1</pre></details>', '</section>', '<style>section[data-update] summary { cursor: pointer; }</style>'].join(NL);

const regex = (id: string, scriptName: string, findRegex: string, replaceString: string) => ({ id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null });
const statusBar = (body: string, id = 'r1', name = '状态栏') => regex(id, name, '<StatusPlaceHolderImpl/>', body);
const updateReceipt = (body: string, id = 'r2', name = '变量更新') => regex(id, name, String.raw`/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/g`, body);

async function project(regexScripts: Array<ReturnType<typeof regex>>): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-frontend-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  await importCard(root, { spec: 'chara_card_v3', spec_version: '3.0', name: '样卡', data: { name: '样卡', first_mes: '开场', extensions: { regex_scripts: regexScripts } } });
  return root;
}
const clean = (root: string) => rm(join(root, '..'), { recursive: true, force: true });
const exported = (card: Record<string, unknown>) => ((card.data as Record<string, unknown>).extensions as { regex_scripts: Array<{ scriptName: string; replaceString: string }> }).regex_scripts;

test('an iframe front-end is wrapped in the html fence when the card is assembled, and its file keeps the bare document', async () => {
  const root = await project([statusBar(documentBody), updateReceipt(inlineReceipt)]);
  const scripts = exported(buildCardFromProject(await readProject(root), CTX));
  assert.equal(scripts[0].replaceString, `${FENCE}html${NL}${documentBody}${NL}${FENCE}`, 'starts with the html fence and ends with </html> and the closing fence, the way the Re0 card does');
  assert.equal(scripts[1].replaceString, inlineReceipt, 'the inline update receipt stays unfenced');
  assert.equal(await readFile(join(root, '正则', '01-状态栏.html'), 'utf8'), documentBody, 'the component file holds only the HTML document');
  await clean(root);
});

test('a front-end that already carries the fence is not wrapped twice', async () => {
  const fenced = `${FENCE}html${NL}${documentBody}${NL}${FENCE}`;
  const root = await project([statusBar(fenced)]);
  assert.equal(exported(buildCardFromProject(await readProject(root), CTX))[0].replaceString, fenced);
  await clean(root);
});

test('a trailing newline in the document file does not end up inside the fence', async () => {
  const root = await project([statusBar(`${documentBody}${NL}${NL}`)]);
  assert.equal(exported(buildCardFromProject(await readProject(root), CTX))[0].replaceString, `${FENCE}html${NL}${documentBody}${NL}${FENCE}`);
  await clean(root);
});

test('a regex exported on its own carries the fence too', async () => {
  const root = await project([statusBar(documentBody), updateReceipt(inlineReceipt)]);
  const components = await readProject(root);
  assert.equal(buildPiece(components, 'regex', '01-状态栏', CTX).replaceString, `${FENCE}html${NL}${documentBody}${NL}${FENCE}`);
  assert.equal(buildPiece(components, 'regex', '02-变量更新', CTX).replaceString, inlineReceipt);
  await clean(root);
});

test('the assembly checks report a front-end whose fence is missing, misplaced or not closed after </html>', async () => {
  const root = await project([
    statusBar(documentBody, 'r1', '状态栏'),
    updateReceipt(inlineReceipt, 'r2', '变量更新'),
    statusBar(`${documentBody}${NL}多写了一行`, 'r3', '尾巴'),
    updateReceipt(`${FENCE}html${NL}${inlineReceipt}${NL}${FENCE}`, 'r4', '内联包了围栏'),
    statusBar(`${FENCE}html${NL}${documentBody.replace('</html>', '')}${NL}${FENCE}`, 'r5', '没有收尾'),
    updateReceipt(`${inlineReceipt}${NL}<script>alert(1)</script>`, 'r6', '内联带脚本'),
  ]);
  const report = await runChecks(root);
  const fence = report.findings.filter(item => item.code === 'frontend-fence');
  assert.ok(fence.every(item => item.level === 'error'), 'fence problems are errors');
  assert.deepEqual(fence.map(item => item.path).sort(), ['正则/03-尾巴.html', '正则/04-内联包了围栏.html', '正则/05-没有收尾.html', '正则/06-内联带脚本.html']);
  assert.equal(report.ok, false, 'they block the export');
  await clean(root);
});

test('the assembly checks run the front-end quality checks on each iframe front-end: errors block the export, warnings do not', async () => {
  const root = await project([statusBar(documentBody), updateReceipt(inlineReceipt)]);
  const report = await runChecks(root);
  const quality = report.findings.filter(item => item.code.startsWith('frontend-') && item.code !== 'frontend-fence');
  assert.deepEqual(quality.map(item => `${item.level}:${item.code}:${item.path}`).sort(), [
    'warning:frontend-media:正则/01-状态栏.html',
    'warning:frontend-tokens:正则/01-状态栏.html',
  ], 'the sample document has feedback and a listener, but one token and no @media; the inline receipt is not a front-end document');
  assert.ok(quality.every(item => item.message.startsWith('「状态栏」')), 'each finding names its regex');
  assert.equal(report.ok, true, 'warnings alone do not block the export');

  const wide = await project([statusBar(documentBody.replace('.bar:hover { color: #fff; }', '.sheet { width: 520px; }').replace('.addEventListener("click", () => {})', '.dataset.ready = "1"'))]);
  const blocked = await runChecks(wide);
  assert.deepEqual(blocked.findings.filter(item => item.level === 'error' && item.code.startsWith('frontend-')).map(item => item.code).sort(), ['frontend-interaction', 'frontend-mobile']);
  assert.equal(blocked.ok, false);
  await clean(root); await clean(wide);
});

test('a clean front-end and a clean inline receipt pass the fence check', async () => {
  const root = await project([statusBar(documentBody), updateReceipt(inlineReceipt)]);
  const report = await runChecks(root);
  assert.deepEqual(report.findings.filter(item => item.code === 'frontend-fence'), []);
  await clean(root);
});
