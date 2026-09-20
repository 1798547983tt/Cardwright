import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getEcosystemSkillPaths } from '../src/runtime/ecosystem-skills.ts';

test('bundled SuPi guidance returns actual skill documents with intact relative references', () => {
  const paths = getEcosystemSkillPaths();
  assert.equal(paths.length, 2);
  for (const path of paths) {
    assert.match(readFileSync(path, 'utf8'), /name: claude-md-/);
    assert.ok(existsSync(join(dirname(path), 'references', 'quality-criteria.md')));
  }
});
