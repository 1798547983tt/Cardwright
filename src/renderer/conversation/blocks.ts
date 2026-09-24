/**
 * Incremental Markdown (handoff §5.5 ⑥): a message is cut into its top-level blocks, and each block renders and is
 * memoized on its own text, so while a reply streams only the growing tail is parsed again.
 */
export interface MarkdownBlock {
  text: string;
  /** The text ends inside a code fence that has not closed yet: a code block still being written. */
  open?: boolean;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// Link references and footnotes resolve across the whole message, so a message that defines any renders as one block.
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * Splits at blank lines, only where the next line starts a new top-level block: fenced code (blank lines and all) and
 * pipe tables stay whole, an indented line after a blank one stays with its list item or code, and the items of a
 * loose list stay one list. When in doubt it does not split; one larger block renders the same, only less lazily.
 */
export function splitMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const whole = DEFINITION.test(source);
  const blocks: MarkdownBlock[] = [];
  let current: string[] = [];
  let fence: { mark: string; size: number } | null = null;
  let afterBlank = false;
  let inList = false;
  const flush = (open: boolean) => {
    while (current.length && !current[current.length - 1].trim()) current.pop();
    if (current.length) blocks.push(open ? { text: current.join('\n'), open: true } : { text: current.join('\n') });
    current = [];
  };
  for (const line of lines) {
    if (fence) {
      current.push(line);
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence.mark && close[1].length >= fence.size && !close[2].trim()) fence = null;
      continue;
    }
    if (!line.trim()) {
      if (current.length) { current.push(line); afterBlank = true; }
      continue;
    }
    if (afterBlank && !whole && /^\S/.test(line) && !(inList && LIST_ITEM.test(line))) flush(false);
    afterBlank = false;
    current.push(line);
    if (/^\S/.test(line)) inList = LIST_ITEM.test(line);
    const open = FENCE.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { mark: open[1][0], size: open[1].length };
  }
  flush(fence !== null);
  return blocks;
}
