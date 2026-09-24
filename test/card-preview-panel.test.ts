// test/card-preview-panel.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SIM_MESSAGE } from '../src/shared/card-studio/tavern-sim.ts';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../src/renderer/card-studio/${relative}`, import.meta.url)), 'utf8');

test('the preview panel knows the four kinds, three widths, the sample variables and the writes', () => {
  const panel = read('PreviewPanel.tsx');
  for (const kind of ["'body'", "'update'", "'status'", "'start'"]) assert.ok(panel.includes(kind), kind);
  assert.ok(panel.includes(`${SIM_MESSAGE}: 1`) || panel.includes(`[SIM_MESSAGE]: 1`), 'the panel posts the sim message into the frame');
  assert.match(panel, /postMessage\(/);
  for (const width of ['phone', 'tablet', 'desktop']) assert.ok(panel.includes(`'${width}'`), width);
  assert.match(panel, /cs-preview-writes/);
  assert.match(panel, /模拟一次更新/);
  const section = read('SectionPage.tsx');
  assert.match(section, /'regex-status' \? 'status'/);
  assert.match(section, /'regex-start' \? 'start'/);
  const assembly = read('AssemblyPanel.tsx');
  assert.match(assembly, /kind="status"/); assert.match(assembly, /kind="start"/);
  const css = read('card-studio-section.css');
  for (const rule of ['.cs-preview-frames.is-phone', '.cs-preview-frames.is-tablet', '.cs-preview-vars', '.cs-preview-writes', '.cs-preview-widths']) assert.ok(css.includes(rule), rule);
});
