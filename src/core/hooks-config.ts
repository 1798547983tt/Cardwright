/**
 * Hooks, written the way Claude Code's `settings.json` writes them (§6.2): an event, an optional tool matcher, and the
 * commands to run. Cardwright supports the events it has a moment for; anything else is reported and left out.
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** The events a hook can stop: a tool call, or a message on its way to the model. */
export const BLOCKING_EVENTS: readonly HookEvent[] = ['PreToolUse', 'UserPromptSubmit'];

export interface HookCommand { type: 'command'; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

const MAX_COMMAND = 8_000;
const MAX_MATCHER = 200;
const MAX_ENTRIES = 50;

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/**
 * Reads a hooks block from Cardwright's own settings or from a Claude Code `settings.json`. Without `strict` anything
 * unusable is skipped and its event name reported, which is what the import preview shows; with `strict` it throws,
 * which is what saving in the settings page does.
 */
export function parseHooks(value: unknown, options: { strict?: boolean } = {}): { hooks: HooksConfig; skipped: string[] } {
  const hooks: HooksConfig = {};
  const skipped = new Set<string>();
  if (!isRecord(value)) return { hooks, skipped: [] };
  const fail = (message: string, event: string) => { if (options.strict) throw new Error(message); skipped.add(event); };
  for (const [event, entries] of Object.entries(value)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) { fail(`Cardwright does not support the ${event} hook event.`, event); continue; }
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) { fail(`The ${event} hooks must be a list.`, event); continue; }
    const kept: HookMatcher[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks) || !entry.hooks.length || entry.hooks.length > MAX_ENTRIES) { fail(`A ${event} hook has no commands.`, event); continue; }
      const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() && entry.matcher.trim() !== '*' ? entry.matcher.trim() : undefined;
      if (matcher !== undefined) {
        if (matcher.length > MAX_MATCHER) { fail(`The ${event} matcher is too long.`, event); continue; }
        try { new RegExp(matcher, 'i'); } catch { fail(`The ${event} matcher is not a valid pattern.`, event); continue; }
      }
      const commands: HookCommand[] = [];
      for (const hook of entry.hooks) {
        if (!isRecord(hook) || hook.type !== 'command') { fail(`A ${event} hook is not a command hook.`, event); continue; }
        const command = typeof hook.command === 'string' ? hook.command.trim() : '';
        if (!command || command.length > MAX_COMMAND || command.includes('\0')) { fail(`A ${event} hook has no command to run.`, event); continue; }
        const timeout = hook.timeout;
        if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > 600)) { fail(`A ${event} hook timeout must be 1–600 seconds.`, event); continue; }
        commands.push({ type: 'command', command, ...(typeof timeout === 'number' ? { timeout } : {}) });
      }
      if (commands.length) kept.push({ ...(matcher ? { matcher } : {}), hooks: commands });
    }
    if (kept.length) hooks[event as HookEvent] = kept;
  }
  return { hooks, skipped: [...skipped] };
}

/** The commands to run for one event; a matcher is a case-insensitive pattern over the tool's name. */
export function hooksFor(hooks: HooksConfig, event: HookEvent, toolName?: string): HookCommand[] {
  return (hooks[event] ?? []).flatMap(entry => {
    if (!entry.matcher) return entry.hooks;
    if (!toolName) return [];
    try { return new RegExp(entry.matcher, 'i').test(toolName) ? entry.hooks : []; } catch { return []; }
  });
}

/** How many commands are configured in total, for the settings page. */
export function countHooks(hooks: HooksConfig): number {
  return Object.values(hooks).reduce((sum, entries) => sum + entries.reduce((inner, entry) => inner + entry.hooks.length, 0), 0);
}
