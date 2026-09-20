/** Small structural surface so history checks can also run in the main process without loading the SDK. */
export interface ConversationEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content?: unknown };
}

export interface ConversationCursorManager {
  getEntries(): ConversationEntry[];
  getEntry(id: string): ConversationEntry | undefined;
  getLeafId(): string | null;
  branch(id: string): void;
  resetLeaf(): void;
}

/** Follow one explicit append-only branch. Invalid or incomplete ancestry is never guessed. */
export function conversationBranch(entries: ConversationEntry[], leafId?: string | null): ConversationEntry[] {
  const index = new Map<string, ConversationEntry>();
  for (const entry of entries) {
    if (!entry.id || index.has(entry.id)) throw new Error('Conversation history contains duplicate or invalid entry IDs.');
    index.set(entry.id, entry);
  }
  let next = leafId === undefined ? entries.at(-1)?.id ?? null : leafId;
  const branch: ConversationEntry[] = [];
  const seen = new Set<string>();
  while (next !== null) {
    if (seen.has(next)) throw new Error('Conversation history contains a parent cycle.');
    seen.add(next);
    const entry = index.get(next);
    if (!entry) throw new Error('The selected conversation version is missing a saved entry.');
    branch.unshift(entry);
    next = entry.parentId;
  }
  return branch;
}

/** Apply before creating the SDK session, so its model context is built from the selected branch. */
export function applyConversationCursor(manager: ConversationCursorManager, options: {
  sessionLeafId?: string | null;
  branchBeforeEntryId?: string;
}): string | null {
  const selectedLeaf = options.sessionLeafId === undefined ? manager.getLeafId() : options.sessionLeafId;
  const branch = conversationBranch(manager.getEntries(), selectedLeaf);
  let nextLeaf = selectedLeaf;
  if (options.branchBeforeEntryId !== undefined) {
    const target = branch.find(entry => entry.id === options.branchBeforeEntryId);
    if (!target || target.type !== 'message' || target.message?.role !== 'user') {
      throw new Error('Only a saved user message in the selected conversation version can be regenerated.');
    }
    nextLeaf = target.parentId;
  }
  // Validate everything before touching the manager; failures keep the previous cursor intact.
  if (nextLeaf === null) manager.resetLeaf();
  else manager.branch(nextLeaf);
  return nextLeaf;
}

export interface LegacyUiMessage {
  id: string;
  role: string;
  text: string;
  sessionEntryId?: string;
}
export interface UserEntryMapping { messageId: string; entryId: string; parentId: string | null }

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(part => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string')) return;
  return content.map(part => String(part.text)).join('');
}

/**
 * Upgrade old UI messages only when the entire ordered user sequence agrees with the saved branch.
 * Repeated prompts remain distinguishable by position. Expanded skills, unsent queues, or missing
 * entries produce no mapping, so an old conversation cannot silently regenerate the wrong turn.
 */
export function mapLegacyUserMessages(entries: ConversationEntry[], messages: LegacyUiMessage[], leafId?: string | null): UserEntryMapping[] {
  const saved = conversationBranch(entries, leafId).filter(entry => entry.type === 'message' && entry.message?.role === 'user');
  const visible = messages.filter(message => message.role === 'user');
  if (saved.length !== visible.length || new Set(visible.map(message => message.id)).size !== visible.length) return [];
  const result: UserEntryMapping[] = [];
  for (let i = 0; i < saved.length; i++) {
    const entry = saved[i];
    const message = visible[i];
    if (!message.id || userText(entry.message?.content) !== message.text || (message.sessionEntryId && message.sessionEntryId !== entry.id)) return [];
    result.push({ messageId: message.id, entryId: entry.id, parentId: entry.parentId });
  }
  return result;
}
