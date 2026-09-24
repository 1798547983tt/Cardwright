import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateSchema, parseInitialVariables, schemaSource, validateInSandbox, validateInitialVariables } from '../src/core/card-studio/variables.ts';
import { RE0_CARD } from './reference-cards.ts';

const NL = String.fromCharCode(10);
const sampleSchema = [
  "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';",
  '',
  'const percent = (fallback = 0) => z.coerce.number().catch(fallback).transform(value => _.clamp(value, 0, 100)).prefault(fallback);',
  '',
  'export const Schema = z.object({',
  '  主角: z.object({ 姓名: z.string().prefault("未知"), 生命: percent(100) }),',
  '  资产: z.object({ 货币: z.record(z.string(), z.coerce.number()).prefault({}) }).prefault({}),',
  '});',
  '',
  '$(() => { registerMvuSchema(Schema); });',
].join(NL);

test('a card schema runs in a sandbox and validates the initial variables', () => {
  const evaluated = evaluateSchema(sampleSchema);
  assert.equal(evaluated.registered, true, 'registerMvuSchema was called');
  const initial = parseInitialVariables(['主角:', '  姓名: 林砚', '  生命: 250', '资产:', '  货币:', '    银币: 12'].join(NL));
  const result = validateInitialVariables(evaluated.schema, initial);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const value = result.value as { 主角: { 姓名: string; 生命: number }; 资产: { 货币: Record<string, number> } };
  assert.equal(value.主角.姓名, '林砚');
  assert.equal(value.主角.生命, 100, 'the schema clamps the value instead of failing');
  assert.equal(value.资产.货币.银币, 12);
});

test('a field the schema cannot accept comes back as an issue with its path', () => {
  const evaluated = evaluateSchema(sampleSchema);
  const result = validateInitialVariables(evaluated.schema, { 主角: { 姓名: 42 } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.path === '主角.姓名'), JSON.stringify(result.issues));
});

test('the sandbox has no files, no network and no timers', () => {
  for (const attempt of ['require("node:fs")', 'process.exit(1)', 'fetch("https://example.invalid")', 'setTimeout(() => {}, 1)']) {
    assert.throws(() => evaluateSchema(`export const Schema = z.object({}); ${attempt};`), /变量结构代码执行失败/, attempt);
  }
});

test('a runaway schema is stopped instead of hanging', () => {
  assert.throws(() => evaluateSchema('export const Schema = z.object({}); while (true) {}', { timeoutMs: 200 }), /超时|timed out/i);
});

test('a schema that never defines Schema is refused', () => {
  assert.throws(() => evaluateSchema('const other = z.object({});'), /没有找到 Schema/);
});

test('the import and export lines are stripped before running', () => {
  const source = schemaSource(sampleSchema);
  assert.equal(source.includes('import '), false);
  assert.equal(source.includes('export const'), false);
  assert.ok(source.includes('const Schema = z.object('));
});

test('initial variables that are not valid YAML are refused', () => {
  assert.throws(() => parseInitialVariables('主角:\n  姓名: [未闭合'), /初始变量不是有效的 YAML/);
  assert.throws(() => parseInitialVariables('只是一行字'), /初始变量应该是一组字段/);
});

test('the Re0 schema validates the Re0 initial variables', { skip: existsSync(RE0_CARD) ? false : 'reference card not available' }, () => {
  const card = JSON.parse(readFileSync(RE0_CARD, 'utf8').replace(/^\uFEFF/, '')) as Record<string, Record<string, Record<string, Record<string, Array<Record<string, string>>>>>>;
  const scripts = card.data.extensions.tavern_helper.scripts as unknown as Array<{ name: string; content: string }>;
  const zod = scripts.find(script => script.name.toUpperCase().includes('ZOD'));
  assert.ok(zod, 'the reference card ships a Zod script');
  const entries = card.data.character_book.entries as unknown as Array<{ comment: string; content: string }>;
  const initvar = entries.find(entry => entry.comment.includes('initvar'));
  assert.ok(initvar);
  const evaluated = evaluateSchema(zod!.content);
  assert.equal(evaluated.registered, true);
  const result = validateInitialVariables(evaluated.schema, parseInitialVariables(initvar!.content));
  assert.equal(result.ok, true, JSON.stringify(result.issues.slice(0, 5)));
  const value = result.value as Record<string, Record<string, unknown>>;
  assert.equal(value['主角档案'].生命, 100);
  assert.equal(value['世界'].危机等级, '无');
});

const sandboxEntry = fileURLToPath(new URL('../src/core/card-studio/sandbox-entry.ts', import.meta.url));
const sandboxOptions = { entry: sandboxEntry, execArgv: ['--import', 'tsx'] };

test('the schema runs in a separate process that cannot touch the file system', async () => {
  const good = await validateInSandbox(sampleSchema, { 主角: { 姓名: '林砚', 生命: 42 } }, sandboxOptions);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal((good.value as { 主角: { 生命: number } }).主角.生命, 42);

  const escape = "export const Schema = z.object({}); const leaked = z.constructor.constructor('return process')(); leaked.mainModule; globalThis.__stolen = leaked.binding ? 'yes' : 'no';";
  const blocked = await validateInSandbox(escape, {}, sandboxOptions);
  assert.equal(blocked.ok, false, 'the escape attempt does not produce a valid schema result');

  const readFile = "export const Schema = z.object({}); const p = z.constructor.constructor('return process')(); p.binding('fs');";
  const denied = await validateInSandbox(readFile, {}, sandboxOptions);
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /执行失败|Access to this API has been restricted|permission/i);
});

test('a runaway schema in the sandbox is killed', async () => {
  const result = await validateInSandbox('export const Schema = z.object({}); while (true) {}', {}, { ...sandboxOptions, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /超时|timed out/i);
});

const BUNDLE = fileURLToPath(new URL('../dist/card-sandbox.cjs', import.meta.url));

test('the packaged sandbox denies a file read even when the vm context is escaped', { skip: existsSync(BUNDLE) ? false : 'build first: npm run build' }, async () => {
  const escape = "export const Schema = z.object({}); const P = z.constructor.constructor('return process')(); globalThis.stolen = P.mainModule.require('node:fs').readFileSync('package.json', 'utf8').length;";
  const blocked = await validateInSandbox(escape, {}, { entry: BUNDLE });
  assert.equal(blocked.restricted, true, 'the permission model is on for the bundled sandbox');
  assert.match(String(blocked.error), /restricted|permission/i);
  const good = await validateInSandbox(sampleSchema, { 主角: { 姓名: '林砚' } }, { entry: BUNDLE });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.restricted, true);
});

test('a schema that loads registerMvuSchema with a dynamic import in try/catch still registers in the sandbox', () => {
  const dynamic = [
    'let registerMvuSchema;',
    'try {',
    "  ({ registerMvuSchema } = await import('https://cdn.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'));",
    '} catch (e) {',
    "  ({ registerMvuSchema } = await import('https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'));",
    '}',
    'const Cap = n => d => _(d).entries().takeRight(n).fromPairs().value();',
    'export const Schema = z.object({ 主角: z.object({ 生命: z.coerce.number().catch(0).prefault(0) }).prefault({}), 因果: z.record(z.string(), z.string()).transform(Cap(2)).prefault({}) });',
    '$(() => { registerMvuSchema(Schema); });',
  ].join(NL);
  const evaluated = evaluateSchema(dynamic);
  assert.equal(evaluated.registered, true, 'registered through the module the sandbox provides');
  const result = validateInitialVariables(evaluated.schema, { 主角: { 生命: '7' }, 因果: { a: '1', b: '2', c: '3' } });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.value, { 主角: { 生命: 7 }, 因果: { b: '2', c: '3' } });
});
