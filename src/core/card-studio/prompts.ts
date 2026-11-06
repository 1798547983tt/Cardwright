import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REQUIRED_TOKENS } from '../../shared/card-studio/assembly-sheet.ts';
import { boardOf, sectionLabel } from '../../shared/card-studio/boards.ts';
import { sectionBriefRule, optimizedBatchRule, type CardAgentOptimization } from '../../shared/card-studio/card-optimization.ts';
import { SQUAD_PROMPT_FILES, boardPromptFile, sectionPromptFile } from '../../shared/card-studio/prompt-files.ts';
import type { CardKind, CardMemberComponent, CardMemberRole, PlanMode } from '../../shared/card-studio/types.ts';

/** Built-in section prompts ship with the application; the prompt editor can override them (prompt-overrides.ts). */
export interface SectionPromptInput {
  sectionId: string; mode?: PlanMode; cardName: string; cardKind: CardKind; source?: string; projectRoot: string;
  /** The preset the design book names; the regex board gets it in the prompt (ADR 0019: skins are compiled in, prose is not read). */
  stylePreset?: { id: string; name: string } | null;
}

const MISSING_SECTION_PROMPT = '本分区的专用提示词尚未内置。只按设计书和派单工作；遇到需要本分区专门知识才能决定的地方，停下来说明，请用户回规划补充设计书。';

const TOKEN_NAMES = [...REQUIRED_TOKENS, '--panel-2', '--line-strong', '--radius', '--radius-sm', '--shadow', '--sans', '--serif', '--mono'];
/** What the regex sections are told about the card's look: the preset by id, the token names, and where the sheet vocabulary is. */
function presetSection(preset: SectionPromptInput['stylePreset']): string[] {
  const lines = ['## 本卡的风格预设与前端骨架', ''];
  if (!preset) lines.push('- 设计书还没有定风格预设。装配单里的 `预设:` 先留空（应用按粉樱 sakura 编译），并在交付里提醒用户回规划补「风格预设」一节。');
  else if (preset.id === 'custom') lines.push('- 预设：题材自定（custom）。把设计书「风格预设」一节的令牌逐个抄进装配单的 `令牌:`（键名见下），缺的令牌回规划补，不要临场发挥。');
  else lines.push(`- 预设：${preset.name}（${preset.id}）。装配单里写 \`预设: ${preset.id}\` 即可，皮肤由应用在编译时注入；不用去读 styles/ 里的预设散文（那是手写 .html 前端才读的）。`);
  lines.push(`- 令牌名（自定义区块的 CSS 只能用这些 \`var()\`，不写具体色值）：${TOKEN_NAMES.map(name => `\`${name}\``).join('、')}。`, '- 装配单的字段、区块词汇、图标名与三份样例在内置资料 `frontend/blocks/词汇.md` 与 `frontend/blocks/样例-*.yaml`。');
  return lines;
}

export { boardPromptFile, sectionPromptFile } from '../../shared/card-studio/prompt-files.ts';

async function resource(root: string, relative: string): Promise<string> {
  try { return (await readFile(join(root, ...relative.split('/')), 'utf8')).replace(/^\uFEFF/, '').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`内置提示词缺失：${relative}。请重新安装 Cardwright。`);
    throw error;
  }
}

function cardKindLabel(input: Pick<SectionPromptInput, 'cardKind' | 'source'>): string {
  return input.cardKind === 'fan' ? `同人卡 · 《${input.source?.trim() || '未填原作名'}》` : '原创卡';
}

/**
 * The rules a section works by: the common rules, its board's, its own, and for regex sections the card's preset.
 * `attachBrief` is true only when the caller really appends `buildSectionBrief`; otherwise the read-first list stays,
 * so a planning or member conversation is never told to read a dispatch brief it does not have.
 */
async function sectionRules(read: (relative: string) => Promise<string>, input: Pick<SectionPromptInput, 'sectionId' | 'mode' | 'stylePreset'>, optimization?: CardAgentOptimization, attachBrief = false): Promise<string[]> {
  const briefConfig = attachBrief || !optimization ? optimization : { ...optimization, sectionBrief: false };
  const shared = sectionBriefRule(optimizedBatchRule(await read('prompts/通用规则.md'), optimization), briefConfig);
  const boardFile = boardPromptFile(input.sectionId);
  const board = boardFile ? await read('prompts/' + boardFile) : '';
  const file = sectionPromptFile(input.sectionId, input.mode);
  const own = file ? await read(`prompts/${file}`) : MISSING_SECTION_PROMPT;
  return [shared, ...(board ? ['', board] : []), '', own, ...(boardOf(input.sectionId).id === 'regex' ? ['', ...presetSection(input.stylePreset ?? null)] : [])];
}

/** `read` lets prompt overrides stand in for the shipped files; without it the shipped files are read. */
export async function buildSectionPrompt(resourceRoot: string, input: SectionPromptInput, options: { read?: (relative: string) => Promise<string>; optimization?: CardAgentOptimization; attachBrief?: boolean } = {}): Promise<string> {
  const read = options.read ?? (relative => resource(resourceRoot, relative));
  return [
    `# 制卡工坊 · ${sectionLabel(input.sectionId)}`,
    '',
    '## 本次对话',
    `- 卡项目：${input.cardName}（${cardKindLabel(input)}）`,
    `- 卡项目根目录：${input.projectRoot}（只在这里读写文件）`,
    `- 内置资料根目录（只读）：${resourceRoot}`,
    `- 知识库：${join(resourceRoot, 'knowledge', 'README.md')}`,
    '',
    ...(await sectionRules(read, input, options.optimization, options.attachBrief)),
  ].join('\n');
}

export interface MemberPromptInput extends SectionPromptInput { role: CardMemberRole; files: readonly string[]; create: readonly string[]; created?: readonly CardMemberComponent[] }

/** A squad member (spec §6.4): its own prompt; a 写组件 then gets the components it was given and the section's rules. */
export async function buildMemberPrompt(resourceRoot: string, input: MemberPromptInput, options: { read?: (relative: string) => Promise<string>; optimization?: CardAgentOptimization } = {}): Promise<string> {
  const read = options.read ?? (relative => resource(resourceRoot, relative));
  const writer = input.role === 'writer';
  const lines = [
    `# 制卡工坊 · ${sectionLabel(input.sectionId)} · 小队成员`,
    '',
    '## 本次任务',
    `- 卡项目：${input.cardName}（${cardKindLabel(input)}）`,
    `- 卡项目根目录：${input.projectRoot}（${writer ? '只写分给你的组件' : '只读'}）`,
    `- 内置资料根目录（只读）：${resourceRoot}`,
    `- 知识库：${join(resourceRoot, 'knowledge', 'README.md')}`,
    '',
    await read(`prompts/${SQUAD_PROMPT_FILES[input.role]}`),
  ];
  if (!writer) return lines.join('\n');
  return [
    ...lines,
    '',
    '## 分给你的组件',
    '',
    `- 可以改的已有组件文件：${input.files.length ? input.files.map(path => `\`${path}\``).join('、') : '（没有）'}`,
    `- 可以用 card_new_component 新建的组件名称：${input.create.length ? input.create.map(name => `「${name}」`).join('、') : '（没有）'}`,
    // Sent again (spec §6.3): what it created in an earlier run is its own to write.
    ...(input.created?.length ? [`- 已经新建好的组件（直接改它们的文件）：${input.created.map(item => `「${item.name}」${item.paths.map(path => `\`${path}\``).join('、')}`).join('；')}`] : []),
    '',
    ...(await sectionRules(read, input, options.optimization)),
  ].join('\n');
}

export function readKnowledgeIndex(resourceRoot: string): Promise<string> {
  return resource(resourceRoot, 'knowledge/README.md');
}
