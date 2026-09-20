import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { runChecks, relevantChecks, type CheckExecutor } from '../src/main/check-runner.ts';
import { buildDelivery, verificationStatus } from '../src/core/delivery.ts';
const executor: CheckExecutor = async (command, cwd, onData, signal) => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', command], { cwd, windowsHide: true, signal }); child.stdout.on('data', chunk => onData(String(chunk))); child.stderr.on('data', chunk => onData(String(chunk))); child.on('error', reject); child.on('exit', (exitCode, signal) => resolve({ exitCode, signal: signal || undefined })); });
test('configured relevant checks execute actual processes and separate exit evidence from model completion', async () => {
  const checks = [{ id: 'unit', name: 'Unit tests', command: 'console.log("actual pass");', paths: ['src/**/*.ts'] }, { id: 'docs', name: 'Docs', command: 'process.exit(7)', paths: ['docs/**'] }];
  assert.deepEqual(relevantChecks(checks, ['src/file.ts']).map(check => check.id), ['unit']); assert.deepEqual(relevantChecks(checks, []), []);
  const runs = await runChecks({ checks, cwd: process.cwd(), revision: 'revision-a', changedPaths: ['src/file.ts'], execute: executor }); assert.equal(runs.length, 1); assert.equal(runs[0].exitCode, 0); assert.match(runs[0].output, /actual pass/); assert.equal(verificationStatus(runs, 'revision-a', ['unit']), 'passed'); assert.equal(verificationStatus(runs, 'revision-b', ['unit']), 'stale'); assert.equal(verificationStatus(runs, 'revision-a', ['unit', 'docs']), 'not-run');
  const fail = await runChecks({ checks, cwd: process.cwd(), revision: 'revision-a', changedPaths: ['docs/readme.md'], execute: executor }); assert.equal(fail[0].exitCode, 7); assert.equal(verificationStatus(fail, 'revision-a'), 'failed');
  const delivery = buildDelivery({ taskId: 'task', turnId: 'turn', execution: 'completed', checks: [], configuredChecks: checks, review: { checkpointId: 'checkpoint', cwd: '.', revision: 'revision-a', coverage: { files: 1, bytes: 1, omitted: [] }, files: [{ path: 'src/file.ts', kind: 'modified', beforeHash: 'old', afterHash: 'new', beforeBytes: 1, afterBytes: 1, binary: false, patch: '', hunks: [], accepted: false }] } }); assert.equal(delivery.execution, 'completed'); assert.equal(delivery.verification, 'not-run'); assert.match(delivery.unverified[0], /not run/);
});
test('check timeout aborts the host executor and bounded logs are explicit', async () => {
  let aborted = false; const runs = await runChecks({ checks: [{ id: 'hang', name: 'Hang', command: 'fixture', timeoutMs: 20 }], cwd: '.', revision: 'r', changedPaths: ['app'], execute: async (_command, _cwd, onData, signal) => { onData('X'.repeat(200000)); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })); }, maxOutputBytes: 2048 });
  assert.equal(aborted, true); assert.equal(runs[0].status, 'timed-out'); assert.equal(runs[0].truncated, true); assert.ok(Buffer.byteLength(runs[0].output) <= 2048);
});
test('cancelled checks never become passed and invalid configuration never executes', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const runs = await runChecks({ checks: [{ id: 'a', name: 'A', command: 'pass' }], cwd: '.', revision: 'r', changedPaths: ['file'], signal: controller.signal, execute: async () => { called = true; return { exitCode: 0 }; } }); assert.equal(called, false); assert.deepEqual(runs, []);
  assert.throws(() => relevantChecks([{ id: 'a', name: 'A', command: 'x' }, { id: 'a', name: 'B', command: 'y' }], ['file']), /unique/);
  const duringPublish = new AbortController();
  const cancelled = await runChecks({ checks: [{ id: 'a', name: 'A', command: 'pass' }], cwd: '.', revision: 'r', changedPaths: ['file'], signal: duringPublish.signal, onRun: run => { if (run.status === 'running') duringPublish.abort(); }, execute: async () => { throw new Error('Must not execute after cancellation.'); } }); assert.equal(cancelled[0].status, 'cancelled');
});
test('check cancellation waits for executor cleanup before publishing its final status', async () => {
  let cleanupFinished = false; let finalPublished = false;
  const started = Date.now();
  const runs = await runChecks({ checks: [{ id: 'cleanup', name: 'Cleanup', command: 'fixture', timeoutMs: 10 }], cwd: '.', revision: 'r', changedPaths: ['file'],
    execute: async (_command, _cwd, _onData, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { setTimeout(() => { cleanupFinished = true; resolve({ exitCode: null }); }, 60); }, { once: true }); }),
    onRun: run => { if (run.status !== 'running') { assert.equal(cleanupFinished, true); finalPublished = true; } },
  });
  assert.equal(runs[0].status, 'timed-out'); assert.equal(finalPublished, true); assert.ok(Date.now() - started >= 60);
});
