import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownBlocks } from '../src/renderer/conversation/blocks.ts';
import { groupToolRuns, toolGroupLabel, type RunRole } from '../src/renderer/conversation/tool-groups.ts';

const NL = String.fromCharCode(10);
const lines = (...items: string[]) => items.join(NL);

test('a reply splits into top-level blocks: fences and tables stay whole, an unclosed fence is the streaming tail', () => {
  const fence = lines('```js', 'const a = 1;', '', 'const b = 2;', '```');
  const table = lines('| 名字 | 值 |', '|---|---|', '| a | 1 |');
  const list = lines('1. 第一步', '', '   接着说明', '', '2. 第二步');
  assert.deepEqual(splitMarkdownBlocks(lines('# 标题', '', '开场白', '', fence, '', table, '', list, '', '结尾')).map(block => block.text),
    ['# 标题', '开场白', fence, table, list, '结尾']);
  // Still being written: the fence has not closed, so the rest of the reply is one code block.
  assert.deepEqual(splitMarkdownBlocks(lines('看这里：', '', '```ts', 'let x = 1;', '', 'let y')),
    [{ text: '看这里：' }, { text: lines('```ts', 'let x = 1;', '', 'let y'), open: true }]);
  // A reference definition resolves across the reply, so such a reply stays whole.
  assert.equal(splitMarkdownBlocks(lines('见 [文档][d]。', '', '[d]: https://example.com')).length, 1);
});

test('consecutive calls of one tool fold into a group; thinking between them rides along, text ends the group', () => {
  type Entry = { id: string; tool?: string; text?: boolean };
  const role = (entry: Entry): RunRole => entry.tool ? { tool: entry.tool } : entry.text ? 'visible' : 'quiet';
  const entries: Entry[] = [{ id: '1', tool: 'read' }, { id: '2' }, { id: '3', tool: 'read' }, { id: '4', tool: 'read' }, { id: '5', tool: 'write' }, { id: '6', text: true }, { id: '7', tool: 'read' }, { id: '8', tool: 'read' }, { id: '9' }];
  const runs = groupToolRuns(entries, role).map(run => run.kind === 'group' ? `${run.name}:${run.items.map(item => item.id).join('')}/${run.calls.length}` : run.item.id);
  assert.deepEqual(runs, ['read:1234/3', '5', '6', 'read:78/2', '9']);
  assert.equal(toolGroupLabel('read', 3, (_en, zh) => zh), '读取 3 个文件');
});
