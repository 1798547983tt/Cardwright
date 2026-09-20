import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('bundled CJS memory resolves app packages outside cwd and runs in Electron Node mode', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const project = dirname(testDir);
  const moduleDir = mkdtempSync(join(testDir, '.memory-bundle-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'cardwright-memory-cjs-'));
  try {
    const outfile = join(moduleDir, 'main.cjs');
    const result = await build({
      stdin: {
        contents: `import { ProjectMemory } from ${JSON.stringify(join(project, 'src', 'runtime', 'ecosystem-memory.ts'))};
ProjectMemory.open({dataDir:process.argv[2],projectId:'smoke-project',sessionId:'smoke-task'}).then(memory=>{
 memory.write({content:'Compiled memory smoke test',category:'ARCHITECTURE'});
 process.stdout.write(JSON.stringify({count:memory.list().length,matches:memory.search('Compiled').length}));
 memory.close();
}).catch(error=>{ process.stderr.write(String(error)); process.exitCode=1; });`,
        resolveDir: project,
        sourcefile: 'memory-smoke.ts',
      },
      outfile, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent',
    });
    assert.equal(result.warnings.length, 0);
    const plain = spawnSync(process.execPath, [outfile, dataDir], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(JSON.parse(plain.stdout), { count: 1, matches: 1 });
    const electron = join(project, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    if (existsSync(electron)) {
      const desktop = spawnSync(electron, [outfile, dataDir], { cwd: tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      assert.equal(desktop.status, 0, desktop.stderr);
      assert.deepEqual(JSON.parse(desktop.stdout), { count: 1, matches: 1 });
    }
  } finally { rmSync(moduleDir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});
