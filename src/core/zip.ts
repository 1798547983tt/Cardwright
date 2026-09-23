/**
 * Just enough ZIP to read a pet pack in memory: the central directory, stored and deflated entries. Nothing is written
 * to disk here, and a name that climbs out of the archive or an entry that inflates past the limit is refused.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer }

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(bytes: Uint8Array, limit = 64 * 1024 * 1024): ZipEntry[] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65_557); index--) {
    if (data.readUInt32LE(index) === END) { end = index; break; }
  }
  if (end < 0) throw new Error('这不是一个 ZIP 文件。');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL) throw new Error('ZIP 的目录损坏了。');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const length = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const local = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
    if (name.endsWith('/') || name.endsWith('\\')) continue;
    if (/^[\\/]|^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..')) throw new Error(`ZIP 里有指向压缩包外面的路径：${name}`);
    if (flags & 1) throw new Error('不支持加密的 ZIP。');
    total += length;
    if (total > limit) throw new Error('ZIP 解压后太大了。');
    if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL) throw new Error(`ZIP 条目损坏：${name}`);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + compressed);
    let content: Buffer;
    if (method === 0) content = Buffer.from(body);
    else if (method === 8) {
      try { content = inflateRawSync(body, { maxOutputLength: Math.max(1, length) }); }
      catch { throw new Error(`ZIP 条目解不开：${name}`); }
    } else throw new Error(`ZIP 条目用了不支持的压缩方式（${method}）：${name}`);
    entries.push({ name, data: content });
  }
  return entries;
}
