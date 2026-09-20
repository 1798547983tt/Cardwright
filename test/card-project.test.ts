import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARD_FILE, CARD_FOLDERS, COVER_STYLES, createCardFolder, parseCardFile, readCardFile, writeCardFile } from '../src/core/card-studio/card-project.ts';

async function temp(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-card-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const fixed = { now: new Date('2026-09-17T08:00:00.000Z'), random: () => 0.99, id: 'card-fixture' };

test('creates the card project folders and registration file', async t => {
  const folder = join(await temp(t), '西游·八十一难');
  const { file, reused } = await createCardFolder({ folder, name: ' 西游·八十一难 ', kind: 'fan', source: '西游记', ...fixed });
  assert.equal(reused, false);
  for (const relative of CARD_FOLDERS) assert.ok((await stat(join(folder, relative))).isDirectory(), relative);
  assert.deepEqual(file, {
    schema: 'cardwright.card-project', version: 1, cardId: 'card-fixture', name: '西游·八十一难', kind: 'fan', source: '西游记',
    coverStyle: COVER_STYLES[4], stylePreset: null, origin: 'new', createdAt: fixed.now.toISOString(), updatedAt: fixed.now.toISOString(), dispatches: [], exports: [], nextUid: 0,
  });
  assert.deepEqual(JSON.parse(await readFile(join(folder, CARD_FILE), 'utf8')), file);
});

test('an original card has no source and picks its cover style from the random source', async t => {
  const root = await temp(t);
  const { file } = await createCardFolder({ folder: join(root, 'a'), name: '雾港档案局', kind: 'original', source: '不会保存', ...fixed, random: () => 0 });
  assert.equal(file.source, undefined);
  assert.equal(file.coverStyle, COVER_STYLES[0]);
});

test('rejects invalid card names, a missing source and a relative folder', async t => {
  const root = await temp(t);
  await assert.rejects(createCardFolder({ folder: join(root, 'a'), name: '  ', kind: 'original' }), /请填写卡名/);
  await assert.rejects(createCardFolder({ folder: join(root, 'b'), name: '名'.repeat(41), kind: 'original' }), /卡名不能超过 40 个字/);
  await assert.rejects(createCardFolder({ folder: join(root, 'c'), name: '西游:八十一难', kind: 'original' }), /卡名不能包含/);
  await assert.rejects(createCardFolder({ folder: join(root, 'd'), name: '西游', kind: 'fan', source: ' ' }), /请填写原作名/);
  await assert.rejects(createCardFolder({ folder: 'relative/folder', name: '西游', kind: 'original' }), /请选择卡项目文件夹/);
});

test('registers an existing card project folder again without changing it', async t => {
  const folder = join(await temp(t), 'existing');
  const { file } = await createCardFolder({ folder, name: '深渊收容录', kind: 'original', ...fixed });
  const before = await readFile(join(folder, CARD_FILE));
  const again = await createCardFolder({ folder, name: '另一个名字', kind: 'fan', source: '无', now: new Date('2030-01-01') });
  assert.equal(again.reused, true);
  assert.deepEqual(again.file, file);
  assert.deepEqual(await readFile(join(folder, CARD_FILE)), before);
});

test('refuses a non-empty folder that is not a card project', async t => {
  const folder = join(await temp(t), 'busy');
  await mkdir(folder); await writeFile(join(folder, 'notes.txt'), 'mine');
  await assert.rejects(createCardFolder({ folder, name: '第七区终端', kind: 'original' }), /这个文件夹不是空的/);
});

test('validates registration files and keeps unknown fields', async t => {
  const folder = join(await temp(t), 'card');
  const { file } = await createCardFolder({ folder, name: '汽灯与铜镜', kind: 'original', ...fixed });
  assert.throws(() => parseCardFile({ ...file, schema: 'something-else' }), /不是卡项目登记文件/);
  assert.throws(() => parseCardFile({ ...file, version: 2 }), /更新版本的 Cardwright/);
  assert.throws(() => parseCardFile({ ...file, kind: 'other' }), /同人或原创/);
  const dispatch = { id: 'd1', target: '世界书/人设', sectionId: 'lore-people', title: '写人物模板', requires: '', body: '', status: 'todo', createdAt: file.createdAt, updatedAt: file.createdAt };
  assert.throws(() => parseCardFile({ ...file, dispatches: [{ ...dispatch, status: 'maybe' }] }), /派单记录无效/);
  await writeCardFile(folder, { ...file, dispatches: [dispatch], futureField: { kept: true } } as typeof file);
  const read = await readCardFile(folder);
  assert.deepEqual(read.dispatches, [dispatch]);
  assert.deepEqual((read as unknown as { futureField: unknown }).futureField, { kept: true });
  assert.deepEqual((await readdir(folder)).filter(name => name.endsWith('.tmp')), []);
});
