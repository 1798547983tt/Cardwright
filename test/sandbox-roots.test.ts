import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { SANDBOX_ROOT_LIMIT, sandboxReadRoots } from '../src/runtime/sandbox-roots.ts';

const base = join(tmpdir(), 'cardwright-roots');
const project = join(base, 'project');
const builtIn = join(base, 'resources', 'card-studio');
const skills = Array.from({ length: 40 }, (_, index) => join(base, 'home', '.claude', 'skills', `skill-${index}`, 'SKILL.md'));
const attachments = Array.from({ length: 20 }, (_, index) => join(base, 'data', 'attachments', `attachment-${index}.txt`));

test('many skills and attachments stay under the command host limit, most important first', () => {
  const roots = sandboxReadRoots({ project, builtIn: [builtIn], attachments, skills });
  assert.equal(roots.length, SANDBOX_ROOT_LIMIT - 1);
  assert.deepEqual(roots.slice(0, 2), [project, builtIn]);
  assert.deepEqual(roots.slice(2), attachments.slice(0, SANDBOX_ROOT_LIMIT - 3));
});

test('skills come after attachments and keep their given order', () => {
  const roots = sandboxReadRoots({ project, attachments: attachments.slice(0, 2), skills: skills.slice(0, 3) });
  assert.deepEqual(roots, [project, ...attachments.slice(0, 2), ...skills.slice(0, 3)]);
});

test('the same path in different case is granted once', () => {
  const upper = skills[0].toUpperCase();
  const roots = sandboxReadRoots({ project, skills: [skills[0], upper] });
  assert.equal(roots.length, process.platform === 'win32' ? 2 : 3);
});

test('files inside the project are already covered by the project root', () => {
  const inside = join(project, '.claude', 'skills', 'local', 'SKILL.md');
  assert.deepEqual(sandboxReadRoots({ project, skills: [inside, skills[1]] }), [project, skills[1]]);
});

test('a custom limit is honoured', () => {
  assert.equal(sandboxReadRoots({ project, builtIn: [builtIn], skills }, 4).length, 4);
});
