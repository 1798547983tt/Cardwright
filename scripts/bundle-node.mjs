import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.14.1';
const sha256 = '58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f';
// Verified against https://nodejs.org/dist/v24.14.1/SHASUMS256.txt (win-x64/node.exe).
const vendored = join(root, 'dist', 'tools', 'node.exe');

/**
 * The verified binary, from the explicit override, the running host, or a copy an
 * earlier build already vendored. Every candidate is hashed, so a wrong host Node or a
 * tampered file never ends up in dist/tools; the last candidate lets `pnpm run dev`
 * reuse a correctly vendored binary when the host Node is a different version.
 */
async function verifiedNodeBytes() {
  for (const candidate of [process.env.CARDWRIGHT_NODE_BINARY, process.execPath, vendored]) {
    if (!candidate) continue;
    try {
      const bytes = await readFile(await realpath(candidate));
      if (createHash('sha256').update(bytes).digest('hex') === sha256) return bytes;
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  throw new Error(`Use the verified Windows x64 Node ${version} binary to build Cardwright's bundled toolchain (CARDWRIGHT_NODE_BINARY).`);
}

export async function bundleNode() {
  const bytes = await verifiedNodeBytes();
  const tools = join(root, 'dist', 'tools'); await mkdir(tools, { recursive: true });
  await writeFile(join(tools, 'node.exe'), bytes);
  await copyFile(join(root, 'build-resources', 'node-LICENSE.txt'), join(tools, 'LICENSE-node.txt'));
  await writeFile(join(tools, 'node-provenance.json'), JSON.stringify({ name: 'Node.js', version, platform: 'win-x64', sha256, source: `https://nodejs.org/dist/v${version}/win-x64/node.exe`, checksums: `https://nodejs.org/dist/v${version}/SHASUMS256.txt` }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleNode();
