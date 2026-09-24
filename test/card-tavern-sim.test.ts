// test/card-tavern-sim.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PREVIEW_MESSAGE_KEY, SIM_GENERATED, SIM_MESSAGE, tavernSimScript, type SimWrite } from '../src/shared/card-studio/tavern-sim.ts';

/** Objects made inside the vm carry that realm's prototypes, and strict deepEqual compares prototypes: compare plain copies. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
/** Lets the promise callbacks queued so far run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Just enough of an element for the composer stand-in. */
interface FakeElement {
  tagName: string; id: string; type: string; value: string; hidden: boolean;
  attributes: Record<string, string>; children: FakeElement[]; listeners: Record<string, Array<() => void>>;
  appendChild(child: FakeElement): FakeElement; setAttribute(name: string, value: string): void;
  addEventListener(name: string, handler: () => void): void; click(): void;
}
function element(tagName: string): FakeElement {
  const self: FakeElement = {
    tagName: tagName.toUpperCase(), id: '', type: '', value: '', hidden: false, attributes: {}, children: [], listeners: {},
    appendChild: child => { self.children.push(child); return child; },
    setAttribute: (name, value) => { self.attributes[name] = String(value); },
    addEventListener: (name, handler) => { (self.listeners[name] ??= []).push(handler); },
    click: () => { for (const handler of self.listeners.click ?? []) handler(); },
  };
  return self;
}
const findById = (root: FakeElement | null, id: string): FakeElement | null =>
  !root ? null : root.id === id ? root : root.children.reduce<FakeElement | null>((found, child) => found ?? findById(child, id), null);

type Message = { data: unknown; source?: unknown };

/** The sim in a bare window whose parent records what is posted; a card script can run after it in the same context. */
function boot(statData: unknown = { 主角: { 生命: 62 } }, over: { loading?: boolean; bookName?: string } = {}) {
  const posted: Array<Record<string, any>> = [];
  const listeners: Record<string, (event: Message) => void> = {};
  const host = { postMessage: (data: Record<string, any>) => { posted.push(data); } };
  const root = element('html');
  const body = over.loading ? null : root.appendChild(element('body'));
  const sandbox: Record<string, unknown> = {
    parent: host, navigator: {}, console, JSON,
    document: { readyState: over.loading ? 'loading' : 'complete', documentElement: root, body, createElement: element, getElementById: (id: string) => findById(root, id) },
    addEventListener: (name: string, handler: (event: Message) => void) => { listeners[name] = handler; },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(tavernSimScript({ cardName: '样卡', statData, messageId: 3, lastMessageId: 3, ...(over.bookName ? { bookName: over.bookName } : {}) }), context);
  /** The records as the panel keeps them: an update replaces the record with its id. */
  const writes = (): SimWrite[] => [...new Map(posted.filter(item => item.write).map(item => [item.write.id, plain(item.write) as SimWrite])).values()];
  const errors = () => posted.filter(item => item.error).map(item => item.error as string);
  const studio = (data: unknown, source: unknown = host) => listeners.message({ data, source });
  return { sandbox: sandbox as Record<string, any>, context, posted, writes, errors, studio, root, body };
}

test('the globals 酒馆助手 injects are there, with copies of the data and matching message ids', async () => {
  const { sandbox } = boot();
  assert.equal(await sandbox.waitGlobalInitialized('Mvu'), sandbox.Mvu, 'it resolves to the global it waited for');
  const data = sandbox.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
  assert.deepEqual(plain(data), { initialized_lorebooks: {}, stat_data: { 主角: { 生命: 62 } } });
  data.stat_data.主角.生命 = 1;
  assert.equal(sandbox.Mvu.getMvuData().stat_data.主角.生命, 62, 'a copy, not the state');
  assert.deepEqual(plain(sandbox.getVariables({ type: 'message', message_id: 'latest' })), { stat_data: { 主角: { 生命: 62 } } });
  assert.equal(sandbox.getCurrentMessageId(), sandbox.getLastMessageId());
  assert.equal(sandbox.tavern_events.MESSAGE_RECEIVED, 'message_received');
  assert.equal(sandbox.Mvu.events.VARIABLE_UPDATE_ENDED, 'mag_variable_update_ended');
  assert.equal(await sandbox.generateRaw({ user_input: 'x' }), '（模拟酒馆：这里会是模型生成的内容）');
});

test('events subscribe, fire, stop and fire once', async () => {
  const { sandbox } = boot();
  const seen: unknown[] = [];
  const handle = sandbox.eventOn('ping', (value: unknown) => { seen.push(value); });
  sandbox.eventOnce('ping', (value: unknown) => { seen.push(['once', value]); });
  await sandbox.eventEmit('ping', 1); await sandbox.eventEmit('ping', 2);
  assert.deepEqual(seen, [1, ['once', 1], 2]);
  handle.stop(); await sandbox.eventEmit('ping', 3);
  assert.deepEqual(seen, [1, ['once', 1], 2]);
});

test('a listener that throws or rejects is reported, and the next one still runs', async () => {
  const { sandbox, errors } = boot();
  const seen: string[] = [];
  sandbox.eventOn('go', () => { throw new Error('同步出错'); });
  sandbox.eventOn('go', async () => { throw new Error('异步出错'); });
  sandbox.eventOn('go', () => { seen.push('第三个'); });
  await sandbox.eventEmit('go');
  assert.deepEqual(seen, ['第三个']);
  assert.deepEqual(errors(), ['同步出错', '异步出错']);
});

test('a once-listener runs in the first emit whose snapshot holds it, even when emits overlap', async () => {
  const { sandbox } = boot();
  const seen: unknown[] = [];
  sandbox.eventOn('tick', async () => { await null; });
  sandbox.eventOnce('tick', (value: unknown) => { seen.push(value); });
  await Promise.all([sandbox.eventEmit('tick', 1), sandbox.eventEmit('tick', 2)]);
  assert.deepEqual(seen, [1]);
});

test('listeners are kept by the function: duplicates ignored, MakeFirst moves, removal finds once-listeners, stop removes only its own', async () => {
  const { sandbox } = boot();
  const seen: string[] = [];
  const a = () => { seen.push('a'); }; const b = () => { seen.push('b'); }; const once = () => { seen.push('once'); };
  const emit = async (name = 'go') => { seen.length = 0; await sandbox.eventEmit(name); return [...seen]; };
  const first = sandbox.eventOn('go', a);
  sandbox.eventOn('go', b);
  sandbox.eventOn('go', a);
  sandbox.eventOnce('go', a);
  assert.deepEqual(await emit(), ['a', 'b'], 'a second registration of the same function is ignored, not added or moved');
  sandbox.eventMakeFirst('go', b);
  assert.deepEqual(await emit(), ['b', 'a'], 'MakeFirst moves a registered listener to the front');
  sandbox.eventMakeLast('go', b);
  assert.deepEqual(await emit(), ['a', 'b']);
  sandbox.eventOnce('go', once);
  sandbox.eventRemoveListener('go', once);
  assert.deepEqual(await emit(), ['a', 'b'], 'a once-listener is removed by the function it was given');
  first.stop(); first.stop();
  const again = sandbox.eventOn('go', a);
  first.stop();
  assert.deepEqual(await emit(), ['b', 'a'], 'an old handle leaves a new registration alone');
  again.stop();
  const nothing = sandbox.eventOn(undefined, a);
  nothing.stop();
  assert.deepEqual(await emit('undefined'), [], 'an undefined event constant subscribes to nothing');
  sandbox.eventOn('other', a);
  sandbox.eventClearListener(b);
  assert.deepEqual(await emit(), []);
  assert.deepEqual(await emit('other'), ['a']);
  sandbox.eventOn('go', b);
  sandbox.eventClearEvent('go');
  assert.deepEqual(await emit(), []);
  sandbox.eventClearAll();
  assert.deepEqual(await emit('other'), []);
  assert.equal(sandbox.eventEmitAndWait, sandbox.eventEmit);
});

test('world book calls are applied in memory and recorded as what would be written', async () => {
  const { sandbox, writes } = boot();
  assert.equal(sandbox.getChatWorldbookName('current'), null);
  const name = await sandbox.getOrCreateChatWorldbook('current', '样卡 · 存档');
  assert.equal(name, '样卡 · 存档');
  assert.equal(sandbox.getChatWorldbookName('current'), name);
  const entry = { name: '[样卡] 初始人物设定', enabled: true, strategy: { type: 'constant' }, position: { type: 'before_character_definition', order: 100 }, content: '玩家：林砚' };
  const after = await sandbox.updateWorldbookWith(name, (entries: unknown[]) => [...entries, entry]);
  assert.equal(after.length, 1);
  assert.deepEqual(plain(await sandbox.getWorldbook(name)), [entry]);
  const primary = sandbox.getCharWorldbookNames('current').primary;
  assert.equal(primary, '样卡');
  await sandbox.updateWorldbookWith(primary, (entries: unknown[]) => [...entries, entry]);
  assert.deepEqual(writes().map(item => item.kind), ['聊天世界书', '聊天世界书', '主世界书']);
  assert.match(writes()[1].detail, /玩家：林砚/);
  await sandbox.updateWorldbookWith(name, (entries: unknown[]) => [...entries, { name: '甲', content: '一' }]);
  await sandbox.updateWorldbookWith(name, (entries: Array<{ name: string; content: string }>) => entries.map(item => (item.name === entry.name ? { ...item, content: '玩家：顾清寒' } : item)));
  const changed = writes().at(-1)?.detail ?? '';
  assert.match(changed, /初始人物设定/);
  assert.doesNotMatch(changed, /甲/, 'an entry that did not change is not named');
  assert.match(changed, /玩家：顾清寒/, 'the content shown is the changed entry, not the last one');
});

test('world book calls fail where SillyTavern fails them, and the batch calls answer in its shapes', async () => {
  const { sandbox } = boot();
  await assert.rejects(sandbox.updateWorldbookWith('样卡', () => { throw new Error('更新函数出错'); }), /更新函数出错/);
  await assert.rejects(sandbox.updateWorldbookWith('样卡', (entries: unknown[]) => { entries.push({ name: '忘了返回' }); }), /数组/);
  await assert.rejects(sandbox.updateWorldbookWith(undefined, (entries: unknown[]) => entries));
  await assert.rejects(sandbox.createWorldbookEntries('样卡', { name: '不是数组' }));
  const made = await sandbox.createWorldbookEntries('样卡', [{ name: '甲', content: '一' }]);
  assert.deepEqual(plain(made), { worldbook: [{ name: '甲', content: '一' }], new_entries: [{ name: '甲', content: '一' }] });
  const dropped = await sandbox.deleteWorldbookEntries('样卡', (item: { name: string }) => item.name === '甲');
  assert.deepEqual(plain(dropped), { worldbook: [], deleted_entries: [{ name: '甲', content: '一' }] });
  await sandbox.replaceWorldbook('样卡', [{ name: '乙', content: '二' }]);
  assert.deepEqual(plain(await sandbox.getWorldbook('样卡')), [{ name: '乙', content: '二' }]);
});

test('the composer stand-in, the clipboard and variable writes are recorded, never executed', async () => {
  const { sandbox, writes, body } = boot();
  const area = sandbox.document.getElementById('send_textarea');
  area.value = '我来了'; sandbox.document.getElementById('send_but').click();
  assert.equal(area.value, '', 'the box is emptied after the send, as SillyTavern does');
  assert.equal(body?.children.length, 0, 'nothing is added to the body');
  await sandbox.navigator.clipboard.writeText('复制的开场');
  assert.equal(await sandbox.navigator.clipboard.readText(), '复制的开场');
  await sandbox.Mvu.replaceMvuData({ stat_data: { 主角: { 生命: 5 } } }, { type: 'chat' });
  assert.equal(sandbox.Mvu.getMvuData().stat_data.主角.生命, 5);
  sandbox.insertOrAssignVariables({ ui: { collapsed: true } }, { type: 'chat' });
  assert.deepEqual(writes().map(item => item.kind), ['输入框', '剪贴板', '变量', '变量']);
  assert.match(writes()[0].detail, /我来了/);
});

test('the composer stand-in is in place at boot, outside the body and hidden, while the document is still loading', () => {
  const { sandbox, root, writes } = boot(undefined, { loading: true });
  const area = sandbox.document.getElementById('send_textarea');
  assert.equal(area?.tagName, 'TEXTAREA');
  const box = root.children.find(child => child.children.includes(area));
  assert.ok(box, 'a child of the root element');
  assert.equal(box.attributes.style, 'display:none!important');
  area.value = '开场'; sandbox.document.getElementById('send_but').click();
  assert.deepEqual(writes().map(item => item.detail), ['发送：开场']);
});

test('variables live by scope: a chat write reads back, updateVariablesWith runs sync and async, deleteVariable removes', async () => {
  const { sandbox, writes } = boot();
  sandbox.insertOrAssignVariables({ ui: { collapsed: true } }, { type: 'chat' });
  assert.equal(sandbox.getVariables({ type: 'chat' }).ui.collapsed, true, 'a status bar sees its own write on the next read');
  assert.equal(sandbox.getVariables({ type: 'message' }).ui, undefined, 'the other scopes keep their own tables');
  assert.equal(sandbox.getVariables({ type: 'chat' }).stat_data.主角.生命, 62, 'message and chat share stat_data');
  assert.deepEqual(plain(sandbox.getVariables({ type: 'global' })), {});
  sandbox.insertVariables({ ui: { collapsed: false, page: 2 } }, { type: 'chat' });
  assert.deepEqual(plain(sandbox.getVariables({ type: 'chat' }).ui), { collapsed: true, page: 2 }, 'insertVariables keeps what is there');
  const now = sandbox.updateVariablesWith((variables: Record<string, any>) => { variables.stat_data.主角.生命 = 50; return variables; }, { type: 'message' });
  assert.equal(now.stat_data.主角.生命, 50, 'a sync updater gets the table back at once');
  assert.equal(sandbox.Mvu.getMvuData().stat_data.主角.生命, 50);
  const later = sandbox.updateVariablesWith(async (variables: Record<string, any>) => ({ ...variables, 旗标: 1 }), { type: 'global' });
  assert.equal(typeof later.then, 'function', 'an async updater gets a promise');
  assert.equal((await later).旗标, 1);
  assert.equal(sandbox.getVariables({ type: 'global' }).旗标, 1);
  const removed = sandbox.deleteVariable('ui.page', { type: 'chat' });
  assert.equal(removed.delete_occurred, true);
  assert.deepEqual(plain(sandbox.getVariables({ type: 'chat' }).ui), { collapsed: true });
  assert.equal(sandbox.deleteVariable('ui.nothing', { type: 'chat' }).delete_occurred, false);
  sandbox.replaceVariables({ 其他: 1 }, { type: 'global' });
  assert.deepEqual(plain(sandbox.getVariables({ type: 'global' })), { 其他: 1 });
  assert.equal(writes().length, 6);
  assert.ok(writes().every(item => item.kind === '变量'));
});

test('the studio replaces the sample data and fires the MVU update with the data before; anything else is ignored', async () => {
  const { sandbox, studio, posted, writes } = boot();
  const seen: unknown[] = [];
  sandbox.eventOn(sandbox.Mvu.events.VARIABLE_UPDATE_ENDED, (after: { stat_data: unknown }, before: { stat_data: unknown }) => { seen.push([after.stat_data, before.stat_data]); });
  studio({ [SIM_MESSAGE]: 1, statData: { 主角: { 生命: 9 } } });
  await settle();
  assert.deepEqual(plain(seen), [[{ 主角: { 生命: 9 } }, { 主角: { 生命: 62 } }]]);
  assert.equal(sandbox.Mvu.getMvuData().stat_data.主角.生命, 9);
  assert.equal(posted.filter(item => item.simulated === 1 && item[PREVIEW_MESSAGE_KEY] === 1).length, 1, 'the panel hears of it on its own channel');
  assert.deepEqual(writes(), [], 'a simulated update is not a write');
  studio({ [SIM_MESSAGE]: 1 });
  studio({ [SIM_MESSAGE]: 1, statData: [1] });
  studio({ somethingElse: true });
  studio({ [SIM_MESSAGE]: 1, statData: { 主角: { 生命: 1 } } }, { postMessage() {} });
  await settle();
  assert.equal(seen.length, 1, 'no statData, a list, another message, another sender: all ignored');
  assert.equal(sandbox.Mvu.getMvuData().stat_data.主角.生命, 9);
});

test('a card that declares its own parent does not break what the sim posts', () => {
  const declared = boot();
  runInContext('function parent() { return "卡片的函数"; }', declared.context);
  assert.equal(typeof declared.sandbox.parent, 'function', 'the declaration replaced the global');
  runInContext('toastr.info("声明了 parent 函数之后")', declared.context);
  assert.deepEqual(declared.writes().map(item => item.detail), ['声明了 parent 函数之后']);
  const lexical = boot();
  runInContext('let parent = null;', lexical.context);
  assert.equal(runInContext('parent', lexical.context), null, 'the name now resolves to the card binding');
  runInContext('toastr.info("let parent 之后")', lexical.context);
  assert.deepEqual(lexical.writes().map(item => item.detail), ['let parent 之后']);
});

test('identical writes in a row become one record with a count, recording stops after 200, and odd values never throw', () => {
  const { sandbox, posted, writes } = boot();
  for (let index = 0; index < 3; index++) sandbox.toastr.info('同一条');
  const updates = posted.filter(item => item.write).map(item => plain(item.write));
  assert.deepEqual(updates.map(item => [item.id, item.count]), [[1, 1], [1, 2], [1, 3]]);
  assert.equal(updates[2].detail, '同一条 ×3');
  const cyclic: Record<string, unknown> = { 名: '环' }; cyclic.self = cyclic;
  assert.doesNotThrow(() => sandbox.insertOrAssignVariables(cyclic, { type: 'chat' }));
  assert.doesNotThrow(() => sandbox.toastr.info(10n));
  for (let index = 0; index < 250; index++) sandbox.toastr.info(`第 ${index} 条`);
  const records = writes();
  assert.equal(records.length, 201, '200 records and one marker');
  assert.equal(records.at(-1)?.detail, '后面的写入省略了');
});

test('what real cards reach for is there: toastr and getContext, TavernHelper, the rest of Mvu, both event maps, the recording stubs', async () => {
  const { sandbox, writes } = boot(undefined, { bookName: '样卡的世界书' });
  sandbox.toastr.success('写好了', '存档');
  assert.equal(writes().at(-1)?.detail, '存档：写好了');
  for (const name of ['clear', 'remove', 'subscribe', 'getContainer']) assert.equal(typeof sandbox.toastr[name], 'function', name);
  assert.deepEqual(plain(sandbox.toastr.options), {});
  const context = sandbox.SillyTavern.getContext();
  assert.deepEqual([context.name1, context.name2, context.getCurrentChatId()], ['玩家', '样卡', 'preview']);
  assert.deepEqual(plain([context.chat, context.chatMetadata]), [[], {}]);
  for (const name of ['getVariables', 'eventOn', 'eventEmitAndWait', 'updateWorldbookWith', 'generate', 'triggerSlash', 'initializeGlobal', 'deleteVariable'])
    assert.equal(sandbox.TavernHelper[name], sandbox[name], `TavernHelper.${name}`);
  assert.equal(sandbox.Mvu.isDuringExtraAnalysis(), false);
  assert.deepEqual(plain(await sandbox.Mvu.parseMessage('<UpdateVariable/>', { stat_data: { a: 1 } })), { stat_data: { a: 1 } });
  assert.deepEqual(plain(sandbox.Mvu.events), {
    VARIABLE_INITIALIZED: 'mag_variable_initiailized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', COMMAND_PARSED: 'mag_command_parsed',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
  });
  assert.equal(sandbox.iframe_events.GENERATION_ENDED, 'js_generation_ended');
  for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'APP_READY']) assert.equal(typeof sandbox.tavern_events[name], 'string', name);
  assert.equal(sandbox.getCharWorldbookNames('current').primary, '样卡的世界书');
  const [row] = sandbox.getChatMessages(-1);
  assert.equal(row.name, '样卡');
  assert.equal(row.data.stat_data.主角.生命, 62);
  assert.equal(await sandbox.generate({ user_input: '写一段' }), SIM_GENERATED);
  await sandbox.triggerSlash('/echo 你好');
  await sandbox.createChatMessages([{ role: 'user', message: '你好' }]);
  sandbox.initializeGlobal('卡片工具', { ok: true });
  assert.deepEqual(plain(await sandbox.waitGlobalInitialized('卡片工具')), { ok: true });
  await sandbox.navigator.clipboard.write([]);
  assert.deepEqual(writes().map(item => item.kind), ['提示', '生成', '命令', '消息', '命令', '剪贴板']);
});

test('values that would end the inline script, or put the parser in its escaped state, are escaped; the JSON still reads as written', () => {
  const script = tavernSimScript({ cardName: '样卡</script>', statData: { 注: '</script><b>x</b>', 旧: '<!--<script>' } });
  assert.ok(!/<\/script/i.test(script), 'no closing script tag inside the inline script');
  assert.ok(!script.includes('<!--'), 'no comment opener either');
  assert.match(tavernSimScript({ cardName: '样卡', statData: { 生命: 100 } }), /"生命":100/);
  const { sandbox } = boot({ 注: '</script>', 旧: '<!--<script>' });
  assert.deepEqual(plain(sandbox.Mvu.getMvuData().stat_data), { 注: '</script>', 旧: '<!--<script>' }, 'the values survive the escaping');
});

test('the sample variables are inlined as data: a __proto__ key survives, and what cannot be serialized falls back to empty with one error', () => {
  const withProto = boot(JSON.parse('{"__proto__":{"x":1},"a":1}'));
  const stat = withProto.sandbox.Mvu.getMvuData().stat_data;
  assert.ok(Object.prototype.hasOwnProperty.call(stat, '__proto__'), 'an own key, not the prototype');
  assert.equal(JSON.stringify(stat), '{"__proto__":{"x":1},"a":1}');
  const cyclic: Record<string, unknown> = { a: 1 }; cyclic.self = cyclic;
  for (const statData of [cyclic, { n: 10n }]) {
    const { sandbox, errors } = boot(statData);
    assert.deepEqual(plain(sandbox.Mvu.getMvuData().stat_data), {});
    assert.deepEqual(errors(), ['样例变量没法序列化，按空变量预览']);
  }
});
