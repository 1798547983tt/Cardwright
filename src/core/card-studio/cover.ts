/** Card covers: a 2:3 portrait cropped from an arbitrary image, stored as PNG/JPEG bytes and exported as PNG bytes.
    Everything here is pure; the main process runs the crop through sharp (src/main/card-cover.ts). */
import { pngChunks } from './png.ts';
import type { CoverOutput, CoverSaveRequest } from '../../shared/card-studio/types.ts';

export const COVER_WIDTH = 960;
export const COVER_HEIGHT = 1440;
/** The narrowest side a stored cover may have; below this the card face turns mushy in SillyTavern. */
export const COVER_MIN_EDGE = 300;
/** 4K on the long edge: the 2:3 portrait tops out at 2560×3840. */
export const COVER_MAX_EDGE = 3840;
/** 32 MB of base64 is about 24 MB of PNG — the same ceiling the IPC guard gives exportCardPng. */
const MAX_DATA_URL = 32_000_000;

export interface CoverCropResult { bytes: Buffer; mime: 'image/png' | 'image/jpeg'; extension: '.png' | '.jpg' }

export function sniffImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export function pngSize(buffer: Buffer): { width: number; height: number } {
  const header = pngChunks(buffer)[0];
  if (!header || header.type !== 'IHDR' || header.data.length < 8) throw new Error('这不是一个 PNG 图片。');
  return { width: header.data.readUInt32BE(0), height: header.data.readUInt32BE(4) };
}

/** The size of a stored cover, PNG or JPEG, without decoding pixels: JPEG reads the SOF marker. */
export function storedCoverSize(bytes: Buffer): { width: number; height: number } {
  const mime = sniffImageMime(bytes);
  if (mime === 'image/png') return pngSize(bytes);
  if (mime === 'image/jpeg') {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += 2; continue; }
      const length = bytes.readUInt16BE(at + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (at + 9 > bytes.length) break;
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
    throw new Error('这不是一张可以读取尺寸的 JPEG 图片。');
  }
  throw new Error('封面必须是 PNG 或 JPEG 图片。');
}

const ratio = (width: number, height: number): number => width / height;

/** The crop rectangle must sit inside the source, the output between 300 and 3840 on each side, and both 2:3. */
export function validateCropRequest(request: CoverSaveRequest, source: { width: number; height: number }): { crop: { left: number; top: number; width: number; height: number }; output: CoverOutput; quality: number } {
  const crop = request?.crop ?? (undefined as never);
  const output = request?.output ?? (undefined as never);
  const quality = request?.quality;
  if (!Number.isInteger(crop.x) || !Number.isInteger(crop.y) || !Number.isInteger(crop.width) || !Number.isInteger(crop.height)) throw new Error('裁剪区域无效。');
  if (crop.width < 1 || crop.height < 1 || crop.x < 0 || crop.y < 0 || crop.x + crop.width > source.width || crop.y + crop.height > source.height) throw new Error('裁剪区域超出了原图的范围。');
  if (!Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < COVER_MIN_EDGE || output.height < COVER_MIN_EDGE || Math.max(output.width, output.height) > COVER_MAX_EDGE) {
    throw new Error(`输出尺寸必须在 ${COVER_MIN_EDGE}~${COVER_MAX_EDGE} 像素之间。`);
  }
  if (Math.abs(ratio(crop.width, crop.height) - COVER_WIDTH / COVER_HEIGHT) > 0.01) throw new Error('裁剪区域必须是 2:3 的竖版比例。');
  if (Math.abs(ratio(output.width, output.height) - COVER_WIDTH / COVER_HEIGHT) > 0.01) throw new Error('输出尺寸必须是 2:3 的竖版比例。');
  if (quality !== 100 && (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 60 || quality > 99)) throw new Error('画质必须在 60–100 之间。');
  return { crop: { left: crop.x, top: crop.y, width: crop.width, height: crop.height }, output: { ...output }, quality };
}

/** A stored cover: PNG or JPEG, a 2:3 portrait between 300 px and 4K. */
export function validateStoredCover(bytes: Buffer): Buffer {
  if (sniffImageMime(bytes) === null) throw new Error('封面必须是 PNG 或 JPEG 图片。');
  const { width, height } = storedCoverSize(bytes);
  if (Math.abs(ratio(width, height) - COVER_WIDTH / COVER_HEIGHT) > 0.01) throw new Error('封面必须是 2:3 的竖版图片。');
  if (width < COVER_MIN_EDGE || height < COVER_MIN_EDGE) throw new Error(`封面的短边至少 ${COVER_MIN_EDGE} 像素。`);
  if (Math.max(width, height) > COVER_MAX_EDGE) throw new Error(`封面最长边不得超过 ${COVER_MAX_EDGE} 像素。`);
  return bytes;
}

/** The image of an exported PNG card: SillyTavern only cares that it is a portrait, so the ratio is what is checked. */
export function decodeCardImage(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('封面必须是 PNG 图片。');
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  const { width, height } = pngSize(bytes);
  if (Math.abs(ratio(width, height) - COVER_WIDTH / COVER_HEIGHT) > 0.01) throw new Error('卡面必须是 2:3 的竖版图片。');
  return bytes;
}

export function coverDataUrl(bytes: Buffer): string {
  return `data:${sniffImageMime(bytes) ?? 'image/png'};base64,${bytes.toString('base64')}`;
}
