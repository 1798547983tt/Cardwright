// src/core/card-studio/frontend-resources.ts
/** The front-end skeleton shipped in card-studio/frontend, read once per service (ADR 0019). */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrontendResources } from '../../shared/card-studio/frontend-compile.ts';

const strip = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
async function read(root: string, relative: string): Promise<string> {
  try { return strip(await readFile(join(root, ...relative.split('/')), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`前端骨架缺失：${relative}。请重新安装 Cardwright。`);
    throw error;
  }
}

export async function loadFrontendResources(resourceRoot: string): Promise<FrontendResources> {
  const [core, host, floating, base] = await Promise.all(['frontend/runtime/core.js', 'frontend/runtime/host.js', 'frontend/runtime/floating.js', 'frontend/base.css'].map(name => read(resourceRoot, name)));
  const version = /const VERSION = '([^']+)'/.exec(core)?.[1] ?? '0.0.0';
  const names = (await readdir(join(resourceRoot, 'frontend', 'skins'))).filter(name => name.endsWith('.css'));
  const skins: Record<string, string> = {};
  for (const name of names) skins[name.slice(0, -'.css'.length)] = await read(resourceRoot, `frontend/skins/${name}`);
  return { version, core, host, floating, base, skins };
}
