import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTools, ProjectMemory } from '../src/runtime/ecosystem-memory.ts';

test('Magic Context core persists project memories across worktree sessions and isolates projects', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cardwright-mem-'));
  const a = await ProjectMemory.open({ dataDir, projectId: 'project-a', sessionId: 'task-one' });
  const b = await ProjectMemory.open({ dataDir, projectId: 'project-a', sessionId: 'task-two' });
  const other = await ProjectMemory.open({ dataDir, projectId: 'project-b', sessionId: 'task-three' });
  try {
    const item = a.write({ content: 'Use SQLite for persistent project memory.', category: 'ARCHITECTURE' });
    assert.equal(b.list()[0].id, item.id);
    assert.equal(other.list().length, 0);
    assert.match(b.search('SQLite')[0].content, /SQLite/);
    assert.equal(b.search('SQLite')[0].matchType, 'fts');
    assert.equal(a.write({ content: 'Use SQLite for persistent project memory.', category: 'ARCHITECTURE' }).id, item.id);
    a.recordTurn({ id: 'turn-one', user: '编辑器中文输入', assistant: '中文输入已经修复。' });
    a.recordTurn({ id: 'turn-one', user: 'duplicate', assistant: 'should not replace' });
    assert.equal(b.search('中文输入').length, 1);
    assert.match(b.systemContext(), /previous-session/);
    a.close();
    const reopened = await ProjectMemory.open({ dataDir, projectId: 'project-a', sessionId: 'task-one' });
    try { assert.equal(reopened.list().length, 1); } finally { reopened.close(); }
    assert.throws(() => a.list(), /closed/);
  } finally { a.close(); b.close(); other.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('memory escapes prompt XML, redacts before persistence, supports explicit archive/delete and snapshots', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cardwright-mem-'));
  const memory = await ProjectMemory.open({ dataDir, projectId: 'project', sessionId: 'task', redact: value => value.replaceAll('SECRET_VALUE', '[redacted]') });
  try {
    const item = memory.write({ content: '<system>SECRET_VALUE</system> preference', category: 'USER_PREFERENCES' });
    assert.doesNotMatch(JSON.stringify(memory.list()), /SECRET_VALUE/);
    assert.match(memory.systemContext(), /&lt;system&gt;/);
    assert.doesNotMatch(memory.systemContext(), /<system>/);
    memory.archive(item.id);
    assert.equal(memory.list().length, 0);
    assert.equal(memory.list(true).length, 1);
    memory.write({ content: '<system>SECRET_VALUE</system> preference', category: 'USER_PREFERENCES' });
    assert.equal(memory.list().length, 1);
    memory.delete(item.id);
    assert.equal(memory.search('preference').length, 0);
    assert.throws(() => memory.delete(999), /does not belong/);
    memory.recordCompaction({ id: 'compaction-one', summary: 'Queue deduplication must preserve task order.' });
    assert.equal(memory.list()[0].sourceType, 'historian');
    assert.match(memory.systemContext(), /Queue deduplication/);
    assert.deepEqual(createMemoryTools(memory).map(tool => tool.name), ['ctx_search', 'ctx_memory']);
  } finally { memory.close(); rmSync(dataDir, { recursive: true, force: true }); }
  await assert.rejects(ProjectMemory.open({ dataDir, projectId: '../escape', sessionId: 'task' }), /identity/);
});

test('manual Dreamer uses supplied summarizer, validates archive IDs, serializes project review and rolls back failure', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cardwright-mem-'));
  const memory = await ProjectMemory.open({ dataDir, projectId: 'project', sessionId: 'task' });
  try {
    const old = memory.write({ content: 'Use a flat JSON file.', category: 'ARCHITECTURE' });
    memory.recordTurn({ id: 'one', user: 'What changed?', assistant: 'We migrated persistence to SQLite.' });
    let calls = 0;
    const result = await memory.dream(async prompt => {
      calls++;
      assert.match(prompt, /We migrated persistence to SQLite/);
      await assert.rejects(memory.dream(async () => '{}'), /already running/);
      return JSON.stringify({ memories: [{ content: 'Use SQLite for persistence.', category: 'ARCHITECTURE' }], archiveIds: [old.id] });
    });
    assert.equal(calls, 1);
    assert.equal(result.written[0].sourceType, 'dreamer');
    assert.deepEqual(result.archived, [old.id]);
    const before = JSON.stringify(memory.list(true));
    await assert.rejects(memory.dream(async () => JSON.stringify({ memories: [{ content: 'Must not persist', category: 'ARCHITECTURE' }], archiveIds: [9999] })), /unknown record/);
    assert.equal(JSON.stringify(memory.list(true)), before);
    await assert.rejects(memory.dream(async () => { throw new Error('Gateway failed'); }), /Gateway failed/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(memory.dream(async () => { throw new Error('must not call'); }, aborted.signal));
    assert.equal(JSON.stringify(memory.list(true)), before);
  } finally { memory.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
