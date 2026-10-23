import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { COVER_HEIGHT, COVER_MAX_EDGE, COVER_MIN_EDGE, COVER_WIDTH, coverDataUrl, decodeCardImage, pngSize, sniffImageMime, storedCoverSize, validateCropRequest, validateStoredCover } from '../src/core/card-studio/cover.ts';
import { cropCover, readCoverSource } from '../src/main/card-cover.ts';
import { ARG_LIMITS, assertArgSize, argLimit } from '../src/main/ipc-size.ts';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A greyscale PNG of the given size; the pixel data is nonsense but no decoder ever looks at it here. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  const pixels = deflateSync(Buffer.alloc(height * (width + 1)));
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}
/** A tiny real JPEG through sharp, so the SOF walker sees a genuine encoding. */
async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer();
}
const url = (buffer: Buffer, type = 'image/png') => `data:${type};base64,${buffer.toString('base64')}`;

test('the size comes from IHDR', () => {
  assert.deepEqual(pngSize(png(COVER_WIDTH, COVER_HEIGHT)), { width: COVER_WIDTH, height: COVER_HEIGHT });
  assert.throws(() => pngSize(Buffer.from('not a png at all, really not')), /PNG/);
  assert.throws(() => pngSize(Buffer.concat([SIGNATURE, chunk('IDAT', Buffer.alloc(4))])), /PNG/);
});

test('magic bytes decide the mime', async () => {
  assert.equal(sniffImageMime(png(300, 450)), 'image/png');
  assert.equal(sniffImageMime(await jpeg(300, 450)), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('<html>')), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('the stored cover may be PNG or JPEG, 2:3, between 300 px and 4K', async () => {
  const small = png(COVER_WIDTH, COVER_HEIGHT);
  assert.deepEqual(validateStoredCover(small), small, 'the bytes are stored unchanged');
  const photo = await jpeg(1200, 1800);
  assert.deepEqual(validateStoredCover(photo), photo, 'a JPEG cover passes too');
  assert.deepEqual(storedCoverSize(await jpeg(960, 1440)), { width: 960, height: 1440 });
  assert.throws(() => validateStoredCover(png(960, 640)), /2:3/, 'a 3:2 landscape fails');
  assert.throws(() => validateStoredCover(png(200, 300)), /300/, 'below the minimum edge fails');
  assert.throws(() => validateStoredCover(png(2560, 3840 + 2)), /3840/, 'past 4K fails');
  assert.throws(() => validateStoredCover(Buffer.from('nonsense')), /PNG 或 JPEG/);
});

test('the crop request is checked against the real source', () => {
  const source = { width: 1920, height: 2880 };
  const good = { sourceId: 'x', crop: { x: 100, y: 200, width: 1280, height: 1920 }, output: { width: 960, height: 1440 }, quality: 85 };
  const checked = validateCropRequest(good, source);
  assert.deepEqual(checked.crop, { left: 100, top: 200, width: 1280, height: 1920 });
  assert.equal(checked.quality, 85);
  // The crop may sit anywhere inside the source, so 1:1 sources crop fine as well.
  const square = validateCropRequest({ ...good, crop: { x: 0, y: 0, width: 1000, height: 1500 } }, { width: 1000, height: 4000 });
  assert.deepEqual(square.crop, { left: 0, top: 0, width: 1000, height: 1500 });
  assert.throws(() => validateCropRequest({ ...good, crop: { x: -1, y: 0, width: 1280, height: 1920 } }, source), /超出/);
  assert.throws(() => validateCropRequest({ ...good, crop: { x: 100, y: 200, width: 1920, height: 2880 } }, source), /超出/, 'hanging past the right edge fails');
  assert.throws(() => validateCropRequest({ ...good, crop: { x: 0, y: 0, width: 1000, height: 1000 } }, source), /2:3/, 'a square crop fails');
  assert.throws(() => validateCropRequest({ ...good, output: { width: 200, height: 300 } }, source), /300/);
  assert.throws(() => validateCropRequest({ ...good, output: { width: 2560, height: 3840 + 10 } }, source), /3840/);
  assert.throws(() => validateCropRequest({ ...good, output: { width: 1440, height: 960 } }, source), /2:3/);
  assert.throws(() => validateCropRequest({ ...good, quality: 59 }, source), /60/);
  assert.throws(() => validateCropRequest({ ...good, quality: 99.5 }, source), /60/);
  assert.doesNotThrow(() => validateCropRequest({ ...good, quality: 100 }, source), 'quality 100 means lossless PNG');
  assert.throws(() => validateCropRequest({ ...good, crop: { x: 0.5, y: 0, width: 1280, height: 1920 } }, source), /无效/);
});

test('an exported card image only has to be a 2:3 portrait PNG', () => {
  const small = png(480, 720);
  assert.deepEqual(decodeCardImage(url(small)), small, 'a smaller 2:3 image is kept as it is');
  assert.deepEqual(decodeCardImage(url(png(COVER_WIDTH, COVER_HEIGHT))), png(COVER_WIDTH, COVER_HEIGHT));
  assert.throws(() => decodeCardImage(url(png(1440, 960))), /2:3/);
  assert.throws(() => decodeCardImage(url(png(960, 960))), /2:3/);
  assert.throws(() => decodeCardImage(url(png(COVER_WIDTH, COVER_HEIGHT), 'image/jpeg')), /PNG/);
  assert.throws(() => decodeCardImage(`data:image/png;base64,${'A'.repeat(32_000_001)}`), /PNG/);
});

test('bytes become a data URL the renderer can show', () => {
  const cover = png(COVER_WIDTH, COVER_HEIGHT);
  assert.equal(coverDataUrl(cover), url(cover));
  const pngBytes = Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(12)), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(coverDataUrl(pngBytes).startsWith('data:image/png;base64,'), true);
  assert.equal(coverDataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).startsWith('data:image/jpeg;base64,'), true);
  assert.equal(coverDataUrl(Buffer.from('<html>not an image')).startsWith('data:image/png;base64,'), true, 'unknown bytes fall back to png');
});

test('the IPC guard keeps the default and lifts the PNG export', () => {
  assert.equal(argLimit('snapshot'), 2_000_000);
  assert.equal(argLimit('exportCardPng'), 32_000_000);
  assert.equal(ARG_LIMITS.saveCardCover, undefined, 'the cover save is small now and rides the default');
  // JSON.stringify wraps the args array in brackets and each string in quotes: ['x'] is length + 4.
  assert.throws(() => assertArgSize('snapshot', ['A'.repeat(1_999_999)]), /Request exceeds/);
  assert.doesNotThrow(() => assertArgSize('snapshot', ['A'.repeat(1_999_996)]));
  assert.doesNotThrow(() => assertArgSize('exportCardPng', ['A'.repeat(31_999_995)]), 'a rendered photo card face passes');
  assert.throws(() => assertArgSize('exportCardPng', ['A'.repeat(31_999_999)]), /Request exceeds/);
});

test('EXIF orientation is applied before the preview and the crop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cardwright-cover-'));
  try {
    // 600×400 with a red left half and a blue right half. Orientation=6 says the stored image must be
    // rotated 90° clockwise to display, so the red half is the top half of the picture the user sees.
    const red = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const blue = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const photo = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 300, top: 0 }])
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const path = join(directory, 'phone.jpg');
    await writeFile(path, photo);

    const source = await readCoverSource(path);
    assert.deepEqual({ width: source.width, height: source.height }, { width: 400, height: 600 }, 'the source is measured as displayed');
    const result = await cropCover({ sourceId: source.sourceId, crop: { x: 0, y: 0, width: 400, height: 600 }, output: { width: 300, height: 450 }, quality: 100 });
    assert.equal(result.extension, '.png');
    const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => { const at = (y * info.width + x) * info.channels; return [data[at], data[at + 1], data[at + 2]]; };
    const top = pixel(150, 30);
    const bottom = pixel(150, 420);
    assert.ok(top[0] > 180 && top[2] < 90, `the red half ends up on top, got ${top}`);
    assert.ok(bottom[2] > 180 && bottom[0] < 90, `the blue half ends up at the bottom, got ${bottom}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
