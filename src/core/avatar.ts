/** Avatars are normalized, bounded PNG or JPEG data; arbitrary URLs and SVG cannot enter the renderer. */
export const MAX_AVATAR_URL_LENGTH = 1_200_000;
export const MAX_AVATAR_EDGE = 512;

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    // Baseline and progressive frames carry the image dimensions.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

export function validateAvatar(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) throw new Error('Choose a valid local PNG or JPEG avatar.');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Choose a valid local PNG or JPEG avatar.');
  const bytes = Buffer.from(match[2], 'base64');
  let size: { width: number; height: number } | undefined;
  if (match[1] === 'png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid avatar image.');
    size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else {
    size = jpegSize(bytes);
    if (!size) throw new Error('Invalid avatar image.');
  }
  if (size.width < 1 || size.height < 1 || size.width > MAX_AVATAR_EDGE || size.height > MAX_AVATAR_EDGE) throw new Error(`Avatars must be normalized to at most ${MAX_AVATAR_EDGE} pixels.`);
  return value;
}
export function validateAvatars(value: unknown): { user?: string; assistant?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid avatar preferences.');
  const avatars = value as Record<string, unknown>;
  return { user: validateAvatar(avatars.user), assistant: validateAvatar(avatars.assistant) };
}
