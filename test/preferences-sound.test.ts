import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppStore } from '../src/core/store.ts';

test('0.9 starts quiet: no sounds, no startup animation, and invalid saved values fall back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-sound-'));
  try {
    const fresh = new AppStore(dir);
    assert.equal(fresh.state.preferences.soundEnabled, false);
    assert.equal(fresh.state.preferences.bootSequence, false);
    assert.equal(fresh.state.preferences.soundVolume, 40);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { soundEnabled: 'yes', soundVolume: 500 } }));
    const invalid = new AppStore(dir);
    assert.equal(invalid.state.preferences.soundEnabled, false);
    assert.equal(invalid.state.preferences.soundVolume, 40);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { soundEnabled: false, soundVolume: 65 } }));
    const saved = new AppStore(dir);
    assert.equal(saved.state.preferences.soundEnabled, false);
    assert.equal(saved.state.preferences.soundVolume, 65);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
