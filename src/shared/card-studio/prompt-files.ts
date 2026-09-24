import { boardOf } from './boards.ts';
import type { PlanMode } from './types.ts';

/** Which built-in prompt file each section and board uses; shared so developer mode can open a section's own prompt. */
const SECTION_FILES: Partial<Record<string, string>> = {
  'lore-rules': '世界书-叙事规则.md', 'lore-overview': '世界书-总览.md', 'lore-setting': '世界书-设定.md',
  'lore-people': '世界书-人设.md', 'lore-plot': '世界书-剧情.md', 'lore-vars': '世界书-变量.md',
  'lore-format': '世界书-正文格式.md',
  'script-schema': '脚本-变量结构.md', 'script-controller': '脚本-世界书控制器.md', 'script-mechanism': '脚本-机制脚本.md',
  'regex-update': '正则-变量更新渲染.md', 'regex-status': '正则-状态栏.md', 'regex-body': '正则-正文美化.md', 'regex-start': '正则-开局创角页.md',
  greet: '开场白.md',
};
/** Prompts shared by every section of one board, inserted between the common rules and the section's own. */
const BOARD_FILES: Partial<Record<string, string>> = { lore: '世界书-通用.md', script: '脚本-通用.md', regex: '正则-通用.md' };

export function sectionPromptFile(sectionId: string, mode?: PlanMode): string | undefined {
  if (sectionId === 'plan') return mode === 'refine' ? '规划-完善优化卡.md' : mode === 'change' ? '规划-改动单.md' : '规划-从零开始制卡.md';
  return SECTION_FILES[sectionId];
}

export function boardPromptFile(sectionId: string): string | undefined {
  return BOARD_FILES[boardOf(sectionId).id];
}

/** The prompt override ids a section's conversations are built from, most specific first. A 改动单 has no kickoff line. */
export function sectionPromptIds(sectionId: string, mode?: PlanMode): string[] {
  const own = sectionPromptFile(sectionId, mode);
  const board = boardPromptFile(sectionId);
  return [...(own ? [`prompts/${own}`] : []), ...(board ? [`prompts/${board}`] : []), 'prompts/通用规则.md', ...(sectionId === 'plan' && mode !== 'change' ? [`kickoff/${mode === 'refine' ? 'refine' : 'scratch'}`] : [])];
}
