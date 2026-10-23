import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/main/harness.ts';
import { StudioServices } from '../src/main/studio-services.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';
import { APP_VERSION } from '../src/shared/version.ts';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
const codec: SecretCodec = { encrypt: value => Buffer.from(`fixture-codec:${value}`), decrypt: value => value.toString().slice('fixture-codec:'.length) };
const feed = 'https://updates.example/cardwright-update.json';
const installer = Buffer.from('MZ test fixture installer; never execute');
const offer = (version: string) => ({ app: 'Cardwright', version, file: `Cardwright-Setup-${version}.exe`, sha256: createHash('sha256').update(installer).digest('hex') });
const newerThan = (version: string) => { const [major, minor, patch] = version.split('.').map(Number); return `${major}.${minor}.${patch + 1}`; };

/** The workbench as main.ts builds it, on a temp profile and an empty home. Call after `updateSource`: the updater takes the global fetch it finds when it is built. */
async function openApp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-version-test-'));
  const home = join(root, 'home'); const data = join(root, 'data');
  await Promise.all([mkdir(home), mkdir(data)]);
  const previousHome = process.env.CARDWRIGHT_SKILL_HOME; process.env.CARDWRIGHT_SKILL_HOME = home;
  const harness = new Harness(data, fakeWorker, new Vault(data, codec), { paused: true });
  const studio = new StudioServices(data, harness, resolve('dist/Cardwright.CommandHost.exe'), buffer => buffer);
  harness.attachStudio(studio);
  t.after(async () => {
    await harness.close();
    if (previousHome === undefined) delete process.env.CARDWRIGHT_SKILL_HOME; else process.env.CARDWRIGHT_SKILL_HOME = previousHome;
    const within = relative(resolve(tmpdir()), resolve(root));
    assert.ok(within.startsWith('cardwright-version-test-') && !within.includes('..'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, data, harness, studio };
}

/** An update source that offers whatever `release` returns, and lists every address asked for. */
function updateSource(t: TestContext, release: () => ReturnType<typeof offer>): string[] {
  const requested: string[] = []; const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => { const url = String(input); requested.push(url); return new Response(url === feed ? JSON.stringify(release()) : installer); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return requested;
}

test('the version the app reports is the version it is packaged as', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, metadata.version);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[''].version, metadata.version);
  assert.equal(metadata.version, '1.3.3');
});

test('the window is told that same version', async t => {
  const { harness } = await openApp(t);
  assert.equal(harness.snapshot().version, APP_VERSION);
});

test('the in-app updater counts from that same version', async t => {
  let released = offer(APP_VERSION);
  const requested = updateSource(t, () => released);
  const { studio } = await openApp(t);
  // This release and every earlier one (1.1.0 is what the updater once believed it was): nothing newer, nothing downloaded.
  for (const version of ['1.1.0', '1.2.0', APP_VERSION]) {
    released = offer(version);
    assert.deepEqual(await studio.updates.check(feed), { status: 'idle', version: APP_VERSION, message: 'No newer version is available from this source.' }, `${version} is not an update`);
  }
  assert.equal(requested.length, 3, 'only the feed was asked, never a package');
  // A release after this one is offered and brought in.
  const next = newerThan(APP_VERSION); released = offer(next);
  const ready = await studio.updates.check(feed);
  assert.equal(ready.status, 'ready'); assert.equal(ready.version, next);
});

test('an update is filed against that version: the downgrade guard, the pre-update backups and the rollback installer', async t => {
  updateSource(t, () => offer(APP_VERSION));
  const { root, data, studio } = await openApp(t);
  const source = join(root, 'source'); await mkdir(source);
  const manifestFor = async (version: string) => { const path = join(source, `update-${version}.json`); await writeFile(join(source, offer(version).file), installer); await writeFile(path, JSON.stringify(offer(version))); return path; };
  await assert.rejects(studio.updates.import(await manifestFor(APP_VERSION)), /newer version/);
  // The profile the update must be able to roll back to, and the installer this app was installed from.
  await Promise.all([writeFile(join(data, 'state.json'), '{}'), writeFile(join(data, 'studio.json'), '{}')]);
  await mkdir(studio.updates.root, { recursive: true }); await writeFile(join(studio.updates.root, `Cardwright-${APP_VERSION}.exe`), 'the installer this app came from');
  assert.equal((await studio.updates.import(await manifestFor(newerThan(APP_VERSION)))).status, 'ready');
  await studio.updates.prepareInstall();
  for (const name of ['state', 'studio']) assert.ok((await stat(join(studio.updates.root, 'backups', `${name}-${APP_VERSION}.json`))).isFile(), `${name} is backed up under ${APP_VERSION}`);
  const rollback = JSON.parse(await readFile(join(studio.updates.root, 'rollback.json'), 'utf8'));
  assert.equal(rollback.version, APP_VERSION); assert.equal(rollback.path, join(studio.updates.root, `Cardwright-${APP_VERSION}.exe`));
});
