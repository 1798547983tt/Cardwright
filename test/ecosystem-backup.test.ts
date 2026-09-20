import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ConfigBackup, validateBackupData, type BackupData } from '../src/main/ecosystem-backup.ts';
import type { AppSnapshot } from '../src/shared/types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-backup-')); const skillPath = join(root, 'selected-skill', 'SKILL.md');
  await mkdir(dirname(skillPath)); await writeFile(skillPath, '# A skill\nPreserve model-private-key as a warning example.');
  await writeFile(join(dirname(skillPath), 'private-script.js'), 'private-neighbor-secret');
  const snapshot: AppSnapshot = {
    version: '0.3.0', preferences: { name: 'User', theme: 'dark', language: 'en', font: 'sans', reducedMotion: true, notifications: true, instructions: 'Never share model-private-key',
      defaultPermission: 'full', maxConcurrent: 3, defaultGatewayId: 'model', defaultThinking: 'medium', skillPaths: [dirname(skillPath)], avatars: { user: 'private-avatar-path' }, soundEnabled: true, soundVolume: 40 },
    gateways: [{ id: 'model', name: 'Gateway', baseUrl: 'https://gateway.example/v1?api_key=model-private-key', modelId: 'test-model', protocol: 'openai-responses', reasoning: false, contextWindow: 16000, maxTokens: 2000, hasKey: true }],
    search: { enabled: true, provider: 'auto', baseUrl: '', hasKey: true },
    ecosystem: { memoryEnabled: true, cacheEnabled: true, showStatusline: true, compactTools: true, roles: [{ id: 'reviewer', name: 'Reviewer', prompt: 'Review model-private-key', readOnly: true }],
      mcpServers: [{ id: 'local', name: 'Local', enabled: true, transport: 'stdio', command: 'node', args: ['server.mjs', '--api-key', 'model-private-key', '--mode', 'safe'], hasSecrets: true }],
      webdav: { url: 'https://private.example/', username: 'private-account', hasPassword: true } },
    projects: [{ id: 'project', name: 'Project', path: join(root, 'private-workspace'), isGit: false, createdAt: '2026-09-16T00:00:00.000Z' }],
    tasks: [], schedules: [], approvals: [], skills: [{ name: 'test-skill', description: 'fixture', path: skillPath }], extensions: [], interactions: [], hooks: {},
  };
  const requests: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = [];
  let stored = ''; let redirect = false; let declaredSize = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(); requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
    if (redirect) { response.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end(); return; }
    if (request.method === 'PUT') { stored = body; response.writeHead(201).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', ...(declaredSize ? { 'Content-Length': String(declaredSize) } : {}) }).end(stored);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = { url: `http://127.0.0.1:${address.port}/dav`, username: 'fixture-user', password: 'webdav-private-password' };
  const applied: Array<BackupData & { importedSkillPaths: string[] }> = [];
  const backup = new ConfigBackup({ dataDir: join(root, 'appdata'), getSnapshot: () => snapshot,
    listMemories: async () => ({ project: [{ id: 'memory', content: 'Decision with model-private-key', category: 'decision', source: join(root, 'transcript.jsonl'), createdAt: '2026-09-16T00:00:00.000Z' }] }),
    readSecretValues: () => ['model-private-key', connection.password], apply: async data => { applied.push(data); } });
  return { root, skillPath, snapshot, requests, backup, connection, applied,
    getStored: () => stored, setStored: (value: string) => { stored = value; }, setRedirect: () => { redirect = true; }, setSize: (value: number) => { declaredSize = value; },
    async cleanup() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(basename(root), /^cardwright-backup-/); await rm(root, { recursive: true, force: true }); },
  };
}

test('manual backup uses a reviewable allowlist and strips credentials, history, paths and neighbor assets', async () => {
  const f = await fixture();
  try {
    const preview = await f.backup.preview('local', f.connection); assert.equal(f.requests.length, 0);
    assert.ok(preview.files.some(file => file.endsWith('/SKILL.md'))); assert.ok(preview.files.includes('memories/project.json'));
    assert.ok(preview.excludes.some(text => text.includes('Unknown secrets')));
    await f.backup.push(f.connection); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'PUT'); assert.equal(f.requests[0].url, '/dav/cardwright-config.json');
    assert.equal(f.requests[0].authorization, `Basic ${Buffer.from('fixture-user:webdav-private-password').toString('base64')}`);
    const text = f.getStored(); assert.equal(Buffer.byteLength(text), preview.bytes);
    for (const forbidden of ['model-private-key', 'webdav-private-password', 'private-neighbor-secret', 'private-avatar-path', 'private-workspace', 'private-account', 'defaultPermission', 'skillPaths', 'transcript.jsonl']) assert.equal(text.includes(forbidden), false, forbidden);
    const data = JSON.parse(text); assert.equal(data.gateways[0].hasKey, false); assert.equal(data.gateways[0].baseUrl, 'https://gateway.example/v1');
    assert.equal(data.ecosystem.mcpServers[0].enabled, false); assert.deepEqual(data.ecosystem.mcpServers[0].args, ['server.mjs', '--mode', 'safe']);
    assert.match(data.skills[0].content, /\[redacted\]/); assert.match(data.memories[0].items[0].content, /\[redacted\]/);
    await assert.rejects(f.backup.push(f.connection), /Preview/);
  } finally { await f.cleanup(); }
});

test('push requires a fresh matching local preview and bound connection', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backup.push(f.connection), /Preview/); assert.equal(f.requests.length, 0);
    await f.backup.preview('local', f.connection); f.snapshot.preferences.instructions = 'Changed after preview';
    await assert.rejects(f.backup.push(f.connection), /changed/); assert.equal(f.requests.length, 0);
    await f.backup.preview('local', f.connection); await writeFile(f.skillPath, '# Modified skill');
    await assert.rejects(f.backup.push(f.connection), /changed/);
    await f.backup.preview('local', f.connection);
    await assert.rejects(f.backup.push({ ...f.connection, username: 'another-user' }), /connection changed/);
    assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});

test('pull validates refetched content and restores only generated skill paths through apply callback', async () => {
  const f = await fixture();
  try {
    await f.backup.preview('local', f.connection); await f.backup.push(f.connection);
    const preview = await f.backup.preview('remote', f.connection); assert.equal(preview.bytes, Buffer.byteLength(f.getStored()));
    await f.backup.pull(f.connection); assert.equal(f.applied.length, 1); assert.equal(f.applied[0].importedSkillPaths.length, 1);
    const path = f.applied[0].importedSkillPaths[0]; assert.ok(path.startsWith(join(f.root, 'appdata', 'imported-skills'))); assert.equal(basename(path), 'SKILL.md');
    assert.equal(await readFile(path, 'utf8'), f.applied[0].skills[0].content);
    assert.equal(f.snapshot.preferences.defaultPermission, 'full'); assert.equal(f.snapshot.gateways[0].hasKey, true);
    assert.equal(f.applied[0].ecosystem.mcpServers[0].enabled, false);
    await f.backup.preview('remote', f.connection);
    const changed = JSON.parse(f.getStored()); changed.preferences.name = 'Changed'; f.setStored(JSON.stringify(changed));
    await assert.rejects(f.backup.pull(f.connection), /remote backup changed/); assert.equal(f.applied.length, 1);
  } finally { await f.cleanup(); }
});

test('remote schema rejects credentials, prototype keys and paths before apply', async () => {
  const f = await fixture();
  try {
    await f.backup.preview('local', f.connection); await f.backup.push(f.connection); const valid = f.getStored();
    const malicious = [
      (data: Record<string, any>) => { data.auth = { password: 'remote-secret' }; },
      (data: Record<string, any>) => { data.ecosystem.mcpServers[0].headers = { Authorization: 'secret' }; },
      (data: Record<string, any>) => { data.preferences.skillPaths = ['C:/private']; },
      (data: Record<string, any>) => { data.skills[0].id = '../../escape'; },
      (data: Record<string, any>) => { data.ecosystem.mcpServers[0].enabled = true; },
      (data: Record<string, any>) => { data.gateways[0].hasKey = true; },
    ];
    for (const edit of malicious) { const data = JSON.parse(valid); edit(data); f.setStored(JSON.stringify(data)); await assert.rejects(f.backup.preview('remote', f.connection)); }
    f.setStored(valid.replace('{', '{"__proto__":{"polluted":true},')); await assert.rejects(f.backup.preview('remote', f.connection));
    assert.equal(f.applied.length, 0); assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    const wrongVersion = JSON.parse(valid); wrongVersion.version = 2; assert.throws(() => validateBackupData(wrongVersion), /version/);
  } finally { await f.cleanup(); }
});

test('remote transfer rejects oversized bodies and redirects without exposing credentials', async () => {
  const f = await fixture();
  try {
    f.setStored('{}'); f.setSize(6 * 1024 * 1024); await assert.rejects(f.backup.preview('remote', f.connection), /5 MB/);
    f.setSize(0); f.setRedirect();
    await assert.rejects(f.backup.preview('remote', f.connection), error => error instanceof Error && /redirects/.test(error.message) && !error.message.includes(f.connection.password));
    assert.equal(f.applied.length, 0); assert.equal(f.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('restoration refuses a redirected imported-skills directory and does not write outside app storage', async () => {
  const f = await fixture();
  try {
    await f.backup.preview('local', f.connection); await f.backup.push(f.connection); await f.backup.preview('remote', f.connection);
    const appDir = join(f.root, 'appdata'); const outside = join(f.root, 'outside'); await mkdir(appDir); await mkdir(outside);
    await symlink(outside, join(appDir, 'imported-skills'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.backup.pull(f.connection), /inside application storage/); assert.deepEqual(await readdir(outside), []); assert.equal(f.applied.length, 0);
  } finally { await f.cleanup(); }
});
