import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { bundleNode } from './bundle-node.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildNative() {
  if (process.platform !== 'win32') throw new Error('The Windows command host must be built on Windows.');
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await access(compiler);
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const host of ['CommandHost', 'UpdateHost']) {
    const args = ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${join(root, 'dist', `Cardwright.${host}.exe`)}`, join(root, 'native', `Cardwright.${host}.cs`)];
    await new Promise((resolve, reject) => {
      const child = spawn(compiler, args, { windowsHide: true, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Native ${host} build failed (${code}).`)));
    });
  }
  await bundleNode();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNative();
