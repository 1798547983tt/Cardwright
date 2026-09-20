import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { canonicalPath, decidePermission } from '../src/runtime/permissions.ts';

async function cleanup(dir: string) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.match(dir, /cardwright-(permissions|links)-/);
  await rm(dir, { recursive: true, force: true });
}

test('permission modes enforce file and shell boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-permissions-'));
  const cwd = join(dir, 'project');
  await mkdir(cwd);
  await writeFile(join(cwd, 'readme.txt'), 'hello');
  try {
    assert.equal((await decidePermission(cwd, 'ask', 'read', { path: 'readme.txt' })).approvedAutomatically, true);
    assert.equal((await decidePermission(cwd, 'ask', 'write', { path: 'new/a.txt' })).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'edit', 'write', { path: 'new/a.txt' })).approvedAutomatically, true);
    assert.equal((await decidePermission(cwd, 'edit', 'read', { path: '../other.txt' })).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'edit', 'write', { path: '../other.txt' })).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'edit', 'powershell', { command: 'Get-ChildItem' })).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'full', 'powershell', { command: 'Get-ChildItem' })).approvedAutomatically, true);
    assert.equal((await decidePermission(cwd, 'ask', 'ls', {})).approvedAutomatically, true);
    await assert.rejects(decidePermission(cwd, 'edit', 'write', {}), /requires a file path/);
  } finally { await cleanup(dir); }
});

test('existing junction ancestors and path-prefix siblings cannot bypass approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-links-'));
  const cwd = join(dir, 'project');
  const outside = join(dir, 'project-other');
  await mkdir(cwd);
  await mkdir(outside);
  await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const escaped = await decidePermission(cwd, 'edit', 'write', { path: 'escape/new/nested.txt' });
    assert.equal(escaped.approvedAutomatically, false);
    assert.equal(escaped.resolvedPath, await canonicalPath('new/nested.txt', outside));
    assert.equal((await decidePermission(cwd, 'ask', 'ls', { path: outside })).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'full', 'write', { path: 'escape/new.txt' })).approvedAutomatically, true);
  } finally { await cleanup(dir); }
});

test('reads inside an extra read-only root are approved while writes there still need approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cardwright-permissions-'));
  const cwd = join(dir, 'project');
  const resources = join(dir, 'resources');
  const sibling = join(dir, 'resources-private');
  await mkdir(cwd); await mkdir(join(resources, 'knowledge'), { recursive: true }); await mkdir(sibling);
  await writeFile(join(resources, 'knowledge', 'README.md'), 'index');
  await writeFile(join(sibling, 'secret.txt'), 'no');
  try {
    const options = { readRoots: [resources] };
    assert.equal((await decidePermission(cwd, 'edit', 'read', { path: join(resources, 'knowledge', 'README.md') }, options)).approvedAutomatically, true);
    assert.equal((await decidePermission(cwd, 'ask', 'ls', { path: resources }, options)).approvedAutomatically, true);
    assert.equal((await decidePermission(cwd, 'edit', 'read', { path: join(sibling, 'secret.txt') }, options)).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'edit', 'write', { path: join(resources, 'knowledge', 'README.md') }, options)).approvedAutomatically, false);
    assert.equal((await decidePermission(cwd, 'edit', 'read', { path: join(resources, 'knowledge', 'README.md') })).approvedAutomatically, false);
  } finally { await cleanup(dir); }
});
