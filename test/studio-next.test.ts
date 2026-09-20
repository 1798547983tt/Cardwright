import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { modelCatalogUrl, fetchModelCatalog } from '../src/core/model-catalog.ts';
import { startRevision, selectRevision } from '../src/core/conversation-revisions.ts';
import { buildUsageReport } from '../src/shared/usage.ts';
import type { Task } from '../src/shared/types.ts';

test('model catalogue handles both protocols, names, duplicate IDs, and never follows credential redirects', async () => {
  let seenKey = ''; let redirects = 0;
  const server = createServer((req, res) => {
    seenKey = String(req.headers.authorization || req.headers['x-api-key'] || '');
    if (req.url === '/redirect/models') { res.writeHead(302, { location: '/target' }); res.end(); return; }
    if (req.url === '/target') redirects++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'z-model', display_name: 'Z model' }, { id: 'a-model' }, { id: 'a-model' }, { wrong: true }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    assert.equal(modelCatalogUrl(base + '/v1/messages', 'anthropic-messages').pathname, '/v1/models');
    assert.equal(modelCatalogUrl(base + '/v1/responses', 'openai-responses').pathname, '/v1/models');
    const models = await fetchModelCatalog({ baseUrl: base + '/v1', protocol: 'openai-completions' }, 'fixture-key');
    assert.deepEqual(models, [{ id: 'a-model' }, { id: 'z-model', name: 'Z model' }]); assert.equal(seenKey, 'Bearer fixture-key');
    await fetchModelCatalog({ baseUrl: base, protocol: 'anthropic-messages' }, 'anthropic-key'); assert.equal(seenKey, 'anthropic-key');
    await assert.rejects(fetchModelCatalog({ baseUrl: base + '/redirect', protocol: 'openai-completions' }, 'private-key'));
    assert.equal(redirects, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('conversation versions preserve old tool history and usage without counting shared prefix twice', () => {
  const at = new Date().toISOString();
  const task: Task = { id: 'task', title: 'test', projectId: 'project', cwd: '', status: 'completed', permission: 'ask', gatewayId: 'g', thinking: 'medium', createdAt: at, updatedAt: at, sessionFile: 'session.jsonl', sessionLeafId: 'leaf',
    messages: [
      { id: 'u1', turnId: 'u1', sessionEntryId: 'one', role: 'user', text: 'same', at },
      { id: 'a1', turnId: 'u1', role: 'assistant', text: 'first', at, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { id: 'u2', turnId: 'u2', sessionEntryId: 'two', role: 'user', text: 'same', at },
      { id: 'a2', turnId: 'u2', role: 'assistant', text: 'second', at, usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ], tools: [{ id: 'tool', turnId: 'u2', name: 'write', args: {}, output: 'kept', status: 'completed', at }] };
  startRevision(task, 'u2');
  assert.deepEqual(task.messages.map(message => message.id), ['u1', 'a1']); assert.equal(task.branchBeforeEntryId, 'two'); assert.equal(task.tools.length, 0);
  const newId = task.activeRevisionId!;
  task.messages.push({ id: 'new', turnId: 'new-user', role: 'assistant', text: 'new version', at, usage: { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  assert.equal(buildUsageReport([task]).tokens.total, 72);
  selectRevision(task, 'initial'); assert.equal(task.messages.at(-1)?.text, 'second'); assert.equal(task.tools[0].output, 'kept');
  selectRevision(task, newId); assert.equal(task.messages.at(-1)?.text, 'new version'); assert.equal(buildUsageReport([task]).tokens.total, 72);
  assert.throws(() => startRevision(task, 'does-not-exist'), /Select a user/);
});
