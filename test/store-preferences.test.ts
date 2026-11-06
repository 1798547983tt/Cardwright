import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppStore } from '../src/core/store.ts';

// The store keeps an explicit list of saved preferences; a new setting that is missing there silently resets on restart.
test('the card studio settings survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { language: 'zh', cardHandoff: { tokens: 120000, windowPercent: 40 } } }));
    const store = new AppStore(dir);
    assert.deepEqual(store.state.preferences.cardHandoff, { tokens: 120000, windowPercent: 40 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('broken card studio settings fall back instead of loading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { cardHandoff: { tokens: 'lots', windowPercent: 400 } } }));
    const store = new AppStore(dir);
    assert.equal(store.state.preferences.cardHandoff, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the 0.9 settings survive a restart: notification switches, disabled subagents and hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      schemaVersion: 7,
      preferences: { notifyFinished: false, notifyApproval: true, disabledAgentIds: ['agent:user:reviewer'] },
      hooks: { PreToolUse: [{ matcher: 'write', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'echo no' }] }] },
    }));
    const store = new AppStore(dir);
    assert.equal(store.state.preferences.notifyFinished, false);
    assert.equal(store.state.preferences.notifyApproval, true);
    assert.deepEqual(store.state.preferences.disabledAgentIds, ['agent:user:reviewer']);
    assert.deepEqual(Object.keys(store.state.hooks), ['PreToolUse'], 'an event Cardwright has no moment for is dropped');
    assert.equal(store.state.hooks.PreToolUse?.[0].hooks[0].command, 'echo hi');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// parseState copies preferences through an allow-list on every load and every save; a setting missing there resets.
test('小绘的性格 is on by default, survives a save and a load when switched off, and a broken value counts as on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    const fresh = new AppStore(dir);
    assert.equal(fresh.state.preferences.persona, true, 'absent means on');
    fresh.state.preferences.persona = false;
    fresh.save();
    assert.equal(new AppStore(dir).state.preferences.persona, false, 'kept through save and load');
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 8, preferences: { persona: 'off' } }));
    assert.equal(new AppStore(dir).state.preferences.persona, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 工坊小队 (spec §5.4): parseState keeps an explicit list, so the setting has to round-trip through a save and a load.
test('the squad settings survive a save and a restart; a missing 自行组队 takes its default and an unknown mode is dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    const store = new AppStore(dir);
    assert.equal(store.state.preferences.cardSquad, undefined, 'no setting until the user picks one');
    store.state.preferences.cardSquad = { mode: 'write', selfDispatch: false };
    store.save();
    assert.deepEqual(new AppStore(dir).state.preferences.cardSquad, { mode: 'write', selfDispatch: false });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 8, preferences: { cardSquad: { mode: 'read' } } }));
    assert.deepEqual(new AppStore(dir).state.preferences.cardSquad, { mode: 'read', selfDispatch: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 8, preferences: { cardSquad: { mode: 'everything', selfDispatch: false } } }));
    assert.equal(new AppStore(dir).state.preferences.cardSquad, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('1.2 role data moves to executor / explorer / planner, and a custom role on a reserved id keeps its prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    const task = (id: string, role?: string) => ({ id, projectId: 'p', title: id, cwd: dir, status: 'completed', permission: 'ask', gatewayId: 'g', thinking: 'medium', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', messages: [], tools: [], ...(role ? { role } : {}) });
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      schemaVersion: 8,
      preferences: { disabledAgentIds: ['Plan', 'planner', 'agent:user:reviewer'] },
      ecosystem: { roles: [
        { id: 'general-purpose', name: 'General purpose', prompt: 'old', readOnly: false, builtIn: true },
        { id: 'Explore', name: 'Explore', prompt: 'old', readOnly: true, builtIn: true },
        { id: 'Plan', name: 'Plan', prompt: 'old', readOnly: true, builtIn: true },
        { id: 'reviewer', name: '审查员', prompt: '只看不改。', readOnly: true, builtIn: false },
        { id: 'planner', name: '我的规划', prompt: '按我的格式写计划。', readOnly: false, builtIn: false },
      ] },
      tasks: [task('a', 'general-purpose'), task('b', 'Explore'), task('c', 'Plan'), task('d', 'planner'), task('e', 'reviewer'), task('f')],
    }));
    const store = new AppStore(dir);
    const roleIds = ['executor', 'explorer', 'planner', 'reviewer', 'planner-custom'];
    const taskRoles = ['executor', 'explorer', 'planner', 'planner-custom', 'reviewer', undefined];
    assert.deepEqual(store.state.ecosystem.roles.map(role => role.id), roleIds);
    assert.deepEqual(store.state.ecosystem.roles.find(role => role.id === 'planner-custom'), { id: 'planner-custom', name: '我的规划', prompt: '按我的格式写计划。', readOnly: false, builtIn: false });
    assert.deepEqual(store.state.tasks.map(item => item.role), taskRoles);
    assert.deepEqual(store.state.preferences.disabledAgentIds, ['planner', 'planner-custom', 'agent:user:reviewer']);
    store.save();
    const reopened = new AppStore(dir);
    assert.deepEqual(reopened.state.ecosystem.roles.map(role => role.id), roleIds, 'nothing moves twice');
    assert.deepEqual(reopened.state.tasks.map(item => item.role), taskRoles);
    assert.deepEqual(reopened.state.preferences.disabledAgentIds, ['planner', 'planner-custom', 'agent:user:reviewer']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the 1.3 subagent switches survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 8, preferences: { enabledAgentIds: ['agent:project:p1:reviewer', 7], disabledAgentIds: ['agent:user:helper'] } }));
    const store = new AppStore(dir);
    assert.deepEqual(store.state.preferences.enabledAgentIds, ['agent:project:p1:reviewer'], 'what is not an id is dropped');
    store.save();
    assert.deepEqual(new AppStore(dir).state.preferences.enabledAgentIds, ['agent:project:p1:reviewer']);
    assert.deepEqual(new AppStore(dir).state.preferences.disabledAgentIds, ['agent:user:helper']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the move never makes a read-only role writable: built-in roles come from the app, and a read-only custom role on a reserved id keeps its tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    const task = (id: string, role: string) => ({ id, projectId: 'p', title: id, cwd: dir, status: 'completed', permission: 'ask', gatewayId: 'g', thinking: 'medium', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', messages: [], tools: [], role });
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      schemaVersion: 8,
      ecosystem: { roles: [
        { id: 'Explore', name: 'Explore', prompt: 'edited by hand', readOnly: false, builtIn: true },
        { id: 'executor', name: '只看的执行', prompt: '只看不改。', readOnly: true, builtIn: false },
      ] },
      tasks: [task('a', 'Explore'), task('b', 'executor')],
    }));
    const { state } = new AppStore(dir);
    const readOnly = (id?: string) => state.ecosystem.roles.find(role => role.id === id)?.readOnly;
    assert.deepEqual(state.tasks.map(item => [item.role, readOnly(item.role)]), [['explorer', true], ['executor-custom', true]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
