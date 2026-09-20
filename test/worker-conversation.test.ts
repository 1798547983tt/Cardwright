import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import type { FromWorker, WorkerInit } from '../src/shared/types.ts';

function respond(response: ServerResponse, text = 'Finished.', tool?: { name: string; args: Record<string, unknown> }, usage = { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'remote-alias', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) { chunk({ tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); chunk({}, 'tool_calls'); }
  else { chunk({ content: text }); chunk({}, 'stop'); }
  response.write(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-conversation-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    const body = JSON.parse(data) as Record<string, unknown>; bodies.push(body); handler(body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const messages: FromWorker[] = [];
  const workers: WorkerRuntime[] = [];
  const newWorker = () => { const worker = new WorkerRuntime(value => messages.push(value)); workers.push(worker); return worker; };
  const init: WorkerInit = { type: 'init', taskId: 'conversation-fixture', cwd, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), gateway: { id: 'gateway', name: 'Fixture gateway', modelId: 'configured-model', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, hasKey: true, reasoning: true, maxTokens: 24000, contextWindow: 64000 }, thinking: 'ultra', permission: 'ask', apiKey: 'fixture-private-key', instructions: '', skillPaths: [], canDelegate: false, skillFiles: [] };
  return { root, cwd, init, bodies, messages, newWorker, async close() { for (const worker of workers) await worker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /cardwright-conversation-/); await rm(root, { recursive: true, force: true }); } };
}

async function until(predicate: () => boolean) { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const userEntries = (messages: FromWorker[]) => messages.filter(message => message.type === 'event' && message.event.type === 'session_entry' && message.event.role === 'user').map(message => { assert.equal(message.type, 'event'); return message.event; });

test('worker injects Cardwright identity and sends max for default Ultra into the real request', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response));
  try {
    const worker = f.newWorker(); await worker.handle(f.init); await worker.handle({ type: 'prompt', text: 'Which model are you?', messageId: 'user-identity' });
    assert.equal(f.bodies.length, 1, JSON.stringify(f.messages));
    assert.equal(f.bodies[0].reasoning_effort, 'max');
    const payload = JSON.stringify(f.bodies[0]);
    assert.match(payload, /configured-model/); assert.match(payload, /configured model ID/); assert.match(payload, /Cardwright, a desktop coding assistant/);
    assert.doesNotMatch(payload, /operating inside pi|Pi documentation|fixture-private-key/);
    assert.doesNotMatch(payload, /ULTRA TEAM MODE|"name":"agent_team"/);
    assert.ok(f.messages.some(item => item.type === 'event' && item.event.type === 'thinking_level_changed' && item.event.level === 'ultra' && item.event.runtimeLevel === 'max'));
    const entries = userEntries(f.messages); assert.equal(entries.length, 1); assert.equal(entries[0].messageId, 'user-identity');
    const done = f.messages.findLast(item => item.type === 'done'); assert.ok(done?.type === 'done'); assert.ok(done.sessionLeafId); assert.equal(done.userEntries?.[0].entryId, entries[0].entryId);
  } finally { await f.close(); }
});

test('Ultra lead automatically collects late members and synthesizes once in the same visible turn', { timeout: 30000 }, async () => {
  let calls = 0;
  const members = [{ name: '界面匠', prompt: 'Review layout.' }, { name: '验收员', prompt: 'Review cases.' }];
  const f = await fixture((_body, response) => {
    const call = calls++;
    if (call === 0 || call === 2) respond(response, '', { name: 'agent_team', args: { members } });
    else respond(response, call === 1 ? 'My own part is finished.' : 'The complete squad result is synthesized.');
  });
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, canDelegate: true });
    const run = worker.handle({ type: 'prompt', text: 'Coordinate independent layout and case reviews.', messageId: 'late-squad' });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'team'));
    const team = f.messages.find(item => item.type === 'request' && item.method === 'team'); assert.ok(team?.type === 'request');
    await worker.handle({ type: 'response', id: team.id, result: { members: [{ id: 'layout', name: '界面匠' }, { id: 'cases', name: '验收员' }] } });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'agents'));
    const inspect = f.messages.find(item => item.type === 'request' && item.method === 'agents'); assert.ok(inspect?.type === 'request'); assert.deepEqual(inspect.args.taskIds, ['layout', 'cases']);
    await worker.handle({ type: 'response', id: inspect.id, result: [{ id: 'layout', status: 'completed', result: 'LAYOUT_RESULT' }, { id: 'cases', status: 'running' }] });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'wait'));
    assert.equal(f.messages.some(item => item.type === 'done'), false, 'Lead must remain active until late member returns.');
    const wait = f.messages.find(item => item.type === 'request' && item.method === 'wait'); assert.ok(wait?.type === 'request');
    await worker.handle({ type: 'response', id: wait.id, result: [{ id: 'layout', status: 'completed', result: 'LAYOUT_RESULT' }, { id: 'cases', status: 'completed', result: 'LATE_CASES_RESULT' }] });
    await run;
    assert.equal(f.bodies.length, 4, JSON.stringify(f.messages));
    assert.match(JSON.stringify(f.bodies[2]), /LATE_CASES_RESULT/);
    assert.equal(f.messages.filter(item => item.type === 'request' && item.method === 'team').length, 1, 'Final synthesis must not create an unbounded new squad.');
    assert.match(JSON.stringify(f.bodies[3]), /additional delegation can start with a new user request/);
    assert.equal(userEntries(f.messages).length, 1, 'Internal recap must not add a visible user turn.');
    const assistantTurns = f.messages.filter(item => item.type === 'event' && item.event.type === 'message_start' && (item.event.message as { role?: string })?.role === 'assistant').map(item => item.type === 'event' ? item.event.turnId : undefined);
    assert.deepEqual(assistantTurns, ['late-squad', 'late-squad', 'late-squad', 'late-squad']);
    assert.equal(f.messages.filter(item => item.type === 'done').length, 1);
  } finally { await f.close(); }
});

test('context usage reflects provider totals and the configured window', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response));
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, gateway: { ...f.init.gateway, contextWindow: 300000 } });
    await worker.handle({ type: 'prompt', text: 'Report a small response.', messageId: 'usage' });
    const context = f.messages.findLast(item => item.type === 'event' && item.event.type === 'context_usage'); assert.ok(context?.type === 'event');
    assert.equal(context.event.tokens, 144); assert.equal(context.event.window, 300000); assert.equal(context.event.percent, 144 / 300000 * 100);
  } finally { await f.close(); }
});

test('/compact compacts at once and says so, and too little to compact is a plain notice', { timeout: 30000 }, async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    const call = calls++;
    if (call < 2) respond(response, 'A'.repeat(100000), undefined, { prompt_tokens: 30000 + call * 25000, completion_tokens: 25000, total_tokens: 55000 + call * 25000 });
    else if (call === 2) respond(response, 'A short reply.');
    else respond(response, '## Goal\nKeep the request.\n## Progress\nThe first long reply was summarized.');
  });
  const notices = () => f.messages.filter(item => item.type === 'event' && item.event.type === 'workflow_notice').map(item => item.type === 'event' ? String(item.event.message) : '');
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, gateway: { ...f.init.gateway, contextWindow: 1_000_000 } });
    await worker.handle({ type: 'prompt', text: '/compact', messageId: 'too-early' });
    assert.equal(f.bodies.length, 0, 'nothing is sent to the model when there is nothing to compact');
    assert.match(notices().at(-1) ?? '', /无需压缩/);
    for (const [text, id] of [['First long reply.', 'one'], ['Second long reply.', 'two'], ['A short one.', 'three']]) await worker.handle({ type: 'prompt', text, messageId: id });
    await worker.handle({ type: 'prompt', text: '/compact', messageId: 'manual' });
    assert.equal(f.bodies.length, 4, 'one summarization request');
    assert.ok(f.messages.some(item => item.type === 'event' && item.event.type === 'compaction_end' && item.event.result));
    assert.match(notices().at(-1) ?? '', /已压缩上下文/);
    assert.equal(f.messages.some(item => item.type === 'error'), false, JSON.stringify(f.messages.filter(item => item.type === 'error')));
    assert.doesNotMatch(JSON.stringify(f.bodies), /"\/compact"/, 'the command itself never reaches the model');
  } finally { await f.close(); }
});

test('automatic compaction triggers above 90 percent and publishes unknown context until the next response', { timeout: 30000 }, async () => {
  let calls = 0;
  const f = await fixture((_body, response) => {
    if (calls++ === 0) respond(response, 'A'.repeat(100000), undefined, { prompt_tokens: 270000, completion_tokens: 24, total_tokens: 270024 });
    else respond(response, '## Goal\nKeep the request.\n## Progress\nA completed fixture reply.');
  });
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, gateway: { ...f.init.gateway, contextWindow: 300000 } });
    await worker.handle({ type: 'prompt', text: 'Produce the fixture reply.', messageId: 'compact' });
    const compressed = f.messages.find(item => item.type === 'event' && item.event.type === 'compaction_end' && item.event.result);
    assert.ok(compressed, JSON.stringify(f.messages.filter(item => item.type !== 'event' || ['compaction_end', 'workflow_compaction', 'context_usage'].includes(String(item.event.type)))));
    assert.ok(f.messages.some(item => item.type === 'event' && item.event.type === 'workflow_compaction'));
    const context = f.messages.findLast(item => item.type === 'event' && item.event.type === 'context_usage'); assert.ok(context?.type === 'event');
    assert.equal(context.event.window, 300000); assert.equal(context.event.tokens, null); assert.equal(context.event.percent, null);
    await worker.handle({ type: 'prompt', text: 'Continue after compaction.', messageId: 'post-compact' });
    const refreshed = f.messages.findLast(item => item.type === 'event' && item.event.type === 'context_usage'); assert.ok(refreshed?.type === 'event'); assert.equal(refreshed.event.tokens, 144);
  } finally { await f.close(); }
});

test('Ultra lead creates a named squad, waits for results, and keeps plan members read-only', { timeout: 30000 }, async () => {
  let calls = 0;
  const members = [{ name: '界面匠', prompt: 'Review the layout.', role: 'general-purpose' }, { name: '验收员', prompt: 'Check acceptance cases.', role: 'Explore' }];
  const f = await fixture((_body, response) => {
    if (calls++ === 0) respond(response, '', { name: 'agent_team', args: { members } });
    else if (calls === 2) respond(response, '', { name: 'get_subagent_result', args: { wait: true } });
    else respond(response, 'Both members returned; plan synthesized.');
  });
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, canDelegate: true, planMode: true });
    const run = worker.handle({ type: 'prompt', text: 'Plan a UI update and independent acceptance review.', messageId: 'team-turn' });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'team'));
    const team = f.messages.find(item => item.type === 'request' && item.method === 'team'); assert.ok(team?.type === 'request');
    assert.deepEqual(team.args.members, members.map(member => ({ ...member, role: 'Explore' })));
    assert.equal(f.messages.some(item => item.type === 'request' && item.method === 'approve'), false);
    await worker.handle({ type: 'response', id: team.id, result: { members: [{ id: 'child-ui', name: '界面匠' }, { id: 'child-review', name: '验收员' }] } });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'wait'));
    const wait = f.messages.find(item => item.type === 'request' && item.method === 'wait'); assert.ok(wait?.type === 'request'); assert.deepEqual(wait.args, {});
    await worker.handle({ type: 'response', id: wait.id, result: [{ id: 'child-ui', status: 'completed', result: 'Layout reviewed.' }, { id: 'child-review', status: 'completed', result: 'Acceptance reviewed.' }] });
    await run;
    assert.equal(f.bodies.length, 3, JSON.stringify(f.messages));
    assert.ok(f.bodies.every(body => body.reasoning_effort === 'max'));
    assert.match(JSON.stringify(f.bodies[0]), /Ultra: default to 6 useful independent members for complex work/);
    assert.match(JSON.stringify(f.bodies[0]), /Simple work needs no squad/);
    assert.match(JSON.stringify(f.bodies[2]), /Acceptance reviewed/);
    assert.ok(f.messages.some(item => item.type === 'done'));
  } finally { await f.close(); }
});

test('squad schema rejects a single member before the host can create children', { timeout: 30000 }, async () => {
  let calls = 0;
  const f = await fixture((_body, response) => respond(response, 'Handled invalid squad.', calls++ === 0 ? { name: 'agent_team', args: { members: [{ name: '验收员', prompt: 'Review it.' }] } } : undefined));
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, canDelegate: true }); await worker.handle({ type: 'prompt', text: 'Exercise squad validation.' });
    assert.equal(f.messages.some(item => item.type === 'request' && item.method === 'team'), false);
    assert.equal(f.bodies.length, 2);
    assert.match(JSON.stringify(f.bodies[1]), /2|two|minimum/i);
  } finally { await f.close(); }
});

test('identical queued prompts retain UI IDs and a regenerated branch excludes the prior future', { timeout: 30000 }, async () => {
  let firstResponse: ServerResponse | undefined; let calls = 0;
  const f = await fixture((_body, response) => { calls++; if (calls === 1) firstResponse = response; else respond(response, `Reply ${calls}`); });
  try {
    const worker = f.newWorker(); await worker.handle(f.init);
    const run = worker.handle({ type: 'prompt', text: 'same text', messageId: 'primary' });
    await until(() => !!firstResponse);
    await worker.handle({ type: 'prompt', text: 'same text', messageId: 'follow', behavior: 'followUp' });
    await worker.handle({ type: 'prompt', text: 'same text', messageId: 'steer', behavior: 'steer' });
    respond(firstResponse!, 'Reply 1'); await run;
    const entries = userEntries(f.messages); assert.deepEqual(entries.map(item => item.messageId), ['primary', 'steer', 'follow']);
    const done = f.messages.findLast(item => item.type === 'done'); assert.ok(done?.type === 'done' && done.sessionFile);
    const branchEntry = String(entries[2].entryId); await worker.dispose();
    const branched = f.newWorker(); await branched.handle({ ...f.init, sessionFile: done.sessionFile, sessionLeafId: done.sessionLeafId, branchBeforeEntryId: branchEntry });
    await branched.handle({ type: 'prompt', text: 'replacement', messageId: 'replacement' });
    const final = f.bodies.at(-1)!;
    const actual = final.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    const userTexts = actual.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : item.content.map(part => part.text || '').join(''));
    assert.deepEqual(userTexts.filter(text => !text.startsWith('Cardwright context —')), ['same text', 'same text', 'replacement']);
    assert.equal(userTexts.filter(text => text.startsWith('Cardwright context —')).length, 1);
    assert.doesNotMatch(JSON.stringify(final), /Reply 3/);
    const raw = await readFile(done.sessionFile, 'utf8'); assert.match(raw, /Reply 3/); assert.match(raw, /replacement/);
    const followAssistantStarts = f.messages.filter(item => item.type === 'event' && item.event.type === 'message_start' && (item.event.message as { role?: string })?.role === 'assistant').map(item => item.type === 'event' ? item.event.turnId : undefined);
    assert.deepEqual(followAssistantStarts, ['primary', 'steer', 'follow', 'replacement']);
  } finally { await f.close(); }
});

test('effective local skills are automatically readable, disabled skills absent, explicit-only invocation supported', { timeout: 30000 }, async () => {
  let path = ''; let calls = 0;
  const f = await fixture((_body, response) => respond(response, 'Skill read.', calls++ === 0 ? { name: 'read', args: { path } } : undefined));
  try {
    path = join(f.root, 'SKILL.md'); await writeFile(path, '---\nname: local-fixture\ndescription: A local test skill\n---\nLOCAL_SKILL_CONTENT');
    const hidden = join(f.root, 'manual.md'); await writeFile(hidden, '---\nname: manual-fixture\ndescription: Explicit test skill\ndisable-model-invocation: true\n---\nMANUAL_SKILL_CONTENT');
    const disabled = join(f.root, 'disabled.md'); await writeFile(disabled, '---\nname: disabled-fixture\ndescription: Disabled test skill\n---\nDISABLED_CONTENT');
    f.init.skillFiles = [{ id: 'auto', name: 'local-fixture', description: 'A local test skill', path, source: 'user', enabled: true, disableModelInvocation: false }, { id: 'manual', name: 'manual-fixture', description: 'Explicit test skill', path: hidden, source: 'user', enabled: true, disableModelInvocation: true }, { id: 'disabled', name: 'disabled-fixture', description: 'Disabled test skill', path: disabled, source: 'user', enabled: false, disableModelInvocation: false }];
    const worker = f.newWorker(); await worker.handle(f.init); await worker.handle({ type: 'prompt', text: 'Use the relevant local skill.', messageId: 'auto-user' });
    assert.equal(f.messages.some(item => item.type === 'request' && item.method === 'approve'), false);
    assert.match(JSON.stringify(f.bodies[0]?.tools), /search_skills/); assert.doesNotMatch(JSON.stringify(f.bodies[0]), /local-fixture|manual-fixture|disabled-fixture/);
    assert.match(JSON.stringify(f.bodies[1]), /LOCAL_SKILL_CONTENT/);
    await worker.handle({ type: 'prompt', text: '/skill:manual-fixture do this', messageId: 'manual-user' });
    assert.match(JSON.stringify(f.bodies.at(-1)), /MANUAL_SKILL_CONTENT/);
    const before = f.bodies.length; await worker.handle({ type: 'prompt', text: '/skill:disabled-fixture', messageId: 'disabled-user' });
    assert.equal(f.bodies.length, before); assert.ok(f.messages.some(item => item.type === 'error' && /unavailable or disabled/.test(item.message)));
  } finally { await f.close(); }
});
