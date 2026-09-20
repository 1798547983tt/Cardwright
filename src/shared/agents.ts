import type { AgentRole } from './types.ts';

/** Subagents found as Markdown files under `.claude/agents` (§6.2), in Claude Code's own format. */
export interface DiscoveredAgent {
  id: string; name: string; description: string; prompt: string; readOnly: boolean;
  tools?: string[]; model?: string; source: 'project' | 'user'; path: string; projectId?: string;
}
/**
 * The one list the settings page and the composer read: built-in roles, the user's own, then what was discovered.
 * Same name: project beats user beats custom beats built-in, and the ones that step aside say who took their place.
 */
export function mergeAgents(input: { saved: AgentRole[]; discovered: DiscoveredAgent[]; disabled: string[]; projectId?: string }): AgentRole[] {
  const disabled = new Set(input.disabled);
  const discovered = input.discovered.filter(agent => !agent.projectId || !input.projectId || agent.projectId === input.projectId);
  const saved: AgentRole[] = input.saved.map(role => ({ ...role, source: role.builtIn ? 'builtin' : 'custom', enabled: !disabled.has(role.id) }));
  const found: AgentRole[] = discovered.map(agent => ({
    id: agent.id, name: agent.name, prompt: agent.prompt, readOnly: agent.readOnly, description: agent.description,
    source: agent.source, path: agent.path, enabled: !disabled.has(agent.id),
    ...(agent.tools ? { tools: agent.tools } : {}), ...(agent.model ? { model: agent.model } : {}), ...(agent.projectId ? { projectId: agent.projectId } : {}),
  }));
  const order: Record<string, number> = { project: 0, user: 1, custom: 2, builtin: 3 };
  // Claude Code knows a subagent by its name; Cardwright's own roles are known by their id.
  const identity = (role: AgentRole) => (role.source === 'project' || role.source === 'user' ? role.name : role.id).toLowerCase();
  const all = [...saved, ...found];
  for (const role of all) {
    const winner = all.filter(item => identity(item) === identity(role))
      .sort((a, b) => (order[a.source ?? 'custom'] ?? 2) - (order[b.source ?? 'custom'] ?? 2))[0];
    if (winner && winner.id !== role.id) role.shadowedBy = winner.id;
  }
  return all;
}

/** What a task may actually use in this project: enabled, not stepped aside, and not another project's. */
export function usableAgents(roles: AgentRole[], projectId?: string): AgentRole[] {
  return roles.filter(role => role.enabled !== false && !role.shadowedBy && (!role.projectId || role.projectId === projectId));
}
