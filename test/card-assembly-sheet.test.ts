import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblySheetError, isAssemblySheet, parseAssemblySheet, sheetPaths, type StartSheet, type StatusSheet } from '../src/shared/card-studio/assembly-sheet.ts';
import { BODY_SHEET, START_SHEET, STATUS_SHEET } from './assembly-sheet-samples.ts';

const NL = String.fromCharCode(10);
const issuesOf = (text: string): string[] => {
  try { parseAssemblySheet(text); return []; }
  catch (error) { if (error instanceof AssemblySheetError) return error.issues.map(issue => `${issue.path}: ${issue.message}`); throw error; }
};

test('a sheet is recognised by its first line, comments and a byte order mark aside', () => {
  assert.ok(isAssemblySheet(STATUS_SHEET));
  assert.ok(isAssemblySheet(['# 装配单', '', '前端: 创角页'].join(NL)));
  assert.ok(isAssemblySheet(String.fromCharCode(0xfeff) + '前端: 正文美化'));
  assert.ok(!isAssemblySheet('<!DOCTYPE html><html></html>'));
  assert.ok(!isAssemblySheet('<section>前端: 假的</section>'));
});

test('the three samples parse into typed sheets with the documented defaults', () => {
  const status = parseAssemblySheet(STATUS_SHEET) as StatusSheet;
  assert.equal(status.kind, '状态栏');
  assert.equal(status.form, 'placeholder');
  assert.equal(status.preset, 'sakura');
  assert.deepEqual(status.summary.map(item => item.label ?? item.path), ['生命', '/主角/状态']);
  assert.deepEqual(status.pages.map(page => page.name), ['状态', '人物', '记录']);
  assert.equal(status.pages[0].blocks[0].type, 'stats');
  const fold = status.pages[2].blocks.find(block => block.type === 'fold');
  assert.equal(fold && fold.type === 'fold' ? fold.blocks[0].type : null, 'list');

  const body = parseAssemblySheet(BODY_SHEET);
  assert.equal(body.kind, '正文美化');
  if (body.kind === '正文美化') {
    assert.equal(body.root, 'content'); assert.equal(body.floors, 10); assert.equal(body.playerMark, '#'); assert.equal(body.statusHead, false);
    assert.deepEqual(body.modules.map(module => `${module.tag}=${module.role}`), ['time=页眉', 'story=正文', 'now_plot=折叠']);
    assert.equal(body.custom.length, 1);
  }

  const start = parseAssemblySheet(START_SHEET) as StartSheet;
  assert.equal(start.kind, '创角页');
  assert.deepEqual(start.steps.map(step => `${step.name}${step.custom ? '*' : ''}`), ['身份', '关系', '自定义开局*']);
  assert.equal(start.steps[0].fields[2].type, '滑杆');
  assert.deepEqual(start.steps[0].fields[2].range, [1, 100]);
  assert.equal(start.writes.entry?.name, '[样卡] 初始人物设定');
  assert.match(start.writes.opening ?? '', /走进港口/);
  assert.equal(start.writes.variables, true);
});

test('a status sheet without 形态 or 折叠 gets header and collapsed', () => {
  const sheet = parseAssemblySheet(['前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: text', '        文本: 你好'].join(NL)) as StatusSheet;
  assert.equal(sheet.form, 'header');
  assert.equal(sheet.collapsed, true);
  assert.equal(sheet.preset, undefined, 'the preset can come from the card when the sheet leaves it out');
});

test('every mistake is reported with the place it is in', () => {
  const bad = ['前端: 状态栏', '预设: rainbow', '分页:', '  - 名称: 状态', '    图标: dragon', '    区块:', '      - 类型: table', '      - 类型: fold', '        标题: 里', '        区块:', '          - 类型: fold', '            标题: 更里', '            区块: []', '      - 类型: custom', '        HTML: \'<script>1</script>\'', '        CSS: \'.x { color: #fff; }\'', '      - 类型: bars', '        项: []'].join(NL);
  const issues = issuesOf(bad);
  assert.ok(issues.some(issue => issue.startsWith('预设: ')), issues.join('|'));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].图标: ')));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[0].类型: ')));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[1].区块[0]: ') && /fold/.test(issue)), 'a fold inside a fold');
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[2].HTML: ')), 'a script in a custom block');
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[2].CSS: ') && /令牌/.test(issue)));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[3].项: ')), 'bars without items');
  assert.deepEqual(issuesOf('前端: 舞台'), ['前端: 只能是 状态栏、正文美化、创角页。']);
  assert.deepEqual(issuesOf('前端: 状态栏'), ['分页: 至少一页。']);
  assert.ok(issuesOf(['前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: text', '        文本: 一', '  - 名称: 状态', '    区块:', '      - 类型: text', '        文本: 二'].join(NL)).some(issue => issue.startsWith('分页[1].名称: ') && /重复/.test(issue)), 'a duplicated page name');
});

test('the creation sheet checks fields, options, ranges and the writes', () => {
  const issues = issuesOf(['前端: 创角页', '步骤:', '  - 名称: 一', '    字段:', '      - 键: 出身', '        类型: 单选', '      - 键: 出身', '        类型: 滑杆', '      - 键: 三', '        类型: 传送门', '写入:', '  初始变量: true'].join(NL));
  assert.ok(issues.some(issue => issue.startsWith('步骤[0].字段[0].选项: ')), issues.join('|'));
  assert.ok(issues.some(issue => issue.startsWith('步骤[0].字段[1].键: ') && /重复/.test(issue)));
  assert.ok(issues.some(issue => issue.startsWith('步骤[0].字段[1].范围: ')));
  assert.ok(issues.some(issue => issue.startsWith('步骤[0].字段[2].类型: ')));
  assert.ok(issues.some(issue => issue.startsWith('写入.初始变量: ')), 'nothing to write into the variables');
});

test('tokens belong to the custom preset only, and the custom preset needs the base set', () => {
  assert.ok(issuesOf(['前端: 正文美化', '预设: sakura', '根标签: content', '令牌:', '  --bg: \'#000\''].join(NL)).some(issue => issue.startsWith('令牌: ')));
  const issues = issuesOf(['前端: 正文美化', '预设: custom', '根标签: content', '令牌:', '  --bg: \'#000\'', '  --text: \'#fff\''].join(NL));
  assert.ok(issues.some(issue => issue.startsWith('令牌: ') && /--panel/.test(issue)), issues.join('|'));
  assert.deepEqual(issuesOf(['前端: 正文美化', '预设: custom', '根标签: content', '令牌:', ...['--bg', '--panel', '--line', '--text', '--text-2', '--text-3', '--accent', '--accent-2', '--ok', '--warn', '--danger'].map(name => `  ${name}: '#123456'`)].join(NL)), []);
  // An unquoted colour: YAML reads everything after # as a comment, so the value arrives as null.
  const unquoted = issuesOf(['前端: 正文美化', '预设: custom', '根标签: content', '令牌:', '  --bg: #000'].join(NL));
  assert.ok(unquoted.some(issue => issue.startsWith('令牌.--bg: ') && /引号/.test(issue)), unquoted.join('|'));
});

test('sheetPaths lists every variable path a sheet binds, placeholders included', () => {
  // Summary paths come first, then each page's blocks in order; a path is listed once.
  assert.deepEqual(sheetPaths(parseAssemblySheet(STATUS_SHEET)), ['/主角/生命', '/主角/状态', '/主角/姓名', '/主角/在逃', '/人物', '/人物/{键}/好感', '/人物/{键}/所在', '/货币', '/事件记录', '/任务', '/任务/-/标题']);
  assert.deepEqual(sheetPaths(parseAssemblySheet(START_SHEET)), ['/主角/姓名', '/主角/状态', '/主角/生命']);
  assert.deepEqual(sheetPaths(parseAssemblySheet(BODY_SHEET)), []);
});

test('a document marker line is skipped when recognising and parsing a sheet', () => {
  const text = ['---', '前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: text', '        文本: 你好'].join(NL);
  assert.ok(isAssemblySheet(text));
  assert.equal((parseAssemblySheet(text) as StatusSheet).kind, '状态栏');
});

test('a pointer allows no empty segment and no trailing slash', () => {
  const issues = issuesOf(['前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: tags', '        变量: /主角/', '      - 类型: tags', '        变量: //x'].join(NL));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[0].变量: ')), issues.join('|'));
  assert.ok(issues.some(issue => issue.startsWith('分页[0].区块[1].变量: ')));
});

test('crisis tiers climb, and a tier without 至 can only be the last', () => {
  const crisis = (tiers: string[]) => issuesOf(['前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: crisis', '        变量: /主角/生命', '        档位:', ...tiers].join(NL));
  const down = crisis(['          - { 至: 70, 名称: 受伤, 色: warn }', '          - { 至: 30, 名称: 濒死, 色: danger }']);
  assert.ok(down.some(issue => issue.startsWith('分页[0].区块[0].档位[1].至: ') && /大/.test(issue)), down.join('|'));
  const open = crisis(['          - { 名称: 安好, 色: ok }', '          - { 至: 30, 名称: 濒死, 色: danger }']);
  assert.ok(open.some(issue => issue.startsWith('分页[0].区块[0].档位[0].至: ') && /最后/.test(issue)), open.join('|'));
});

test('token values and custom CSS cannot break out of the style sheet', () => {
  const base = ['--bg', '--panel', '--line', '--text', '--text-2', '--text-3', '--accent', '--accent-2', '--ok', '--warn', '--danger'].map(name => `  ${name}: '#123456'`);
  const custom = (extra: string) => issuesOf(['前端: 正文美化', '预设: custom', '根标签: content', '令牌:', ...base, extra].join(NL));
  const braces = custom("  --evil: '#000; } body { color: red'");
  assert.deepEqual(braces, ['令牌.--evil: 令牌值不能包含 { } 或 </。'], braces.join('|'));
  const closer = custom("  --evil: 'x</style'");
  assert.deepEqual(closer, ['令牌.--evil: 令牌值不能包含 { } 或 </。'], closer.join('|'));
  const css = issuesOf(['前端: 状态栏', '分页:', '  - 名称: 状态', '    区块:', '      - 类型: custom', '        HTML: \'<div class="cw-x">好</div>\'', '        CSS: \'.cw-x { color: var(--text); }</style><p>逃逸</p>\''].join(NL));
  assert.ok(css.some(issue => issue.startsWith('分页[0].区块[0].CSS: ') && /提前结束/.test(issue)), css.join('|'));
});
