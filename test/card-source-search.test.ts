import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importSources } from '../src/core/card-studio/sources.ts';
import { searchSources } from '../src/core/card-studio/source-search.ts';

const NOVEL = [
  '第一回　灵根育孕源流出',
  '诗曰：混沌未分天地乱，茫茫渺渺无人见。',
  '东胜神洲海外有一国土，名曰傲来国。',
  '第二回　悟彻菩提真妙理',
  '话表美猴王得了姓名，怡然踊跃。',
  '第三回　四海千山皆拱伏',
  '却说那红孩儿住在火云洞，号圣婴大王。',
  '红孩儿又喷出三昧真火，把行者烧得难当。',
  'Sun Wukong laughed at the RED BOY.',
].join('\n');

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-source-search-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'card');
  await createCardFolder({ folder: root, name: '西游', kind: 'fan', source: '西游记', now: new Date('2026-09-19T08:00:00Z') });
  await mkdir(join(directory, 'incoming'));
  const file = join(directory, 'incoming', '西游记.txt');
  await writeFile(file, NOVEL, 'utf8');
  await importSources(root, [file]);
  return { root, directory };
}

test('a keyword search returns the file, material, chapter title, line and a snippet', async t => {
  const { root } = await setup(t);
  const result = await searchSources(root, { query: '红孩儿' });
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.results.map(item => [item.source, item.chapter, item.line]), [['西游记.txt', '第三回　四海千山皆拱伏', 2], ['西游记.txt', '第三回　四海千山皆拱伏', 3]]);
  assert.match(result.results[0].file, /^资料\/分章\/西游记\/0003-/);
  assert.match(result.results[0].snippet, /红孩儿住在火云洞/);
});

test('several words must all appear, and Latin letters ignore case', async t => {
  const { root } = await setup(t);
  assert.deepEqual((await searchSources(root, { query: '红孩儿 三昧真火' })).results.map(item => item.line), [3]);
  assert.equal((await searchSources(root, { query: 'red boy' })).total, 1);
});

test('a regular expression can be used, and a broken one gets a plain message', async t => {
  const { root } = await setup(t);
  const result = await searchSources(root, { query: '第.回', regex: true });
  assert.deepEqual(result.results.map(item => item.chapter), ['第一回　灵根育孕源流出', '第二回　悟彻菩提真妙理', '第三回　四海千山皆拱伏']);
  await assert.rejects(searchSources(root, { query: '红孩儿(', regex: true }), /正则写法有误/);
  await assert.rejects(searchSources(root, { query: 'x'.repeat(201), regex: true }), /不超过 200/);
  await assert.rejects(searchSources(root, { query: '  ' }), /要搜的词/);
});

test('results stop at the limit and say how many there were', async t => {
  const { root } = await setup(t);
  const result = await searchSources(root, { query: '.', regex: true, limit: 2 });
  assert.equal(result.results.length, 2);
  assert.ok(result.total > 2);
  assert.equal(result.truncated, true);
  assert.equal((await searchSources(root, { query: '.', regex: true, limit: 500 })).results.length <= 50, true);
});

test('only chapter files under 资料/分章 are read, whatever the manifest says', async t => {
  const { root, directory } = await setup(t);
  await writeFile(join(directory, 'secret.txt'), '红孩儿的秘密', 'utf8');
  const manifestPath = join(root, '资料', '.cardwright-sources.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.sources[0].chapters.push({ index: 99, title: '越界', chars: 6, path: '资料/分章/../../../secret.txt' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await searchSources(root, { query: '秘密' });
  assert.equal(result.total, 0);
});

test('a card without material says so', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-source-search-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'card');
  await createCardFolder({ folder: root, name: '空卡', kind: 'original', now: new Date('2026-09-19T08:00:00Z') });
  const result = await searchSources(root, { query: '红孩儿' });
  assert.deepEqual(result.results, []);
  assert.match(result.note ?? '', /还没有导入资料/);
});
