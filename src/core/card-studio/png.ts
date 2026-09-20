/**
 * Character card payloads inside a PNG. SillyTavern stores the card as base64 JSON in two tEXt chunks,
 * `chara` (compatibility) and `ccv3` (V3). Everything else in the image is left untouched.
 */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PAYLOAD_KEYWORDS = ['ccv3', 'chara'] as const;

export interface PngChunk { type: string; data: Buffer; raw: Buffer; offset: number }
export interface PngCard { card: unknown; payloads: string[]; mismatch: boolean }

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Every chunk of a PNG, in file order. Throws on a broken signature, length or checksum. */
export function pngChunks(buffer: Buffer): PngChunk[] {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('这个文件不是 PNG。');
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > buffer.length || end > buffer.length) throw new Error('PNG 数据块长度损坏，文件可能不完整。');
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expected = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expected) throw new Error(`PNG 数据块 ${type} 的校验和不对，文件可能损坏。`);
    chunks.push({ type, data, raw: buffer.subarray(offset, end), offset });
    offset = end;
    if (type === 'IEND') break;
  }
  if (!chunks.some(chunk => chunk.type === 'IEND')) throw new Error('PNG 缺少结束块，文件可能不完整。');
  return chunks;
}

const textPayload = (chunk: PngChunk): { keyword: string; text: string } | null => {
  if (chunk.type !== 'tEXt') return null;
  const zero = chunk.data.indexOf(0);
  if (zero < 0) return null;
  return { keyword: chunk.data.toString('latin1', 0, zero), text: chunk.data.toString('latin1', zero + 1) };
};

function decodePayload(keyword: string, text: string): unknown {
  const json = Buffer.from(text.trim(), 'base64').toString('utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(json); }
  catch { throw new Error(`PNG 里的 ${keyword} 数据块不是有效的角色卡 JSON。`); }
}

/** Reads the card out of a PNG. `ccv3` wins when both payloads exist and disagree. */
export function readCardFromPng(buffer: Buffer): PngCard {
  const chunks = pngChunks(buffer);
  const found = new Map<string, unknown>();
  const duplicates: string[] = [];
  for (const chunk of chunks) {
    const payload = textPayload(chunk);
    if (!payload || !PAYLOAD_KEYWORDS.includes(payload.keyword as typeof PAYLOAD_KEYWORDS[number])) continue;
    if (found.has(payload.keyword)) { duplicates.push(payload.keyword); continue; }
    found.set(payload.keyword, decodePayload(payload.keyword, payload.text));
  }
  if (duplicates.length) throw new Error(`PNG 里有重复的 ${[...new Set(duplicates)].join('、')} 数据块，无法判断该用哪一个。`);
  if (!found.size) throw new Error('这张 PNG 里没有角色卡数据（缺少 chara 或 ccv3 数据块）。');
  const card = found.get('ccv3') ?? found.get('chara');
  const mismatch = found.size > 1 && JSON.stringify(found.get('ccv3')) !== JSON.stringify(found.get('chara'));
  return { card, payloads: [...found.keys()], mismatch };
}

const isPayload = (chunk: PngChunk): boolean => {
  const payload = textPayload(chunk);
  return !!payload && PAYLOAD_KEYWORDS.includes(payload.keyword as typeof PAYLOAD_KEYWORDS[number]);
};

/** The image alone: the card payload chunks removed, every other chunk kept byte for byte. */
export function stripCardFromPng(buffer: Buffer): Buffer {
  const chunks = pngChunks(buffer);
  if (!chunks.some(isPayload)) return buffer;
  return Buffer.concat([SIGNATURE, ...chunks.filter(chunk => !isPayload(chunk)).map(chunk => chunk.raw)]);
}

/** Writes the card into both payload chunks, replacing earlier ones and keeping every other chunk. */
export function writeCardIntoPng(buffer: Buffer, card: unknown): Buffer {
  const chunks = pngChunks(buffer);
  const text = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  const payloads = PAYLOAD_KEYWORDS.map(keyword => makeChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])));
  const kept: Buffer[] = [];
  for (const chunk of chunks) {
    if (isPayload(chunk)) continue;
    if (chunk.type === 'IEND') { kept.push(...payloads, chunk.raw); continue; }
    kept.push(chunk.raw);
  }
  return Buffer.concat([SIGNATURE, ...kept]);
}

/** Writes the card and reads it straight back (§5.21): an export that would not read back as the same card is refused. */
export function writeCheckedCardPng(buffer: Buffer, card: unknown): Buffer {
  const written = writeCardIntoPng(buffer, card);
  const back = readCardFromPng(written);
  if (back.mismatch || JSON.stringify(back.card) !== JSON.stringify(card)) throw new Error('导出的 PNG 重新读回后与整卡不一致，已停止导出。');
  return written;
}
