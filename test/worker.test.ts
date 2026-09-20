import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { createResources } from '../src/runtime/resources.ts';
import type { FromWorker, Gateway, PermissionMode, WorkerInit } from '../src/shared/types.ts';

async function createFixture(mode: PermissionMode, handler: (request: Record<string, unknown>, response: ServerResponse) => void, protocol: Gateway['protocol'] = 'openai-completions') {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-worker-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bodies.push(body);
      urls.push(request.url ?? '');
      assert.equal(request.headers.authorization, 'Bearer cardwright-test-secret');
      if (protocol === 'anthropic-messages') assert.equal(request.headers['x-api-key'], 'cardwright-test-secret');
      handler(body, response);
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const messages: FromWorker[] = [];
  const worker = new WorkerRuntime(message => messages.push(message));
  const init: WorkerInit = {
    type: 'init', taskId: 'test-task', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'),
    gateway: {
      id: 'test', name: 'Test local gateway', baseUrl: `http://127.0.0.1:${address.port}${protocol === 'anthropic-messages' ? '' : '/v1'}`, modelId: 'test-model',
      protocol, reasoning: false, contextWindow: 32000, maxTokens: 2000, hasKey: true,
    },
    apiKey: 'cardwright-test-secret', thinking: 'off', permission: mode, instructions: 'Keep answers short.',
    skillPaths: [], canDelegate: true,
  };
  return {
    root, cwd, worker, init, messages, bodies, urls,
    async cleanup() {
      await worker.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.match(root, /cardwright-worker-/);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function stream(response: ServerResponse, tool?: { name: string; args: Record<string, unknown> }, text = 'Finished safely.') {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
    id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) {
    chunk({ tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    chunk({}, 'tool_calls');
  } else { chunk({ content: text }); chunk({}, 'stop'); }
  response.write(`data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function streamAnthropic(response: ServerResponse, tool?: { name: string; args: Record<string, unknown> }) {
  // Mirrors Pi's published api/anthropic-messages.js event parser.
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  emit({ type: 'message_start', message: {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 12, cache_creation_input_tokens: 0 },
  } });
  emit({ type: 'content_block_start', index: 0, content_block: tool
    ? { type: 'tool_use', id: 'toolu_test', name: tool.name, input: {} }
    : { type: 'text', text: '' } });
  emit({ type: 'content_block_delta', index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) }
    : { type: 'text_delta', text: 'Anthropic protocol verified.' } });
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  emit({ type: 'message_stop' });
  response.end();
}

function streamResponses(response: ServerResponse, tool?: { name: string; args: Record<string, unknown> }) {
  // Mirrors Pi's published api/openai-responses-shared.js output item state machine.
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  let sequence = 0;
  const emit = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  const item = tool
    ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: tool.name, arguments: '', status: 'in_progress' }
    : { type: 'message', id: 'msg_test', role: 'assistant', content: [], status: 'in_progress' };
  emit({ type: 'response.created', response: { id: 'resp_test', object: 'response', status: 'in_progress', output: [] } });
  emit({ type: 'response.output_item.added', output_index: 0, item });
  const finalItem = tool
    ? { ...item, arguments: JSON.stringify(tool.args), status: 'completed' }
    : { ...item, content: [{ type: 'output_text', text: 'Responses protocol verified.', annotations: [] }], status: 'completed' };
  if (tool) {
    emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: JSON.stringify(tool.args) });
    emit({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: JSON.stringify(tool.args) });
  } else {
    emit({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Responses protocol verified.' });
  }
  emit({ type: 'response.output_item.done', output_index: 0, item: finalItem });
  emit({ type: 'response.completed', response: {
    id: 'resp_test', object: 'response', status: 'completed', output: [finalItem],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 0 } },
  } });
  response.end();
}

async function until(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for local worker state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('real Pi web_search approval gates HTTP and returns structured, cited sources', { timeout: 30000 }, async context => {
  for (const allow of [false, true]) await context.test(allow ? 'approved' : 'denied', async () => {
    let gatewayCalls = 0;
    let searchCalls = 0;
    const searchServer = createServer((request, response) => {
      searchCalls++;
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.pathname, '/search');
      assert.equal(url.searchParams.get('q'), 'Pi SDK documentation');
      assert.equal(url.searchParams.get('format'), 'json');
      assert.equal(request.headers.authorization, undefined);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ results: [{ title: 'Pi SDK', url: 'https://example.com/pi-sdk', content: '<b>SDK reference</b>' }] }));
    });
    await new Promise<void>(resolve => searchServer.listen(0, '127.0.0.1', resolve));
    const address = searchServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing search server address');
    const fixture = await createFixture('ask', (request, response) => {
      if (gatewayCalls === 0) assert.match(JSON.stringify(request.tools), /web_search/);
      stream(response, gatewayCalls++ === 0 ? { name: 'web_search', args: { query: 'Pi SDK documentation', count: 3 } } : undefined);
    });
    fixture.init.search = { enabled: true, provider: 'searxng', baseUrl: `http://127.0.0.1:${address.port}`, hasKey: false };
    try {
      await fixture.worker.handle(fixture.init);
      const run = fixture.worker.handle({ type: 'prompt', text: 'Search the public Pi SDK documentation.' });
      await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'approve'));
      const approval = fixture.messages.find(message => message.type === 'request' && message.method === 'approve');
      assert.ok(approval?.type === 'request');
      assert.equal(approval.args.toolName, 'web_search');
      assert.match(String(approval.args.reason), /search service.*Pi SDK documentation/);
      assert.equal(searchCalls, 0);
      await fixture.worker.handle({ type: 'response', id: approval.id, result: allow });
      await run;
      assert.equal(searchCalls, allow ? 1 : 0);
      const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'web_search');
      assert.ok(completed?.type === 'event', JSON.stringify(fixture.messages));
      assert.equal(completed.event.isError, !allow);
      if (allow) {
        const result = completed.event.result as { details: { provider: string; results: unknown[] }; content: { text: string }[] };
        assert.equal(result.details.provider, 'searxng');
        assert.deepEqual(result.details.results, [{ title: 'Pi SDK', url: 'https://example.com/pi-sdk', snippet: 'SDK reference' }]);
        assert.match(result.content[0]?.text ?? '', /untrusted/);
        assert.match(JSON.stringify(fixture.bodies.at(-1)), /https:\/\/example.com\/pi-sdk/);
      }
    } finally {
      await fixture.cleanup();
      searchServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => searchServer.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('worker omits unconfigured search tools and redacts both model and search keys from events', { timeout: 30000 }, async () => {
  const searchSecret = 'cardwright-search-secret';
  const fixture = await createFixture('full', (_request, response) => {
    stream(response, undefined, `A hostile provider echoed cardwright-test-secret and ${searchSecret}.`);
  });
  fixture.init.search = { enabled: true, provider: 'brave', baseUrl: '', hasKey: false, apiKey: searchSecret };
  try {
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: 'Say hello.' });
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]?.tools), /web_search/);
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]?.tools), /"name":"web_search"/);
    assert.doesNotMatch(JSON.stringify(fixture.messages), /cardwright-test-secret|cardwright-search-secret/);
    assert.match(JSON.stringify(fixture.messages), /\[redacted\]/);
  } finally { await fixture.cleanup(); }
});

test('disabling web search revokes pending approval and aborts an in-flight search', { timeout: 30000 }, async context => {
  for (const active of [false, true]) await context.test(active ? 'in flight' : 'pending approval', async () => {
    let gatewayCalls = 0;
    let searchCalls = 0;
    const searchServer = createServer((_request, response) => {
      searchCalls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"results":[');
    });
    await new Promise<void>(resolve => searchServer.listen(0, '127.0.0.1', resolve));
    const address = searchServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing search server address');
    const fixture = await createFixture(active ? 'full' : 'ask', (_request, response) => {
      stream(response, gatewayCalls++ === 0 ? { name: 'web_search', args: { query: 'cancel this search' } } : undefined);
    });
    fixture.init.search = { enabled: true, provider: 'searxng', baseUrl: `http://127.0.0.1:${address.port}`, hasKey: false };
    try {
      await fixture.worker.handle(fixture.init);
      const run = fixture.worker.handle({ type: 'prompt', text: 'Search for docs.' });
      await until(() => active ? searchCalls > 0 : fixture.messages.some(message => message.type === 'request' && message.method === 'approve'));
      await fixture.worker.handle({ type: 'search', search: { ...fixture.init.search, enabled: false } });
      if (!active) {
        const approval = fixture.messages.find(message => message.type === 'request' && message.method === 'approve');
        assert.ok(approval?.type === 'request');
        await fixture.worker.handle({ type: 'response', id: approval.id, result: true });
      }
      await run;
      assert.equal(searchCalls, active ? 1 : 0);
      const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'web_search');
      assert.ok(completed?.type === 'event');
      assert.equal(completed.event.isError, true);
      assert.match(JSON.stringify(completed.event.result), active ? /cancelled/ : /disabled/);
    } finally {
      await fixture.cleanup();
      searchServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => searchServer.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('real Pi tool execution waits for approval; denial prevents the file write', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('ask', (_request, response) => {
    stream(response, calls++ === 0 ? { name: 'write', args: { path: 'blocked.txt', content: 'must not be written' } } : undefined);
  });
  try {
    await fixture.worker.handle(fixture.init);
    assert.ok(fixture.messages.some(message => message.type === 'ready'), JSON.stringify(fixture.messages));
    const run = fixture.worker.handle({ type: 'prompt', text: 'Create the file.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'approve'));
    await assert.rejects(access(join(fixture.cwd, 'blocked.txt')));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'approve');
    assert.ok(request?.type === 'request');
    assert.equal(request.args.toolName, 'write');
    await fixture.worker.handle({ type: 'response', id: request.id, result: false });
    await run;
    await assert.rejects(access(join(fixture.cwd, 'blocked.txt')));
    assert.ok(fixture.messages.some(message => message.type === 'done'));
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
    assert.equal(JSON.stringify(fixture.messages).includes('cardwright-test-secret'), false);
  } finally { await fixture.cleanup(); }
});

test('approved PowerShell tool executes the real Windows shell and streams its output', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('ask', (_request, response) => {
    stream(response, calls++ === 0 ? { name: 'powershell', args: { command: "Write-Output 'CARDWRIGHT_SHELL_VERIFIED'" } } : undefined);
  });
  try {
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'Run the fixed shell verification command.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'approve'));
    const approval = fixture.messages.find(message => message.type === 'request' && message.method === 'approve');
    assert.ok(approval?.type === 'request');
    assert.equal(approval.args.toolName, 'powershell');
    assert.equal(fixture.messages.some(message => message.type === 'event' && message.event.type === 'tool_execution_end'), false);
    await fixture.worker.handle({ type: 'response', id: approval.id, result: true });
    await run;
    const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'powershell');
    assert.ok(completed?.type === 'event', JSON.stringify(fixture.messages));
    assert.equal(completed.event.isError, false, JSON.stringify(completed));
    assert.match(JSON.stringify(completed.event.result), /CARDWRIGHT_SHELL_VERIFIED/);
    assert.ok(fixture.messages.some(message => message.type === 'done'));
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
  } finally { await fixture.cleanup(); }
});

test('isolated PowerShell still runs with many skills installed; only skills in use are readable', { timeout: 60000, skip: process.platform !== 'win32' }, async () => {
  let calls = 0;
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  let command = '';
  const fixture = await createFixture('edit', (_request, response) => {
    const call = calls++;
    stream(response, call === 0 ? { name: 'use_skill', args: { name: 'skill-3' } } : call === 1 ? { name: 'powershell', args: { command } } : undefined);
  });
  try {
    const skills = join(fixture.root, 'skills');
    for (let index = 0; index < 40; index++) {
      await mkdir(join(skills, `skill-${index}`), { recursive: true });
      await writeFile(join(skills, `skill-${index}`, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Skill number ${index} for the sandbox root test\n---\nSKILL_${index}_BODY`);
    }
    const resources = join(fixture.root, 'card-resources');
    await mkdir(resources);
    command = `$ErrorActionPreference='Stop'; Get-Content -Raw ${quote(join(skills, 'skill-3', 'SKILL.md'))}; try { [IO.File]::ReadAllText(${quote(join(skills, 'skill-4', 'SKILL.md'))}); 'SKILL4_ESCAPED' } catch [UnauthorizedAccessException] { 'SKILL4_DENIED' }; 'ROOTS_OK'`;
    fixture.init.skillPaths = [skills];
    fixture.init.canDelegate = false;
    fixture.init.sandbox = { enabled: true, helperPath: resolve('dist/Cardwright.CommandHost.exe') };
    fixture.init.card = { prompt: 'Card section rules for the test.', readRoots: [resources] };
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'Use skill 3 and run the check.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), 20000);
    const approval = fixture.messages.find(message => message.type === 'request' && message.method === 'approve');
    assert.ok(approval?.type === 'request');
    assert.equal(approval.args.toolName, 'powershell');
    await fixture.worker.handle({ type: 'response', id: approval.id, result: true });
    await run;
    const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'powershell');
    assert.ok(completed?.type === 'event', JSON.stringify(fixture.messages));
    const output = JSON.stringify(completed.event.result);
    assert.equal(completed.event.isError, false, output);
    assert.match(output, /SKILL_3_BODY/);
    assert.match(output, /SKILL4_DENIED/);
    assert.match(output, /ROOTS_OK/);
    assert.doesNotMatch(output, /ESCAPED/);
  } finally { await fixture.cleanup(); }
});

test('searching the material needs no approval and is answered by the app', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('ask', (_request, response) => stream(response, calls++ === 0 ? { name: 'card_search_sources', args: { query: '红孩儿 火云洞', limit: 5 } } : undefined));
  try {
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: 'Card section rules for the test.', readRoots: [] };
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '查一下红孩儿。' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'card'));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'card');
    assert.ok(request?.type === 'request');
    assert.deepEqual(request.args, { action: 'search_sources', query: '红孩儿 火云洞', limit: 5 });
    await fixture.worker.handle({ type: 'response', id: request.id, result: { query: '红孩儿 火云洞', results: [{ file: '资料/分章/西游记/0003-第三回.txt', source: '西游记.txt', chapter: '第三回', line: 2, snippet: '红孩儿住在火云洞' }], total: 1, truncated: false } });
    await run;
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
    const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'card_search_sources');
    assert.ok(completed?.type === 'event');
    assert.equal(completed.event.isError, false);
    assert.match(JSON.stringify(completed.event.result), /火云洞/);
  } finally { await fixture.cleanup(); }
});

test('card messages carry no context usage tag: the app, not the AI, decides when to change conversations', { timeout: 30000 }, async () => {
  const fixture = await createFixture('edit', (_request, response) => stream(response));
  try {
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: 'Card section rules for the test.', readRoots: [] };
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '写第一个人物。' });
    await fixture.worker.handle({ type: 'prompt', text: '继续写第二个人物。' });
    assert.equal(fixture.bodies.length, 2);
    assert.match(JSON.stringify(fixture.bodies[1]), /继续写第二个人物/);
    assert.doesNotMatch(JSON.stringify(fixture.bodies), /context_usage/);
  } finally { await fixture.cleanup(); }
});

test('edit mode writes through Pi, preserves sessions, and loads text without executing extensions', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => {
    stream(response, calls++ === 0 ? { name: 'write', args: { path: 'generated.txt', content: 'verified output' } } : undefined);
  });
  try {
    await mkdir(join(fixture.cwd, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(fixture.cwd, '.pi', 'extensions', 'bad.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(fixture.cwd, 'extension-ran.txt'))}, 'bad'); export default () => {};`);
    await writeFile(join(fixture.cwd, 'AGENTS.md'), '# Project context\nLOCAL_CONTEXT_SENTINEL');
    const selectedSkills = join(fixture.root, 'selected-skill');
    const automaticSkills = join(fixture.cwd, '.pi', 'skills', 'automatic-skill');
    await mkdir(selectedSkills);
    await mkdir(automaticSkills, { recursive: true });
    await writeFile(join(selectedSkills, 'SKILL.md'), '---\nname: selected-skill\ndescription: SELECTED_SKILL_SENTINEL\n---\nUse precise edits.');
    await writeFile(join(automaticSkills, 'SKILL.md'), '---\nname: automatic-skill\ndescription: UNSELECTED_SKILL_SENTINEL\n---\nDo something else.');
    fixture.init.skillPaths = [selectedSkills];
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '!echo this is a normal model prompt' });
    assert.equal(await readFile(join(fixture.cwd, 'generated.txt'), 'utf8'), 'verified output');
    await assert.rejects(access(join(fixture.cwd, 'extension-ran.txt')));
    assert.equal(fixture.messages.some(message => message.type === 'request'), false);
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
    const done = fixture.messages.find(message => message.type === 'done');
    assert.ok(done?.type === 'done' && done.sessionFile);
    const saved = await readFile(done.sessionFile, 'utf8');
    assert.match(saved, /verified output/);
    assert.doesNotMatch(saved, /cardwright-test-secret/);
    assert.match(JSON.stringify(fixture.bodies[0]), /LOCAL_CONTEXT_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]), /SELECTED_SKILL_SENTINEL/);
    assert.match(JSON.stringify(fixture.bodies[0]?.tools), /"name":"search_skills"/);
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]), /UNSELECTED_SKILL_SENTINEL/);
    assert.match(JSON.stringify(fixture.bodies[0]), /!echo this is a normal model prompt/);
    assert.match(JSON.stringify(fixture.bodies[0]?.tools), /"name":"agent"/);
    await assert.rejects(access(join(fixture.init.agentDir, 'auth.json')));
    const resumedMessages: FromWorker[] = [];
    const resumed = new WorkerRuntime(message => resumedMessages.push(message));
    try {
      await resumed.handle({ ...fixture.init, sessionFile: done.sessionFile, canDelegate: false });
      await resumed.handle({ type: 'prompt', text: 'Continue from the saved session.' });
      assert.equal(resumedMessages.some(message => message.type === 'error'), false, JSON.stringify(resumedMessages));
      assert.match(JSON.stringify(fixture.bodies.at(-1)), /verified output/);
      assert.doesNotMatch(JSON.stringify(fixture.bodies.at(-1)?.tools), /"name":"agent"/);
    } finally { await resumed.dispose(); }
  } finally { await fixture.cleanup(); }
});

test('cancel rejects an outstanding approval; a late allow cannot execute the tool', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => stream(response, { name: 'write', args: { path: 'cancelled.txt', content: 'never' } }));
  try {
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'Write a file.' });
    await until(() => fixture.messages.some(message => message.type === 'request'));
    const request = fixture.messages.find(message => message.type === 'request');
    assert.ok(request?.type === 'request');
    await fixture.worker.handle({ type: 'cancel' });
    await fixture.worker.handle({ type: 'response', id: request.id, result: true });
    await run;
    await assert.rejects(access(join(fixture.cwd, 'cancelled.txt')));
    assert.ok(fixture.messages.some(message => message.type === 'event' && message.event.type === 'run_cancelled'));
    assert.equal(fixture.messages.some(message => message.type === 'error'), false);
  } finally { await fixture.cleanup(); }
});

test('provider HTTP failure is reported as failure before done and redacts the credential', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Invalid key cardwright-test-secret', type: 'authentication_error' } }));
  });
  try {
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: 'Hello' });
    const errorIndex = fixture.messages.findIndex(message => message.type === 'error');
    const doneIndex = fixture.messages.findIndex(message => message.type === 'done');
    assert.ok(errorIndex >= 0 && doneIndex > errorIndex, JSON.stringify(fixture.messages));
    assert.equal(JSON.stringify(fixture.messages).includes('cardwright-test-secret'), false);
  } finally { await fixture.cleanup(); }
});

test('messages arriving during prompt preflight are queued and settle once', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => stream(response));
  try {
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'First request.' });
    const queued = fixture.worker.handle({ type: 'prompt', text: 'Then inspect the result.', behavior: 'followUp' });
    await Promise.all([run, queued]);
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
    assert.equal(fixture.messages.filter(message => message.type === 'done').length, 1);
    assert.match(JSON.stringify(fixture.bodies.at(-1)), /Then inspect the result/);
  } finally { await fixture.cleanup(); }
});

test('the actual child worker accepts IPC init/prompt and reports streamed completion', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => stream(response, undefined, 'IPC verified.'));
  const child = fork(fileURLToPath(new URL('../src/runtime/worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: 'pipe', serialization: 'json',
  });
  const messages: FromWorker[] = [];
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  child.on('message', message => messages.push(message as FromWorker));
  try {
    child.send(fixture.init);
    await until(() => messages.some(message => message.type === 'ready') || messages.some(message => message.type === 'error'));
    assert.ok(messages.some(message => message.type === 'ready'), JSON.stringify(messages) + errors);
    child.send({ type: 'prompt', text: 'Test the IPC connection.' });
    await until(() => messages.some(message => message.type === 'done'));
    assert.equal(messages.some(message => message.type === 'error'), false, JSON.stringify(messages));
    assert.match(JSON.stringify(messages), /IPC verified/);
    assert.doesNotMatch(JSON.stringify(messages), /cardwright-test-secret/);
  } finally {
    child.disconnect();
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fixture.cleanup();
  }
});

for (const protocol of ['anthropic-messages', 'openai-responses'] as const) {
  test(`${protocol} sends correct auth and streams a real Pi tool round trip`, { timeout: 30000 }, async () => {
    let calls = 0;
    const fixture = await createFixture('edit', (_request, response) => {
      const tool = calls++ === 0 ? { name: 'write', args: { path: 'protocol.txt', content: protocol } } : undefined;
      if (protocol === 'anthropic-messages') streamAnthropic(response, tool);
      else streamResponses(response, tool);
    }, protocol);
    try {
      await fixture.worker.handle(fixture.init);
      await fixture.worker.handle({ type: 'prompt', text: 'Write the requested file then summarize.' });
      assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
      assert.equal(await readFile(join(fixture.cwd, 'protocol.txt'), 'utf8'), protocol);
      assert.equal(fixture.bodies.length, 2);
      assert.equal(fixture.urls[0]?.split('?')[0], protocol === 'anthropic-messages' ? '/v1/messages' : '/v1/responses');
      assert.match(JSON.stringify(fixture.messages), /protocol verified/);
      assert.ok(fixture.messages.some(message => message.type === 'event' && message.event.type === 'tool_execution_end'));
      assert.match(JSON.stringify(fixture.bodies[1]), protocol === 'anthropic-messages' ? /tool_result/ : /function_call_output/);
      assert.doesNotMatch(JSON.stringify(fixture.messages), /cardwright-test-secret/);
    } finally { await fixture.cleanup(); }
  });
}

test('initial reasoning clamp is reported and external session paths are rejected before Pi opens them', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => stream(response));
  try {
    await fixture.worker.handle({ ...fixture.init, thinking: 'max' });
    assert.ok(fixture.messages.some(message => message.type === 'event' && message.event.type === 'thinking_level_changed' && message.event.level === 'off'));
    const outside = join(fixture.root, 'outside.jsonl');
    const original = JSON.stringify({ type: 'session', id: 'old', cwd: fixture.cwd });
    await writeFile(outside, original);
    const messages: FromWorker[] = [];
    const invalid = new WorkerRuntime(message => messages.push(message));
    try {
      await invalid.handle({ ...fixture.init, sessionFile: outside });
      assert.ok(messages.some(message => message.type === 'error' && /outside this task/.test(message.message)));
      assert.equal(messages.some(message => message.type === 'ready'), false);
      assert.equal(await readFile(outside, 'utf8'), original);
      assert.equal(fixture.bodies.length, 0);
    } finally { await invalid.dispose(); }
  } finally { await fixture.cleanup(); }
});

test('skill discovery bounds linked roots, skips cycles, and never auto-loads linked AGENTS files', { timeout: 30000 }, async context => {
  const fixture = await createFixture('ask', (_request, response) => stream(response));
  try {
    const selected = join(fixture.root, 'selected');
    const inside = join(selected, 'inside');
    const outside = join(fixture.root, 'outside');
    await mkdir(inside, { recursive: true });
    await mkdir(outside);
    await writeFile(join(inside, 'SKILL.md'), '---\nname: inside\ndescription: APPROVED_SKILL_METADATA\n---\nUse the tools.');
    await writeFile(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: UNAPPROVED_SKILL_METADATA\n---\nOutside root.');
    await symlink(outside, join(selected, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(selected, join(selected, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
    const resources = createResources(fixture.cwd, fixture.init.agentDir, [selected], '');
    assert.equal(resources.getSkills().skills.length, 1);
    assert.equal(resources.getSkills().skills[0]?.name, 'inside');
    assert.doesNotMatch(JSON.stringify(resources.getSkills()), /UNAPPROVED_SKILL_METADATA/);
    await context.test('linked context is omitted before prompting', async linkedContext => {
      const externalContext = join(outside, 'context.md');
      await writeFile(externalContext, 'UNAPPROVED_CONTEXT_FILE');
      try { await symlink(externalContext, join(fixture.cwd, 'AGENTS.md'), 'file'); }
      catch (error) {
        if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
          linkedContext.skip('Windows host does not permit creation of file symlinks.'); return;
        }
        throw error;
      }
      const safe = createResources(fixture.cwd, fixture.init.agentDir, [], '');
      assert.doesNotMatch(JSON.stringify(safe.getAgentsFiles()), /UNAPPROVED_CONTEXT_FILE/);
    });
  } finally { await fixture.cleanup(); }
});
