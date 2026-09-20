import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KICKOFF } from '../../shared/card-studio/markers.ts';

/**
 * 提示词覆盖: developer-mode edits of the card studio's built-in prompts, kept in the data folder under
 * prompt-overrides/<original relative path> so they survive updates. An override wins over the shipped default; the
 * default's fingerprint at save time tells when a newer version changed the text the override was based on.
 */
import type { PromptGroup, PromptOverrideDetail, PromptOverrideItem } from '../../shared/card-studio/types.ts';
export type { PromptGroup, PromptOverrideDetail, PromptOverrideItem };

const KICKOFF_LINES: Record<string, string> = { 'kickoff/scratch': KICKOFF.scratch, 'kickoff/refine': KICKOFF.refine };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function describe(id: string): { label: string; group: PromptGroup } {
  if (id === 'kickoff/scratch') return { label: '开场话 · 从零开始制卡', group: 'kickoff' };
  if (id === 'kickoff/refine') return { label: '开场话 · 完善优化卡', group: 'kickoff' };
  const name = id.slice('prompts/'.length, -'.md'.length);
  if (name === '通用规则') return { label: '通用规则', group: 'rules' };
  return { label: name.replace('-', ' · '), group: name.endsWith('-通用') ? 'board' : 'section' };
}

export class PromptOverrides {
  private readonly root: string;
  constructor(dataDir: string, private readonly resourceRoot: string) { this.root = join(dataDir, 'prompt-overrides'); }

  /** Every editable id: each prompts/*.md the app ships, and the two kickoff lines. Nothing else can be written. */
  async ids(): Promise<string[]> {
    const files = (await readdir(join(this.resourceRoot, 'prompts')).catch(() => [] as string[])).filter(name => name.endsWith('.md')).sort();
    return [...files.map(name => `prompts/${name}`), ...Object.keys(KICKOFF_LINES)];
  }

  async list(): Promise<PromptOverrideItem[]> {
    return Promise.all((await this.ids()).map(async id => { const { text: _text, defaultText: _default, ...item } = await this.read(id); return item; }));
  }

  async read(id: string): Promise<PromptOverrideDetail> {
    await this.known(id);
    const defaultText = await this.defaultText(id);
    const override = await this.override(id);
    const saved = (await this.index())[id];
    return { id, ...describe(id), text: override ?? defaultText, defaultText, overridden: override !== undefined, stale: override !== undefined && !!saved && saved.defaultSha256 !== hash(defaultText) };
  }

  /** What a new conversation gets for this prompt: the override when there is one, else the shipped default. */
  async effective(id: string): Promise<string> {
    if ((await this.ids()).includes(id)) {
      const override = await this.override(id);
      if (override !== undefined) return override.trim();
    }
    return this.defaultText(id);
  }

  async save(id: string, text: string): Promise<PromptOverrideDetail> {
    await this.known(id);
    if (typeof text !== 'string' || !text.trim()) throw new Error('提示词不能为空；要回到默认版本请用「恢复默认」。');
    if (text.length > 400_000) throw new Error('提示词太长了。');
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text.replace(/\r\n/g, '\n'), 'utf8');
    const index = await this.index();
    index[id] = { defaultSha256: hash(await this.defaultText(id)), savedAt: new Date().toISOString() };
    await this.writeIndex(index);
    return this.read(id);
  }

  async restore(id: string): Promise<PromptOverrideDetail> {
    await this.known(id);
    await rm(this.file(id), { force: true });
    const index = await this.index();
    delete index[id];
    await this.writeIndex(index);
    return this.read(id);
  }

  private async known(id: string): Promise<void> {
    if (typeof id !== 'string' || !(await this.ids()).includes(id)) throw new Error('这一项不能修改：开发者模式只能修改制卡的内置提示词和开场话。');
  }

  private async defaultText(id: string): Promise<string> {
    if (id in KICKOFF_LINES) return KICKOFF_LINES[id];
    try { return (await readFile(join(this.resourceRoot, ...id.split('/')), 'utf8')).replace(/^\uFEFF/, '').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`内置提示词缺失：${id}。请重新安装 Cardwright。`);
      throw error;
    }
  }

  private file(id: string): string {
    return id.startsWith('kickoff/') ? join(this.root, 'kickoff', `${id.slice('kickoff/'.length)}.txt`) : join(this.root, ...id.split('/'));
  }

  private override(id: string): Promise<string | undefined> {
    return readFile(this.file(id), 'utf8').then(text => text.replace(/^\uFEFF/, ''), () => undefined);
  }

  private async index(): Promise<Record<string, { defaultSha256: string; savedAt: string }>> {
    try { return JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')); }
    catch { return {}; }
  }

  private async writeIndex(index: Record<string, { defaultSha256: string; savedAt: string }>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, 'index.json');
    await writeFile(`${path}.tmp`, JSON.stringify(index, null, 2) + '\n', 'utf8');
    await rename(`${path}.tmp`, path);
  }
}
