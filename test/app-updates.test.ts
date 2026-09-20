import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAppUpdate, createAppUpdate } from '../src/shared/app-updates.ts';
import { defaultPreferences } from '../src/core/store.ts';
import { defaultEcosystem } from '../src/core/ecosystem.ts';
import type { AppSnapshot, Task } from '../src/shared/types.ts';

function task(id: string): Task {
  return { id, title: id, projectId: 'project', cwd: 'C:/fixture', status: 'running', permission: 'ask', gatewayId: 'gateway', thinking: 'medium', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id: `${id}-user`, role: 'user', text: 'Work.', at: '2026-01-01' }, { id: `${id}-answer`, role: 'assistant', text: 'Hello', thinking: 'Think', at: '2026-01-01' }], tools: [{ id: `${id}-tool`, name: 'read', args: { path: 'file.ts' }, output: 'first', status: 'running', at: '2026-01-01' }] };
}
function snapshot(): AppSnapshot {
  return { preferences: defaultPreferences(), gateways: [], projects: [], tasks: [task('one'), task('two')], schedules: [], approvals: [], skills: [], version: 'fixture', search: { enabled: false, provider: 'auto', baseUrl: '', hasKey: false }, ecosystem: defaultEcosystem(), extensions: [], interactions: [], hooks: {} };
}

test('stream deltas preserve historical object references and freeze emitted changes', () => {
  const source = snapshot(); const initial = applyAppUpdate(null, createAppUpdate(null, source, 1));
  source.tasks[0].messages[1].text += ' world'; source.tasks[0].messages[1].thinking += ' more';
  source.tasks[0].tools[0].output += '\nsecond'; source.tasks[0].status = 'waiting';
  const delta = createAppUpdate(initial, source, 2);
  assert.equal(delta.type, 'patch'); assert.match(JSON.stringify(delta), /"append"/);
  assert.doesNotMatch(JSON.stringify(delta), /"text":"Hello world"/);
  const current = applyAppUpdate(initial, delta);
  assert.deepEqual(current, source);
  assert.equal(current.preferences, initial.preferences); assert.equal(current.tasks[1], initial.tasks[1]);
  assert.equal(current.tasks[0].messages[0], initial.tasks[0].messages[0]);
  source.tasks[0].tools[0].args.path = 'after-emission';
  assert.equal(current.tasks[0].tools[0].args.path, 'file.ts');
  assert.throws(() => applyAppUpdate(initial, createAppUpdate(current, source, 3)), /revision/);
});

test('message additions, older record updates, deletion and branch switching round-trip atomically', () => {
  let current = applyAppUpdate(null, createAppUpdate(null, snapshot()));
  const source = structuredClone(current);
  source.tasks[0].messages[0].sessionEntryId = 'persisted-entry';
  source.tasks[0].messages.push({ id: 'new-user', role: 'user', text: 'Next.', at: '2026-01-02' });
  source.tasks.push(task('three')); source.tasks.reverse();
  current = applyAppUpdate(current, createAppUpdate(current, source)); assert.deepEqual(current, source);
  const branch = structuredClone(current);
  const first = branch.tasks.find(task => task.id === 'one')!;
  first.activeRevisionId = 'other'; first.messages = first.messages.slice(0, 1); first.messages[0].text = 'Edited.';
  first.tools = []; branch.tasks = branch.tasks.filter(task => task.id !== 'two');
  const delta = createAppUpdate(current, branch);
  assert.match(JSON.stringify(delta), /"replacement"/);
  assert.deepEqual(applyAppUpdate(current, delta), branch);
});

test('missed stream packets require resynchronization and no-op updates reuse snapshot identity', () => {
  const current = applyAppUpdate(null, createAppUpdate(null, snapshot()));
  assert.equal(applyAppUpdate(current, createAppUpdate(current, structuredClone(current))), current);
  const next = structuredClone(current); next.tasks[0].messages[1].text += ' appended';
  const delta = createAppUpdate(current, next);
  assert.throws(() => applyAppUpdate(next, delta), /prefix mismatch/);
});

test('six streaming tasks with long history transmit only changed records', () => {
  const source = snapshot(); source.tasks = Array.from({ length: 6 }, (_, i) => {
    const item = task(String(i));
    item.messages = Array.from({ length: 800 }, (_, n) => ({ id: `${i}-${n}`, role: n % 2 ? 'assistant' : 'user', text: `Message ${n} ` + 'history '.repeat(100), at: '2026-01-01' }));
    return item;
  });
  let previous = applyAppUpdate(null, createAppUpdate(null, source));
  let legacyBytes = 0; let deltaBytes = 0;
  for (let i = 0; i < 20; i++) {
    for (const item of source.tasks) { item.messages.at(-1)!.text += ' stream'; item.updatedAt = `2026-01-01T00:00:${String(i).padStart(2, '0')}`; }
    const delta = createAppUpdate(previous, source);
    legacyBytes += Buffer.byteLength(JSON.stringify(source)); deltaBytes += Buffer.byteLength(JSON.stringify(delta));
    previous = applyAppUpdate(previous, delta);
  }
  assert.deepEqual(previous, source);
  assert.ok(deltaBytes < legacyBytes / 100);
  console.log(JSON.stringify({ fixture: 'six-streams-800-messages-each-20-updates', legacyBytes, deltaBytes, reductionPercent: Math.round((1 - deltaBytes / legacyBytes) * 10000) / 100 }));
});
