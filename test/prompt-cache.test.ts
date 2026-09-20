import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';
import { PrefixMeter, contextSnapshot } from '../src/runtime/prompt-cache.ts';
import { cardwrightSystemPrompt, createResources } from '../src/runtime/resources.ts';
import { searchSkillCatalog } from '../src/runtime/skill-tools.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import type { FromWorker, WorkerInit } from '../src/shared/types.ts';

test('fixed base prompt stays small and independent of model identity', () => {
  const identity = { modelId: 'changed-model', gatewayName: 'new-gateway', protocol: 'openai-completions', selectedEffort: 'ultra' };
  assert.equal(cardwrightSystemPrompt(), cardwrightSystemPrompt(identity));
  assert.ok(cardwrightSystemPrompt().length < 1500);
  assert.doesNotMatch(cardwrightSystemPrompt(identity), /changed-model|new-gateway|ultra/);
});

test('changing model facts appends only that section, preserving user instructions', () => {
  const initial = contextSnapshot({ facts: 'model-a', instructions: 'Keep this exact user rule.' })!;
  const changed = contextSnapshot({ facts: 'model-b', instructions: 'Keep this exact user rule.' }, initial.details.digests)!;
  assert.match(changed.content, /model-b/);
  assert.doesNotMatch(changed.content, /Keep this exact user rule/);
  assert.equal(contextSnapshot({ facts: 'model-a', instructions: 'Keep this exact user rule.' }, initial.details.digests), undefined);
});

test('local prefix metric separates byte reuse from server cache hits', () => {
  const meter = new PrefixMeter();
  const first = { messages: [{ role: 'user', content: 'hello '.repeat(100) }], tools: [{ name: 'read' }] };
  assert.equal(meter.observe(first)!.sharedBytes, 0);
  const second = meter.observe({ ...first, messages: [...first.messages, { role: 'assistant', content: 'done' }] })!;
  assert.ok(second.sharedPercent > 80);
  assert.equal(second.measurement, 'local-estimate');
  assert.equal('cacheRead' in second, false);
  assert.ok(meter.observe({ ...first, tools: [{ name: 'changed' }] })!.sharedPercent < 20);
});

test('skill search excludes manual-only entries and bounds returned descriptions', () => {
  const make = (name: string, manual = false): Skill => ({ name, description: 'frontend ' + 'design '.repeat(200), filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, sourceInfo: createSyntheticSourceInfo('/skills', { source: 'test' }), disableModelInvocation: manual });
  const skills = [make('z-front'), make('a-front'), make('secret-front', true)];
  const matches = searchSkillCatalog(skills, 'frontend', 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'a-front');
  assert.ok(matches[0].description.length <= 600);
  assert.deepEqual(searchSkillCatalog(skills, 'secret-front'), []);
});

function respond(response: ServerResponse, text: string, tokens = 100, tool?: { name: string; args: Record<string, unknown> }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  emit({ role: 'assistant' }, null);
  if (tool) emit({ tool_calls: [{ index: 0, id: 'call-' + tool.name, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, 'tool_calls');
  else emit({ content: text }, 'stop');
  response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [], usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10, prompt_tokens_details: { cached_tokens: Math.min(50, tokens) } } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function fixture(handler: (body: Record<string, any>, response: ServerResponse) => void, protocol: WorkerInit['gateway']['protocol'] = 'openai-completions') {
  const root = await mkdtemp(join(tmpdir(), 'cw-prompt-cache-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const bodies: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); handler(body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const init: WorkerInit = { type: 'init', taskId: 'cache-fixture', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), gateway: { id: 'test', name: 'Test', modelId: 'fixture', protocol, reasoning: false, hasKey: true, baseUrl: `http://127.0.0.1:${address.port}${protocol === 'anthropic-messages' ? '' : '/v1'}`, contextWindow: 32000, maxTokens: 4000 }, apiKey: 'fixture-key', thinking: 'off', permission: 'edit', instructions: 'Fixture saved instruction.', skillPaths: [], canDelegate: false };
  const messages: FromWorker[] = [];
  const worker = new WorkerRuntime(message => messages.push(message));
  return { root, cwd, init, messages, bodies, worker, async close() { await worker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.match(root, /cw-prompt-cache-/); await rm(root, { recursive: true, force: true }); } };
}

test('actual worker keeps prefix stable, loads skill bodies only on request and respects disabled invocation', { timeout: 30000 }, async () => {
  let call = 0;
  const f = await fixture((_body, response) => {
    if (call++ === 0) respond(response, '', 100, { name: 'search_skills', args: { query: 'frontend' } });
    else if (call === 2) respond(response, '', 100, { name: 'use_skill', args: { name: 'frontend-fixture' } });
    else respond(response, 'Done.');
  });
  try {
    const dir = join(f.root, 'skills', 'frontend'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: frontend-fixture\ndescription: frontend styling\n---\nBODY_LOADED_ON_DEMAND');
    f.init.skillPaths = [join(f.root, 'skills')];
    await writeFile(join(f.cwd, 'AGENTS.md'), 'PRESERVE_USER_PROJECT_RULES');
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Work on frontend.' });
    assert.equal(f.messages.some(message => message.type === 'error'), false);
    assert.doesNotMatch(JSON.stringify(f.bodies[0]), /BODY_LOADED_ON_DEMAND|frontend styling/);
    assert.match(JSON.stringify(f.bodies[1]), /frontend styling/);
    assert.match(JSON.stringify(f.bodies[2]), /BODY_LOADED_ON_DEMAND/);
    assert.match(JSON.stringify(f.bodies[0]), /PRESERVE_USER_PROJECT_RULES/);
    const system = f.bodies[0].messages[0];
    assert.ok(system.content.length < 1700);
    for (const body of f.bodies) { assert.deepEqual(body.messages[0], system); assert.deepEqual(body.tools, f.bodies[0].tools); }
    await f.worker.handle({ type: 'prompt', text: 'Continue.' });
    const last = f.bodies.at(-1)!;
    assert.equal(JSON.stringify(last).split('Fixture saved instruction.').length - 1, 1);
    assert.equal(f.messages.some(message => message.type === 'request'), false);
    assert.ok(f.messages.some(message => message.type === 'event' && message.event.type === 'cache_prefix' && Number(message.event.sharedPercent) > 80));
  } finally { await f.close(); }
});

function respondOtherProtocol(response: ServerResponse, protocol: 'openai-responses' | 'anthropic-messages', text: string, tokens: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (value: Record<string, unknown>) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  if (protocol === 'anthropic-messages') {
    event({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    event({ type: 'message_stop' });
  } else {
    const final = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' };
    event({ type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...final, content: [], status: 'in_progress' } });
    event({ type: 'response.content_part.added', output_index: 0, item_id: final.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event({ type: 'response.output_text.delta', output_index: 0, item_id: final.id, content_index: 0, delta: text });
    event({ type: 'response.output_item.done', output_index: 0, item: final });
    event({ type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [final], usage: { input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  }
  response.end();
}

test('prefix compaction uses the real Responses and Anthropic wire protocols', { timeout: 30000 }, async t => {
  for (const protocol of ['openai-responses', 'anthropic-messages'] as const) await t.test(protocol, async () => {
    let conversations = 0; let compactions = 0;
    const f = await fixture((body, response) => {
      if (JSON.stringify((body.messages ?? body.input).at(-1)).includes('Summarize the conversation above into a concise checkpoint')) {
        compactions++; respondOtherProtocol(response, protocol, 'Goal: finish fixture. Done: inspect. Next: verify.', 100);
      } else respondOtherProtocol(response, protocol, 'Fixture complete.', ++conversations >= 3 ? 29500 : 100);
    }, protocol);
    try {
      await f.worker.handle(f.init);
      for (let i = 0; i < 3; i++) await f.worker.handle({ type: 'prompt', text: `${i}: ` + 'unchanged protocol fixture '.repeat(2000) });
      assert.equal(f.messages.some(message => message.type === 'error'), false, f.messages.filter(message => message.type === 'error').map(message => message.message).join('\n'));
      assert.ok(compactions > 0);
      const compactBody = f.bodies.find(body => JSON.stringify((body.messages ?? body.input).at(-1)).includes('Summarize the conversation above into a concise checkpoint'))!;
      const first = f.bodies[0];
      assert.deepEqual(compactBody.tools, first.tools);
      assert.deepEqual(compactBody.system ?? compactBody.instructions, first.system ?? first.instructions);
      const withoutCacheMarkers = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item));
      const compactMessages = compactBody.messages ?? compactBody.input;
      const originalMessages = f.bodies[2].messages ?? f.bodies[2].input;
      assert.deepEqual(withoutCacheMarkers(compactMessages.slice(0, -1)), withoutCacheMarkers(originalMessages.slice(0, compactMessages.length - 1)));
      const done = f.messages.findLast(message => message.type === 'done'); assert.ok(done?.type === 'done' && done.sessionFile);
      assert.match(await readFile(done.sessionFile, 'utf8'), /cardwright-prefix-v1/);
    } finally { await f.close(); }
  });
});

test('actual worker compression preserves system/tool prefix and records one checkpoint', { timeout: 30000 }, async () => {
  let conversations = 0; let compactions = 0;
  const f = await fixture((body, response) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes('Summarize the conversation above into a concise checkpoint')) { compactions++; respond(response, 'Goal: preserve the fixture. Done: read context. Next: continue the user task.'); }
    else respond(response, 'Verified fixture.', ++conversations >= 3 ? 29500 : 100);
  });
  try {
    await f.worker.handle(f.init);
    for (let i = 0; i < 3; i++) await f.worker.handle({ type: 'prompt', text: `Part ${i}: ` + 'stable project detail '.repeat(2200) });
    assert.equal(f.messages.some(message => message.type === 'error'), false, f.messages.filter(message => message.type === 'error').map(message => message.message).join('\n'));
    assert.ok(compactions >= 1);
    const compactBody = f.bodies.find(body => JSON.stringify(body.messages.at(-1)).includes('Summarize the conversation above into a concise checkpoint'))!;
    assert.deepEqual(compactBody.messages[0], f.bodies[0].messages[0]);
    assert.deepEqual(compactBody.tools, f.bodies[0].tools);
    assert.deepEqual(compactBody.messages.slice(0, -1), f.bodies[2].messages.slice(0, compactBody.messages.length - 1));
    const done = f.messages.findLast(message => message.type === 'done'); assert.ok(done?.type === 'done' && done.sessionFile);
    const history = await readFile(done.sessionFile, 'utf8');
    assert.match(history, /cardwright-prefix-v1/);
    assert.equal(f.messages.filter(message => message.type === 'event' && message.event.type === 'nested_usage' && message.event.purpose === 'compaction').length, compactions);
  } finally { await f.close(); }
});

test('a rejected summary keeps history and does not launch a second summarizer or execute its tool', { timeout: 30000 }, async () => {
  let conversations = 0; let compactions = 0;
  const f = await fixture((body, response) => {
    if (JSON.stringify(body.messages.at(-1)).includes('Summarize the conversation above into a concise checkpoint')) {
      compactions++; respond(response, '', 100, { name: 'write', args: { path: 'should-not-exist', content: 'no' } });
    } else respond(response, 'Fixture response.', ++conversations >= 3 ? 29500 : 100);
  });
  try {
    await f.worker.handle(f.init);
    for (let i = 0; i < 3; i++) await f.worker.handle({ type: 'prompt', text: `${i}: ` + 'long retained fixture '.repeat(2200) });
    assert.equal(compactions, 1); assert.equal(f.bodies.length, 4);
    assert.ok(f.messages.some(message => message.type === 'event' && message.event.type === 'workflow_notice' && String(message.event.message).includes('attempted a tool call')));
    assert.equal(f.messages.some(message => message.type === 'request'), false);
    const done = f.messages.findLast(message => message.type === 'done'); assert.ok(done?.type === 'done' && done.sessionFile);
    const history = await readFile(done.sessionFile, 'utf8');
    assert.doesNotMatch(history, /"type":"compaction"/);
    assert.match(history, /long retained fixture/);
  } finally { await f.close(); }
});

test('worker sends immutable image bytes and selected file references across follow-up requests', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response, 'Image received.'));
  try {
    const root = join(f.root, 'attachments'); await mkdir(root);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1kAAAAASUVORK5CYII=';
    const path = join(root, 'pixel.png'); await writeFile(path, Buffer.from(png, 'base64'));
    const note = join(root, 'note.txt'); await writeFile(note, 'attachment fixture');
    f.init.attachmentRoot = root;
    await f.worker.handle(f.init);
    await f.worker.handle({ type: 'prompt', text: 'Inspect this.', attachments: [
      { id: 'image', name: 'pixel.png', kind: 'image', mimeType: 'image/png', bytes: Buffer.from(png, 'base64').length, storedPath: path },
      { id: 'file', name: 'note.txt', kind: 'file', mimeType: 'text/plain', bytes: 18, storedPath: note },
    ] });
    await f.worker.handle({ type: 'prompt', text: 'Continue.' });
    for (const body of f.bodies) { assert.match(JSON.stringify(body), /image_url/); assert.match(JSON.stringify(body), new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.match(JSON.stringify(body), /note.txt/); }
    const requests = f.bodies.length;
    await f.worker.handle({ type: 'prompt', text: 'Reject outside reference.', attachments: [{ id: 'bad', name: 'outside.txt', kind: 'file', mimeType: 'text/plain', bytes: 1, storedPath: join(f.cwd, 'outside.txt') }] });
    assert.equal(f.bodies.length, requests);
    assert.ok(f.messages.some(message => message.type === 'error' && message.message.includes('outside')));
  } finally { await f.close(); }
});
