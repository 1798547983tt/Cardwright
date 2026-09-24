/*
 * Cardwright 前端骨架 · 运行时核心（纯函数）。
 * 输入是编译器补过行信息的装配单与 MVU 的 stat_data，输出 HTML 字符串；所有文本经 escape。
 * 不碰 document / window：酒馆助手的 iframe、悬浮应用的 Shadow DOM 和 Node 的 vm 都用同一份。
 * renderBody 把每个标签配到它后面第一个同名闭合标签：同名标签嵌套不支持（模块标记不会嵌套）。
 */
(function (root) {
  'use strict';
  const VERSION = '1.1.0';
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escape = text => String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, ch => ESCAPES[ch]);
  const attr = value => escape(value).replace(/\n/g, ' ');

  // 18 个图标：24×24 视框里的简单线条，stroke 由 CSS 的 currentColor 给。
  const ICONS = {
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    users: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7 0"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    sword: '<path d="M4 20l10-10M14 10l4-6 2 2-6 4M4 20l3-1 1-3"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>',
    flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    leaf: '<path d="M4 20C6 10 12 5 20 4c-1 8-6 14-16 16z"/><path d="M4 20l8-8"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    pin: '<path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    scroll: '<path d="M6 4h12v13a3 3 0 0 1-3 3H6z"/><path d="M6 20a3 3 0 0 1 0-6h9"/><path d="M9 8h6M9 11h6"/>',
  };
  const icon = name => (ICONS[name] ? '<svg class="cw-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>' : '');

  const segments = path => String(path || '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const PLACEHOLDER = part => part === '{键}' || part === '-';
  function resolve(data, path) {
    let current = data;
    for (const key of segments(path)) {
      if (current === null || current === undefined || typeof current !== 'object') return undefined;
      current = Array.isArray(current) ? current[Number(key)] : Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
    }
    return current;
  }
  /** MVU's older shape keeps a leaf as [value, note]; a leaf item shows the value. */
  const unwrap = (value, kind) => (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && (value[0] === null || typeof value[0] !== 'object') && kind !== '列表' ? value[0] : value);
  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const percent = (value, range) => (isNumber(value) && range && range[1] > range[0] ? Math.round(Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0]))) * 100) : null);
  const MISSING = '未知';
  function formatValue(raw, item) {
    const kind = item && item.kind;
    const value = unwrap(raw, kind);
    if (value === undefined || value === null) return MISSING;
    if (value === '') return '—';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (isNumber(value)) return item && item.range ? value + ' / ' + item.range[1] : String(value);
    if (Array.isArray(value)) return value.length ? value.map(entry => (entry && typeof entry === 'object' ? '{…}' : String(entry))).join('、') : '—';
    if (typeof value === 'object') return '{…}';
    return String(value);
  }
  const label = item => item.label || segments(item.path).filter(part => !PLACEHOLDER(part)).pop() || item.path;
  const title = block => (block.title ? '<h3 class="cw-block-title">' + escape(block.title) + '</h3>' : '');
  const section = (kind, block, inner) => '<section class="cw-block cw-' + kind + '">' + title(block) + inner + '</section>';
  const missingClass = value => (value === undefined || value === null ? ' is-missing' : '');
  const barTrack = width => '<span class="cw-bar-track"><span class="cw-bar-fill" style="width: ' + (width === null ? 0 : width) + '%"></span></span>';
  /** `/人物/{键}/好感` under `/人物` for key 老周 → `/人物/老周/好感`; a list element index works the same way. */
  const concrete = (fieldPath, basePath, key) => '/' + segments(basePath).concat([key]).concat(segments(fieldPath).slice(segments(basePath).length + 1)).map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  const entriesOf = value => (Array.isArray(value) ? value.map((entry, index) => [String(index), entry]) : value && typeof value === 'object' ? Object.entries(value) : []);
  const hue = name => { let hash = 0; for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360; return hash; };

  const renderers = {
    stats(block, data) {
      return section('stats', block, '<dl class="cw-stats-grid">' + block.items.map(item => { const value = resolve(data, item.path); return '<dt>' + escape(label(item)) + '</dt><dd class="cw-value' + missingClass(value) + '">' + escape(formatValue(value, item)) + '</dd>'; }).join('') + '</dl>');
    },
    bars(block, data) {
      return section('bars', block, block.items.map(item => { const value = unwrap(resolve(data, item.path), item.kind); const width = percent(value, item.range); return '<div class="cw-bar"><span class="cw-bar-label">' + escape(label(item)) + '</span>' + barTrack(width) + '<span class="cw-bar-value' + missingClass(value) + '">' + escape(formatValue(value, item)) + '</span></div>'; }).join(''));
    },
    gauge(block, data) {
      return section('gauge', block, '<div class="cw-gauge-row">' + block.items.map(item => { const value = unwrap(resolve(data, item.path), item.kind); const width = percent(value, item.range); const dash = width === null ? 0 : Math.round(width * 1.26); return '<figure class="cw-gauge-item"><svg class="cw-gauge" viewBox="0 0 48 30" data-percent="' + (width === null ? 0 : width) + '"><path class="cw-gauge-track" d="M4 26a20 20 0 0 1 40 0" pathLength="126"/><path class="cw-gauge-fill" d="M4 26a20 20 0 0 1 40 0" pathLength="126" stroke-dasharray="' + dash + ' 126"/></svg><figcaption><b>' + escape(formatValue(value, item)) + '</b><span>' + escape(label(item)) + '</span></figcaption></figure>'; }).join('') + '</div>');
    },
    tags(block, data) {
      const value = unwrap(resolve(data, block.path), block.kind);
      const tags = Array.isArray(value) ? value.map(entry => (entry && typeof entry === 'object' ? '{…}' : String(entry))) : value && typeof value === 'object' ? Object.keys(value) : value === undefined || value === null || value === '' ? [] : String(value).split(/[、，,]/).map(part => part.trim()).filter(Boolean);
      return section('tags', block, tags.length ? '<div class="cw-tags">' + tags.map(tag => '<span class="cw-tag">' + escape(tag) + '</span>').join('') + '</div>' : '<p class="cw-empty">—</p>');
    },
    list(block, data) {
      const entries = entriesOf(resolve(data, block.path)).slice(-block.recent).reverse();
      if (!entries.length) return section('list', block, '<p class="cw-empty">—</p>');
      const rows = entries.map(([key, entry]) => {
        if (!block.fields || !entry || typeof entry !== 'object') return '<li>' + escape(formatValue(entry, {})) + '</li>';
        return '<li>' + Object.entries(block.fields).map(([name, field]) => '<span class="cw-field"><b>' + escape(name) + '</b>' + escape(formatValue(resolve(data, concrete(field, block.path, key)), {})) + '</span>').join('') + '</li>';
      });
      return section('list', block, '<ul class="cw-list">' + rows.join('') + '</ul>');
    },
    relation(block, data) {
      const entries = entriesOf(resolve(data, block.path));
      if (!entries.length) return section('relation', block, '<p class="cw-empty">—</p>');
      return section('relation', block, '<div class="cw-relations">' + entries.map(([key]) => {
        const fields = Object.entries(block.fields).map(([name, field]) => '<span class="cw-field"><b>' + escape(name) + '</b>' + escape(formatValue(resolve(data, concrete(field, block.path, key)), {})) + '</span>').join('');
        const bar = block.bar ? barTrack(percent(unwrap(resolve(data, concrete(block.bar, block.path, key))), block.barRange)) : '';
        return '<article class="cw-relation"><span class="cw-avatar" style="--hue: ' + hue(key) + '">' + escape([...String(key)][0] || '?') + '</span><div class="cw-relation-body"><b class="cw-relation-name">' + escape(key) + '</b><div class="cw-relation-fields">' + fields + '</div>' + bar + '</div></article>';
      }).join('') + '</div>');
    },
    timeline(block, data) {
      const entries = entriesOf(resolve(data, block.path)).slice(-block.recent).reverse();
      if (!entries.length) return section('timeline', block, '<p class="cw-empty">—</p>');
      return section('timeline', block, '<ol class="cw-timeline">' + entries.map(([key, entry]) => {
        const time = block.time && entry && typeof entry === 'object' ? formatValue(resolve(data, concrete(block.time, block.path, key)), {}) : '';
        const note = block.note && entry && typeof entry === 'object' ? formatValue(resolve(data, concrete(block.note, block.path, key)), {}) : formatValue(entry, {});
        return '<li>' + (time ? '<time>' + escape(time) + '</time>' : '') + '<span>' + escape(note) + '</span></li>';
      }).join('') + '</ol>');
    },
    crisis(block, data) {
      const value = unwrap(resolve(data, block.path), block.kind);
      const current = isNumber(value) ? block.tiers.findIndex(tier => tier.upTo === undefined || value <= tier.upTo) : block.tiers.findIndex(tier => tier.name === value);
      return section('crisis', block, '<div class="cw-tiers">' + block.tiers.map((tier, index) => '<span class="cw-tier is-' + tier.tone + (index === current ? ' is-current' : '') + '">' + escape(tier.name) + '</span>').join('') + '</div>');
    },
    delta(block, data, previous) {
      return section('delta', block, block.items.map(item => {
        const now = unwrap(resolve(data, item.path), item.kind); const before = previous ? unwrap(resolve(previous, item.path), item.kind) : undefined;
        const change = isNumber(now) && isNumber(before) ? now - before : null;
        const state = change === null || change === 0 ? 'same' : change > 0 ? 'up' : 'down';
        const text = change === null || change === 0 ? formatValue(now, item) : (change > 0 ? '+' : '') + change;
        return '<span class="cw-delta-item"><b>' + escape(label(item)) + '</b><span class="cw-delta is-' + state + '">' + escape(text) + '</span></span>';
      }).join(''));
    },
    text(block, data) {
      const text = block.text !== undefined ? block.text : formatValue(resolve(data, block.path), block);
      return section('text', block, '<p class="cw-text">' + escape(text) + '</p>');
    },
    fold(block, data, previous) {
      return '<details class="cw-fold"' + (block.open ? ' open' : '') + '><summary>' + escape(block.title) + '</summary>' + block.blocks.map(child => renderBlock(child, data, previous)).join('') + '</details>';
    },
    custom(block) { return '<section class="cw-block cw-custom">' + block.html + '</section>'; },
  };
  function renderBlock(block, data, previous) {
    const render = renderers[block.type];
    return render ? render(block, data || {}, previous || null) : '';
  }
  function renderPages(sheet, data, previous) {
    return { pages: sheet.pages.map(page => ({ name: page.name, icon: page.icon ? icon(page.icon) : '', html: page.blocks.map(block => renderBlock(block, data, previous)).join('') })), warnings: [] };
  }
  function renderSummary(sheet, data) {
    return sheet.summary.map(item => '<span class="cw-summary-item"><b>' + escape(label(item)) + '</b>' + escape(formatValue(resolve(data, item.path), item)) + '</span>').join('');
  }

  /* 正文美化：按模块表把 <标签>…</标签> 变成版面；没有标签就按段落显示原文。 */
  const ROLE_OPEN = { 页眉: 'header class="cw-head"', 章节: 'h2 class="cw-chapter"', 场景: 'p class="cw-scene"', 独白: 'p class="cw-mono"', 提示: 'aside class="cw-tip"', 检定: 'div class="cw-check"' };
  const tagName = open => open.split(/\s/)[0];
  /** `{名字}「…」` 一行对白的 HTML；不是对白就返回 null。玩家标记（缺省 `#`）显示成「你」。 */
  function sayLine(line, playerMark) {
    const say = /^\{([^{}]*)\}\s*[「“"](.+?)[」”"]\s*$/.exec(line.trim());
    if (!say) return null;
    const player = say[1] === playerMark;
    return '<p class="cw-say' + (player ? ' is-player' : '') + '"><b class="cw-speaker">' + escape(player ? '你' : say[1]) + '</b><q>' + escape(say[2]) + '</q></p>';
  }
  function paragraphs(text, playerMark) {
    return text.split(/\n[ \t]*\n/).map(part => part.trim()).filter(Boolean).map(part => {
      const lines = part.split('\n');
      const says = lines.map(line => sayLine(line, playerMark));
      return says.every(Boolean) ? says.join('') : '<p class="cw-para">' + lines.map(escape).join('<br>') + '</p>';
    }).join('');
  }
  function renderBody(sheet, source) {
    const text = String(source || '').replace(/\r\n?/g, '\n');
    const modules = new Map(sheet.modules.map(module => [module.tag.toLowerCase(), module]));
    const parts = [];
    const pattern = /<([A-Za-z][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g;
    let cursor = 0; let match;
    while ((match = pattern.exec(text))) {
      const loose = text.slice(cursor, match.index).trim();
      if (loose) parts.push(paragraphs(loose, sheet.playerMark));
      const module = modules.get(match[1].toLowerCase());
      const inner = match[2].trim();
      const role = module ? module.role : '正文';
      if (role === '隐藏') { cursor = match.index + match[0].length; continue; }
      if (role === '正文' || role === '对白') parts.push(paragraphs(inner, sheet.playerMark));
      else if (role === '折叠') parts.push('<details class="cw-fold"><summary>' + escape(module.label || match[1]) + '</summary>' + paragraphs(inner, sheet.playerMark) + '</details>');
      else { const open = ROLE_OPEN[role]; parts.push('<' + open + '>' + escape(inner).replace(/\n/g, '<br>') + '</' + tagName(open) + '>'); }
      cursor = match.index + match[0].length;
    }
    const tail = text.slice(cursor).trim();
    if (!parts.length) return '<div class="cw-fallback">' + paragraphs(text, sheet.playerMark) + '</div>';
    if (tail) parts.push(paragraphs(tail, sheet.playerMark));
    return parts.join('');
  }

  /* 创角页：当前一步的表单，最后一步是核对清单。draft 是 {键: 值}。 */
  function renderField(field, draft) {
    const value = draft[field.key];
    const on = option => (Array.isArray(value) ? value.includes(option) : value === option);
    if (field.type === '文本') return '<input class="cw-input" type="text" data-cw-field="' + attr(field.key) + '" value="' + attr(value === undefined ? '' : value) + '"' + (field.hint ? ' placeholder="' + attr(field.hint) + '"' : '') + (field.required ? ' required' : '') + '>';
    if (field.type === '长文本') return '<textarea class="cw-input cw-textarea" data-cw-field="' + attr(field.key) + '"' + (field.hint ? ' placeholder="' + attr(field.hint) + '"' : '') + (field.required ? ' required' : '') + '>' + escape(value === undefined ? '' : value) + '</textarea>';
    if (field.type === '单选') return '<div class="cw-choices">' + field.options.map(option => '<label class="cw-choice' + (on(option) ? ' is-on' : '') + '"><input type="radio" name="' + attr(field.key) + '" value="' + attr(option) + '" data-cw-field="' + attr(field.key) + '"' + (on(option) ? ' checked' : '') + '>' + escape(option) + '</label>').join('') + '</div>';
    if (field.type === '多选' || field.type === '人物列表') return '<div class="cw-choices' + (field.type === '人物列表' ? ' is-people' : '') + '">' + field.options.map(option => '<label class="cw-choice' + (on(option) ? ' is-on' : '') + '"><input type="checkbox" value="' + attr(option) + '" data-cw-field="' + attr(field.key) + '"' + (field.max ? ' data-cw-max="' + attr(field.max) + '"' : '') + (on(option) ? ' checked' : '') + '>' + escape(option) + '</label>').join('') + '</div>';
    if (field.type === '滑杆') return '<input class="cw-slider" type="range" min="' + attr(field.range[0]) + '" max="' + attr(field.range[1]) + '" value="' + attr(isNumber(value) ? value : field.range[0]) + '" data-cw-field="' + attr(field.key) + '"><output class="cw-slider-value">' + escape(isNumber(value) ? value : field.range[0]) + '</output>';
    return '';
  }
  function renderStart(sheet, draft, stepIndex) {
    const steps = sheet.steps.map(step => step.name).concat(['核对']);
    const nav = steps.map((name, index) => '<li class="cw-step' + (index === stepIndex ? ' is-current' : index < stepIndex ? ' is-done' : '') + '">' + escape(name) + '</li>').join('');
    const last = stepIndex >= sheet.steps.length;
    let body;
    if (last) {
      body = '<dl class="cw-review">' + sheet.steps.flatMap(step => step.fields).map(field => { const value = draft[field.key]; const empty = value === undefined || value === '' || (Array.isArray(value) && !value.length); return '<dt>' + escape(field.key) + '</dt>' + (empty ? '<dd class="is-missing">未填</dd>' : '<dd>' + escape(Array.isArray(value) ? value.join('、') : value) + '</dd>'); }).join('') + '</dl>';
    } else {
      const step = sheet.steps[stepIndex];
      body = step.fields.map(field => '<div class="cw-field-row"><label class="cw-field-label">' + escape(field.key) + (field.required ? '<i class="cw-required">*</i>' : '') + '</label>' + renderField(field, draft) + '</div>').join('');
    }
    const buttons = '<button type="button" class="cw-btn" data-cw-nav="back"' + (stepIndex === 0 ? ' disabled' : '') + '>上一步</button>' + (last ? '<button type="button" class="cw-btn is-primary" data-cw-nav="submit">开始</button>' : '<button type="button" class="cw-btn is-primary" data-cw-nav="next">下一步</button>');
    return '<div class="cw-start">' + (sheet.title ? '<h1 class="cw-title">' + escape(sheet.title) + '</h1>' : '') + '<ol class="cw-steps">' + nav + '</ol><div class="cw-start-body">' + body + '</div><div class="cw-start-nav">' + buttons + '</div></div>';
  }

  root.CardwrightCore = { version: VERSION, escape, icon, resolve, formatValue, renderSummary, renderPages, renderBlock, renderStart, renderBody, ICONS: Object.keys(ICONS) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
