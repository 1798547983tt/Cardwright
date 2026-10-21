/** The one place a cover image is decoded from an arbitrary file: picking the image the user wants to crop,
    and running the crop itself through sharp, straight from the retained source bytes. The renderer only
    ever sees a small preview and hands back a crop request in the source image's own pixel space. */
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp from 'sharp';
import { validateCropRequest, type CoverCropResult } from '../core/card-studio/cover.ts';
import type { CoverSaveRequest } from '../shared/card-studio/types.ts';

/** The crop dialog never needs more than this; downsizing here keeps the preview off the IPC channel's slow path. */
const PREVIEW_EDGE = 1600;
/** Files up to 64 MB, like the 资料导入 limit; anything larger is a book scan, not a cover. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Decoding pixels is what costs memory; cap it before sharp does. */
const MAX_PIXELS = 50_000_000;
const FORMATS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tiff'];
/** Retained source images, sourceId → bytes; the LRU keeps the worst case bounded. */
const SOURCES = new Map<string, Buffer>();
const SOURCE_LIMIT = 8;

function retain(bytes: Buffer): string {
  const sourceId = randomUUID();
  SOURCES.set(sourceId, bytes);
  while (SOURCES.size > SOURCE_LIMIT) SOURCES.delete(SOURCES.keys().next().value!);
  return sourceId;
}

/** Retains the picked image for the crop dialog and returns a bounded preview of it. */
export async function readCoverSource(path: string): Promise<{ sourceId: string; dataUrl: string; width: number; height: number }> {
  const information = await stat(path);
  if (!information.isFile() || information.size > MAX_FILE_BYTES || !FORMATS.includes(extname(path).toLowerCase())) {
    throw new Error('请选择小于 64 MB 的图片文件（PNG、JPEG、WebP 等）。');
  }
  const bytes = await readFile(path);
  const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => null);
  if (!metadata?.width || !metadata?.height) throw new Error('这张图片打不开，请换一张 PNG、JPEG 或 WebP。');
  const { width, height } = metadata;
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height));
  const preview = scale < 1
    ? await sharp(bytes, { limitInputPixels: MAX_PIXELS }).resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' }).jpeg({ quality: 92 }).toBuffer()
    : await sharp(bytes, { limitInputPixels: MAX_PIXELS }).jpeg({ quality: 92 }).toBuffer();
  return { sourceId: retain(bytes), dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`, width, height };
}

/** Runs the crop on the retained source and hands back encoded bytes, plus the mime to store it under. */
export async function cropCover(request: CoverSaveRequest): Promise<CoverCropResult> {
  const bytes = SOURCES.get(request?.sourceId ?? '');
  if (!bytes) throw new Error('找不到所选的封面原图，请重新选择图片。');
  const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
  const checked = validateCropRequest(request, { width: metadata.width ?? 0, height: metadata.height ?? 0 });
  const pipeline = sharp(bytes, { limitInputPixels: MAX_PIXELS }).extract(checked.crop);
  const output = checked.output.width === checked.crop.width && checked.output.height === checked.crop.height ? pipeline : pipeline.resize(checked.output.width, checked.output.height, { kernel: 'lanczos3' });
  const encoded = checked.quality === 100
    ? await output.png().toBuffer()
    : await output.jpeg({ quality: checked.quality, mozjpeg: true }).toBuffer();
  SOURCES.delete(request.sourceId);
  return checked.quality === 100
    ? { bytes: encoded, mime: 'image/png', extension: '.png' }
    : { bytes: encoded, mime: 'image/jpeg', extension: '.jpg' };
}

/** Frees a source the dialog is done with (closed without saving). */
export function releaseCoverSource(sourceId: string): void {
  SOURCES.delete(sourceId);
}
