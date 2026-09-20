import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore, STATE_SCHEMA_VERSION } from '../src/core/store.ts';

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'cw-store-batch-'));
  return { root, async close() { assert.match(root, /cw-store-batch-/); await rm(root, { recursive: true, force: true }); } };
}

test('stream saves are batched and flush persists the newest requested state', async () => {
  const f = await directory();
  try {
    const store = new AppStore(f.root);
    for (let i = 0; i < 100; i++) { store.state.preferences.name = `name-${i}`; store.requestSave(1000); }
    await assert.rejects(readFile(store.filePath));
    await store.flush();
    const saved = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(saved.preferences.name, 'name-99'); assert.equal(saved.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
  } finally { await f.close(); }
});

test('a pending asynchronous save cannot overwrite a newer critical synchronous save', async () => {
  const f = await directory();
  try {
    const store = new AppStore(f.root); store.state.preferences.name = 'old'; store.requestSave(1000);
    const pending = store.flush();
    store.state.preferences.name = 'critical'; store.save();
    await pending; await store.flush();
    assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).preferences.name, 'critical');
  } finally { await f.close(); }
});

test('legacy migration preserves exact original bytes and reuses its backup', async () => {
  const f = await directory();
  try {
    const original = ' { "preferences": { "name": "original" }, "tasks": [] }\n';
    await writeFile(join(f.root, 'state.json'), original);
    const first = new AppStore(f.root); assert.ok(first.migrationBackup);
    assert.equal(await readFile(first.migrationBackup, 'utf8'), original);
    assert.equal(await readFile(first.filePath, 'utf8'), original);
    const second = new AppStore(f.root); assert.equal(second.migrationBackup, first.migrationBackup);
    second.save();
    assert.equal(new AppStore(f.root).migrationBackup, undefined);
    assert.equal((await readdir(join(f.root, 'backups'))).length, 1);
  } finally { await f.close(); }
});

test('background save errors are observable and recover through explicit flush', async () => {
  const f = await directory();
  try {
    const store = new AppStore(f.root); await mkdir(store.filePath);
    let errors = 0; store.onSaveError = () => errors++;
    store.requestSave(0);
    const deadline = Date.now() + 5000;
    while (!errors && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(store.lastSaveError); assert.equal(errors, 1);
    await rmdir(store.filePath);
    await store.flush(); assert.equal(store.lastSaveError, undefined);
    assert.ok(await readFile(store.filePath, 'utf8'));
  } finally { await f.close(); }
});
