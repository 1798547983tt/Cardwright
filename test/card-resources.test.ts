import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = fileURLToPath(new URL('../card-studio', import.meta.url));
const read = (relative: string) => readFileSync(join(resources, ...relative.split('/')), 'utf8');

test('every knowledge article marked as written exists, and every file there is listed', () => {
  const index = read('knowledge/README.md');
  const written = [...index.matchAll(/^\| ([^|]+\.md) \|[^|]+\| 已写 \|/gmu)].map(match => match[1].trim());
  assert.ok(written.length >= 7, `expected the written articles in the index, got ${written.join(', ')}`);
  for (const name of written) assert.ok(existsSync(join(resources, 'knowledge', name)), `knowledge/${name}`);
  for (const name of readdirSync(join(resources, 'knowledge')).filter(item => item.endsWith('.md') && item !== 'README.md')) {
    assert.ok(written.includes(name), `knowledge/${name} is not listed as written in the index`);
  }
});

test('every written knowledge article states its version and check date', () => {
  for (const name of readdirSync(join(resources, 'knowledge')).filter(item => /^\d\d-/.test(item))) {
    const text = read(`knowledge/${name}`);
    assert.match(text, /20\d\d-\d\d-\d\d/, `${name} has a check date`);
  }
});

test('the knowledge files the prompts point to exist', () => {
  // Knowledge citations always sit on a line that says 知识库; other numbered files (开场白/00-开场.md) do not count.
  const lines = readdirSync(join(resources, 'prompts')).flatMap(name => read(`prompts/${name}`).split('\n')).filter(line => line.includes('知识库'));
  const cited = new Set(lines.flatMap(line => [...line.matchAll(/`(\d\d-[^`/]+\.md)`/gu)].map(match => match[1])));
  assert.ok(cited.size > 0);
  for (const name of cited) assert.ok(existsSync(join(resources, 'knowledge', name)), `a prompt cites knowledge/${name}`);
});

test('the style presets and the anti-cliché list ship together', () => {
  for (const name of ['README.md', '战术档案.md', '鎏金典狱.md', '工业终端.md', '复古电影.md', '题材自定.md', '反八股清单.md']) {
    assert.ok(existsSync(join(resources, 'styles', name)), `styles/${name}`);
  }
  for (const id of ['tactical', 'gilded', 'terminal', 'cinema', 'custom']) assert.ok(read('styles/README.md').includes(`\`${id}\``), id);
  for (const name of ['战术档案.md', '鎏金典狱.md', '工业终端.md', '复古电影.md']) {
    const text = read(`styles/${name}`);
    assert.ok(text.includes('--accent:'), `${name} names its one accent colour`);
    assert.ok(text.includes('## 禁用'), `${name} lists what it forbids`);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(text), `${name} does not load Google Fonts`);
  }
});

test('the Re0 library lists every sample folder it ships', () => {
  const index = read('re0/README.md');
  for (const folder of readdirSync(join(resources, 're0', 'samples'))) {
    assert.ok(index.includes(`samples/${folder}/`), `re0/README.md lists samples/${folder}/`);
    assert.ok(readdirSync(join(resources, 're0', 'samples', folder)).some(name => name.endsWith('.md')), `samples/${folder} is not empty`);
  }
});
