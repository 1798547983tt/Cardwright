import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardFolder } from '../src/core/card-studio/card-project.ts';
import { importCard, readProject } from '../src/core/card-studio/components.ts';
import { ARTIFACT_MANIFEST_FILE, DERIVED_TABLE_FILE, VARIABLE_TABLE_FILE, hashText, readArtifactManifest, readVariableTableState, syncVariableArtifacts, writeDerivedTable } from '../src/core/card-studio/variable-artifacts.ts';
import { PATH_LIST_START } from '../src/shared/card-studio/variable-generate.ts';
import { SAMPLE_TABLE } from './variable-table-sample.ts';

async function project(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'cardwright-artifacts-')), '卡项目');
  await createCardFolder({ folder: root, name: '样卡', kind: 'original', random: () => 0 });
  return root;
}
const clean = (root: string) => rm(join(root, '..'), { recursive: true, force: true });
const read = (root: string, relative: string) => readFile(join(root, ...relative.split('/')), 'utf8');

test('syncing writes every artifact once and nothing the second time', async () => {
  const root = await project();
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  const first = (await syncVariableArtifacts(root, { cardName: '样卡' }))!;
  assert.equal(first.rows, 13);
  assert.deepEqual(first.created.sort(), ['世界书/变量/1002-[initvar].md', '世界书/变量/9994-变量列表.md', '世界书/变量/9995-变量规则.md', '世界书/变量/9996-变量输出格式.md', '正则/01-只发送最新3楼的变量更新.html', '脚本/01-MVU.js', '脚本/02-ZOD.js']);
  assert.deepEqual(first.written.sort(), ['世界书/变量/1002-[initvar].md', '世界书/变量/9994-变量列表.md', '世界书/变量/9995-变量规则.md', '世界书/变量/9996-变量输出格式.md', '脚本/01-MVU.js', '脚本/02-ZOD.js']);
  const components = await readProject(root);
  const initvar = components.lore.find(entry => entry.params.comment === '[initvar]')!;
  assert.equal(initvar.params.order, 1002);
  assert.equal(initvar.params.disable, true, 'MVU only reads a disabled [initvar]');
  assert.equal(initvar.params.constant, true);
  assert.match(initvar.content, /^主角:\n {2}姓名: ""/);
  assert.match(components.scripts.find(script => script.name === '01-MVU')!.body, /MVU-offline@v1\.0\.1/);
  assert.deepEqual((components.scripts.find(script => script.name === '01-MVU')!.params.button as { buttons: Array<{ visible: boolean }> }).buttons.map(button => button.visible), [true, false, false, false, true, false]);
  assert.match(components.scripts.find(script => script.name === '02-ZOD')!.body, /registerMvuSchema\(Schema\)/);
  const cleanup = components.regex.find(item => item.params.scriptName === '只发送最新3楼的变量更新')!;
  assert.equal(cleanup.params.promptOnly, true);
  assert.equal(cleanup.params.minDepth, 6);
  assert.equal(cleanup.params.markdownOnly, false);
  assert.equal(cleanup.body, '');
  assert.match(components.lore.find(entry => entry.params.comment === '变量规则')!.content, new RegExp(`本条目由「世界书·变量」分区撰写[\\s\\S]*${PATH_LIST_START}`));
  const manifest = (await readArtifactManifest(root))!;
  assert.equal(manifest.table, hashText(SAMPLE_TABLE));
  assert.equal(Object.keys(manifest.files).length, 6);
  assert.equal(manifest.files['世界书/变量/9995-变量规则.md'].part, 'block');

  const second = (await syncVariableArtifacts(root, { cardName: '样卡' }))!;
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.written, []);
  assert.equal(second.unchanged.length, 6);
  await clean(root);
});

test('the narrative above the path list survives a regeneration; a changed table rewrites the block', async () => {
  const root = await project();
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  await syncVariableArtifacts(root, { cardName: '样卡' });
  const rules = '世界书/变量/9995-变量规则.md';
  const body = await read(root, rules);
  await writeFile(join(root, ...rules.split('/')), body.replace(/^[\s\S]*?\n\n/, '总则：只按事实更新。\n\n'));
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE.replace('上限: 12', '上限: 3'));
  const result = (await syncVariableArtifacts(root, { cardName: '样卡' }))!;
  assert.ok(result.written.includes(rules));
  const again = await read(root, rules);
  assert.match(again, /^总则：只按事实更新。\n\n/);
  assert.match(again, /最多 3 条/);
  assert.doesNotMatch(again, /最多 12 条/);
  await clean(root);
});

test('a card without a table gets a derived one, and the authored one wins', async () => {
  const root = await project();
  await importCard(root, {
    spec: 'chara_card_v3', spec_version: '3.0', name: '样卡',
    data: { name: '样卡', first_mes: '开场', character_book: { name: '书', entries: [{ id: 1, keys: [], comment: '[initvar]', content: '主角:\n  生命: 90', constant: true, enabled: false, insertion_order: 1002, position: 'before_char', extensions: { position: 0, depth: 4 } }] }, extensions: { world: '书' } },
  });
  assert.equal(await writeDerivedTable(root), true);
  const derived = await readVariableTableState(root);
  assert.equal(derived.source, 'derived');
  assert.equal(derived.source === 'derived' && derived.table.rows.find(row => row.path === '/主角/生命')?.default, 90);
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  assert.equal(await writeDerivedTable(root), false, 'nothing is derived beside an authored table');
  const authored = await readVariableTableState(root);
  assert.equal(authored.source, 'authored');
  assert.equal(authored.source === 'authored' && authored.table.rows.length, 13);
  assert.ok((await readFile(join(root, DERIVED_TABLE_FILE), 'utf8')).includes('推导'));
  await writeFile(join(root, VARIABLE_TABLE_FILE), '版本: 2');
  await assert.rejects(() => readVariableTableState(root), /「版本」必须是 1/);
  assert.equal(await syncVariableArtifacts(join(root, '..'), { cardName: 'x' }), null, 'no table, nothing to sync');
  assert.equal(await readArtifactManifest(root), null);
  assert.equal(ARTIFACT_MANIFEST_FILE, '变量表.生成.json');
  await clean(root);
});

test('an imported card keeps its own entries: the [initvar] is disabled in place, look-alike names are left alone, the MVU buttons are put right', async () => {
  const root = await project();
  await importCard(root, {
    spec: 'chara_card_v3', spec_version: '3.0', name: '样卡',
    data: { name: '样卡', first_mes: '开场', character_book: { name: '书', entries: [
      { id: 1, keys: [], comment: '[initvar]变量初始化', content: '主角:\n  生命: 90', constant: true, enabled: true, insertion_order: 100, position: 'before_char', extensions: { position: 0, depth: 4 } },
      { id: 2, keys: [], comment: '[mvu_update]变量更新规则', content: '总则：只按事实更新。', constant: true, enabled: true, insertion_order: 9995, position: 'before_char', extensions: { position: 0, depth: 4 } },
      { id: 3, keys: [], comment: '变量输出格式说明', content: '这是一段说明，不是格式本身。', constant: true, enabled: true, insertion_order: 9997, position: 'before_char', extensions: { position: 0, depth: 4 } },
    ] }, extensions: { world: '书', tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: "import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js'", info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: {} } } },
  });
  await writeFile(join(root, VARIABLE_TABLE_FILE), SAMPLE_TABLE);
  const result = (await syncVariableArtifacts(root, { cardName: '样卡' }))!;
  const components = await readProject(root);
  const initvars = components.lore.filter(entry => /initvar/i.test(String(entry.params.comment)));
  assert.equal(initvars.length, 1, 'no second [initvar]');
  assert.equal(initvars[0].params.disable, true, 'an imported [initvar] is disabled in place');
  assert.equal(initvars[0].params.order, 100, 'its order is left alone');
  const rules = components.lore.find(entry => entry.params.comment === '[mvu_update]变量更新规则')!;
  assert.match(rules.content, /^总则：只按事实更新。\n\n/);
  assert.ok(rules.content.includes(PATH_LIST_START));
  assert.equal(components.lore.find(entry => entry.params.comment === '变量输出格式说明')!.content, '这是一段说明，不是格式本身。', 'a look-alike name is not claimed');
  assert.ok(result.created.includes('世界书/变量/9996-变量输出格式.md'), 'the real entry is created beside it');
  const mvu = components.scripts.filter(script => /MVU/i.test(String(script.params.name)));
  assert.equal(mvu.length, 1);
  assert.deepEqual((mvu[0].params.button as { buttons: Array<{ visible: boolean }> }).buttons.map(button => button.visible), [true, false, false, false, true, false]);
  assert.ok(result.written.includes(mvu[0].paramsPath), 'the corrected parameters count as written');
  await clean(root);
});
