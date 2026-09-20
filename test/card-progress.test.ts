import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS } from '../src/shared/card-studio/boards.ts';
import { boardStats, dispatchCounts, nextStep, sectionState } from '../src/shared/card-studio/progress.ts';
import { parsePeople } from '../src/shared/card-studio/design-book.ts';
import { componentName } from '../src/shared/card-studio/components.ts';
import type { CardDispatch, DispatchStatus } from '../src/shared/card-studio/types.ts';

let serial = 0;
const dispatch = (sectionId: string | null, title: string, status: DispatchStatus): CardDispatch => ({
  id: `d${++serial}`, target: sectionId ?? '世界书/不存在', sectionId, title, requires: '', body: '', status, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
});
const lore = BOARDS.find(board => board.id === 'lore')!;
const script = BOARDS.find(board => board.id === 'script')!;

test('section state follows the dispatches written for that section', () => {
  const input = (dispatches: CardDispatch[]) => ({ dispatches, designExists: true });
  assert.equal(sectionState(input([]), 'lore-people'), 'todo');
  assert.equal(sectionState(input([dispatch('lore-people', '写人物模板', 'todo')]), 'lore-people'), 'todo');
  assert.equal(sectionState(input([dispatch('lore-people', '写人物模板', 'active')]), 'lore-people'), 'active');
  assert.equal(sectionState(input([dispatch('lore-people', '写人物模板', 'done'), dispatch('lore-people', '写人物总览', 'done')]), 'lore-people'), 'done');
  assert.equal(sectionState(input([dispatch('lore-people', '写人物模板', 'done'), dispatch('lore-people', '逐个写人物', 'todo')]), 'lore-people'), 'active');
});

test('planning is done once the design book exists, sources once material is imported', () => {
  assert.equal(sectionState({ dispatches: [], designExists: false }, 'plan'), 'todo');
  assert.equal(sectionState({ dispatches: [], designExists: false, planStarted: true }, 'plan'), 'active');
  assert.equal(sectionState({ dispatches: [], designExists: true }, 'plan'), 'done');
  assert.equal(sectionState({ dispatches: [], designExists: false, sources: 0 }, 'source'), 'todo');
  assert.equal(sectionState({ dispatches: [], designExists: false, sources: 3 }, 'source'), 'done');
});

test('board statistics count sections and leave out an optional section nobody dispatched', () => {
  const dispatches = [dispatch('lore-rules', '写叙事规则', 'done'), dispatch('lore-overview', '写地点总览', 'done'), dispatch('lore-people', '写人物模板', 'active')];
  assert.deepEqual(boardStats({ dispatches, designExists: true }, lore), { done: 2, total: 7, active: true });
  assert.deepEqual(boardStats({ dispatches: [], designExists: true }, script), { done: 0, total: 2, active: false });
  assert.deepEqual(boardStats({ dispatches: [dispatch('script-mechanism', '写轮回存档', 'todo')], designExists: true }, script), { done: 0, total: 3, active: false });
});

test('dispatch counts report done over total', () => {
  assert.deepEqual(dispatchCounts([dispatch('lore-rules', 'a', 'done'), dispatch('lore-people', 'b', 'active'), dispatch('build', 'c', 'todo')]), { done: 1, total: 3 });
  assert.deepEqual(dispatchCounts([]), { done: 0, total: 0 });
});

test('next step is the first unfinished dispatch that points at a section', () => {
  const broken = dispatch(null, '目标写错的派单', 'todo');
  const people = dispatch('lore-people', '逐个写人物', 'active');
  const plot = dispatch('lore-plot', '写剧情模板', 'todo');
  const step = nextStep({ dispatches: [dispatch('lore-rules', '写叙事规则', 'done'), broken, people, plot], designExists: true });
  assert.equal(step.kind, 'dispatch');
  assert.equal(step.sectionId, 'lore-people');
  assert.equal(step.kind === 'dispatch' && step.dispatch.id, people.id);
});

test('without dispatches the next step is planning; after all dispatches it is assembly', () => {
  assert.deepEqual(nextStep({ dispatches: [], designExists: false }), { kind: 'plan', sectionId: 'plan', mode: 'scratch' });
  assert.deepEqual(nextStep({ dispatches: [], designExists: false, origin: 'import' }), { kind: 'plan', sectionId: 'plan', mode: 'refine' });
  assert.deepEqual(nextStep({ dispatches: [], designExists: true }), { kind: 'plan', sectionId: 'plan', mode: 'scratch' });
  assert.deepEqual(nextStep({ dispatches: [dispatch('lore-rules', '写叙事规则', 'done')], designExists: true }), { kind: 'build', sectionId: 'build' });
});

test('counts the design book roster in table and list form', () => {
  const table = '# 设计书\n\n## 人物名单\n\n| 序号 | 人物 | 档位 | 状态 |\n|---|---|---|---|\n| 1 | 唐三藏 | 主要 | 已写 |\n| 2 | 孙悟空 | 主要 | 已写 |\n| 3 | 红孩儿 | 次要 | 未写 |\n\n## 派单清单与顺序\n| 1 | 已写 |\n';
  assert.deepEqual(parsePeople(table), { written: 2, total: 3 });
  const list = '## 5 人物名单\n- 唐三藏｜主要｜已写\n1. 红孩儿｜次要｜未写\n2. 白骨夫人｜次要｜未写\n\n### 备注\n不算人物';
  assert.deepEqual(parsePeople(list), { written: 1, total: 3 });
  assert.equal(parsePeople('# 设计书\n\n## 不做清单\n- 无'), null);
});

test('names components by their card project path', () => {
  assert.equal(componentName('世界书/人设/120-红孩儿.md'), '人设·红孩儿');
  assert.equal(componentName('世界书\\人设\\120-红孩儿.json'), '人设·红孩儿');
  assert.equal(componentName('设计书.md'), '设计书');
  assert.equal(componentName('资料/索引.md'), '资料索引');
  assert.equal(componentName('世界书/人设/出处索引.md'), '出处索引（人设）');
  assert.equal(componentName('世界书/剧情/剧情模板.md'), '剧情模板');
  assert.equal(componentName('正则/状态栏/替换内容.html'), '正则·状态栏');
  assert.equal(componentName('脚本/世界书控制器.js'), '脚本·世界书控制器');
  assert.equal(componentName('开场白/01-长安城送别.md'), '开场白·长安城送别');
  assert.equal(componentName('notes/todo.txt'), 'notes/todo.txt');
});
