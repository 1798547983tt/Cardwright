import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as themes from '../src/shared/themes.ts';
import * as pets from '../src/shared/pets.ts';
import * as images from '../src/core/image-size.ts';
import * as zip from '../src/core/zip.ts';
import type { Task } from '../src/shared/types.ts';

test('three built-in themes: the dark and light ones as they were, and 红粉白 with its pet', () => {
  assert.deepEqual(themes.BUILT_IN_THEMES.map(theme => [theme.id, theme.base]), [['dark', 'dark'], ['light', 'light'], ['sakura', 'light']]);
  assert.equal(themes.BUILT_IN_THEMES.find(theme => theme.id === 'sakura')?.pet?.id, 'erii');
  assert.equal(themes.resolveTheme('system', { systemDark: true, packs: [] }).dataTheme, 'dark');
  assert.equal(themes.resolveTheme('system', { systemDark: false, packs: [] }).dataTheme, 'light');
  assert.equal(themes.resolveTheme('sakura', { systemDark: true, packs: [] }).dataTheme, 'sakura');
  const gone = themes.resolveTheme('my-theme', { systemDark: false, packs: [] });
  assert.deepEqual([gone.dataTheme, gone.missing], ['dark', true], 'a pack that has gone falls back to the dark theme');
});

const pack = (json: unknown, files = ['theme.json', 'bg.webp']) => themes.parseThemePack(typeof json === 'string' ? json : JSON.stringify(json), { folder: 'night-tea', files });

test('a theme pack changes colours, the pet, a background and the entrance, and nothing else', () => {
  const parsed = pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: { canvas: '#101418', panel: '#161b20', text: '#e8e2d6', accent: '#c9a36a', danger: 'rgb(220, 80, 80)' }, background: 'bg.webp', entrance: true, pet: { id: 'erii', actions: { complete: 'waving' } } });
  assert.ok('theme' in parsed, JSON.stringify(parsed));
  const theme = parsed.theme;
  assert.deepEqual([theme.id, theme.name, theme.base, theme.background, theme.entrance, theme.pet?.id, theme.pet?.actions?.complete], ['night-tea', '夜茶', 'dark', 'bg.webp', true, 'erii', 'waving']);
  const variables = themes.themeVariables(theme);
  assert.equal(variables['--canvas'], '#101418');
  assert.equal(variables['--accent'], '#c9a36a');
  assert.equal(variables['--primary'], '#c9a36a', 'the accent drives the primary button and focus too');
  assert.equal(variables['--focus'], '#c9a36a');
  assert.match(variables['--accent-soft'], /color-mix\(in srgb, #c9a36a/);
  assert.equal(variables['--danger'], 'rgb(220, 80, 80)');
  assert.equal(variables['--theme-accent'], '#c9a36a', 'the card studio tints its gold and board light towards it');
  assert.ok(!Object.keys(variables).some(name => /radius|font|motion/.test(name)), 'layout, type and shape stay the workbench’s');
});

test('a broken theme pack is refused with the reason', () => {
  const reason = (value: ReturnType<typeof pack>) => 'error' in value ? value.error : '';
  assert.match(reason(pack('{ not json')), /JSON/);
  assert.match(reason(pack({ id: 'other', name: '夜茶', base: 'dark', colors: {} })), /文件夹/);
  assert.match(reason(pack({ id: 'night-tea', name: '', base: 'dark', colors: {} })), /名称/);
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'sepia', colors: {} })), /base/);
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: { accent: 'url(evil)' } })), /accent/);
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: { radius: '0px' } })), /radius/, 'shapes are not a theme’s to change');
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: {}, background: 'missing.png' })), /missing\.png/);
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: {}, background: '../outside.png' }, ['theme.json', '../outside.png'])), /背景/);
  assert.match(reason(pack({ id: 'night-tea', name: '夜茶', base: 'dark', colors: {}, pet: { id: 'erii', actions: { complete: 'dancing' } } })), /dancing/);
  assert.match(reason(pack({ id: 'dark', name: '冒名', base: 'dark', colors: {} }, ['theme.json'])), /文件夹|内置/);
});

test('a pet pack is read the way Codex writes it', () => {
  const manifest = (value: Record<string, unknown>) => pets.parsePetManifest(JSON.stringify({ id: 'erii', displayName: '绘梨衣', description: '红发、红白巫女服的绘梨衣，头顶一只小黄鸭。', spritesheetPath: 'spritesheet.webp', ...value }));
  const ok = manifest({});
  assert.ok('pet' in ok);
  assert.deepEqual(ok.pet, { id: 'erii', displayName: '绘梨衣', description: '红发、红白巫女服的绘梨衣，头顶一只小黄鸭。', spritesheetPath: 'spritesheet.webp' });
  assert.ok('error' in manifest({ displayName: '' }));
  assert.ok('error' in manifest({ id: 'Erii Pet!' }));
  assert.ok('error' in manifest({ spritesheetPath: '../../secrets.webp' }));
  assert.ok('error' in manifest({ spritesheetPath: 'sheet.gif' }));
  assert.ok('error' in pets.parsePetManifest('{'));
  assert.deepEqual(pets.spriteLayout(1536, 1872), { version: 1, columns: 8, rows: 9, cellWidth: 192, cellHeight: 208 });
  assert.deepEqual(pets.spriteLayout(1536, 2288), { version: 2, columns: 8, rows: 11, cellWidth: 192, cellHeight: 208 });
  assert.equal(pets.spriteLayout(1024, 1024), null);
  assert.deepEqual(pets.PET_ROWS.map(row => [row.state, row.frames]), [['idle', 6], ['running-right', 8], ['running-left', 8], ['waving', 4], ['jumping', 5], ['failed', 8], ['waiting', 6], ['running', 6], ['review', 6]]);
  assert.equal(pets.PET_ROWS.reduce((sum, row) => sum + row.frames, 0), 57);
});

test('image sizes come from the file header: lossless, lossy and extended WebP, and PNG', () => {
  // The header of the built-in pet's spritesheet (lossless WebP, 1536×1872).
  const lossless = Buffer.from('52494646a6cf2200574542505650384c99cf22002fffc5d311', 'hex');
  assert.deepEqual(images.imageSize(lossless), { width: 1536, height: 1872, type: 'webp' });
  const lossy = Buffer.alloc(30); lossy.write('RIFF', 0); lossy.write('WEBP', 8); lossy.write('VP8 ', 12); lossy.writeUInt8(0x9d, 23); lossy.writeUInt8(0x01, 24); lossy.writeUInt8(0x2a, 25); lossy.writeUInt16LE(1536, 26); lossy.writeUInt16LE(2288, 28);
  assert.deepEqual(images.imageSize(lossy), { width: 1536, height: 2288, type: 'webp' });
  const extended = Buffer.alloc(30); extended.write('RIFF', 0); extended.write('WEBP', 8); extended.write('VP8X', 12); extended.writeUIntLE(1535, 24, 3); extended.writeUIntLE(1871, 27, 3);
  assert.deepEqual(images.imageSize(extended), { width: 1536, height: 1872, type: 'webp' });
  const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1536, 16); png.writeUInt32BE(1872, 20);
  assert.deepEqual(images.imageSize(png), { width: 1536, height: 1872, type: 'png' });
  assert.equal(images.imageSize(Buffer.from('GIF89a')), null);
});

/** A small ZIP with a stored and a deflated entry, written by hand. */
function makeZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(entry.deflate ? 8 : 0, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a pet ZIP is read without extracting it anywhere: stored and deflated entries, and no paths out of it', () => {
  const archive = makeZip([{ name: 'erii/pet.json', data: Buffer.from('{"id":"erii"}') }, { name: 'erii/spritesheet.webp', data: Buffer.alloc(4096, 7), deflate: true }]);
  const entries = zip.readZip(archive);
  assert.deepEqual(entries.map(entry => [entry.name, entry.data.length]), [['erii/pet.json', 13], ['erii/spritesheet.webp', 4096]]);
  assert.equal(entries[1].data[100], 7);
  assert.throws(() => zip.readZip(makeZip([{ name: '../evil.webp', data: Buffer.from('x') }])), /路径/);
  assert.throws(() => zip.readZip(Buffer.from('not a zip')), /ZIP/);
});

const at = (offset: number) => new Date(Date.UTC(2026, 8, 22, 10, 0, 0) + offset * 1000).toISOString();
const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({ id, projectId: 'p', title: `任务${id}`, cwd: '', status, permission: 'ask', gatewayId: 'g', thinking: 'medium', createdAt: at(0), updatedAt: at(0), messages: [], tools: [], ...extra });

test('the pet reports local state with the priority Codex uses: input, then failed, then done, then running', () => {
  const now = new Date(Date.UTC(2026, 8, 22, 10, 1, 0));
  const base = { now, approvals: [], interactions: [], runs: [], usageToday: 12_345 };
  assert.equal(pets.petMood({ ...base, tasks: [] }).state, 'idle');
  const running = pets.petMood({ ...base, tasks: [task('a', 'running')] });
  assert.deepEqual([running.state, running.title, running.status], ['running', '任务a', '运行中']);
  const waiting = pets.petMood({ ...base, tasks: [task('a', 'running'), task('b', 'waiting')], approvals: [{ taskId: 'b' }] });
  assert.deepEqual([waiting.state, waiting.title, waiting.status], ['waiting', '任务b', '等待审批']);
  const failed = pets.petMood({ ...base, tasks: [task('a', 'running'), task('c', 'failed', { completedAt: at(40) })] });
  assert.deepEqual([failed.state, failed.title], ['failed', '任务c']);
  const done = pets.petMood({ ...base, tasks: [task('a', 'running'), task('d', 'completed', { completedAt: at(50) })] });
  assert.deepEqual([done.state, done.status], ['jumping', '已完成']);
  const stale = pets.petMood({ ...base, tasks: [task('d', 'completed', { completedAt: at(-600) })] });
  assert.equal(stale.state, 'idle', 'an old result is not news');
  const superseded = pets.petMood({ ...base, tasks: [task('d', 'completed', { completedAt: at(30) }), task('e', 'running', { startedAt: at(45) })] });
  assert.deepEqual([superseded.state, superseded.title], ['running', '任务e'], 'a result stops being news once a later run has started');
  const failedThenStarted = pets.petMood({ ...base, tasks: [task('c', 'failed', { completedAt: at(30) }), task('e', 'running', { startedAt: at(45) })] });
  assert.equal(failedThenStarted.state, 'running');
  const making = pets.petMood({ ...base, tasks: [], runs: [{ card: '樱花庄', projectId: 'card', status: 'running', done: 3, total: 12 }] });
  assert.deepEqual([making.state, making.progress], ['review', '一键制作 · 樱花庄 3 / 12']);
  assert.equal(running.usage, '今天 12,345 Token');
  assert.equal(pets.petMood({ ...base, tasks: [task('d', 'completed', { completedAt: at(50) })], actions: { complete: 'waving' } }).state, 'waving', 'a theme can remap an action');
});

test('a click on the pet opens what it reports: a workbench task, a card conversation, the card being made, or the app', () => {
  const now = new Date(Date.UTC(2026, 8, 22, 10, 1, 0));
  const base = { now, approvals: [], interactions: [], runs: [], usageToday: 0 };
  assert.deepEqual(pets.petMood({ ...base, tasks: [task('a', 'running')] }).open, { kind: 'task', taskId: 'a' });
  const conversation = task('b', 'running', { projectId: 'card', card: { sectionId: 'lore-rules' } as Task['card'] });
  assert.deepEqual(pets.petMood({ ...base, tasks: [conversation] }).open, { kind: 'card', projectId: 'card', sectionId: 'lore-rules', taskId: 'b' });
  assert.deepEqual(pets.petMood({ ...base, tasks: [], runs: [{ card: '樱花庄', projectId: 'card', status: 'running', done: 1, total: 4 }] }).open, { kind: 'card', projectId: 'card' });
  assert.deepEqual(pets.petMood({ ...base, tasks: [] }).open, { kind: 'app' });
});

test('the floating pet keeps the spot it was dragged to, inside the screen it is on, or goes to the bottom-right corner', () => {
  const size = { width: 280, height: 270 };
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1280, height: 984 };
  const corner = { x: 1920 - 280 - pets.PET_MARGIN, y: 1040 - 270 - pets.PET_MARGIN };
  assert.deepEqual(pets.petPlacement(undefined, size, { primary, all: [primary, second] }), corner, 'the first time');
  assert.deepEqual(pets.petPlacement({ x: 2400, y: 300 }, size, { primary, all: [primary, second] }), { x: 2400, y: 300 }, 'a spot on the second screen');
  assert.deepEqual(pets.petPlacement({ x: 1700, y: 850 }, size, { primary, all: [primary, second] }), { x: 1640, y: 770 }, 'half off the edge: pulled back in');
  assert.deepEqual(pets.petPlacement({ x: 2400, y: 300 }, size, { primary, all: [primary] }), corner, 'the screen it was on is gone');
  assert.deepEqual(pets.petPlacement({ x: Number.NaN, y: 0 }, size, { primary, all: [primary] }), corner);
});
