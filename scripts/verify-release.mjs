import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const source = resolve('.');
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const packaged = resolve(process.argv[2] || join('release', metadata.version, 'Cardwright-win32-x64'));
assert.ok(packaged.startsWith(resolve('release') + sep), 'Validate a release inside this workspace.');
const app = join(packaged, 'resources', 'app');
assert.equal(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).version, metadata.version);
async function hash(path) { const value = createHash('sha256'); for await (const chunk of createReadStream(path)) value.update(chunk); return value.digest('hex'); }
async function files(folder) { const result = []; for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); if (item.isDirectory()) result.push(...await files(path)); else if (item.isFile()) result.push(path); } return result; }
const verified = [];
// The built-in desk pet ships in assets/ (ADR 0018): its sheet, its manifest and its NOTICE.md; its window has its own page and preload.
for (const file of [...await files(join(source, 'dist')), ...await files(join(source, 'assets')), join(source, 'package-lock.json')]) {
  const path = relative(source, file); const expected = await hash(file);
  assert.equal(await hash(join(app, path)), expected, `Packaged bytes differ: ${path}`);
  verified.push({ path, sha256: expected, bytes: (await stat(file)).size });
}
for (const name of ['Cardwright.CommandHost.exe', 'Cardwright.UpdateHost.exe', 'tools/node.exe', 'tools/LICENSE-node.txt', 'main.cjs', 'preload.cjs', 'pet-preload.cjs', 'renderer/index.html', 'renderer/pet.html', 'worker.mjs']) assert.ok(verified.some(file => file.path.replaceAll('\\', '/') === 'dist/' + name), `Missing runtime: ${name}`);
for (const name of ['pets/erii/pet.json', 'pets/erii/spritesheet.webp', 'pets/erii/NOTICE.md']) assert.ok(verified.some(file => file.path.replaceAll('\\', '/') === 'assets/' + name), `Missing asset: ${name}`);
const provenance = JSON.parse(await readFile(join(app, 'dist', 'tools', 'node-provenance.json'), 'utf8'));
assert.equal(await hash(join(app, 'dist', 'tools', 'node.exe')), provenance.sha256);
const receipt = { version: metadata.version, at: new Date().toISOString(), status: 'passed', executable: join(packaged, 'Cardwright.exe'), verifiedFiles: verified.length, nodeVersion: provenance.version, files: verified };
await mkdir('artifacts/workbench-0.7', { recursive: true });
await writeFile('artifacts/workbench-0.7/release-integrity.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ status: receipt.status, version: receipt.version, verifiedFiles: receipt.verifiedFiles, nodeVersion: receipt.nodeVersion }));
