/**
 * World book entries as component files: parameters in the field names SillyTavern uses for a standalone
 * world book export, body kept as plain text. Verified against SillyTavern 1.19.0
 * (`public/scripts/world-info.js` convertCharacterBook, `src/endpoints/characters.js` convertWorldInfoToCharacterBook).
 */

export interface LoreParams {
  uid: number; key: string[]; comment: string; order: number; position: number; constant: boolean;
  /** Card-only fields a standalone entry cannot express; never written into a world book export. */
  $card?: Record<string, unknown>;
  [field: string]: unknown;
}
export interface LoreSplit { params: LoreParams; content: string }

/** Top-level fields of a card `character_book` entry that the parameters already carry. */
const CARD_FIELDS = ['id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective', 'insertion_order', 'enabled', 'position', 'use_regex', 'extensions'];
const SECTION_DEFAULTS: Record<string, { constant: boolean; position: number; depth: number; order: number }> = {
  'lore-format': { constant: true, position: 4, depth: 0, order: 0 },
  'lore-rules': { constant: true, position: 0, depth: 4, order: 1 },
  'lore-overview': { constant: true, position: 0, depth: 4, order: 10 },
  'lore-setting': { constant: false, position: 0, depth: 4, order: 51 },
  'lore-people': { constant: false, position: 0, depth: 4, order: 100 },
  'lore-plot': { constant: false, position: 4, depth: 4, order: 300 },
  'lore-vars': { constant: true, position: 0, depth: 4, order: 9995 },
};
const FALLBACK_DEFAULTS = { constant: false, position: 0, depth: 4, order: 100 };

/** Parameters every entry of this workshop carries (handoff §6 「统一参数」) plus SillyTavern's own defaults. */
export function defaultLoreParams(input: { uid: number; section: string; name: string; keys?: string[]; order?: number }): LoreParams {
  // The body lives in its own file and is never stored in the parameters.
  const base = SECTION_DEFAULTS[input.section] ?? FALLBACK_DEFAULTS;
  return {
    uid: input.uid, key: input.keys ? [...input.keys] : [], keysecondary: [], comment: input.name,
    constant: base.constant, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
    order: input.order ?? base.order, position: base.position, disable: false, ignoreBudget: false,
    excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    probability: 100, useProbability: true, depth: base.depth, outletName: '', group: '', groupOverride: false,
    groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [], displayIndex: input.uid,
    extensions: {},
  } as unknown as LoreParams;
}

const pick = (source: Record<string, unknown>, field: string, fallback: unknown) => Object.hasOwn(source, field) ? source[field] : fallback;

/** One entry of a card's `character_book`, split into parameters and body. */
export function cardEntryToParams(entry: Record<string, unknown>, index: number): LoreSplit {
  const extensions = (entry.extensions ?? {}) as Record<string, unknown>;
  const position = pick(extensions, 'position', entry.position === 'before_char' ? 0 : 1);
  const params: Record<string, unknown> = {
    uid: typeof entry.id === 'number' ? entry.id : index,
    key: (entry.keys as string[]) ?? [], keysecondary: (entry.secondary_keys as string[]) ?? [],
    comment: (entry.comment as string) ?? '', constant: entry.constant ?? false,
    vectorized: pick(extensions, 'vectorized', false), selective: entry.selective ?? false,
    selectiveLogic: pick(extensions, 'selectiveLogic', 0), addMemo: Boolean(entry.comment),
    order: entry.insertion_order, position, disable: !entry.enabled,
    ignoreBudget: pick(extensions, 'ignore_budget', false),
    excludeRecursion: pick(extensions, 'exclude_recursion', false),
    preventRecursion: pick(extensions, 'prevent_recursion', false),
    matchPersonaDescription: pick(extensions, 'match_persona_description', false),
    matchCharacterDescription: pick(extensions, 'match_character_description', false),
    matchCharacterPersonality: pick(extensions, 'match_character_personality', false),
    matchCharacterDepthPrompt: pick(extensions, 'match_character_depth_prompt', false),
    matchScenario: pick(extensions, 'match_scenario', false),
    matchCreatorNotes: pick(extensions, 'match_creator_notes', false),
    delayUntilRecursion: pick(extensions, 'delay_until_recursion', false),
    probability: pick(extensions, 'probability', 100), useProbability: pick(extensions, 'useProbability', true),
    depth: pick(extensions, 'depth', 4), outletName: pick(extensions, 'outlet_name', ''),
    group: pick(extensions, 'group', ''), groupOverride: pick(extensions, 'group_override', false),
    groupWeight: pick(extensions, 'group_weight', 100), scanDepth: pick(extensions, 'scan_depth', null),
    caseSensitive: pick(extensions, 'case_sensitive', null), matchWholeWords: pick(extensions, 'match_whole_words', null),
    useGroupScoring: pick(extensions, 'use_group_scoring', null), automationId: pick(extensions, 'automation_id', ''),
    role: pick(extensions, 'role', 0), sticky: pick(extensions, 'sticky', null), cooldown: pick(extensions, 'cooldown', null),
    delay: pick(extensions, 'delay', null), triggers: pick(extensions, 'triggers', []),
    displayIndex: pick(extensions, 'display_index', index), extensions,
  };
  const card: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) if (!CARD_FIELDS.includes(field)) card[field] = value;
  // SillyTavern always exports `use_regex: true`; anything else came from another tool and has to be kept.
  if (Object.hasOwn(entry, 'use_regex') && entry.use_regex !== true) card.use_regex = entry.use_regex;
  if (entry.position !== (position === 0 ? 'before_char' : 'after_char')) card.position = entry.position;
  if (Object.keys(card).length) params.$card = card;
  return { params: params as LoreParams, content: (entry.content as string) ?? '' };
}

/** Back to a card `character_book` entry, in the shape SillyTavern writes. */
export function paramsToCardEntry(params: LoreParams, content: string): Record<string, unknown> {
  const source = params as Record<string, unknown>;
  const card = (params.$card ?? {}) as Record<string, unknown>;
  const keep = (field: string, fallback: unknown) => Object.hasOwn(source, field) ? source[field] : fallback;
  const entry: Record<string, unknown> = {
    id: params.uid, keys: params.key ?? [], secondary_keys: keep('keysecondary', []), comment: params.comment ?? '',
    content, constant: params.constant ?? false, selective: keep('selective', false), insertion_order: params.order,
    enabled: !keep('disable', false), position: params.position === 0 ? 'before_char' : 'after_char', use_regex: true,
    extensions: {
      ...((params.extensions ?? {}) as Record<string, unknown>),
      position: params.position, exclude_recursion: keep('excludeRecursion', false), display_index: keep('displayIndex', params.uid),
      probability: keep('probability', null), useProbability: keep('useProbability', false), depth: keep('depth', 4),
      selectiveLogic: keep('selectiveLogic', 0), outlet_name: keep('outletName', ''), group: keep('group', ''),
      group_override: keep('groupOverride', false), group_weight: keep('groupWeight', null),
      prevent_recursion: keep('preventRecursion', false), delay_until_recursion: keep('delayUntilRecursion', false),
      scan_depth: keep('scanDepth', null), match_whole_words: keep('matchWholeWords', null),
      use_group_scoring: keep('useGroupScoring', false), case_sensitive: keep('caseSensitive', null),
      automation_id: keep('automationId', ''), role: keep('role', 0), vectorized: keep('vectorized', false),
      sticky: keep('sticky', null), cooldown: keep('cooldown', null), delay: keep('delay', null),
      match_persona_description: keep('matchPersonaDescription', false),
      match_character_description: keep('matchCharacterDescription', false),
      match_character_personality: keep('matchCharacterPersonality', false),
      match_character_depth_prompt: keep('matchCharacterDepthPrompt', false),
      match_scenario: keep('matchScenario', false), match_creator_notes: keep('matchCreatorNotes', false),
      triggers: keep('triggers', []), ignore_budget: keep('ignoreBudget', false),
    },
    ...card,
  };
  return entry;
}

/** One entry of a standalone world book export, split into parameters and body. */
export function bookEntryToParams(entry: Record<string, unknown>): LoreSplit {
  const params: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) if (field !== 'content') params[field] = value;
  return { params: params as LoreParams, content: (entry.content as string) ?? '' };
}

/** Back to a standalone world book entry; card-only fields stay out of it. */
export function paramsToBookEntry(params: LoreParams, content: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(params)) {
    if (field === '$card' || value === undefined) continue;
    entry[field] = value;
    if (field === 'comment') entry.content = content;
  }
  if (!Object.hasOwn(entry, 'content')) entry.content = content;
  return entry;
}

/** Which section a world book entry belongs to, from the order table in the handoff (§6). */
export function sectionOfParams(params: { order?: unknown; position?: unknown; comment?: string; [field: string]: unknown }): string {
  const order = Number(params.order); const position = Number(params.position);
  const comment = params.comment ?? '';
  if (!Number.isFinite(order)) return 'lore-other';
  if (order === 0 && position === 4) return 'lore-format';
  if (order >= 1 && order <= 9) return 'lore-rules';
  if (order >= 10 && order <= 14) return /人物|角色/.test(comment) ? 'lore-people' : 'lore-overview';
  if (order >= 15 && order <= 19) return 'lore-plot';
  if (order >= 20 && order <= 99) return 'lore-setting';
  if (order === 100 && position !== 4) return 'lore-people';
  if (order >= 300 && position === 4) return 'lore-plot';
  if (order === 1002 || (order >= 9990 && order <= 9999)) return 'lore-vars';
  return 'lore-other';
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** `100-爱蜜莉雅`: the order first so a folder listing reads in prompt order, the comment after it. */
export function loreFileName(params: { uid: number; order?: unknown; comment?: string; [field: string]: unknown }, taken: ReadonlySet<string>): string {
  const cleaned = [...(params.comment ?? '').replace(ILLEGAL, '_').trim()].slice(0, 40).join('').replace(/[. ]+$/, '');
  const base = `${Number.isFinite(Number(params.order)) ? params.order : 0}-${cleaned || '未命名'}`;
  return taken.has(base) ? `${base}~${params.uid}` : base;
}
