import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REQUIRED_TOKENS } from '../../shared/card-studio/assembly-sheet.ts';
import { boardOf, sectionLabel } from '../../shared/card-studio/boards.ts';
import { boardPromptFile, sectionPromptFile } from '../../shared/card-studio/prompt-files.ts';
import type { CardKind, PlanMode } from '../../shared/card-studio/types.ts';

/** Built-in section prompts ship with the application; developer mode can override them (prompt-overrides.ts). */
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

/** `read` lets prompt overrides stand in for the shipped files; without it the shipped files are read. */
export async function buildSectionPrompt(resourceRoot: string, input: SectionPromptInput, options: { read?: (relative: string) => Promise<string> } = {}): Promise<string> {
  const read = options.read ?? (relative => resource(resourceRoot, relative));
  const shared = await read('prompts/通用规则.md');
  const boardFile = boardPromptFile(input.sectionId);
  const board = boardFile ? await read('prompts/' + boardFile) : '';
  const file = sectionPromptFile(input.sectionId, input.mode);
  const own = file ? await read(`prompts/${file}`) : MISSING_SECTION_PROMPT;
  const kind = input.cardKind === 'fan' ? `同人卡 · 《${input.source?.trim() || '未填原作名'}》` : '原创卡';
  return [
    `# 制卡工坊 · ${sectionLabel(input.sectionId)}`,
    '',
    '## 本次对话',
    `- 卡项目：${input.cardName}（${kind}）`,
    `- 卡项目根目录：${input.projectRoot}（只在这里读写文件）`,
    `- 内置资料根目录（只读）：${resourceRoot}`,
    `- 知识库：${join(resourceRoot, 'knowledge', 'README.md')}`,
    '',
    shared,
    ...(board ? ['', board] : []),
    '',
    own,
    ...(boardOf(input.sectionId).id === 'regex' ? ['', ...presetSection(input.stylePreset ?? null)] : []),
  ].join('\n');
}

/** A read-only reader of an Ultra planning squad: reads the material and the design book and reports back to planning. */
export function buildSquadMemberPrompt(input: Omit<SectionPromptInput, 'sectionId' | 'mode'>): string {
  const kind = input.cardKind === 'fan' ? `同人卡 · 《${input.source?.trim() || '未填原作名'}》` : '原创卡';
  return [
    '# 制卡工坊 · 规划小队 · 只读资料员',
    '',
    `- 卡项目：${input.cardName}（${kind}）`,
    `- 卡项目根目录：${input.projectRoot}（只读）`,
    '',
    '你是规划 AI 派出的只读资料员。按分给你的任务读资料和设计书、整理要点，再把结果交回规划 AI，由它汇总后和用户对话。',
    '',
    '- 只读：不写、不改任何文件，不新建组件。',
    '- 先读 `资料/索引.md`；找人物、事件或说法时先用 `card_search_sources`（搜资料）按关键词或正则搜分章，再精读命中的章节。不要用命令搜资料。',
    '- 回复只写要点：人物、地点、事件、时间线，每条附原文出处（分章文件与行号）；资料里查不到的写成缺口，不要编造。',
    '- 用中文。',
  ].join('\n');
}

export function readKnowledgeIndex(resourceRoot: string): Promise<string> {
  return resource(resourceRoot, 'knowledge/README.md');
}
