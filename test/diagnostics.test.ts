import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnosticText, LOG_LIMIT, needsRotation, pageLabel, redactHome, reportOf, windowsLabel, type RendererErrorReport } from '../src/shared/diagnostics.ts';
import { appendRendererLog } from '../src/main/renderer-log.ts';

// An invented account: a Chinese name, so file URLs in stacks carry it percent-encoded.
const HOME = String.raw`C:\Users\示例用户`;
const ENCODED_HOME = encodeURI('C:/Users/示例用户');
const report: RendererErrorReport = {
  source: 'boundary',
  page: '制卡工坊 · 拼装',
  message: 'Unknown card studio section: lore-other',
  stack: [
    'Error: Unknown card studio section: lore-other',
    `    at boardOf (file:///${ENCODED_HOME}/AppData/Local/Programs/Cardwright/resources/app.asar/dist/renderer/assets/index.js:1:100)`,
    `    at sectionLabel (file:///${ENCODED_HOME}/AppData/Local/Programs/Cardwright/resources/app.asar/dist/renderer/assets/index.js:1:200)`,
  ].join('\n'),
  componentStack: '\n    at AssemblyPanel\n    at SectionPage\n    at CardStudio',
};
const environment = { version: '0.9.1', windows: 'Windows 11 Home China 10.0.22631', home: HOME, at: new Date('2026-09-22T10:15:30.000Z') };

test('the diagnostic text carries every field the user is asked to send', () => {
  const text = diagnosticText(report, environment);
  const lines = text.split('\n');
  assert.ok(lines.includes('时间：2026-09-22T10:15:30.000Z'), text);
  assert.ok(lines.includes('应用版本：0.9.1'), text);
  assert.ok(lines.includes('Windows：Windows 11 Home China 10.0.22631'), text);
  assert.ok(lines.includes('页面：制卡工坊 · 拼装'), text);
  assert.ok(lines.includes('来源：错误边界'), text);
  assert.ok(lines.includes('错误：Unknown card studio section: lore-other'), text);
  const stack = lines.indexOf('调用栈：'); const components = lines.indexOf('组件栈：');
  assert.ok(stack > 0 && components > stack, text);
  assert.match(lines.slice(stack + 1, components).join('\n'), /at boardOf/);
  assert.match(lines.slice(components + 1).join('\n'), /at AssemblyPanel[\s\S]*at CardStudio/);
});

test('a record has no blank line inside it, so the blank line between records in the log stays unambiguous', () => {
  const text = diagnosticText({ ...report, stack: 'Error: x\n\n    at a\n\n\n    at b' }, environment);
  assert.ok(!text.includes('\n\n'), text);
  assert.ok(!text.endsWith('\n'));
});

test('missing stacks are written as missing, and the other sources are named', () => {
  const text = diagnosticText({ source: 'rejection', page: '工作台 · 首页', message: 'boom' }, environment);
  assert.match(text, /^来源：unhandledrejection$/m);
  assert.match(text, /^调用栈：（无）$/m);
  assert.match(text, /^组件栈：（无）$/m);
  assert.match(diagnosticText({ ...report, source: 'error' }, environment), /^来源：window\.onerror$/m);
});

test('only the listed fields reach the text: card content and conversations riding along on the report stay out', () => {
  const smuggled = { ...report, card: { name: '西游·八十一难', entries: ['<红孩儿>姓名：红孩儿</红孩儿>'] }, messages: ['帮我写红孩儿'], gateway: { baseUrl: 'https://gateway.example.com/v1', key: 'sk-live-0123456789abcdef' } } as RendererErrorReport;
  const text = diagnosticText(smuggled, environment);
  for (const secret of ['西游', '红孩儿', '帮我写', 'gateway.example.com', 'sk-live']) assert.ok(!text.includes(secret), `${secret} leaked into ${text}`);
});

test('gateway addresses and keys that slip into an error message are hidden, React error links are kept', () => {
  const text = diagnosticText({ ...report, message: 'connect failed: https://gateway.example.com/v1/chat with key sk-test-0000-1111 and Bearer abc.def.ghi; see https://react.dev/errors/418?args[]=x' }, environment);
  assert.ok(!text.includes('gateway.example.com'), text);
  assert.ok(!text.includes('sk-test-0000-1111'), text);
  assert.ok(!text.includes('abc.def.ghi'), text);
  assert.ok(text.includes('https://react.dev/errors/418?args[]=x'), text);
});

test('the user folder in every path becomes ~, whatever the slashes, case or URL encoding', () => {
  const text = diagnosticText({ ...report, message: String.raw`ENOENT: no such file or directory, open 'c:\users\示例用户\AppData\Roaming\Cardwright\state.json' (C:/Users/示例用户/Documents)` }, environment);
  assert.ok(!text.includes('示例用户') && !text.toLowerCase().includes(encodeURI('示例用户').toLowerCase()), text);
  assert.ok(text.includes(String.raw`'~\AppData\Roaming\Cardwright\state.json'`), text);
  assert.ok(text.includes('(~/Documents)'), text);
  assert.ok(text.includes('file:///~/AppData/Local/Programs/Cardwright/'), text);
});

test('redactHome leaves other folders and a missing home alone', () => {
  assert.equal(redactHome(String.raw`C:\Users\示例用户2\x`, HOME), String.raw`C:\Users\示例用户2\x`, 'a longer folder name is someone else');
  assert.equal(redactHome(String.raw`D:\Projects\x`, HOME), String.raw`D:\Projects\x`);
  assert.equal(redactHome(String.raw`C:\Users\示例用户`, HOME), '~');
  assert.equal(redactHome('anything', ''), 'anything');
});

test('any thrown value becomes a report, and an object is never serialized into it', () => {
  const fromError = reportOf('boundary', new TypeError('x is undefined'), '工作台 · 首页', '\n    at Home');
  assert.equal(fromError.source, 'boundary');
  assert.equal(fromError.page, '工作台 · 首页');
  assert.equal(fromError.message, 'x is undefined');
  assert.match(fromError.stack ?? '', /TypeError: x is undefined/);
  assert.equal(fromError.componentStack, '\n    at Home');
  assert.equal(reportOf('boundary', new Error(''), 'p').message, 'Error', 'an empty message falls back to the name');
  assert.equal(reportOf('rejection', 'plain words', 'p').message, 'plain words');
  assert.equal(reportOf('rejection', undefined, 'p').message, 'undefined');
  const fromObject = reportOf('rejection', { card: '西游·八十一难', entries: ['红孩儿'] }, 'p');
  assert.ok(!/西游|红孩儿/.test(JSON.stringify(fromObject)), JSON.stringify(fromObject));
});

test('a runaway message or stack is cut, so one record cannot fill the log', () => {
  const text = diagnosticText({ ...report, message: 'x'.repeat(50_000), stack: 'y'.repeat(50_000) }, environment);
  assert.ok(text.length < 20_000, String(text.length));
  assert.match(text, /（已截断）/);
});

test('Windows 11 is named from its build number, since Windows itself still reports Windows 10', () => {
  assert.equal(windowsLabel('Windows 10 Home China', '10.0.22631'), 'Windows 11 Home China 10.0.22631');
  assert.equal(windowsLabel('Windows 10 Pro', '10.0.19045'), 'Windows 10 Pro 10.0.19045');
  assert.equal(windowsLabel('Windows 11 Pro', '10.0.26100'), 'Windows 11 Pro 10.0.26100');
});

test('the page is named by where the user is, never by the card or the task they have open', () => {
  assert.equal(pageLabel({ area: 'studio', page: 'section', sectionId: 'build' }), '制卡工坊 · 拼装');
  assert.equal(pageLabel({ area: 'studio', page: 'section', sectionId: 'lore-people' }), '制卡工坊 · 世界书 · 人设');
  assert.equal(pageLabel({ area: 'studio', page: 'project' }), '制卡工坊 · 卡项目主页');
  assert.equal(pageLabel({ area: 'studio', page: 'library' }), '制卡工坊 · 卡库');
  assert.equal(pageLabel({ area: 'workbench', mode: 'code', task: true }), '工作台 · 任务');
  assert.equal(pageLabel({ area: 'workbench', mode: 'code', task: false }), '工作台 · 首页');
  assert.equal(pageLabel({ area: 'workbench', mode: 'tasks', task: false }), '工作台 · Agent 与计划');
  assert.equal(pageLabel({ area: 'workbench', mode: 'settings', task: false }), '工作室设置');
});

test('the log rotates before a record would take it past 1 MB', () => {
  assert.equal(LOG_LIMIT, 1024 * 1024);
  assert.equal(needsRotation(0, 500), false);
  assert.equal(needsRotation(LOG_LIMIT - 100, 100), false, 'exactly 1 MB is still within the limit');
  assert.equal(needsRotation(LOG_LIMIT - 100, 101), true);
  assert.equal(needsRotation(LOG_LIMIT + 5, 1), true);
  assert.equal(needsRotation(0, LOG_LIMIT * 2), false, 'an empty log is never rotated, even for a huge record');
});

test('records are appended with a blank line between them, and the log rotates into a single renderer.log.1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-log-'));
  const logs = join(root, 'logs');
  try {
    await appendRendererLog(logs, '第一条');
    await appendRendererLog(logs, 'second\nline');
    assert.equal(await readFile(join(logs, 'renderer.log'), 'utf8'), '第一条\n\nsecond\nline\n\n');
    await writeFile(join(logs, 'renderer.log'), 'x'.repeat(LOG_LIMIT));
    await appendRendererLog(logs, 'third');
    assert.equal((await readFile(join(logs, 'renderer.log.1'), 'utf8')).length, LOG_LIMIT);
    assert.equal(await readFile(join(logs, 'renderer.log'), 'utf8'), 'third\n\n');
    await writeFile(join(logs, 'renderer.log'), 'y'.repeat(LOG_LIMIT));
    await appendRendererLog(logs, 'fourth');
    assert.equal(await readFile(join(logs, 'renderer.log.1'), 'utf8'), 'y'.repeat(LOG_LIMIT), 'only the latest old log is kept');
    assert.equal(await readFile(join(logs, 'renderer.log'), 'utf8'), 'fourth\n\n');
    assert.deepEqual((await readdir(logs)).sort(), ['renderer.log', 'renderer.log.1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records written at the same moment all land, one after another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-log-'));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendRendererLog(root, `record ${index}`)));
    const records = (await readFile(join(root, 'renderer.log'), 'utf8')).split('\n\n').filter(Boolean);
    assert.deepEqual(records.sort(), Array.from({ length: 20 }, (_, index) => `record ${index}`).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
