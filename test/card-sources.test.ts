import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importSources, readSourceManifest, resplitSource } from '../src/core/card-studio/sources.ts';

// 「第一回　灵根育孕源流出\n诗曰：混沌未分天地乱。\n第二回　悟彻菩提真妙理\n话表美猴王得了姓名。\n」 encoded as GBK.
const gbkNovel = Buffer.from('b5dad2bbbbd8a1a1c1e9b8f9d3fdd4d0d4b4c1f7b3f60acaabd4bba3babbece3e7ceb4b7d6ccecb5d8c2d2a1a30ab5dab6febbd8a1a1cef2b3b9c6d0cce1d5e6c3eec0ed0abbb0b1edc3c0baefcdf5b5c3c1cbd0d5c3fba1a30a', 'hex');

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-card-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'card');
  await createCardFolder({ folder: root, name: '西游·八十一难', kind: 'fan', source: '西游记', now: new Date('2026-09-17T08:00:00Z') });
  const incoming = join(directory, 'incoming');
  await (await import('node:fs/promises')).mkdir(incoming);
  return { root, incoming };
}

function png(chunks: Array<[string, Buffer]>): Buffer {
  const chunk = ([type, data]: [string, Buffer]) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...[['IHDR', Buffer.alloc(13)] as [string, Buffer], ...chunks, ['IEND', Buffer.alloc(0)] as [string, Buffer]].map(chunk)]);
}

test('imports a GBK novel: original copy, UTF-8 chapters and the material index', async t => {
  const { root, incoming } = await setup(t);
  const source = join(incoming, '西游记.txt');
  await writeFile(source, gbkNovel);
  const report = await importSources(root, [source], { now: new Date('2026-09-17T09:00:00Z') });
  assert.deepEqual(report.rejected, []);
  const [record] = report.imported;
  assert.equal(record.name, '西游记.txt');
  assert.equal(record.kind, 'text');
  assert.equal(record.encoding, 'GB18030/GBK → UTF-8');
  assert.deepEqual(record.split, { mode: 'headings', level: '回', parts: 2 });
  assert.deepEqual(record.chapters?.map(chapter => [chapter.title, chapter.path]), [
    ['第一回　灵根育孕源流出', '资料/分章/西游记/0001-第一回 灵根育孕源流出.txt'],
    ['第二回　悟彻菩提真妙理', '资料/分章/西游记/0002-第二回 悟彻菩提真妙理.txt'],
  ]);
  assert.deepEqual(await readFile(join(root, '资料', '原件', '西游记.txt')), gbkNovel);
  const chapter = await readFile(join(root, '资料', '分章', '西游记', '0001-第一回 灵根育孕源流出.txt'));
  assert.notDeepEqual([...chapter.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(chapter.toString('utf8'), '第一回　灵根育孕源流出\n诗曰：混沌未分天地乱。');
  const index = await readFile(join(root, '资料', '索引.md'), 'utf8');
  for (const expected of ['# 资料索引', '## 西游记.txt', '资料/原件/西游记.txt', 'GB18030/GBK → UTF-8', '按章节标题（回），2 份', '| 1 | 第一回　灵根育孕源流出 | 21 | 资料/分章/西游记/0001-第一回 灵根育孕源流出.txt |']) assert.ok(index.includes(expected), expected);
  assert.deepEqual((await readSourceManifest(root)).map(item => item.name), ['西游记.txt']);
});

test('renames a second import with the same file name', async t => {
  const { root, incoming } = await setup(t);
  const source = join(incoming, '西游记.txt');
  await writeFile(source, gbkNovel);
  await importSources(root, [source]);
  const second = await importSources(root, [source]);
  assert.equal(second.imported[0].name, '西游记 (2).txt');
  assert.ok((await stat(join(root, '资料', '分章', '西游记 (2)', '0002-第二回 悟彻菩提真妙理.txt'))).isFile());
  assert.deepEqual((await readSourceManifest(root)).map(item => item.name), ['西游记.txt', '西游记 (2).txt']);
});

test('copies JSON, PNG character cards and images as reference material without splitting', async t => {
  const { root, incoming } = await setup(t);
  const files: Array<[string, Buffer]> = [
    ['世界书.json', Buffer.from(JSON.stringify({ entries: { 0: { uid: 0, content: '甲' } } }))],
    ['角色卡.png', png([['tEXt', Buffer.from('chara\0e30=', 'latin1')]])],
    ['立绘.png', png([])],
    ['草图.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ];
  for (const [name, bytes] of files) await writeFile(join(incoming, name), bytes);
  const report = await importSources(root, files.map(([name]) => join(incoming, name)));
  assert.deepEqual(report.imported.map(item => [item.name, item.kind, item.chapters]), [['世界书.json', 'json', undefined], ['角色卡.png', 'card-png', undefined], ['立绘.png', 'image', undefined], ['草图.jpg', 'image', undefined]]);
  assert.deepEqual(await readdir(join(root, '资料', '分章')), []);
  const index = await readFile(join(root, '资料', '索引.md'), 'utf8');
  for (const expected of ['JSON 参考资料（世界书）', 'PNG 角色卡（参考资料）', '图片']) assert.ok(index.includes(expected), expected);
});

test('rejects formats that must be converted first, unknown types, folders and oversized files', async t => {
  const { root, incoming } = await setup(t);
  for (const name of ['设定.docx', '小说.pdf', '小说.epub', '程序.exe', '大.txt']) await writeFile(join(incoming, name), 'x'.repeat(32));
  const report = await importSources(root, ['设定.docx', '小说.pdf', '小说.epub', '程序.exe', '大.txt'].map(name => join(incoming, name)).concat(incoming), { limitBytes: 16 });
  assert.deepEqual(report.imported, []);
  assert.deepEqual(report.rejected, [
    { name: '设定.docx', reason: '请先转成 txt 再导入' }, { name: '小说.pdf', reason: '请先转成 txt 再导入' }, { name: '小说.epub', reason: '请先转成 txt 再导入' },
    { name: '程序.exe', reason: '不支持这种文件类型' }, { name: '大.txt', reason: '文件太大（上限 64 MB）' }, { name: 'incoming', reason: '请选择文件，不支持文件夹' },
  ]);
});

test('re-splits one source into fixed-size parts and rewrites the index', async t => {
  const { root, incoming } = await setup(t);
  const source = join(incoming, '西游记.txt');
  await writeFile(source, gbkNovel);
  await importSources(root, [source]);
  const record = await resplitSource(root, '西游记.txt', 'fixed', { size: 6000 });
  assert.deepEqual(record.split, { mode: 'fixed', parts: 1, size: 6000, manual: true });
  assert.deepEqual(await readdir(join(root, '资料', '分章', '西游记')), ['0001-第 1 份.txt']);
  const index = await readFile(join(root, '资料', '索引.md'), 'utf8');
  assert.ok(index.includes('切分：按固定字数重新切分（约 6,000 字一份），1 份'));
  await assert.rejects(resplitSource(root, '不存在.txt', 'auto'), /找不到这份资料/);
});
