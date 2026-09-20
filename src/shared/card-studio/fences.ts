/** Fenced code blocks in Markdown replies. Unclosed fences are ignored: they are still streaming or malformed. */
export interface Fence { start: number; end: number; info: string; content: string }

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Expects text with `\n` newlines; offsets refer to that text. */
export function findFences(text: string): Fence[] {
  const fences: Fence[] = [];
  let open: { start: number; marker: string; info: string; contentStart: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (match && !(match[1].startsWith('`') && match[2].includes('`'))) open = { start: lineStart, marker: match[1], info: match[2].trim(), contentStart: Math.min(offset, text.length) };
    } else if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim()) {
      const content = open.contentStart <= lineStart ? text.slice(open.contentStart, lineStart).replace(/\n$/, '') : '';
      fences.push({ start: open.start, end: Math.min(offset, text.length), info: open.info, content });
      open = null;
    }
  }
  return fences;
}

export function fenceKind(fence: Fence): string {
  return fence.info.split(/\s+/)[0] ?? '';
}
