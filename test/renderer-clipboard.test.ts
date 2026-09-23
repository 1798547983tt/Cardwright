import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../src/renderer', import.meta.url));
const sources = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? sources(join(folder, entry.name))
  : /\.(tsx?|mjs)$/.test(entry.name) ? [join(folder, entry.name)] : []);

// The main window refuses every permission request, so navigator.clipboard.writeText rejects with NotAllowedError in the
// packaged app (0.9.1, verification record). 复制消息, 复制回复 and the dispatch card's 复制 silently did nothing.
test('the renderer copies through the bridge, never through navigator.clipboard', () => {
  for (const file of sources(renderer)) assert.doesNotMatch(readFileSync(file, 'utf8'), /navigator\s*\.\s*clipboard/, `${file} writes the clipboard from the page`);
});

test('the three copy buttons hand their text to the bridge', () => {
  const conversation = readFileSync(join(renderer, 'Conversation.tsx'), 'utf8');
  assert.match(conversation, /api\.copyText\(turn\.user!?\.text\)/, '复制消息');
  assert.match(conversation, /api\.copyText\(visibleFinal\.item\.text\)/, '复制回复');
  assert.match(readFileSync(join(renderer, 'card-studio', 'SectionThread.tsx'), 'utf8'), /api\.copyText\(formatDispatch\(dispatch\)\)/, 'the dispatch card');
});
