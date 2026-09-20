import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface LockEntry { version?: string; dev?: boolean; peer?: boolean; optional?: boolean; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, LockEntry> };

/** Where Node would find `name` from a package at `path`: its own node_modules first, then each parent's. */
function resolveFrom(path: string, name: string): LockEntry | undefined {
  let base = path;
  while (true) {
    const found = lock.packages[`${base ? `${base}/` : ''}node_modules/${name}`];
    if (found) return found;
    if (!base) return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut < 0 ? '' : base.slice(0, cut);
  }
}

// The packager prunes everything npm installed only to satisfy a peer. A shipped package whose required peer is such a
// package then fails at runtime — unnoticed while release/ sits inside the repo, whose own node_modules fills the gap.
test('every required peer of a shipped package is shipped too', () => {
  const missing: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev || entry.peer) continue;
    for (const peer of Object.keys(entry.peerDependencies ?? {})) {
      if (entry.peerDependenciesMeta?.[peer]?.optional) continue;
      const installed = resolveFrom(path, peer);
      if (!installed || installed.peer || installed.dev) missing.push(`${peer} (needed by ${path.replace(/^node_modules\//, '')})`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'declare these as dependencies so the portable build carries them');
});

// The portable build is also what the installer wraps (prepackaged), so it ships only what the app runs:
// never the design documents, scripts, native sources or this machine's tool settings.
test('the package leaves out design documents, scripts and local settings but keeps what the app runs', async () => {
  const { PACKAGE_IGNORE } = await import('../scripts/package-options.mjs') as { PACKAGE_IGNORE: RegExp[] };
  const ignored = (path: string) => PACKAGE_IGNORE.some(pattern => pattern.test(path));
  for (const path of ['/.claude', '/.claude/launch.json', '/.tmp/x', '/.gitignore', '/docs/handoff/0.9-cardwright.md', '/scripts/package.mjs', '/native/Cardwright.CommandHost.cs', '/CONTEXT.md', '/DESIGN.md', '/PRODUCT.md', '/README.md', '/src/main/main.ts', '/test/core.test.ts', '/artifacts/x.png', '/release/0.8.0', '/tsconfig.json', '/electron-builder.config.cjs', '/index.html']) assert.ok(ignored(path), `${path} must not ship`);
  for (const path of ['/dist/main.cjs', '/card-studio/prompts/通用规则.md', '/node_modules/react/index.js', '/package.json', '/package-lock.json', '/THIRD_PARTY_NOTICES.md', '/LICENSE']) assert.ok(!ignored(path), `${path} must ship`);
});
