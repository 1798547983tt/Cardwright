import test from 'node:test';
import assert from 'node:assert/strict';
import { countChars, splitChapters } from '../src/core/card-studio/chapters.ts';

const total = (chapters: Array<{ text: string }>) => countChars(chapters.map(chapter => chapter.text).join('\n'));

test('splits classic 回 headings and keeps every character', () => {
  const text = '第一回　灵根育孕源流出　心性修持大道生\n诗曰：混沌未分天地乱。\n\n第二回　悟彻菩提真妙理　断魔归本合元神\n话表美猴王得了姓名。\n第三回　四海千山皆拱伏　九幽十类尽除名\n却说美猴王荣归故里。\n';
  const result = splitChapters(text);
  assert.equal(result.mode, 'headings');
  assert.equal(result.level, '回');
  assert.deepEqual(result.chapters.map(chapter => chapter.title), ['第一回　灵根育孕源流出　心性修持大道生', '第二回　悟彻菩提真妙理　断魔归本合元神', '第三回　四海千山皆拱伏　九幽十类尽除名']);
  assert.deepEqual(result.chapters.map(chapter => chapter.index), [1, 2, 3]);
  assert.ok(result.chapters[0].text.includes('诗曰：混沌未分天地乱。'));
  assert.equal(result.chapters[1].chars, countChars('第二回　悟彻菩提真妙理　断魔归本合元神\n话表美猴王得了姓名。'));
  assert.equal(total(result.chapters), countChars(text));
});

test('splits by 卷 when volumes are the only headings', () => {
  const result = splitChapters('第一卷 风起\n内容甲\n第二卷 云涌\n内容乙');
  assert.equal(result.level, '卷');
  assert.deepEqual(result.chapters.map(chapter => chapter.title), ['第一卷 风起', '第二卷 云涌']);
});

test('splits by 章 inside volumes and records the volume of each chapter', () => {
  const text = '第一卷 风起\n第一章 初见\n内容一\n第二章 再见\n内容二\n第二卷 云涌\n第三章 离别\n内容三';
  const result = splitChapters(text);
  assert.equal(result.level, '章');
  assert.deepEqual(result.chapters.map(chapter => [chapter.title, chapter.volume]), [['第一章 初见', '第一卷 风起'], ['第二章 再见', '第一卷 风起'], ['第三章 离别', '第二卷 云涌']]);
  assert.equal(total(result.chapters), countChars(text));
});

test('ignores long lines, sentences and inline mentions that look like headings', () => {
  const long = `第一章 ${'很长的一句话'.repeat(12)}`;
  const text = `${long}\n他说第三章的内容最精彩。\n第二章 结束了。\n平常的段落。`;
  const result = splitChapters(text, { size: 20 });
  assert.equal(result.mode, 'fixed');
  assert.equal(total(result.chapters), countChars(text));
});

test('recognizes full-width, Arabic and Chinese numerals including 两 and 零', () => {
  const result = splitChapters('第１２章 全角\n甲\n第13章 阿拉伯\n乙\n第两百零一章 汉字\n丙');
  assert.deepEqual(result.chapters.map(chapter => chapter.title), ['第１２章 全角', '第13章 阿拉伯', '第两百零一章 汉字']);
});

test('uses the finest level that appears at least twice', () => {
  const result = splitChapters('第一卷 风起\n第一章 初见\n内容\n第二卷 云涌\n内容');
  assert.equal(result.level, '卷');
  assert.equal(result.chapters.length, 2);
});

test('keeps a short preface in the first chapter and a long one as its own part', () => {
  const short = splitChapters('序：短短几句。\n第一章 开始\n正文\n第二章 继续\n正文');
  assert.equal(short.chapters.length, 2);
  assert.ok(short.chapters[0].text.startsWith('序：短短几句。'));
  const long = splitChapters(`${'楔子内容'.repeat(60)}\n第一章 开始\n正文\n第二章 继续\n正文`);
  assert.deepEqual(long.chapters.map(chapter => chapter.title), ['前言', '第一章 开始', '第二章 继续']);
});

test('falls back to fixed-size parts at line boundaries when there are no headings', () => {
  const paragraph = (character: string) => character.repeat(300);
  const text = `${paragraph('甲')}\n\n${paragraph('乙')}\n\n${paragraph('丙')}`;
  const result = splitChapters(text, { size: 500 });
  assert.equal(result.mode, 'fixed');
  assert.equal(result.level, undefined);
  assert.deepEqual(result.chapters.map(chapter => chapter.title), ['第 1 份', '第 2 份', '第 3 份']);
  assert.ok(result.chapters.every(chapter => chapter.chars > 0));
  assert.equal(total(result.chapters), countChars(text));
});

test('cuts a single line longer than the size into several parts', () => {
  const result = splitChapters('字'.repeat(1200), { size: 500 });
  assert.deepEqual(result.chapters.map(chapter => chapter.chars), [500, 500, 200]);
});

test('can force fixed-size parts even when headings exist', () => {
  const result = splitChapters('第一章 甲\n内容\n第二章 乙\n内容', { mode: 'fixed', size: 6000 });
  assert.equal(result.mode, 'fixed');
  assert.equal(result.chapters.length, 1);
});

test('counts characters without whitespace', () => {
  assert.equal(countChars('a b\n\t　c'), 3);
});
