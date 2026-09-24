import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importCard, readProject } from '../src/core/card-studio/components.ts';
import { buildCardFromProject } from '../src/core/card-studio/assembly.ts';
import { bookName, diffFingerprints, exportReport, fingerprintProject, piecesFolderName, readCardMeta, writeCardMeta } from '../src/core/card-studio/export-report.ts';

async function project(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-report-')), '卡项目');
  await createCardFolder({ folder: root, name: '雾港档案', kind: 'original', random: () => 0 });
  await importCard(root, {
    spec: 'chara_card_v3', spec_version: '3.0', name: '雾港档案',
    data: {
      name: '雾港档案', first_mes: '雾。', creator: '示例作者', creator_notes: '旧备注', character_version: 'v1', tags: ['测试'],
      character_book: { name: '雾港档案世界书', entries: [
        { id: 3, keys: ['林砚'], secondary_keys: [], comment: '林砚', content: '<林砚>\n警探。\n</林砚>', constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char', use_regex: true, extensions: { position: 0, depth: 4 } },
      ] },
      extensions: {
        world: '雾港档案世界书',
        regex_scripts: [{ id: 'r1', scriptName: '正文美化', findRegex: '/<content>/', replaceString: '<div>$1</div>', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null }],
        tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: 'import "mvu";', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: {} },
      },
    },
  });
  return root;
}

test('card metadata lives in the envelope and reaches the export without touching the components', async () => {
  const root = await project();
  assert.deepEqual(await readCardMeta(root), { name: '雾港档案', creator: '示例作者', version: 'v1', notes: '旧备注', tags: ['测试'] });
  const lore = await readFile(join(root, '世界书/人设/100-林砚.md'), 'utf8');
  await writeCardMeta(root, { name: '雾港档案·终版', creator: '示例作者', version: 'v2', notes: '新备注', tags: ['测试', '悬疑', ' ', '悬疑'] });
  assert.deepEqual(await readCardMeta(root), { name: '雾港档案·终版', creator: '示例作者', version: 'v2', notes: '新备注', tags: ['测试', '悬疑'] }, 'blank and repeated tags are dropped');
  const card = buildCardFromProject(await readProject(root), { frontend: null, table: null, cardName: '样卡' }) as { name: string; data: Record<string, unknown> };
  assert.equal(card.data.name, '雾港档案·终版');
  assert.equal(card.data.character_version, 'v2');
  assert.equal(card.data.creator_notes, '新备注');
  assert.equal(card.name, '雾港档案·终版', 'the top-level mirror follows');
  assert.equal(await readFile(join(root, '世界书/人设/100-林砚.md'), 'utf8'), lore, 'the components are untouched');
  await assert.rejects(() => writeCardMeta(root, { name: ' ', creator: '', version: '', notes: '', tags: [] }), /卡名/);
});

test('every piece has a fingerprint, and only what changed is reported', async () => {
  const root = await project();
  const first = fingerprintProject(await readProject(root));
  assert.deepEqual(first.map(item => `${item.kind}:${item.name}`).sort(), ['greeting:开场白', 'lore:林砚', 'meta:卡片信息', 'regex:正文美化', 'script:MVU'].sort());
  assert.deepEqual(fingerprintProject(await readProject(root)), first, 'the same files give the same fingerprints');
  assert.equal(diffFingerprints(null, first), null, 'the first export has nothing to compare with');

  await writeFile(join(root, '世界书/人设/100-林砚.md'), '<林砚>\n警探，常年穿旧风衣。\n</林砚>');
  await writeFile(join(root, '正则/01-正文美化.html'), '<div class="mist">$1</div>');
  const second = fingerprintProject(await readProject(root));
  const diff = diffFingerprints(first, second)!;
  assert.deepEqual(diff.changed.map(item => item.name).sort(), ['林砚', '正文美化']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);

  const removed = diffFingerprints(second, second.filter(item => item.kind !== 'script'))!;
  assert.deepEqual(removed.removed.map(item => item.name), ['MVU']);
  assert.deepEqual(diffFingerprints(second.filter(item => item.kind !== 'script'), second)!.added.map(item => item.name), ['MVU']);
});

test('the report names the file, what changed and the verified way to replace it', () => {
  const lore = { kind: 'lore' as const, key: '3', name: '林砚', hash: 'b' };
  const regex = { kind: 'regex' as const, key: 'r1', name: '正文美化', hash: 'b' };
  const text = exportReport({ cardName: '雾港档案', file: '导出/雾港档案-v2-20260918.png', bookName: '雾港档案世界书', diff: { added: [], changed: [lore, regex], removed: [] }, piecesFolder: '导出/单件-v2-20260918' });
  for (const expected of ['雾港档案-v2-20260918.png', '林砚', '正文美化', '替换/更新', '不要再次导入', '导入卡内世界书']) assert.ok(text.includes(expected), expected);
  const first = exportReport({ cardName: '雾港档案', file: '导出/雾港档案-v1-20260918.json', bookName: '雾港档案世界书', diff: null, piecesFolder: null });
  for (const expected of ['第一次导入', '内置正则', 'embedded World/Lorebook', '嵌入式脚本']) assert.ok(first.includes(expected), expected);
  const unchanged = exportReport({ cardName: '雾港档案', file: '导出/x.json', bookName: '雾港档案世界书', diff: { added: [], changed: [], removed: [] }, piecesFolder: null });
  assert.ok(unchanged.includes('和上次导出相比没有改动'));
});

test('single pieces go into a folder that carries the version and the date', () => {
  assert.equal(piecesFolderName('v2', '20260918'), '单件-v2-20260918');
  assert.equal(piecesFolderName('', '20260918'), '单件-20260918');
});

test('the world book piece is named the way SillyTavern names the book it binds', async () => {
  const root = await project();
  const components = await readProject(root);
  assert.equal(bookName(components), '雾港档案世界书');
  assert.equal(bookName({ ...components, book: { ...components.book, name: ' ' } }), "雾港档案's Lorebook", 'an unnamed book is imported as <character>\'s Lorebook (SillyTavern 1.19.0, world-info.js)');
});
