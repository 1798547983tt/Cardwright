import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeText } from '../src/core/card-studio/encoding.ts';

const sample = '第一回　灵根育孕源流出\n诗曰：混沌未分天地乱。\n';
// The same text encoded as GBK (generated with Python's str.encode('gbk')).
const gbk = Buffer.from('b5dad2bbbbd8a1a1c1e9b8f9d3fdd4d0d4b4c1f7b3f60acaabd4bba3babbece3e7ceb4b7d6ccecb5d8c2d2a1a30a', 'hex');

test('decodes GBK bytes as GB18030', () => {
  assert.deepEqual(decodeText(gbk), { encoding: 'gb18030', label: 'GB18030/GBK → UTF-8', text: sample });
});

test('keeps UTF-8 without a byte order mark', () => {
  assert.deepEqual(decodeText(Buffer.from(sample, 'utf8')), { encoding: 'utf-8', label: 'UTF-8', text: sample });
});

test('strips a UTF-8 byte order mark', () => {
  const result = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample, 'utf8')]));
  assert.deepEqual(result, { encoding: 'utf-8-bom', label: 'UTF-8 BOM → UTF-8', text: sample });
});

test('decodes UTF-16 little and big endian with a byte order mark', () => {
  const little = Buffer.from(sample, 'utf16le');
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), little])), { encoding: 'utf-16le', label: 'UTF-16LE → UTF-8', text: sample });
  const big = Buffer.from(little); big.swap16();
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), big])), { encoding: 'utf-16be', label: 'UTF-16BE → UTF-8', text: sample });
});

test('treats plain ASCII and empty files as UTF-8', () => {
  assert.equal(decodeText(Buffer.from('Chapter 1\nhello\n', 'ascii')).encoding, 'utf-8');
  assert.deepEqual(decodeText(Buffer.alloc(0)), { encoding: 'utf-8', label: 'UTF-8', text: '' });
});

test('recognizes UTF-16LE without a byte order mark from its zero bytes', () => {
  const text = 'Chapter 1: The beginning\n第一章\n';
  assert.deepEqual(decodeText(Buffer.from(text, 'utf16le')), { encoding: 'utf-16le', label: 'UTF-16LE → UTF-8', text });
});
