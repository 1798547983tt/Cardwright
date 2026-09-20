import { createHash } from 'node:crypto';
import {
  convertToLlm, estimateTokens, sessionEntryToContextMessages,
  type AgentSession, type ExtensionFactory, type SessionBeforeCompactEvent, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { Context, Message } from '@earendil-works/pi-ai';

export const CONTEXT_MESSAGE = 'cardwright:context-v2';
export const COMPACTION_INSTRUCTION = 'Summarize the conversation above into a concise checkpoint: user goal and constraints; completed changes and verification evidence; open work and next steps; essential paths and decisions. Preserve current user instructions and unresolved issues. Merge any earlier checkpoint. Output only the summary; do not call tools.';

/** Append only changed sections; a model change must not duplicate all project instructions. */
export function contextSnapshot(sections: Record<string, string>, retained: Record<string, string> = {}) {
  const digests: Record<string, string> = {};
  const changed: string[] = [];
  for (const [name, content] of Object.entries(sections)) {
    const digest = createHash('sha256').update(content).digest('hex');
    if (retained[name] === digest) continue;
    digests[name] = digest;
    changed.push(`${name}:\n${content || '(none)'}`);
  }
  if (!changed.length) return undefined;
  return { customType: CONTEXT_MESSAGE, display: false,
    content: `Cardwright context — each section below replaces its earlier version. Saved and project instructions guide this task; recalled observations may be stale.\n\n${changed.join('\n\n')}`,
    details: { digests },
  };
}

export function retainedContextDigests(entries: readonly SessionEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.type !== 'custom_message' || entry.customType !== CONTEXT_MESSAGE || !entry.details || typeof entry.details !== 'object' || !('digests' in entry.details)) continue;
    if (!entry.details.digests || typeof entry.details.digests !== 'object') continue;
    for (const [name, digest] of Object.entries(entry.details.digests)) if (typeof digest === 'string') result[name] = digest;
  }
  return result;
}

export interface PrefixMeasurement {
  requestIndex: number;
  purpose: 'conversation' | 'compaction';
  bytes: number;
  sharedBytes: number;
  sharedPercent: number;
  estimatedTokens: number;
  estimatedSharedTokens: number;
  systemCharacters: number;
  toolCount: number;
  measurement: 'local-estimate';
}

/** Compare model-visible request bytes, not credentials, request IDs or generated output. */
export class PrefixMeter {
  private previous?: Buffer;
  private requests = 0;
  observe(payload: unknown, purpose: PrefixMeasurement['purpose'] = 'conversation'): PrefixMeasurement | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const request = payload as Record<string, unknown>;
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const messages = request.messages ?? request.input;
    if (!Array.isArray(messages)) return undefined;
    const system = request.system ?? request.instructions ?? messages.filter(message => message && typeof message === 'object' && ['system', 'developer'].includes(String((message as Record<string, unknown>).role)));
    // Match provider-visible values in their existing key order. This is a
    // reproducible local proxy for cache eligibility, never a hit-rate claim.
    const visible = JSON.stringify({ tools, system, messages });
    const current = Buffer.from(visible, 'utf8');
    let shared = 0;
    if (this.previous) while (shared < Math.min(current.length, this.previous.length) && current[shared] === this.previous[shared]) shared++;
    const result: PrefixMeasurement = {
      requestIndex: ++this.requests, purpose, bytes: current.length, sharedBytes: shared,
      sharedPercent: current.length ? Math.round(shared / current.length * 1000) / 10 : 0,
      estimatedTokens: Math.ceil(visible.length / 4), estimatedSharedTokens: Math.ceil(current.subarray(0, shared).toString('utf8').length / 4),
      systemCharacters: typeof system === 'string' ? system.length : JSON.stringify(system).length,
      toolCount: tools.length, measurement: 'local-estimate',
    };
    if (purpose === 'conversation') this.previous = current;
    return result;
  }
}

export function balancedToolHistory(messages: readonly Message[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') {
      if (pending.has(part.id)) return false;
      pending.add(part.id);
    }
    if (message.role === 'toolResult' && !pending.delete(message.toolCallId)) return false;
    if (message.role === 'user' && pending.size) return false;
  }
  return pending.size === 0;
}

/** Use the actual retained prefix, including the prior checkpoint and custom context. */
export function compactionPrefix(session: AgentSession, event: SessionBeforeCompactEvent): Message[] | undefined {
  const entries = session.sessionManager.buildContextEntries();
  const boundary = entries.findIndex(entry => entry.id === event.preparation.firstKeptEntryId);
  if (boundary <= 0) return undefined;
  const count = entries.slice(0, boundary).flatMap(sessionEntryToContextMessages).length;
  if (count <= 0 || count >= session.messages.length) return undefined;
  const messages = convertToLlm(session.messages.slice(0, count));
  return balancedToolHistory(messages) ? messages : undefined;
}

export interface PromptCacheOptions {
  context: () => Record<string, string>;
  session: () => AgentSession | undefined;
  protocol: string;
  cacheEnabled: boolean;
  emit: (event: Record<string, unknown>) => void;
}

/** Reuses Pi's admission, compaction transaction and session storage. No second compactor. */
export function createPromptCacheExtension(options: PromptCacheOptions): ExtensionFactory {
  return pi => {
    const meter = new PrefixMeter();
    let purpose: PrefixMeasurement['purpose'] = 'conversation';
    pi.on('before_agent_start', (_event, ctx) => {
      const snapshot = contextSnapshot(options.context(), retainedContextDigests(ctx.sessionManager.buildContextEntries()));
      if (snapshot) return { message: snapshot };
    });
    pi.on('session_compact', async (_event, ctx) => {
      const snapshot = contextSnapshot(options.context(), retainedContextDigests(ctx.sessionManager.buildContextEntries()));
      if (snapshot) {
        // Restore exact user/project instructions after summarization, without
        // asking the summarizer to reproduce their full text from memory.
        await options.session()?.sendCustomMessage(snapshot, { triggerTurn: false });
      }
    });
    pi.on('before_provider_request', event => {
      const measurement = meter.observe(event.payload, purpose);
      if (measurement) options.emit({ type: 'cache_prefix', ...measurement });
    });
    pi.on('session_before_compact', async (event, ctx) => {
      const session = options.session();
      // These are the SDK protocols exercised by Cardwright's wire fixtures.
      // Unsupported or unbalanced shapes keep the native SDK summarizer.
      if (!options.cacheEnabled || !session?.model || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(options.protocol)) return;
      const prefix = compactionPrefix(session, event);
      if (!prefix) return;
      event.signal.throwIfAborted();
      const instructions = COMPACTION_INSTRUCTION + (event.customInstructions ? `\nAdditional user focus: ${event.customInstructions}` : '');
      const context: Context = {
        systemPrompt: session.systemPrompt,
        tools: session.agent.state.tools,
        messages: [...prefix, { role: 'user', content: [{ type: 'text', text: instructions }], timestamp: Date.now() }],
      };
      purpose = 'compaction';
      try {
        const stream = await session.agent.streamFunction(session.model, context, {
          signal: event.signal, sessionId: ctx.sessionManager.getSessionId(), cacheRetention: 'short',
          maxTokens: Math.min(8192, session.model.maxTokens),
          ...(session.thinkingLevel !== 'off' ? { reasoning: session.thinkingLevel } : {}),
          onPayload: session.agent.onPayload,
        });
        const response = await stream.result();
        event.signal.throwIfAborted();
        options.emit({ type: 'nested_usage', purpose: 'compaction', model: session.model.id, usage: response.usage });
        if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage || 'Compaction did not finish.');
        if (response.stopReason === 'length') throw new Error('Compaction reached its output limit. The existing history was preserved.');
        if (response.content.some(part => part.type === 'toolCall')) throw new Error('Compaction attempted a tool call. The existing history was preserved.');
        const summary = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
        const before = prefix.reduce((sum, message) => sum + estimateTokens(message), 0);
        if (!summary || Math.ceil(summary.length / 4) >= before) throw new Error('Compaction produced no smaller checkpoint. The existing history was preserved.');
        const files = event.preparation.fileOps;
        const modifiedFiles = [...new Set([...files.written, ...files.edited])].sort();
        return { compaction: {
          summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
          // Usage is emitted once above; recording it on the compaction would
          // make the desktop count this auxiliary request twice.
          details: { adapter: 'cardwright-prefix-v1', readFiles: [...files.read].filter(path => !modifiedFiles.includes(path)).sort(), modifiedFiles },
        } };
      } catch (error) {
        // Pi logs and swallows extension exceptions. Return an explicit cancel
        // so a failed custom summary cannot silently launch a second model call.
        options.emit({ type: 'workflow_notice', level: 'error', message: error instanceof Error ? error.message : 'Compaction failed; history was preserved.' });
        return { cancel: true };
      } finally { purpose = 'conversation'; }
    });
  };
}
