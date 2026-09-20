import { BrowserWindow, WebContentsView, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { browserDecision, isLocal, normalizeUrl, originOf, submitsForm, typingDecision } from '../core/browser-permissions.ts';
import type { BrowserState, BrowserTab } from '../shared/types.ts';

/** Its own partition, so what the browser signs into stays apart from the rest of Cardwright (§6.4). */
const PARTITION = 'persist:cardwright-browser';
const MAX_TABS = 6;
const MAX_TEXT = 40_000;
const MAX_ELEMENTS = 200;

interface Tab { id: string; view: WebContentsView; title: string; url: string; loading: boolean; console: string[]; requests: Array<{ url: string; status?: number; method: string }>;
  /** Origins the user allowed just for this tab; they go when the tab does. */ once: Set<string>;
  /** The last page that actually loaded, so a refused link leaves the user where they were. */ lastGood: string }

/** Reads the page the way the agent needs it: interactive elements with a ref, and the visible text. */
const READ_SCRIPT = `(() => {
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const nodes = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length > 0);
  window.__cardwrightRefs = new Map();
  const items = nodes.slice(0, ${MAX_ELEMENTS}).map((node, index) => {
    const ref = 'e' + (index + 1);
    window.__cardwrightRefs.set(ref, node);
    const label = (node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.value || node.innerText || node.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    return { ref, role: node.getAttribute('role') || node.tagName.toLowerCase(), name: label, type: node.getAttribute('type') || undefined, autocomplete: node.getAttribute('autocomplete') || undefined, fieldName: node.getAttribute('name') || undefined, id: node.id || undefined, inForm: !!node.form };
  });
  return { title: document.title, url: location.href, items };
})()`;

export class BrowserHost {
  private tabs: Tab[] = [];
  private activeId = '';
  private bounds: { x: number; y: number; width: number; height: number } | null = null;
  private pending: { origin: string; url: string; tabId?: string } | null = null;
  /** The user took over this tab; the agent's tools wait until they give it back. */
  private takenOver = new Set<string>();
  private readonly partition = session.fromPartition(PARTITION);
  private wired = false;

  constructor(private readonly window: BrowserWindow, private readonly options: { allowed: () => string[]; allow: (origin: string) => void; changed: () => void }) {}

  /**
   * Session-wide rules, set once: `webRequest` and the download and permission handlers belong to the session, not to
   * a view, so registering them per tab would leave only the newest tab's rules in place.
   */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    // Downloads are the user's business, not the agent's (§6.4).
    this.partition.on('will-download', (event, item) => {
      event.preventDefault();
      this.note(item.getURL(), '[download blocked] ');
    });
    this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // A page the user allowed must not walk the agent onto another site: every top-level load goes through the gate,
    // redirects included, which `will-navigate` alone would miss.
    this.partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details, callback) => {
      const tab = this.byContents(details.webContentsId);
      const decision = browserDecision(details.url, [...this.options.allowed(), ...(tab?.once ?? [])]);
      if (decision.allow) { callback({}); return; }
      if (decision.reason === 'ask') { this.pending = { origin: decision.origin, url: details.url, tabId: tab?.id }; }
      if (tab) tab.console.push(`[blocked] ${details.url.slice(0, 300)}`);
      this.options.changed();
      callback({ cancel: true });
    });
    this.partition.webRequest.onCompleted(details => {
      const tab = this.byContents(details.webContentsId);
      if (!tab) return;
      tab.requests.push({ url: details.url.slice(0, 300), status: details.statusCode, method: details.method });
      if (tab.requests.length > 200) tab.requests.shift();
    });
  }

  private byContents(id?: number): Tab | undefined {
    return id === undefined ? undefined : this.tabs.find(tab => !tab.view.webContents.isDestroyed() && tab.view.webContents.id === id);
  }

  private note(url: string, prefix: string): void {
    const tab = this.tabs.find(item => item.id === this.activeId);
    if (!tab) return;
    tab.console.push(`${prefix}${url.slice(0, 300)}`);
    this.options.changed();
  }

  state(): BrowserState {
    return {
      tabs: this.tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, loading: tab.loading, takenOver: this.takenOver.has(tab.id) } satisfies BrowserTab)),
      activeId: this.activeId,
      pending: this.pending ? { origin: this.pending.origin, url: this.pending.url } : undefined,
      visible: !!this.bounds,
    };
  }

  /** The renderer says where the browser area is; `null` hides the page (the panel closed or another tab is up). */
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.bounds = rect && rect.width > 40 && rect.height > 40 ? rect : null;
    for (const tab of this.tabs) {
      const active = tab.id === this.activeId && this.bounds;
      if (tab.view.webContents.isDestroyed()) continue;
      tab.view.setVisible(!!active);
      if (active) tab.view.setBounds({ x: Math.round(this.bounds!.x), y: Math.round(this.bounds!.y), width: Math.round(this.bounds!.width), height: Math.round(this.bounds!.height) });
    }
    this.options.changed();
  }

  select(tabId: string): void {
    if (!this.tabs.some(tab => tab.id === tabId)) return;
    this.activeId = tabId;
    this.setBounds(this.bounds);
  }

  takeOver(tabId: string, taken: boolean): void {
    if (taken) this.takenOver.add(tabId); else this.takenOver.delete(tabId);
    this.options.changed();
  }

  /** Answers the pending site question; `always` remembers the origin. */
  decide(answer: 'once' | 'always' | 'deny'): void {
    const request = this.pending;
    this.pending = null;
    if (!request || answer === 'deny') { this.options.changed(); return; }
    if (answer === 'always') this.options.allow(request.origin);
    void this.open(request.url, { tabId: request.tabId, allowOnce: answer === 'once' });
  }

  async open(input: string, options: { tabId?: string; allowOnce?: boolean } = {}): Promise<{ tabId: string } | { needsPermission: string }> {
    const url = normalizeUrl(input);
    if (!url) throw new Error('只能打开 http 或 https 网页。');
    const existing = options.tabId ? this.tabs.find(item => item.id === options.tabId) : undefined;
    const decision = browserDecision(url, [...this.options.allowed(), ...(options.allowOnce ? [originOf(url)] : []), ...(existing?.once ?? [])]);
    if (!decision.allow && decision.reason === 'blocked') throw new Error(decision.message);
    if (!decision.allow) { this.pending = { origin: decision.origin, url, tabId: options.tabId }; this.options.changed(); return { needsPermission: decision.origin }; }
    const tab = existing || this.newTab();
    // 允许一次 covers this visit: the origin stays open for this tab, with its redirects, until the tab is closed.
    if (options.allowOnce) tab.once.add(originOf(url));
    this.activeId = tab.id;
    tab.loading = true; tab.url = url;
    this.options.changed();
    await tab.view.webContents.loadURL(url).catch(error => { tab.loading = false; throw new Error(`打不开这个网页：${error instanceof Error ? error.message : String(error)}`); });
    this.setBounds(this.bounds);
    return { tabId: tab.id };
  }

  close(tabId: string): void {
    const index = this.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    this.detach(tab);
    this.takenOver.delete(tabId);
    this.activeId = this.tabs[Math.max(0, index - 1)]?.id ?? '';
    this.setBounds(this.bounds);
  }

  /**
   * Lets go of one page. This also runs while the window is being destroyed, when touching the window or the view
   * throws: an exception here left the application unable to quit, so every step stands on its own.
   */
  private detach(tab: Tab): void {
    try { if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view); } catch { /* The window went first. */ }
    try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch { /* Already gone. */ }
  }

  /** Called as the window closes; after this the host holds no pages. */
  closeAll(): void {
    const tabs = [...this.tabs];
    this.tabs = []; this.takenOver.clear(); this.activeId = ''; this.pending = null; this.bounds = null;
    for (const tab of tabs) this.detach(tab);
  }

  private tab(tabId?: string): Tab {
    const tab = tabId ? this.tabs.find(item => item.id === tabId) : this.tabs.find(item => item.id === this.activeId);
    if (!tab) throw new Error('浏览器里没有这个标签页，先用 browser_open 打开一个网页。');
    if (this.takenOver.has(tab.id)) throw new Error('用户接手了这个标签页。等他们点【交还】之后再操作。');
    return tab;
  }

  private newTab(): Tab {
    if (this.tabs.length >= MAX_TABS) this.close(this.tabs[0].id);
    this.wire();
    const view = new WebContentsView({ webPreferences: { session: this.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const tab: Tab = { id: randomUUID(), view, title: '', url: '', loading: false, console: [], requests: [], once: new Set(), lastGood: '' };
    view.setBorderRadius?.(0);
    view.webContents.setWindowOpenHandler(({ url }) => { void this.open(url, { }).catch(() => undefined); return { action: 'deny' }; });
    view.webContents.on('page-title-updated', (_event, title) => { tab.title = title; this.options.changed(); });
    view.webContents.on('did-start-loading', () => { tab.loading = true; this.options.changed(); });
    view.webContents.on('did-stop-loading', () => { tab.loading = false; this.options.changed(); });
    view.webContents.on('did-navigate', (_event, url) => { tab.url = url; tab.lastGood = url; this.options.changed(); });
    // A refused page is not where the user is: put the last good one back rather than leaving an error page.
    view.webContents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.loading = false; tab.url = tab.lastGood;
      if (tab.lastGood && tab.lastGood !== url && !view.webContents.isDestroyed()) void view.webContents.loadURL(tab.lastGood).catch(() => undefined);
      this.options.changed();
    });
    view.webContents.on('console-message', (_event, _level, message) => { tab.console.push(String(message).slice(0, 500)); if (tab.console.length > 200) tab.console.shift(); });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.tabs.push(tab);
    return tab;
  }

  private async run<T>(tabId: string | undefined, script: string): Promise<T> {
    const tab = this.tab(tabId);
    return await tab.view.webContents.executeJavaScript(script, true) as T;
  }

  async readText(tabId?: string): Promise<string> {
    const text = await this.run<string>(tabId, '(document.body && document.body.innerText) || ""');
    return text.slice(0, MAX_TEXT);
  }

  async structure(tabId?: string): Promise<{ title: string; url: string; items: Array<Record<string, unknown>> }> {
    return this.run(tabId, READ_SCRIPT);
  }

  async find(text: string, tabId?: string): Promise<Array<Record<string, unknown>>> {
    const page = await this.structure(tabId);
    const needle = text.toLocaleLowerCase();
    return page.items.filter(item => String(item.name ?? '').toLocaleLowerCase().includes(needle));
  }

  async click(ref: string, tabId?: string): Promise<string> {
    const page = await this.structure(tabId);
    if (!page.items.some(item => item.ref === ref)) throw new Error(`页面上没有 ${ref}，先用 browser_structure 看一遍。`);
    const target = page.items.find(item => item.ref === ref)!;
    await this.run(tabId, `(() => { const node = window.__cardwrightRefs.get(${JSON.stringify(ref)}); if (!node) return false; node.scrollIntoView({ block: 'center' }); node.click(); return true; })()`);
    return `已点击 ${ref}（${String(target.name ?? target.role ?? '')}）。`;
  }

  async type(ref: string, text: string, tabId?: string): Promise<string> {
    const page = await this.structure(tabId);
    const target = page.items.find(item => item.ref === ref);
    if (!target) throw new Error(`页面上没有 ${ref}，先用 browser_structure 看一遍。`);
    const decision = typingDecision({ type: String(target.type ?? ''), autocomplete: String(target.autocomplete ?? ''), name: String(target.fieldName ?? ''), id: String(target.id ?? ''), label: String(target.name ?? '') });
    if (!decision.allow) throw new Error(decision.message ?? '这个输入框不能代填。');
    await this.run(tabId, `(() => { const node = window.__cardwrightRefs.get(${JSON.stringify(ref)}); if (!node) return false; node.focus(); if ('value' in node) { node.value = ${JSON.stringify(text)}; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); } else { node.textContent = ${JSON.stringify(text)}; } return true; })()`);
    return `已在 ${ref} 输入 ${text.length} 个字符。`;
  }

  /** Whether clicking this element would hand a form to the site; the app asks the user before that happens. */
  async submits(ref: string, tabId?: string): Promise<boolean> {
    const page = await this.structure(tabId);
    const target = page.items.find(item => item.ref === ref);
    return !!target && submitsForm({ role: String(target.role ?? ''), type: String(target.type ?? ''), inForm: !!target.inForm });
  }

  async screenshot(tabId?: string): Promise<{ data: string; width: number; height: number }> {
    const tab = this.tab(tabId);
    const image = await tab.view.webContents.capturePage();
    const size = image.getSize();
    return { data: image.toPNG().toString('base64'), width: size.width, height: size.height };
  }

  consoleLines(tabId?: string): string[] { return [...this.tab(tabId).console].slice(-80); }
  networkLines(tabId?: string): Array<{ url: string; status?: number; method: string }> { return [...this.tab(tabId).requests].slice(-60); }
  /** The origin of the page the agent is on, for the permission notes in the panel. */
  currentOrigin(tabId?: string): string { const tab = this.tabs.find(item => item.id === (tabId ?? this.activeId)); return tab ? originOf(tab.url) : ''; }
  isLocalPage(tabId?: string): boolean { const tab = this.tabs.find(item => item.id === (tabId ?? this.activeId)); return !!tab && isLocal(tab.url); }
}
