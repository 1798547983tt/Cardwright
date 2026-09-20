import { packager } from '@electron/packager';
import { join, resolve, sep } from 'node:path';
import { copyFile, readFile } from 'node:fs/promises';
import { PACKAGE_IGNORE } from './package-options.mjs';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version.');
// CARDWRIGHT_PACKAGE_OUT builds the same package outside the repository for smoke runs: inside it, Node would quietly
// supply pruned modules from the repository's own node_modules.
const out = process.env.CARDWRIGHT_PACKAGE_OUT ? resolve(process.env.CARDWRIGHT_PACKAGE_OUT) : resolve('release', version);
if (!process.env.CARDWRIGHT_PACKAGE_OUT && !out.startsWith(`${resolve('release')}${sep}`)) throw new Error('Package output must remain within release.');
if (process.env.CARDWRIGHT_PACKAGE_OUT && (out + sep).startsWith(resolve('.') + sep)) throw new Error('CARDWRIGHT_PACKAGE_OUT must be outside the repository.');
const paths = await packager({ dir: '.', out, name: 'Cardwright', platform: 'win32', arch: 'x64', overwrite: true, asar: false, prune: true, executableName: 'Cardwright', icon: resolve('dist', 'icon.ico'), ignore: PACKAGE_IGNORE });
for (const path of paths) {
  await copyFile(resolve('package-lock.json'), join(path, 'resources', 'app', 'package-lock.json'));
  process.stdout.write(`${path}\n`);
}
