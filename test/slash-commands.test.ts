import test from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor, matchCommand, slashSuggestions } from '../src/shared/slash-commands.ts';
import { MODES, modeLabel, nextMode } from '../src/shared/permission-modes.ts';
import { initPrompt } from '../src/shared/init-prompt.ts';

const skills = [
  { id: 's1', name: 'tavern-card-builder', description: 'Design card variables and CoT' },
  { id: 's2', name: 'code-review', description: 'Review a branch', disableModelInvocation: true },
];

test('the card composer lists the common commands, then the card commands', () => {
  assert.deepEqual(commandsFor('card').map(command => command.label), ['/compact', '/context', '/cost', '/model', '/help', '/检查', '/标记完成', '/换对话', '/下一步']);
});

test('a slash lists skills before commands, and plain text lists nothing', () => {
  const items = slashSuggestions('/', { skills, commands: commandsFor('card'), language: 'zh' });
  assert.ok(items);
  assert.deepEqual(items.slice(0, 2).map(item => [item.kind, item.label, item.insert]), [['skill', '/tavern-card-builder', '/skill:tavern-card-builder '], ['skill', '/code-review', '/skill:code-review ']]);
  assert.equal(items[1].manual, true);
  assert.deepEqual(items.slice(2).map(item => item.label), commandsFor('card').map(command => command.label));
  assert.equal(items.find(item => item.label === '/检查')?.description, '运行拼装检查');
  assert.equal(slashSuggestions('继续写人设', { skills, commands: commandsFor('card'), language: 'zh' }), null);
  assert.equal(slashSuggestions('/compact now', { skills, commands: commandsFor('card'), language: 'zh' }), null);
});

test('typing narrows the list by name or description, ignoring case', () => {
  const labels = (text: string) => slashSuggestions(text, { skills, commands: commandsFor('card'), language: 'en' })?.map(item => item.label);
  assert.deepEqual(labels('/co'), ['/code-review', '/compact', '/context', '/cost']);
  assert.deepEqual(labels('/检'), ['/检查']);
  assert.deepEqual(labels('/TAVERN'), ['/tavern-card-builder']);
  assert.deepEqual(labels('/skill:code'), ['/code-review']);
});

test('the workbench lists the Claude Code commands, then the Cardwright workflows', () => {
  assert.deepEqual(commandsFor('workbench').map(command => command.label),
    ['/clear', '/compact', '/context', '/cost', '/model', '/resume', '/rewind', '/init', '/help', '/plan', '/todos', '/memory', '/dream']);
  // Without a conversation only the ones that make sense on their own are offered.
  assert.deepEqual(commandsFor('workbench', { task: false }).map(command => command.label), ['/model', '/resume', '/help']);
  assert.deepEqual(commandsFor('card').map(command => command.label).slice(0, 5), ['/compact', '/context', '/cost', '/model', '/help']);
});

test('Shift+Tab cycles 默认审批 → 自动编辑 → 计划 → 完全访问', () => {
  assert.deepEqual(MODES.map(mode => [mode.permission, mode.planMode]), [['ask', false], ['edit', false], ['edit', true], ['full', false]]);
  assert.deepEqual(nextMode({ permission: 'ask', planMode: false }), { permission: 'edit', planMode: false });
  assert.deepEqual(nextMode({ permission: 'edit', planMode: false }), { permission: 'edit', planMode: true });
  assert.deepEqual(nextMode({ permission: 'edit', planMode: true }), { permission: 'full', planMode: false });
  assert.deepEqual(nextMode({ permission: 'full', planMode: false }), { permission: 'ask', planMode: false });
  // Plan mode is the third step whatever permission it was switched on from, and leaving it turns it off.
  assert.deepEqual(nextMode({ permission: 'full', planMode: true }), { permission: 'full', planMode: false });
  assert.deepEqual(nextMode({ permission: 'ask', planMode: true }), { permission: 'full', planMode: false });
  const t = (_en: string, zh: string) => zh;
  assert.deepEqual(MODES.map(mode => modeLabel(mode, t)), ['默认审批', '自动编辑', '计划', '完全访问']);
});

test('/init updates the instruction file a project already has, or writes CLAUDE.md', () => {
  const zh = (file: string | null) => initPrompt(file, 'zh');
  assert.match(zh('AGENTS.md'), /AGENTS\.md/);
  assert.match(zh('AGENTS.md'), /更新/);
  assert.doesNotMatch(zh('AGENTS.md'), /新建/);
  assert.match(zh('CLAUDE.md'), /CLAUDE\.md/);
  assert.match(zh(null), /新建/);
  assert.match(zh(null), /CLAUDE\.md/);
  assert.match(initPrompt(null, 'en'), /CLAUDE\.md/);
  // The command is a prompt, so it must not read as a chat message the model could answer with talk alone.
  for (const file of ['AGENTS.md', null]) assert.ok(zh(file).length > 120, String(file));
});

test('only an exact command runs as a command', () => {
  const commands = commandsFor('card');
  assert.equal(matchCommand('/检查', commands)?.name, '检查');
  assert.equal(matchCommand('  /compact  ', commands)?.name, 'compact');
  assert.equal(matchCommand('/compact 请压缩', commands), undefined);
  assert.equal(matchCommand('/plan', commands), undefined);
});
