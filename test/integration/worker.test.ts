import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkerRuntime } from '../../src/runtime/worker.ts';
import { createResources } from '../../src/runtime/resources.ts';
import type { FromWorker, Gateway, PermissionMode, WorkerInit } from '../../src/shared/types.ts';
import { CARD_ROLES } from '../../src/shared/card-studio/squad.ts';
import type { CardSquadAssignment } from '../../src/shared/card-studio/types.ts';

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

/** One model reply that calls several tools together, as models do with calls that do not depend on each other. */
function streamCalls(response: ServerResponse, tools: Array<{ name: string; args: Record<string, unknown> }>) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
    id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  chunk({ role: 'assistant' });
  chunk({ tool_calls: tools.map((tool, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) });
  chunk({}, 'tool_calls');
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

test('registering dispatches needs no approval, is answered by the app, and is offered only when the app says so', { timeout: 30000 }, async () => {
  let calls = 0;
  const dispatches = [{ target: '世界书/叙事规则', title: '写叙事规则', body: '写四条叙事规则。' }];
  const fixture = await createFixture('ask', (_request, response) => stream(response, calls++ === 0 ? { name: 'card_add_dispatches', args: { dispatches } } : undefined));
  try {
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: 'Planning rules for the test.', readRoots: [], addDispatches: true };
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '登记世界书的派单。' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'card'));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'card');
    assert.ok(request?.type === 'request');
    assert.deepEqual(request.args, { action: 'add_dispatches', dispatches });
    await fixture.worker.handle({ type: 'response', id: request.id, result: { added: 1, results: [{ index: 0, ok: true, target: '世界书/叙事规则', title: '写叙事规则', section: '世界书 · 叙事规则' }] } });
    await run;
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
    assert.match(JSON.stringify(fixture.bodies[0]?.tools), /"name":"card_add_dispatches"/);
    const completed = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'card_add_dispatches');
    assert.ok(completed?.type === 'event');
    assert.equal(completed.event.isError, false);
  } finally { await fixture.cleanup(); }

  const section = await createFixture('edit', (_request, response) => stream(response));
  try {
    section.init.canDelegate = false;
    section.init.card = { prompt: 'Section rules for the test.', readRoots: [] };
    await section.worker.handle(section.init);
    await section.worker.handle({ type: 'prompt', text: '写叙事规则。' });
    assert.match(JSON.stringify(section.bodies[0]?.tools), /"name":"card_check"/);
    assert.doesNotMatch(JSON.stringify(section.bodies[0]?.tools), /card_add_dispatches/);
  } finally { await section.cleanup(); }

  // A squad member gets exactly its own tools: not this one, even if the app wrongly offered it.
  const member = await createFixture('edit', (_request, response) => stream(response));
  try {
    member.init.canDelegate = false;
    member.init.card = { prompt: '小队成员测试。', readRoots: [], member: { role: 'writer', files: [], create: ['黄袍怪'] }, addDispatches: true };
    await member.worker.handle(member.init);
    await member.worker.handle({ type: 'prompt', text: '开工。' });
    assert.match(JSON.stringify(member.bodies[0]?.tools), /"name":"card_new_component"/);
    assert.doesNotMatch(JSON.stringify(member.bodies[0]?.tools), /card_add_dispatches/);
  } finally { await member.cleanup(); }
});

// The agent loop runs the tool calls of one reply side by side unless a tool says otherwise, and the order dispatches are
// registered in is the order one-click making sends them in: a second registration waits for the first one's answer.
test('registrations from one reply run one after the other, in the order they were made', { timeout: 30000 }, async () => {
  let calls = 0;
  const first = [{ target: '脚本/变量结构', title: '写变量表', body: '正文一' }];
  const second = [{ target: '世界书/变量', title: '写变量条目', body: '正文二' }];
  const fixture = await createFixture('ask', (_request, response) => calls++ === 0
    ? streamCalls(response, [{ name: 'card_add_dispatches', args: { dispatches: first } }, { name: 'card_add_dispatches', args: { dispatches: second } }])
    : stream(response));
  try {
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: 'Planning rules for the test.', readRoots: [], addDispatches: true };
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '登记两批派单。' });
    const requests = () => fixture.messages.flatMap(message => message.type === 'request' && message.method === 'card' ? [message] : []);
    const answer = { added: 1, results: [{ index: 0, ok: true, target: '', title: '', section: '' }] };
    await until(() => requests().length > 0);
    // Time enough for a second call to start if the loop ran them together.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(requests().length, 1, 'the second registration is held back until the first is answered');
    assert.deepEqual(requests()[0].args, { action: 'add_dispatches', dispatches: first });
    await fixture.worker.handle({ type: 'response', id: requests()[0].id, result: answer });
    await until(() => requests().length === 2);
    assert.deepEqual(requests()[1].args, { action: 'add_dispatches', dispatches: second });
    await fixture.worker.handle({ type: 'response', id: requests()[1].id, result: answer });
    await run;
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
    // The flag belongs to the local agent loop: the relay is sent nothing it does not know (1.2.0: an unknown field is refused).
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]), /executionMode|sequential|parallel/);
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
    assert.match(JSON.stringify(fixture.bodies[0]?.tools), /"name":"dispatch_member"/);
    await assert.rejects(access(join(fixture.init.agentDir, 'auth.json')));
    const resumedMessages: FromWorker[] = [];
    const resumed = new WorkerRuntime(message => resumedMessages.push(message));
    try {
      await resumed.handle({ ...fixture.init, sessionFile: done.sessionFile, canDelegate: false });
      await resumed.handle({ type: 'prompt', text: 'Continue from the saved session.' });
      assert.equal(resumedMessages.some(message => message.type === 'error'), false, JSON.stringify(resumedMessages));
      assert.match(JSON.stringify(fixture.bodies.at(-1)), /verified output/);
      assert.doesNotMatch(JSON.stringify(fixture.bodies.at(-1)?.tools), /"name":"dispatch_member"/);
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
  const child = fork(fileURLToPath(new URL('../../src/runtime/worker.ts', import.meta.url)), [], {
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

test('the dispatch tools list the subagents the app passes in, by the names the lead uses', { timeout: 30000 }, async () => {
  const fixture = await createFixture('ask', (_request, response) => stream(response));
  try {
    fixture.init.roles = [
      { id: 'executor', label: '执行员', description: '通用执行', readOnly: false },
      { id: 'reviewer', label: 'reviewer', description: 'REVIEWER_DESCRIPTION_SENTINEL', readOnly: true },
    ];
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: 'Who can I send?' });
    const tools = JSON.stringify(fixture.bodies[0]?.tools);
    assert.match(tools, /"name":"dispatch_member"/);
    assert.match(tools, /reviewer/);
    assert.match(tools, /REVIEWER_DESCRIPTION_SENTINEL/);
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
  } finally { await fixture.cleanup(); }
});

test('the dispatch tools tell the lead its 成员额度, and dispatch_team says to use dispatch_member when it is one', { timeout: 60000 }, async () => {
  const descriptions = async (squadSize?: number) => {
    const fixture = await createFixture('ask', (_request, response) => stream(response));
    try {
      if (squadSize !== undefined) fixture.init.squadSize = squadSize;
      await fixture.worker.handle(fixture.init);
      await fixture.worker.handle({ type: 'prompt', text: 'How many members may I hold?' });
      const tools = JSON.parse(JSON.stringify(fixture.bodies[0]?.tools)) as Array<{ function?: { name: string; description: string } }>;
      const describe = (name: string) => tools.find(tool => tool.function?.name === name)?.function?.description ?? '';
      return { member: describe('dispatch_member'), team: describe('dispatch_team') };
    } finally { await fixture.cleanup(); }
  };
  const three = await descriptions(3);
  assert.match(three.member, /at most 3 members at once/);
  assert.match(three.team, /2 to 6 members per call/, 'the limit of one call stays');
  assert.match(three.team, /at most 3 members at once/, 'but the lead holds no more than its quota');
  assert.doesNotMatch(three.team, /use dispatch_member/);
  const one = await descriptions(1);
  assert.match(one.member, /at most 1 member at once/);
  assert.match(one.team, /quota is 1/);
  assert.match(one.team, /dispatch_member/, 'with a quota of one a squad cannot be sent: use dispatch_member');
  const unset = await descriptions();
  assert.match(unset.member, /at most 6 members at once/, 'the default quota when the app says nothing');
});

test('a task the app marks read-only cannot write, and still follows its own subagent’s instructions', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => {
    stream(response, calls++ === 0 ? { name: 'write', args: { path: 'blocked.txt', content: 'must not land' } } : undefined, 'Reported instead.');
  });
  try {
    await fixture.worker.handle({ ...fixture.init, readOnly: true, roleDefinition: { id: 'reviewer', name: 'Reviewer', prompt: 'ROLE_PROMPT_SENTINEL', readOnly: false } });
    await fixture.worker.handle({ type: 'prompt', text: 'Write a file.' });
    await assert.rejects(access(join(fixture.cwd, 'blocked.txt')));
    const first = JSON.stringify(fixture.bodies[0]);
    assert.match(first, /ROLE_PROMPT_SENTINEL/, 'the subagent’s own instructions are kept');
    assert.match(first, /Read-only: inspect and report/);
    assert.match(JSON.stringify(fixture.bodies[1]), /read-only|只读/, 'the refused write went back to the model');
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
  } finally { await fixture.cleanup(); }
});

test('a read-only lead’s dispatch keeps the subagent it asked for and marks the member read-only', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('ask', (_request, response) => {
    stream(response, calls++ === 0 ? { name: 'dispatch_member', args: { role: 'reviewer', task: '看看 README，交回要点。', name: '审查甲' } } : undefined, 'Dispatched.');
  });
  try {
    await fixture.worker.handle({ ...fixture.init, planMode: true });
    const run = fixture.worker.handle({ type: 'prompt', text: 'Plan it with a reviewer.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'delegate'));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'delegate');
    assert.ok(request?.type === 'request');
    assert.equal(request.args.role, 'reviewer', 'not swapped for the built-in explorer');
    assert.equal(request.args.readOnly, true);
    await fixture.worker.handle({ type: 'response', id: request.id, result: { id: 'member-1', status: 'queued' } });
    await run;
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages));
  } finally { await fixture.cleanup(); }
});

test('the dispatch tools hand files and create to the app', { timeout: 30000 }, async () => {
  const steps = [
    { name: 'dispatch_member', args: { role: 'writer', task: '写黄袍怪', name: '白骨精', files: ['世界书/人设/120-红孩儿.md'], create: ['黄袍怪'] } },
    { name: 'dispatch_team', args: { members: [{ name: '甲手', task: '写甲', role: 'writer', create: ['甲'] }, { name: '乙手', task: '写乙', role: 'writer', files: ['世界书/人设/121-乙.md'] }] } },
  ];
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, steps[calls++], 'Dispatched.'));
  try {
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'Send the writers.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'delegate'));
    const single = fixture.messages.find(message => message.type === 'request' && message.method === 'delegate');
    assert.ok(single?.type === 'request');
    assert.deepEqual([single.args.files, single.args.create], [['世界书/人设/120-红孩儿.md'], ['黄袍怪']]);
    await fixture.worker.handle({ type: 'response', id: single.id, result: { id: 'member-1', status: 'queued' } });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'team'));
    const team = fixture.messages.find(message => message.type === 'request' && message.method === 'team');
    assert.ok(team?.type === 'request');
    assert.deepEqual((team.args.members as Array<Record<string, unknown>>).map(member => [member.files ?? null, member.create ?? null]), [[null, ['甲']], [['世界书/人设/121-乙.md'], null]]);
    await fixture.worker.handle({ type: 'response', id: team.id, result: { squadId: 'squad-1', members: [{ id: 'member-2', status: 'queued' }, { id: 'member-3', status: 'queued' }] } });
    await run;
  } finally { await fixture.cleanup(); }
});

const toolNames = (body: Record<string, unknown> | undefined) => ((body?.tools ?? []) as Array<{ function: { name: string } }>).map(item => item.function.name).sort();

test('a card squad member is offered only its own tools', { timeout: 60000 }, async () => {
  const cases: Array<{ member: CardSquadAssignment; web: boolean; expected: string[] }> = [
    { member: { role: 'researcher', files: [], create: [] }, web: false, expected: ['card_check', 'card_search_sources', 'ls', 'read'] },
    { member: { role: 'writer', files: [], create: ['黄袍怪'] }, web: false, expected: ['card_check', 'card_new_component', 'card_search_sources', 'edit', 'ls', 'read', 'write'] },
    { member: { role: 'researcher', files: [], create: [] }, web: true, expected: ['card_check', 'card_search_sources', 'fetch_content', 'ls', 'read', 'web_search'] },
  ];
  for (const { member, web, expected } of cases) {
    const fixture = await createFixture('edit', (_request, response) => stream(response));
    try {
      fixture.init.canDelegate = false;
      fixture.init.readOnly = member.role === 'researcher';
      fixture.init.card = { prompt: '小队成员测试。', readRoots: [], member };
      if (web) fixture.init.search = { enabled: true, provider: 'searxng', baseUrl: 'http://127.0.0.1:9', hasKey: false };
      await fixture.worker.handle(fixture.init);
      await fixture.worker.handle({ type: 'prompt', text: '开工。' });
      assert.deepEqual(toolNames(fixture.bodies[0]), expected, `${member.role}${web ? ' with web' : ''}`);
    } finally { await fixture.cleanup(); }
  }
});

test('a card squad member is not told about the skill tools it does not have; its lead still is', { timeout: 60000 }, async () => {
  const sentence = 'search_skills finds relevant local skills';
  for (const member of [undefined, { role: 'writer' as const, files: [], create: ['黄袍怪'] }]) {
    const fixture = await createFixture('edit', (_request, response) => stream(response));
    try {
      fixture.init.canDelegate = !member;
      fixture.init.card = { prompt: '制卡测试。', readRoots: [], ...(member ? { member } : {}) };
      await fixture.worker.handle(fixture.init);
      await fixture.worker.handle({ type: 'prompt', text: '开工。' });
      assert.equal(JSON.stringify(fixture.bodies[0]).includes(sentence), !member, member ? 'the member' : 'the lead');
    } finally { await fixture.cleanup(); }
  }
});

test('a card lead’s dispatch tools speak of the card folder and say what files and create are, not of Git worktrees', { timeout: 60000 }, async () => {
  type Schema = { description?: string; properties?: Record<string, Schema>; items?: Schema };
  const dispatch = async (card: boolean) => {
    const fixture = await createFixture('edit', (_request, response) => stream(response));
    try {
      if (card) { fixture.init.card = { prompt: '制卡测试。', readRoots: [] }; fixture.init.roles = [CARD_ROLES.researcher, CARD_ROLES.writer]; }
      await fixture.worker.handle(fixture.init);
      await fixture.worker.handle({ type: 'prompt', text: '开工。' });
      const tools = (fixture.bodies[0]?.tools ?? []) as Array<{ function: { name: string; description: string; parameters: Schema } }>;
      const tool = (name: string) => tools.find(item => item.function.name === name)!.function;
      const member = tool('dispatch_member');
      const team = tool('dispatch_team');
      const fields = team.parameters.properties?.members?.items?.properties ?? {};
      return { member: member.description, team: team.description, files: [member.parameters.properties?.files?.description ?? '', fields.files?.description ?? ''], create: [member.parameters.properties?.create?.description ?? '', fields.create?.description ?? ''] };
    } finally { await fixture.cleanup(); }
  };
  const card = await dispatch(true);
  for (const text of [card.member, card.team]) { assert.doesNotMatch(text, /Git|worktree/); assert.match(text, /card folder/); }
  for (const text of card.files) assert.match(text, /写组件.*relative to the card folder/);
  for (const text of card.create) assert.match(text, /写组件.*card_new_component/);
  const workbench = await dispatch(false);
  assert.match(workbench.member, /worktree/, 'the workbench wording stays');
  for (const text of [...workbench.files, ...workbench.create]) assert.match(text, /card studio/);
});

test('a card lead whose reply is cut off at the output limit waits for its members, then fails without a recap', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => {
    if (calls++ === 0) { stream(response, { name: 'dispatch_member', args: { role: 'researcher', task: '查红孩儿的出处', name: '土地公' } }); return; }
    // The reply stops at the output limit.
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'cut', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant' }); chunk({ content: '收尾写到一半' }); chunk({}, 'length');
    response.write(`data: ${JSON.stringify({ id: 'cut', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const answer = async (method: string, result: unknown) => {
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === method));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === method);
    assert.ok(request?.type === 'request');
    await fixture.worker.handle({ type: 'response', id: request.id, result });
  };
  try {
    fixture.init.card = { prompt: '制卡测试。', readRoots: [] };
    fixture.init.roles = [CARD_ROLES.researcher];
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '查资料。' });
    await answer('delegate', { id: 'member-1', name: '土地公', status: 'running', result: '' });
    await answer('agents', [{ id: 'member-1', status: 'running' }]);
    await answer('wait', [{ id: 'member-1', status: 'completed', result: '红孩儿：第四十回' }]);
    await run;
    assert.equal(fixture.bodies.length, 2, 'no recap turn after a cut-off reply');
    const waited = fixture.messages.findIndex(message => message.type === 'request' && message.method === 'wait');
    const failed = fixture.messages.findIndex(message => message.type === 'error');
    assert.ok(waited >= 0 && failed > waited, 'the run fails only once its member is back');
    assert.ok(fixture.messages.some(message => message.type === 'event' && message.event.type === 'output_truncated'));
  } finally { await fixture.cleanup(); }
});

test('a 写组件 member writes only its files and the components it created; shared files stay with the lead', { timeout: 30000 }, async () => {
  const steps = [
    { name: 'write', args: { path: '世界书/人设/120-红孩儿.md', content: '<红孩儿>\n写好了\n</红孩儿>\n' } },
    { name: 'write', args: { path: '设计书.md', content: '成员改的设计书' } },
    { name: 'write', args: { path: '世界书/人设/121-别人.md', content: '不该写' } },
    { name: 'card_new_component', args: { name: '黄袍怪', section: 'lore-people' } },
    { name: 'write', args: { path: '世界书/人设/130-黄袍怪.md', content: '<黄袍怪>\n</黄袍怪>\n' } },
  ];
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, steps[calls++], 'Returned.'));
  try {
    await mkdir(join(fixture.cwd, '世界书', '人设'), { recursive: true });
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: '小队成员测试。', readRoots: [], member: { role: 'writer', files: ['世界书/人设/120-红孩儿.md', '设计书.md'], create: ['黄袍怪'] } };
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '写红孩儿和黄袍怪。' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'card'));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'card');
    assert.ok(request?.type === 'request');
    assert.equal(request.args.action, 'new_component');
    await fixture.worker.handle({ type: 'response', id: request.id, result: { uid: 130, section: 'lore-people', paramsPath: '世界书/人设/130-黄袍怪.json', bodyPath: '世界书/人设/130-黄袍怪.md' } });
    await run;
    assert.match(await readFile(join(fixture.cwd, '世界书', '人设', '120-红孩儿.md'), 'utf8'), /写好了/);
    assert.match(await readFile(join(fixture.cwd, '世界书', '人设', '130-黄袍怪.md'), 'utf8'), /黄袍怪/);
    await assert.rejects(access(join(fixture.cwd, '设计书.md')), 'a shared file is refused even when it was listed');
    await assert.rejects(access(join(fixture.cwd, '世界书', '人设', '121-别人.md')));
    const writes = fixture.messages.flatMap(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'write' ? [message.event] : []);
    assert.deepEqual(writes.map(event => event.isError), [false, true, true, false]);
    const seen = JSON.stringify(fixture.bodies.at(-1));
    assert.match(seen, /共享文件/, 'the model is told why the shared file was refused');
    assert.match(seen, /没有分给你/);
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
  } finally { await fixture.cleanup(); }
});

test('a 写组件 sent again may still write the components it created in an earlier run', { timeout: 30000 }, async () => {
  const steps = [{ name: 'write', args: { path: '世界书/人设/130-黄袍怪.md', content: '<黄袍怪>\n第二次写\n</黄袍怪>\n' } }];
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, steps[calls++], 'Returned.'));
  try {
    await mkdir(join(fixture.cwd, '世界书', '人设'), { recursive: true });
    fixture.init.canDelegate = false;
    fixture.init.card = { prompt: '小队成员测试。', readRoots: [], member: { role: 'writer', files: [], create: ['黄袍怪'], created: [{ name: '黄袍怪', paths: ['世界书/人设/130-黄袍怪.md', '世界书/人设/130-黄袍怪.json'] }] } };
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '接着写黄袍怪。' });
    assert.match(await readFile(join(fixture.cwd, '世界书', '人设', '130-黄袍怪.md'), 'utf8'), /第二次写/);
    assert.doesNotMatch(JSON.stringify(fixture.bodies.at(-1)), /没有分给你/);
  } finally { await fixture.cleanup(); }
});

test('a card squad member never asks: what would need approval is refused', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, calls++ === 0 ? { name: 'read', args: { path: '../outside.txt' } } : undefined, 'Returned.'));
  try {
    await writeFile(join(fixture.root, 'outside.txt'), 'outside the card');
    fixture.init.canDelegate = false;
    fixture.init.readOnly = true;
    fixture.init.card = { prompt: '小队成员测试。', readRoots: [], member: { role: 'researcher', files: [], create: [] } };
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '读一下外面的文件。' });
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
    const read = fixture.messages.find(message => message.type === 'event' && message.event.type === 'tool_execution_end' && message.event.toolName === 'read');
    assert.ok(read?.type === 'event');
    assert.equal(read.event.isError, true);
    assert.match(JSON.stringify(fixture.bodies.at(-1)), /不能做需要审批的操作/);
  } finally { await fixture.cleanup(); }
});

test('with 联网 on, a 查资料 member searches without asking', { timeout: 30000 }, async () => {
  let searches = 0;
  const searchServer = createServer((_request, response) => { searches++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ results: [{ title: '红孩儿', url: 'https://example.com/hong', content: '火云洞' }] })); });
  await new Promise<void>(resolve => searchServer.listen(0, '127.0.0.1', resolve));
  const address = searchServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing search server address');
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, calls++ === 0 ? { name: 'web_search', args: { query: '红孩儿', count: 1 } } : undefined, 'Returned.'));
  try {
    fixture.init.canDelegate = false;
    fixture.init.readOnly = true;
    fixture.init.search = { enabled: true, provider: 'searxng', baseUrl: `http://127.0.0.1:${address.port}`, hasKey: false };
    fixture.init.card = { prompt: '小队成员测试。', readRoots: [], member: { role: 'researcher', files: [], create: [] } };
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '查红孩儿。' });
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'approve'), false);
    assert.equal(searches, 1);
  } finally {
    await fixture.cleanup();
    searchServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => searchServer.close(error => error ? reject(error) : resolve()));
  }
});

test('a card lead’s squad rules come from its prompt, not the workbench’s Ultra line', { timeout: 30000 }, async () => {
  const fixture = await createFixture('edit', (_request, response) => stream(response));
  try {
    fixture.init.thinking = 'ultra';
    fixture.init.roles = [CARD_ROLES.researcher];
    fixture.init.card = { prompt: '## 小队\n派发规则测试。', readRoots: [] };
    await fixture.worker.handle(fixture.init);
    await fixture.worker.handle({ type: 'prompt', text: '开工。' });
    const body = JSON.stringify(fixture.bodies[0]);
    assert.doesNotMatch(body, /规划 Ultra/);
    assert.doesNotMatch(body, /Ultra: default to/);
    assert.match(body, /派发规则测试/);
  } finally { await fixture.cleanup(); }
});

test('a card lead waits for the members it never collected, then wraps up with their reports', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => {
    const step = calls++;
    stream(response, step === 0 ? { name: 'dispatch_member', args: { role: 'researcher', task: '查红孩儿的出处', name: '土地公' } } : undefined, step === 1 ? '派出去了。' : '已收尾。');
  });
  const answer = async (method: string, result: unknown) => {
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === method));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === method);
    assert.ok(request?.type === 'request');
    await fixture.worker.handle({ type: 'response', id: request.id, result });
  };
  try {
    fixture.init.card = { prompt: '制卡测试。', readRoots: [] };
    fixture.init.roles = [CARD_ROLES.researcher];
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: '查资料。' });
    await answer('delegate', { id: 'member-1', name: '土地公', status: 'running', result: '' });
    await answer('agents', [{ id: 'member-1', status: 'running' }]);
    await answer('wait', [{ id: 'member-1', status: 'completed', result: '红孩儿：第四十回' }]);
    await run;
    assert.equal(fixture.bodies.length, 3, 'one more turn to wrap up');
    const recap = JSON.stringify(fixture.bodies[2]);
    assert.match(recap, /小队成员都回来了/);
    assert.match(recap, /第四十回/);
    assert.match(recap, /cardwright:incomplete/);
    assert.equal(fixture.messages.some(message => message.type === 'error'), false, JSON.stringify(fixture.messages.filter(message => message.type === 'error')));
  } finally { await fixture.cleanup(); }
});

test('a workbench lead below Ultra still ends its turn without waiting for its members', { timeout: 30000 }, async () => {
  let calls = 0;
  const fixture = await createFixture('edit', (_request, response) => stream(response, calls++ === 0 ? { name: 'dispatch_member', args: { role: 'explorer', task: '看看 README' } } : undefined, 'Dispatched.'));
  try {
    await fixture.worker.handle(fixture.init);
    const run = fixture.worker.handle({ type: 'prompt', text: 'Send someone.' });
    await until(() => fixture.messages.some(message => message.type === 'request' && message.method === 'delegate'));
    const request = fixture.messages.find(message => message.type === 'request' && message.method === 'delegate');
    assert.ok(request?.type === 'request');
    await fixture.worker.handle({ type: 'response', id: request.id, result: { id: 'member-9', status: 'queued' } });
    await run;
    assert.equal(fixture.messages.some(message => message.type === 'request' && message.method === 'agents'), false);
    assert.equal(fixture.bodies.length, 2);
  } finally { await fixture.cleanup(); }
});
