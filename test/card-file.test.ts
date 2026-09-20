import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCard, emptyCardEnvelope, isCardJson, isLorebookJson, splitCard } from '../src/shared/card-studio/card-file.ts';

const RE0_CARD = 'E:/Cardwright/参考资料/完整的卡/json格式的卡/Re0：从零开始的异世界生活.json';
const RE0_BOOK = 'E:/Cardwright/参考资料/世界书部分/完整的世界书/Re0：从零开始的异世界生活世界书.json';
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
const exists = (path: string) => { try { readFileSync(path); return true; } catch { return false; } };

const entry = (id: number, extra: Record<string, unknown> = {}) => ({
  id, keys: [`关键词${id}`], secondary_keys: [], comment: `条目${id}`, content: `<条目${id}>\n正文\n</条目${id}>`,
  constant: false, selective: true, insertion_order: 100 + id, enabled: true, position: 'before_char', use_regex: true,
  extensions: {
    position: 0, exclude_recursion: true, prevent_recursion: true, display_index: id, probability: 100, useProbability: true,
    depth: 4, selectiveLogic: 0, outlet_name: '', group: '', group_override: false, group_weight: 100,
    delay_until_recursion: false, scan_depth: null, match_whole_words: null, use_group_scoring: false, case_sensitive: null,
    automation_id: '', role: 0, vectorized: false, sticky: 0, cooldown: 0, delay: 0, match_persona_description: false,
    match_character_description: false, match_character_personality: false, match_character_depth_prompt: false,
    match_scenario: false, match_creator_notes: false, triggers: [], ignore_budget: false,
  },
  ...extra,
});

const sampleCard = () => ({
  spec: 'chara_card_v3', spec_version: '3.0', name: '样卡', description: '', personality: '', scenario: '',
  first_mes: '开场一', mes_example: '', creator: '示例作者', creatorcomment: '备注', avatar: 'none', chat: 'x',
  fav: false, talkativeness: 0.5, tags: ['测试'], create_date: '2026-09-17T00:00:00.000Z', character_version: 'v1',
  data: {
    name: '样卡', description: '', personality: '', scenario: '', first_mes: '开场一', mes_example: '',
    creator: '示例作者', creator_notes: '备注', character_version: 'v1', system_prompt: '', post_history_instructions: '',
    tags: ['测试'], alternate_greetings: ['开场二', '开场三'], group_only_greetings: ['群聊开场'],
    character_book: { name: '样卡世界书', entries: [entry(0), entry(1)], extensions: { custom: 1 } },
    extensions: {
      world: '样卡世界书', depth_prompt: { depth: 4, prompt: '', role: 'system' }, fav: false, talkativeness: 0.5,
      regex_scripts: [{ id: 'r1', scriptName: '正文美化', findRegex: '/<content>/i', replaceString: '<div>渲染</div>', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: 0, maxDepth: null }],
      tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'MVU', id: 's1', content: 'import "x";', info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } }], variables: { keep: true } },
      thirdParty: { keep: 'me' },
    },
  },
});

test('a card splits into an envelope and components, and rebuilds unchanged', () => {
  const card = sampleCard();
  const parts = splitCard(card);
  assert.equal(parts.lore.length, 2);
  assert.equal(parts.lore[0].content, '<条目0>\n正文\n</条目0>');
  assert.equal(parts.lore[0].params.uid, 0);
  assert.equal(parts.book.name, '样卡世界书');
  assert.deepEqual(parts.book.extras, { extensions: { custom: 1 } });
  assert.equal(parts.regex.length, 1);
  assert.equal(parts.regex[0].body, '<div>渲染</div>');
  assert.equal(parts.regex[0].params.replaceString, undefined);
  assert.equal(parts.scripts.length, 1);
  assert.equal(parts.scripts[0].body, 'import "x";');
  assert.deepEqual(parts.greetings, { first: '开场一', alternates: ['开场二', '开场三'], groupOnly: ['群聊开场'] });
  assert.deepEqual(buildCard(parts), card);
});

test('a lean entry from another tool gains SillyTavern’s own fields without changing meaning', () => {
  const lean = { id: 4, keys: ['王都'], comment: '王都', content: '正文', insertion_order: 60, enabled: true, position: 'before_char', extensions: { position: 0, depth: 4 } };
  const parts = splitCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '样卡', character_book: { name: '书', entries: [lean] }, extensions: {} } });
  const rebuilt = buildCard(parts) as Record<string, Record<string, Record<string, Record<string, unknown>[]>>>;
  const entry = rebuilt.data.character_book.entries[0] as unknown as Record<string, unknown>;
  assert.equal(entry.id, 4);
  assert.equal(entry.insertion_order, 60);
  assert.equal(entry.use_regex, true);
  assert.equal((entry.extensions as Record<string, unknown>).prevent_recursion, false, 'missing switches take SillyTavern’s defaults');
  assert.equal((entry.extensions as Record<string, unknown>).position, 0);
  assert.equal((entry.extensions as Record<string, unknown>).depth, 4);
});

const deep = (value: unknown, path: string): Record<string, unknown> => path.split('.').reduce((node: Record<string, unknown>, key) => (node?.[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>);

test('the envelope keeps unknown fields and the parts that are not components', () => {
  const parts = splitCard(sampleCard());
  assert.equal(deep(parts.envelope, 'data.extensions.thirdParty').keep, 'me');
  assert.deepEqual(deep(parts.envelope, 'data.extensions.tavern_helper').variables, { keep: true });
  assert.deepEqual(deep(parts.envelope, 'data.extensions.tavern_helper').scripts, [], 'scripts move into components');
  assert.deepEqual(deep(parts.envelope, 'data.character_book').entries, []);
  assert.equal((parts.envelope as Record<string, unknown>).chat, 'x');
});

test('a V2 card imports and comes back as V3 with its top-level mirrors', () => {
  const v2 = { spec: 'chara_card_v2', spec_version: '2.0', name: '旧卡', first_mes: '你好', data: { name: '旧卡', description: '描述', first_mes: '你好', alternate_greetings: [], extensions: {} } };
  const parts = splitCard(v2);
  assert.equal(parts.greetings.first, '你好');
  const rebuilt = buildCard(parts) as Record<string, unknown>;
  assert.equal(rebuilt.spec, 'chara_card_v3');
  assert.equal(rebuilt.spec_version, '3.0');
  assert.equal(rebuilt.first_mes, '你好');
  assert.equal((rebuilt.data as Record<string, unknown>).description, '描述');
});

test('a V1 card without a data block still splits', () => {
  const v1 = { name: '最早的卡', description: '描述', personality: '', scenario: '', first_mes: '开场', mes_example: '' };
  const parts = splitCard(v1);
  assert.equal(parts.greetings.first, '开场');
  const rebuilt = buildCard(parts) as Record<string, Record<string, unknown>>;
  assert.equal(rebuilt.spec, 'chara_card_v3');
  assert.equal(rebuilt.data.description, '描述');
  assert.equal(rebuilt.data.first_mes, '开场');
});

test('a new card starts from an empty V3 envelope', () => {
  const parts = splitCard(emptyCardEnvelope('西游·八十一难', new Date('2026-09-17T00:00:00.000Z')));
  const card = buildCard({ ...parts, greetings: { first: '开场白', alternates: [], groupOnly: [] } }) as Record<string, Record<string, unknown>>;
  assert.equal(card.spec, 'chara_card_v3');
  assert.equal(card.data.name, '西游·八十一难');
  assert.equal(card.data.first_mes, '开场白');
  assert.equal(card.first_mes as unknown as string, '开场白');
  assert.deepEqual((card.data.extensions as Record<string, unknown>).tavern_helper, { scripts: [], variables: {} });
  assert.equal((card.data.extensions as Record<string, unknown>).world, '西游·八十一难');
});

test('card and world book files are told apart', () => {
  assert.equal(isCardJson(sampleCard()), true);
  assert.equal(isCardJson({ entries: {} }), false);
  assert.equal(isLorebookJson({ entries: { 0: { uid: 0, content: '' } } }), true);
  assert.equal(isLorebookJson(sampleCard()), false);
  assert.equal(isCardJson({ name: '最早的卡', first_mes: '开场', description: '' }), true);
});

test('the Re0 card survives a full split and rebuild', { skip: exists(RE0_CARD) ? false : 'reference card not available' }, () => {
  const card = readJson(RE0_CARD);
  const parts = splitCard(card);
  assert.equal(parts.lore.length, 290);
  assert.equal(parts.regex.length, 8);
  assert.equal(parts.scripts.length, 5);
  const rebuilt = buildCard(parts) as Record<string, unknown>;
  assert.deepEqual(rebuilt, card, 'the rebuilt card is identical to the imported one');
  const book = (rebuilt.data as Record<string, Record<string, unknown[]>>).character_book;
  assert.deepEqual(book.entries.map(item => (item as Record<string, unknown>).id), (card.data as Record<string, Record<string, unknown[]>>).character_book.entries.map(item => (item as Record<string, unknown>).id), 'entry order is kept');
});

test('the Re0 standalone world book keeps its entries', { skip: exists(RE0_BOOK) ? false : 'reference book not available' }, async () => {
  const { bookEntryToParams, paramsToBookEntry } = await import('../src/shared/card-studio/lore.ts');
  const book = readJson(RE0_BOOK) as { entries: Record<string, Record<string, unknown>> };
  const uids = Object.keys(book.entries);
  assert.equal(uids.length, 290);
  for (const uid of uids) {
    const original = book.entries[uid];
    const { params, content } = bookEntryToParams(original);
    assert.deepEqual(paramsToBookEntry(params, content), original, `entry ${uid} round trips`);
  }
});
