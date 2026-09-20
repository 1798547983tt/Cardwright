import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { SquadIntegrationService } from '../src/core/squad-integration.ts';
import { ReviewDriftError } from '../src/core/checkpoints.ts';
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec('git', args, { cwd, windowsHide: true })).stdout.trim(); }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-integration-')); const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(project);
  t.after(async () => { assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith('cardwright-integration-')); await rm(root, { recursive: true, force: true }); });
  await git(project, 'init', '-b', 'main'); await git(project, 'config', 'user.name', 'Fixture'); await git(project, 'config', 'user.email', 'fixture@example.invalid'); await git(project, 'config', 'core.autocrlf', 'false');
  for (const file of ['one.txt', 'two.txt', 'delete.txt']) await writeFile(join(project, file), `base ${file}\n`); await writeFile(join(project, 'binary.bin'), Buffer.from([0, 255, 2])); await git(project, 'add', '.'); await git(project, 'commit', '-m', 'base'); const baseCommit = await git(project, 'rev-parse', 'HEAD');
  const member = async (id: string) => { const cwd = join(root, id); await git(project, 'worktree', 'add', '--detach', cwd, baseCommit); return { taskId: id, cwd, baseCommit }; };
  return { root, project, data, baseCommit, member, service: new SquadIntegrationService(data) };
}
test('squad integrates independent real Git patches including new/deleted/binary files and preserves dirty target files', async t => {
  const f = await fixture(t); const one = await f.member('one'); const two = await f.member('two');
  await writeFile(join(one.cwd, 'one.txt'), 'member one\n'); await writeFile(join(one.cwd, 'new.txt'), 'new member file\n'); await writeFile(join(one.cwd, 'binary.bin'), Buffer.from([0, 42, 24])); await writeFile(join(two.cwd, 'two.txt'), 'member two\n'); await rm(join(two.cwd, 'delete.txt')); await writeFile(join(f.project, 'human.txt'), 'unsaved human work');
  const beforeIndex = await git(f.project, 'diff', '--cached'); const integration = await f.service.prepare({ projectPath: f.project, baseCommit: f.baseCommit, members: [one, two] }); assert.equal(integration.status, 'ready'); assert.deepEqual(integration.members.map(member => member.status), ['applied', 'applied']);
  assert.equal(await readFile(join(f.project, 'one.txt'), 'utf8'), 'base one.txt\n'); const review = await f.service.review(integration.id); assert.equal(review.files.length, 5);
  const applied = await f.service.applyReviewed(integration.id, review.revision); assert.equal(applied.files.length, 5); assert.equal(await readFile(join(f.project, 'one.txt'), 'utf8'), 'member one\n'); assert.equal(await readFile(join(f.project, 'two.txt'), 'utf8'), 'member two\n'); assert.equal(await readFile(join(f.project, 'new.txt'), 'utf8'), 'new member file\n'); assert.equal(await readFile(join(f.project, 'human.txt'), 'utf8'), 'unsaved human work'); assert.deepEqual(await readFile(join(f.project, 'binary.bin')), Buffer.from([0, 42, 24])); await assert.rejects(readFile(join(f.project, 'delete.txt')), { code: 'ENOENT' }); assert.equal(await git(f.project, 'diff', '--cached'), beforeIndex);
  await assert.rejects(f.service.applyReviewed(integration.id, review.revision), /already applied/); assert.equal((await new SquadIntegrationService(f.data).get(integration.id)).status, 'applied');
});
test('overlapping member edits are reported in isolation without changing the original project', async t => {
  const f = await fixture(t); const one = await f.member('one'); const two = await f.member('two'); await writeFile(join(one.cwd, 'one.txt'), 'A\n'); await writeFile(join(two.cwd, 'one.txt'), 'B\n');
  const integration = await f.service.prepare({ projectPath: f.project, baseCommit: f.baseCommit, members: [one, two] }); assert.equal(integration.status, 'conflicted'); assert.equal(integration.members[1].status, 'conflict'); assert.match(integration.members[1].error!, /patch|does not apply/i); assert.equal(await readFile(join(f.project, 'one.txt'), 'utf8'), 'base one.txt\n'); assert.equal(await readFile(join(integration.path, 'one.txt'), 'utf8'), 'A\n'); await assert.rejects(f.service.applyReviewed(integration.id, (await f.service.review(integration.id)).revision), /conflicting/);
});
test('reviewed integration rejects drift before applying any files and invalidates checks when integration changes', async t => {
  const f = await fixture(t); const one = await f.member('one'); await writeFile(join(one.cwd, 'one.txt'), 'A\n'); await writeFile(join(one.cwd, 'two.txt'), 'B\n'); const integration = await f.service.prepare({ projectPath: f.project, baseCommit: f.baseCommit, members: [one] }); const review = await f.service.review(integration.id);
  const runs = await f.service.check(integration.id, [{ id: 'check', name: 'Check', command: 'verify' }], async (_command, cwd, onData) => { assert.equal(cwd, integration.path); onData('verified isolated files'); return { exitCode: 0 }; }); assert.equal(runs[0].revision, review.revision); assert.equal(runs[0].status, 'passed');
  await writeFile(join(f.project, 'two.txt'), 'later human edit\n'); await assert.rejects(f.service.applyReviewed(integration.id, review.revision), ReviewDriftError); assert.equal(await readFile(join(f.project, 'one.txt'), 'utf8'), 'base one.txt\n'); assert.equal(await readFile(join(f.project, 'two.txt'), 'utf8'), 'later human edit\n');
  await writeFile(join(integration.path, 'one.txt'), 'edited during review\n'); await assert.rejects(f.service.applyReviewed(integration.id, review.revision), /changed since review/);
});
test('member from another repository and changes outside checkpoint coverage cannot enter integration', async t => {
  const f = await fixture(t); const one = await f.member('one'); await mkdir(join(one.cwd, 'dist')); await writeFile(join(one.cwd, 'dist', 'generated.js'), 'generated'); const integration = await f.service.prepare({ projectPath: f.project, baseCommit: f.baseCommit, members: [one] }); assert.equal(integration.status, 'conflicted'); assert.match(integration.members[0].error!, /outside checkpoint coverage/); assert.equal((await f.service.review(integration.id)).files.length, 0);
  const foreign = await fixture(t); const outsider = await foreign.member('outsider'); const rejected = await f.service.prepare({ projectPath: f.project, baseCommit: f.baseCommit, members: [outsider] }); assert.equal(rejected.status, 'conflicted'); assert.match(rejected.members[0].error!, /another repository/);
});
test('separate hunks in the same file combine without requiring a clean target checkout', async t => {
  const f = await fixture(t); const original = Array.from({ length: 35 }, (_, i) => `line ${i}`).join('\n') + '\n'; await writeFile(join(f.project, 'one.txt'), original); await git(f.project, 'add', '.'); await git(f.project, 'commit', '-m', 'long source'); const baseCommit = await git(f.project, 'rev-parse', 'HEAD');
  const members = []; for (const id of ['a', 'b']) { const cwd = join(f.root, id); await git(f.project, 'worktree', 'add', '--detach', cwd, baseCommit); members.push({ taskId: id, cwd, baseCommit }); }
  await writeFile(join(members[0].cwd, 'one.txt'), original.replace('line 2\n', 'changed A\n')); await writeFile(join(members[1].cwd, 'one.txt'), original.replace('line 30\n', 'changed B\n')); await writeFile(join(f.project, 'two.txt'), 'human unrelated\n');
  const integration = await f.service.prepare({ projectPath: f.project, baseCommit, members }); assert.equal(integration.status, 'ready'); const review = await f.service.review(integration.id); await f.service.applyReviewed(integration.id, review.revision); assert.equal(await readFile(join(f.project, 'one.txt'), 'utf8'), original.replace('line 2\n', 'changed A\n').replace('line 30\n', 'changed B\n')); assert.equal(await readFile(join(f.project, 'two.txt'), 'utf8'), 'human unrelated\n');
});
