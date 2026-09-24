/** The seven boards of a card project and their sections, in dispatch-display order. */
export interface StudioSection { id: string; name: string; high?: boolean; optional?: boolean }
export type BoardId = 'plan' | 'source' | 'lore' | 'script' | 'regex' | 'greet' | 'build';
export interface StudioBoard { id: BoardId; no: string; name: string; en: string; color: string; sections: StudioSection[] }

export const BOARDS: readonly StudioBoard[] = [
  { id: 'plan', no: '01', name: '规划', en: 'PLANNING', color: '#d2ad62', sections: [{ id: 'plan', name: '规划', high: true }] },
  { id: 'source', no: '02', name: '资料', en: 'SOURCES', color: '#86a36c', sections: [{ id: 'source', name: '资料' }] },
  { id: 'lore', no: '03', name: '世界书', en: 'LOREBOOK', color: '#4db6c1', sections: [
    { id: 'lore-rules', name: '叙事规则' }, { id: 'lore-overview', name: '总览' }, { id: 'lore-setting', name: '设定' },
    { id: 'lore-people', name: '人设', high: true }, { id: 'lore-plot', name: '剧情', high: true },
    { id: 'lore-vars', name: '变量' }, { id: 'lore-format', name: '正文格式' }] },
  { id: 'script', no: '04', name: '脚本', en: 'SCRIPTS', color: '#9a82d6', sections: [
    { id: 'script-schema', name: '变量结构' }, { id: 'script-controller', name: '世界书控制器', high: true }, { id: 'script-mechanism', name: '机制脚本', optional: true }] },
  { id: 'regex', no: '05', name: '正则', en: 'REGEX', color: '#e3a13c', sections: [
    { id: 'regex-update', name: '变量更新渲染', high: true }, { id: 'regex-status', name: '状态栏', high: true },
    { id: 'regex-body', name: '正文美化', high: true }, { id: 'regex-start', name: '开局创角页', high: true }] },
  { id: 'greet', no: '06', name: '开场白', en: 'GREETINGS', color: '#d4545f', sections: [{ id: 'greet', name: '开场白' }] },
  { id: 'build', no: '07', name: '拼装', en: 'ASSEMBLY', color: '#b7c0c9', sections: [{ id: 'build', name: '拼装' }] },
];

export const SECTION_IDS: readonly string[] = BOARDS.flatMap(board => board.sections.map(section => section.id));
/** Where an imported world book entry no section takes is kept (世界书/未分类). It has no board section, no page and no prompt. */
export const UNCLASSIFIED_SECTION = 'lore-other';

/**
 * The order sections depend on each other (§5.4): a section reads what the ones before it wrote. 改动派单 run in this
 * order whatever order the change AI wrote them in.
 */
export const SECTION_ORDER: readonly string[] = [
  'plan', 'lore-rules', 'lore-overview', 'lore-setting', 'lore-people', 'lore-plot', 'script-schema', 'lore-vars',
  'lore-format', 'regex-update', 'regex-body', 'regex-status', 'regex-start', 'greet', 'script-controller', 'script-mechanism', 'build',
];

/** Items in dependency order of their sections; the order they came in breaks ties, and an unknown or missing section goes last. */
export function sortByDependency<T extends { sectionId: string | null }>(items: readonly T[]): T[] {
  const rank = (item: T) => { const at = item.sectionId ? SECTION_ORDER.indexOf(item.sectionId) : -1; return at < 0 ? SECTION_ORDER.length : at; };
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(entry => entry.item);
}

/** The board of a section, or undefined: section ids also come from card data (checks, dispatches, conversations). */
export function findBoard(sectionId: string): StudioBoard | undefined {
  return BOARDS.find(item => item.sections.some(section => section.id === sectionId));
}

/** For ids the code itself names; an unknown one is a programming error. */
export function boardOf(sectionId: string): StudioBoard {
  const board = findBoard(sectionId);
  if (!board) throw new Error(`Unknown card studio section: ${sectionId}`);
  return board;
}

export function sectionOf(sectionId: string): StudioSection | undefined {
  return BOARDS.flatMap(board => board.sections).find(section => section.id === sectionId);
}

/** 「世界书 · 人设」 for multi-section boards, 「规划」 for single-section boards. Never throws: 未分类 has its own label, any other unknown id is shown as it is. */
export function sectionLabel(sectionId: string): string {
  if (sectionId === UNCLASSIFIED_SECTION) return '世界书 · 未分类';
  const board = findBoard(sectionId);
  if (!board) return sectionId;
  return board.sections.length > 1 ? `${board.name} · ${sectionOf(sectionId)!.name}` : board.name;
}

/** The dispatch target string for a section: 「世界书/人设」 or 「开场白」. */
export function targetOf(sectionId: string): string {
  const board = boardOf(sectionId);
  return board.sections.length > 1 ? `${board.name}/${sectionOf(sectionId)!.name}` : board.name;
}

export function normalizeTarget(target: string): string {
  return target.replace(/\s*[/／]\s*/g, '/').trim();
}

export function sectionFromTarget(target: string): string | null {
  const [boardName, sectionName, extra] = normalizeTarget(target).split('/');
  if (extra !== undefined) return null;
  const board = BOARDS.find(item => item.name === boardName);
  if (!board) return null;
  if (sectionName === undefined) return board.sections.length === 1 ? board.sections[0].id : null;
  return board.sections.find(section => section.name === sectionName)?.id ?? null;
}
