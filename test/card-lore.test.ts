import test from 'node:test';
import assert from 'node:assert/strict';
import { bookEntryToParams, cardEntryToParams, defaultLoreParams, loreFileName, paramsToBookEntry, paramsToCardEntry, sectionOfParams } from '../src/shared/card-studio/lore.ts';

// A card entry in the shape SillyTavern writes into data.character_book.entries (verified against 1.19.0).
const cardEntry = (overrides: Record<string, unknown> = {}, extensions: Record<string, unknown> = {}) => ({
  id: 12, keys: ['爱蜜莉雅'], secondary_keys: [], comment: '爱蜜莉雅', content: '<爱蜜莉雅>\n姓名：爱蜜莉雅\n</爱蜜莉雅>',
  constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char', use_regex: true,
  extensions: {
    position: 0, exclude_recursion: true, display_index: 12, probability: 100, useProbability: true, depth: 4,
    selectiveLogic: 0, outlet_name: '', group: '', group_override: false, group_weight: 100, prevent_recursion: true,
    delay_until_recursion: false, scan_depth: null, match_whole_words: null, use_group_scoring: false, case_sensitive: null,
    automation_id: '', role: 0, vectorized: false, sticky: 0, cooldown: 0, delay: 0, match_persona_description: false,
    match_character_description: false, match_character_personality: false, match_character_depth_prompt: false,
    match_scenario: false, match_creator_notes: false, triggers: [], ignore_budget: false, ...extensions,
  },
  ...overrides,
});

test('new entries start from the parameters their section needs', () => {
  const person = defaultLoreParams({ uid: 7, section: 'lore-people', name: '爱蜜莉雅' });
  assert.equal(person.uid, 7);
  assert.equal(person.comment, '爱蜜莉雅');
  assert.deepEqual(person.key, []);
  assert.equal(person.constant, false);
  assert.equal(person.position, 0);
  assert.equal(person.order, 100);
  assert.equal(person.disable, false);
  assert.equal(person.excludeRecursion, true);
  assert.equal(person.preventRecursion, true);
  assert.equal(person.probability, 100);
  assert.equal(person.selectiveLogic, 0);
  assert.deepEqual(person.keysecondary, []);
  assert.equal(person.displayIndex, 7);

  const format = defaultLoreParams({ uid: 1, section: 'lore-format', name: '正文格式' });
  assert.equal(format.position, 4);
  assert.equal(format.depth, 0);
  assert.equal(format.order, 0);
  assert.equal(format.constant, true);

  const plot = defaultLoreParams({ uid: 2, section: 'lore-plot', name: '第01卷｜王都' });
  assert.equal(plot.position, 4);
  assert.equal(plot.depth, 4);
  assert.equal(plot.order, 300);
  assert.equal(plot.constant, false);

  const rules = defaultLoreParams({ uid: 3, section: 'lore-rules', name: '战斗规则', keys: ['战斗'] });
  assert.equal(rules.constant, true);
  assert.equal(rules.order, 1);
  assert.deepEqual(rules.key, ['战斗']);
});

test('a card entry becomes parameters and content, and goes back unchanged', () => {
  const entry = cardEntry();
  const { params, content } = cardEntryToParams(entry, 0);
  assert.equal(params.uid, 12);
  assert.deepEqual(params.key, ['爱蜜莉雅']);
  assert.equal(params.order, 100);
  assert.equal(params.position, 0);
  assert.equal(params.depth, 4);
  assert.equal(params.disable, false);
  assert.equal(params.excludeRecursion, true);
  assert.equal(content, entry.content);
  assert.equal(params.$card, undefined, 'nothing card-only to keep for a standard entry');
  assert.deepEqual(paramsToCardEntry(params, content), entry);
});

test('an @depth entry keeps the real position from extensions, not the position string', () => {
  const entry = cardEntry({ id: 300, insertion_order: 300, position: 'after_char' }, { position: 4, depth: 4, display_index: 300 });
  const { params } = cardEntryToParams(entry, 5);
  assert.equal(params.position, 4);
  assert.equal(params.depth, 4);
  assert.equal(sectionOfParams(params), 'lore-plot');
  assert.deepEqual(paramsToCardEntry(params, entry.content), entry);
});

test('card-only and unknown fields survive the round trip', () => {
  const entry = cardEntry({ name: '旧版字段', priority: 10, use_regex: false, case_sensitive: true }, { third_party: { note: 'keep me' } });
  const { params, content } = cardEntryToParams(entry, 0);
  assert.deepEqual(params.$card, { name: '旧版字段', priority: 10, use_regex: false, case_sensitive: true });
  assert.deepEqual((params.extensions as Record<string, unknown>).third_party, { note: 'keep me' });
  assert.deepEqual(paramsToCardEntry(params, content), entry);
});

test('null parameters stay null instead of being flattened to false', () => {
  const entry = cardEntry({}, { use_group_scoring: null, group_weight: null, probability: null });
  const { params, content } = cardEntryToParams(entry, 0);
  assert.equal(params.useGroupScoring, null);
  assert.equal(params.groupWeight, null);
  assert.deepEqual(paramsToCardEntry(params, content), entry);
});

test('an entry without an id falls back to its array index', () => {
  const { id: _id, ...rest } = cardEntry();
  const { params } = cardEntryToParams(rest, 3);
  assert.equal(params.uid, 3);
  assert.equal(params.displayIndex, 12, 'display_index from extensions wins over the index');
});

test('standalone world book entries keep every field they carry', () => {
  const entry = {
    key: ['露格尼卡'], keysecondary: [], comment: '露格尼卡王国', content: '<露格尼卡王国>\n王国。\n</露格尼卡王国>',
    constant: false, selective: true, selectiveLogic: 0, addMemo: true, order: 52, position: 0, disable: false,
    excludeRecursion: true, preventRecursion: true, probability: 100, useProbability: true, depth: 4, uid: 52,
    displayIndex: 52, extensions: { position: 0 }, characterFilter: { isExclude: false, names: [], tags: [] }, futureField: 'keep',
  };
  const { params, content } = bookEntryToParams(entry);
  assert.equal(content, entry.content);
  assert.equal(params.futureField, 'keep');
  assert.deepEqual(params.characterFilter, { isExclude: false, names: [], tags: [] });
  assert.deepEqual(paramsToBookEntry(params, content), entry);
});

test('card-only fields never leak into a standalone world book entry', () => {
  const { params, content } = cardEntryToParams(cardEntry({ use_regex: false }), 0);
  const book = paramsToBookEntry(params, content) as Record<string, unknown>;
  assert.equal(book.$card, undefined);
  assert.equal(book.uid, 12);
  assert.equal(book.content, content);
});

test('entries land in the section their parameters imply', () => {
  const at = (order: number, position = 0, comment = '', depth?: number) => sectionOfParams({ uid: 0, key: [], comment, constant: true, order, position, ...(depth === undefined ? {} : { depth }) });
  assert.equal(at(0, 4, '正文格式', 0), 'lore-format');
  assert.equal(at(1, 0, '战斗规则'), 'lore-rules');
  assert.equal(at(9, 0, '叙事基调'), 'lore-rules');
  assert.equal(at(10, 0, '人物总览'), 'lore-people');
  assert.equal(at(12, 0, '地点总览'), 'lore-overview');
  assert.equal(at(15, 0, '标题剧情索引'), 'lore-plot');
  assert.equal(at(20, 0, '世界观'), 'lore-setting');
  assert.equal(at(50, 0, '力量体系'), 'lore-setting');
  assert.equal(at(100, 0, '爱蜜莉雅'), 'lore-people');
  assert.equal(at(300, 4, '第01卷｜王都', 4), 'lore-plot');
  assert.equal(at(1002, 0, '[initvar] 初始'), 'lore-vars');
  assert.equal(at(9995, 0, '变量规则'), 'lore-vars');
  assert.equal(at(7000, 1, '不认识的条目'), 'lore-other');
});

test('file names read at a glance and never collide', () => {
  const taken = new Set<string>();
  const first = loreFileName({ uid: 12, key: [], comment: '爱蜜莉雅', constant: false, order: 100, position: 0 }, taken);
  assert.equal(first, '100-爱蜜莉雅');
  taken.add(first);
  const second = loreFileName({ uid: 13, key: [], comment: '爱蜜莉雅', constant: false, order: 100, position: 0 }, taken);
  assert.equal(second, '100-爱蜜莉雅~13');
  assert.equal(loreFileName({ uid: 1, key: [], comment: '人物/总览: 第一版?', constant: true, order: 10, position: 0 }, new Set()), '10-人物_总览_ 第一版_');
  assert.equal(loreFileName({ uid: 2, key: [], comment: '', constant: true, order: 9995, position: 0 }, new Set()), '9995-未命名');
  assert.equal(loreFileName({ uid: 3, key: [], comment: '一'.repeat(60), constant: true, order: 20, position: 0 }, new Set()).length, 3 + 40);
});
