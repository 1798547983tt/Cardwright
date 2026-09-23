import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPetView } from '../src/shared/pet-view.ts';
import { BUILT_IN_THEMES, type ThemeDefinition } from '../src/shared/themes.ts';
import type { AppSnapshot, PetSummary, Task } from '../src/shared/types.ts';

const now = new Date(Date.UTC(2026, 8, 23, 10, 0, 0));
const pets: PetSummary[] = [
  { id: 'erii', displayName: '绘梨衣', description: '', builtIn: true, version: 1, notice: true },
  { id: 'mika', displayName: 'Mika', description: '', builtIn: false, version: 1, notice: false },
];
const snapshot = (preferences: Record<string, unknown>, tasks: Task[] = []) => ({
  preferences: { theme: 'dark', language: 'zh', reducedMotion: false, ...preferences }, tasks, approvals: [], interactions: [], cardStudio: undefined,
}) as unknown as AppSnapshot;

test('the floating pet window gets its pet, mood, theme and click target worked out in the main process', () => {
  const sakura = buildPetView({ snapshot: snapshot({ theme: 'sakura' }), pets, themes: [], systemDark: true, now });
  assert.ok(sakura);
  assert.deepEqual([sakura.petId, sakura.name, sakura.theme.dataTheme, sakura.mood.event, sakura.mood.open, sakura.language, sakura.reduced], ['erii', '绘梨衣', 'sakura', 'idle', { kind: 'app' }, 'zh', false], 'the theme’s own pet');
  assert.equal(sakura.mood.usage, '今天 0 Token');
  assert.equal(buildPetView({ snapshot: snapshot({ petId: 'mika' }), pets, themes: [], systemDark: true, now })?.petId, 'mika', 'the chosen pet');
  assert.equal(buildPetView({ snapshot: snapshot({ petId: 'gone' }), pets, themes: [], systemDark: true, now })?.petId, 'erii', 'a pet that is gone falls back');
  assert.equal(buildPetView({ snapshot: snapshot({}), pets: [], themes: [], systemDark: true, now }), null, 'no pet to show');
  const pack: ThemeDefinition = { ...BUILT_IN_THEMES[0], id: 'night-tea', name: '夜茶', builtIn: false, colors: { accent: '#c9a36a' }, pet: { id: 'mika', actions: { complete: 'waving' } } };
  const packed = buildPetView({ snapshot: snapshot({ theme: 'night-tea', reducedMotion: true, language: 'en' }), pets, themes: [pack], systemDark: true, now });
  assert.ok(packed);
  assert.deepEqual([packed.petId, packed.actions.complete, packed.actions.poke, packed.reduced, packed.theme.dataTheme, packed.language], ['mika', 'waving', 'waving', true, 'dark', 'en']);
  assert.equal(packed.theme.variables['--accent'], '#c9a36a', 'a pack’s colours go along');
  const task = { id: 'a', projectId: 'p', title: '整理笔记', cwd: '', status: 'running', permission: 'ask', gatewayId: 'g', thinking: 'medium', createdAt: now.toISOString(), updatedAt: now.toISOString(), messages: [], tools: [] } as Task;
  const running = buildPetView({ snapshot: snapshot({}, [task]), pets, themes: [], systemDark: true, now });
  assert.deepEqual([running?.mood.event, running?.mood.title, running?.mood.open], ['running', '整理笔记', { kind: 'task', taskId: 'a' }]);
});
