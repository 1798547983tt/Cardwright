// src/shared/card-studio/frontend-compile.ts
/**
 * 装配单 → 前端 (ADR 0019): the sheet, the 变量表, the runtime and a skin become the document a regex writes, or the
 * script a floating status bar runs. Pure code: the resources are passed in, never read here.
 */
import { sheetLabel, sheetPaths, type AssemblySheet, type BodySheet, type SheetBlock, type SheetItem, type SheetKind, type StartSheet, type StatusForm, type StatusSheet } from './assembly-sheet.ts';
import { matchVariablePath, type VariableRow, type VariableTable } from './variable-table.ts';

export interface FrontendResources { version: string; core: string; host: string; floating: string; base: string; skins: Record<string, string> }
/**
 * 外链模式（编译选项）：骨架、皮肤与 runtime 不内联，改成指向**已发布 tag** 的 `<link>`/`<script src>`。
 * `root` 形如 `https://testingcf.jsdelivr.net/gh/<owner>/<repo>@<tag>/card-studio/frontend`。
 * 好处：卡体积约减半，runtime 不再穿过酒馆的文本管线（实体、`$`、`{{` 这些问题都碰不到了）。
 */
export interface FrontendExternal { root: string }
export interface CompileIssue { code: 'sheet-invalid' | 'variable-binding' | 'variable-table-missing'; message: string; path?: string }
export interface CompileContext {
  resources: FrontendResources | null; table: VariableTable | null; cardName: string;
  /** 给了就按外链模式编译；不给就是内联（默认）。 */
  external?: FrontendExternal | null;
  /** The card's preset when the sheet names none. */ preset?: string | null;
  /** The project's other sheets: a header status bar needs the body sheet, and a body sheet with 状态头 needs the status sheet. */
  bodySheet?: BodySheet | null; statusSheet?: StatusSheet | null;
  /** The regex component's id: the floating app mounts once per id. */ regexId?: string;
  /**
   * 头像表 `{ 角色名: { 表情: 图片地址 } }`。只对正文美化生效：它写进页面里的一小段脚本，
   * 由运行时 core.js 的 sayLine 读取，给 `{名字:表情}「…」` 选头像。没有就整段不写。
   */
  avatars?: Record<string, Record<string, string>> | null;
}
export interface CompileResult { kind: SheetKind; form?: StatusForm; html: string; script?: string; issues: CompileIssue[] }
const DEFAULT_PRESET = 'sakura';

/** Whole-line comments and indentation go. Relies on the runtime convention: no code line begins with a bare * and no string literal spans lines, so trimming lines never rewrites a string. */
export function compress(js: string): string {
  return js.replace(/\r\n?/g, '\n').replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('*')).join('\n');
}

type Enriched = SheetItem & { kind?: VariableRow['type']; range?: [number, number]; values?: string[] };
function rowOf(table: VariableTable | null, path: string): VariableRow | null { return table ? matchVariablePath(table, path) : null; }
function enrichItem(item: SheetItem, table: VariableTable | null, missing: string[]): Enriched {
  const row = rowOf(table, item.path);
  if (table && !row && !missing.includes(item.path)) missing.push(item.path);
  return { ...item, ...(row ? { kind: row.type, ...(row.range ? { range: row.range } : {}), ...(row.values ? { values: row.values } : {}) } : {}) };
}
function enrichBlock(block: SheetBlock, table: VariableTable | null, missing: string[], invalid: string[]): SheetBlock {
  const check = (path: string) => { if (table && !rowOf(table, path) && !missing.includes(path)) missing.push(path); };
  switch (block.type) {
    case 'stats': case 'delta': return { ...block, items: block.items.map(item => enrichItem(item, table, missing)) };
    case 'bars': case 'gauge': {
      const items = block.items.map(item => enrichItem(item, table, missing));
      for (const item of items) if (table && rowOf(table, item.path) && !(item.kind === '数值' && item.range)) invalid.push(`${block.type} 里的 ${item.path} 不是有范围的数值，进度条和量表只能显示有范围的数值。`);
      return { ...block, items };
    }
    case 'tags': case 'text': { if (block.path) check(block.path); const row = block.path ? rowOf(table, block.path) : null; return row ? { ...block, kind: row.type } as SheetBlock : block; }
    case 'list': check(block.path); Object.values(block.fields ?? {}).forEach(check); return block;
    case 'timeline': check(block.path); if (block.time) check(block.time); if (block.note) check(block.note); return block;
    case 'relation': {
      check(block.path); Object.values(block.fields).forEach(check);
      if (!block.bar) return block;
      check(block.bar); const row = rowOf(table, block.bar);
      return row?.range ? { ...block, barRange: row.range } as SheetBlock : block;
    }
    case 'crisis': { check(block.path); const row = rowOf(table, block.path); return row ? { ...block, kind: row.type } as SheetBlock : block; }
    case 'fold': return { ...block, blocks: block.blocks.map(child => enrichBlock(child, table, missing, invalid)) };
    case 'custom': return block;
  }
}
/** The sheet with each bound path's row attached (kind, range, values), plus the paths the table does not have. */
export function enrichSheet<T extends AssemblySheet>(sheet: T, table: VariableTable | null): { sheet: T; missing: string[]; invalid: string[] } {
  const missing: string[] = []; const invalid: string[] = [];
  if (sheet.kind === '状态栏') return { sheet: { ...sheet, summary: sheet.summary.map(item => enrichItem(item, table, missing)), pages: sheet.pages.map(page => ({ ...page, blocks: page.blocks.map(block => enrichBlock(block, table, missing, invalid)) })) }, missing, invalid };
  if (sheet.kind === '创角页') { for (const path of sheetPaths(sheet)) if (table && !rowOf(table, path)) missing.push(path); return { sheet, missing, invalid }; }
  return { sheet, missing, invalid };
}

/** A JSON escape for `&` (backslash, u, 0026), built from char codes so this source carries no escape sequence. */
const JSON_AMP = String.fromCharCode(92) + 'u0026';
/** Data embedded in a script: `</` cannot close the tag, and no `&` is left for SillyTavern to decode once more as an entity. */
const escapeJson = (value: unknown): string => JSON.stringify(value).replace(/<\//g, '<\\/').replace(/&/g, JSON_AMP);
/** 装配单给的令牌（只有 custom 皮肤走这条路）。外链模式下这一块必须内联——皮肤文件里没有它。 */
function tokensCss(tokens: Record<string, string> | undefined): string {
  return `:root {\n${Object.entries(tokens ?? {}).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;
}
function skinCss(resources: FrontendResources, preset: string, tokens: Record<string, string> | undefined): string {
  if (preset === 'custom') return `${tokensCss(tokens)}${resources.skins.custom ?? ''}`;
  return resources.skins[preset] ?? resources.skins[DEFAULT_PRESET] ?? '';
}
/** 外链模式内联的那一小块：装配单令牌 + 装配单自定 CSS；皮肤文件本身走外链。 */
function sheetCss(sheet: AssemblySheet, preset: string, tokens: Record<string, string> | undefined): string {
  return `${preset === 'custom' ? tokensCss(tokens) : ''}${customCss(sheet)}`;
}
function customCss(sheet: AssemblySheet): string {
  const blocks: string[] = [];
  const walk = (block: SheetBlock) => { if (block.type === 'custom' && block.css) blocks.push(block.css); if (block.type === 'fold') block.blocks.forEach(walk); };
  if (sheet.kind === '状态栏') sheet.pages.forEach(page => page.blocks.forEach(walk));
  if (sheet.kind === '正文美化') sheet.custom.forEach(item => { if (item.css) blocks.push(item.css); });
  return blocks.join('\n');
}
function htmlDocument(options: { resources: FrontendResources; preset: string; form: string; css: string; sheetJson: string; app: string; source: boolean; avatars?: Record<string, Record<string, string>> | null; external?: FrontendExternal | null }): string {
  const { resources } = options;
  const external = options.external ?? null;
  return [
    '<!DOCTYPE html>',
    `<!-- Cardwright skeleton ${resources.version} · ${options.preset} · ${options.form}${external ? ' · 外链资产' : ''} -->`,
    ...(external ? [`<!-- Cardwright assets ${external.root} -->`] : []),
    '<html lang="zh-CN">',
    '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(external
      ? [
          `<link rel="stylesheet" href="${external.root}/base.css">`,
          `<link rel="stylesheet" href="${external.root}/skins/${options.preset}.css">`,
          ...(options.css.trim() ? [`<style>\n${options.css}\n</style>`] : []),
        ]
      : [`<style>\n${resources.base}\n${options.css}\n</style>`]),
    '</head>',
    '<body>',
    options.app,
    ...(options.source ? ['<textarea id="cw-source" hidden>$1</textarea>'] : []),
    `<script id="cw-sheet" type="application/json">${options.sheetJson}</script>`,
    // 头像表单独一个小脚本：只说数据，不含逻辑；没有配就整段省掉。
    ...(options.avatars && Object.keys(options.avatars).length
      ? [`<script id="cw-avatars" type="application/json">${escapeJson(options.avatars)}</script>`,
         `<script>window.__CW_AVATARS=${escapeJson(options.avatars)};</script>`]
      : []),
    ...(external
      ? [`<script src="${external.root}/runtime/core.js"></script>`, `<script src="${external.root}/runtime/host.js"></script>`]
      : [`<script>\n${compress(resources.core)}\n${compress(resources.host)}\n</script>`]),
    '<script>CardwrightHost.boot();</script>',
    '</body>', '</html>',
  ].join('\n');
}
/** Shipped runtime files only: a $-group or {{ in them is a build defect, so it throws; user content goes through fail() instead. */
function guard(text: string, what: string): void {
  if (/\$(?:\d|<)/.test(text)) throw new Error(`${what}里有会被酒馆正则替换掉的 $ 写法，运行时不能这样写。`);
  if (text.includes('{{')) throw new Error(`${what}里有 {{，酒馆会把它当宏替换掉。`);
}

export function compileSheet(sheet: AssemblySheet, context: CompileContext): CompileResult {
  const issues: CompileIssue[] = [];
  const kind = sheet.kind;
  const form = sheet.kind === '状态栏' ? sheet.form : undefined;
  const fail = (message: string): CompileResult => ({ kind, ...(form ? { form } : {}), html: '', issues: [...issues, { code: 'sheet-invalid', message }] });
  if (!context.resources) return fail('没有前端骨架资源，无法编译装配单。');
  const preset = sheet.preset ?? context.preset ?? DEFAULT_PRESET;
  if (preset === 'custom' && !sheet.tokens) return fail('本卡的预设是题材自定，装配单里要写全 令牌。');
  if (!context.resources.skins[preset]) issues.push({ code: 'sheet-invalid', message: `前端骨架里没有预设 ${preset} 的皮肤文件，请重新安装 Cardwright。` });
  if (!context.table) issues.push({ code: 'variable-table-missing', message: `${sheetLabel(sheet)}没有变量表可以核对读写路径；先在脚本 · 变量结构写变量表。` });
  const enriched = enrichSheet(sheet, context.table);
  for (const path of enriched.missing) issues.push({ code: 'variable-binding', path, message: sheet.kind === '创角页' ? `创角页写的 ${path} 不在变量表里，写入会被 Zod 丢掉。` : `${sheet.kind}读的 ${path} 不在变量表里，会显示「未知」。` });
  for (const message of enriched.invalid) issues.push({ code: 'sheet-invalid', message });
  const withCard = { ...enriched.sheet, cardName: context.cardName };
  const external = context.external ?? null;
  const css = external ? sheetCss(sheet, preset, sheet.tokens) : `${skinCss(context.resources, preset, sheet.tokens)}\n${customCss(sheet)}`;
  const sheetJson = escapeJson(withCard);
  if (/\$(?:\d|<)/.test(sheetJson)) return fail('装配单里有 $ 后面跟数字或 <，酒馆正则会把它替换掉。');
  if (sheetJson.includes('{{')) return fail('装配单里有 {{，酒馆会把它当宏替换掉。');
  if (/\$(?:\d|<)/.test(css)) return fail('样式里有 $ 后面跟数字或 <，酒馆正则会把它替换掉。');
  if (css.includes('{{')) return fail('样式里有 {{，酒馆会把它当宏替换掉。');
  // 外链模式下 runtime 不在文档里，guard 也就无从谈起；它仍然在仓库里由 build 检查。
  if (!external) { guard(context.resources.core, '运行时 core.js'); guard(context.resources.host, '运行时 host.js'); }

  if (sheet.kind === '状态栏') {
    if (sheet.form === 'header') {
      if (!context.bodySheet?.statusHead) issues.push({ code: 'sheet-invalid', message: 'header 形态的状态栏要嵌进正文美化：本卡需要一份开了 状态头: true 的正文美化装配单。' });
      return { kind, form, html: '', issues };
    }
    if (sheet.form === 'floating') {
      // 悬浮应用是一段酒馆助手脚本，不是 iframe 文档：它照旧内联（外链要改成 import URL，是另一套机制，先不动）。
      guard(context.resources.floating, '运行时 floating.js');
      const script = [
        `// Cardwright skeleton ${context.resources.version} · ${preset} · floating`,
        '(function () {',
        // Both literals go through escapeJson: the script runs inside a <script> element (酒馆助手's, and the preview's stand-in page).
        `const SHEET = ${sheetJson};`,
        `const CSS = ${escapeJson(`${context.resources.base}\n${css}`)};`,
        compress(context.resources.core), compress(context.resources.host), compress(context.resources.floating),
        "const hostDocument = (() => { try { return window.parent && window.parent !== window ? window.parent.document : document; } catch { return document; } })();",
        `const app = CardwrightFloating.mount({ hostDocument, id: '${(context.regexId ?? 'status').replace(/[^\w-]/g, '')}', sheet: SHEET, css: CSS });`,
        '(async () => { const helpers = CardwrightHost.helpers; await helpers.waitMvu(2500); app.draw(helpers.readData());',
        "  if (typeof Mvu !== 'undefined' && Mvu.events && typeof eventOn === 'function') eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, after => app.draw((after && after.stat_data) || helpers.readData()));",
        "  if (typeof tavern_events !== 'undefined' && typeof eventOn === 'function') eventOn(tavern_events.CHAT_CHANGED, () => app.draw(helpers.readData()));",
        '})();',
        '})();',
      ].join('\n');
      return { kind, form, html: '', script, issues };
    }
    return { kind, form, issues, html: htmlDocument({ resources: context.resources, preset, form: 'placeholder', css, sheetJson, app: '<main id="cw-app" class="cw-app is-status is-placeholder"></main>', source: false, external }) };
  }
  if (sheet.kind === '正文美化') {
    let json = sheetJson;
    let app = '<main id="cw-app" class="cw-app is-body"></main>';
    if (sheet.statusHead) {
      const status = context.statusSheet && context.statusSheet.form === 'header' ? context.statusSheet : null;
      if (!status) issues.push({ code: 'sheet-invalid', message: '正文美化开了 状态头，但本卡没有 形态: header 的状态栏装配单。' });
      else {
        // Embedded only: the status sheet reports its own missing paths when it compiles, on its own component.
        const head = enrichSheet(status, context.table).sheet;
        json = escapeJson({ ...withCard, statusHead: { ...head, cardName: context.cardName } });
        app = `<div id="cw-status-head" class="cw-status-head"></div>\n${app}`;
      }
    }
    return { kind, issues, html: htmlDocument({ resources: context.resources, preset, form: 'body', css, sheetJson: json, app, source: true, avatars: context.avatars ?? null, external }) };
  }
  return { kind, issues, html: htmlDocument({ resources: context.resources, preset, form: 'start', css, sheetJson, app: '<main id="cw-app" class="cw-app is-start"></main>', source: true, external }) };
}
