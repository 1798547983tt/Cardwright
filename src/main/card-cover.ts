/** The one place a cover image is decoded from an arbitrary file: picking the image the user wants to crop.
    Everything after this point is plain PNG bytes, handled by src/core/card-studio/cover.ts. */
import { nativeImage } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/** The crop dialog never needs more than this; downsizing here keeps the preview off the IPC channel's slow path. */
const PREVIEW_EDGE = 1600;

export async function readCoverSource(path: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const information = await stat(path);
  if (!information.isFile() || information.size > 20 * 1024 * 1024 || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase())) {
    throw new Error('请选择小于 20 MB 的 PNG、JPEG 或 WebP 图片。');
  }
  const image = nativeImage.createFromBuffer(await readFile(path));
  if (image.isEmpty()) throw new Error('这张图片打不开，请换一张 PNG 或 JPEG。');
  const { width, height } = image.getSize();
  if (width < 1 || height < 1) throw new Error('这张图片打不开，请换一张 PNG 或 JPEG。');
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(width, height));
  const preview = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
  const size = preview.getSize();
  return { dataUrl: `data:image/jpeg;base64,${preview.toJPEG(92).toString('base64')}`, width: size.width, height: size.height };
}
