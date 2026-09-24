import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppStore } from '../src/core/store.ts';
import { isNewerVersion, ReleaseCheck, RELEASES_PAGE, type ReleaseCheckOptions } from '../src/main/release-check.ts';

const PAGE = 'https://github.com/1798547983tt/Cardwright/releases/tag/v1.1.0';
const NOW = new Date('2026-09-24T08:00:00.000Z');

/** A stand-in for api.github.com on this machine; the checker is pointed at it, so no request leaves the computer. */
async function fakeGitHub(reply: () => { status?: number; body: unknown }) {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const { status = 200, body } = reply();
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/1798547983tt/Cardwright/releases/latest`;
  return { url, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function withFolder(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-release-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const options = (dir: string, url: string, extra: Partial<ReleaseCheckOptions> = {}): ReleaseCheckOptions =>
  ({ dataDir: dir, currentVersion: '1.0.0', url, fetch, enabled: () => true, notify: () => true, now: () => NOW, log: () => undefined, ...extra });

test('versions compare by number, a leading v is ignored and a pre-release is older than its release', () => {
  assert.equal(isNewerVersion('1.1.0', '1.0.0'), true);
  assert.equal(isNewerVersion('v1.0.10', '1.0.9'), true, 'numbers, not text');
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('2.0.0', '10.0.0'), false);
  assert.equal(isNewerVersion('v1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(isNewerVersion('1.1.0-beta.1', '1.1.0'), false, 'a pre-release is older than the release');
  assert.equal(isNewerVersion('1.1.0', '1.1.0-beta.1'), true);
  assert.equal(isNewerVersion('1.1.0-beta.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.1.0-beta.10', '1.1.0-beta.9'), true);
  for (const tag of ['nightly', '1.2', '', 'v', '1.2.3.4']) assert.equal(isNewerVersion(tag, '1.0.0'), false, `${tag || 'empty'} is no version`);
});

test('a newer release is announced once, from a plain GET, and only its version and page are kept', async () => withFolder(async dir => {
  const github = await fakeGitHub(() => ({ body: { tag_name: 'v1.1.0', html_url: PAGE, body: 'notes', assets: [{ browser_download_url: 'https://github.com/x/Cardwright-Setup-1.1.0.exe' }] } }));
  try {
    const shown: string[][] = [];
    await new ReleaseCheck(options(dir, github.url, { notify: (version, url) => { shown.push([version, url]); return true; } })).check();
    assert.deepEqual(shown, [['1.1.0', PAGE]]);
    assert.equal(github.requests.length, 1, 'one request: nothing is downloaded');
    const [request] = github.requests;
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.accept, 'application/vnd.github+json');
    assert.equal(request.headers['user-agent'], 'Cardwright/1.0.0');
    assert.equal(request.headers['content-length'], undefined, 'nothing is sent');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'release-check.json'), 'utf8')), { latest: '1.1.0', url: PAGE, checkedAt: NOW.toISOString(), notified: '1.1.0' });
    // After a restart the version is already announced: the check runs, the reminder does not come again.
    const again = new ReleaseCheck(options(dir, github.url, { notify: (version, url) => { shown.push([version, url]); return true; } }));
    await again.check();
    assert.equal(github.requests.length, 2);
    assert.equal(shown.length, 1, 'already notified: no second notification');
    assert.deepEqual(await again.read(), { current: '1.0.0', newer: true, latest: '1.1.0', url: PAGE, checkedAt: NOW.toISOString() });
    assert.deepEqual(await new ReleaseCheck(options(dir, github.url, { currentVersion: '1.1.0' })).read(), { current: '1.1.0', newer: false, checkedAt: NOW.toISOString() }, 'once installed, the release is not newer');
  } finally { await github.close(); }
}));

test('nothing is announced when the release is not newer, the switch is off or the network fails, and a failure is logged once', async () => withFolder(async dir => {
  let reply: { status?: number; body: unknown } = { body: { tag_name: 'v1.0.0', html_url: 'https://github.com/1798547983tt/Cardwright/releases/tag/v1.0.0' } };
  const github = await fakeGitHub(() => reply);
  try {
    let shown = 0; const logged: string[] = [];
    const checker = new ReleaseCheck(options(dir, github.url, { notify: () => { shown++; return true; }, log: message => { logged.push(message); } }));
    await checker.check();
    assert.deepEqual(await checker.read(), { current: '1.0.0', newer: false, checkedAt: NOW.toISOString() });
    await new ReleaseCheck(options(dir, github.url, { enabled: () => false, notify: () => { shown++; return true; } })).check();
    assert.equal(github.requests.length, 1, 'switched off: no request at all');
    reply = { status: 500, body: { message: 'Server Error' } };
    await checker.check();
    reply = { body: { tag_name: 'latest', html_url: PAGE } };
    await checker.check();
    assert.equal(shown, 0);
    assert.equal(logged.length, 1, 'a failing check is silent after the first log line');
    assert.deepEqual(await checker.read(), { current: '1.0.0', newer: false, checkedAt: NOW.toISOString() }, 'a failed check keeps what the last good one saw');
  } finally { await github.close(); }
}));

test('a reminder the system held back comes at the next check, and only a page of the project’s releases is opened', async () => withFolder(async dir => {
  const github = await fakeGitHub(() => ({ body: { tag_name: 'v2.0.0', html_url: 'https://github.com/1798547983tt/Cardwright/releases/../../../evil/download' } }));
  try {
    const shown: string[][] = []; let showing = false;
    const checker = new ReleaseCheck(options(dir, github.url, { notify: (version, url) => { shown.push([version, url]); return showing; } }));
    await checker.check();
    showing = true;
    await checker.check();
    await checker.check();
    assert.deepEqual(shown, [['2.0.0', RELEASES_PAGE], ['2.0.0', RELEASES_PAGE]], 'held back once, shown once, then quiet');
    assert.equal((await checker.read()).url, RELEASES_PAGE);
  } finally { await github.close(); }
}));

test('the reminder is on by default, and switching it off survives a restart', async () => withFolder(async dir => {
  assert.equal(new AppStore(dir).state.preferences.releaseCheck, true);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 7, preferences: { releaseCheck: false } }));
  assert.equal(new AppStore(dir).state.preferences.releaseCheck, false, 'the store keeps the switch, not only the default');
}));

test('the schedule checks after the first delay, then on every interval, until it is stopped', async () => withFolder(async dir => {
  const github = await fakeGitHub(() => ({ body: { tag_name: 'v1.0.0', html_url: PAGE } }));
  try {
    const stop = new ReleaseCheck(options(dir, github.url)).start(1, 20);
    for (let waited = 0; github.requests.length < 2 && waited < 3000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    stop();
    assert.ok(github.requests.length >= 2);
    await new Promise(resolve => setTimeout(resolve, 60));
    const seen = github.requests.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(github.requests.length, seen, 'no check after stop');
  } finally { await github.close(); }
}));
