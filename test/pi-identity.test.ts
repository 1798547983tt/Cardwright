import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { runSandboxCommand } from '../src/runtime/sandbox-runner.ts';
import { defaultEcosystem } from '../src/core/ecosystem.ts';
import { buildSectionPrompt } from '../src/core/card-studio/prompts.ts';
import type { FromWorker, PermissionMode, WorkerInit } from '../src/shared/types.ts';

const windowsOnly = { skip: process.platform !== 'win32' };
/** Lists the names of PI_* variables the command can see; prints PI_COUNT=0 when there are none. */
const LIST_PI = "$names = @(Get-ChildItem env: | Where-Object { $_.Name -like 'PI_*' } | ForEach-Object { $_.Name }); \"PI_COUNT=$($names.Count) $($names -join ',')\"";

type Tool = { name: string; args: Record<string, unknown> };
function stream(response: ServerResponse, tool?: Tool, text = 'Done.') {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'pi-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) { chunk({ tool_calls: [{ index: 0, id: `call-${tool.name}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); chunk({}, 'tool_calls'); }
  else { chunk({ content: text }); chunk({}, 'stop'); }
  response.write(`data: ${JSON.stringify({ id: 'pi-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function fixture(permission: PermissionMode, tools: Tool[]) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-identity-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    stream(response, tools[call++]);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  const messages: FromWorker[] = [];
  const worker = new WorkerRuntime(message => messages.push(message));
  const init: WorkerInit = {
    type: 'init', taskId: 'identity-task', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
    gateway: { id: 'test', name: 'Local test gateway', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'test-model', protocol: 'openai-completions', reasoning: false, contextWindow: 32000, maxTokens: 2000, hasKey: true },
    apiKey: 'cardwright-identity-secret', thinking: 'off', permission, instructions: '', skillPaths: [], canDelegate: true,
    dataDir: join(root, 'data'), projectId: 'identity-project', ecosystem: { ...defaultEcosystem(), memoryEnabled: true, cacheEnabled: true },
  };
  return {
    root, cwd, init, worker, messages, bodies,
    output: (name: string) => JSON.stringify(messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === name)),
    async cleanup() {
      await worker.dispose();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('PowerShell and host commands see no PI_ variables', { timeout: 60000, ...windowsOnly }, async () => {
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  const f = await fixture('full', [{ name: 'powershell', args: { command: LIST_PI } }, { name: 'host_command', args: { command: LIST_PI } }]);
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'List the environment.' });
    const shell = f.output('powershell'), host = f.output('host_command');
    assert.match(shell, /PI_COUNT=0/, shell);
    assert.match(host, /PI_COUNT=0/, host);
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous;
    await f.cleanup();
  }
});

test('isolated commands and terminals see no PI_ variables', { timeout: 60000, ...windowsOnly }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cardwright-identity-sandbox-'));
  let output = '';
  try {
    const result = await runSandboxCommand(LIST_PI, cwd, { helperPath: resolve('dist/Cardwright.CommandHost.exe'), env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: cwd }, onData: data => { output += data.toString('utf8'); } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /PI_COUNT=0/, output);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

/** Every place the words "pi" or "PI_" appear in what the model receives, with a little context. */
function mentions(value: unknown): string[] {
  const text = JSON.stringify(value);
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9])pi(?![A-Za-z0-9_])|\bPI_[A-Z]/gi)) found.push(text.slice(Math.max(0, match.index - 60), match.index + 60));
  return found;
}

test('nothing the model receives names Pi, and truncated output files are Cardwright files', { timeout: 60000 }, async () => {
  const many = "1..3000 | ForEach-Object { 'line ' + $_ }";
  const f = await fixture('full', [{ name: 'powershell', args: { command: many } }]);
  try {
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Print many lines.' });
    assert.equal(f.messages.some(message => message.type === 'error'), false, JSON.stringify(f.messages.filter(message => message.type === 'error')));
    assert.ok(f.bodies.length >= 2, 'the model saw the tool result');
    assert.deepEqual(f.bodies.flatMap(body => mentions(body)), []);
    const shell = f.output('powershell');
    assert.match(shell, /Full output: [^\]]*cardwright-powershell-/, shell);
  } finally { await f.cleanup(); }
});

test('a card conversation with web tools names no Pi either', { timeout: 60000 }, async () => {
  const f = await fixture('edit', []);
  try {
    const resources = resolve('card-studio');
    f.init.canDelegate = false;
    f.init.search = { enabled: true, provider: 'auto', baseUrl: '', hasKey: false };
    f.init.card = { prompt: await buildSectionPrompt(resources, { sectionId: 'lore-people', cardName: '身份测试卡', cardKind: 'fan', source: '测试原作', projectRoot: f.cwd }), readRoots: [resources] };
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: '开始写人设。' });
    assert.equal(f.messages.some(message => message.type === 'error'), false, JSON.stringify(f.messages.filter(message => message.type === 'error')));
    assert.match(JSON.stringify(f.bodies[0]?.tools), /"name":"web_search"/);
    assert.match(JSON.stringify(f.bodies[0]?.tools), /"name":"card_new_component"/);
    assert.deepEqual(f.bodies.flatMap(body => mentions(body)), []);
  } finally { await f.cleanup(); }
});

test('a task run never creates ~/.pi', { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cardwright-identity-home-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home; process.env.HOME = home;
  const f = await fixture('ask', []);
  try {
    await writeFile(join(f.cwd, 'README.md'), 'Identity test project');
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Say hello.' });
    assert.equal(f.messages.some(message => message.type === 'error'), false, JSON.stringify(f.messages.filter(message => message.type === 'error')));
    await assert.rejects(access(join(home, '.pi')), 'Cardwright must not create or use ~/.pi');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await f.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
