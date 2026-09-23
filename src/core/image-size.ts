/** Width and height from an image file's header, without decoding it: WebP (lossy, lossless, extended) and PNG. */
export interface ImageSize { width: number; height: number; type: 'webp' | 'png' }

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('latin1', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), type: 'png' };
  }
  if (data.length < 16 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = data.toString('latin1', 12, 16);
  // Extended: 24-bit canvas width and height minus one.
  if (chunk === 'VP8X' && data.length >= 30) return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1, type: 'webp' };
  // Lossless: after the 0x2f signature, 14 bits of width minus one, then 14 bits of height minus one.
  if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, type: 'webp' };
  }
  // Lossy: a key frame's start code, then 14-bit width and height.
  if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, type: 'webp' };
  }
  return null;
}
