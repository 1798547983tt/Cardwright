/**
 * 桌宠's floating window (ADR 0018, revised 2026-09-23): everything the window draws is worked out here, in the main
 * process, from the app's own state — the pet, its mood and what a click opens, the theme's colours. The window itself
 * only draws, and can ask the main process for nothing but what PetBridge lists.
 */
import { runIsOpen } from './card-studio/run.ts';
import { DEFAULT_PET_ACTIONS, petMood, type PetEvent, type PetMood, type PetState, type SpriteLayout } from './pets.ts';
import { resolveTheme, type ThemeDefinition } from './themes.ts';
import { buildUsageReport } from './usage.ts';
import type { AppSnapshot, PetSummary } from './types.ts';

/** The floating window: room for the bubble above a 120×130 sprite. */
export const PET_WINDOW = { width: 280, height: 270 } as const;

export interface PetView {
  petId: string;
  name: string;
  mood: PetMood;
  actions: Record<PetEvent, PetState>;
  language: 'en' | 'zh';
  reduced: boolean;
  theme: { dataTheme: string; variables: Record<string, string> };
}

export function buildPetView(input: {
  snapshot: Pick<AppSnapshot, 'preferences' | 'tasks' | 'approvals' | 'interactions' | 'cardStudio'>;
  pets: readonly PetSummary[];
  themes: readonly ThemeDefinition[];
  systemDark: boolean;
  now: Date;
}): PetView | null {
  const { snapshot, pets } = input;
  const preferences = snapshot.preferences;
  const theme = resolveTheme(preferences.theme, { systemDark: input.systemDark, packs: input.themes });
  // The chosen pet, else the theme's, else the built-in one, else whichever there is.
  const pet = [preferences.petId, theme.theme.pet?.id, 'erii'].map(id => pets.find(item => item.id === id)).find(Boolean) ?? pets[0];
  if (!pet) return null;
  const actions = { ...DEFAULT_PET_ACTIONS, ...theme.theme.pet?.actions };
  const language = preferences.language;
  const t = (english: string, chinese: string) => language === 'zh' ? chinese : english;
  const runs = (snapshot.cardStudio?.cards ?? []).flatMap(card => card.run && runIsOpen(card.run)
    ? [{ card: card.name, projectId: card.projectId, status: card.run.status, done: card.run.done.length, total: card.run.total }] : []);
  const usageToday = buildUsageReport(snapshot.tasks, { days: 1, now: input.now.getTime() }).tokens.total;
  const mood = petMood({ now: input.now, tasks: snapshot.tasks, approvals: snapshot.approvals, interactions: snapshot.interactions, runs, usageToday, actions, t });
  return { petId: pet.id, name: pet.displayName, mood, actions, language, reduced: preferences.reducedMotion === true, theme: { dataTheme: theme.dataTheme, variables: theme.variables } };
}

/** The floating window's only way out: what to draw, and a handful of requests the main process checks. */
export interface PetBridge {
  view(): Promise<PetView | null>;
  sprite(): Promise<{ dataUrl: string; layout: SpriteLayout } | null>;
  onView(listener: (view: PetView) => void): () => void;
  onPoke(listener: () => void): () => void;
  open(): Promise<void>;
  menu(): Promise<void>;
  hide(): Promise<void>;
  interactive(on: boolean): void;
  dragStart(): void;
  drag(dx: number, dy: number): void;
  dragEnd(): Promise<void>;
}

declare global { interface Window { cardwrightPet?: PetBridge } }
