import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { pngChunks, readCardFromPng, stripCardFromPng, writeCardIntoPng, writeCheckedCardPng } from '../src/core/card-studio/png.ts';
import { RE0_CARD, RE0_PNG } from './reference-cards.ts';

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
/** A one pixel greyscale PNG plus one unrelated text chunk, so the writer has something to preserve. */
function tinyPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 0;
  const pixels = deflateSync(Buffer.from([0, 255]));
  const note = Buffer.concat([Buffer.from('Software', 'latin1'), Buffer.from([0]), Buffer.from('Cardwright fixture', 'latin1')]);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('tEXt', note), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}
const sampleCard = () => ({ spec: 'chara_card_v3', spec_version: '3.0', name: '雾港档案', data: { name: '雾港档案', first_mes: '雾从码头升起。', character_book: { name: '书', entries: [] }, extensions: {} } });

test('a card is written into both payload chunks and read back', () => {
  const png = writeCardIntoPng(tinyPng(), sampleCard());
  const types = pngChunks(png).map(item => item.type);
  assert.deepEqual(types, ['IHDR', 'tEXt', 'IDAT', 'tEXt', 'tEXt', 'IEND'], 'the payloads go in before IEND and the original chunks stay');
  const read = readCardFromPng(png);
  assert.deepEqual(read.card, sampleCard());
  assert.deepEqual(read.payloads.sort(), ['ccv3', 'chara']);
  assert.equal(read.mismatch, false);
  const note = pngChunks(png).find(item => item.type === 'tEXt' && item.data.toString('latin1').startsWith('Software'));
  assert.ok(note, 'unrelated text chunks are preserved');
});

test('writing twice replaces the payloads instead of stacking them', () => {
  const once = writeCardIntoPng(tinyPng(), sampleCard());
  const twice = writeCardIntoPng(once, { ...sampleCard(), name: '改过的卡' });
  assert.equal(pngChunks(twice).filter(item => item.type === 'tEXt').length, 3, 'one unrelated chunk plus the two payloads');
  assert.equal((readCardFromPng(twice).card as Record<string, unknown>).name, '改过的卡');
});

test('a PNG without a card payload says so', () => {
  assert.throws(() => readCardFromPng(tinyPng()), /没有角色卡数据/);
});

test('a broken file is refused before anything is parsed', () => {
  assert.throws(() => readCardFromPng(Buffer.from('not a png at all')), /不是 PNG/);
  const png = writeCardIntoPng(tinyPng(), sampleCard());
  const damaged = Buffer.from(png); damaged[png.length - 12] ^= 0xff;
  assert.throws(() => readCardFromPng(damaged), /校验和|损坏/);
});

test('two payloads that disagree are reported, and ccv3 wins', () => {
  const png = writeCardIntoPng(tinyPng(), sampleCard());
  const other = Buffer.from(JSON.stringify({ ...sampleCard(), name: '另一张卡' }), 'utf8').toString('base64');
  const rebuilt = pngChunks(png).map(item => {
    if (item.type !== 'tEXt' || !item.data.toString('latin1').startsWith('chara' + String.fromCharCode(0))) return item.raw;
    return chunk('tEXt', Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(other, 'latin1')]));
  });
  const mixed = Buffer.concat([SIGNATURE, ...rebuilt]);
  const read = readCardFromPng(mixed);
  assert.equal(read.mismatch, true);
  assert.equal((read.card as Record<string, unknown>).name, '雾港档案', 'ccv3 is the V3 payload and wins');
});

test('the reference PNG holds the same card as the JSON export', { skip: existsSync(RE0_PNG) ? false : 'reference card not available' }, () => {
  const read = readCardFromPng(readFileSync(RE0_PNG));
  assert.deepEqual(read.payloads.sort(), ['ccv3', 'chara']);
  assert.equal(read.mismatch, false);
  const card = read.card as Record<string, Record<string, Record<string, unknown[]>>>;
  assert.equal(card.data.character_book.entries.length, 290);
  const json = JSON.parse(readFileSync(RE0_CARD, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  assert.deepEqual(read.card, json, 'the PNG and the JSON carry the same card');
});

test('a written PNG survives a round trip through the reader', { skip: existsSync(RE0_PNG) ? false : 'reference card not available' }, () => {
  const original = readFileSync(RE0_PNG);
  const card = readCardFromPng(original).card;
  const written = writeCardIntoPng(original, card);
  assert.deepEqual(readCardFromPng(written).card, card);
  assert.deepEqual(pngChunks(written).filter(item => item.type !== 'tEXt').map(item => item.type), pngChunks(original).filter(item => item.type !== 'tEXt').map(item => item.type), 'the image itself is untouched');
});

test('the image of a card PNG can be kept without the card inside it', () => {
  const original = tinyPng();
  const carded = writeCardIntoPng(original, sampleCard());
  const image = stripCardFromPng(carded);
  assert.deepEqual(pngChunks(image).map(item => item.type), ['IHDR', 'tEXt', 'IDAT', 'IEND'], 'only the two payloads go, the unrelated text chunk stays');
  assert.deepEqual(image, original, 'what is left is byte for byte the image it started as');
  assert.throws(() => readCardFromPng(image), /没有角色卡数据/);
  assert.deepEqual(stripCardFromPng(original), original, 'an image without a card is returned as it is');
});

test('an exported PNG is read back before it is trusted', () => {
  const card = sampleCard();
  const png = writeCheckedCardPng(tinyPng(), card);
  assert.deepEqual(readCardFromPng(png).card, card, 'what is written reads back as the same card');
  assert.throws(() => writeCheckedCardPng(tinyPng(), { data: { name: 'x', note: 1n } }), /BigInt|读回|JSON/, 'a card that cannot be written faithfully is refused');
});
