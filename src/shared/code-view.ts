/** Just enough colour for the file viewer in the side panel: comments, strings, numbers and keywords. */
export type CodeLanguage = 'ts' | 'json' | 'markdown' | 'shell' | 'text';
export interface CodePart { kind: 'text' | 'comment' | 'string' | 'number' | 'keyword'; text: string }

const EXTENSIONS: Record<string, CodeLanguage> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts', css: 'ts', scss: 'ts',
  json: 'json', md: 'markdown', markdown: 'markdown', ps1: 'shell', sh: 'shell', bash: 'shell', yml: 'shell', yaml: 'shell', toml: 'shell', ini: 'shell',
};
const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'from', 'as', 'new', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'typeof', 'interface', 'type', 'enum', 'default', 'switch', 'case', 'break', 'continue', 'this', 'true', 'false', 'null', 'undefined']);

export function languageOf(path: string): CodeLanguage {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && EXTENSIONS[extension]) || 'text';
}

/** One line, split into parts that always join back into the original text. */
export function tokenizeLine(line: string, language: CodeLanguage): CodePart[] {
  if (language === 'text' || language === 'markdown') return [{ kind: 'text', text: line }];
  const parts: CodePart[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { parts.push(...words(buffer, language)); buffer = ''; } };
  for (let index = 0; index < line.length; index++) {
    const rest = line.slice(index);
    const comment = language === 'shell' ? /^#.*/.exec(rest) : /^(\/\/.*|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (comment) { flush(); parts.push({ kind: 'comment', text: comment[0] }); index += comment[0].length - 1; continue; }
    const string = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(rest);
    if (string) { flush(); parts.push({ kind: 'string', text: string[0] }); index += string[0].length - 1; continue; }
    buffer += line[index];
  }
  flush();
  return parts.length ? parts : [{ kind: 'text', text: line }];
}

/** Keywords and numbers inside a run of ordinary code. */
function words(text: string, language: CodeLanguage): CodePart[] {
  const parts: CodePart[] = [];
  for (const piece of text.split(/([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/g)) {
    if (!piece) continue;
    if (language !== 'json' && KEYWORDS.has(piece)) parts.push({ kind: 'keyword', text: piece });
    else if (/^\d+(?:\.\d+)?$/.test(piece)) parts.push({ kind: 'number', text: piece });
    else parts.push({ kind: 'text', text: piece });
  }
  return parts;
}
