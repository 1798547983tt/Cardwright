import { build } from 'electron-builder';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require('../electron-builder.config.cjs');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version.');
const appDirectory = resolve(process.argv[2] || join(root, 'release', version, 'Cardwright-win32-x64'));
const output = join(root, 'release', version, 'installer');
if (!appDirectory.startsWith(`${join(root, 'release')}${sep}`)) throw new Error('Only a prepared Cardwright release directory can be packaged.');
await access(join(appDirectory, 'Cardwright.exe'));
const packagedVersion = JSON.parse(await readFile(join(appDirectory, 'resources', 'app', 'package.json'), 'utf8')).version;
if (packagedVersion !== version) throw new Error('Build the current version before creating its installer.');
await mkdir(output, { recursive: true });
const artifacts = await build({ projectDir: root, prepackaged: appDirectory, win: ['nsis','zip'], x64: true, publish: 'never', config: { ...config, directories: { ...config.directories, output } } });
const installer = artifacts.find(path => path.endsWith(`Cardwright-Setup-${version}.exe`));
if (!installer) throw new Error('The installer was not generated.');
const digest = createHash('sha256');
for await (const chunk of createReadStream(installer)) digest.update(chunk);
const manifest = { app: 'Cardwright', version, file: `Cardwright-Setup-${version}.exe`, sha256: digest.digest('hex') };
await writeFile(join(output, 'cardwright-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for(const archive of artifacts.filter(path=>path.endsWith('.zip'))){const digest=createHash('sha256');for await(const chunk of createReadStream(archive))digest.update(chunk);await writeFile(`${archive}.sha256`,`${digest.digest('hex')}  ${archive.split(/[\\/]/).at(-1)}\n`);process.stdout.write(`${archive}\n`);}
process.stdout.write(`${installer}\n${join(output, 'cardwright-update.json')}\n`);
