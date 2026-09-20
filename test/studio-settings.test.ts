import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppStore } from '../src/core/store.ts';
import { validateAvatar } from '../src/core/avatar.ts';
import { externalUrl } from '../src/core/external-url.ts';
import { Harness } from '../src/main/harness.ts';
import { Vault } from '../src/main/vault.ts';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aANsAAAAASUVORK5CYII=';

test('legacy settings migrate to independent search and avatars without losing user fields or history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-studio-'));
  try {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ preferences: { name: 'Legacy user', theme: 'dark', instructions: 'Keep my instructions.', defaultPermission: 'full' }, tasks: [{ id: 'legacy-task', status: 'completed', messages: [{ role: 'assistant', text: 'History retained.' }], tools: [] }] }));
    const store = new AppStore(directory);
    assert.equal(store.state.preferences.name, 'Legacy user');
    assert.equal(store.state.preferences.defaultPermission, 'full');
    assert.equal(store.state.tasks[0].messages[0].text, 'History retained.');
    assert.equal(store.state.search.enabled, true);
    assert.equal(store.state.search.provider, 'auto');
    store.state.preferences.avatars = { user: png, assistant: png };
    store.save();
    const reopened = new AppStore(directory);
    assert.deepEqual(reopened.state.preferences.avatars, { user: png, assistant: png });
    assert.equal(reopened.state.preferences.instructions, 'Keep my instructions.');
  } finally { assert.ok(relative(tmpdir(), directory).startsWith('cardwright-studio-')); await rm(directory, { recursive: true, force: true }); }
});

test('avatar data forbids remote sources, SVG and oversized image dimensions', () => {
  assert.equal(validateAvatar(png), png);
  assert.equal(validateAvatar(undefined), undefined);
  assert.throws(() => validateAvatar('https://example.com/avatar.png'));
  assert.throws(() => validateAvatar('data:image/svg+xml,<svg onload="alert(1)"/>'));
  const bytes = Buffer.from(png.split(',')[1], 'base64'); bytes.writeUInt32BE(513, 16);
  assert.throws(() => validateAvatar(`data:image/png;base64,${bytes.toString('base64')}`));
  bytes.writeUInt32BE(512, 16); bytes.writeUInt32BE(512, 20);
  assert.ok(validateAvatar(`data:image/png;base64,${bytes.toString('base64')}`), '512px avatars are allowed for large portraits');
  assert.throws(() => validateAvatar(`data:image/png;base64,${'A'.repeat(1_300_000)}`));
  const jpeg = (width: number, height: number) => `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64')}`;
  assert.equal(validateAvatar(jpeg(512, 512)), jpeg(512, 512));
  assert.throws(() => validateAvatar(jpeg(513, 512)));
  assert.throws(() => validateAvatar(`data:image/jpeg;base64,${Buffer.from('not a jpeg image').toString('base64')}`));
});

test('external source links permit web URLs and reject executable or credential-bearing targets', () => {
  assert.equal(externalUrl('https://example.com/docs?q=hello#section'), 'https://example.com/docs?q=hello#section');
  for (const value of ['javascript:alert(1)', 'file:///C:/Windows/system32', 'data:text/html,test', 'mailto:x@example.com', 'https://user:pass@example.com/']) assert.throws(() => externalUrl(value));
});

test('search credentials stay out of snapshots and avatars reset independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-studio-'));
  const vault = new Vault(directory, { encrypt: value => Buffer.from(value).reverse(), decrypt: value => Buffer.from(value).reverse().toString() });
  const harness = new Harness(directory, fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url)), vault);
  try {
    assert.throws(() => harness.saveSearch({ enabled: true, provider: 'brave', baseUrl: '' }));
    harness.saveSearch({ enabled: true, provider: 'brave', baseUrl: 'https://ignored.invalid' }, 'search-secret-fixture');
    assert.equal(harness.snapshot().search.hasKey, true);
    assert.equal(harness.snapshot().search.baseUrl, '');
    assert.ok(!JSON.stringify(harness.snapshot()).includes('search-secret-fixture'));
    assert.ok(!(await readFile(join(directory, 'state.json'), 'utf8')).includes('search-secret-fixture'));
    harness.saveSearch({ enabled: true, provider: 'searxng', baseUrl: 'http://127.0.0.1:9999/search' });
    assert.equal(harness.snapshot().search.baseUrl, 'http://127.0.0.1:9999');
    assert.throws(() => harness.saveSearch({ enabled: true, provider: 'searxng', baseUrl: 'https://user:pass@example.com/' }));
    harness.setAvatar('user', png); harness.setAvatar('assistant', png); harness.setAvatar('user');
    assert.equal(harness.snapshot().preferences.avatars?.user, undefined);
    assert.equal(harness.snapshot().preferences.avatars?.assistant, png);
    assert.throws(() => harness.setAvatar('assistant', 'data:image/svg+xml,bad'));
    assert.equal(harness.snapshot().preferences.avatars?.assistant, png);
  } finally { await harness.close(); assert.ok(relative(tmpdir(), directory).startsWith('cardwright-studio-')); await rm(directory, { recursive: true, force: true }); }
});

test('effective reasoning level from worker is shown instead of the requested unsupported level', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-studio-'));
  const projectPath = join(directory, 'project'); await mkdir(projectPath);
  const vault = new Vault(directory, { encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
  const harness = new Harness(join(directory, 'data'), fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url)), vault);
  try {
    harness.saveGateway({ id: 'fixture', name: 'Fixture', baseUrl: 'https://example.invalid/v1', modelId: 'fixture', protocol: 'openai-completions', reasoning: false, contextWindow: 8192, maxTokens: 1024 }, 'fake-key');
    const project = await harness.addProject(projectPath);
    const task = await harness.createTask({ projectId: project.id, prompt: 'effective-thinking', thinking: 'high', isolated: false });
    const end = Date.now() + 10_000;
    while (harness.snapshot().tasks.find(item => item.id === task.id)?.status !== 'completed') {
      if (Date.now() > end) throw new Error('Worker completion timed out.');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(harness.snapshot().tasks.find(item => item.id === task.id)?.thinking, 'off');
  } finally { await harness.close(); assert.ok(relative(tmpdir(), directory).startsWith('cardwright-studio-')); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
