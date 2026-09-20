/** Card covers: a 2:3 portrait the renderer draws on a canvas, stored and exported as PNG bytes.
    Everything here is pure, so the main process never re-encodes what the cropper produced. */
import { pngChunks } from './png.ts';

export const COVER_WIDTH = 960;
export const COVER_HEIGHT = 1440;
/** 24 MB of base64 is about 18 MB of PNG — far more than a 960×1440 cover ever needs. */
const MAX_DATA_URL = 24_000_000;

export function pngSize(buffer: Buffer): { width: number; height: number } {
  const header = pngChunks(buffer)[0];
  if (!header || header.type !== 'IHDR' || header.data.length < 8) throw new Error('这不是一个 PNG 图片。');
  return { width: header.data.readUInt32BE(0), height: header.data.readUInt32BE(4) };
}

function decode(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('封面必须是 PNG 图片。');
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  pngSize(bytes);
  return bytes;
}

/** The crop dialog always draws at the full size, so a stored cover is exactly 960×1440. */
export function decodeCover(dataUrl: unknown): Buffer {
  const bytes = decode(dataUrl);
  const { width, height } = pngSize(bytes);
  if (width !== COVER_WIDTH || height !== COVER_HEIGHT) throw new Error(`封面必须是 ${COVER_WIDTH}×${COVER_HEIGHT} 的图片。`);
  return bytes;
}

/** The image of an exported PNG card: SillyTavern only cares that it is a portrait, so the ratio is what is checked. */
export function decodeCardImage(dataUrl: unknown): Buffer {
  const bytes = decode(dataUrl);
  const { width, height } = pngSize(bytes);
  if (Math.abs(width / height - COVER_WIDTH / COVER_HEIGHT) > 0.01) throw new Error('卡面必须是 2:3 的竖版图片。');
  return bytes;
}

export function coverDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
