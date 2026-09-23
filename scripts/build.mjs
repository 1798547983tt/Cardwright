import { build as bundle } from 'esbuild';
import { build as frontend } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildNative } from './build-native.mjs';

await mkdir('dist', { recursive: true });
if (process.platform === 'win32') await buildNative();
await bundle({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron', '@earendil-works/pi-ai/compat'], sourcemap: true, logLevel: 'info' });
await bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron'], sourcemap: true, logLevel: 'info' });
// The floating desk pet's window has a bridge of its own (ADR 0018).
await bundle({ entryPoints: ['src/main/pet-preload.ts'], outfile: 'dist/pet-preload.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron'], sourcemap: true, logLevel: 'info' });
await bundle({ entryPoints: ['src/runtime/worker.ts'], outfile: 'dist/worker.mjs', platform: 'node', format: 'esm', bundle: true, packages: 'external', sourcemap: true, logLevel: 'info' });
// Self-contained so the card schema sandbox can run under Node's permission model with only its own file readable.
await bundle({ entryPoints: ['src/core/card-studio/sandbox-entry.ts'], outfile: 'dist/card-sandbox.cjs', platform: 'node', format: 'cjs', bundle: true, sourcemap: false, logLevel: 'info' });
await frontend({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true, rolldownOptions: { input: { index: resolve('index.html'), pet: resolve('pet.html') } } }, logLevel: 'info' });

// Original chamfered signal mark (same geometry as src/renderer/primitives.tsx Mark).
// PNG/ICO encoding keeps packaging independent of image tools.
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]); }
const TILE = [[16, 4], [60, 4], [60, 48], [48, 60], [4, 60], [4, 16]];
const LETTER = [[47, 17], [26, 17], [17, 26], [17, 38], [26, 47], [47, 47], [47, 39], [30, 39], [25, 34], [25, 30], [30, 25], [47, 25]];
const DOT = [[51, 9], [55, 9], [55, 13], [51, 13]];
function inside(polygon, x, y) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; } return hit; }
function markPng(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1)); const samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let tile = 0; let ink = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const u = (x + (sx + .5) / samples) * 64 / size; const v = (y + (sy + .5) / samples) * 64 / size;
      if (inside(TILE, u, v)) { tile++; if (inside(LETTER, u, v) || inside(DOT, u, v)) ink++; }
    }
    const total = samples * samples; const index = y * (size * 4 + 1) + 1 + x * 4; const inkShare = tile ? ink / tile : 0;
    pixels[index] = Math.round(242 * (1 - inkShare) + 17 * inkShare); pixels[index + 1] = Math.round(226 * (1 - inkShare) + 17 * inkShare); pixels[index + 2] = Math.round(55 * (1 - inkShare) + 17 * inkShare); pixels[index + 3] = Math.round(255 * tile / total);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function markIco(sizes) {
  const images = sizes.map(size => ({ size, png: markPng(size) }));
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16; const entries = [];
  for (const { size, png } of images) { const entry = Buffer.alloc(16); entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12); offset += png.length; entries.push(entry); }
  return Buffer.concat([head, ...entries, ...images.map(image => image.png)]);
}
// The taskbar mark for "something needs you", shown while the window is elsewhere.
function badgePng(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const middle = (size - 1) / 2; const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x - middle, y - middle);
    const edge = Math.min(1, Math.max(0, radius - distance));
    const index = y * (size * 4 + 1) + 1 + x * 4;
    pixels[index] = 242; pixels[index + 1] = 226; pixels[index + 2] = 55; pixels[index + 3] = Math.round(255 * edge);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
await writeFile('dist/badge.png', badgePng(32));
await writeFile('dist/icon.png', markPng(256));
await writeFile('dist/icon-tray.png', markPng(16));
await writeFile('dist/icon-tray@2x.png', markPng(32));
await writeFile('dist/icon.ico', markIco([16, 24, 32, 48, 64, 128, 256]));
