import test from 'node:test';
import assert from 'node:assert/strict';
import { backtrackSamples, createRegexProber, dialectProblems, probeBacktracking } from '../src/core/card-studio/regex-probe.ts';

const BODY = String.raw`<content>([\s\S]*?)<\/content>`;
const UPDATE = String.raw`<(update(?:variable)?)>\s*((?:(?!<\1>).)*)\s*<\/\1>`;
/** The host thread busy for `ms`, the way a long synchronous read holds the Electron main process. */
const stall = (ms: number): void => { setImmediate(() => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }); };

test('a catastrophic pattern is caught by the timed probe; a normal one is not', async () => {
  const bad = await probeBacktracking('(a+)+$', '', ['a'.repeat(40) + 'b'], 200);
  assert.equal(bad.hang, true);
  const good = await probeBacktracking(BODY, 'is', backtrackSamples(BODY), 500);
  assert.equal(good.hang, false);
  const broken = await probeBacktracking('(', '', ['x'], 200);
  assert.equal(broken.hang, false, 'a pattern that does not compile is not a hang');
});

test('the prober times only the pattern: a host thread stalled past the budget is not a hang', async () => {
  const prober = createRegexProber();
  try {
    const cold = prober.probe(BODY, 'is', backtrackSamples(BODY));
    stall(400);
    assert.equal(await cold, 'ok', 'neither the worker start-up nor the stall counts');
    const warm = prober.probe(BODY, 'is', backtrackSamples(BODY));
    stall(400);
    assert.equal(await warm, 'ok', 'a deadline that fires late reads what the worker already sent');
  } finally {
    prober.close();
  }
});

test('an exponential pattern hangs twice and counts; lazy and quadratic ones finish on the worker that comes back', async () => {
  const prober = createRegexProber();
  try {
    assert.equal(await prober.probe('(a+)+$', '', backtrackSamples('(a+)+$')), 'hang');
    for (const [source, flags] of [[BODY, 'is'], [UPDATE, 'is'], [String.raw`^([\s\S]*)$`, ''], [String.raw`[\s\S]*<\/content>`, '']] as const) {
      assert.equal(await prober.probe(source, flags, backtrackSamples(source)), 'ok', source);
    }
    assert.equal(await prober.probe('(', '', ['x']), 'ok', 'a pattern that does not compile is not a hang');
  } finally {
    prober.close();
  }
});

test('closing the prober ends the probe in flight as inconclusive, and every later one', async () => {
  const prober = createRegexProber();
  const pending = prober.probe('(a+)+$', '', backtrackSamples('(a+)+$'));
  setTimeout(() => prober.close(), 50);
  assert.equal(await pending, 'inconclusive');
  assert.equal(await prober.probe(BODY, 'is', backtrackSamples(BODY)), 'inconclusive');
});

test('the samples grow from the literal prefix, past an anchor or an opening group, so a lazy body regex is exercised', () => {
  const samples = backtrackSamples(BODY);
  assert.ok(samples.every(sample => sample.length >= 4000));
  assert.ok(samples.some(sample => sample.startsWith('<content>')));
  for (const source of [String.raw`^<content>([\s\S]*?)<\/content>`, String.raw`(<content>[\s\S]*?<\/content>)`, String.raw`(?:<content>)([\s\S]*?)<\/content>`, String.raw`^(?<body><content>)([\s\S]*?)<\/content>`]) {
    assert.ok(backtrackSamples(source).some(sample => sample.startsWith('<content>aaa')), source);
  }
  assert.equal(backtrackSamples('(a+)+$').length, 5);
  assert.ok(backtrackSamples('(a+)+$').some(sample => sample.endsWith('a!')), 'one run breaks the match at its end');
});

test('the dialect scan reads tokens: escapes, whole classes, modifier groups and bounded lookbehinds are quiet', () => {
  const quiet = [
    String.raw`\*+([^*]+)\*+`, String.raw`\++`, String.raw`\?+`, String.raw`[*+\-/]`, String.raw`(?<=\d{3})x`, String.raw`(?<!\\)"`,
    String.raw`(?<=a{1,3})b`, String.raw`\\A`, String.raw`\(?>`, '[(?>]', BODY, UPDATE, '(?i:abc)', '(?<name>x)y',
  ];
  for (const source of quiet) assert.deepEqual(dialectProblems(source), [], source);
});

test('Java-dialect writings are pointed out with the JavaScript way', () => {
  for (const source of ['(?i)status', String.raw`\Astart`, '[[:alpha:]]+', '(?>abc)', 'a*+b', 'a{2}+b', '(?<=x+)y', String.raw`(?<=<(\w+)>.*)y`]) {
    assert.equal(dialectProblems(source).length, 1, source);
  }
  assert.match(dialectProblems('(?i)status')[0], /内联标志/);
  assert.match(dialectProblems(String.raw`\Astart`)[0], /Java/);
  assert.match(dialectProblems('[[:alpha:]]+')[0], /POSIX/);
  assert.match(dialectProblems('(?>abc)')[0], /原子组/);
  assert.match(dialectProblems('a*+b')[0], /占有量词/);
  assert.match(dialectProblems('a{2}+b')[0], /占有量词/);
  assert.match(dialectProblems('(?<=x+)y')[0], /后视.*不定长.*长度上限/);
  assert.match(dialectProblems(String.raw`(?<=<(\w+)>.*)y`)[0], /后视/);
  assert.equal(dialectProblems(String.raw`(?<=(a)\1)b`).length, 1, 'a backreference has no length bound either');
  assert.equal(dialectProblems('(?<name>x)y').length, 0, 'a named group is not a lookbehind');
  const both = dialectProblems(String.raw`(?i)\Astart`);
  assert.equal(both.length, 2);
  assert.match(both[0], /内联标志/, 'reported in rule order');
});
