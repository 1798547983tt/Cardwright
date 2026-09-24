import { findBoard } from './boards.ts';
import { componentName } from './components.ts';
import { stripMarkers } from './markers.ts';
import { projectRelativePath } from './view.ts';
import type { CardChange, CardCheckFinding, CardCheckReport, CardDispatch, CardRun, CardRunPause, CardRunScope } from './types.ts';
import type { ChatMessage, Task, TaskStatus, ToolCall } from '../types.ts';

/** The boards one-click making covers; planning, material and assembly are never run for the user. */
export const RUN_BOARDS = ['lore', 'script', 'regex', 'greet'] as const;
/** The same tool failing this many times in a row pauses the run. */
export const TOOL_FAILURE_LIMIT = 3;
/** What 继续 sends when the last round broke off or went nowhere and the user wrote nothing meanwhile. */
export const CONTINUE_TEXT = '继续做这条派单，做完按交付格式回复。';
/** Why a run paused, as the progress bar and the notification name it. */
export const RUN_PAUSE_LABELS: Record<CardRunPause, { en: string; zh: string }> = {
  question: { en: 'The section AI asked questions', zh: '分区 AI 提了问题' },
  refusal: { en: 'The section AI would not start', zh: '分区 AI 拒绝开工' },
  'tool-failures': { en: 'A tool kept failing', zh: '同一个工具连续失败' },
  'check-errors': { en: 'The assembly check still has errors', zh: '拼装检查仍有错误' },
  'model-error': { en: 'The model or the network failed', zh: '模型或网络出错' },
  approval: { en: 'A tool needs your approval', zh: '需要你批准工具' },
  interjection: { en: 'You wrote in the conversation', zh: '你在对话里发了消息' },
  user: { en: 'Paused as you asked', zh: '已按你的要求暂停' },
  restart: { en: 'The app restarted', zh: '应用重启过' },
};
/** A run that still has work: it holds its conversations and the card waits for it. */
export function runIsOpen(run: Pick<CardRun, 'status'> | undefined): boolean {
  return !!run && (run.status === 'running' || run.status === 'pausing' || run.status === 'paused');
}

/** Whether an open run holds this conversation: the one it works in, the one handing off, or its conversation in a section. */
export function runOwns(run: Pick<CardRun, 'status' | 'current' | 'handoff' | 'conversations'> | undefined, taskId: string): boolean {
  if (!run || !runIsOpen(run)) return false;
  return run.current?.taskId === taskId || run.handoff?.fromTaskId === taskId || Object.values(run.conversations ?? {}).includes(taskId);
}

/**
 * The dispatches a run will send: still unsent, aimed at a section of the chosen boards, in planning order. A section no
 * board has is skipped, and so are 改动派单: they belong to their 改动单's own run (`changeQueue`).
 */
export function runQueue(dispatches: readonly CardDispatch[], scope: CardRunScope): string[] {
  const boards: readonly string[] = scope === 'all' ? RUN_BOARDS : [scope];
  return dispatches.filter(item => {
    const board = item.status === 'todo' && item.sectionId && !item.changeId ? findBoard(item.sectionId) : undefined;
    return !!board && boards.includes(board.id);
  }).map(item => item.id);
}

/** Whether one-click making can send a dispatch to this section: one of the world book, script, regex or greeting boards. */
export function runnableSection(sectionId: string | null): boolean {
  const board = sectionId ? findBoard(sectionId) : undefined;
  return !!board && (RUN_BOARDS as readonly string[]).includes(board.id);
}

/** What a 改动单's run still has to send: its dispatches not yet sent, in the dependency order 照单开做 stored them in. */
export function changeQueue(change: Pick<CardChange, 'dispatchIds'>, dispatches: readonly CardDispatch[]): string[] {
  return change.dispatchIds.filter(id => dispatches.some(item => item.id === id && item.status === 'todo' && item.sectionId));
}

/** The longest run of failures of one tool, in call order, when it reaches the limit. */
export function toolFailureStreak(tools: readonly ToolCall[]): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  let name = ''; let count = 0;
  for (const tool of tools) {
    if (tool.status === 'failed' && tool.name === name) count++;
    else if (tool.status === 'failed') { name = tool.name; count = 1; }
    else { name = ''; count = 0; }
    if (count >= TOOL_FAILURE_LIMIT && (!best || count > best.count)) best = { name, count };
  }
  return best;
}

export type TurnOutcome =
  | { kind: 'delivered' } | { kind: 'cancelled' } | { kind: 'interjection' }
  | { kind: 'model-error'; message: string } | { kind: 'tool-failures'; tool: string; count: number }
  | { kind: 'question'; text: string } | { kind: 'refusal'; text: string };

/**
 * What the turns since the run's first message for this dispatch came to. Earlier turns of the same conversation (other
 * dispatches) do not count towards the reply or the failing tools. A user message the run neither sent nor acknowledged
 * is an interjection wherever it sits, because the user can also write between two dispatches (`known`: every message
 * the run sent in this conversation, defaulting to this dispatch's).
 */
export function turnOutcome(input: { status: TaskStatus; error?: string; messages: readonly ChatMessage[]; tools: readonly ToolCall[]; sent: readonly string[]; known?: readonly string[] }): TurnOutcome {
  if (input.status === 'cancelled') return { kind: 'cancelled' };
  if (input.status === 'failed') return { kind: 'model-error', message: input.error || '模型请求失败。' };
  const known = input.known ?? input.sent;
  const first = input.messages.findIndex(message => known.includes(message.id));
  if (first >= 0 && input.messages.slice(first).some(message => message.role === 'user' && !known.includes(message.id))) return { kind: 'interjection' };
  const start = input.messages.findIndex(message => input.sent.includes(message.id));
  const turn = start < 0 ? [] : input.messages.slice(start);
  const turnIds = new Set(turn.filter(message => message.role === 'user').map(message => message.id));
  const streak = toolFailureStreak(input.tools.filter(tool => tool.turnId && turnIds.has(tool.turnId)));
  if (streak) return { kind: 'tool-failures', tool: streak.name, count: streak.count };
  const reply = stripMarkers(turn.findLast(message => message.role === 'assistant' && message.text.trim())?.text ?? '');
  if (reply.hasAcceptAll) return { kind: 'question', text: reply.text.trim().slice(0, 1200) };
  if (reply.refused) return { kind: 'refusal', text: reply.text.trim().slice(0, 1200) };
  return { kind: 'delivered' };
}

/** Assembly check errors on the components this dispatch wrote; errors elsewhere in the card do not hold it back. */
export function dispatchErrors(report: CardCheckReport, tools: readonly ToolCall[], turnIds: readonly string[], root: string): CardCheckFinding[] {
  const written = new Set<string>();
  for (const tool of tools) {
    if (!tool.turnId || !turnIds.includes(tool.turnId) || tool.status !== 'completed' || (tool.name !== 'write' && tool.name !== 'edit')) continue;
    const relative = projectRelativePath(root, String(tool.args.path ?? ''));
    if (relative) written.add(componentName(relative));
  }
  return report.findings.filter(finding => finding.level === 'error' && finding.path && written.has(componentName(finding.path)));
}

/** Tokens (input, output, cache read and write) and cost of the run's conversations since it started. */
export function runUsage(run: Pick<CardRun, 'conversations' | 'current' | 'startedAt'>, tasks: readonly Pick<Task, 'id' | 'messages'>[]): { tokens: number; cost: number } {
  const ids = new Set([...Object.values(run.conversations), ...(run.current ? [run.current.taskId] : [])]);
  let tokens = 0; let cost = 0;
  for (const task of tasks) {
    if (!ids.has(task.id)) continue;
    for (const message of task.messages) {
      if (!message.usage || message.at < run.startedAt) continue;
      tokens += message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      cost += message.usage.cost;
    }
  }
  return { tokens, cost };
}
