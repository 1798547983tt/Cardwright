import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFERENCES_TOTAL_LINE_LIMIT, REFERENCE_LINE_LIMIT, buildSectionBrief, resolveDispatchReferences } from '../src/core/card-studio/section-brief.ts';
import { formatDispatch, parseDispatchContent } from '../src/shared/card-studio/dispatch.ts';

async function card(t: test.TestContext): Promise<{ root: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-section-brief-'));
  await mkdir(join(root, '资料'), { recursive: true });
  await writeFile(join(root, '设计书.md'), [
    '# 设计书 · 雾港',
    '## 1 作品与范围',
    '一句话。',
    '## 3 主角与配角',
    '- 甲',
    '- 乙',
    '## 4 剧情',
    '- 第一章',
    '- 第二章',
  ].join('\n'));
  await writeFile(join(root, '变量表.yaml'), ['version: 1', 'rows:', '  - path: /主角/生命', '    type: 数值', '  - path: /主角/好感', '    type: 数值'].join('\n'));
  await writeFile(join(root, '资料', '索引.md'), ['# 资料索引', '1. 第一章'].join('\n'));
  return { root, close: async () => { assert.match(root, /cardwright-section-brief-/); await rm(root, { recursive: true, force: true }); } };
}

test('a heading resolves to the lines until the next heading of the same level', async t => {
  const f = await card(t); t.after(f.close);
  const references = await resolveDispatchReferences(f.root, [{ path: '设计书.md', heading: '主角与配角', summary: '人物名单' }]);
  assert.equal(references.length, 1);
  assert.equal(references[0].offset, 4);
  assert.equal(references[0].lines, 3);
  assert.equal(references[0].heading, '主角与配角');
  assert.equal(references[0].summary, '人物名单');
});

test('an explicit offset is clamped, lines are capped and duplicates are dropped', async t => {
  const f = await card(t); t.after(f.close);
  const [first] = await resolveDispatchReferences(f.root, [{ path: '设计书.md', offset: 99, lines: 999 }]);
  assert.equal(first.offset, 9);
  assert.equal(first.lines, 1);
  const capped = await resolveDispatchReferences(f.root, [{ path: '设计书.md', offset: 2, lines: 999 }]);
  assert.equal(capped[0].lines, 8);
  assert.ok(capped[0].lines <= REFERENCE_LINE_LIMIT);
  const duplicate = await resolveDispatchReferences(f.root, [{ path: '设计书.md', offset: 2, lines: 3 }, { path: '设计书.md', offset: 2, lines: 3 }]);
  assert.equal(duplicate.length, 1);
});

test('the total line budget drops references that would exceed it', async t => {
  const f = await card(t); t.after(f.close);
  await writeFile(join(f.root, '长.md'), Array.from({ length: 1000 }, (_, index) => `第 ${index + 1} 行`).join('\n'));
  const references = await resolveDispatchReferences(f.root, Array.from({ length: 8 }, (_, index) => ({ path: '长.md', offset: index * 200 + 1, lines: 200 })));
  assert.equal(references.length, Math.floor(REFERENCES_TOTAL_LINE_LIMIT / 200));
});

test('paths outside the card and missing files are refused', async t => {
  const f = await card(t); t.after(f.close);
  for (const path of ['../secret.txt', 'C:/secret.txt', '/secret.txt', '资料/../../secret.txt']) {
    assert.deepEqual(await resolveDispatchReferences(f.root, [{ path }]), [], path);
  }
  assert.deepEqual(await resolveDispatchReferences(f.root, [{ path: '不存在.md', heading: '人物' }]), []);
});

test('a dispatch brief shows its own summary and resolved reference lines', async t => {
  const f = await card(t); t.after(f.close);
  const references = await resolveDispatchReferences(f.root, [{ path: '设计书.md', heading: '主角与配角', summary: '人物名单' }]);
  const brief = await buildSectionBrief(f.root, { title: '写人设', brief: '先写主角和两个配角', references }, 'lore-people');
  assert.ok(brief);
  assert.match(brief, /本次派单摘要/);
  assert.match(brief, /派单：写人设/);
  assert.match(brief, /规划要点：先写主角和两个配角/);
  assert.match(brief, /`设计书\.md` 第 4–6 行：人物名单/);
  assert.match(brief, /不要整本通读/);
});

test('without planning references the brief is derived from the design book, variables and index', async t => {
  const f = await card(t); t.after(f.close);
  const brief = await buildSectionBrief(f.root, { title: '写人设' }, 'lore-people');
  assert.ok(brief);
  assert.match(brief, /`设计书\.md` 第 4–6 行/);
  assert.match(brief, /`变量表\.yaml` 第 1–6 行：变量表，共 2 个变量/);
  assert.match(brief, /`资料\/索引\.md` 第 1–2 行：资料索引/);
});

test('no dispatch or no material means no brief at all', async t => {
  const f = await card(t); t.after(f.close);
  assert.equal(await buildSectionBrief(f.root, undefined, 'lore-people'), null);
  const empty = await mkdtemp(join(tmpdir(), 'cardwright-section-brief-'));
  t.after(async () => { await rm(empty, { recursive: true, force: true }); });
  assert.equal(await buildSectionBrief(empty, { title: '写人设' }, 'lore-people'), null);
});

test('a formatted dispatch carries the brief and stays readable back', async t => {
  const f = await card(t); t.after(f.close);
  const references = await resolveDispatchReferences(f.root, [{ path: '设计书.md', heading: '主角与配角', summary: '人物名单' }]);
  const text = formatDispatch({ target: '世界书/人设', title: '写人设', requires: '设计书', body: '写主角。', brief: '先写主角', references });
  assert.match(text, /摘要: 先写主角/);
  assert.match(text, /参考（先读这些行，不要整本读）:/);
  assert.match(text, /`设计书\.md` 第 4–6 行：人物名单/);
  const parsed = parseDispatchContent(text.replace(/^`+派单\n/, '').replace(/\n`+$/, ''));
  assert.ok(parsed && !('error' in parsed));
  assert.equal(parsed.brief, '先写主角');
});
