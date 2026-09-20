/**
 * Splitting a character card into component parts and building it back. The envelope keeps everything that is
 * not a component — including fields this version does not understand — so an imported card comes back unchanged.
 * Card structure verified against the V3 spec and SillyTavern 1.19.0.
 */
import { cardEntryToParams, paramsToCardEntry, type LoreSplit } from './lore.ts';

export interface ComponentSplit { params: Record<string, unknown>; body: string }
export interface CardGreetings { first: string; alternates: string[]; groupOnly: string[] }
export interface CardParts {
  /** The card with every component-owned value emptied; component values are written back on build. */
  envelope: Record<string, unknown>;
  book: { name: string; extras: Record<string, unknown> };
  lore: LoreSplit[];
  regex: ComponentSplit[];
  scripts: ComponentSplit[];
  greetings: CardGreetings;
}

const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function isCardJson(value: unknown): boolean {
  const card = record(value);
  if (typeof card.spec === 'string' && card.spec.startsWith('chara_card')) return true;
  if (record(card.data).name !== undefined || record(card.data).description !== undefined) return true;
  return typeof card.name === 'string' && (typeof card.first_mes === 'string' || typeof card.description === 'string');
}

export function isLorebookJson(value: unknown): boolean {
  const book = record(value);
  if (isCardJson(value)) return false;
  const entries = book.entries;
  if (Array.isArray(entries)) return entries.every(item => record(item).content !== undefined || record(item).comment !== undefined);
  return !!entries && typeof entries === 'object';
}

/** The skeleton a card project starts from before anything is written. */
export function emptyCardEnvelope(name: string, now = new Date()): Record<string, unknown> {
  const at = now.toISOString();
  return {
    spec: 'chara_card_v3', spec_version: '3.0', name, description: '', personality: '', scenario: '', first_mes: '',
    mes_example: '', creator: '', creator_notes: '', creatorcomment: '', character_version: '', tags: [],
    avatar: 'none', fav: false, talkativeness: 0.5, create_date: at,
    data: {
      name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator: '',
      creator_notes: '', character_version: '', system_prompt: '', post_history_instructions: '', tags: [],
      alternate_greetings: [], group_only_greetings: [],
      character_book: { name, entries: [] },
      extensions: { world: name, depth_prompt: { depth: 4, prompt: '', role: 'system' }, fav: false, talkativeness: 0.5, regex_scripts: [], tavern_helper: { scripts: [], variables: {} } },
    },
  };
}

/** Splits a V1/V2/V3 card into components; everything else stays in the envelope. */
export function splitCard(input: Record<string, unknown>): CardParts {
  const envelope = clone(input);
  // V1 cards have no data block: their top level is the card data.
  const owned = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? record(envelope.data) : envelope;
  const book = record(owned.character_book);
  const entries = Array.isArray(book.entries) ? book.entries : Object.values(record(book.entries));
  const lore = entries.map((item, index) => cardEntryToParams(record(item), index));
  const bookExtras: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(book)) if (field !== 'entries' && field !== 'name') bookExtras[field] = clone(value);

  const extensions = record(owned.extensions);
  const helper = record(extensions.tavern_helper);
  const regex = list(extensions.regex_scripts).map(item => splitComponent(record(item), 'replaceString'));
  const scripts = list(helper.scripts).map(item => splitComponent(record(item), 'content'));
  const greetings: CardGreetings = {
    first: text(owned.first_mes ?? envelope.first_mes),
    alternates: list(owned.alternate_greetings).map(text),
    groupOnly: list(owned.group_only_greetings).map(text),
  };

  if (Object.hasOwn(owned, 'character_book')) owned.character_book = { ...book, entries: [] };
  if (Object.hasOwn(extensions, 'regex_scripts')) extensions.regex_scripts = [];
  if (Object.hasOwn(helper, 'scripts')) helper.scripts = [];
  for (const field of ['first_mes', 'alternate_greetings', 'group_only_greetings'] as const) {
    if (Object.hasOwn(owned, field)) owned[field] = field === 'first_mes' ? '' : [];
    if (owned !== envelope && Object.hasOwn(envelope, field)) envelope[field] = field === 'first_mes' ? '' : [];
  }
  return { envelope, book: { name: text(book.name) || text(owned.name) || text(envelope.name), extras: bookExtras }, lore, regex, scripts, greetings };
}

export function splitComponent(item: Record<string, unknown>, bodyField: string): ComponentSplit {
  const params: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(item)) if (field !== bodyField) params[field] = clone(value);
  return { params, body: text(item[bodyField]) };
}

export function joinComponent(component: ComponentSplit, bodyField: string): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  let written = false;
  for (const [field, value] of Object.entries(component.params)) {
    item[field] = clone(value);
    if (!written && (field === 'scriptName' || field === 'name')) { item[bodyField] = component.body; written = true; }
  }
  if (!written) item[bodyField] = component.body;
  return item;
}

/** Builds a V3 card from the envelope and the components. */
export function buildCard(parts: CardParts): Record<string, unknown> {
  const card = clone(parts.envelope);
  if (!(card.data && typeof card.data === 'object' && !Array.isArray(card.data))) {
    // A V1 card has no data block: move its fields into one, then write the components into it.
    const moved = clone(card); delete moved.data; delete moved.spec; delete moved.spec_version;
    card.data = moved;
  }
  const data = record(card.data);
  card.spec = 'chara_card_v3';
  card.spec_version = '3.0';

  const extensions = record(data.extensions);
  data.extensions = extensions;
  if (parts.regex.length || Object.hasOwn(extensions, 'regex_scripts')) extensions.regex_scripts = parts.regex.map(item => joinComponent(item, 'replaceString'));
  if (parts.scripts.length || Object.hasOwn(extensions, 'tavern_helper')) {
    const helper = record(extensions.tavern_helper);
    helper.scripts = parts.scripts.map(item => joinComponent(item, 'content'));
    if (!Object.hasOwn(helper, 'variables')) helper.variables = {};
    extensions.tavern_helper = helper;
  }
  if (parts.lore.length || Object.hasOwn(data, 'character_book')) {
    data.character_book = { ...clone(parts.book.extras), name: parts.book.name, entries: parts.lore.map(item => paramsToCardEntry(item.params, item.content)) };
  }
  data.first_mes = parts.greetings.first;
  data.alternate_greetings = [...parts.greetings.alternates];
  if (parts.greetings.groupOnly.length || Object.hasOwn(data, 'group_only_greetings')) data.group_only_greetings = [...parts.greetings.groupOnly];
  if (card !== data) {
    // SillyTavern keeps V2-compatible mirrors on the top level; refresh the ones the card already has.
    if (Object.hasOwn(card, 'first_mes')) card.first_mes = parts.greetings.first;
    for (const field of ['name', 'description', 'personality', 'scenario', 'mes_example', 'character_version', 'creator', 'tags'] as const) {
      if (Object.hasOwn(card, field) && Object.hasOwn(data, field)) card[field] = clone(data[field]);
    }
    if (Object.hasOwn(card, 'creatorcomment') && Object.hasOwn(data, 'creator_notes')) card.creatorcomment = clone(data.creator_notes);
    if (Object.hasOwn(card, 'creator_notes') && Object.hasOwn(data, 'creator_notes')) card.creator_notes = clone(data.creator_notes);
  }
  return card;
}
