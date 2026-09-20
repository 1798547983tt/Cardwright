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
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { language: 'zh', cardHandoff: { tokens: 120000, windowPercent: 40 }, developerMode: true } }));
    const store = new AppStore(dir);
    assert.deepEqual(store.state.preferences.cardHandoff, { tokens: 120000, windowPercent: 40 });
    assert.equal(store.state.preferences.developerMode, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('broken card studio settings fall back instead of loading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-preferences-'));
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { cardHandoff: { tokens: 'lots', windowPercent: 400 }, developerMode: 'yes' } }));
    const store = new AppStore(dir);
    assert.equal(store.state.preferences.cardHandoff, undefined);
    assert.equal(store.state.preferences.developerMode, undefined);
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
