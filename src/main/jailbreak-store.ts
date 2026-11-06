import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleJailbreak, normalizeJailbreakPack, type AssembledJailbreak, type JailbreakChoice, type JailbreakPack, type JailbreakPackSummary, type JailbreakVariables } from '../shared/jailbreak.ts';

const BUILT_IN: Array<{ id: string; file: string }> = [
  { id: 'builtin-normal', file: '破限-普通.json' },
  { id: 'builtin-strict', file: '破限-严格.json' },
];

/**
 * 破限 packs: the two that ship with the application, plus any the user imported
 * from a SillyTavern preset. Imported packs are written only to the data folder,
 * never into the application or the repository.
 *
 * A user pack whose id matches a built-in one replaces it.
 */
export class JailbreakStore {
  constructor(private readonly dataDir: string, private readonly resourceRoot: string) {}

  private get folder(): string { return join(this.dataDir, 'jailbreak-packs'); }

  private readBuiltIn(id: string): JailbreakPack | undefined {
    const entry = BUILT_IN.find(item => item.id === id);
    if (!entry) return undefined;
    const path = join(this.resourceRoot, 'prompts', entry.file);
    if (!existsSync(path)) return undefined;
    try { return normalizeJailbreakPack(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { return undefined; }
  }

  private readUser(id: string): JailbreakPack | undefined {
    const path = join(this.folder, `${id}.json`);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !existsSync(path)) return undefined;
    try { return normalizeJailbreakPack(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { return undefined; }
  }

  read(id: string): JailbreakPack | undefined {
    // A user pack of the same id is the edited version of a built-in one.
    return this.readUser(id) ?? this.readBuiltIn(id);
  }

  list(): JailbreakPackSummary[] {
    const summaries = new Map<string, JailbreakPackSummary>();
    for (const entry of BUILT_IN) {
      const pack = this.readBuiltIn(entry.id);
      if (pack) summaries.set(entry.id, { id: pack.id, name: pack.name, builtIn: true, entries: pack.entries.length });
    }
    if (existsSync(this.folder)) {
      for (const file of readdirSync(this.folder)) {
        if (!file.toLowerCase().endsWith('.json')) continue;
        const id = file.slice(0, -5);
        const pack = this.readUser(id);
        if (!pack) continue;
        const builtIn = BUILT_IN.some(item => item.id === id);
        summaries.set(id, { id: pack.id, name: pack.name, builtIn, entries: pack.entries.length });
      }
    }
    return [...summaries.values()];
  }

  save(pack: JailbreakPack): JailbreakPackSummary {
    const normalized = normalizeJailbreakPack(pack);
    mkdirSync(this.folder, { recursive: true });
    writeFileSync(join(this.folder, `${normalized.id}.json`), `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const builtIn = BUILT_IN.some(item => item.id === normalized.id);
    return { id: normalized.id, name: normalized.name, builtIn, entries: normalized.entries.length };
  }

  remove(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('破限套的标识不合法。');
    const path = join(this.folder, `${id}.json`);
    if (existsSync(path)) rmSync(path);
    else if (BUILT_IN.some(item => item.id === id)) throw new Error('内置破限套不能删除，只能改。');
  }

  /** The pack a task or card chose, ready to send. Missing packs turn the toggle off rather than failing the run. */
  resolve(choice: JailbreakChoice | undefined, variables: JailbreakVariables): AssembledJailbreak | undefined {
    if (!choice?.pack) return undefined;
    return assembleJailbreak(this.read(choice.pack), variables);
  }
}
