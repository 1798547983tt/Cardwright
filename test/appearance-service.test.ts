import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppearanceService } from '../src/main/appearance.ts';

/** A spritesheet that is only a lossless WebP header: enough for the size check, which never decodes pixels. */
function sheet(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(56, 4); bytes.write('WEBP', 8); bytes.write('VP8L', 12); bytes.writeUInt32LE(40, 16); bytes[20] = 0x2f;
  bytes.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return bytes;
}
const manifest = (id: string, name = id) => JSON.stringify({ id, displayName: name, description: `${name} 桌宠`, spritesheetPath: 'spritesheet.webp' });

/** A stored ZIP of the given files, written by hand. */
function storedZip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value); const name = Buffer.from(path);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-appearance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'); const data = join(root, 'data');
  await mkdir(join(app, 'assets', 'pets', 'erii'), { recursive: true });
  await writeFile(join(app, 'assets', 'pets', 'erii', 'pet.json'), manifest('erii', '绘梨衣'));
  await writeFile(join(app, 'assets', 'pets', 'erii', 'spritesheet.webp'), sheet(1536, 1872));
  await writeFile(join(app, 'assets', 'pets', 'erii', 'NOTICE.md'), '# 素材说明\n');
  return { root, data, service: new AppearanceService(data, app) };
}

test('the built-in pet is listed with its notice, and its sheet is served as an image', async t => {
  const { service } = await setup(t);
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.pets.map(pet => [pet.id, pet.displayName, pet.builtIn, pet.version]), [['erii', '绘梨衣', true, 1]]);
  assert.equal(snapshot.pets[0].notice, true, 'a built-in pet carries its NOTICE.md');
  assert.deepEqual(snapshot.themes, []);
  const sprite = await service.petSprite('erii');
  assert.match(sprite.dataUrl, /^data:image\/webp;base64,/);
  assert.equal(sprite.layout.rows, 9);
  await assert.rejects(service.petSprite('nobody'), /找不到/);
});

test('theme packs in the data folder are listed, and a broken one is refused with its reason', async t => {
  const { data, service } = await setup(t);
  await mkdir(join(data, 'themes', 'night-tea'), { recursive: true });
  await writeFile(join(data, 'themes', 'night-tea', 'theme.json'), JSON.stringify({ id: 'night-tea', name: '夜茶', base: 'dark', colors: { accent: '#c9a36a' }, background: 'bg.webp' }));
  await writeFile(join(data, 'themes', 'night-tea', 'bg.webp'), sheet(800, 600));
  await mkdir(join(data, 'themes', 'broken'), { recursive: true });
  await writeFile(join(data, 'themes', 'broken', 'theme.json'), '{ "id": "broken", ');
  await mkdir(join(data, 'themes', 'empty'), { recursive: true });
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.themes.map(theme => [theme.id, theme.name, theme.background]), [['night-tea', '夜茶', 'bg.webp']]);
  assert.deepEqual(snapshot.rejectedThemes.map(item => item.folder).sort(), ['broken', 'empty']);
  assert.match(snapshot.rejectedThemes.find(item => item.folder === 'broken')!.reason, /JSON/);
  assert.match(snapshot.rejectedThemes.find(item => item.folder === 'empty')!.reason, /theme\.json/);
  assert.match(await service.themeBackground('night-tea'), /^data:image\/webp;base64,/);
});

test('a pet pack installs from a folder or a ZIP into the data folder, checked first', async t => {
  const { root, data, service } = await setup(t);
  const folder = join(root, 'mika');
  await mkdir(folder); await writeFile(join(folder, 'pet.json'), manifest('mika', '米卡')); await writeFile(join(folder, 'spritesheet.webp'), sheet(1536, 2288));
  const installed = await service.installPet(folder);
  assert.deepEqual([installed.id, installed.version, installed.replaced], ['mika', 2, false]);
  assert.deepEqual((await readdir(join(data, 'pets', 'mika'))).sort(), ['pet.json', 'spritesheet.webp']);

  const zip = join(root, 'rin.codex-pet.zip');
  await writeFile(zip, storedZip({ 'rin/pet.json': manifest('rin', '凛'), 'rin/spritesheet.webp': sheet(1536, 1872) }));
  assert.equal((await service.installPet(zip)).id, 'rin', 'a pack whose files sit in one folder inside the ZIP');
  assert.equal((await service.installPet(folder)).replaced, true, 'installing again replaces it');
  assert.deepEqual((await service.snapshot()).pets.map(pet => pet.id), ['erii', 'mika', 'rin']);

  const wrong = join(root, 'wrong'); await mkdir(wrong); await writeFile(join(wrong, 'pet.json'), manifest('wrong')); await writeFile(join(wrong, 'spritesheet.webp'), sheet(1024, 1024));
  await assert.rejects(service.installPet(wrong), /1024×1024/);
  const same = join(root, 'same'); await mkdir(same); await writeFile(join(same, 'pet.json'), manifest('erii')); await writeFile(join(same, 'spritesheet.webp'), sheet(1536, 1872));
  await assert.rejects(service.installPet(same), /内置/);
  const bare = join(root, 'bare'); await mkdir(bare); await writeFile(join(bare, 'spritesheet.webp'), sheet(1536, 1872));
  await assert.rejects(service.installPet(bare), /pet\.json/);
  assert.equal((await readdir(join(data, 'pets'))).length, 2, 'nothing half-installed is left behind');

  await mkdir(join(data, 'pets', 'odd')); await writeFile(join(data, 'pets', 'odd', 'pet.json'), '{');
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.rejectedPets.map(item => item.folder), ['odd']);
  assert.equal(JSON.parse(await readFile(join(data, 'pets', 'mika', 'pet.json'), 'utf8')).displayName, '米卡');
});
