import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerRuntime } from '../../src/runtime/worker.ts';
import type { FromWorker, WorkerInit } from '../../src/shared/types.ts';
import { BUILTIN_ROLES, defaultEcosystem } from '../../src/core/ecosystem.ts';

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
/** The system prompt of a recorded request: its first message, whatever role the protocol gives it. */
const systemPrompt = (body: Record<string, unknown>) => String((body.messages as Array<{ content: unknown }>)[0].content);

test('the request opens with 小绘 and the configured model, and the default Ultra sends max', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response));
  try {
    const worker = f.newWorker(); await worker.handle(f.init); await worker.handle({ type: 'prompt', text: 'Which model are you?', messageId: 'user-identity' });
    assert.equal(f.bodies.length, 1, JSON.stringify(f.messages));
    assert.equal(f.bodies[0].reasoning_effort, 'max');
    const system = systemPrompt(f.bodies[0]);
    assert.ok(system.startsWith('你是小绘，Cardwright 里的 AI。这次对话用的模型是 configured-model（网关：Fixture gateway）。'), system.slice(0, 120));
    assert.ok(system.includes('跟用户说话时，你是这样的：'));
    assert.doesNotMatch(system, /desktop coding assistant|When asked your model/);
    const payload = JSON.stringify(f.bodies[0]);
    assert.doesNotMatch(payload, /operating inside pi|Pi documentation|fixture-private-key/);
    assert.doesNotMatch(payload, /ULTRA TEAM MODE|"name":"dispatch_team"/);
    assert.ok(f.messages.some(item => item.type === 'event' && item.event.type === 'thinking_level_changed' && item.event.level === 'ultra' && item.event.runtimeLevel === 'max'));
    const entries = userEntries(f.messages); assert.equal(entries.length, 1); assert.equal(entries[0].messageId, 'user-identity');
    const done = f.messages.findLast(item => item.type === 'done'); assert.ok(done?.type === 'done'); assert.ok(done.sessionLeafId); assert.equal(done.userEntries?.[0].entryId, entries[0].entryId);
  } finally { await f.close(); }
});

test('a squad member gets one line; the personality follows its switch and the interface language', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response));
  try {
    const systemOf = async (identity: WorkerInit['identity']) => {
      const worker = f.newWorker(); await worker.handle({ ...f.init, identity }); await worker.handle({ type: 'prompt', text: 'Who are you?' });
      return systemPrompt(f.bodies.at(-1)!);
    };
    const member = await systemOf({ language: 'zh', persona: true, member: true });
    assert.ok(member.startsWith('你是小绘派出的帮手，这次用的模型是 configured-model（网关：Fixture gateway）。'), member.slice(0, 80));
    assert.doesNotMatch(member, /你是小绘，|跟用户说话时/);
    const plain = await systemOf({ language: 'zh', persona: false, member: false });
    assert.ok(plain.startsWith('你是小绘，Cardwright 里的 AI。'));
    assert.doesNotMatch(plain, /跟用户说话时/);
    const english = await systemOf({ language: 'en', persona: true, member: false });
    assert.ok(english.startsWith('You are 小绘, the AI in Cardwright. This conversation runs on configured-model (gateway: Fixture gateway).'), english.slice(0, 120));
    assert.ok(english.includes('When you talk with the user:'));
  } finally { await f.close(); }
});

test('a memory review is a bare request: no system prompt, no 小绘', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response, '{"memories":[],"archiveIds":[]}'));
  try {
    const worker = f.newWorker();
    await worker.handle({ ...f.init, dataDir: join(f.root, 'data'), projectId: 'dream-project', ecosystem: { ...defaultEcosystem(), memoryEnabled: true } });
    await worker.handle({ type: 'prompt', text: '/dream', messageId: 'dream' });
    assert.equal(f.messages.some(item => item.type === 'error'), false, JSON.stringify(f.messages.filter(item => item.type === 'error')));
    assert.equal(f.bodies.length, 1);
    assert.deepEqual((f.bodies[0].messages as Array<{ role: string }>).map(message => message.role), ['user']);
    assert.doesNotMatch(JSON.stringify(f.bodies[0]), /小绘|Cardwright 里的 AI/);
  } finally { await f.close(); }
});

test('Ultra lead automatically collects late members and synthesizes once in the same visible turn', { timeout: 30000 }, async () => {
  let calls = 0;
  const members = [{ name: '界面匠', task: 'Review layout.' }, { name: '验收员', task: 'Review cases.' }];
  const f = await fixture((_body, response) => {
    const call = calls++;
    if (call === 0 || call === 2) respond(response, '', { name: 'dispatch_team', args: { members } });
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
  const members = [{ name: '界面匠', task: 'Review the layout.', role: 'executor' }, { name: '验收员', task: 'Check acceptance cases.', role: 'explorer' }];
  const f = await fixture((_body, response) => {
    if (calls++ === 0) respond(response, '', { name: 'dispatch_team', args: { members } });
    else if (calls === 2) respond(response, '', { name: 'member_result', args: { wait: true } });
    else respond(response, 'Both members returned; plan synthesized.');
  });
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, canDelegate: true, planMode: true });
    const run = worker.handle({ type: 'prompt', text: 'Plan a UI update and independent acceptance review.', messageId: 'team-turn' });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'team'));
    const team = f.messages.find(item => item.type === 'request' && item.method === 'team'); assert.ok(team?.type === 'request');
    assert.deepEqual(team.args.members, members.map(member => ({ name: member.name, prompt: member.task, role: member.role })), 'the host request keeps its own field names, and each member the subagent it was sent as');
    assert.equal(team.args.readOnly, true, 'a planning lead’s members only read: the request says so and the app decides');
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
  const f = await fixture((_body, response) => respond(response, 'Handled invalid squad.', calls++ === 0 ? { name: 'dispatch_team', args: { members: [{ name: '验收员', task: 'Review it.' }] } } : undefined));
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

test('a built-in role is named by its new id in the task mode', { timeout: 30000 }, async () => {
  const f = await fixture((_body, response) => respond(response));
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, roleDefinition: BUILTIN_ROLES.find(role => role.id === 'explorer') });
    await worker.handle({ type: 'prompt', text: 'Look around.' });
    const payload = JSON.stringify(f.bodies[0]);
    assert.match(payload, /Role: explorer\. Inspect the project and return findings; do not change files\./);
    assert.doesNotMatch(payload, /Role: Explore/);
  } finally { await f.close(); }
});

test('a read-only task that is asked to write points the model at an executor task', { timeout: 30000 }, async () => {
  let calls = 0;
  const f = await fixture((_body, response) => respond(response, 'Refused.', calls++ === 0 ? { name: 'write', args: { path: 'refused.txt', content: 'x' } } : undefined));
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, roleDefinition: BUILTIN_ROLES.find(role => role.id === 'explorer') });
    await worker.handle({ type: 'prompt', text: 'Write a file.' });
    assert.equal(f.bodies.length, 2, JSON.stringify(f.messages));
    const refusal = JSON.stringify(f.bodies[1]);
    assert.match(refusal, /This task is read-only\. Approve the implementation plan or use an executor task before making changes\./);
    assert.doesNotMatch(refusal, /general-purpose/);
  } finally { await f.close(); }
});

test('the squad tools carry Cardwright’s names and list the roles one per line; message_member reaches the member', { timeout: 30000 }, async () => {
  let calls = 0;
  const f = await fixture((_body, response) => calls++ === 0
    ? respond(response, '', { name: 'message_member', args: { member_id: 'child-1', message: '再查一下第三章。' } })
    : respond(response, 'Sent.'));
  try {
    const worker = f.newWorker(); await worker.handle({ ...f.init, canDelegate: true });
    const run = worker.handle({ type: 'prompt', text: 'Tell the member to look again.', messageId: 'steer-turn' });
    await until(() => f.messages.some(item => item.type === 'request' && item.method === 'steer_agent'));
    const steer = f.messages.find(item => item.type === 'request' && item.method === 'steer_agent'); assert.ok(steer?.type === 'request');
    assert.deepEqual(steer.args, { agent_id: 'child-1', message: '再查一下第三章。' }, 'the host request keeps its own field names');
    await worker.handle({ type: 'response', id: steer.id, result: { ok: true } });
    await run;
    const tools = JSON.stringify(f.bodies[0].tools);
    for (const name of ['dispatch_member', 'dispatch_team', 'member_result', 'message_member']) assert.match(tools, new RegExp(`"name":"${name}"`));
    for (const old of ['agent', 'agent_team', 'get_subagent_result', 'steer_subagent']) assert.doesNotMatch(tools, new RegExp(`"name":"${old}"`));
    assert.match(tools, /- `executor`（执行员）：通用执行/);
    assert.match(tools, /- `explorer`（探索员）：查看项目、交回发现；只读/);
    assert.match(tools, /- `planner`（规划师）：规划，进入规划模式；只读/);
    assert.doesNotMatch(tools, /subagent_type|run_in_background|general-purpose/);
  } finally { await f.close(); }
});
