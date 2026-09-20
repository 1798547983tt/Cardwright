import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileRefs } from '../src/shared/file-refs.ts';
import { languageOf, tokenizeLine } from '../src/shared/code-view.ts';

test('a path with a line number becomes a reference, and lookalikes do not', () => {
  const found = parseFileRefs('根因在 src/core/git.ts:59，另见 src/main/harness.ts:566-569 和 tests/a_b.test.tsx:3。');
  assert.deepEqual(found.map(item => [item.path, item.line, item.endLine]), [
    ['src/core/git.ts', 59, undefined],
    ['src/main/harness.ts', 566, 569],
    ['tests/a_b.test.tsx', 3, undefined],
  ]);
  assert.deepEqual(parseFileRefs('打开 http://localhost:3000 看看'), []);
  assert.deepEqual(parseFileRefs('会议在 10:30，版本 1.2:3'), []);
  assert.deepEqual(parseFileRefs('src/a.ts：12 用的是中文冒号'), []);
  assert.deepEqual(parseFileRefs('C:/work/app/src/main.ts:8').map(item => item.path), ['C:/work/app/src/main.ts']);
  assert.deepEqual(parseFileRefs('src\\main\\harness.ts:12').map(item => [item.path, item.line]), [['src\\main\\harness.ts', 12]]);
  // The offsets point back at the original text so the renderer can split around them.
  const one = parseFileRefs('见 src/a.ts:7 结束')[0];
  assert.equal('见 src/a.ts:7 结束'.slice(one.start, one.end), 'src/a.ts:7');
});

test('a line is coloured by what it is, and the language comes from the extension', () => {
  assert.equal(languageOf('src/main/harness.ts'), 'ts');
  assert.equal(languageOf('README.md'), 'markdown');
  assert.equal(languageOf('data.json'), 'json');
  assert.equal(languageOf('run.ps1'), 'shell');
  assert.equal(languageOf('notes.unknown'), 'text');
  const line = tokenizeLine("const name = 'hello'; // a note", 'ts');
  assert.deepEqual(line.filter(part => part.kind !== 'text').map(part => [part.kind, part.text]), [
    ['keyword', 'const'], ['string', "'hello'"], ['comment', '// a note'],
  ]);
  assert.deepEqual(tokenizeLine('# 只是注释', 'shell').map(part => part.kind), ['comment']);
  assert.deepEqual(tokenizeLine('普通文字', 'text').map(part => [part.kind, part.text]), [['text', '普通文字']]);
  assert.equal(tokenizeLine('const x = 42;', 'ts').some(part => part.kind === 'number' && part.text === '42'), true);
  // Whatever it does, the parts always add back up to the original line.
  const source = 'function f(a) { return "x" /* keep */; } // tail';
  assert.equal(tokenizeLine(source, 'ts').map(part => part.text).join(''), source);
});
