/*
 * Cardwright 前端骨架 · 运行时宿主：等 MVU、读变量、订阅更新、只画最新一楼、错误面板、创角页的提交事务。依赖 core.js。
 * 顶层不碰 document / window / navigator：Node 的 vm 只给 setTimeout 也能加载，纯函数都放在 CardwrightHost.helpers 里测。
 * 酒馆助手的全局函数一律在调用时经 root 取，不在加载时捕获：真实酒馆和模拟酒馆都可能晚一步注入。
 */
(function (root) {
  'use strict';
  const core = root.CardwrightCore;
  const g = name => (typeof root[name] === 'function' ? root[name] : null);
  const disposers = [];
  const log = (tag, ...rest) => { try { console.log('[' + tag + ']', ...rest); } catch (ignored) {} };

  /* ---- 纯函数（helpers）：Node 的 vm 直接测这些 ---- */
  /** 把 {键} 占位换成草稿里的值：数组用顿号连起来，缺的留空，再抹掉行尾空白。 */
  function fillTemplate(template, draft) {
    return String(template || '').replace(/\{([^{}]+)\}/g, (whole, key) => { const value = draft[key]; return value === undefined || value === null ? '' : Array.isArray(value) ? value.join('、') : String(value); }).replace(/[ \t]+\n/g, '\n');
  }
  /** 创角页写进世界书的条目形状：常驻、排在角色定义之前。 */
  const entryOf = (name, content) => ({ name, enabled: true, strategy: { type: 'constant' }, position: { type: 'before_character_definition', order: 100 }, content });
  /** 更新同名条目，或追加到末尾；不改传入的数组。 */
  function upsertEntry(entries, entry) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const at = list.findIndex(item => item && item.name === entry.name);
    if (at >= 0) list[at] = Object.assign({}, list[at], entry); else list.push(entry);
    return list;
  }
  /** 把一个位置夹回视口内（悬浮球和面板的拖动记位共用）。 */
  function clampPosition(position, viewport, size) {
    return { x: Math.max(0, Math.min(viewport.width - size, Math.round(position.x))), y: Math.max(0, Math.min(viewport.height - size, Math.round(position.y))) };
  }
  /** 等酒馆助手把 Mvu 初始化好，超时就不等了；返回现在有没有可用的 Mvu。 */
  async function waitMvu(timeoutMs) {
    const wait = g('waitGlobalInitialized');
    if (wait) {
      let timer;
      try { await Promise.race([Promise.resolve(wait('Mvu')), new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); })]); } catch (ignored) {}
      clearTimeout(timer);
    }
    return !!(root.Mvu && typeof root.Mvu.getMvuData === 'function');
  }
  /** 读最新一楼的 stat_data：先 Mvu，再 getVariables，都没有就给空对象。 */
  function readData() {
    try {
      if (root.Mvu && typeof root.Mvu.getMvuData === 'function') {
        const data = root.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
        return (data && data.stat_data) || {};
      }
    } catch (error) { log('骨架', '读 MVU 失败', error); }
    try {
      const read = g('getVariables');
      if (read) { const data = read({ type: 'message', message_id: 'latest' }); return (data && data.stat_data) || {}; }
    } catch (error) { log('骨架', '读变量失败', error); }
    return {};
  }
  /** 自己是不是最新一楼；拿不到楼层接口时当成是。 */
  const isLatest = () => {
    const current = g('getCurrentMessageId'); const last = g('getLastMessageId');
    if (!current || !last) return true;
    try { return current() === last(); } catch (ignored) { return true; }
  };
  /** 按 JSON Pointer 逐级建对象再赋值：setAt(data, '/主角/出身', '渔民')。 */
  function setAt(object, pointer, value) {
    if (!object || typeof object !== 'object') return;
    const keys = String(pointer || '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length || keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) return;
    let current = object;
    for (let index = 0; index < keys.length - 1; index++) {
      const key = keys[index];
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
  }

  /* ---- 事件订阅：返回值全部进 disposers，换聊天时一起停掉 ---- */
  function listen(name, handler) {
    const on = g('eventOn');
    if (!on || name === undefined || name === null) return;
    try { const handle = on(name, handler); if (handle && typeof handle.stop === 'function') disposers.push(handle); } catch (error) { log('骨架', '订阅失败', name, error); }
  }
  function dispose() {
    while (disposers.length) { const handle = disposers.pop(); try { handle.stop(); } catch (ignored) {} }
  }

  /* ---- 复制与错误面板 ---- */
  function copyText(text) {
    const fallback = () => {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        return true;
      } catch (error) { log('骨架', '复制失败', error); return false; }
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') return navigator.clipboard.writeText(text).catch(fallback);
    } catch (ignored) {}
    return Promise.resolve(fallback());
  }
  /** 错误面板：写清哪一步、什么错，带【复制报错】；只追加或替换旧面板，不清掉页面上已有的内容（表单要留住）。 */
  function errorPanel(mount, tag, step, error) {
    const target = mount || document.body;
    log(tag, step, error);
    const message = error && error.message ? String(error.message) : String(error);
    const report = '[' + tag + '] ' + step + '：' + message + (error && error.stack ? '\n' + String(error.stack) : '');
    const old = target.querySelector('.cw-error');
    if (old) old.remove();
    const panel = document.createElement('section');
    panel.className = 'cw-error';
    panel.innerHTML = '<b>' + core.escape(step) + '出错</b><p>' + core.escape(message) + '</p><button type="button" class="cw-btn" data-cw-copy>复制报错</button>';
    panel.addEventListener('click', event => { const button = event.target && event.target.closest ? event.target.closest('[data-cw-copy]') : null; if (button) copyText(report); });
    target.appendChild(panel);
  }

  /* ---- 状态栏（placeholder 与 header 共用；正文美化的状态头也走这里）---- */
  function mountStatus(mount, sheet, tag) {
    let latest = null; let previous = null; let page = 0; let collapsed = !!sheet.collapsed;
    const draw = data => {
      try {
        if (data !== latest) { previous = latest; latest = data; }
        const summary = sheet.summary && sheet.summary.length ? core.renderSummary(sheet, latest || {}) : '';
        const header = '<header class="cw-status-bar">' + (sheet.title ? '<span class="cw-status-title">' + core.escape(sheet.title) + '</span>' : '') + '<span class="cw-summary">' + summary + '</span>' + '<button type="button" class="cw-toggle" data-cw-toggle>' + (collapsed ? '展开' : '收起') + '</button></header>';
        let body = '';
        if (!collapsed) {
          const rendered = core.renderPages(sheet, latest || {}, previous);
          if (!(page >= 0 && page < rendered.pages.length)) page = 0;
          const tabs = rendered.pages.map((item, index) => '<button type="button" class="cw-tab' + (index === page ? ' is-on' : '') + '" data-cw-page="' + index + '">' + item.icon + '<span>' + core.escape(item.name) + '</span></button>').join('');
          const current = rendered.pages[page];
          body = '<nav class="cw-tabs">' + tabs + '</nav><div class="cw-page">' + (current ? current.html : '') + '</div>';
        }
        mount.innerHTML = '<div class="cw-status' + (collapsed ? ' is-collapsed' : '') + '">' + header + body + '</div>';
      } catch (error) { errorPanel(mount, tag, '渲染', error); }
    };
    mount.addEventListener('click', event => {
      const target = event.target && event.target.closest ? event.target.closest('[data-cw-toggle], [data-cw-page]') : null;
      if (!target) return;
      if (target.hasAttribute('data-cw-toggle')) collapsed = !collapsed;
      else page = Number(target.getAttribute('data-cw-page')) || 0;
      draw(latest === null ? readData() : latest);
    });
    return { draw, hide: () => { mount.textContent = ''; } };
  }
  /** 挂一个状态栏：旧楼层不画，等 MVU，订阅更新，收到新消息后不是最新楼就收起。 */
  async function runStatus(mount, sheet, tag) {
    if (!mount) throw new Error('文档里没有状态栏的挂载点。');
    if (!isLatest()) { mount.textContent = ''; return; }
    const view = mountStatus(mount, sheet, tag);
    const hideIfOld = () => { if (!isLatest()) { view.hide(); dispose(); } };
    await waitMvu(2500);
    view.draw(readData());
    if (root.Mvu && root.Mvu.events) listen(root.Mvu.events.VARIABLE_UPDATE_ENDED, after => view.draw((after && after.stat_data) || readData()));
    if (root.tavern_events) {
      listen(root.tavern_events.MESSAGE_RECEIVED, hideIfOld);
      listen(root.tavern_events.MESSAGE_SENT, hideIfOld);
      /* 换聊天时酒馆会重建各楼的 iframe，本文档马上作废：全部停掉、按新聊天补画一次就够，不重新订阅。 */
      listen(root.tavern_events.CHAT_CHANGED, () => { dispose(); view.draw(readData()); });
    }
  }
  async function bootStatus(sheet, tag) {
    await runStatus(document.getElementById('cw-app'), sheet, tag);
  }

  /* ---- 正文美化：一次性渲染捕获的正文；#cw-source 是 hidden 的 textarea（捕获文本里的闭合脚本标签截不断文档，textContent 读到的就是原文）；开了状态头就在 #cw-status-head 里再挂一个状态栏 ---- */
  async function bootBody(sheet, tag) {
    const mount = document.getElementById('cw-app');
    if (!mount) throw new Error('文档里没有正文的挂载点。');
    const source = document.getElementById('cw-source');
    try { mount.innerHTML = core.renderBody(sheet, source ? source.textContent : ''); } catch (error) { errorPanel(mount, tag, '渲染', error); }
    if (sheet.statusHead && sheet.statusHead.pages) {
      const head = document.getElementById('cw-status-head');
      if (head) await runStatus(head, sheet.statusHead, tag);
    }
  }

  /* ---- 创角页 ---- */
  /** 酒馆的输入框：先找父窗口（真实酒馆），沙箱里 window.parent 会抛错，退回本文档（模拟酒馆放了一个）。 */
  function composer() {
    let doc = null;
    try { doc = window.parent && window.parent !== window ? window.parent.document : null; } catch (ignored) { doc = null; }
    const pick = d => d && { textarea: d.querySelector('#send_textarea'), send: d.querySelector('#send_but') };
    const found = pick(doc);
    return found && found.textarea ? found : pick(document);
  }
  /** 提交事务，顺序固定：① 玩家设定进世界书 ② 开场信息进输入框 ③ 初始变量写进 MVU。返回给玩家看的提示。
      state 跨重试保留：点过发送就不再发第二遍（① 经 upsertEntry 天然幂等，③ 失败只提示、不中断）。 */
  async function submit(sheet, draft, tag, state) {
    const notes = [];
    if (sheet.writes.entry) {
      const content = fillTemplate(sheet.writes.entry.template, draft);
      const create = g('getOrCreateChatWorldbook'); const update = g('updateWorldbookWith'); const names = g('getCharWorldbookNames');
      let book = null;
      if (create) { book = await create('current', sheet.cardName + ' · 存档'); }
      else if (names) { const bound = await names('current'); book = bound && bound.primary; notes.push('这个酒馆版本没有聊天世界书，玩家设定写进了角色主世界书。'); }
      if (!book || !update) throw new Error('没有可写的世界书接口。');
      await update(book, entries => upsertEntry(entries, entryOf(sheet.writes.entry.name, content)));
    }
    if (sheet.writes.opening && !state.openingSent) {
      const text = fillTemplate(sheet.writes.opening, draft); const box = composer();
      if (box && box.textarea && !box.textarea.value.trim()) {
        box.textarea.value = text;
        box.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (box.send) box.send.click();
        state.openingSent = true;
      }
      else { try { await navigator.clipboard.writeText(text); notes.push('输入框里已有内容，开场信息已复制到剪贴板，请自己粘贴。'); } catch (ignored) { notes.push('开场信息没能填入输入框，请手动复制：' + text); } }
    }
    if (sheet.writes.variables) {
      await waitMvu(2500);
      if (root.Mvu && typeof root.Mvu.replaceMvuData === 'function') {
        try {
          const data = root.Mvu.getMvuData({ type: 'message', message_id: 'latest' }) || { stat_data: {} };
          if (!data.stat_data || typeof data.stat_data !== 'object') data.stat_data = {};
          for (const field of sheet.steps.flatMap(step => step.fields)) if (field.write && draft[field.key] !== undefined) setAt(data.stat_data, field.write, draft[field.key]);
          await root.Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' });
          await root.Mvu.replaceMvuData(data, { type: 'chat' });
        } catch (error) { log(tag, '初始变量', error); notes.push('初始变量写入失败；进入游戏后让模型重算一次即可。'); }
      } else notes.push('MVU 没有就绪，初始变量没有写入；进入游戏后让模型重算一次即可。');
    }
    return notes;
  }
  async function bootStart(sheet, tag) {
    const mount = document.getElementById('cw-app');
    if (!mount) throw new Error('文档里没有创角页的挂载点。');
    const draft = {};
    const progress = { openingSent: false };
    let at = 0;
    let busy = false;
    /* 滑杆一渲染就有可见的值，把它先记进草稿，免得核对页写「未填」。 */
    const seed = () => { if (at >= sheet.steps.length) return; for (const field of sheet.steps[at].fields) if (field.type === '滑杆' && field.range && draft[field.key] === undefined) draft[field.key] = field.range[0]; };
    const render = () => { try { seed(); mount.innerHTML = core.renderStart(sheet, draft, at); } catch (error) { errorPanel(mount, tag, '渲染', error); } };
    const missing = () => {
      const bad = [];
      if (at >= sheet.steps.length) return bad;
      for (const field of sheet.steps[at].fields) {
        if (!field.required) continue;
        const value = draft[field.key];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) bad.push(field.key);
      }
      return bad;
    };
    const markInvalid = bad => {
      const controls = mount.querySelectorAll('[data-cw-field]');
      for (const control of controls) {
        if (bad.indexOf(control.getAttribute('data-cw-field')) < 0) continue;
        const row = control.closest('.cw-field-row');
        (row || control).classList.add('is-invalid');
      }
    };
    /* 不整页重画（文本框会丢焦点），只同步选中态与滑杆读数。 */
    const reflect = target => {
      if (target.type === 'radio' || target.type === 'checkbox') {
        const holder = target.closest('.cw-choices');
        if (!holder) return;
        for (const input of holder.querySelectorAll('input')) { const choice = input.closest('.cw-choice'); if (choice) choice.classList.toggle('is-on', input.checked); }
      } else if (target.type === 'range') {
        const output = target.nextElementSibling;
        if (output && output.classList && output.classList.contains('cw-slider-value')) output.textContent = String(target.value);
      }
    };
    const collect = target => {
      const key = target.getAttribute('data-cw-field');
      if (!key) return;
      const row = target.closest('.cw-field-row');
      if (row) row.classList.remove('is-invalid');
      if (target.type === 'checkbox') {
        const list = Array.isArray(draft[key]) ? draft[key].slice() : [];
        const max = Number(target.getAttribute('data-cw-max')) || 0;
        const found = list.indexOf(target.value);
        if (target.checked && found < 0) { if (max && list.length >= max) target.checked = false; else list.push(target.value); }
        if (!target.checked && found >= 0) list.splice(found, 1);
        draft[key] = list;
      } else if (target.type === 'range') draft[key] = Number(target.value);
      else draft[key] = target.value;
      reflect(target);
    };
    const onEdit = event => { const target = event.target; if (target && target.getAttribute && target.getAttribute('data-cw-field')) collect(target); };
    mount.addEventListener('input', onEdit);
    mount.addEventListener('change', onEdit);
    mount.addEventListener('click', event => {
      const target = event.target && event.target.closest ? event.target.closest('[data-cw-nav]') : null;
      if (!target || busy) return;
      const nav = target.getAttribute('data-cw-nav');
      if (nav === 'back' && at > 0) { at -= 1; render(); }
      else if (nav === 'next') {
        const bad = missing();
        if (bad.length) { markInvalid(bad); return; }
        at += 1; render();
      } else if (nav === 'submit') {
        busy = true; target.disabled = true;
        submit(sheet, draft, tag, progress).then(notes => {
          busy = false;
          const items = (notes || []).map(note => '<li>' + core.escape(note) + '</li>').join('');
          mount.innerHTML = '<section class="cw-done"><b>' + core.escape(sheet.title || '创角完成') + '</b><p>设定已写好，开始你的故事吧。</p>' + (items ? '<ul>' + items + '</ul>' : '') + '</section>';
        }).catch(error => { busy = false; target.disabled = false; errorPanel(mount, tag, '提交', error); });
      }
    });
    render();
  }

  /* ---- 入口：读 #cw-sheet，按种类分支 ---- */
  function boot() {
    const begin = () => {
      const holder = document.getElementById('cw-sheet');
      let sheet;
      try { sheet = JSON.parse(holder.textContent); } catch (error) { errorPanel(document.body, '骨架', '解析装配单', error); return; }
      const tag = (sheet.cardName || '卡') + '·' + (sheet.kind || '前端');
      const run = sheet.kind === '状态栏' ? bootStatus : sheet.kind === '正文美化' ? bootBody : bootStart;
      run(sheet, tag).catch(error => errorPanel(document.getElementById('cw-app') || document.body, tag, '启动', error));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
    else begin();
  }

  root.CardwrightHost = { boot, helpers: { fillTemplate, entryOf, upsertEntry, clampPosition, waitMvu, readData, isLatest, setAt } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
