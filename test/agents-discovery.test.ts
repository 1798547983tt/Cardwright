import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgents } from '../src/core/agents.ts';
import { mergeAgents } from '../src/shared/agents.ts';
import type { AgentRole } from '../src/shared/types.ts';

const NL = String.fromCharCode(10);
const agentFile = (name: string, description: string, extra: string[], body: string) =>
  ['---', `name: ${name}`, `description: ${description}`, ...extra, '---', '', body, ''].join(NL);

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-agents-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  await mkdir(join(home, '.claude', 'agents'), { recursive: true });
  await mkdir(join(project, '.claude', 'agents'), { recursive: true });
  return { root, home, project };
}

test('reads the Claude Code agent format and skips what it cannot use', async () => {
  const { root, home, project } = await workspace();
  try {
    await writeFile(join(home, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer', '审查改动，不写文件', ['tools: Read, Grep, Glob'], '你是审查者。只读，不改文件。'));
    await writeFile(join(home, '.claude', 'agents', 'builder.md'), agentFile('builder', '实现功能', ['tools: Read, Write, Bash', 'model: sonnet'], '你负责实现。'));
    await writeFile(join(home, '.claude', 'agents', 'no-frontmatter.md'), '这个文件没有 frontmatter。' + NL);
    await writeFile(join(home, '.claude', 'agents', 'nameless.md'), ['---', 'description: 缺少名字', '---', '正文'].join(NL));
    await writeFile(join(home, '.claude', 'agents', 'empty-body.md'), agentFile('empty', '正文是空的', [], '   '));
    await writeFile(join(project, '.claude', 'agents', 'planner.md'), agentFile('planner', '先出计划', [], '你先写计划。'));
    const found = discoverAgents({ projects: [{ id: 'p1', path: project }], homeDir: home });
    assert.deepEqual(found.map(agent => agent.name).sort(), ['builder', 'planner', 'reviewer']);
    const reviewer = found.find(agent => agent.name === 'reviewer')!;
    assert.equal(reviewer.readOnly, true, 'no writing tool means a read-only subagent');
    assert.equal(reviewer.source, 'user');
    assert.deepEqual(reviewer.tools, ['Read', 'Grep', 'Glob']);
    assert.match(reviewer.prompt, /只读/);
    const builder = found.find(agent => agent.name === 'builder')!;
    assert.equal(builder.readOnly, false);
    assert.equal(builder.model, 'sonnet');
    const planner = found.find(agent => agent.name === 'planner')!;
    assert.equal(planner.source, 'project');
    assert.equal(planner.projectId, 'p1');
    assert.equal(planner.readOnly, false, 'no tools listed means the agent keeps every tool');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a project agent wins over a user agent of the same name, and disabled ones are marked', async () => {
  const { root, home, project } = await workspace();
  try {
    await writeFile(join(home, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer', '用户版', [], '用户版正文。'));
    await writeFile(join(project, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer', '项目版', [], '项目版正文。'));
    const found = discoverAgents({ projects: [{ id: 'p1', path: project }], homeDir: home });
    const saved: AgentRole[] = [{ id: 'general-purpose', name: 'General purpose', prompt: '内置', readOnly: false, builtIn: true }, { id: 'reviewer', name: '我的审查员', prompt: '自建', readOnly: false }];
    const merged = mergeAgents({ saved, discovered: found, disabled: ['agent:user:reviewer'] });
    const byId = (id: string) => merged.find(role => role.id === id);
    assert.equal(byId('agent:project:p1:reviewer')?.description, '项目版');
    assert.equal(byId('agent:project:p1:reviewer')?.enabled, true);
    assert.equal(byId('agent:user:reviewer')?.enabled, false, 'the user switched this one off');
    assert.equal(byId('agent:user:reviewer')?.shadowedBy, 'agent:project:p1:reviewer');
    assert.equal(byId('reviewer')?.shadowedBy, 'agent:project:p1:reviewer', 'a custom role of the same name steps aside');
    assert.equal(byId('general-purpose')?.shadowedBy, undefined);
    assert.deepEqual(merged.map(role => role.source), ['builtin', 'custom', 'project', 'user']);
    // Only what a task may actually use: enabled, not shadowed, and not another project's.
    const usable = mergeAgents({ saved, discovered: found, disabled: [], projectId: 'p1' }).filter(role => role.enabled !== false && !role.shadowedBy);
    assert.deepEqual(usable.map(role => role.id), ['general-purpose', 'agent:project:p1:reviewer']);
    const elsewhere = mergeAgents({ saved, discovered: found, disabled: [], projectId: 'p2' }).filter(role => role.enabled !== false && !role.shadowedBy);
    // Another project's agent is out of scope, and the user's own agent file takes precedence over the saved role.
    assert.deepEqual(elsewhere.map(role => role.id), ['general-purpose', 'agent:user:reviewer']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discovery stays bounded and survives an unreadable folder', async () => {
  const { root, home, project } = await workspace();
  try {
    for (let index = 0; index < 60; index++) await writeFile(join(home, '.claude', 'agents', `agent-${index}.md`), agentFile(`agent-${index}`, `第 ${index} 个`, [], '正文。'));
    await writeFile(join(home, '.claude', 'agents', 'huge.md'), agentFile('huge', '正文超长', [], 'x'.repeat(300_000)));
    const found = discoverAgents({ projects: [{ id: 'p1', path: join(project, 'gone') }], homeDir: home, limit: 50 });
    assert.equal(found.length, 50, 'the limit holds');
    assert.equal(found.some(agent => agent.name === 'huge'), false, 'an oversized file is left out');
  } finally { await rm(root, { recursive: true, force: true }); }
});
