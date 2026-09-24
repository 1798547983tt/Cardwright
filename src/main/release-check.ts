import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 新版本提醒 (1.1, handoff §5.7a): once a day the version number of the latest GitHub release, and nothing else. The
 * check sends only the GET itself, never downloads anything, and a reminder does no more than open the release page.
 */
export const RELEASES_LATEST_URL = 'https://api.github.com/repos/1798547983tt/Cardwright/releases/latest';
/** A reminder leads only to the project's own release pages; when the reply names none of them, to this one. */
const RELEASE_PAGES = 'https://github.com/1798547983tt/Cardwright/releases/';
export const RELEASES_PAGE = `${RELEASE_PAGES}latest`;
const FILE = 'release-check.json';
const DAY = 24 * 60 * 60 * 1000;

const VERSION = /^[vV]?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseVersion(value: unknown): { core: number[]; pre?: string } | undefined {
  const match = typeof value === 'string' && value.length <= 64 ? VERSION.exec(value) : null;
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] } : undefined;
}
/** `major.minor.patch[-pre]` without the leading `v` or build metadata; undefined when it is no version at all. */
function version(value: unknown): string | undefined {
  const parsed = parseVersion(value);
  return parsed && `${parsed.core.join('.')}${parsed.pre ? `-${parsed.pre}` : ''}`;
}
/** Semver's order for pre-release parts: numbers by value and before words, words as text, a shorter list first. */
function comparePre(a: string, b: string): number {
  const x = a.split('.'), y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x[i]), otherNumeric = /^\d+$/.test(y[i]);
    if (numeric && otherNumeric) { if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]); }
    else if (numeric !== otherNumeric) return numeric ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
/** True when `candidate` is a later `major.minor.patch` than `current`; a pre-release comes before its release, and what is no version is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (a.pre === undefined || b.pre === undefined) return a.pre === undefined && b.pre !== undefined;
  return comparePre(a.pre, b.pre) > 0;
}
function releasePage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try { const href = new URL(value).href; return href.startsWith(RELEASE_PAGES) ? href : undefined; } catch { return undefined; }
}

/** release-check.json: the newest release seen, its page, when the check last succeeded and the last version announced. */
interface ReleaseRecord { latest?: string; url?: string; checkedAt?: string; notified?: string }
/**
 * What the settings page and the top bar's pill show: this build, whether the latest release is newer than it, when the
 * check last succeeded, and the latest release with its page only while it is newer.
 */
export interface ReleaseCheckView { current: string; newer: boolean; latest?: string; url?: string; checkedAt?: string }
export interface ReleaseCheckOptions {
  /** The data folder; the check keeps release-check.json there. */
  dataDir: string;
  /** This build, `app.getVersion()`. */
  currentVersion: string;
  /** Electron's `net.fetch` in the app. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The GitHub address unless a test points the check at a server on this machine. */
  url?: string;
  /** The `releaseCheck` preference, read at every check. */
  enabled: () => boolean;
  /** Shows the reminder; true when it was shown, so one the system held back comes again at the next check. */
  notify: (version: string, url: string) => boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

export class ReleaseCheck {
  private logged = false;
  private running?: Promise<void>;
  constructor(private readonly options: ReleaseCheckOptions) {}

  /** One check. A failure is logged the first time and is silent after that; it never throws. */
  check(): Promise<void> {
    this.running ??= this.run().catch(error => {
      if (this.logged) return;
      this.logged = true;
      (this.options.log ?? console.warn)(`[release-check] 新版本检查失败 / The new-version check failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async read(): Promise<ReleaseCheckView> {
    const { latest, url, checkedAt } = await this.record(), current = this.options.currentVersion;
    const release = latest && url && isNewerVersion(latest, current) ? { latest, url } : undefined;
    return { current, newer: !!release, ...(checkedAt ? { checkedAt } : {}), ...release };
  }

  /** The first check `firstDelay` after startup, then one every `interval` while the app runs; returns what stops them. */
  start(firstDelay = 60_000, interval = DAY): () => void {
    let repeat: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { void this.check(); repeat = setInterval(() => void this.check(), interval); }, firstDelay);
    return () => { clearTimeout(first); clearInterval(repeat); };
  }

  private get file(): string { return join(this.options.dataDir, FILE); }

  private async run(): Promise<void> {
    if (!this.options.enabled()) return;
    const { currentVersion } = this.options;
    const response = await this.options.fetch(this.options.url ?? RELEASES_LATEST_URL, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Cardwright/${currentVersion}` },
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
    const reply: unknown = await response.json();
    const release = typeof reply === 'object' && reply !== null ? reply as Record<string, unknown> : {};
    // Only these two fields are read; everything else in the reply, the download links included, is ignored.
    const latest = version(release.tag_name);
    if (!latest) throw new Error('The latest release carries no version number.');
    const url = releasePage(release.html_url) ?? RELEASES_PAGE;
    const record: ReleaseRecord = { ...await this.record(), latest, url, checkedAt: (this.options.now?.() ?? new Date()).toISOString() };
    const due = isNewerVersion(latest, currentVersion) && (!record.notified || isNewerVersion(latest, record.notified));
    if (due && this.options.notify(latest, url)) record.notified = latest;
    await writeFile(this.file, JSON.stringify(record, null, 2));
  }

  private async record(): Promise<ReleaseRecord> {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); } catch { return {}; }
    if (typeof saved !== 'object' || saved === null) return {};
    const value = saved as Record<string, unknown>, record: ReleaseRecord = {};
    const latest = version(value.latest), url = releasePage(value.url), notified = version(value.notified);
    if (latest) record.latest = latest;
    if (url) record.url = url;
    if (notified) record.notified = notified;
    if (typeof value.checkedAt === 'string' && value.checkedAt.length <= 40 && !Number.isNaN(Date.parse(value.checkedAt))) record.checkedAt = value.checkedAt;
    return record;
  }
}
