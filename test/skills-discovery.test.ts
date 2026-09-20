import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, skillId, skillsForProject } from '../src/core/skills.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cardwright-skills-'));
  const write = (folder: string, name: string, extra = '') => {
    mkdirSync(folder, { recursive: true });
    const path = join(folder, 'SKILL.md');
    writeFileSync(path, `---\nname: ${name}\ndescription: >-\n  Useful local skill\n  with folded metadata.\n${extra}---\nNever execute this body during discovery.\n`);
    return path;
  };
  return { root, write, clear: () => rmSync(root, { recursive: true, force: true }) };
}

test('discovers exact user roots, nested and project skills with deterministic precedence and metadata', t => {
  const f = fixture(); t.after(f.clear);
  const homeDir = join(f.root, 'home'); const project = join(f.root, 'project');
  const paths = [
    f.write(join(homeDir, '.agents', 'skills', 'same'), 'same'),
    f.write(join(homeDir, '.codex', 'skills', 'same'), 'same'),
    f.write(join(homeDir, '.claude', 'skills', 'nested', 'claude'), 'claude'),
    f.write(join(homeDir, '.codex', 'skills', '.system', 'internal'), 'internal'),
    f.write(join(project, '.agents', 'skills', 'same'), 'same', 'disable-model-invocation: true\n'),
    f.write(join(f.root, 'custom', 'same'), 'same'),
    f.write(join(f.root, 'bundled'), 'same'),
  ];
  f.write(join(homeDir, 'not-a-skill-root'), 'must-not-scan');
  const options = { projects: [{ id: 'p', path: project }], customPaths: [join(f.root, 'custom')], disabledIds: [], homeDir, bundledPaths: [paths[6]] };
  const all = discoverSkills(options);
  assert.equal(all.length, 7);
  assert.ok(all.every(skill => skill.description === 'Useful local skill with folded metadata.'));
  assert.equal(skillsForProject(all, 'p').find(skill => skill.name === 'same')?.path, paths[4]);
  assert.equal(skillsForProject(all, 'other').find(skill => skill.name === 'same')?.path, paths[5]);
  assert.equal(skillsForProject(all, 'p').find(skill => skill.name === 'same')?.disableModelInvocation, true);
  assert.equal(skillsForProject(all, 'other').some(skill => skill.projectId === 'p'), false);
  assert.equal(all.find(skill => skill.path === paths[1])?.shadowedBy, skillId(paths[5]));
  const disabled = discoverSkills({ ...options, disabledIds: [skillId(paths[4]), skillId(paths[5])] });
  assert.equal(skillsForProject(disabled, 'p').find(skill => skill.name === 'same')?.path, paths[0]);
  assert.equal(disabled.find(skill => skill.path === paths[4])?.enabled, false);
});

test('deduplicates physical paths, contains junctions, and respects a skill root boundary', t => {
  const f = fixture(); t.after(f.clear);
  const homeDir = join(f.root, 'home'); const selected = join(f.root, 'selected');
  const inside = f.write(join(selected, 'one'), 'inside');
  f.write(join(selected, 'one', 'nested'), 'not-a-second-skill');
  f.write(join(f.root, 'outside'), 'outside');
  symlinkSync(join(f.root, 'outside'), join(selected, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(selected, 'one'), join(selected, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const all = discoverSkills({ projects: [], customPaths: [selected, selected, join(selected, 'one')], disabledIds: [], homeDir });
  assert.deepEqual(all.map(skill => skill.name), ['inside']);
  assert.equal(all[0].id, skillId(inside));
});

test('rejects malformed metadata, oversized files and aliases without evaluating skill bodies', t => {
  const f = fixture(); t.after(f.clear);
  const homeDir = join(f.root, 'home'); const selected = join(f.root, 'selected');
  const put = (name: string, text: string) => { const folder = join(selected, name); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'SKILL.md'), text); };
  put('alias', '---\nname: alias\ndescription: &ref content\nalias: *ref\n---\n');
  put('duplicate', '---\nname: first\nname: second\ndescription: hi\n---\n');
  put('missing', '---\nname: missing\n---\n');
  put('invalid-command', '---\nname: "bad/name"\ndescription: hi\n---\n');
  put('oversized', `---\nname: huge\ndescription: hi\n---\n${'x'.repeat(256 * 1024)}`);
  put('long-metadata', `---\nname: too-long\ndescription: hi\nignored: ${'x'.repeat(17 * 1024)}\n---\n`);
  f.write(join(selected, 'valid'), 'valid');
  assert.deepEqual(discoverSkills({ projects: [], customPaths: [selected], disabledIds: [], homeDir }).map(skill => skill.name), ['valid']);
});

test('caps discovery at 500 skill files', t => {
  const f = fixture(); t.after(f.clear);
  const selected = join(f.root, 'selected');
  for (let i = 0; i < 505; i++) f.write(join(selected, `skill-${i.toString().padStart(3, '0')}`), `skill-${i}`);
  const all = discoverSkills({ projects: [], customPaths: [selected], disabledIds: [], homeDir: join(f.root, 'home') });
  assert.equal(all.length, 500);
  assert.equal(new Set(all.map(skill => skill.id)).size, 500);
});
