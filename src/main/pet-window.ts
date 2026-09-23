/**
 * 桌宠 (ADR 0018, revised 2026-09-23): like Codex's, the pet floats in a small window of its own above every other one,
 * and stays while Cardwright is minimized or in the tray. The window is transparent, never takes the focus and lets the
 * mouse through wherever nothing is drawn. What it shows and what a click opens are worked out here; the window only
 * draws, and every request it makes is checked to come from it.
 */
import { BrowserWindow, ipcMain, Menu, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { buildPetView, PET_WINDOW, type PetView } from '../shared/pet-view.ts';
import { petPlacement, type PetArea, type PetTarget, type SpriteLayout } from '../shared/pets.ts';
import type { AppearanceSnapshot, AppSnapshot, Preferences } from '../shared/types.ts';

export interface PetHost {
  /** Where the built main, preloads and renderer live. */
  directory: string;
  devUrl?: string;
  snapshot(): AppSnapshot;
  savePreferences(changes: Partial<Preferences>): void;
  appearance(): Promise<AppearanceSnapshot>;
  sprite(id: string): Promise<{ dataUrl: string; layout: SpriteLayout }>;
  systemDark(): boolean;
  /** Brings Cardwright to the front on what the pet reported. */
  open(target: PetTarget): void;
}

const CHANNEL = 'cardwright-pet';
/** A finished result stops being news after a while, so the view is worked out again now and then. */
const TICK_MS = 15_000;
/** Changes come in bursts while a reply streams; the view is worked out at most this often. */
const SETTLE_MS = 200;

export class PetWindow {
  private window?: BrowserWindow;
  private view: PetView | null = null;
  private published = '';
  private appearance?: AppearanceSnapshot;
  private appearanceKey = '';
  private dragFrom?: { x: number; y: number };
  /** The size Windows really gave the window; every move keeps it, since moving a transparent window at a fractional
   *  display scale otherwise grows it by a pixel at a time. */
  private size?: { width: number; height: number };
  private ticker?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private disposed = false;

  constructor(private readonly host: PetHost) {
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const win = this.window;
      return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    };
    const handle = (name: string, fn: (...args: unknown[]) => unknown) => ipcMain.handle(`${CHANNEL}:${name}`, (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted IPC sender.');
      return fn(...args);
    });
    const listen = (name: string, fn: (...args: unknown[]) => void) => ipcMain.on(`${CHANNEL}:${name}`, (event, ...args) => { if (trusted(event)) fn(...args); });
    handle('view', () => this.view);
    handle('sprite', () => this.view ? this.host.sprite(this.view.petId) : null);
    handle('open', () => this.open());
    handle('menu', () => this.menu());
    handle('hide', () => this.host.savePreferences({ petEnabled: false }));
    handle('drag-end', () => this.dragEnd());
    listen('interactive', on => this.interactive(on === true));
    listen('drag-start', () => this.dragStart());
    listen('drag', (dx, dy) => this.drag(dx, dy));
    screen.on('display-removed', () => this.keepOnScreen());
    screen.on('display-metrics-changed', () => this.keepOnScreen());
  }

  /** Called on every change of the app: works the view out again soon, once for a burst. */
  schedule(): void {
    if (this.pending || this.disposed) return;
    this.pending = setTimeout(() => { this.pending = undefined; void this.sync(); }, SETTLE_MS);
  }

  /** Opens, closes or refreshes the window as the app's state and preferences say. Overlapping calls run once more after. */
  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.update().catch(() => undefined).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; void this.sync(); }
    });
    return this.running;
  }

  /** Theme and pet packs may have changed on disk (a pack installed, the folder opened). */
  forgetAppearance(): void {
    this.appearance = undefined;
    this.schedule();
  }

  /** Quitting: the window goes and nothing opens it again. */
  dispose(): void {
    this.disposed = true;
    if (this.pending) clearTimeout(this.pending);
    this.close();
  }

  private async update(): Promise<void> {
    if (this.disposed) return;
    const snapshot = this.host.snapshot();
    const preferences = snapshot.preferences;
    if (preferences.petEnabled !== true) { this.close(); return; }
    const key = `${preferences.theme}|${preferences.petId ?? ''}`;
    if (!this.appearance || key !== this.appearanceKey) { this.appearance = await this.host.appearance(); this.appearanceKey = key; }
    if (this.disposed) return;
    const view = buildPetView({ snapshot, pets: this.appearance.pets, themes: this.appearance.themes, systemDark: this.host.systemDark(), now: new Date() });
    if (!view) { this.close(); return; }
    this.view = view;
    if (!this.window) this.create(preferences.petPosition);
    const text = JSON.stringify(view);
    const win = this.window;
    // Until the page has loaded it asks for the view itself.
    if (win && !win.isDestroyed() && !win.webContents.isLoading() && text !== this.published) {
      this.published = text;
      win.webContents.send(`${CHANNEL}:update`, view);
    }
  }

  private create(saved: { x: number; y: number } | undefined): void {
    const { x, y } = petPlacement(saved, PET_WINDOW, this.screens());
    const win = new BrowserWindow({
      x, y, width: PET_WINDOW.width, height: PET_WINDOW.height, show: false,
      // No Windows resize frame: with it the window is larger than asked and grows a pixel at a time as it moves.
      frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, title: 'Cardwright · 桌宠',
      webPreferences: { preload: join(this.host.directory, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    this.window = win;
    this.published = '';
    // Windows may make a frameless transparent window a few pixels larger than asked: place it by the size it really has.
    const real = win.getBounds();
    this.size = { width: real.width, height: real.height };
    this.keepOnScreen(saved ?? null);
    win.setAlwaysOnTop(true, 'floating');
    // The mouse goes through until it is over the pet or its bubble; the page says when.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.webContents.on('did-finish-load', () => this.schedule());
    win.on('closed', () => { if (this.window === win) { this.window = undefined; this.stopTicking(); } });
    this.ticker = setInterval(() => this.schedule(), TICK_MS);
    const page = this.host.devUrl ? win.loadURL(`${this.host.devUrl}/pet.html`) : win.loadFile(join(this.host.directory, 'renderer', 'pet.html'));
    void page.catch(() => undefined);
  }

  private close(): void {
    this.stopTicking();
    const win = this.window;
    this.window = undefined; this.view = null; this.published = ''; this.dragFrom = undefined; this.size = undefined;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private stopTicking(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private open(): void {
    this.host.open(this.view?.mood.open ?? { kind: 'app' });
  }

  private menu(): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const zh = this.host.snapshot().preferences.language === 'zh';
    Menu.buildFromTemplate([
      { label: zh ? '打开 Cardwright' : 'Open Cardwright', click: () => this.open() },
      { label: zh ? '打招呼' : 'Say hello', click: () => { if (!win.isDestroyed()) win.webContents.send(`${CHANNEL}:poke`); } },
      { type: 'separator' },
      { label: zh ? '收起桌宠' : 'Hide the desk pet', click: () => this.host.savePreferences({ petEnabled: false }) },
    ]).popup({ window: win });
  }

  private interactive(on: boolean): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    if (on) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }

  private dragStart(): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    this.dragFrom = { x, y };
  }

  private drag(dx: unknown, dy: unknown): void {
    const win = this.window; const from = this.dragFrom;
    if (!win || win.isDestroyed() || !from) return;
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 20_000 || Math.abs(dy) > 20_000) return;
    win.setBounds({ x: Math.round(from.x + dx), y: Math.round(from.y + dy), ...this.windowSize(win) });
  }

  /** Where it was let go, pulled back on a screen if need be, is where it comes back next time. */
  private dragEnd(): void {
    this.dragFrom = undefined;
    const spot = this.keepOnScreen();
    if (spot) this.host.savePreferences({ petPosition: spot });
  }

  /** Pulls the window onto a screen: from where it is, from a saved spot, or (null) into the corner. */
  private keepOnScreen(from?: { x: number; y: number } | null): { x: number; y: number } | undefined {
    const win = this.window;
    if (!win || win.isDestroyed()) return undefined;
    const bounds = win.getBounds(); const size = this.windowSize(win);
    const spot = petPlacement(from === null ? undefined : from ?? { x: bounds.x, y: bounds.y }, size, this.screens());
    if (spot.x !== bounds.x || spot.y !== bounds.y || size.width !== bounds.width || size.height !== bounds.height) win.setBounds({ ...spot, ...size });
    return spot;
  }

  private windowSize(win: BrowserWindow): { width: number; height: number } {
    if (!this.size) { const bounds = win.getBounds(); this.size = { width: bounds.width, height: bounds.height }; }
    return this.size;
  }

  private screens(): { primary: PetArea; all: PetArea[] } {
    return { primary: screen.getPrimaryDisplay().workArea, all: screen.getAllDisplays().map(display => display.workArea) };
  }
}
