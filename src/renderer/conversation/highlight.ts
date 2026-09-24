/**
 * Syntax highlighting for code blocks: highlight.js 11 core with the languages a card studio and a coding agent
 * actually write. The colours come from CSS variables, one palette per skin (conversation.css).
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({ bash, css, diff, javascript, json, markdown, plaintext, python, typescript, xml, yaml })) hljs.registerLanguage(name, language);
hljs.registerAliases(['shell', 'console', 'terminal'], { languageName: 'bash' });

/** Past this size a block is shown as plain text: highlighting it would hold up the whole conversation. */
export const HIGHLIGHT_LIMIT = 50_000;

/** The block as highlighted HTML (highlight.js escapes the code itself), or null when it stays plain text. */
export function highlightCode(code: string, language: string | undefined): string | null {
  if (!language || code.length > HIGHLIGHT_LIMIT) return null;
  const name = language.toLowerCase();
  if (!hljs.getLanguage(name)) return null;
  try { return hljs.highlight(code, { language: name, ignoreIllegals: true }).value; } catch { return null; }
}
