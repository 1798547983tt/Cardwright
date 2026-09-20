import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.14.1';
const sha256 = '58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f';
// Verified against https://nodejs.org/dist/v24.14.1/SHASUMS256.txt (win-x64/node.exe).
export async function bundleNode() {
  const binary = await realpath(process.env.CARDWRIGHT_NODE_BINARY || process.execPath);
  const bytes = await readFile(binary);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Use the verified Windows x64 Node ${version} binary to build Cardwright's bundled toolchain (CARDWRIGHT_NODE_BINARY).`);
  const tools = join(root, 'dist', 'tools'); await mkdir(tools, { recursive: true });
  await writeFile(join(tools, 'node.exe'), bytes);
  await copyFile(join(root, 'build-resources', 'node-LICENSE.txt'), join(tools, 'LICENSE-node.txt'));
  await writeFile(join(tools, 'node-provenance.json'), JSON.stringify({ name: 'Node.js', version, platform: 'win-x64', sha256, source: `https://nodejs.org/dist/v${version}/win-x64/node.exe`, checksums: `https://nodejs.org/dist/v${version}/SHASUMS256.txt` }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleNode();
