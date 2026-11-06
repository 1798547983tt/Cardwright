import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../src/renderer/${relative}`, import.meta.url)), 'utf8');

test('the prompt editor lists the squad prompts in a group of their own', () => {
  assert.match(read('CardStudioSettings.tsx'), /\{ id: 'squad', en: 'Squad prompts', zh: '小队提示词' \}/);
});

test('a run paused on squad gaps says what 继续 does', () => {
  assert.match(read('card-studio/RunPanel.tsx'), /paused\.reason === 'incomplete'/);
});

test('本轮写入 and the 撤回 dialog list the members’ writes under their names', () => {
  const thread = read('card-studio/SectionThread.tsx');
  assert.match(thread, /leadTurnWrites\(task, data\.tasks, turn\.id, card\.path\)/);
  assert.match(thread, /leadTurnWrites\(task, data\.tasks, message\.turnId \|\| message\.id, card\.path\)/);
  assert.match(thread, /write\.member \? ` · \$\{write\.member\}` : ''/);
});

test('工作室设置 → 制卡 has the 子代理 switch, 自行组队 and the concurrency hint', () => {
  const settings = read('CardStudioSettings.tsx');
  for (const text of ['cardSquadSettings(data.preferences)', "t('Squads', '小队')", "zh: '关'", "zh: '只读'", "zh: '可写'", '子代理', '自行组队', '同时运行的 Agent', '成员额度', 'defaultSquadSize', 'cardSquad: { ...squad, ...changes }']) assert.ok(settings.includes(text), text);
  assert.match(settings, /disabled=\{squad\.mode === 'off'\}/);
});

test('制卡Agent优化 is its own section with every policy and no developer mode', () => {
  const settings = read('CardStudioSettings.tsx');
  for (const text of ["t('Card agent optimization', '制卡Agent优化')", 'DEFAULT_CARD_OPTIMIZATION', 'maxWritesPerRound', 'maxContinueRounds', 'handoffEnabled', 'handoffTokens', 'sectionBrief', 'CARD_OPTIMIZATION_LIMITS', 'cardOptimization: { ...optimization, ...changes }', "t('Built-in prompts', '内置提示词')"]) assert.ok(settings.includes(text), text);
  assert.doesNotMatch(settings, /developerMode|开发者模式/);
  assert.match(settings, /setConfirmBrief\(true\)/);
  assert.match(settings, /optimization\.enabled && <>/);
  assert.match(settings, /optimization\.handoffEnabled && <Row/);
  assert.match(settings, /resetPrompts/);
  assert.match(settings, /t\('Reset all', '全部重置'\)/);
  assert.match(settings, /t\('Reset', '重置'\)/);
  assert.match(settings, /disabled=\{resetting \|\| overriddenCount === 0\}/, 'reset all stays visible and is disabled when nothing is modified');
  assert.match(settings, /disabled=\{resetting \|\| !item\.overridden\}/, 'every prompt shows a reset control');
  assert.match(settings, /step=\{0\.01\}/, 'the threshold accepts two decimals');
  assert.match(settings, /\/ 1000/, 'the threshold is shown in K tokens');
});

test('the composer’s squad chip says what this conversation may send now, with 自行组队 and the Ultra exception in its tooltip', () => {
  const composer = read('card-studio/StudioComposer.tsx');
  assert.ok(composer.includes('cardDispatchRoles({ settings: squad, sectionId, thinking: currentThinking, member: false })'));
  assert.ok(composer.includes('const squad = cardSquadSettings(data.preferences);'));
  for (const text of ["'小队 · 关'", "'小队 · 只读'", "'小队 · 可写'", '自行组队：开', '自行组队：关', '选了 Ultra：活能拆开时派小队', '选 Ultra 时照样派']) assert.ok(composer.includes(text), text);
  assert.doesNotMatch(composer, /level !== 'ultra' \|\| sectionId === 'plan'/, 'Ultra is offered in every section (1.3.2)');
  assert.match(composer, /title=\{squadTip\}/);
  assert.doesNotMatch(composer, /只有规划选 Ultra 时才派只读小队|只读读资料/, 'the 1.2 rule is gone');
});

test('the workbench squad panel draws its members with the shared member card', () => {
  assert.match(read('SquadMemberCard.tsx'), /export function SquadMemberCard/);
  const panel = read('AgentSquad.tsx');
  assert.match(panel, /<SquadMemberCard /);
  assert.match(panel, /memberState\(member, \{ approval:/);
  assert.doesNotMatch(panel, /function state\(member/);
  assert.match(panel, /member\.readOnly && !member\.sharedReadOnly/, 'stage 3’s read-only badge stays');
});

test('each turn shows its squad in place: member cards with network state, files, result, work log and a stop button', () => {
  const squad = read('card-studio/CardSquad.tsx');
  for (const text of ['<SquadMemberCard', 'cardMemberLabel(member)', 'netStatusText(member.net', 'memberWrites(member, card.path)', 'memberSummary(member)', '<MemberTranscript', 'api.cancelTask(member.id)', '停止这个成员', "t('Squad', '小队')"]) assert.ok(squad.includes(text), text);
  const thread = read('card-studio/SectionThread.tsx');
  assert.match(thread, /<CardSquad members=\{membersOfTurn\(task, squad, turn\.id\)\}/);
  assert.match(thread, /等小队成员回来/);
  assert.match(thread, /reply\?\.incomplete/);
  const page = read('card-studio/SectionPage.tsx');
  assert.doesNotMatch(page, /读资料小队|Reading squad/);
  const css = read('card-studio/card-studio-section.css');
  for (const rule of ['.cs-squad-area', '.cs-squad-writes', '.cs-squad-task']) assert.ok(css.includes(rule), rule);
  assert.ok(!css.includes('.cs-squad {'), 'the old brief list is gone');
});

test('the squad area draws a member’s text with the thread’s own studio Markdown, so a web link in it opens in the browser', () => {
  const squad = read('card-studio/CardSquad.tsx');
  assert.match(squad, /import \{ Markdown \} from '\.\/studio-markdown'/);
  assert.doesNotMatch(squad, /conversation\/Markdown/, 'not the bare kernel, whose links go nowhere in this window');
  const thread = read('card-studio/SectionThread.tsx');
  assert.match(thread, /from '\.\/studio-markdown'/);
  assert.doesNotMatch(thread, /function StudioLink/, 'one link handler, in the shared module');
  assert.match(read('card-studio/studio-markdown.tsx'), /api\.openExternal\(href\)/);
});
