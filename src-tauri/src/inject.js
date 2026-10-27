// 注入到美团外卖商家后台窗口（含页面里的内嵌框架）的脚本。
// 只做三件事：读点金页面上看得见的数字、读昨日曝光图表的悬停提示、在用户确认后点「推广出价」弹窗。
// 不读取、不转发 Cookie / 本地存储 / 请求令牌，不改页面请求。结果只通过「向应用主窗口发事件」交出去。
(function () {
  if (window.__cfInjected) return;
  window.__cfInjected = true;
  var TOP = window.top === window;

  function emit(event, payload) {
    try {
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: event, payload: payload });
      return true;
    } catch (e) {
      return false;
    }
  }
  // 内嵌框架里不一定能直接发事件：先试，不行就交给最外层页面转发。
  function send(event, payload) {
    if (TOP) { emit(event, payload); return; }
    try { window.top.postMessage({ __cf: 'relay', event: event, payload: payload }, '*'); } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- 读页面 ----------
  function visible(e) {
    if (!e) return false;
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  function text(e) { return ((e && (e.innerText || e.textContent)) || '').trim(); }
  function one(css) {
    var es = Array.prototype.filter.call(document.querySelectorAll(css), visible);
    return es.length === 1 ? es[0] : null;
  }
  function cents(e) {
    var s = text(e).replace(/,/g, '');
    var m = s.match(/^\s*(\d+(?:\.\d{1,2})?)\s*(?:元)?\s*$/);
    return m ? Math.round(Number(m[1]) * 100) : null;
  }
  function readCpc() {
    var cpc = document.querySelector('.isomor-cpc-index');
    if (!cpc) return null;
    var body = text(document.body);
    var q = new URL(location.href).searchParams;
    var d = { capturedAt: Date.now(), storeId: q.get('wmPoiId'), planId: null, blocker: null };
    if (/验证码|访问受限|操作过于频繁|异常登录/.test(body)) d.blocker = '页面出现验证或访问限制，请你在窗口里手动处理';
    if (document.querySelector('input[type=password]')) d.blocker = '需要重新登录';
    var metric = Array.prototype.filter.call(document.querySelectorAll('.pc-realtime-effect-data .overview-item'), function (e) { return text(e.querySelector('.category-title')) === '推广花费'; });
    d.spend = metric.length === 1 ? cents(metric[0].querySelector('.overview-num')) : null;
    d.platformBudget = cents(one('.isomor-cpc-fresh-budget-number'));
    d.bid = cents(one('.isomor-cpc-setting-price .isomor-cpc-set-item-new-action-name'));
    var toggle = one('.switch-component input[type=checkbox]') || document.querySelector('.switch-component input[type=checkbox]');
    var cpcText = text(cpc);
    if (toggle) d.status = toggle.checked ? 'running' : 'paused';
    else if (/已暂停|暂停中|去开启|去推广|已关闭|未开启/.test(cpcText)) d.status = 'paused';
    else if (/推广中/.test(cpcText)) d.status = 'running';
    else d.status = 'unknown';
    d.minBid = cents(one('.isomor-bid-popup .isomor-sliderplus-text-start'));
    d.maxBid = cents(one('.isomor-bid-popup .isomor-sliderplus-text-end'));
    d.modalBid = cents(one('.isomor-bid-popup .isomor-bid-card-num'));
    d.scope = text(one('.isomor-bid-popup .isomor-popup-desc')).slice(0, 60);
    d.dialog = !!one('.isomor-bid-popup');
    return d;
  }

  // ---------- 读曝光图表 ----------
  function chartInfo() {
    var charts = Array.prototype.filter.call(document.querySelectorAll('.highcharts-container'), visible);
    for (var i = 0; i < charts.length; i++) {
      var box = charts[i].closest('[class*=chart],[id^=chart]') || charts[i].parentElement;
      var t = text(box && box.parentElement ? box.parentElement : box);
      if (/曝光人数/.test(t) || charts.length === 1) {
        var plot = charts[i].querySelector('.highcharts-plot-background') || charts[i].querySelector('svg');
        return { container: charts[i], plot: plot, containerText: t.slice(0, 300) };
      }
    }
    return null;
  }
  function tooltipText() {
    var el = document.querySelector('.highcharts-tooltip') || document.querySelector('[class*=tooltip]');
    return text(el).replace(/\s+/g, ' ');
  }
  async function readCurve() {
    var info = chartInfo();
    if (!info) return;
    info.container.scrollIntoView({ block: 'center' });
    await sleep(300);
    var r = info.plot.getBoundingClientRect();
    var y = r.top + r.height * 0.55;
    var seen = {}, list = [];
    var N = 96;
    for (var i = 0; i < N; i++) {
      var x = r.left + r.width * (i + 0.5) / N;
      var target = document.elementFromPoint(x, y) || info.container;
      ['mousemove', 'mouseover'].forEach(function (type) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, view: window }));
      });
      await sleep(60);
      var t = tooltipText();
      if (t && !seen[t]) { seen[t] = 1; list.push(t.slice(0, 160)); }
    }
    send('mt-tooltips', { tooltips: list, containerText: info.containerText });
  }

  // ---------- 点「推广出价」弹窗（只在用户点了「应用这条建议」或自动调价时调用）----------
  function clickEl(e) { if (e && visible(e)) { e.click(); return true; } return false; }
  async function until(fn, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) { var v = fn(); if (v) return v; await sleep(300); }
    return null;
  }
  function done(ok, msg, extra) { send('mt-apply', Object.assign({ ok: ok, msg: msg }, extra || {})); }
  async function applyBid(before, target, maxStep, scope) {
    if (!document.querySelector('.isomor-cpc-index')) return; // 不是点金页的框架保持沉默
    if (!(maxStep > 0 && maxStep <= 100) || Math.abs(target - before) > maxStep || target <= 0) { done(false, '改动幅度超出单次步长，已拒绝'); return; }
    var submitted = false;
    var dialogOpen = function () { return one('.isomor-bid-popup'); };
    var cancel = function () { clickEl(one('.isomor-bid-popup .isomor-popup-btn-cancel button')); };
    try {
      if (!dialogOpen()) {
        if (!clickEl(document.querySelector('.isomor-cpc-setting-price .isomor-cpc-set-item-action-arrow-wrapper'))) { done(false, '没找到「推广出价」入口，请确认停在点金页'); return; }
        if (!(await until(dialogOpen, 8000))) { done(false, '出价弹窗没有打开'); return; }
      }
      var cur = function () { return cents(one('.isomor-bid-popup .isomor-bid-card-num')); };
      await sleep(400);
      var s0 = readCpc();
      if (cur() !== before) { cancel(); done(false, '弹窗里的当前出价与读到的不一致，已取消'); return; }
      if (scope && s0 && s0.scope !== scope) { cancel(); done(false, '出价时段已变化，已取消'); return; }
      if (s0 && s0.minBid != null && target < s0.minBid || s0 && s0.maxBid != null && target > s0.maxBid) { cancel(); done(false, '目标出价超出平台允许范围，已取消'); return; }
      var dir = target > before ? 'right' : 'left';
      var guard = 0;
      while (cur() !== target && guard++ < 12) {
        if (!clickEl(one('.isomor-bid-popup .isomor-sliderplus-' + dir))) { cancel(); done(false, '没找到加减按钮，已取消'); return; }
        await sleep(250);
        var c = cur();
        if (c != null && (dir === 'right' ? c > target : c < target)) { cancel(); done(false, '加减步长与预期不符，已取消'); return; }
      }
      if (cur() !== target) { cancel(); done(false, '没能把弹窗里的出价调到目标值，已取消'); return; }
      if (!clickEl(one('.isomor-bid-popup .isomor-popup-btn-confirm button'))) { cancel(); done(false, '没找到「保存设置」按钮，已取消'); return; }
      submitted = true;
      await until(function () { return !dialogOpen(); }, 8000);
      await sleep(1500);
      var after = readCpc();
      done(true, '已点保存，请看回读结果', { submitted: true, readback: after && after.bid });
      if (after) send('mt-snapshot', after);
    } catch (e) {
      try { cancel(); } catch (e2) {}
      done(false, '执行出错：' + (e && e.message ? e.message : e), { submitted: submitted });
    }
  }

  // ---------- 命令分发 ----------
  async function handle(cmd) {
    if (cmd.name === 'read') { var d = readCpc(); if (d) send('mt-snapshot', d); }
    else if (cmd.name === 'text') {
      // 只给营业时间解析用：门店管理页上的可见文字，截断
      var b = text(document.body);
      if (/营业时间|营业时段/.test(b)) {
        var i = b.search(/营业时间|营业时段/);
        send('mt-text', { text: b.slice(Math.max(0, i - 20), i + 800) });
      }
    }
    else if (cmd.name === 'curve') await readCurve();
    else if (cmd.name === 'apply') await applyBid(cmd.before, cmd.target, cmd.maxStep, cmd.scope);
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    var host = '';
    try { host = new URL(ev.origin).hostname; } catch (e) {}
    if (!/(^|\.)meituan\.com$/.test(host)) return; // 只信美团自己的页面
    if (m.__cf === 'relay' && TOP && typeof m.event === 'string' && /^mt-/.test(m.event)) emit(m.event, m.payload);
    else if (m.__cf === 'cmd' && !TOP && ev.source === window.parent && m.cmd && typeof m.cmd.name === 'string') handle(m.cmd);
  });

  if (TOP) {
    // 由应用调用：把命令发给自己和所有内嵌框架，谁的页面上有对应内容谁处理
    window.__campfire = {
      run: function (cmd) {
        handle(cmd);
        var fs = document.querySelectorAll('iframe');
        for (var i = 0; i < fs.length; i++) { try { fs[i].contentWindow.postMessage({ __cf: 'cmd', cmd: cmd }, '*'); } catch (e) {} }
      },
    };
    emit('mt-status', { step: 'injected', host: location.hostname });
  }
})();
