import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRegexParams, compileRegex, parseFindRegex, regexHits, sampleOutputFrom } from '../src/core/card-studio/regex.ts';

const NL = String.fromCharCode(10);
const params = (over: Record<string, unknown> = {}) => ({ id: 'r1', scriptName: '正文美化', findRegex: '/<content>([\\s\\S]*?)<\\/content>/is', replaceString: '<div>$1</div>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: 0, maxDepth: null, ...over });

test('a find pattern written as /pattern/flags compiles', () => {
  const spec = parseFindRegex('/<content>([\\s\\S]*?)<\\/content>/is');
  assert.equal(spec.flags, 'is');
  assert.equal(spec.source.startsWith('<content>'), true);
  const regex = compileRegex('/<content>([\\s\\S]*?)<\\/content>/is');
  assert.equal(regex.flags.includes('i'), true);
});

test('a bare pattern is taken literally', () => {
  const spec = parseFindRegex('<StatusPlaceHolderImpl/>');
  assert.equal(spec.flags, '');
  assert.equal(spec.source, '<StatusPlaceHolderImpl/>');
  assert.equal(compileRegex('<StatusPlaceHolderImpl/>').test('前 <StatusPlaceHolderImpl/> 后'), true);
});

test('a pattern that cannot compile says why', () => {
  assert.throws(() => compileRegex('/(未闭合/g'), /正则无法编译/);
  assert.throws(() => compileRegex(''), /没有填查找表达式/);
});

test('the sample output is taken from the fenced block of the text format entry', () => {
  const format = ['<customize_format>', '根标签 content', '</customize_format>', '', '```示例输出', '<content>', '<time>雾港历1年01月01日</time>', '</content>', '```'].join(NL);
  const sample = sampleOutputFrom(format);
  assert.ok(sample?.includes('<content>'));
  assert.equal(sampleOutputFrom('没有示例的条目'), null);
});

test('a display regex that never matches the sample output is reported', () => {
  const sample = ['<content>', '<time>雾港历1年01月01日</time>', '</content>'].join(NL);
  assert.equal(regexHits(compileRegex(params().findRegex), sample), true);
  assert.equal(regexHits(compileRegex('/<never_used>/i'), sample), false);
});

test('placement, depth and the world book rule are checked', () => {
  assert.deepEqual(checkRegexParams(params()).map(item => item.code), []);
  assert.deepEqual(checkRegexParams(params({ placement: [9] })).map(item => item.code), ['regex-placement']);
  assert.deepEqual(checkRegexParams(params({ placement: [] })).map(item => item.code), ['regex-placement']);
  assert.deepEqual(checkRegexParams(params({ placement: [5], promptOnly: false })).map(item => item.code), ['regex-world-book']);
  assert.deepEqual(checkRegexParams(params({ placement: [5], promptOnly: true })).map(item => item.code), []);
  assert.deepEqual(checkRegexParams(params({ minDepth: 6, maxDepth: 2 })).map(item => item.code), ['regex-depth']);
  assert.deepEqual(checkRegexParams(params({ markdownOnly: false, promptOnly: false })).map(item => item.code), ['regex-effect']);
  assert.deepEqual(checkRegexParams(params({ scriptName: '' })).map(item => item.code), ['regex-name']);
});
