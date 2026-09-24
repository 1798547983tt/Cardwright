// src/core/card-studio/assembly.ts
/**
 * From component files to what SillyTavern imports (ADR 0010, revised by ADR 0019): a hand-written regex body gets its
 * 前端围栏; a 装配单 is compiled with the 变量表, the runtime and a skin; a floating status bar also yields a 酒馆助手 script.
 */
import { buildCard, joinComponent, type CardParts } from '../../shared/card-studio/card-file.ts';
import { withFrontendFence } from '../../shared/card-studio/frontend.ts';
import { AssemblySheetError, isAssemblySheet, parseAssemblySheet, type AssemblySheet, type BodySheet, type StatusForm, type StatusSheet } from '../../shared/card-studio/assembly-sheet.ts';
import { compileSheet, type CompileIssue, type FrontendResources } from '../../shared/card-studio/frontend-compile.ts';
import type { VariableTable } from '../../shared/card-studio/variable-table.ts';
import type { FileComponent, PieceKind, ProjectComponents } from './components.ts';

export interface AssemblyContext { frontend: FrontendResources | null; table: VariableTable | null; cardName: string; preset?: string | null }
export interface AssemblyIssue { code: CompileIssue['code']; message: string; path?: string; component: string; bodyPath: string }
export interface CompiledRegex { component: FileComponent; sheet: AssemblySheet | null; replacement: string; form?: StatusForm }
export interface SynthesizedScript { name: string; params: Record<string, unknown>; body: string; from: FileComponent }
export interface CompiledProject { regex: CompiledRegex[]; scripts: SynthesizedScript[]; issues: AssemblyIssue[] }
export const FLOATING_SUFFIX = '·悬浮应用';
/** Without the shipped skeleton no sheet compiles: one issue for the project, not one per sheet. */
export const NO_SKELETON_MESSAGE = '没有前端骨架资源，装配单编译不了。请重新安装 Cardwright。';
const label = (item: FileComponent): string => String(item.params.scriptName ?? item.name);

/** The card name the assembly writes and the preview's {{char}}: the card's own name, else `fallback` (the registration's), else 角色卡. */
export function assemblyCardName(project: ProjectComponents, fallback?: string | null): string {
  const data = (project.envelope.data && typeof project.envelope.data === 'object' ? project.envelope.data : {}) as Record<string, unknown>;
  return String(data.name ?? '').trim() || String(fallback ?? '').trim() || '角色卡';
}

/** A regex component whose body is a 装配单: every `.yaml` body (an empty one included), and an `.html` body that opens with 前端:. */
export function isSheetComponent(item: FileComponent): boolean {
  return item.format === 'yaml' || (item.format === 'html' && isAssemblySheet(item.body));
}

/** Every sheet-bodied regex parsed, or the error it raised. */
function parsedSheets(project: ProjectComponents): Map<string, AssemblySheet | AssemblySheetError> {
  const sheets = new Map<string, AssemblySheet | AssemblySheetError>();
  for (const item of project.regex) {
    if (!isSheetComponent(item)) continue;
    try { sheets.set(item.name, parseAssemblySheet(item.body)); }
    catch (error) { sheets.set(item.name, error instanceof AssemblySheetError ? error : new AssemblySheetError([{ path: '装配单', message: error instanceof Error ? error.message : String(error) }])); }
  }
  return sheets;
}

export function compileProject(project: ProjectComponents, context: AssemblyContext): CompiledProject {
  const sheets = parsedSheets(project);
  const issues: AssemblyIssue[] = [];
  const first = (kind: AssemblySheet['kind']) => [...sheets.values()].find((sheet): sheet is AssemblySheet => !(sheet instanceof Error) && sheet.kind === kind) ?? null;
  const bodySheet = first('正文美化') as BodySheet | null;
  const statusSheet = first('状态栏') as StatusSheet | null;
  const scripts: SynthesizedScript[] = [];
  const counts = new Map<AssemblySheet['kind'], number>();
  let skeletonless = false;
  const regex = project.regex.map((component): CompiledRegex => {
    const parsed = sheets.get(component.name);
    if (!parsed) return { component, sheet: null, replacement: withFrontendFence(component.body) };
    if (parsed instanceof Error) {
      issues.push(...parsed.issues.slice(0, 8).map(issue => ({ code: 'sheet-invalid' as const, message: `「${label(component)}」装配单 ${issue.path}：${issue.message}`, component: component.name, bodyPath: component.bodyPath })));
      return { component, sheet: null, replacement: '' };
    }
    const nth = (counts.get(parsed.kind) ?? 0) + 1;
    counts.set(parsed.kind, nth);
    if (nth > 1) issues.push({ code: 'sheet-invalid', message: `「${label(component)}」是本卡第 ${nth} 个「${parsed.kind}」装配单，只认第一个；删掉多余的。`, component: component.name, bodyPath: component.bodyPath });
    if (!context.frontend) { skeletonless = true; return { component, sheet: parsed, replacement: '', ...(parsed.kind === '状态栏' ? { form: parsed.form } : {}) }; }
    const result = compileSheet(parsed, { resources: context.frontend, table: context.table, cardName: context.cardName, preset: context.preset ?? null, bodySheet, statusSheet, regexId: String(component.params.id ?? component.name) });
    issues.push(...result.issues.map(issue => ({ ...issue, message: `「${label(component)}」${issue.message}`, component: component.name, bodyPath: component.bodyPath })));
    if (result.script) {
      const id = `${String(component.params.id ?? component.name)}-floating`;
      scripts.push({ name: `${component.name}${FLOATING_SUFFIX}`, from: component, body: result.script, params: { type: 'script', enabled: component.params.disabled !== true, name: `${label(component)}${FLOATING_SUFFIX}`, id, info: '由状态栏装配单编译（形态 floating）；改装配单，不改这里。', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false } } });
    }
    return { component, sheet: parsed, replacement: result.html ? withFrontendFence(result.html) : '', ...(result.form ? { form: result.form } : {}) };
  });
  if (skeletonless) issues.push({ code: 'sheet-invalid', message: NO_SKELETON_MESSAGE, component: '', bodyPath: '' });
  return { regex, scripts, issues };
}

/** What a regex component writes into `replaceString`: compiled when it is a sheet, fenced when it is a document. */
export function regexReplacement(item: FileComponent, compiled?: CompiledProject): string {
  const found = compiled?.regex.find(entry => entry.component === item || entry.component.name === item.name);
  return found ? found.replacement : withFrontendFence(item.body);
}

function partsOf(project: ProjectComponents, compiled: CompiledProject): CardParts {
  return {
    envelope: project.envelope,
    book: { name: project.book.name, extras: project.book.extras },
    lore: project.lore.map(item => ({ params: item.params, content: item.content })),
    regex: compiled.regex.map(item => ({ params: item.component.params, body: item.replacement })),
    scripts: [...project.scripts.map(item => ({ params: item.params, body: item.body })), ...compiled.scripts.map(item => ({ params: item.params, body: item.body }))],
    greetings: {
      first: project.greetings.find(item => item.kind === 'first')?.text ?? '',
      alternates: project.greetings.filter(item => item.kind === 'alternate').map(item => item.text),
      groupOnly: project.greetings.filter(item => item.kind === 'group').map(item => item.text),
    },
  };
}

/** The card SillyTavern imports, from a project that is already compiled (the checks read back the one they checked). */
export function buildCardFromCompiled(project: ProjectComponents, compiled: CompiledProject): Record<string, unknown> {
  return buildCard(partsOf(project, compiled));
}

export function buildCardFromProject(project: ProjectComponents, context: AssemblyContext): Record<string, unknown> {
  return buildCardFromCompiled(project, compileProject(project, context));
}

/**
 * One regex or script joined back into the shape SillyTavern and 酒馆助手 import; a synthesized script counts as a script.
 * `compiled` is the project already compiled with `context`, for a caller exporting several pieces at once.
 */
export function buildPiece(project: ProjectComponents, kind: PieceKind, name: string, context: AssemblyContext, compiled?: CompiledProject): Record<string, unknown> {
  const own = kind === 'script' ? project.scripts.find(item => item.name === name) : undefined;
  if (own) return joinComponent({ params: own.params, body: own.body }, 'content');
  const assembled = compiled ?? compileProject(project, context);
  if (kind === 'regex') {
    const piece = assembled.regex.find(item => item.component.name === name);
    if (!piece) throw new Error(`没有找到正则组件「${name}」。`);
    return joinComponent({ params: piece.component.params, body: piece.replacement }, 'replaceString');
  }
  const synthesized = assembled.scripts.find(item => item.name === name);
  if (!synthesized) throw new Error(`没有找到脚本组件「${name}」。`);
  return joinComponent({ params: synthesized.params, body: synthesized.body }, 'content');
}
