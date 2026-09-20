import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { COVER_HEIGHT, COVER_WIDTH, coverDataUrl, decodeCardImage, decodeCover, pngSize } from '../src/core/card-studio/cover.ts';

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
const url = (buffer: Buffer, type = 'image/png') => `data:${type};base64,${buffer.toString('base64')}`;

test('the size comes from IHDR', () => {
  assert.deepEqual(pngSize(png(COVER_WIDTH, COVER_HEIGHT)), { width: COVER_WIDTH, height: COVER_HEIGHT });
  assert.throws(() => pngSize(Buffer.from('not a png at all, really not')), /PNG/);
  assert.throws(() => pngSize(Buffer.concat([SIGNATURE, chunk('IDAT', Buffer.alloc(4))])), /PNG/);
});

test('a stored cover has to be exactly 960×1440', () => {
  const cover = png(COVER_WIDTH, COVER_HEIGHT);
  assert.deepEqual(decodeCover(url(cover)), cover, 'the bytes the cropper produced are stored unchanged');
  assert.throws(() => decodeCover(url(png(640, 960))), /960/);
  assert.throws(() => decodeCover(url(png(COVER_WIDTH, COVER_HEIGHT), 'image/jpeg')), /PNG/);
  assert.throws(() => decodeCover('封面/封面.png'), /PNG/);
  assert.throws(() => decodeCover(`data:image/png;base64,${'A'.repeat(24_000_001)}`), /PNG/);
  assert.throws(() => decodeCover(url(Buffer.from('nonsense'))), /PNG/);
});

test('an exported card image only has to be a 2:3 portrait', () => {
  const small = png(480, 720);
  assert.deepEqual(decodeCardImage(url(small)), small, 'a smaller 2:3 image is kept as it is');
  assert.deepEqual(decodeCardImage(url(png(COVER_WIDTH, COVER_HEIGHT))), png(COVER_WIDTH, COVER_HEIGHT));
  assert.throws(() => decodeCardImage(url(png(1440, 960))), /2:3/);
  assert.throws(() => decodeCardImage(url(png(960, 960))), /2:3/);
});

test('bytes become a data URL the renderer can show', () => {
  const cover = png(COVER_WIDTH, COVER_HEIGHT);
  assert.equal(coverDataUrl(cover), url(cover));
  assert.deepEqual(decodeCover(coverDataUrl(cover)), cover, 'the round trip is lossless');
});
