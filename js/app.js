/* 小說閱讀器（網頁版）— 純原生 JS，無外部相依。書本文字只存在使用者裝置的 IndexedDB。 */
(function () {
  'use strict';

  var KEY_P = 'novelReader.progress.v1';      // 與離線版相同的鍵與格式，方便搬進度
  var KEY_S = 'novelReader.settings.v1';
  var FORMAT = 'novel-reader-progress';
  var DEFAULTS = { fontSize: 19, lineHeight: 1.9, theme: 'light', font: 'sans', width: 'medium' };
  var EXTRA_DEFAULTS = { tapZones: 'on' };   // 網頁版專屬設定（離線版會忽略）
  var THEME_COLOR = { light: '#f6f6f4', sepia: '#f4ecd8', dark: '#16181c' };
  var LIB = [];                               // 書籍中繼資料（不含文字）

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- localStorage（失敗時退回記憶體） ---------- */
  var mem = {}, storageOK = true;
  try { var _k = '__t'; localStorage.setItem(_k, '1'); localStorage.removeItem(_k); } catch (e) { storageOK = false; }
  function sget(k) { try { return storageOK ? localStorage.getItem(k) : (mem[k] || null); } catch (e) { return mem[k] || null; } }
  function sset(k, v) { try { if (storageOK) localStorage.setItem(k, v); else mem[k] = v; } catch (e) { mem[k] = v; storageOK = false; $('storageWarn').hidden = false; } }
  function jget(k, d) { try { var v = sget(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }

  var progress = jget(KEY_P, { books: {} });
  if (!progress || typeof progress !== 'object' || !progress.books) progress = { books: {} };
  var settings = Object.assign({}, DEFAULTS, EXTRA_DEFAULTS, jget(KEY_S, {}));

  function saveProgress() { sset(KEY_P, JSON.stringify(progress)); }
  function saveSettings() { sset(KEY_S, JSON.stringify(settings)); }

  /* ---------- 小工具 ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pctStr(p) { return (Math.round((p || 0) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%'; }
  function fmtDate(t) { try { return new Date(t).toLocaleString('zh-TW', { hour12: false }); } catch (e) { return ''; } }
  function findBook(id) { for (var i = 0; i < LIB.length; i++) if (LIB[i].id === id) return LIB[i]; return null; }
  function fmtMB(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }

  /* 書本 ID：與離線版 build.py 相同 —— 'b' + sha1(UTF-8 書名) 前 8 碼 */
  function sha1hex(str) {
    var bytes = new TextEncoder().encode(str), l = bytes.length;
    var words = [], i;
    for (i = 0; i < l; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    words[(((l + 8) >> 6) << 4) + 15] = l * 8;
    var w = new Array(80), h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    function rol(n, s) { return (n << s) | (n >>> (32 - s)); }
    for (var b = 0; b < words.length; b += 16) {
      var a = h0, bb = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        w[i] = i < 16 ? (words[b + i] | 0) : rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        var f, k;
        if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5A827999; }
        else if (i < 40) { f = bb ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = bb ^ c ^ d; k = 0xCA62C1D6; }
        var t = (rol(a, 5) + f + e + k + w[i]) | 0;
        e = d; d = c; c = rol(bb, 30); bb = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  function bookIdFor(title) { return 'b' + sha1hex(title).slice(0, 8); }

  /* ---------- IndexedDB（meta：書籍資訊；text：章節文字） ---------- */
  var db = null, dbOK = true, memBooks = {};
  function openDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { dbOK = false; return resolve(null); }
      var r;
      try { r = indexedDB.open('novel-reader-web', 1); } catch (e) { dbOK = false; return resolve(null); }
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('meta', { keyPath: 'id' }); d.createObjectStore('text', { keyPath: 'id' }); };
      r.onsuccess = function () { db = r.result; resolve(db); };
      r.onerror = function () { dbOK = false; resolve(null); };
      r.onblocked = function () { dbOK = false; resolve(null); };
    });
  }
  function txDone(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = tx.onabort = function () { rej(tx.error || new Error('儲存失敗')); }; }); }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function dbAllMeta() {
    if (!dbOK) return Promise.resolve(Object.keys(memBooks).map(function (k) { return memBooks[k].meta; }));
    return reqP(db.transaction('meta').objectStore('meta').getAll());
  }
  function dbPutBook(meta, chapters) {
    if (!dbOK) { memBooks[meta.id] = { meta: meta, chapters: chapters }; return Promise.resolve(); }
    var tx = db.transaction(['meta', 'text'], 'readwrite');
    tx.objectStore('meta').put(meta);
    tx.objectStore('text').put({ id: meta.id, chapters: chapters });
    return txDone(tx);
  }
  function dbGetText(id) {
    if (!dbOK) return Promise.resolve(memBooks[id] ? memBooks[id].chapters : null);
    return reqP(db.transaction('text').objectStore('text').get(id)).then(function (r) { return r ? r.chapters : null; });
  }
  function dbDelete(id) {
    if (!dbOK) { delete memBooks[id]; return Promise.resolve(); }
    var tx = db.transaction(['meta', 'text'], 'readwrite');
    tx.objectStore('meta').delete(id); tx.objectStore('text').delete(id);
    return txDone(tx);
  }
  function loadLibrary() { return dbAllMeta().then(function (m) { LIB = m || []; }); }

  /* ---------- 儲存空間 ---------- */
  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
    return Promise.resolve(false);
  }
  function renderStorageInfo() {
    var box = $('storageInfo'); if (!box) return;
    if (!(navigator.storage && navigator.storage.estimate)) { box.textContent = ''; return; }
    var pp = navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false);
    Promise.all([navigator.storage.estimate(), pp]).then(function (r) {
      var used = r[0].usage || 0;
      box.textContent = '已使用儲存空間 ' + fmtMB(used) + '（上限約 ' + fmtMB(r[0].quota || 0) + '）· 永久儲存：' + (r[1] ? '已啟用' : '未啟用（瀏覽器空間不足時可能被清除，建議定期匯出進度）');
    }).catch(function () { box.textContent = ''; });
  }

  /* ---------- 設定 ---------- */
  function applySettings() {
    var r = document.documentElement;
    r.style.setProperty('--fs', settings.fontSize + 'px');
    r.style.setProperty('--lh', String(settings.lineHeight));
    r.dataset.theme = settings.theme;
    r.dataset.font = settings.font;
    r.dataset.width = settings.width;
    $('metaTheme').setAttribute('content', THEME_COLOR[settings.theme] || THEME_COLOR.light);
    $('setFont').value = settings.fontSize; $('outFont').textContent = settings.fontSize + 'px';
    $('setLine').value = settings.lineHeight; $('outLine').textContent = Number(settings.lineHeight).toFixed(1);
    [['segTheme', 'theme'], ['segFont', 'font'], ['segWidth', 'width'], ['segTap', 'tapZones']].forEach(function (p) {
      Array.prototype.forEach.call($(p[0]).children, function (b) { b.classList.toggle('on', b.dataset.v === settings[p[1]]); });
    });
  }
  function changeSetting(k, v) {
    var anchor = state.view === 'read' ? currentPara() : -1;
    settings[k] = v; saveSettings(); applySettings();
    if (anchor >= 0) scrollToPara(anchor);
  }
  function openSettings() { $('settingsMask').hidden = false; $('settingsPanel').hidden = false; }
  function closeSettings() { $('settingsMask').hidden = true; $('settingsPanel').hidden = true; }

  /* ---------- 書架 ---------- */
  function renderShelf() {
    var grid = $('bookGrid'); grid.textContent = '';
    $('emptyState').hidden = LIB.length > 0;
    var books = LIB.slice().sort(function (a, b) {
      var ta = (progress.books[a.id] || {}).t || 0, tb = (progress.books[b.id] || {}).t || 0;
      return tb - ta || (a.title < b.title ? -1 : 1);
    });
    books.forEach(function (b) {
      var p = progress.books[b.id];
      var li = el('li', 'book-card');
      li.dataset.id = b.id;
      li.appendChild(el('h3', null, b.title));
      var meta = '共 ' + b.chapters + ' 章 · 約 ' + Math.round(b.chars / 10000) + ' 萬字';
      if (b.mode === 'headings' && b.firstNo && b.firstNo > 1) meta += ' · 收錄第 ' + b.firstNo + '–' + b.lastNo + ' 章';
      if (b.mode === 'chunked') meta += ' · 無章名，已自動分段';
      li.appendChild(el('div', 'book-meta', meta));
      var last = el('div', 'book-last');
      if (p && typeof p.ch === 'number') {
        last.textContent = '讀到：' + (p.title || ('第 ' + (p.ch + 1) + ' 章')) + '（' + (p.ch + 1) + '/' + b.chapters + '） · ' + pctStr(p.pct) + (p.t ? ' · ' + fmtDate(p.t) : '');
      } else last.textContent = '尚未開始閱讀';
      li.appendChild(last);
      var bar = el('div', 'pbar'); var fill = el('span'); fill.style.width = ((p && p.pct) ? Math.min(100, p.pct * 100) : 0) + '%'; bar.appendChild(fill); li.appendChild(bar);
      var act = el('div', 'book-actions');
      var go = el('button', 'btn primary', p ? '繼續閱讀' : '開始閱讀'); go.type = 'button'; go.dataset.act = 'read'; act.appendChild(go);
      li.appendChild(act);
      var act2 = el('div', 'book-actions sec');
      [['rename', '改書名'], p ? ['reset', '清除進度'] : null, ['delete', '刪除']].forEach(function (x) {
        if (!x) return;
        var bt = el('button', 'btn small' + (x[0] === 'delete' ? ' danger' : ''), x[1]); bt.type = 'button'; bt.dataset.act = x[0]; act2.appendChild(bt);
      });
      li.appendChild(act2);
      var notes = (b.notes || []).concat(b.analysis || []);
      if (notes.length) {
        var det = el('details'); det.appendChild(el('summary', null, '章節檢查（' + notes.length + ' 項）'));
        var ul = el('ul'); notes.forEach(function (n) { ul.appendChild(el('li', null, n)); }); det.appendChild(ul); li.appendChild(det);
      }
      grid.appendChild(li);
    });
    $('storageWarn').hidden = storageOK;
    $('idbWarn').hidden = dbOK;
    renderStorageInfo();
  }

  /* ---------- 讀者狀態 ---------- */
  var state = { view: 'shelf', book: null, bookId: null, ch: 0, cum: [], lens: [], total: 1, restoring: false };
  var saveTimer = null;

  function openBook(id) {
    state.view = 'read'; state.bookId = id; state.book = null;
    $('shelfView').hidden = true; $('readerView').hidden = false; $('loading').hidden = false;
    $('chapterTitle').textContent = ''; $('chapterBody').textContent = '';
    showBars(true);
    var meta = findBook(id);
    dbGetText(id).then(function (chapters) {
      if (state.bookId !== id) return;
      if (!chapters || !chapters.length) throw new Error('找不到這本書的內容，請重新匯入');
      var book = { id: id, title: meta.title, chapters: chapters };
      state.book = book;
      var cum = [], acc = 0, lens = [];
      chapters.forEach(function (c) { cum.push(acc); lens.push(c[1].length); acc += c[1].length; });
      state.cum = cum; state.lens = lens; state.total = acc || 1;
      var p = progress.books[id];
      var ch = (p && typeof p.ch === 'number') ? Math.min(Math.max(p.ch, 0), chapters.length - 1) : 0;
      $('barBook').textContent = book.title;
      $('loading').hidden = true;
      renderChapter(ch, p ? { para: p.para, ratio: p.ratio } : null);
    }).catch(function (e) {
      $('loading').hidden = true; toast('錯誤：' + e.message); location.hash = '#/';
    });
  }

  function renderChapter(idx, pos) {
    var book = state.book; if (!book) return;
    idx = Math.min(Math.max(idx, 0), book.chapters.length - 1);
    state.ch = idx; state.restoring = true;
    var c = book.chapters[idx];
    $('chapterTitle').textContent = c[0];
    $('barChapter').textContent = c[0];
    document.title = c[0] + ' — ' + book.title;
    var body = $('chapterBody'); body.textContent = '';
    var frag = document.createDocumentFragment();
    c[1].split('\n').forEach(function (t) { if (t) frag.appendChild(el('p', null, t)); });   // textContent → 自動跳脫 HTML
    if (!frag.childNodes.length) frag.appendChild(el('p', 'empty', '（本章沒有內容）'));
    body.appendChild(frag);
    var atFirst = idx === 0, atLast = idx === book.chapters.length - 1;
    ['btnPrev', 'btnPrev2'].forEach(function (i) { $(i).disabled = atFirst; });
    ['btnNext', 'btnNext2'].forEach(function (i) { $(i).disabled = atLast; });
    window.scrollTo(0, 0);
    if (pos && (pos.para > 0 || pos.ratio > 0)) {
      if (typeof pos.para === 'number' && pos.para < body.children.length) scrollToPara(pos.para);
      else window.scrollTo(0, Math.max(0, (pos.ratio || 0) * (document.documentElement.scrollHeight - window.innerHeight)));
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { state.restoring = false; updateChapterBar(); saveNow(); }); });
    if (!$('drawer').hidden) markToc();
  }

  function gotoChapter(idx) {
    if (!state.book) return;
    if (idx < 0 || idx >= state.book.chapters.length) return;
    renderChapter(idx, null);
  }

  /* ---------- 位置追蹤 ---------- */
  function barH() { return $('topbar').offsetHeight || 48; }
  function currentPara() {
    var ps = $('chapterBody').children, n = ps.length; if (!n) return 0;
    var probe = barH() + 6, lo = 0, hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ps[mid].getBoundingClientRect().bottom > probe) hi = mid; else lo = mid + 1;
    }
    return lo;
  }
  function scrollToPara(i) {
    var ps = $('chapterBody').children; if (!ps.length) return;
    i = Math.min(Math.max(i, 0), ps.length - 1);
    var top = ps[i].getBoundingClientRect().top + window.pageYOffset;
    window.scrollTo(0, Math.max(0, top - barH() - 6));
  }
  function chapterRatio() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.pageYOffset / max)) : 1;
  }
  function updateChapterBar() {
    $('chapterBarFill').style.width = (chapterRatio() * 100) + '%';
    if (state.book) {
      var overall = (state.cum[state.ch] + chapterRatio() * state.lens[state.ch]) / state.total;
      var txt = '第 ' + (state.ch + 1) + ' / ' + state.book.chapters.length + ' 章 · 全書約 ' + pctStr(overall);
      $('bookPct').textContent = txt; $('bbPos').textContent = txt;
    }
  }
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (state.view !== 'read' || !state.book || state.restoring) return;
    var ratio = chapterRatio();
    var rec = progress.books[state.bookId] || {};
    rec.ch = state.ch; rec.title = state.book.chapters[state.ch][0];
    rec.para = currentPara(); rec.ratio = Math.round(ratio * 1000) / 1000;
    rec.pct = Math.min(1, (state.cum[state.ch] + ratio * state.lens[state.ch]) / state.total);
    rec.t = Date.now();
    progress.books[state.bookId] = rec;
    saveProgress();
  }
  function scheduleSave() {
    updateChapterBar();
    if (state.restoring) return;
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400);
  }
  window.addEventListener('scroll', function () { if (state.view === 'read') scheduleSave(); }, { passive: true });
  window.addEventListener('resize', function () { if (state.view === 'read') updateChapterBar(); });
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveNow(); });

  /* 工具列顯示／隱藏 */
  function showBars(on) { $('topbar').classList.toggle('off', !on); $('bottombar').classList.toggle('off', !on); }
  function barsVisible() { return !$('topbar').classList.contains('off'); }
  $('article').addEventListener('click', function (e) {
    if (e.target.closest('button,a,input')) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var y = e.clientY, h = window.innerHeight;
    if (settings.tapZones === 'on' && y < h * 0.2) window.scrollBy(0, -Math.round(h * 0.85));
    else if (settings.tapZones === 'on' && y > h * 0.8) window.scrollBy(0, Math.round(h * 0.85));
    else showBars(!barsVisible());
  });

  /* ---------- 抽屜：目錄＋書籤 ---------- */
  function openDrawer(tab) {
    if (!state.book) return;
    $('drawerMask').hidden = false; $('drawer').hidden = false;
    buildToc(); showTab(tab || 'toc'); markToc(true);
  }
  function closeDrawer() { $('drawerMask').hidden = true; $('drawer').hidden = true; }
  function showTab(t) {
    $('tabToc').classList.toggle('active', t === 'toc'); $('tabBm').classList.toggle('active', t === 'bm');
    $('paneToc').hidden = t !== 'toc'; $('paneBm').hidden = t !== 'bm';
    if (t === 'bm') buildBookmarks();
  }
  var tocBuiltFor = null;
  function buildToc() {
    if (tocBuiltFor === state.bookId) return;
    var ol = $('tocList'); ol.textContent = '';
    var frag = document.createDocumentFragment();
    state.book.chapters.forEach(function (c, i) {
      var li = el('li'); li.dataset.i = i; li.dataset.q = (i + 1) + ' ' + c[0];
      var b = el('button', null, c[0]); b.type = 'button'; li.appendChild(b); frag.appendChild(li);
    });
    ol.appendChild(frag); tocBuiltFor = state.bookId; $('tocFilter').value = '';
  }
  function markToc(scroll) {
    var items = $('tocList').children, cur = null;
    for (var i = 0; i < items.length; i++) {
      var isCur = i === state.ch;
      items[i].classList.toggle('current', isCur);
      items[i].classList.toggle('read', i < state.ch);
      if (isCur) cur = items[i];
    }
    if (scroll && cur) cur.scrollIntoView({ block: 'center' });
  }
  function filterToc() {
    var q = $('tocFilter').value.trim().toLowerCase();
    Array.prototype.forEach.call($('tocList').children, function (li) { li.hidden = q && li.dataset.q.toLowerCase().indexOf(q) < 0; });
  }
  function buildBookmarks() {
    var ul = $('bmList'); ul.textContent = '';
    var rec = progress.books[state.bookId]; var bms = (rec && rec.bm) || [];
    $('bmEmpty').hidden = bms.length > 0;
    bms.forEach(function (bm, i) {
      var li = el('li');
      var go = el('button', 'go'); go.type = 'button'; go.dataset.i = i;
      go.appendChild(document.createTextNode(bm.title || ('第 ' + (bm.ch + 1) + ' 節')));
      go.appendChild(el('small', null, '位置 ' + Math.round((bm.ratio || 0) * 100) + '% · ' + fmtDate(bm.t)));
      var del = el('button', 'icon-btn', '🗑'); del.type = 'button'; del.dataset.i = i; del.setAttribute('aria-label', '刪除書籤');
      li.appendChild(go); li.appendChild(del); ul.appendChild(li);
    });
  }
  function addBookmark() {
    if (!state.book) return;
    saveNow();
    var rec = progress.books[state.bookId] || (progress.books[state.bookId] = { ch: state.ch });
    rec.bm = rec.bm || [];
    rec.bm.push({ ch: state.ch, title: state.book.chapters[state.ch][0], para: currentPara(), ratio: Math.round(chapterRatio() * 1000) / 1000, t: Date.now() });
    if (rec.bm.length > 200) rec.bm.shift();
    rec.t = Date.now();
    saveProgress(); toast('已加入書籤');
  }

  /* ---------- 匯出／匯入進度（格式與離線版相同） ---------- */
  function exportProgress() {
    saveNow();
    var data = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), settings: settings, books: progress.books };
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var a = document.createElement('a'); var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    a.href = URL.createObjectURL(blob);
    a.download = 'novel-progress-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('已匯出進度');
  }
  function importProgress(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var d = JSON.parse(fr.result);
        if (!d || d.format !== FORMAT || !d.books || typeof d.books !== 'object') throw new Error('不是有效的進度檔');
        var n = 0, kept = 0;
        Object.keys(d.books).forEach(function (id) {
          var inc = d.books[id]; if (!inc || typeof inc.ch !== 'number') return;
          var cur = progress.books[id];
          if (!cur || (inc.t || 0) > (cur.t || 0)) {
            if (cur && cur.bm && inc.bm) { var seen = {}; inc.bm.forEach(function (b) { seen[b.ch + ':' + b.para] = 1; }); cur.bm.forEach(function (b) { if (!seen[b.ch + ':' + b.para]) inc.bm.push(b); }); }
            progress.books[id] = inc; n++;
          } else {
            kept++;
            if (inc.bm) { cur.bm = cur.bm || []; var s2 = {}; cur.bm.forEach(function (b) { s2[b.ch + ':' + b.para] = 1; }); inc.bm.forEach(function (b) { if (!s2[b.ch + ':' + b.para]) cur.bm.push(b); }); }
          }
        });
        if (d.settings && typeof d.settings === 'object') {
          Object.keys(DEFAULTS).forEach(function (k) { if (d.settings[k] != null) settings[k] = d.settings[k]; });
          saveSettings(); applySettings();
        }
        saveProgress(); route();
        toast('匯入完成：更新 ' + n + ' 本，保留較新的本機進度 ' + kept + ' 本（未匯入書籍的進度會先保留）');
      } catch (e) { toast('匯入失敗：' + e.message); }
    };
    fr.onerror = function () { toast('無法讀取檔案'); };
    fr.readAsText(file);
  }
  function pickProgress() { var f = $('fileProgress'); f.value = ''; f.click(); }

  /* ---------- 匯入小說 ---------- */
  var importing = false;
  function pickBooks() { if (importing) return; var f = $('fileBooks'); f.value = ''; f.click(); }

  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error || new Error('無法讀取檔案')); }; fr.readAsArrayBuffer(file); });
  }

  // 優先用 Web Worker；若環境不支援則退回主執行緒（較慢但可用）
  function processInWorker(name, buf, onProg) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('js/worker.js'); } catch (e) { return fallback(); }
      var got = false;
      w.onmessage = function (ev) {
        var d = ev.data; got = true;
        if (d.type === 'progress') onProg(d.stage, d.frac);
        else if (d.type === 'done') { w.terminate(); resolve(d.result); }
        else if (d.type === 'error') { w.terminate(); reject(new Error(d.message)); }
      };
      w.onerror = function (ev) { w.terminate(); if (ev && ev.preventDefault) ev.preventDefault(); if (!got) fallback(); else reject(new Error('處理失敗')); };
      try { w.postMessage({ name: name, buf: buf }, [buf]); } catch (e) { w.terminate(); fallback(); }
      function fallback() {
        onProg('處理中（相容模式，畫面可能暫時無回應）', 0.5);
        setTimeout(function () {
          try {
            var title = NovelSplit.titleFromFilename(name), res;
            if (/\.js$/i.test(name)) {
              var b = NovelSplit.parseBookJs(NovelSplit.decodeBuffer(buf).text), st = NovelSplit.statsFromChapters(b.chapters);
              res = { chapters: b.chapters, mode: 'headings', notes: ['由離線版書檔匯入（章節沿用原切分）'], analysis: [], chars: st.chars, firstNo: st.firstNo, lastNo: st.lastNo };
              title = b.title || title;
            } else res = NovelSplit.processText(NovelSplit.decodeBuffer(buf).text);
            res.title = title; resolve(res);
          } catch (err) { reject(err); }
        }, 30);
      }
    });
  }

  function importFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length || importing) return;
    importing = true;
    var list = $('importList'); list.textContent = '';
    $('btnImportClose').disabled = true; $('importHead').textContent = '匯入小說（0/' + files.length + '）';
    $('importMask').hidden = false; $('importPanel').hidden = false;
    var rows = files.map(function (f) {
      var li = el('li'); li.appendChild(el('div', null, f.name));
      var st = el('span', 'st', '等待中…'); li.appendChild(st);
      var bar = el('div', 'pbar'); var fill = el('span'); bar.appendChild(fill); li.appendChild(bar);
      list.appendChild(li); return { li: li, st: st, fill: fill };
    });
    requestPersist().then(renderStorageInfo);
    var okCount = 0, done = 0;
    var chain = Promise.resolve();
    files.forEach(function (file, i) {
      chain = chain.then(function () {
        var row = rows[i];
        function setProg(stage, frac) { row.st.textContent = stage + ' ' + Math.round(frac * 100) + '%'; row.fill.style.width = Math.round(frac * 100) + '%'; }
        if (!/\.(txt|js)$/i.test(file.name) && file.type && file.type.indexOf('text/') !== 0) { row.st.textContent = '略過：不是 .txt 檔'; row.st.className = 'st err'; return; }
        if (!file.size) { row.st.textContent = '略過：檔案是空的'; row.st.className = 'st err'; return; }
        setProg('讀取檔案', 0);
        return readBuffer(file).then(function (buf) {
          setProg('讀取檔案', 1);
          return processInWorker(file.name, buf, setProg);
        }).then(function (res) {
          if (!res.chapters || !res.chapters.length) throw new Error('沒有可用內容');
          var title = res.title || NovelSplit.titleFromFilename(file.name);
          if (!title) title = '未命名';
          var id = bookIdFor(title);
          var existed = !!findBook(id);
          var meta = { id: id, title: title, chapters: res.chapters.length, chars: res.chars, mode: res.mode, firstNo: res.firstNo, lastNo: res.lastNo,
                       notes: res.notes || [], analysis: res.analysis || [], added: Date.now(), srcName: file.name, size: file.size, enc: res.enc };
          row.st.textContent = '寫入裝置儲存空間…'; row.fill.style.width = '100%';
          return dbPutBook(meta, res.chapters).then(function () {
            okCount++;
            row.st.textContent = '完成：「' + title + '」' + res.chapters.length + ' 章' + (existed ? '（已取代同名舊書，閱讀進度保留）' : '') + (res.enc && res.enc !== 'utf-8' && res.enc !== 'js' ? ' · 編碼 ' + res.enc : '');
            row.st.className = 'st ok';
          });
        }).catch(function (err) {
          var msg = (err && err.name === 'QuotaExceededError') ? '儲存空間不足' : (err && err.message || '未知錯誤');
          row.st.textContent = '失敗：' + msg; row.st.className = 'st err';
        }).then(function () { done++; $('importHead').textContent = '匯入小說（' + done + '/' + files.length + '）'; });
      });
    });
    chain.then(function () { return loadLibrary(); }).then(function () {
      importing = false; $('btnImportClose').disabled = false;
      $('importHead').textContent = '匯入完成：成功 ' + okCount + '／' + files.length;
      if (state.view === 'shelf') renderShelf();
    });
  }
  $('btnImportClose').addEventListener('click', function () { $('importMask').hidden = true; $('importPanel').hidden = true; });

  /* ---------- 書架動作：刪除／改名 ---------- */
  function deleteBook(id) {
    var b = findBook(id); if (!b) return;
    if (!confirm('確定要從這個裝置刪除「' + b.title + '」嗎？\n（閱讀進度與書籤會保留，之後重新匯入同名檔案即可接續。）')) return;
    dbDelete(id).then(loadLibrary).then(function () { renderShelf(); toast('已刪除「' + b.title + '」'); })
      .catch(function () { toast('刪除失敗'); });
  }
  function renameBook(id) {
    var b = findBook(id); if (!b) return;
    var nt = prompt('新的書名（書名決定進度對應的書籍 ID，需與電腦版的書名一致才能互通進度）', b.title);
    if (nt == null) return; nt = nt.trim();
    if (!nt || nt === b.title) return;
    var nid = bookIdFor(nt);
    if (findBook(nid)) { toast('已有同名的書'); return; }
    dbGetText(id).then(function (chapters) {
      var meta = Object.assign({}, b, { id: nid, title: nt });
      return dbPutBook(meta, chapters).then(function () { return dbDelete(id); });
    }).then(function () {
      if (progress.books[id]) { progress.books[nid] = progress.books[id]; delete progress.books[id]; saveProgress(); }
      return loadLibrary();
    }).then(function () { renderShelf(); toast('已改名'); }).catch(function () { toast('改名失敗'); });
  }

  /* ---------- 路由 ---------- */
  function route() {
    var h = location.hash || '#/';
    var m = h.match(/^#\/read\/([A-Za-z0-9_-]+)/);
    closeDrawer(); closeSettings();
    if (m && findBook(m[1])) {
      if (state.view === 'read' && state.bookId === m[1] && state.book) return;
      openBook(m[1]);
    } else {
      saveNow();
      state.view = 'shelf'; state.book = null; state.bookId = null; tocBuiltFor = null;
      $('readerView').hidden = true; $('shelfView').hidden = false; $('loading').hidden = true;
      document.title = '小說書架';
      if (m) history.replaceState(null, '', location.pathname + location.search + '#/');
      renderShelf(); window.scrollTo(0, 0);
    }
  }
  window.addEventListener('hashchange', route);

  /* ---------- 事件 ---------- */
  $('bookGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var li = b.closest('.book-card'); if (!li) return;
    var id = li.dataset.id, act = b.dataset.act;
    if (act === 'read') location.hash = '#/read/' + id;
    else if (act === 'delete') deleteBook(id);
    else if (act === 'rename') renameBook(id);
    else if (act === 'reset') {
      if (confirm('確定要清除「' + findBook(id).title + '」的閱讀進度與書籤嗎？')) { delete progress.books[id]; saveProgress(); renderShelf(); }
    }
  });
  $('btnPickBooks').addEventListener('click', pickBooks);
  $('fileBooks').addEventListener('change', function (e) { importFiles(e.target.files); });
  $('btnBack').addEventListener('click', function () { saveNow(); location.hash = '#/'; });
  $('btnToc').addEventListener('click', function () { openDrawer('toc'); });
  $('btnToc2').addEventListener('click', function () { openDrawer('toc'); });
  $('btnBookmark').addEventListener('click', addBookmark);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnShelfSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', closeSettings);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('drawerMask').addEventListener('click', closeDrawer);
  ['btnPrev', 'btnPrev2'].forEach(function (i) { $(i).addEventListener('click', function () { gotoChapter(state.ch - 1); }); });
  ['btnNext', 'btnNext2'].forEach(function (i) { $(i).addEventListener('click', function () { gotoChapter(state.ch + 1); }); });
  $('tabToc').addEventListener('click', function () { showTab('toc'); });
  $('tabBm').addEventListener('click', function () { showTab('bm'); });
  $('tocFilter').addEventListener('input', filterToc);
  $('tocList').addEventListener('click', function (e) {
    var li = e.target.closest('li'); if (!li) return;
    closeDrawer(); gotoChapter(parseInt(li.dataset.i, 10));
  });
  $('bmList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var i = parseInt(b.dataset.i, 10), rec = progress.books[state.bookId]; if (!rec || !rec.bm || !rec.bm[i]) return;
    if (b.classList.contains('go')) { var bm = rec.bm[i]; closeDrawer(); renderChapter(bm.ch, { para: bm.para, ratio: bm.ratio }); }
    else { rec.bm.splice(i, 1); saveProgress(); buildBookmarks(); }
  });
  $('setFont').addEventListener('input', function (e) { changeSetting('fontSize', parseInt(e.target.value, 10)); });
  $('setLine').addEventListener('input', function (e) { changeSetting('lineHeight', parseFloat(e.target.value)); });
  $('fontMinus').addEventListener('click', function () { changeSetting('fontSize', Math.max(14, settings.fontSize - 1)); });
  $('fontPlus').addEventListener('click', function () { changeSetting('fontSize', Math.min(36, settings.fontSize + 1)); });
  [['segTheme', 'theme'], ['segFont', 'font'], ['segWidth', 'width'], ['segTap', 'tapZones']].forEach(function (p) {
    $(p[0]).addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) changeSetting(p[1], b.dataset.v); });
  });
  $('btnResetSettings').addEventListener('click', function () { Object.assign(settings, DEFAULTS, EXTRA_DEFAULTS); saveSettings(); applySettings(); });
  $('btnExport').addEventListener('click', exportProgress);
  $('btnExport2').addEventListener('click', exportProgress);
  $('btnImport').addEventListener('click', pickProgress);
  $('btnImport2').addEventListener('click', pickProgress);
  $('fileProgress').addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) importProgress(e.target.files[0]); });

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' && e.target.type !== 'range') { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') { closeDrawer(); closeSettings(); return; }
    if (state.view !== 'read' || !state.book) return;
    var modal = !$('drawer').hidden || !$('settingsPanel').hidden;
    if (e.key === 'ArrowLeft' && !modal) { e.preventDefault(); gotoChapter(state.ch - 1); }
    else if (e.key === 'ArrowRight' && !modal) { e.preventDefault(); gotoChapter(state.ch + 1); }
    else if ((e.key === 't' || e.key === 'T') && !modal) { openDrawer('toc'); }
  });

  /* ---------- PWA：Service Worker（僅 https 或 localhost） ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  /* ---------- 啟動 ---------- */
  applySettings();
  openDB().then(loadLibrary).catch(function () { LIB = []; }).then(function () {
    route();
    if (LIB.length) requestPersist().then(renderStorageInfo);
    window.__ready = true;
  });
})();
