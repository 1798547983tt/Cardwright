/* Cardwright 前端骨架 · 悬浮应用：在酒馆页面挂一颗悬浮球与一块可拖动、记位置的状态面板（一个实例）。依赖 core.js。 */
(function (root) {
  'use strict';
  var core = root.CardwrightCore;
  var SIZE = 56;
  function mount(options) {
    var doc = options.hostDocument;
    var id = options.id;
    var key = 'cardwright-floating:' + id;
    var existing = doc.querySelector('[data-cardwright-floating="' + id + '"]');
    if (existing) return existing.__cardwright;
    var holder = doc.createElement('div');
    holder.setAttribute('data-cardwright-floating', id);
    holder.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;';
    var shadow = holder.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + options.css.replace(/:root\b/g, ':host') + '</style>'
      + '<button class="cw-ball" type="button" aria-label="打开状态面板"></button>'
      + '<section class="cw-panel" hidden>'
      + '<header class="cw-panel-bar">'
      + '<span class="cw-status-title"></span>'
      + '<button class="cw-panel-close" type="button" aria-label="收起">'
      + '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>'
      + '</button>'
      + '</header>'
      + '<nav class="cw-tabs"></nav>'
      + '<div class="cw-page"></div>'
      + '</section>';
    (doc.body || doc.documentElement).appendChild(holder);
    var position = { x: 16, y: Math.max(16, ((doc.defaultView || {}).innerHeight || 600) - SIZE - 24) };
    try {
      var saved = JSON.parse((doc.defaultView || {}).localStorage.getItem(key) || 'null');
      if (saved && typeof saved.x === 'number') position = saved;
    } catch (ignored) {}
    var clamp = function (p, view) {
      return {
        x: Math.max(0, Math.min((view.innerWidth || 400) - SIZE, p.x)),
        y: Math.max(0, Math.min((view.innerHeight || 600) - SIZE, p.y))
      };
    };
    var onResize = function () {
      position = clamp(position, doc.defaultView || { innerWidth: 400, innerHeight: 600 });
      holder.style.transform = 'translate(' + position.x + 'px,' + position.y + 'px)';
    };
    onResize();
    var ball = shadow.querySelector('.cw-ball');
    ball.style.touchAction = 'none';
    var panel = shadow.querySelector('.cw-panel');
    var drag = null;
    ball.addEventListener('pointerdown', function (event) {
      drag = { x: event.clientX - position.x, y: event.clientY - position.y, moved: false, id: event.pointerId };
      ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener('pointermove', function (event) {
      if (!drag) return;
      var next = { x: event.clientX - drag.x, y: event.clientY - drag.y };
      if (Math.abs(next.x - position.x) + Math.abs(next.y - position.y) > 2) drag.moved = true;
      position = next;
      onResize();
    });
    ball.addEventListener('pointerup', function () {
      if (!drag) return;
      if (drag.moved) {
        try { (doc.defaultView || {}).localStorage.setItem(key, JSON.stringify(position)); } catch (ignored) {}
      } else {
        panel.hidden = !panel.hidden;
      }
      drag = null;
    });
    ball.addEventListener('pointercancel', function (event) {
      if (!drag) return;
      try { ball.releasePointerCapture(event.pointerId); } catch (ignored) {}
      drag = null;
    });
    shadow.querySelector('.cw-panel-close').addEventListener('click', function () {
      panel.hidden = true;
    });
    if (doc.defaultView) doc.defaultView.addEventListener('resize', onResize);
    var page = 0;
    var previous = null;
    var data = {};
    var draw = function (next) {
      data = next || {};
      var pages = core.renderPages(options.sheet, data, previous);
      shadow.querySelector('.cw-status-title').textContent = options.sheet.title || '';
      shadow.querySelector('.cw-tabs').innerHTML = pages.pages.map(function (item, index) {
        return '<button type="button" class="cw-tab' + (index === page ? ' is-on' : '') + '" data-cw-page="' + index + '">' + item.icon + core.escape(item.name) + '</button>';
      }).join('');
      shadow.querySelector('.cw-page').innerHTML = pages.pages[page] ? pages.pages[page].html : '';
      previous = data;
    };
    shadow.querySelector('.cw-tabs').addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-cw-page]') : null;
      if (!button) return;
      page = Number(button.getAttribute('data-cw-page'));
      draw(data);
    });
    var api = {
      draw: draw,
      destroy: function () {
        if (doc.defaultView) doc.defaultView.removeEventListener('resize', onResize);
        holder.remove();
      }
    };
    holder.__cardwright = api;
    return api;
  }
  root.CardwrightFloating = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
