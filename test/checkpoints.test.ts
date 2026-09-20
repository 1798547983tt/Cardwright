import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CheckpointService, ReviewDriftError } from '../src/core/checkpoints.ts';
import { reviewCommentsPrompt } from '../src/core/review.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-checkpoints-')); const cwd = join(root, 'project'); const data = join(root, 'data'); await mkdir(cwd);
  t.after(async () => { assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith('cardwright-checkpoints-')); await rm(root, { recursive: true, force: true }); });
  return { cwd, data, service: new CheckpointService(data) };
}
test('checkpoints restore a real text hunk, preserve CRLF and keep unrelated edits', async t => {
  const { cwd, service } = await fixture(t); const original = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n'; await writeFile(join(cwd, 'source.txt'), original);
  const checkpoint = await service.capture('task', 'turn', cwd); const edited = original.replace('line 2\r\n', 'changed A\r\n').replace('line 25\r\n', 'changed B\r\n'); await writeFile(join(cwd, 'source.txt'), edited); await writeFile(join(cwd, 'unrelated.txt'), 'human note');
  const review = await service.diff(checkpoint.id); const file = review.files.find(file => file.path === 'source.txt')!; assert.equal(file.hunks.length, 2);
  const after = await service.reviewAction({ checkpointId: checkpoint.id, path: file.path, hunkId: file.hunks[0].id, action: 'revert', expectedHash: file.afterHash });
  assert.equal(await readFile(join(cwd, 'source.txt'), 'utf8'), original.replace('line 25\r\n', 'changed B\r\n')); assert.equal(await readFile(join(cwd, 'unrelated.txt'), 'utf8'), 'human note');
  assert.equal(after.files.find(file => file.path === 'source.txt')!.hunks.length, 1); assert.equal((await service.listAudit(checkpoint.id))[0].action, 'revert');
});
test('accept and inline comments persist without changing the working file', async t => {
  const { cwd, data, service } = await fixture(t); await writeFile(join(cwd, 'app.ts'), 'old'); const checkpoint = await service.capture('task', 'turn', cwd); await writeFile(join(cwd, 'app.ts'), 'new');
  const file = (await service.diff(checkpoint.id)).files[0]; const accepted = await service.reviewAction({ checkpointId: checkpoint.id, path: file.path, action: 'accept', expectedHash: file.afterHash }); assert.equal(accepted.files[0].accepted, true); assert.equal(await readFile(join(cwd, 'app.ts'), 'utf8'), 'new');
  const comment = await service.addComment({ checkpointId: checkpoint.id, path: 'app.ts', side: 'after', line: 1, text: 'Preserve the original public name.' });
  const restarted = new CheckpointService(data); assert.deepEqual(await restarted.listComments(checkpoint.id), [comment]); assert.match(reviewCommentsPrompt([comment]), /original public name/); assert.equal((await restarted.list('task')).length, 1);
});
test('file restore supports binary, new and deleted files without newline changes', async t => {
  const { cwd, service } = await fixture(t); const binary = Buffer.from([0, 255, 1, 4]); await writeFile(join(cwd, 'picture.bin'), binary); await writeFile(join(cwd, 'deleted.txt'), 'no final newline'); const checkpoint = await service.capture('task', 'turn', cwd);
  await writeFile(join(cwd, 'picture.bin'), Buffer.from([0, 24])); await rm(join(cwd, 'deleted.txt')); await writeFile(join(cwd, 'new.txt'), 'new content');
  for (const file of (await service.diff(checkpoint.id)).files) { if (file.path === 'picture.bin') assert.equal(file.binary, true); await service.reviewAction({ checkpointId: checkpoint.id, path: file.path, action: 'revert', expectedHash: file.afterHash }); }
  assert.deepEqual(await readFile(join(cwd, 'picture.bin')), binary); assert.equal(await readFile(join(cwd, 'deleted.txt'), 'utf8'), 'no final newline'); await assert.rejects(readFile(join(cwd, 'new.txt')), { code: 'ENOENT' }); assert.equal((await service.diff(checkpoint.id)).files.length, 0);
});
test('stale review cannot overwrite a later human edit, including comments on old hunks', async t => {
  const { cwd, service } = await fixture(t); await writeFile(join(cwd, 'app.txt'), 'baseline'); const checkpoint = await service.capture('task', 'turn', cwd); await writeFile(join(cwd, 'app.txt'), 'agent edit'); const file = (await service.diff(checkpoint.id)).files[0]; await writeFile(join(cwd, 'app.txt'), 'human edit');
  await assert.rejects(service.reviewAction({ checkpointId: checkpoint.id, path: file.path, action: 'revert', expectedHash: file.afterHash }), ReviewDriftError); assert.equal(await readFile(join(cwd, 'app.txt'), 'utf8'), 'human edit');
  await assert.rejects(service.reviewAction({ checkpointId: checkpoint.id, path: '../outside', action: 'revert', expectedHash: null }), /relative/);
});
test('hunk restore respects inserted lines, EOF markers and newly created files', async t => {
  const { cwd, service } = await fixture(t); const original = Array.from({ length: 35 }, (_, index) => `line ${index}`).join('\n'); await writeFile(join(cwd, 'source'), original); const checkpoint = await service.capture('task', 'turn', cwd);
  const changed = original.replace('line 2\n', 'line 2\nextra one\nextra two\n').replace('line 30\n', 'last edit\n'); await writeFile(join(cwd, 'source'), changed);
  const file = (await service.diff(checkpoint.id)).files[0]; assert.equal(file.hunks.length, 2); await service.reviewAction({ checkpointId: checkpoint.id, path: file.path, hunkId: file.hunks[1].id, action: 'revert', expectedHash: file.afterHash }); assert.equal(await readFile(join(cwd, 'source'), 'utf8'), original.replace('line 2\n', 'line 2\nextra one\nextra two\n'));
  await writeFile(join(cwd, 'newfile'), 'brand new without newline'); const added = (await service.diff(checkpoint.id)).files.find(file => file.path === 'newfile')!; await service.reviewAction({ checkpointId: checkpoint.id, path: added.path, hunkId: added.hunks[0].id, action: 'revert', expectedHash: added.afterHash }); await assert.rejects(readFile(join(cwd, 'newfile')), { code: 'ENOENT' });
});
test('checkpoints ignore build trees and do not follow directory links; limits fail closed', async t => {
  const { cwd, data, service } = await fixture(t); await mkdir(join(cwd, 'node_modules')); await writeFile(join(cwd, 'node_modules', 'ignored'), 'dependency'); await mkdir(join(cwd, '.git')); await writeFile(join(cwd, '.git', 'ignored'), 'index');
  const outside = join(data, 'outside'); await mkdir(outside, { recursive: true }); await writeFile(join(outside, 'private'), 'not snapshotted'); await symlink(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); await writeFile(join(cwd, 'ordinary'), 'data');
  const checkpoint = await service.capture('task', 'turn', cwd); assert.deepEqual(Object.keys(checkpoint.files), ['ordinary']); assert.equal(checkpoint.coverage.omitted.length, 3);
  await assert.rejects(new CheckpointService(data, { limits: { maxFileBytes: 2 } }).capture('other', 'turn', cwd), /exceeds/); assert.equal((await service.list()).length, 1);
  await writeFile(join(cwd, 'ordinary'), 'edited'); await rm(join(cwd, 'ordinary')); await symlink(outside, join(cwd, 'ordinary'), process.platform === 'win32' ? 'junction' : 'dir'); assert.equal((await service.diff(checkpoint.id)).files.length, 0);
  await assert.rejects(service.reviewAction({ checkpointId: checkpoint.id, path: 'linked/private', action: 'revert', expectedHash: null })); assert.equal(await readFile(join(outside, 'private'), 'utf8'), 'not snapshotted');
});
