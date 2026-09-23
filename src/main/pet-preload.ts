/** The floating pet window's bridge (ADR 0018): what to draw, and the few requests the main process checks. Nothing else. */
import { contextBridge, ipcRenderer } from 'electron';
import type { PetBridge, PetView } from '../shared/pet-view.ts';

const CHANNEL = 'cardwright-pet';
function listen<T>(name: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(`${CHANNEL}:${name}`, handler);
  return () => { ipcRenderer.removeListener(`${CHANNEL}:${name}`, handler); };
}

const bridge: PetBridge = {
  view: () => ipcRenderer.invoke(`${CHANNEL}:view`),
  sprite: () => ipcRenderer.invoke(`${CHANNEL}:sprite`),
  onView: listener => listen<PetView>('update', listener),
  onPoke: listener => listen<void>('poke', () => listener()),
  open: () => ipcRenderer.invoke(`${CHANNEL}:open`),
  menu: () => ipcRenderer.invoke(`${CHANNEL}:menu`),
  hide: () => ipcRenderer.invoke(`${CHANNEL}:hide`),
  interactive: on => ipcRenderer.send(`${CHANNEL}:interactive`, on === true),
  dragStart: () => ipcRenderer.send(`${CHANNEL}:drag-start`),
  drag: (dx, dy) => ipcRenderer.send(`${CHANNEL}:drag`, dx, dy),
  dragEnd: () => ipcRenderer.invoke(`${CHANNEL}:drag-end`),
};

contextBridge.exposeInMainWorld('cardwrightPet', bridge);
