/** `路径:行号` in a reply opens that file in the side panel at that line (§6.3). */
export interface FileRef { path: string; line: number; endLine?: number; start: number; end: number }

// A path with at least one separator, then :line or :line-line. A scheme (http://) or a bare time (10:30) is not one.
const PATTERN = /(?<![\w.:\/\\-])((?:[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+):(\d{1,6})(?:-(\d{1,6}))?(?![\w:])/g;

export function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const [whole, path, line, endLine] = match;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(Math.max(0, match.index - 8), match.index + whole.length))) continue;
    if (!/[\\/]/.test(path)) continue;
    refs.push({ path, line: Number(line), ...(endLine ? { endLine: Number(endLine) } : {}), start: match.index, end: match.index + whole.length });
  }
  return refs;
}
