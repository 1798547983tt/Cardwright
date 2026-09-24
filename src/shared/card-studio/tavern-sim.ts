// src/shared/card-studio/tavern-sim.ts
/**
 * 模拟酒馆 (Q3, ADR 0019): the globals 酒馆助手 4.x injects into a front-end iframe, stood in for inside the studio's
 * preview. Reads come from the sample variables; every write is recorded and posted to the studio as 「将写入」,
 * nothing is executed. Names and shapes follow knowledge/50 and knowledge/60 and 酒馆助手's own type declarations; the
 * MVU event names are MVU's own, its spelling included.
 *
 * The script runs first in the preview document, before any script of the card's, and keeps what it needs from the
 * window at boot: a card that declares its own `parent` (a function, a var, a top-level let) cannot cut it off.
 */
export interface TavernSimOptions {
  cardName: string; statData: unknown; messageId?: number; lastMessageId?: number;
  /** The card's primary world book, as getCharWorldbookNames reports it: the card name when not given, null for none. */
  bookName?: string | null;
}
/** The key of a message the studio posts into the frame to replace the sample variables. */
export const SIM_MESSAGE = 'cardwrightSim';
/** Every message a preview document posts to the studio carries this key: the reporter's and the sim's. */
export const PREVIEW_MESSAGE_KEY = 'cardwrightPreview';
/** What a recorded write would touch. */
export type SimWriteKind = '聊天世界书' | '主世界书' | '输入框' | '剪贴板' | '变量' | '消息' | '提示' | '生成' | '命令';
/**
 * One record of 「将写入」, posted as `{ [PREVIEW_MESSAGE_KEY]: 1, write }`. The same record again right after it comes
 * as an update of its id with a higher count (the detail ends in ` ×N`), so the panel replaces the record it holds.
 * After 200 records one more says 「后面的写入省略了」 and nothing further is posted. A simulated update from the
 * studio is not a write: it is posted as `{ [PREVIEW_MESSAGE_KEY]: 1, simulated: 1 }`.
 */
export interface SimWrite { id: number; kind: SimWriteKind; detail: string; count: number }
export const SIM_GENERATED = '（模拟酒馆：这里会是模型生成的内容）';

/** The sample variables as JSON; what JSON cannot hold (a cycle, a BigInt) previews as empty variables. */
function sampleJson(statData: unknown): { json: string; broken: boolean } {
  try {
    return { json: JSON.stringify(statData ?? {}) ?? '{}', broken: false };
  } catch {
    return { json: '{}', broken: true };
  }
}

/**
 * JSON text as a single-quoted string literal for an inline <script>, read back with JSON.parse: an object literal
 * would turn a `__proto__` key from [initvar] into a prototype. Backslashes and single quotes are escaped for the
 * literal, and `</` and `<!` are broken up so a value can neither close the element nor put the parser in its escaped
 * script state. The JSON's own double quotes stay as they are, so `"生命":100` still reads as written.
 */
function scriptLiteral(json: string): string {
  return `'${json.replace(/[\\']/g, char => `\\${char}`).replace(/<(?=[\/!])/g, '<\\')}'`;
}

export function tavernSimScript(options: TavernSimOptions): string {
  const sample = sampleJson(options.statData);
  const messageId = options.messageId ?? 3;
  const settings = JSON.stringify({
    messageId, lastMessageId: options.lastMessageId ?? messageId, cardName: options.cardName,
    bookName: options.bookName === undefined ? options.cardName : options.bookName,
  });
  const state = scriptLiteral(`{"stat_data":${sample.json},${settings.slice(1)}`);
  const broken = sample.broken ? "\n  post({ error: '样例变量没法序列化，按空变量预览' });" : '';
  return String.raw`(() => {
  // The parent as it is before the card runs: a card that declares its own parent cannot cut the studio off.
  const host = window.parent;
  const post = data => { try { host.postMessage(Object.assign({ ${PREVIEW_MESSAGE_KEY}: 1 }, data), '*'); } catch (ignored) {} };
  const state = JSON.parse(${state});${broken}
  const isPlain = value => Object.prototype.toString.call(value) === '[object Object]';
  const own = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
  // A __proto__ key in the data stays a key: it is defined, never assigned.
  const put = (target, key, value) => { if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }); else target[key] = value; };
  const asText = value => { try { return String(value); } catch (ignored) { return ''; } };
  // What a card hands over is shown and copied without throwing at its call: a cycle or a BigInt degrades instead.
  const show = value => {
    if (typeof value === 'string') return value;
    try { const text = JSON.stringify(value); if (text !== undefined) return text; } catch (ignored) {}
    return asText(value);
  };
  const clone = value => {
    try { const text = JSON.stringify(value); return text === undefined ? null : JSON.parse(text); }
    catch (ignored) { post({ error: '有个值没法序列化（循环引用或 BigInt），模拟酒馆按空值处理' }); return null; }
  };
  const report = error => post({ error: show(error && error.message ? error.message : error).slice(0, 300) });

  // 「将写入」: the same record again right after it becomes one with a count; after 200 there is a marker and no more.
  let recorded = 0;
  let last = null;
  let capped = false;
  const record = (kind, detail) => {
    if (capped) return;
    const text = show(detail).slice(0, 400);
    if (last && last.kind === kind && last.detail === text) {
      last.count += 1;
      post({ write: { id: last.id, kind, detail: text + ' ×' + last.count, count: last.count } });
      return;
    }
    if (recorded >= 200) {
      capped = true;
      post({ write: { id: recorded + 1, kind: '提示', detail: '后面的写入省略了', count: 1 } });
      return;
    }
    recorded += 1;
    last = { id: recorded, kind, detail: text, count: 1 };
    post({ write: { id: recorded, kind, detail: text, count: 1 } });
  };

  // Globals. Every function is on TavernHelper too, as 酒馆助手 has them in both places.
  const helper = {};
  const expose = (name, value) => {
    try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); }
    catch (error) { post({ error: '模拟酒馆没能提供 ' + asText(name) + '：' + show(error && error.message) }); }
  };
  const define = (name, value) => { helper[name] = value; expose(name, value); };

  // Events as 酒馆助手 keeps them: one registration per event and listener, found by the listener it was given.
  const buckets = new Map();
  const entriesOf = name => buckets.get(name) || [];
  const findEntry = (name, listener) => entriesOf(name).find(entry => entry.listener === listener);
  const drop = (name, entry) => { const list = entriesOf(name); const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1); };
  const handleOf = (name, entry) => ({ stop: () => drop(name, entry) });
  const subscribe = (name, listener, place, once) => {
    if (typeof name !== 'string' || typeof listener !== 'function') return { stop: () => {} };
    if (!buckets.has(name)) buckets.set(name, []);
    const found = findEntry(name, listener);
    if (found && place === 'on') return handleOf(name, found);
    if (found) drop(name, found);
    const entry = found || { listener, run: listener, fired: false };
    if (!found && once) entry.run = (...args) => { if (entry.fired) return undefined; entry.fired = true; drop(name, entry); return listener(...args); };
    if (place === 'first') buckets.get(name).unshift(entry); else buckets.get(name).push(entry);
    return handleOf(name, entry);
  };
  // The listeners run in order from a snapshot, each awaited on its own: one that throws or rejects is reported, the next still runs.
  const eventEmit = (name, ...args) => {
    const snapshot = entriesOf(name).slice();
    return (async () => { for (const entry of snapshot) { try { await entry.run(...args); } catch (error) { report(error); } } })();
  };
  define('eventOn', (name, listener) => subscribe(name, listener, 'on', false));
  define('eventOnce', (name, listener) => subscribe(name, listener, 'on', true));
  define('eventMakeFirst', (name, listener) => subscribe(name, listener, 'first', false));
  define('eventMakeLast', (name, listener) => subscribe(name, listener, 'last', false));
  define('eventRemoveListener', (name, listener) => { const found = findEntry(name, listener); if (found) drop(name, found); });
  define('eventClearEvent', name => { buckets.delete(name); });
  define('eventClearListener', listener => { for (const name of [...buckets.keys()]) { const found = findEntry(name, listener); if (found) drop(name, found); } });
  define('eventClearAll', () => { buckets.clear(); });
  define('eventEmit', eventEmit);
  define('eventEmitAndWait', eventEmit);
  expose('tavern_events', {
    APP_READY: 'app_ready', MESSAGE_RECEIVED: 'message_received', MESSAGE_SENT: 'message_sent', MESSAGE_UPDATED: 'message_updated',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPED: 'message_swiped',
    USER_MESSAGE_RENDERED: 'user_message_rendered', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped', STREAM_TOKEN_RECEIVED: 'stream_token_received', WORLDINFO_UPDATED: 'worldinfo_updated',
    SETTINGS_LOADED: 'settings_loaded',
  });
  expose('iframe_events', {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended',
  });
  define('waitGlobalInitialized', name => Promise.resolve(window[name]));
  define('initializeGlobal', (name, value) => { expose(asText(name), value); record('命令', 'initializeGlobal ' + asText(name)); });
  define('getCurrentMessageId', () => state.messageId);
  define('getLastMessageId', () => state.lastMessageId);

  // Variables by scope. message and chat share the sample stat_data (one MVU state for the preview); the others start empty.
  const SCOPES = ['message', 'chat', 'global', 'script', 'character', 'preset', 'extension'];
  const scopeOf = (options, fallback) => { const type = options && typeof options === 'object' ? options.type : undefined; return SCOPES.indexOf(type) >= 0 ? type : fallback; };
  const makeTable = (scope, value) => {
    const table = {};
    if (scope === 'message' || scope === 'chat') Object.defineProperty(table, 'stat_data', { get: () => state.stat_data, set: next => { state.stat_data = next; }, enumerable: true, configurable: true });
    if (isPlain(value)) for (const key of Object.keys(value)) put(table, key, value[key]);
    return table;
  };
  const tables = Object.create(null);
  for (const scope of SCOPES) tables[scope] = makeTable(scope, {});
  // Objects merge key by key; anything else, arrays included, is replaced (or kept, when overwrite is off).
  const merge = (target, source, overwrite) => {
    for (const key of Object.keys(source)) {
      const next = source[key];
      if (own(target, key) && isPlain(target[key]) && isPlain(next)) merge(target[key], next, overwrite);
      else if (overwrite || !own(target, key)) put(target, key, next);
    }
    return target;
  };
  const where = options => show(options || {});
  define('getVariables', options => clone(tables[scopeOf(options, 'chat')]));
  define('insertOrAssignVariables', (value, options) => {
    const scope = scopeOf(options, 'chat');
    const source = clone(value);
    if (isPlain(source)) merge(tables[scope], source, true);
    record('变量', 'insertOrAssignVariables ' + where(options) + ' ' + show(value));
    return clone(tables[scope]);
  });
  define('insertVariables', (value, options) => {
    const scope = scopeOf(options, 'chat');
    const source = clone(value);
    if (isPlain(source)) merge(tables[scope], source, false);
    record('变量', 'insertVariables ' + where(options) + ' ' + show(value));
    return clone(tables[scope]);
  });
  define('replaceVariables', (value, options) => {
    const scope = scopeOf(options, 'chat');
    tables[scope] = makeTable(scope, clone(value));
    record('变量', 'replaceVariables ' + where(options) + ' ' + show(value));
    return clone(tables[scope]);
  });
  // A sync updater gets the new table back at once and an async one a promise of it, as with 酒馆助手's two overloads.
  define('updateVariablesWith', (updater, options) => {
    const scope = scopeOf(options, 'chat');
    const store = result => {
      if (!isPlain(result)) throw new TypeError('updateVariablesWith 的更新函数要返回新的变量对象。');
      tables[scope] = makeTable(scope, clone(result));
      record('变量', 'updateVariablesWith ' + where(options) + ' ' + show(result));
      return clone(tables[scope]);
    };
    const result = updater(clone(tables[scope]));
    return result && typeof result.then === 'function' ? Promise.resolve(result).then(store) : store(result);
  });
  // Paths as lodash reads them, a.b.c and a[0].b; only own keys are followed.
  define('deleteVariable', (path, options) => {
    const scope = scopeOf(options, 'chat');
    const keys = asText(path).replace(/\[(\d+)\]/g, (whole, index) => '.' + index).split('.').filter(key => key !== '');
    let target = tables[scope];
    for (let at = 0; target && at < keys.length - 1; at += 1) target = own(target, keys[at]) && target[keys[at]] !== null && typeof target[keys[at]] === 'object' ? target[keys[at]] : null;
    const key = keys[keys.length - 1];
    const deleted = !!target && keys.length > 0 && own(target, key);
    if (deleted) { delete target[key]; record('变量', 'deleteVariable ' + where(options) + ' ' + asText(path)); }
    return { variables: clone(tables[scope]), delete_occurred: deleted };
  });
  const Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData: () => ({ initialized_lorebooks: {}, stat_data: clone(state.stat_data) }),
    replaceMvuData: (data, options) => {
      const scope = scopeOf(options, 'message');
      const copy = clone(data);
      tables[scope] = makeTable(scope, copy);
      record('变量', 'replaceMvuData ' + where(options) + ' ' + show(copy && copy.stat_data));
      return Promise.resolve();
    },
    parseMessage: (message, old) => Promise.resolve(clone(old)),
    isDuringExtraAnalysis: () => false,
  };
  expose('Mvu', Mvu);

  // World books, in memory by name, with SillyTavern's rules for what the calls take.
  const books = Object.create(null);
  if (typeof state.bookName === 'string') books[state.bookName] = [];
  let chatBook = null;
  const bookKind = name => (name === chatBook ? '聊天世界书' : '主世界书');
  const names = list => list.map(entry => (entry && entry.name) || '（无名条目）').join('、');
  const refuse = message => Promise.reject(new TypeError(message));
  define('getCharWorldbookNames', () => ({ primary: state.bookName, additional: [] }));
  define('getChatWorldbookName', () => chatBook);
  define('getOrCreateChatWorldbook', (chat, name) => {
    chatBook = chatBook || (typeof name === 'string' && name ? name : state.cardName + ' · 存档');
    if (!books[chatBook]) books[chatBook] = [];
    record('聊天世界书', '建立或取得「' + chatBook + '」');
    return Promise.resolve(chatBook);
  });
  define('getWorldbook', name => (typeof name === 'string' ? Promise.resolve(clone(books[name] || [])) : refuse('getWorldbook 要一个世界书名字。')));
  // The updater gets a copy and has to return the entries: SillyTavern refuses anything else, so the preview does too.
  define('updateWorldbookWith', (name, updater) => {
    if (typeof name !== 'string') return refuse('updateWorldbookWith 要一个世界书名字。');
    const before = clone(books[name] || []) || [];
    return new Promise(resolve => resolve(updater(clone(before)))).then(after => {
      if (!Array.isArray(after)) throw new TypeError('updateWorldbookWith 的更新函数要返回条目数组。');
      const list = clone(after) || [];
      books[name] = list;
      const same = (one, other) => !!one && !!other && one.name === other.name && one.content === other.content;
      const changed = list.filter(entry => !before.some(old => same(old, entry)));
      const kept = new Set(list.map(entry => entry && entry.name));
      const removed = before.filter(entry => !kept.has(entry && entry.name));
      const shown = changed.length ? ' ｜ ' + show((changed[0] && changed[0].content) || '').slice(0, 200) : '';
      record(bookKind(name), '「' + name + '」' + (changed.length ? '新增或修改：' + names(changed) : '条目没有变化') + (removed.length ? '；删除：' + names(removed) : '') + shown);
      return clone(list);
    });
  });
  define('createWorldbookEntries', (name, entries) => {
    if (typeof name !== 'string') return refuse('createWorldbookEntries 要一个世界书名字。');
    if (!Array.isArray(entries)) return refuse('createWorldbookEntries 要一个条目数组。');
    const added = clone(entries) || [];
    books[name] = (books[name] || []).concat(added);
    record(bookKind(name), '「' + name + '」新增 ' + added.length + ' 条：' + names(added));
    return Promise.resolve({ worldbook: clone(books[name]), new_entries: clone(added) });
  });
  define('replaceWorldbook', (name, entries) => {
    if (typeof name !== 'string') return refuse('replaceWorldbook 要一个世界书名字。');
    if (!Array.isArray(entries)) return refuse('replaceWorldbook 要一个条目数组。');
    books[name] = clone(entries) || [];
    record(bookKind(name), '「' + name + '」整本换成 ' + books[name].length + ' 条：' + names(books[name]));
    return Promise.resolve();
  });
  define('deleteWorldbookEntries', (name, predicate) => {
    if (typeof name !== 'string') return refuse('deleteWorldbookEntries 要一个世界书名字。');
    return new Promise(resolve => {
      const kept = [];
      const deleted = [];
      for (const entry of books[name] || []) (predicate(clone(entry)) ? deleted : kept).push(entry);
      books[name] = kept;
      if (deleted.length) record(bookKind(name), '「' + name + '」删除 ' + deleted.length + ' 条：' + names(deleted));
      resolve({ worldbook: clone(kept), deleted_entries: clone(deleted) });
    });
  });

  // Messages, generation and commands: recorded; a generation answers with the fixed text.
  const reply = ${JSON.stringify(SIM_GENERATED)};
  const asked = (call, config) => call + (config && config.user_input ? '：' + show(config.user_input) : '');
  define('generate', config => { record('生成', asked('generate', config)); return Promise.resolve(reply); });
  define('generateRaw', config => { record('生成', asked('generateRaw', config)); return Promise.resolve(reply); });
  define('triggerSlash', command => { record('命令', asText(command)); return Promise.resolve(''); });
  define('getChatMessages', () => [{ message_id: state.messageId, name: state.cardName, role: 'assistant', is_hidden: false, message: '', data: clone(tables.message), extra: {} }]);
  define('setChatMessages', messages => { record('消息', 'setChatMessages ' + show(messages)); return Promise.resolve(); });
  define('createChatMessages', messages => { record('消息', 'createChatMessages ' + show(messages)); return Promise.resolve(); });

  const toast = (message, title) => { record('提示', (title === undefined || title === null || title === '' ? '' : show(title) + '：') + show(message === undefined ? '' : message)); };
  expose('toastr', { success: toast, info: toast, warning: toast, error: toast, clear: () => {}, remove: () => {}, subscribe: () => {}, getContainer: () => null, options: {} });
  // SillyTavern is the context itself, as 酒馆助手 exposes it: SillyTavern.getCurrentChatId() and SillyTavern.getContext() both work.
  const context = { name1: '玩家', name2: state.cardName, chat: [], chatMetadata: {}, getCurrentChatId: () => 'preview', getContext: () => context };
  expose('SillyTavern', context);
  let copied = '';
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: text => { copied = asText(text); record('剪贴板', copied); return Promise.resolve(); },
        write: items => { record('剪贴板', '写入 ' + (Array.isArray(items) ? items.length : 0) + ' 项非文本内容'); return Promise.resolve(); },
        readText: () => Promise.resolve(copied),
      },
    });
  } catch (ignored) {}

  // The composer stand-in hangs off the root element from the start: outside the body, so the card's layout and
  // :last-child rules never see it, and a card that rewrites its body cannot take it away. A send empties it, as there.
  try {
    if (!document.getElementById('send_textarea')) {
      const box = document.createElement('div');
      box.hidden = true;
      box.setAttribute('style', 'display:none!important');
      const area = document.createElement('textarea');
      area.id = 'send_textarea';
      const button = document.createElement('button');
      button.id = 'send_but';
      button.type = 'button';
      button.addEventListener('click', () => { record('输入框', '发送：' + asText(area.value)); area.value = ''; });
      box.appendChild(area);
      box.appendChild(button);
      (document.documentElement || document.body).appendChild(box);
    }
  } catch (error) { report(error); }

  // The studio's 「模拟一次更新」: only from this frame's own parent, only a plain object of variables.
  addEventListener('message', event => {
    if (!event || event.source !== host) return;
    const data = event.data;
    if (!data || data.${SIM_MESSAGE} !== 1 || !isPlain(data.statData)) return;
    const before = state.stat_data;
    state.stat_data = clone(data.statData) || {};
    eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, { initialized_lorebooks: {}, stat_data: clone(state.stat_data) }, { initialized_lorebooks: {}, stat_data: clone(before) });
    post({ simulated: 1 });
  });
  expose('TavernHelper', helper);
})();`;
}
