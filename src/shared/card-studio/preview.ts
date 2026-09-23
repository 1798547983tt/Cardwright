/**
 * The card studio's local preview: what SillyTavern 1.19.0 shows for the latest AI reply, reproduced from its own code.
 * Regex (public/scripts/extensions/regex/engine.js): the scripts that change the message run when it arrives; the
 * display-only ones run at every render, here at depth 0. Formatting (script.js messageFormatting): quotes are wrapped
 * in <q>, then Markdown. 酒馆助手 4.9.5 (src/util/is_frontend.ts) turns a code block holding `html>`, `<head>` or
 * `<body` into an iframe. Only the card's own regex take part: the player's global and preset regex are not known here.
 */
import { findFences, normalizeNewlines } from './fences.ts';

export interface PreviewRegex {
  scriptName?: string; findRegex?: string; replaceString?: string; trimStrings?: string[]; placement?: number[];
  disabled?: boolean; markdownOnly?: boolean; promptOnly?: boolean; minDepth?: number | null; maxDepth?: number | null; substituteRegex?: number;
}
export interface PreviewMacros { char: string; user: string }
/** What one regex did to the reply. `stage` is null when the regex never touches a displayed AI reply. */
export interface RegexStep { name: string; outcome: 'applied' | 'no-match' | 'skipped'; stage: 'stored' | 'display' | null; reason?: string }
/** `frontend`: a document 酒馆助手 renders in an iframe of its own; `html`: the message text itself. */
export interface PreviewSegment { kind: 'html' | 'frontend'; html: string }
export interface PreviewRender { text: string; steps: RegexStep[]; segments: PreviewSegment[]; external: string[] }

const AI_OUTPUT = 2;

/** SillyTavern's regexFromString (utils.js): `/pattern/flags`, or the whole text as a pattern. */
export function regexFromString(input: string): RegExp | undefined {
  try {
    const match = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
    if (!match) return undefined;
    if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) return RegExp(input);
    return new RegExp(match[2], match[3]);
  } catch {
    return undefined;
  }
}

const escapeRegex = (text: string): string => text.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()-]/g, char => `\\${char}`);

/** The two macros a preview can know. Other macros stay as they are written. */
function substituteMacros(text: string, macros: PreviewMacros): string {
  return text.replace(/\{\{char\}\}/gi, () => macros.char).replace(/\{\{user\}\}/gi, () => macros.user);
}

function findSource(script: PreviewRegex, macros: PreviewMacros): string {
  const find = String(script.findRegex ?? '');
  const mode = Number(script.substituteRegex);
  if (mode === 1) return substituteMacros(find, macros);
  if (mode === 2) return substituteMacros(find, { char: escapeRegex(macros.char), user: escapeRegex(macros.user) });
  return find;
}

/** SillyTavern's runRegexScript: {{match}} is the whole match, $n and $<name> are groups, trim strings leave the groups. */
export function runRegexScript(script: PreviewRegex, text: string, macros: PreviewMacros): string {
  if (!script || script.disabled || !script.findRegex || !text) return text;
  const find = regexFromString(findSource(script, macros));
  if (!find) return text;
  const trims = Array.isArray(script.trimStrings) ? script.trimStrings.map(String) : [];
  return text.replace(find, (...args: unknown[]) => {
    const replacement = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    const withGroups = replacement.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_whole: string, num?: string, groupName?: string) => {
      let value: unknown;
      if (num) value = args[Number(num)];
      else if (groupName) {
        const groups = args[args.length - 1];
        value = groups && typeof groups === 'object' ? (groups as Record<string, unknown>)[groupName] : undefined;
      }
      if (!value) return '';
      return trims.reduce((result, trim) => result.replaceAll(substituteMacros(trim, macros), ''), String(value));
    });
    return substituteMacros(withGroups, macros);
  });
}

function hits(script: PreviewRegex, text: string, macros: PreviewMacros): boolean {
  const find = regexFromString(findSource(script, macros));
  return !!find && new RegExp(find.source, find.flags.replace('g', '')).test(text);
}

/**
 * The regex of SillyTavern's getRegexedString for the latest AI reply: first the ones that change the stored message
 * (neither 只改显示 nor 只改提示词), then the display-only ones at `depth`, each pass in card order.
 */
export function displayRegex(text: string, scripts: PreviewRegex[], macros: PreviewMacros, depth = 0): { text: string; steps: RegexStep[] } {
  const steps: RegexStep[] = scripts.map(script => ({ name: String(script.scriptName || '未命名正则'), outcome: 'skipped', stage: null }));
  const stageOf = (script: PreviewRegex, index: number): 'stored' | 'display' | null => {
    if (script.disabled) { steps[index].reason = '已停用。'; return null; }
    if (!Array.isArray(script.placement) || !script.placement.map(Number).includes(AI_OUTPUT)) { steps[index].reason = '不作用于 AI 输出（作用范围里没有「AI 输出」）。'; return null; }
    if (script.markdownOnly) return 'display';
    if (script.promptOnly) { steps[index].reason = '只改提示词，不影响显示。'; return null; }
    return 'stored';
  };
  const stages = scripts.map(stageOf);
  let value = text;
  for (const stage of ['stored', 'display'] as const) {
    scripts.forEach((script, index) => {
      if (stages[index] !== stage) return;
      const step = steps[index];
      step.stage = stage;
      if (stage === 'display') {
        const min = script.minDepth; const max = script.maxDepth;
        if (typeof min === 'number' && min >= -1 && depth < min) { step.reason = `最新一楼的深度是 ${depth}，它从深度 ${min} 才开始生效。`; return; }
        if (typeof max === 'number' && max >= 0 && depth > max) { step.reason = `最新一楼的深度是 ${depth}，超出了它的最大深度 ${max}。`; return; }
      }
      if (!regexFromString(findSource(script, macros))) { step.reason = '查找表达式无法编译，酒馆会跳过它。'; return; }
      if (!hits(script, value, macros)) { step.outcome = 'no-match'; step.reason = '没有命中。'; return; }
      value = runRegexScript(script, value, macros);
      step.outcome = 'applied';
    });
  }
  return { text: value, steps };
}

const KEEP_QUOTES_IN_TAGS = String.fromCharCode(0xfffe);

/** SillyTavern's quote wrapping in messageFormatting: quoted text becomes <q>, except in tags, <style> and code. */
export function wrapQuotes(text: string): string {
  const guarded = text.replace(/<([^>]+)>/g, (_whole, contents: string) => `<${contents.replace(/"/g, KEEP_QUOTES_IN_TAGS)}>`);
  const wrapped = guarded.replace(
    /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim,
    (match: string, ...quoted: Array<string | undefined>) => {
      const found = quoted.slice(0, 6).find(Boolean);
      return found ? `<q>${found}</q>` : match;
    },
  );
  return wrapped.split(KEEP_QUOTES_IN_TAGS).join('"');
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Block-level tags: a line that starts with one of them starts raw HTML, as in Markdown. */
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'audio', 'blockquote', 'body', 'canvas', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'meta', 'nav', 'noscript', 'ol', 'p', 'pre', 'script', 'section', 'style', 'summary', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul', 'video']);

/** The last line of the HTML block that starts at `start`: where its tag closes, else the next blank line. */
function blockEnd(lines: string[], start: number, tag: string): number {
  const opens = new RegExp(`<${tag}(?=[\\s>])(?:[^>]*[^/>])?>|<${tag}>`, 'gi');
  const closes = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    depth += (lines[index].match(opens)?.length ?? 0) - (lines[index].match(closes)?.length ?? 0);
    if (depth <= 0) return index;
  }
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim()) end++;
  return end;
}

const emphasis = (line: string): string => line.split(/(<[^>]*>)/).map((part, index) => index % 2 ? part
  : part.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>')).join('');

/** Enough of SillyTavern's Markdown for a preview: raw HTML blocks, paragraphs, a line break per newline, bold and italics. */
function markdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(emphasis).join('<br>')}</p>`); paragraph = []; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const open = /^ {0,3}<\/?([A-Za-z][\w-]*)(?=[\s/>]|$)/.exec(line);
    if (open && BLOCK_TAGS.has(open[1].toLowerCase())) {
      flush();
      const end = line.trimStart().startsWith('</') ? index : blockEnd(lines, index, open[1].toLowerCase());
      out.push(lines.slice(index, end + 1).join('\n'));
      index = end;
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return out.join('\n');
}

/** The message text as SillyTavern formats it: quotes, then Markdown, with code blocks kept as code. */
function formatMessage(text: string): string {
  const quoted = wrapQuotes(text);
  const parts: string[] = [];
  let cursor = 0;
  for (const fence of findFences(quoted)) {
    parts.push(markdown(quoted.slice(cursor, fence.start)), `<pre><code>${escapeHtml(fence.content)}</code></pre>`);
    cursor = fence.end;
  }
  parts.push(markdown(quoted.slice(cursor)));
  return parts.filter(Boolean).join('\n');
}

/** 酒馆助手's isFrontend. */
export const isFrontend = (content: string): boolean => ['html>', '<head>', '<body'].some(tag => content.includes(tag));

/** The hosts a piece of HTML would reach for; the preview loads none of them. */
export function externalHosts(html: string): string[] {
  const hosts = new Set<string>();
  for (const match of html.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) hosts.add(match[1].toLowerCase());
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']?\/\/([a-z0-9.-]+)|url\(\s*["']?\/\/([a-z0-9.-]+)/gi)) hosts.add((match[1] ?? match[2]).toLowerCase());
  return [...hosts].sort();
}

/** The latest AI reply as SillyTavern would show it: regex, then the message text and 酒馆助手's documents in order. */
export function renderReply(text: string, scripts: PreviewRegex[], macros: PreviewMacros): PreviewRender {
  const shown = displayRegex(normalizeNewlines(text), scripts, macros);
  const segments: PreviewSegment[] = [];
  const pushText = (part: string) => { if (part.trim()) segments.push({ kind: 'html', html: formatMessage(part) }); };
  let cursor = 0;
  for (const fence of findFences(shown.text)) {
    if (!isFrontend(fence.content)) continue;
    pushText(shown.text.slice(cursor, fence.start));
    segments.push({ kind: 'frontend', html: fence.content });
    cursor = fence.end;
  }
  pushText(shown.text.slice(cursor));
  return { text: shown.text, steps: shown.steps, segments, external: externalHosts(segments.map(segment => segment.html).join('\n')) };
}

/** The <UpdateVariable> block of a sample, finished and as it looks while it is still streaming. */
export function updateBlocks(text: string): { done: string; streaming: string } | null {
  const match = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i.exec(normalizeNewlines(text));
  if (!match) return null;
  return { done: match[0], streaming: match[0].replace(/\s*<\/UpdateVariable>$/i, '') };
}

/** Posts the document's height, its script errors and what the policy blocked to the studio. */
const REPORTER = [
  '(() => {',
  "  const post = data => parent.postMessage(Object.assign({ cardwrightPreview: 1 }, data), '*');",
  "  addEventListener('error', event => post({ error: String(event.message || '脚本出错').slice(0, 300) }));",
  "  addEventListener('unhandledrejection', event => post({ error: String((event.reason && event.reason.message) || event.reason || '脚本出错').slice(0, 300) }));",
  "  addEventListener('securitypolicyviolation', event => post({ blocked: /^https?:/.test(event.blockedURI) ? 'network' : event.effectiveDirective.startsWith('script') ? 'script' : 'other' }));",
  // The body, as 酒馆助手 measures it: the root element is never shorter than the frame, so it could only grow.
  '  let last = 0;',
  '  const measure = () => { const height = document.body ? Math.ceil(document.body.scrollHeight) : 0; if (height > 0 && Math.abs(height - last) > 1) { last = height; post({ height }); } };',
  "  addEventListener('DOMContentLoaded', () => { measure(); new ResizeObserver(measure).observe(document.body); });",
  "  addEventListener('load', measure);",
  '})();',
].join('\n');

/**
 * The iframes 酒馆助手 makes share the page's storage, and card scripts keep settings there (Re0 keeps its reading
 * settings). A sandboxed preview has no storage of its own, so it gets one in memory that lasts for this view.
 */
const STORAGE = [
  '(() => {',
  "  for (const name of ['localStorage', 'sessionStorage']) {",
  "    try { window[name].getItem('cardwright'); continue; } catch {}",
  '    const store = new Map();',
  '    const storage = {',
  '      get length() { return store.size; },',
  '      key: index => [...store.keys()][index] ?? null,',
  '      getItem: key => store.has(String(key)) ? store.get(String(key)) : null,',
  '      setItem: (key, value) => { store.set(String(key), String(value)); },',
  '      removeItem: key => { store.delete(String(key)); },',
  '      clear: () => { store.clear(); },',
  '    };',
  '    Object.defineProperty(window, name, { value: storage, configurable: true });',
  '  }',
  '})();',
].join('\n');

/**
 * SillyTavern's sanitizing of message text (1.19.0, knowledge base 30 §5): DOMPurify drops scripts and what embeds or
 * navigates, unwraps tags it does not know, strips event handlers and prefixes every class with custom- (fa-, note- and
 * monospace are spared); decodeStyleTags scopes each selector of the message's own <style> to `.mes_text ` and prefixes
 * its class selectors the same way, so `:root` and `body` rules match nothing. The message waits in an inert template
 * until this has run, so its styles never apply unsanitized.
 */
const SANITIZER = String.raw`(() => {
  const source = document.getElementById('cardwright-message');
  const box = document.querySelector('.mes_text');
  if (!source || !box) return;
  const fragment = document.importNode(source.content, true);
  source.remove();
  const drop = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'TITLE', 'NOSCRIPT']);
  const spared = name => name.startsWith('fa-') || name.startsWith('note-') || name === 'monospace';
  const topLevel = text => { const parts = []; let depth = 0, start = 0; for (let index = 0; index < text.length; index++) { const char = text[index]; if (char === '(' || char === '[') depth++; else if (char === ')' || char === ']') depth--; else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; } } parts.push(text.slice(start)); return parts; };
  const scope = selector => '.mes_text ' + selector.trim().split(' ').map(part => part.startsWith('.') ? '.custom-' + part.slice(1) : part).join(' ');
  const rewrite = rules => [...rules].map(rule => {
    if (rule instanceof CSSStyleRule) return topLevel(rule.selectorText).map(scope).join(', ') + ' { ' + rule.style.cssText + ' }';
    if (rule instanceof CSSMediaRule) return '@media ' + rule.media.mediaText + ' { ' + rewrite(rule.cssRules) + ' }';
    if (rule instanceof CSSSupportsRule) return '@supports ' + rule.conditionText + ' { ' + rewrite(rule.cssRules) + ' }';
    return rule.cssText;
  }).join('\n');
  const clean = node => {
    for (const child of [...node.children]) {
      if (drop.has(child.tagName)) { child.remove(); continue; }
      if (child.tagName === 'STYLE') {
        let css = '';
        try { const sheet = new CSSStyleSheet(); sheet.replaceSync(child.textContent || ''); css = rewrite(sheet.cssRules); } catch {}
        child.textContent = css;
        continue;
      }
      clean(child);
      for (const attribute of [...child.attributes]) if (/^on/i.test(attribute.name)) child.removeAttribute(attribute.name);
      if (child.hasAttribute('class')) child.setAttribute('class', (child.getAttribute('class') || '').split(/\s+/).filter(Boolean).map(name => spared(name) ? name : 'custom-' + name).join(' '));
      if (child instanceof HTMLUnknownElement || child.tagName.includes('-')) child.replaceWith(...child.childNodes);
    }
  };
  clean(fragment);
  box.append(fragment);
})();`;

/** SillyTavern's default look for message text: its body, italic and quote colours. */
const MESSAGE_STYLE = [
  ':root { color-scheme: dark; }',
  'html, body { margin: 0; }',
  'body { padding: 12px 16px; background: #171717; color: rgb(220, 220, 210); font: 15px/1.6 "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; overflow-wrap: anywhere; }',
  '.mes_text p { margin: 0 0 .7em; }',
  '.mes_text i, .mes_text em { color: rgb(145, 145, 145); }',
  '.mes_text q { color: rgb(225, 138, 36); }',
  '.mes_text q::before, .mes_text q::after { content: ""; }',
  '.mes_text q i, .mes_text q em { color: inherit; }',
  '.mes_text pre { white-space: pre-wrap; padding: 8px 10px; background: rgba(0, 0, 0, .35); border-radius: 4px; }',
  '.mes_text code { font-family: Consolas, "Cascadia Mono", monospace; font-size: .92em; }',
  '.mes_text img, .mes_text video { max-width: 100%; }',
].join('\n');

const BASE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

/**
 * One preview document and the policy it is served with. Nothing reaches the network. A frontend document runs its
 * scripts, as in the iframe 酒馆助手 gives it (with the same base style); the message text runs none of its own, since
 * SillyTavern strips them, and only the reporter carries the nonce.
 */
export function previewDocument(segment: PreviewSegment, nonce: string): { html: string; csp: string } {
  if (segment.kind === 'frontend') {
    return {
      csp: `${BASE_POLICY}; script-src 'unsafe-inline' 'unsafe-eval'`,
      html: [
        '<!DOCTYPE html>', '<html>', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}</style>',
        `<script>${STORAGE}</script>`, `<script>${REPORTER}</script>`, '</head>', '<body>', segment.html, '</body>', '</html>', '',
      ].join('\n'),
    };
  }
  return {
    csp: `${BASE_POLICY}; script-src 'nonce-${nonce}'`,
    html: [
      '<!DOCTYPE html>', '<html>', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<style>${MESSAGE_STYLE}</style>`, `<script nonce="${nonce}">${REPORTER}</script>`, '</head>', '<body>',
      // A closing template tag in the message would end the template early; it is split so the parser keeps it as text.
      '<div class="mes_text"></div>', `<template id="cardwright-message">${segment.html.replace(/<\/template/gi, '&lt;/template')}</template>`,
      `<script nonce="${nonce}">${SANITIZER}</script>`, '</body>', '</html>', '',
    ].join('\n'),
  };
}
