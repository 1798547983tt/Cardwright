/**
 * Tool rows (handoff §5.5 ③): consecutive calls of the same tool fold into one group row, 「读取 5 个文件」, which opens
 * to the calls themselves.
 */

/** What an entry of a work log is to the grouping: a call of a tool; `quiet`, which a group carries along when it sits
 *  between two calls (a thinking record between two reads); or `visible` text, which ends a group. */
export type RunRole = { tool: string } | 'quiet' | 'visible';
export type ToolRun<T> = { kind: 'single'; item: T } | { kind: 'group'; name: string; items: T[]; calls: T[] };

export function groupToolRuns<T>(items: readonly T[], role: (item: T) => RunRole): ToolRun<T>[] {
  const runs: ToolRun<T>[] = [];
  for (let index = 0; index < items.length;) {
    const first = role(items[index]);
    if (typeof first === 'object') {
      const calls = [items[index]];
      let end = index;
      for (let next = index + 1; next < items.length; next++) {
        const kind = role(items[next]);
        if (typeof kind === 'object' && kind.tool === first.tool) { calls.push(items[next]); end = next; }
        else if (kind !== 'quiet') break;
      }
      if (calls.length > 1) {
        runs.push({ kind: 'group', name: first.tool, items: items.slice(index, end + 1), calls });
        index = end + 1;
        continue;
      }
    }
    runs.push({ kind: 'single', item: items[index] });
    index++;
  }
  return runs;
}

/** The group row's name: what the calls did together. */
export function toolGroupLabel(name: string, count: number, t: (english: string, chinese: string) => string): string {
  switch (name) {
    case 'read': return t(`Read ${count} files`, `读取 ${count} 个文件`);
    case 'write': return t(`Wrote ${count} files`, `写入 ${count} 个文件`);
    case 'edit': return t(`Edited ${count} files`, `修改 ${count} 个文件`);
    case 'ls': return t(`Listed ${count} folders`, `查看 ${count} 个目录`);
    case 'grep': case 'find': return t(`Searched ${count} times`, `搜索 ${count} 次`);
    case 'bash': case 'powershell': case 'host_command': return t(`Ran ${count} commands`, `运行 ${count} 条命令`);
    case 'web_search': return t(`Searched the web ${count} times`, `联网搜索 ${count} 次`);
    case 'fetch_content': return t(`Read ${count} pages`, `读取 ${count} 个网页`);
    case 'card_search_sources': return t(`Searched the sources ${count} times`, `检索资料 ${count} 次`);
    default: return t(`${name} · ${count} calls`, `${name} · ${count} 次调用`);
  }
}
