import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createAgentSession, createEventBus, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadExtensionFromFactory } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createResources } from '../src/runtime/resources.ts';
import { createEcosystemMcpExtension, ecosystemMcpConfig } from '../src/runtime/ecosystem-mcp.ts';

test('MCP config is an isolated lazy snapshot with no environment/credential autodiscovery', () => {
  const input = [{ id: 'local', name: 'Local', enabled: true, transport: 'stdio' as const, command: 'node', args: ['server.mjs'], env: { EXPLICIT: 'literal' } }];
  const config = ecosystemMcpConfig(input);
  input[0].args[0] = 'changed.mjs'; assert.deepEqual(config.mcpServers.local.args, ['server.mjs']);
  assert.equal(config.mcpServers.local.inheritEnv, false); assert.equal(config.mcpServers.local.literalEnv, true);
  assert.equal(config.mcpServers.local.lifecycle, 'lazy'); assert.equal(config.settings.sampling, false); assert.deepEqual(config.imports, []);
  assert.throws(() => ecosystemMcpConfig([...input, ...input]), /unique/);
  assert.throws(() => ecosystemMcpConfig([{ id: 'http', name: '', enabled: true, transport: 'http', url: 'https://secret:key@example.com/' }]), /credentials/);
});

test('actual Pi MCP adapter discovers a loopback server and forwards precise tool approvals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-mcp-')); const oldAgent = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  let calls = 0; let connections = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return; }
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (body.method === 'initialize') { connections++; result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'loopback-fixture', version: '1' } }; }
    else if (body.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a fixture value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
    else if (body.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text: `echo:${body.params.arguments.value}` }] }; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let approved = false; const approvals: string[] = [];
  const factory = await createEcosystemMcpExtension([{ id: 'fixture', name: 'Fixture', enabled: true, transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }], {
    agentDir: root,
    approve: async request => { approvals.push(`${request.serverName}/${request.originalToolName}/${request.args.value}`); return approved; },
  });
  const runtime = createExtensionRuntime(); const eventBus = createEventBus();
  const extension = await loadExtensionFromFactory(factory, root, eventBus, runtime, 'cardwright:mcp');
  assert.ok(extension.tools.has('mcp')); assert.equal(connections, 0);
  const resources = createResources(root, root, [], 'Fixture');
  resources.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models, resourceLoader: resources, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory(), noTools: 'builtin' });
  try {
    await session.bindExtensions({ mode: 'rpc' });
    assert.equal(connections, 0);
    const mcp = session.agent.state.tools.find(tool => tool.name === 'mcp'); assert.ok(mcp);
    const connect = await mcp.execute('connect', { connect: 'fixture' });
    assert.doesNotMatch(JSON.stringify(connect), /Initialization failed/); assert.equal(connections, 1);
    const denied = await mcp.execute('deny', { tool: 'fixture_echo', args: { value: 'one' } });
    assert.equal(calls, 0); assert.match(JSON.stringify(denied), /denied/i);
    approved = true;
    const result = await mcp.execute('allow', { tool: 'fixture_echo', args: { value: 'two' } });
    assert.equal(calls, 1); assert.match(JSON.stringify(result), /echo:two/);
    assert.deepEqual(approvals, ['fixture/echo/one', 'fixture/echo/two']);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); eventBus.clear();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(root, { recursive: true, force: true });
  }
});

test('bundled ESM MCP adapter loads under plain Node without node_modules type stripping', async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(testDirectory, '.compiled-mcp-'));
  try {
    await build({ entryPoints: [join(testDirectory, '../src/runtime/ecosystem-mcp.ts')], outfile: join(directory, 'mcp.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
    const runner = join(directory, 'run.mjs');
    await writeFile(runner, `
      import { createEcosystemMcpExtension } from './mcp.mjs';
      import { dirname,join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const agentDir=join(dirname(fileURLToPath(import.meta.url)),'agent');
      process.env.PI_CODING_AGENT_DIR=agentDir;
      const factory=await createEcosystemMcpExtension([], {agentDir,approve:async()=>false});
      if(typeof factory!=='function') throw new Error('Missing actual MCP factory');
      console.log('compiled-esm-ok');
    `);
    const result = await promisify(execFile)(process.execPath, [runner], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 });
    assert.match(result.stdout, /compiled-esm-ok/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
