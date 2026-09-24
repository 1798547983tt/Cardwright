import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder, readCardFile } from '../src/core/card-studio/card-project.ts';
import { buildLorebookFromProject, createComponent, importCard, importLorebook, moveLoreComponents, readProject } from '../src/core/card-studio/components.ts';
import { buildCardFromProject } from '../src/core/card-studio/assembly.ts';
import { buildCard, splitCard } from '../src/shared/card-studio/card-file.ts';
import { RE0_CARD } from './reference-cards.ts';

const exists = (path: string) => existsSync(path);
const CTX = { frontend: null, table: null, cardName: '样卡' };

async function project(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-components-')), '卡项目');
  await createCardFolder({ folder: root, name: '西游·八十一难', kind: 'fan', source: '西游记', random: () => 0 });
  return root;
}

const sampleCard = () => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡', first_mes: '开场一',
  data: {
    name: '样卡', description: '', first_mes: '开场一', alternate_greetings: ['开场二'], group_only_greetings: ['群聊开场'],
    character_book: {
      name: '样卡世界书', entries: [
        { id: 5, keys: [], comment: '正文格式', content: '<content>', constant: true, selective: true, insertion_order: 0, enabled: true, position: 'after_char', use_regex: true, extensions: { position: 4, depth: 0, display_index: 0 } },
        { id: 2, keys: ['爱蜜莉雅'], comment: '爱蜜莉雅', content: '<爱蜜莉雅>\n正文\n</爱蜜莉雅>', constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char', use_regex: true, extensions: { position: 0, depth: 4, display_index: 1 } },
      ],
    },
    extensions: {
      world: '样卡世界书',
      regex_scripts: [{ id: 'r1', scriptName: '正文美化', findRegex: '/<content>/i', replaceString: '<div>看板</div>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0 }],
      tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: 'import "mvu";', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: {} },
    },
  },
});

test('new components get their uid from the application and never reuse it', async () => {
  const root = await project();
  const first = await createComponent(root, { board: 'lore', section: 'lore-people', name: '红孩儿' });
  assert.equal(first.uid, 0);
  assert.equal(first.paramsPath, '世界书/人设/100-红孩儿.json');
  assert.equal(first.bodyPath, '世界书/人设/100-红孩儿.md');
  assert.equal(await readFile(join(root, first.bodyPath), 'utf8'), '<红孩儿>\n\n</红孩儿>\n');
  const params = JSON.parse(await readFile(join(root, first.paramsPath), 'utf8')) as Record<string, unknown>;
  assert.equal(params.uid, 0);
  assert.equal(params.order, 100);
  assert.equal(params.excludeRecursion, true);
  assert.equal(params.content, undefined, 'the body never lives in the parameters');
  assert.equal((await readCardFile(root)).nextUid, 1);

  const second = await createComponent(root, { board: 'lore', section: 'lore-people', name: '红孩儿' });
  assert.equal(second.uid, 1);
  assert.equal(second.paramsPath, '世界书/人设/100-红孩儿~1.json', 'same name and order gets a uid suffix');

  await rm(join(root, second.paramsPath));
  await rm(join(root, second.bodyPath));
  const third = await createComponent(root, { board: 'lore', section: 'lore-plot', name: '第01卷｜王都', keys: ['第01卷'] });
  assert.equal(third.uid, 2, 'a deleted component does not free its uid');
  assert.equal(third.paramsPath, '世界书/剧情/300-第01卷｜王都.json');
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('a card imports into components and exports back unchanged', async () => {
  const root = await project();
  const card = sampleCard();
  const report = await importCard(root, card);
  assert.equal(report.lore, 2);
  assert.equal(report.regex, 1);
  assert.equal(report.scripts, 1);
  assert.deepEqual(report.issues, []);
  assert.ok(existsSync(join(root, '世界书/正文格式/0-正文格式.md')));
  assert.ok(existsSync(join(root, '世界书/人设/100-爱蜜莉雅.json')));
  assert.ok(existsSync(join(root, '正则/01-正文美化.html')));
  assert.equal(await readFile(join(root, '正则/01-正文美化.html'), 'utf8'), '<div>看板</div>');
  assert.ok(existsSync(join(root, '脚本/01-MVU.js')));
  assert.equal(await readFile(join(root, '开场白/00-开场.md'), 'utf8'), '开场一');
  assert.equal(await readFile(join(root, '开场白/群聊/01-群聊开场.md'), 'utf8'), '群聊开场');
  assert.equal((await readCardFile(root)).nextUid, 6, 'the counter starts after the biggest imported uid');

  const project1 = await readProject(root);
  assert.deepEqual(project1.issues, []);
  assert.equal(project1.lore.length, 2);
  assert.deepEqual(project1.lore.map(item => item.params.uid), [5, 2], 'the imported entry order is kept');
  // The component files add nothing of their own: the export matches what the same card rebuilds to in memory.
  assert.deepEqual(buildCardFromProject(project1, CTX), buildCard(splitCard(card)));
  const exported = buildCardFromProject(project1, CTX) as Record<string, Record<string, Record<string, Array<Record<string, unknown>>>>>;
  assert.deepEqual(exported.data.character_book.entries.map(item => item.id), [5, 2]);
  assert.equal(exported.data.character_book.entries[1].content as unknown as string, ['<爱蜜莉雅>', '正文', '</爱蜜莉雅>'].join(String.fromCharCode(10)));
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('editing a body file changes the exported card', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  await writeFile(join(root, '世界书/人设/100-爱蜜莉雅.md'), '<爱蜜莉雅>\n改过的正文\n</爱蜜莉雅>');
  const card = buildCardFromProject(await readProject(root), CTX) as Record<string, Record<string, Record<string, Array<Record<string, unknown>>>>>;
  const entry = card.data.character_book.entries.find(item => item.id === 2)!;
  assert.equal(entry.content, '<爱蜜莉雅>\n改过的正文\n</爱蜜莉雅>');
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('broken and orphaned component files are reported, not swallowed', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  await writeFile(join(root, '世界书/设定/20-坏参数.json'), '{ 这不是 JSON');
  await writeFile(join(root, '世界书/设定/21-只有正文.md'), '正文');
  await writeFile(join(root, '世界书/人设/100-爱蜜莉雅.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, '世界书/人设/100-爱蜜莉雅.json'), 'utf8')), uid: 5 }));
  const found = await readProject(root);
  const codes = found.issues.map(issue => issue.code).sort();
  assert.deepEqual(codes, ['duplicate-uid', 'orphan-body', 'params-parse']);
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('a standalone world book imports, and a second import needs replace', async () => {
  const root = await project();
  const book = { entries: { 0: { uid: 0, key: ['王都'], comment: '王都', content: '<王都>\n城。\n</王都>', constant: false, order: 52, position: 0, disable: false, displayIndex: 0 } } };
  const report = await importLorebook(root, book, { name: '样卡世界书' });
  assert.equal(report.lore, 1);
  assert.ok(existsSync(join(root, '世界书/设定/52-王都.md')));
  await assert.rejects(importLorebook(root, book, { name: '样卡世界书' }), /已经有世界书条目/);

  const replaced = await importLorebook(root, { entries: { 7: { uid: 7, key: [], comment: '新的条目', content: '正文', constant: true, order: 3, position: 0 } } }, { name: '新书', replace: true });
  assert.equal(replaced.lore, 1);
  assert.equal(existsSync(join(root, '世界书/设定/52-王都.md')), false, 'replacing clears the old entries');
  const exported = buildLorebookFromProject(await readProject(root)) as { entries: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(exported.entries), ['7']);
  assert.equal(exported.entries['7'].content, '正文');
  assert.equal(exported.entries['7'].$card, undefined);
  await rm(join(root, '..'), { recursive: true, force: true });
});

// 1.1 Q22 整理未分类: a component moves by moving its pair; nothing inside it changes and nothing already there is replaced.
test('moving unclassified entries keeps uid, order and body and never takes a name the section has', async () => {
  const root = await project();
  const entry = (uid: number, comment: string, order: number, content: string) => ({ uid, key: [comment], comment, content, constant: false, order, position: 0 });
  await importLorebook(root, { entries: { 3: entry(3, '楚子航', 101, '<楚子航>\r\n师兄。\r\n</楚子航>'), 4: entry(4, 'mika', 103, '<mika>\n小写。\n</mika>'), 5: entry(5, '路明非', 102, '<路明非>\n衰仔。\n</路明非>') } }, { name: '龙族' });
  // Already in 人设: one with the same name, and one differing only in case, which on Windows is the same file.
  const same = await createComponent(root, { board: 'lore', section: 'lore-people', name: '楚子航', order: 101 });
  await createComponent(root, { board: 'lore', section: 'lore-people', name: 'Mika', order: 103 });
  const before = await readProject(root);
  assert.deepEqual(before.lore.filter(item => item.section === 'lore-other').map(item => item.uid), [3, 4, 5]);
  const bytes = (path: string) => readFile(join(root, ...path.split('/')));
  const original = new Map(await Promise.all(before.lore.map(async item => [item.uid, [await bytes(item.paramsPath), await bytes(item.bodyPath)]] as const)));

  await assert.rejects(moveLoreComponents(root, ['世界书/未分类/103-mika.json', '世界书/未分类/没有这条.json'], 'lore-people'), /找不到/);
  await assert.rejects(moveLoreComponents(root, ['世界书/未分类/103-mika.json'], 'lore-nowhere'), /未知的世界书分区/);
  const moved = await moveLoreComponents(root, ['世界书/未分类/101-楚子航.json', '世界书/未分类/103-mika.json'], 'lore-people');
  assert.deepEqual(moved, ['世界书/人设/101-楚子航~3.json', '世界书/人设/103-mika~4.json']);

  const after = await readProject(root);
  assert.deepEqual(after.issues, []);
  assert.deepEqual(after.book.order, before.book.order, 'the export order is the book, which a move leaves alone');
  assert.deepEqual(after.lore.map(item => [item.uid, item.section]), [[3, 'lore-people'], [4, 'lore-people'], [5, 'lore-other'], [same.uid, 'lore-people'], [same.uid + 1, 'lore-people']]);
  for (const item of after.lore) assert.deepEqual([await bytes(item.paramsPath), await bytes(item.bodyPath)], original.get(item.uid), `uid ${item.uid} is byte for byte what it was`);
  assert.deepEqual((await readdir(join(root, '世界书/未分类'))).sort(), ['102-路明非.json', '102-路明非.md']);
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('the Re0 card round trips through component files', { skip: exists(RE0_CARD) ? false : 'reference card not available' }, async () => {
  const root = await project();
  const card = JSON.parse(readFileSync(RE0_CARD, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  const report = await importCard(root, card);
  assert.equal(report.lore, 290);
  assert.deepEqual(report.issues, []);
  const found = await readProject(root);
  assert.deepEqual(found.issues, []);
  assert.deepEqual(buildCardFromProject(found, CTX), card);
  const files = await readdir(join(root, '世界书/人设'));
  assert.ok(files.length > 200, 'the character entries land in the 人设 folder');
  const book = buildLorebookFromProject(found) as { entries: Record<string, unknown> };
  assert.equal(Object.keys(book.entries).length, 290);
  assert.deepEqual(splitCard(card).lore.map(item => item.params.uid), found.lore.map(item => item.params.uid), 'entry order survives the file layout');
  await rm(join(root, '..'), { recursive: true, force: true });
});

const freshProject = project;

test('a regex component can be born as a sheet, with the find expression its kind uses', async () => {
  const root = await freshProject();
  const status = await createComponent(root, { board: 'regex', name: '状态栏', format: 'sheet' });
  assert.equal(status.bodyPath, '正则/01-状态栏.yaml');
  assert.match(await readFile(join(root, status.bodyPath), 'utf8'), /^# 装配单[\s\S]*^前端: 状态栏$/m);
  const params = JSON.parse(await readFile(join(root, status.paramsPath), 'utf8'));
  assert.equal(params.findRegex, String.raw`/<StatusPlaceHolderImpl\/>/g`);
  const body = await createComponent(root, { board: 'regex', name: '正文美化', format: 'sheet' });
  assert.equal(JSON.parse(await readFile(join(root, body.paramsPath), 'utf8')).findRegex, String.raw`/<content>([\s\S]*?)<\/content>/is`);
  assert.equal(JSON.parse(await readFile(join(root, body.paramsPath), 'utf8')).maxDepth, 9);
  const start = await createComponent(root, { board: 'regex', name: '开局创角页', format: 'sheet' });
  assert.deepEqual(JSON.parse(await readFile(join(root, start.paramsPath), 'utf8')).placement, [1, 2]);
  const project = await readProject(root);
  assert.deepEqual(project.regex.map(item => `${item.name}:${item.format}`), ['01-状态栏:yaml', '02-正文美化:yaml', '03-开局创角页:yaml']);
  const plain = await createComponent(root, { board: 'regex', name: '旧楼层', });
  assert.equal(plain.bodyPath, '正则/04-旧楼层.html');
  assert.equal((await readProject(root)).regex[3].format, 'html');
});

test('a component with both a sheet and a document is reported and the sheet wins', async () => {
  const root = await freshProject();
  const made = await createComponent(root, { board: 'regex', name: '状态栏', format: 'sheet' });
  await writeFile(join(root, made.bodyPath.replace(/\.yaml$/, '.html')), '<!DOCTYPE html><html></html>');
  const project = await readProject(root);
  assert.equal(project.regex.length, 1);
  assert.equal(project.regex[0].format, 'yaml');
  assert.deepEqual(project.issues.map(issue => issue.code), ['duplicate-body']);
});

test('the sheet starter is picked by name, and an unmatched name starts as a status bar', async () => {
  const root = await freshProject();
  const body = async (result: { bodyPath: string }) => readFile(join(root, result.bodyPath), 'utf8');
  assert.match(await body(await createComponent(root, { board: 'regex', name: '状态栏', format: 'sheet' })), /^前端: 状态栏$/m);
  assert.match(await body(await createComponent(root, { board: 'regex', name: '正文美化', format: 'sheet' })), /^前端: 正文美化$/m);
  assert.match(await body(await createComponent(root, { board: 'regex', name: '开局创角页', format: 'sheet' })), /^前端: 创角页$/m);
  const fallback = await createComponent(root, { board: 'regex', name: '面板', format: 'sheet' });
  assert.match(await body(fallback), /^前端: 状态栏$/m);
  assert.equal(JSON.parse(await readFile(join(root, fallback.paramsPath), 'utf8')).findRegex, String.raw`/<StatusPlaceHolderImpl\/>/g`);
});
