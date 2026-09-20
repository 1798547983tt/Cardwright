/** How a tool call reads in the conversation: one line each, opened for the details (§6.2). */
const HEAD_LINES = 40;
const HEAD_CHARS = 4_000;
const SUMMARY_CHARS = 160;

/** Long output keeps its head; the rest waits behind 显示全部. */
export function foldOutput(text: string, limits: { lines?: number; chars?: number } = {}): { head: string; hiddenLines: number; folded: boolean } {
  const maxLines = limits.lines ?? HEAD_LINES;
  const maxChars = limits.chars ?? HEAD_CHARS;
  const lines = text.split('\n');
  if (lines.length > maxLines) return { head: lines.slice(0, maxLines).join('\n'), hiddenLines: lines.length - maxLines, folded: true };
  if (text.length > maxChars) return { head: text.slice(0, maxChars), hiddenLines: 0, folded: true };
  return { head: text, hiddenLines: 0, folded: false };
}

/** The one line beside the tool's name: the file, the command, the query, else the arguments. */
export function toolSummary(tool: { name: string; args: Record<string, unknown> }, _t: (en: string, zh: string) => string): string {
  const first = tool.args.query ?? tool.args.path ?? tool.args.command ?? tool.args.description ?? tool.args.prompt;
  const text = typeof first === 'string' && first.trim() ? first : Object.keys(tool.args).length ? JSON.stringify(tool.args) : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS);
}
