/**
 * The assembly bench's paperwork: the card's metadata (§3.6 step 3), a fingerprint of every piece at each export, and
 * the report that says what changed since the last export and how to put it into SillyTavern. The replacement steps
 * are the ones verified in a real SillyTavern 1.19.0 with 酒馆助手 4.9.5 (knowledge 10, §6).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CARD_ENVELOPE_FILE, readProject, type ProjectComponents } from './components.ts';
import type { CardMeta } from '../../shared/card-studio/types.ts';

export type { CardMeta };
export type PieceKind = 'lore' | 'regex' | 'script' | 'greeting' | 'meta';
export interface PieceFingerprint { kind: PieceKind; key: string; name: string; hash: string }
export interface ExportDiff { added: PieceFingerprint[]; changed: PieceFingerprint[]; removed: PieceFingerprint[] }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export async function readCardMeta(root: string): Promise<CardMeta> {
  const data = record(record((await readProject(root)).envelope).data);
  return {
    name: text(data.name), creator: text(data.creator), version: text(data.character_version), notes: text(data.creator_notes),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
  };
}

/** Writes the metadata into the envelope only; the component files are never touched. */
export async function writeCardMeta(root: string, meta: CardMeta): Promise<CardMeta> {
  const name = meta.name.trim();
  if (!name) throw new Error('卡名不能为空。');
  if ([...name].length > 60) throw new Error('卡名最多 60 个字。');
  const clean: CardMeta = {
    name, creator: meta.creator.trim(), version: meta.version.trim(), notes: meta.notes.trim(),
    tags: [...new Set(meta.tags.map(tag => String(tag).trim()).filter(Boolean))],
  };
  const path = join(root, CARD_ENVELOPE_FILE);
  const file = record(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')));
  const envelope = record(file.envelope);
  const data = record(envelope.data);
  Object.assign(data, { name: clean.name, creator: clean.creator, character_version: clean.version, creator_notes: clean.notes, tags: clean.tags });
  envelope.data = data;
  file.envelope = envelope;
  file.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return clean;
}

/** One fingerprint per piece as SillyTavern would see it: world book entries by uid, regex and scripts by id. */
export function fingerprintProject(project: ProjectComponents): PieceFingerprint[] {
  const pieces: PieceFingerprint[] = [{ kind: 'meta', key: 'meta', name: '卡片信息', hash: hash(project.envelope) }];
  for (const entry of project.lore) pieces.push({ kind: 'lore', key: String(entry.uid), name: text(entry.params.comment) || `uid ${entry.uid}`, hash: hash([entry.params, entry.content]) });
  for (const item of project.regex) pieces.push({ kind: 'regex', key: text(item.params.id) || item.name, name: text(item.params.scriptName) || item.name, hash: hash([item.params, item.body]) });
  for (const item of project.scripts) pieces.push({ kind: 'script', key: text(item.params.id) || item.name, name: text(item.params.name) || item.name, hash: hash([item.params, item.body]) });
  let alternate = 0; let group = 0;
  for (const greeting of project.greetings) {
    const name = greeting.kind === 'first' ? '开场白' : greeting.kind === 'alternate' ? `备选开场 ${++alternate}` : `群聊开场 ${++group}`;
    pieces.push({ kind: 'greeting', key: greeting.path, name, hash: hash(greeting.text) });
  }
  return pieces;
}

export function diffFingerprints(previous: PieceFingerprint[] | null, current: PieceFingerprint[]): ExportDiff | null {
  if (!previous) return null;
  const id = (item: PieceFingerprint) => `${item.kind}:${item.key}`;
  const before = new Map(previous.map(item => [id(item), item]));
  const after = new Map(current.map(item => [id(item), item]));
  return {
    added: current.filter(item => !before.has(id(item))),
    changed: current.filter(item => before.has(id(item)) && before.get(id(item))!.hash !== item.hash),
    removed: previous.filter(item => !after.has(id(item))),
  };
}

/** The name SillyTavern gives the card's world book and binds the character to; an unnamed book becomes "<name>'s Lorebook". */
export function bookName(project: ProjectComponents): string {
  return project.book.name.trim() || `${text(record(project.envelope.data).name).trim() || '角色卡'}'s Lorebook`;
}

export function piecesFolderName(version: string, date: string): string {
  return ['单件', version, date].filter(Boolean).join('-');
}

const KIND_LABEL: Record<PieceKind, string> = { lore: '世界书', regex: '正则', script: '酒馆助手脚本', greeting: '开场白', meta: '卡片信息' };

/** The report written next to each whole-card export. */
export function exportReport(input: { cardName: string; file: string; bookName: string; diff: ExportDiff | null; piecesFolder: string | null }): string {
  const { diff } = input;
  const lines = [`# 导出报告 · ${input.cardName}`, '', `- 文件：\`${input.file}\``, ''];
  lines.push('## 改动', '');
  if (!diff) lines.push('第一次导出，没有可以比较的上一次。', '');
  else if (!diff.added.length && !diff.changed.length && !diff.removed.length) lines.push('和上次导出相比没有改动。', '');
  else {
    for (const [label, items] of [['新增', diff.added], ['改动', diff.changed], ['删除', diff.removed]] as const) {
      for (const item of items) lines.push(`- ${label} · ${KIND_LABEL[item.kind]}：${item.name}`);
    }
    lines.push('');
  }
  lines.push('## 怎样放进酒馆', '');
  if (!diff) {
    lines.push('### 第一次导入', '',
      '1. 在酒馆里导入这个文件；问到标签时选「全部导入」。',
      '2. 第一次打开这个角色时，酒馆会接连问三件事（顺序不固定），都要同意：',
      '   - 「此角色含有内置正则，你想要启用它们吗？」→ 确定。否则卡里的正则都不生效。',
      `   - 「This character has an embedded World/Lorebook. Would you like to import it now?」→ 是。世界书以「${input.bookName}」为名导入并绑定到角色。`,
      '   - 「角色卡中包含酒馆助手可用的嵌入式脚本，是否现在就启用它们?」→ 确认。否则 MVU 和变量结构不会运行。',
      '3. 每个问题只问一次。选错了也能补：正则在「扩展 → 正则」里启用，世界书用角色面板「更多… → 导入卡内世界书」，脚本在「酒馆助手 → 脚本库 → 角色脚本」里启用。', '');
  } else {
    lines.push('### 更新已经导入的卡（推荐）', '',
      '1. 在酒馆里打开这个角色，角色面板「更多… → 替换/更新 → 用文件替换」，选这个文件。',
      '2. 还是同一个角色，聊天记录保留；卡里的正则和酒馆助手脚本随卡一起替换。',
      `3. 装了酒馆助手时，绑定的世界书「${input.bookName}」会一起更新；没装的话，再点「更多… → 导入卡内世界书」，确认覆盖。`,
      '',
      '- 不要再次导入整卡：酒馆会另外生成一个角色（名字后面加 1、2），聊天不会跟过去。', '');
    const changed = [...diff.added, ...diff.changed];
    if (changed.some(item => item.kind === 'lore' || item.kind === 'regex' || item.kind === 'script')) {
      lines.push(`### 只换单件时${input.piecesFolder ? `（单件在 \`${input.piecesFolder}/\`）` : '（先在拼装台点「导出全部单件」）'}`, '');
      if (changed.some(item => item.kind === 'lore')) lines.push(`- 世界书：导入「${input.bookName}.json」，确认覆盖后，在角色面板把世界书重新绑定到「${input.bookName}」——酒馆覆盖同名世界书时会解除原来的绑定。`);
      for (const item of changed.filter(piece => piece.kind === 'regex')) lines.push(`- 正则「${item.name}」：先在「扩展 → 正则 → 角色正则」里删掉旧的，再导入新文件并选「角色」；导入总是新增一条，不删就会有两条同时生效。`);
      for (const item of changed.filter(piece => piece.kind === 'script')) lines.push(`- 酒馆助手脚本「${item.name}」：先在「酒馆助手 → 脚本库 → 角色脚本」里删掉旧的，再导入；导入的脚本默认关闭，记得打开。`);
      lines.push('');
    }
  }
  lines.push('以上步骤按 SillyTavern 1.19.0 + 酒馆助手 4.9.5 实测（2026-09-18）。其他版本以酒馆里的实际提示为准。');
  return `${lines.join('\n')}\n`;
}
