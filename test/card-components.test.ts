import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder, readCardFile } from '../src/core/card-studio/card-project.ts';
import { buildCardFromProject, buildLorebookFromProject, createComponent, importCard, importLorebook, readProject } from '../src/core/card-studio/components.ts';
import { buildCard, splitCard } from '../src/shared/card-studio/card-file.ts';

const RE0_CARD = 'E:/Cardwright/参考资料/完整的卡/json格式的卡/Re0：从零开始的异世界生活.json';
const exists = (path: string) => existsSync(path);

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
  assert.deepEqual(buildCardFromProject(project1), buildCard(splitCard(card)));
  const exported = buildCardFromProject(project1) as Record<string, Record<string, Record<string, Array<Record<string, unknown>>>>>;
  assert.deepEqual(exported.data.character_book.entries.map(item => item.id), [5, 2]);
  assert.equal(exported.data.character_book.entries[1].content as unknown as string, ['<爱蜜莉雅>', '正文', '</爱蜜莉雅>'].join(String.fromCharCode(10)));
  await rm(join(root, '..'), { recursive: true, force: true });
});

test('editing a body file changes the exported card', async () => {
  const root = await project();
  await importCard(root, sampleCard());
  await writeFile(join(root, '世界书/人设/100-爱蜜莉雅.md'), '<爱蜜莉雅>\n改过的正文\n</爱蜜莉雅>');
  const card = buildCardFromProject(await readProject(root)) as Record<string, Record<string, Record<string, Array<Record<string, unknown>>>>>;
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

test('the Re0 card round trips through component files', { skip: exists(RE0_CARD) ? false : 'reference card not available' }, async () => {
  const root = await project();
  const card = JSON.parse(readFileSync(RE0_CARD, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  const report = await importCard(root, card);
  assert.equal(report.lore, 290);
  assert.deepEqual(report.issues, []);
  const found = await readProject(root);
  assert.deepEqual(found.issues, []);
  assert.deepEqual(buildCardFromProject(found), card);
  const files = await readdir(join(root, '世界书/人设'));
  assert.ok(files.length > 200, 'the character entries land in the 人设 folder');
  const book = buildLorebookFromProject(found) as { entries: Record<string, unknown> };
  assert.equal(Object.keys(book.entries).length, 290);
  assert.deepEqual(splitCard(card).lore.map(item => item.params.uid), found.lore.map(item => item.params.uid), 'entry order survives the file layout');
  await rm(join(root, '..'), { recursive: true, force: true });
});
