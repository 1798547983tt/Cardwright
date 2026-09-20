import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AccessRule } from '../shared/studio-types.ts';

export function validateAccessRule(input: Omit<AccessRule, 'id' | 'createdAt'>): AccessRule {
  if (!['session', 'project'].includes(input.scope) || !input.projectId || (input.scope === 'session' && !input.taskId) || !['read', 'write', 'network', 'command'].includes(input.kind)) throw new Error('Choose a valid permission scope.');
  let target = input.target.trim();
  if (!target || target.length > 4000 || /[\0\r\n]/.test(target)) throw new Error('Enter one permission target.');
  if (input.kind === 'network') {
    const url = new URL(target.includes('://') ? target : `https://${target}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter an HTTP(S) origin without credentials.');
    target = url.origin;
  } else if (input.kind === 'read' || input.kind === 'write') {
    if (!isAbsolute(target)) throw new Error('Choose an absolute folder for this rule.'); target = resolve(target);
  }
  return { ...input, target, id: randomUUID(), createdAt: new Date().toISOString() };
}
export function ruleMatches(rules: AccessRule[], projectId: string, taskId: string, kind: AccessRule['kind'], target: string): boolean {
  return rules.some(rule => {
    if (rule.projectId !== projectId || rule.kind !== kind || (rule.scope === 'session' && rule.taskId !== taskId)) return false;
    if (kind === 'network') { try { return new URL(target).origin === rule.target; } catch { return false; } }
    if (kind === 'command') return rule.target === target.trim();
    const part = relative(resolve(rule.target), resolve(target)); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
  });
}
