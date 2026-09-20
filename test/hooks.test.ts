import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksFor, parseHooks } from '../src/core/hooks-config.ts';
import { runHooks } from '../src/main/hooks.ts';

test('a Claude Code hooks block is read as written, and what cannot run is reported', () => {
  const { hooks, skipped } = parseHooks({
    PreToolUse: [{ matcher: 'write|edit', hooks: [{ type: 'command', command: 'echo one', timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo two' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo unsupported' }] }],
    Stop: [{ hooks: [{ type: 'script', command: 'echo wrong type' }] }],
    PostToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'echo broken matcher' }] }],
    Notification: [{ hooks: [{ type: 'command', command: '   ' }] }],
  });
  assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'UserPromptSubmit']);
  assert.equal(hooks.PreToolUse?.[0].hooks[0].timeout, 5);
  assert.deepEqual(skipped.sort(), ['Notification', 'PostToolUse', 'PreCompact', 'Stop']);
  assert.deepEqual(parseHooks(null), { hooks: {}, skipped: [] });
  assert.throws(() => parseHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: 'x'.repeat(9000) }] }] }, { strict: true }), /command/i);
  assert.throws(() => parseHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo', timeout: 10_000 }] }] }, { strict: true }), /timeout/i);
});

test('a matcher picks the tools it names; no matcher means every one', () => {
  const { hooks } = parseHooks({
    PreToolUse: [
      { matcher: 'write|edit', hooks: [{ type: 'command', command: 'echo writes' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'echo all' }] },
      { hooks: [{ type: 'command', command: 'echo also all' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
  });
  assert.deepEqual(hooksFor(hooks, 'PreToolUse', 'write').map(hook => hook.command), ['echo writes', 'echo all', 'echo also all']);
  assert.deepEqual(hooksFor(hooks, 'PreToolUse', 'powershell').map(hook => hook.command), ['echo all', 'echo also all']);
  assert.deepEqual(hooksFor(hooks, 'Stop').map(hook => hook.command), ['echo stop']);
  assert.deepEqual(hooksFor(hooks, 'SessionStart'), []);
});

test('hooks run with the event on stdin: 0 allows, 2 blocks, anything else is reported', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-hooks-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const { hooks } = parseHooks({
    PreToolUse: [
      { matcher: 'write', hooks: [{ type: 'command', command: '$event = [Console]::In.ReadToEnd() | ConvertFrom-Json; Write-Output "saw $($event.hook_event_name) $($event.tool_name)"' }] },
      { matcher: 'deny-me', hooks: [{ type: 'command', command: '[Console]::Error.WriteLine("这个工具不许用"); exit 2' }] },
      { matcher: 'grumble', hooks: [{ type: 'command', command: '[Console]::Error.WriteLine("钩子自己坏了"); exit 3' }] },
      { matcher: 'slow', hooks: [{ type: 'command', command: 'Start-Sleep -Seconds 30', timeout: 1 }] },
      { matcher: 'env', hooks: [{ type: 'command', command: '$names = @(Get-ChildItem env: | Where-Object { $_.Name -like "PI_*" } | ForEach-Object { $_.Name }); Write-Output "PI_COUNT=$($names.Count)"; Write-Output "CWD=$(Get-Location)"' }] },
    ],
  });
  const env = { ...process.env, PI_SECRET_THING: 'leaked' } as NodeJS.ProcessEnv;
  const run = (toolName: string) => runHooks(hooks, { event: 'PreToolUse', toolName, cwd: root, taskId: 'task-1', projectDir: root, env });

  const ok = await run('write');
  assert.equal(ok.decision, 'allow');
  assert.match(ok.messages.join(' '), /saw PreToolUse write/, JSON.stringify(ok));

  const denied = await run('deny-me');
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason ?? '', /这个工具不许用/);

  const broken = await run('grumble');
  assert.equal(broken.decision, 'allow', 'a hook that fails does not block the tool');
  assert.match(broken.messages.join(' '), /钩子自己坏了/);

  const slow = await run('slow');
  assert.equal(slow.decision, 'allow');
  assert.match(slow.messages.join(' '), /超时|timed out/i);

  const clean = await run('env');
  assert.match(clean.messages.join(' '), /PI_COUNT=0/, JSON.stringify(clean));
  assert.match(clean.messages.join(' ').replace(/\\/g, '/'), new RegExp(root.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&'), 'i'));
});
