import { nativeImage, type NativeImage } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { MAX_AVATAR_EDGE, validateAvatar } from '../core/avatar.ts';

async function openImage(path: string): Promise<NativeImage> {
  const information = await stat(path);
  if (!information.isFile() || information.size > 10 * 1024 * 1024 || !['.png', '.jpg', '.jpeg'].includes(extname(path).toLowerCase())) throw new Error('Choose a PNG or JPEG image smaller than 10 MB.');
  const image = nativeImage.createFromBuffer(await readFile(path));
  if (image.isEmpty()) throw new Error('This image could not be opened. Choose a PNG or JPEG file.');
  const { width, height } = image.getSize();
  if (width < 1 || height < 1 || width * height > 40_000_000) throw new Error('This image is too large. Choose one below 40 megapixels.');
  return image;
}

/** Transparent images keep PNG; opaque photos use high-quality JPEG to stay small at 512px. */
function encode(image: NativeImage): string {
  const bitmap = image.toBitmap();
  let transparent = false;
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] < 255) { transparent = true; break; }
  const result = transparent ? `data:image/png;base64,${image.toPNG().toString('base64')}` : `data:image/jpeg;base64,${image.toJPEG(92).toString('base64')}`;
  return validateAvatar(result)!;
}

function square(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  const edge = Math.min(width, height);
  const cropped = width === height ? image : image.crop({ x: Math.floor((width - edge) / 2), y: Math.floor((height - edge) / 2), width: edge, height: edge });
  const target = Math.min(MAX_AVATAR_EDGE, edge);
  return edge === target ? cropped : cropped.resize({ width: target, height: target, quality: 'best' });
}

/** Legacy one-step upload: centered square crop. */
export async function prepareAvatar(path: string): Promise<string> {
  return encode(square(await openImage(path)));
}

/** A bounded preview for the in-app cropper; the renderer never reads the original file. */
export async function previewAvatarSource(path: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const image = await openImage(path);
  const { width, height } = image.getSize();
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const preview = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
  const size = preview.getSize();
  return { dataUrl: `data:image/jpeg;base64,${preview.toJPEG(90).toString('base64')}`, width: size.width, height: size.height };
}

/** Re-decodes cropper output so only normalized pixels are stored. */
export function normalizeAvatar(dataUrl: unknown): string {
  if (typeof dataUrl !== 'string' || dataUrl.length > 4_000_000 || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new Error('Choose a valid local PNG or JPEG avatar.');
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('The cropped avatar could not be read.');
  return encode(square(image));
}
