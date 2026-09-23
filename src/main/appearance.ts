/**
 * 主题包 and 桌宠 on disk (ADR 0018): theme packs in `<资料目录>/themes/<id>/`, pet packs in `<资料目录>/pets/<id>/` beside
 * the built-in ones in `assets/pets/`. Everything is checked before it is used or installed, and a pack that is not
 * right is listed with its reason instead of breaking the settings page.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { imageSize } from '../core/image-size.ts';
import { readZip } from '../core/zip.ts';
import { parsePetManifest, spriteLayout, type PetManifest, type SpriteLayout } from '../shared/pets.ts';
import { parseThemePack, type ThemeDefinition } from '../shared/themes.ts';
import type { AppearanceSnapshot, PetSummary } from '../shared/types.ts';

/** Codex refuses bigger spritesheets; so does Cardwright. */
const SPRITE_LIMIT = 20 * 1024 * 1024;
const BACKGROUND_LIMIT = 8 * 1024 * 1024;
const PACK_LIMIT = 64 * 1024 * 1024;
const MIME: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

interface PetOnDisk { manifest: PetManifest; layout: SpriteLayout; folder: string; notice: boolean }

async function folders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function header(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try { const buffer = Buffer.alloc(64); const { bytesRead } = await handle.read(buffer, 0, 64, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

/** The layout a spritesheet's bytes describe, or the reason it cannot be a pet. */
function checkSheet(bytes: Buffer, size: number): SpriteLayout {
  if (size > SPRITE_LIMIT) throw new Error('精灵图超过 20 MB。');
  const dimensions = imageSize(bytes);
  if (!dimensions) throw new Error('精灵图不是 WebP 或 PNG。');
  const layout = spriteLayout(dimensions.width, dimensions.height);
  if (!layout) throw new Error(`精灵图是 ${dimensions.width}×${dimensions.height}，桌宠包要 1536×1872（v1）或 1536×2288（v2）。`);
  return layout;
}

export class AppearanceService {
  readonly themesFolder: string;
  readonly petsFolder: string;
  private readonly builtInPets: string;

  constructor(dataDir: string, appRoot: string) {
    this.themesFolder = join(dataDir, 'themes');
    this.petsFolder = join(dataDir, 'pets');
    this.builtInPets = join(appRoot, 'assets', 'pets');
  }

  async snapshot(): Promise<AppearanceSnapshot> {
    const themes: ThemeDefinition[] = []; const rejectedThemes: AppearanceSnapshot['rejectedThemes'] = [];
    for (const folder of await folders(this.themesFolder)) {
      try { themes.push(await this.readTheme(folder)); } catch (error) { rejectedThemes.push({ folder, reason: message(error) }); }
    }
    const pets: PetSummary[] = []; const rejectedPets: AppearanceSnapshot['rejectedPets'] = [];
    const builtIn = new Set<string>();
    for (const folder of await folders(this.builtInPets)) {
      // A built-in pet that does not load is a packaging fault; it is left out rather than shown to the user as theirs.
      try { const pet = await this.readPet(join(this.builtInPets, folder)); builtIn.add(pet.manifest.id); pets.push(this.summary(pet, true)); } catch { /* verify-release checks the built-in pack. */ }
    }
    for (const folder of await folders(this.petsFolder)) {
      try {
        const pet = await this.readPet(join(this.petsFolder, folder));
        if (builtIn.has(pet.manifest.id)) throw new Error(`「${pet.manifest.id}」和内置宠物重名。`);
        pets.push(this.summary(pet, false));
      } catch (error) { rejectedPets.push({ folder, reason: message(error) }); }
    }
    return { themes, rejectedThemes, pets, rejectedPets, themesFolder: this.themesFolder, petsFolder: this.petsFolder };
  }

  /** A theme's background picture, as a data URL the window can show. */
  async themeBackground(id: string): Promise<string> {
    const theme = await this.readTheme(id);
    if (!theme.background) throw new Error('这个主题没有背景图。');
    const path = join(this.themesFolder, id, theme.background);
    if ((await stat(path)).size > BACKGROUND_LIMIT) throw new Error('背景图超过 8 MB。');
    return `data:${MIME[extname(path).toLowerCase()]};base64,${(await readFile(path)).toString('base64')}`;
  }

  async petSprite(id: string): Promise<{ dataUrl: string; layout: SpriteLayout }> {
    const pet = await this.findPet(id);
    const path = join(pet.folder, pet.manifest.spritesheetPath);
    return { dataUrl: `data:${MIME[extname(path).toLowerCase()]};base64,${(await readFile(path)).toString('base64')}`, layout: pet.layout };
  }

  /** A pet's NOTICE.md (source, author, licence), when its pack has one. */
  async petNotice(id: string): Promise<string> {
    const pet = await this.findPet(id);
    return pet.notice ? readFile(join(pet.folder, 'NOTICE.md'), 'utf8') : '';
  }

  /** Installs a pet pack from a ZIP or a folder. It is checked in memory first, so a bad pack leaves nothing behind. */
  async installPet(source: string): Promise<{ id: string; displayName: string; version: 1 | 2; replaced: boolean }> {
    const files = (await stat(source)).isDirectory() ? await this.folderFiles(source) : new Map(readZip(await readFile(source), PACK_LIMIT).map(entry => [entry.name.replace(/\\/g, '/'), entry.data]));
    const manifestPath = files.has('pet.json') ? 'pet.json' : [...files.keys()].filter(path => /^[^/]+\/pet\.json$/.test(path)).sort()[0];
    if (!manifestPath) throw new Error('宠物包里没有 pet.json。');
    const parsed = parsePetManifest(files.get(manifestPath)!.toString('utf8'));
    if ('error' in parsed) throw new Error(parsed.error);
    const pet = parsed.pet;
    const sheet = files.get(manifestPath.slice(0, -'pet.json'.length) + pet.spritesheetPath);
    if (!sheet) throw new Error(`宠物包里没有 pet.json 指向的 ${pet.spritesheetPath}。`);
    const layout = checkSheet(sheet, sheet.length);
    const builtIn = await Promise.all((await folders(this.builtInPets)).map(folder => this.readPet(join(this.builtInPets, folder)).then(item => item.manifest.id, () => '')));
    if (builtIn.includes(pet.id)) throw new Error(`「${pet.id}」是内置宠物，不用再安装。`);
    const target = join(this.petsFolder, pet.id.toLowerCase());
    const staging = join(this.petsFolder, `.installing-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, 'pet.json'), files.get(manifestPath)!);
      await writeFile(join(staging, pet.spritesheetPath), sheet);
      const replaced = await exists(target);
      if (replaced) await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      return { id: pet.id, displayName: pet.displayName, version: layout.version, replaced };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private summary(pet: PetOnDisk, builtIn: boolean): PetSummary {
    return { id: pet.manifest.id, displayName: pet.manifest.displayName, description: pet.manifest.description, builtIn, version: pet.layout.version, notice: pet.notice };
  }

  private async readTheme(folder: string): Promise<ThemeDefinition> {
    const root = join(this.themesFolder, folder);
    const files = await readdir(root).catch(() => [] as string[]);
    if (!files.includes('theme.json')) throw new Error('文件夹里没有 theme.json。');
    const parsed = parseThemePack(await readFile(join(root, 'theme.json'), 'utf8'), { folder, files });
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.theme;
  }

  private async readPet(folder: string): Promise<PetOnDisk> {
    const raw = await readFile(join(folder, 'pet.json'), 'utf8').catch(() => { throw new Error('文件夹里没有 pet.json。'); });
    const parsed = parsePetManifest(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    const sheet = join(folder, parsed.pet.spritesheetPath);
    const size = await stat(sheet).then(value => value.size, () => { throw new Error(`找不到 pet.json 指向的 ${parsed.pet.spritesheetPath}。`); });
    return { manifest: parsed.pet, layout: checkSheet(await header(sheet), size), folder, notice: await exists(join(folder, 'NOTICE.md')) };
  }

  private async findPet(id: string): Promise<PetOnDisk> {
    for (const root of [this.builtInPets, this.petsFolder]) {
      for (const folder of await folders(root)) {
        const pet = await this.readPet(join(root, folder)).catch(() => null);
        if (pet?.manifest.id === id) return pet;
      }
    }
    throw new Error(`找不到桌宠「${id}」。`);
  }

  /** The files of a pack folder and of the folders one level inside it. */
  private async folderFiles(root: string): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>(); let total = 0;
    const walk = async (folder: string, depth: number): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && depth < 1) await walk(path, depth + 1);
        else if (entry.isFile()) {
          total += (await stat(path)).size;
          if (total > PACK_LIMIT || files.size >= 64) throw new Error('这个文件夹太大，不像是一个宠物包。');
          files.set(relative(root, path).replace(/\\/g, '/'), await readFile(path));
        }
      }
    };
    await walk(root, 0);
    return files;
  }
}
