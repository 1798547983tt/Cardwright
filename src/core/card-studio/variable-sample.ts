// src/core/card-studio/variable-sample.ts
/** The variables a preview starts from: the card's [initvar], else the 变量表 defaults, else nothing. */
import { parse as parseYaml } from 'yaml';
import { generateInitialVariables } from '../../shared/card-studio/variable-generate.ts';
import type { VariableTable } from '../../shared/card-studio/variable-table.ts';
import { parseInitialVariables } from './variables.ts';
import type { ProjectComponents } from './components.ts';

const INITVAR = /initvar|初始变量/i;

export function sampleVariables(project: ProjectComponents, table: VariableTable | null): Record<string, unknown> {
  const initvar = project.lore.find(entry => INITVAR.test(String(entry.params.comment)));
  if (initvar) { try { return parseInitialVariables(initvar.content) as Record<string, unknown>; } catch { /* fall through to the table */ } }
  if (table) { try { const value = parseYaml(generateInitialVariables(table)); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* nothing */ } }
  return {};
}
