import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { applyConversationCursor, conversationBranch, mapLegacyUserMessages, type ConversationEntry } from '../src/runtime/conversation-history.ts';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const assistant = (value: string) => ({ role: 'assistant' as const, content: text(value), api: 'openai-completions' as const, provider: 'test', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() });

test('edits the selected repeated user prompt as an append-only branch and leaves filesystem effects intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'cardwright-history-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const first = manager.appendMessage({ role: 'user', content: text('same'), timestamp: Date.now() });
  const answer = manager.appendMessage(assistant('first answer'));
  const second = manager.appendMessage({ role: 'user', content: text('same'), timestamp: Date.now() });
  const old = manager.appendMessage(assistant('old answer'));
  const effect = join(root, 'already-written.txt'); writeFileSync(effect, 'earlier tool output');
  assert.deepEqual(mapLegacyUserMessages(manager.getEntries(), [{ id: 'ui1', role: 'user', text: 'same' }, { id: 'ui2', role: 'user', text: 'same' }]), [
    { messageId: 'ui1', entryId: first, parentId: null }, { messageId: 'ui2', entryId: second, parentId: answer },
  ]);
  assert.equal(applyConversationCursor(manager, { branchBeforeEntryId: second }), answer);
  const replacement = manager.appendMessage({ role: 'user', content: text('edited'), timestamp: Date.now() });
  const fresh = manager.appendMessage(assistant('new answer'));
  assert.equal(manager.getEntry(replacement)?.parentId, answer);
  assert.ok(manager.getEntry(old));
  assert.equal(readFileSync(effect, 'utf8'), 'earlier tool output');
  assert.deepEqual(conversationBranch(manager.getEntries(), fresh).map(entry => entry.id), [first, answer, replacement, fresh]);
  const restored = SessionManager.open(manager.getSessionFile()!, join(root, 'sessions'), root);
  assert.equal(restored.getLeafId(), fresh);
  applyConversationCursor(restored, { sessionLeafId: old });
  assert.deepEqual(restored.buildSessionContext().messages.map(message => 'content' in message ? message.content : null), [text('same'), text('first answer'), text('same'), text('old answer')]);
});

test('editing first user prompt resets the leaf and invalid requests leave the cursor unchanged', () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: 'user', content: text('first'), timestamp: 1 });
  const last = manager.appendMessage(assistant('answer'));
  assert.throws(() => applyConversationCursor(manager, { branchBeforeEntryId: last }), /saved user message/);
  assert.throws(() => applyConversationCursor(manager, { sessionLeafId: 'unknown' }), /missing/);
  assert.equal(manager.getLeafId(), last);
  assert.equal(applyConversationCursor(manager, { branchBeforeEntryId: first }), null);
  const newFirst = manager.appendMessage({ role: 'user', content: text('replacement'), timestamp: 2 });
  assert.equal(manager.getEntry(newFirst)?.parentId, null);
  assert.throws(() => applyConversationCursor(manager, { sessionLeafId: newFirst, branchBeforeEntryId: first }), /selected conversation/);
  assert.equal(manager.getLeafId(), newFirst);
});

test('legacy mapping rejects partial, transformed, mismatched known IDs and undelivered UI histories', () => {
  const entries: ConversationEntry[] = [{ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: text('hello') } }];
  assert.deepEqual(mapLegacyUserMessages(entries, [{ id: 'ui', role: 'user', text: 'hello', sessionEntryId: 'other' }]), []);
  assert.deepEqual(mapLegacyUserMessages(entries, [{ id: 'ui', role: 'user', text: '/skill:hello' }]), []);
  assert.deepEqual(mapLegacyUserMessages(entries, [{ id: 'ui', role: 'user', text: 'hello' }, { id: 'queued', role: 'user', text: 'not delivered' }]), []);
  assert.deepEqual(mapLegacyUserMessages(entries, []), []);
  assert.deepEqual(mapLegacyUserMessages(entries, [{ id: 'ui', role: 'user', text: 'hello' }, { id: 'notice', role: 'system', text: 'notice' }]), [{ messageId: 'ui', entryId: 'u1', parentId: null }]);
});

test('branch traversal refuses broken parents, duplicate IDs and cycles', () => {
  assert.throws(() => conversationBranch([{ id: 'a', type: 'message', parentId: 'missing' }]), /missing/);
  assert.throws(() => conversationBranch([{ id: 'a', type: 'message', parentId: 'b' }, { id: 'b', type: 'message', parentId: 'a' }]), /cycle/);
  assert.throws(() => conversationBranch([{ id: 'a', type: 'message', parentId: null }, { id: 'a', type: 'message', parentId: null }]), /duplicate/);
  assert.deepEqual(conversationBranch([], null), []);
});
