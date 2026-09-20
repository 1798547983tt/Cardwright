import type { Task } from '../shared/types.ts';

export interface TaskBudget { tokens: number; minutes: number; money: number }
export function budgetUsage(tasks: Task[]): { tokens: number; money: number; elapsedMinutes: number } {
  const seen = new Set<string>(); let tokens = 0; let money = 0;
  for (const task of tasks) for (const message of [...task.messages, ...(task.revisions || []).flatMap(revision => revision.messages)]) {
    if (seen.has(message.id)) continue; seen.add(message.id);
    if (message.usage) { tokens += message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite; money += message.usage.cost; }
  }
  const start = Math.min(...tasks.map(task => Date.parse(task.startedAt || task.createdAt)));
  return { tokens, money, elapsedMinutes: Number.isFinite(start) ? Math.max(0, (Date.now() - start) / 60000) : 0 };
}
export function exceededBudget(budget: TaskBudget, usage: ReturnType<typeof budgetUsage>): string | undefined {
  if (budget.tokens > 0 && usage.tokens >= budget.tokens) return 'The squad reached its configured token budget.';
  if (budget.minutes > 0 && usage.elapsedMinutes >= budget.minutes) return 'The squad reached its configured time budget.';
  if (budget.money > 0 && usage.money >= budget.money) return 'The squad reached its configured cost budget.';
}
