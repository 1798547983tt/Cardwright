import test from 'node:test';
import assert from 'node:assert/strict';
import { foldOutput, toolSummary } from '../src/shared/tool-view.ts';

const NL = String.fromCharCode(10);

test('short output is shown whole; long output keeps a head and says how much is left', () => {
  const short = ['行一', '行二', '行三'].join(NL);
  assert.deepEqual(foldOutput(short), { head: short, hiddenLines: 0, folded: false });
  const long = Array.from({ length: 120 }, (_, index) => `行 ${index + 1}`).join(NL);
  const folded = foldOutput(long);
  assert.equal(folded.folded, true);
  assert.equal(folded.head.split(NL).length, 40);
  assert.equal(folded.hiddenLines, 80);
  assert.match(folded.head, /^行 1/);
  // A single enormous line is cut by characters, not by lines.
  const wide = 'x'.repeat(12_000);
  const cut = foldOutput(wide);
  assert.equal(cut.folded, true);
  assert.equal(cut.head.length, 4_000);
  assert.equal(cut.hiddenLines, 0);
});

test('a tool call says in one line what it did', () => {
  const t = (_en: string, zh: string) => zh;
  assert.equal(toolSummary({ name: 'write', args: { path: 'src/main.ts' } }, t), 'src/main.ts');
  assert.equal(toolSummary({ name: 'powershell', args: { command: 'npm test' } }, t), 'npm test');
  assert.equal(toolSummary({ name: 'read', args: { path: 'README.md', offset: 20 } }, t), 'README.md');
  assert.equal(toolSummary({ name: 'web_search', args: { query: '西游记 火云洞' } }, t), '西游记 火云洞');
  // Anything else: the arguments, on one line, cut to fit.
  const summary = toolSummary({ name: 'odd_tool', args: { a: 1, b: 'x'.repeat(400) } }, t);
  assert.ok(summary.length <= 160, String(summary.length));
  assert.doesNotMatch(summary, new RegExp(NL));
  assert.equal(toolSummary({ name: 'no_args', args: {} }, t), '');
});
