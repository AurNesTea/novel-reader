/* 小說閱讀器（網頁版）— 純原生 JS。書本文字只存在使用者裝置的 IndexedDB（本機匯入或從使用者自己的 Google 雲端硬碟下載的快取）。
   雲端相關（登入、Drive REST）在 js/drive.js；這裡負責書架合併、快取與進度同步。 */
(function () {
  'use strict';

  var KEY_P = 'novelReader.progress.v1';      // 與離線版相同的鍵與格式，方便搬進度
  var KEY_S = 'novelReader.settings.v1';
  var KEY_F = 'novelReader.shelfFold.v1';      // 書架卡片收合狀態（獨立於進度，不會進匯出的進度 JSON）
  var FORMAT = 'novel-reader-progress';
  var DEFAULTS = { fontSize: 19, lineHeight: 1.9, theme: 'light', font: 'sans', width: 'medium' };
  var EXTRA_DEFAULTS = { tapZones: 'on', typeset: 'on' };   // 網頁版專屬設定（離線版會忽略）
  var THEME_COLOR = { light: '#f6f6f4', sepia: '#f4ecd8', dark: '#16181c' };
  var LIB = [];                               // 書籍中繼資料（不含文字）
  var KEY_ST = 'novelReader.settingsT.v1';     // 設定最後修改時間（同步時新者為準）
  var KEY_DEL = 'novelReader.deleted.v1';      // 已清除進度的書 { 書ID: 時間 }（同步用，避免被雲端舊資料復活）
  var KEY_FOLDER = 'novelReader.driveFolder.v1';
  var KEY_DLIST = 'novelReader.driveList.v1';  // 最後一次的雲端書單（離線時也能顯示）
  var KEY_SYNC = 'novelReader.sync.v1';        // { at: 上次成功同步時間, fileId: 雲端進度檔 ID }
  var KEY_DIRTY = 'novelReader.syncDirty.v1';  // 有尚未上傳的變更
  var SYNC_FILE = 'novel-reader-progress.json';
  var CFG = window.NOVEL_READER_CONFIG || {};
  var ND = window.NovelDrive || null;
  var CLOUD = !!(ND && ND.configured);

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
  var settingsT = +sget(KEY_ST) || 0;
  var deleted = jget(KEY_DEL, {}); if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) deleted = {};
  function saveDeleted() { sset(KEY_DEL, JSON.stringify(deleted)); }
  // 使用者造成的進度變更：存檔並排程同步
  function touch() { saveProgress(); markDirty(); }
  var fold = jget(KEY_F, {}); if (!fold || typeof fold !== 'object' || Array.isArray(fold)) fold = {};   // { 書ID: true(收合) | false(展開) }
  function saveFold() { sset(KEY_F, JSON.stringify(fold)); }
  var defaultOpenId = null;                   // 沒有手動設定過時，只有「最近讀過的書」預設展開
  function isCollapsed(id) { return typeof fold[id] === 'boolean' ? fold[id] : id !== defaultOpenId; }
  function setCardFold(li, collapsed) {
    li.classList.toggle('collapsed', collapsed);
    var t = li.querySelector('.fold-toggle'), body = li.querySelector('.book-body');
    t.setAttribute('aria-expanded', collapsed ? 'false' : 'true'); body.hidden = collapsed;
  }
  function updateFoldAll() {
    var cards = $('bookGrid').children, allCollapsed = cards.length > 0;
    for (var i = 0; i < cards.length; i++) if (!cards[i].classList.contains('collapsed')) { allCollapsed = false; break; }
    var b = $('btnFoldAll'); b.textContent = allCollapsed ? '全部展開' : '全部收合'; b.dataset.mode = allCollapsed ? 'expand' : 'collapse';
    $('foldBar').hidden = cards.length === 0;
    $('shelfCount').textContent = cards.length + ' 本書';
  }
  function toggleCard(li) {
    var c = !li.classList.contains('collapsed');
    fold[li.dataset.id] = c; saveFold(); setCardFold(li, c); updateFoldAll();
  }
  function foldAll(collapsed) {
    Array.prototype.forEach.call($('bookGrid').children, function (li) { fold[li.dataset.id] = collapsed; setCardFold(li, collapsed); });
    saveFold(); updateFoldAll();
  }
  function saveSettings(fromUser) {
    sset(KEY_S, JSON.stringify(settings));
    if (fromUser) { settingsT = Date.now(); sset(KEY_ST, String(settingsT)); markDirty(); }
  }

  /* ---------- 小工具 ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pctStr(p) { return (Math.round((p || 0) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%'; }
  function fmtDate(t) { try { return new Date(t).toLocaleString('zh-TW', { hour12: false }); } catch (e) { return ''; } }
  function findLocal(id) { for (var i = 0; i < LIB.length; i++) if (LIB[i].id === id) return LIB[i]; return null; }
  // 書架上的一本書：本機（匯入或雲端快取）或雲端書單中的書
  function findBook(id) { return findLocal(id) || (driveById[id] ? { id: id, title: driveById[id].title, driveOnly: true } : null); }
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
    [['segTheme', 'theme'], ['segFont', 'font'], ['segWidth', 'width'], ['segTap', 'tapZones'], ['segTypeset', 'typeset']].forEach(function (p) {
      Array.prototype.forEach.call($(p[0]).children, function (b) { b.classList.toggle('on', b.dataset.v === settings[p[1]]); });
    });
    // 排版優化開關改變（含重設、其他裝置同步）→ 重新排這一章，停在同一個原始行
    if (state.view === 'read' && state.book && typeof state.tsOn === 'boolean' && state.tsOn !== (settings.typeset !== 'off')) {
      renderChapter(state.ch, { para: currentPara(), ratio: 0 });
    }
  }
  function changeSetting(k, v) {
    var anchor = state.view === 'read' ? currentPara() : -1;
    settings[k] = v; saveSettings(true); applySettings();
    if (anchor >= 0) scrollToPara(anchor);
  }
  function openSettings() { $('settingsMask').hidden = false; $('settingsPanel').hidden = false; }
  function closeSettings() { $('settingsMask').hidden = true; $('settingsPanel').hidden = true; }

  /* ---------- 書架 ---------- */
  // 合併本機書（匯入／雲端快取）與雲端書單；同一本書（同書名 → 同 ID）只出現一次
  function shelfEntries() {
    var map = {}, out = [];
    LIB.forEach(function (m) { map[m.id] = { id: m.id, title: m.title, meta: m, drive: null }; out.push(map[m.id]); });
    Object.keys(driveById).forEach(function (id) {
      var f = driveById[id];
      if (map[id]) map[id].drive = f;
      else { map[id] = { id: id, title: f.title, meta: null, drive: f }; out.push(map[id]); }
    });
    return out;
  }
  function findEntry(id) { var e = shelfEntries(); for (var i = 0; i < e.length; i++) if (e[i].id === id) return e[i]; return null; }
  function sameVersion(meta, f) {
    if (!meta || !f || meta.driveId !== f.id) return false;
    if (meta.md5 && f.md5Checksum) return meta.md5 === f.md5Checksum;
    return meta.modifiedTime === f.modifiedTime && (!f.size || meta.size === f.size);
  }
  // 'local' 本機匯入 | 'cached' 雲端快取（最新） | 'stale' 雲端有新版 | 'remote' 尚未下載 | 'orphan' 快取但不在目前書單
  function entryKind(e) {
    if (e.meta && e.meta.source !== 'drive') return 'local';
    if (e.meta && !e.drive) return 'orphan';
    if (e.meta) return sameVersion(e.meta, e.drive) ? 'cached' : 'stale';
    return 'remote';
  }
  function renderShelf() {
    var grid = $('bookGrid'); grid.textContent = '';
    var entries = shelfEntries();
    $('emptyState').hidden = entries.length > 0;
    var books = entries.sort(function (a, b) {
      var ta = (progress.books[a.id] || {}).t || 0, tb = (progress.books[b.id] || {}).t || 0;
      return tb - ta || (a.title < b.title ? -1 : 1);
    });
    var top = books[0]; defaultOpenId = (top && (progress.books[top.id] || {}).t) ? top.id : null;
    books.forEach(function (e) {
      var b = e.meta || {}, kind = entryKind(e), p = progress.books[e.id];
      var li = el('li', 'book-card');
      li.dataset.id = e.id; li.dataset.kind = kind;
      var h3 = el('h3', 'book-title');
      var tg = el('button', 'fold-toggle', e.title); tg.type = 'button'; tg.dataset.act = 'fold'; tg.setAttribute('aria-controls', 'body-' + e.id);
      h3.appendChild(tg); li.appendChild(h3);
      var pct = (p && p.pct) ? Math.min(100, p.pct * 100) : 0;
      if (p && typeof p.ch === 'number') { tg.dataset.pct = pctStr(p.pct); li.style.setProperty('--p', pct + '%'); }
      if (kind !== 'local') tg.dataset.cloud = '1';
      var body = el('div', 'book-body'); body.id = 'body-' + e.id;
      var cardEl = li; li = body;               // 以下內容都放進可收合的 body
      var mrow = el('div', 'book-meta');
      if (kind !== 'local') mrow.appendChild(el('span', 'badge cloud', '雲端'));
      else if (e.drive) mrow.appendChild(el('span', 'badge', '本機匯入'));
      var meta, info = [];
      if (e.meta) {
        meta = '共 ' + b.chapters + ' 章 · 約 ' + Math.round(b.chars / 10000) + ' 萬字';
        if (kind === 'cached') meta += ' · 離線可讀';
        if (kind === 'stale') meta += ' · 雲端有新版';
        if (kind === 'orphan') meta += ' · 已快取';
        if (b.mode === 'headings' && b.firstNo && b.firstNo > 1) info.push('收錄第 ' + b.firstNo + '–' + b.lastNo + ' 章');
        if (b.mode === 'chunked') { meta += ' · 無章名'; info.push('無章名，已自動分段'); }
        if (kind === 'cached') info.push('已存在這台裝置，離線也能讀');
        if (kind === 'stale') info.push('雲端有新版本，開啟時會重新下載');
        if (kind === 'orphan') info.push('已快取，但不在目前的雲端資料夾');
      } else { meta = (e.drive.size ? fmtMB(e.drive.size) + ' · ' : '') + '尚未下載'; info.push('開啟時會從雲端硬碟下載'); }
      mrow.appendChild(el('span', 'meta-txt', meta));
      li.appendChild(mrow);
      var prog = el('div', 'book-prog');
      var last = el('div', 'book-last');
      if (p && typeof p.ch === 'number') {
        last.appendChild(el('span', 'last-ch', '讀到 ' + (p.title || ('第 ' + (p.ch + 1) + ' 章'))));
        last.appendChild(el('span', 'last-pct', pctStr(p.pct)));
      } else last.appendChild(el('span', 'last-ch muted', '尚未開始閱讀'));
      prog.appendChild(last);
      var bar = el('div', 'pbar'); var fill = el('span'); fill.style.width = pct + '%'; bar.appendChild(fill); prog.appendChild(bar);
      if (p && typeof p.ch === 'number') prog.appendChild(el('div', 'book-sub', '章節 ' + (p.ch + 1) + (b.chapters ? ' / ' + b.chapters : '') + (p.t ? ' · ' + fmtTime(p.t) : '')));
      li.appendChild(prog);
      var act = el('div', 'book-actions');
      var go = el('button', 'btn primary', p ? '繼續閱讀' : '開始閱讀'); go.type = 'button'; go.dataset.act = 'read'; act.appendChild(go);
      var more = el('button', 'icon-btn more-btn', '⋯'); more.type = 'button'; more.dataset.act = 'more';
      more.setAttribute('aria-label', '更多操作'); more.title = '更多操作'; more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'more-' + e.id);
      act.appendChild(more);
      li.appendChild(act);
      var mp = el('div', 'book-more'); mp.id = 'more-' + e.id; mp.hidden = true;
      var act2 = el('div', 'more-btns');
      var btns = kind === 'local' ? [e.drive ? null : ['rename', '改書名'], p ? ['reset', '清除進度'] : null, ['delete', '刪除']]
                                  : [p ? ['reset', '清除進度'] : null, e.meta ? ['uncache', '清除快取'] : null];
      btns.forEach(function (x) {
        if (!x) return;
        var bt = el('button', 'btn small' + (x[0] === 'delete' ? ' danger' : ''), x[1]); bt.type = 'button'; bt.dataset.act = x[0]; act2.appendChild(bt);
      });
      if (act2.children.length) mp.appendChild(act2);
      info.forEach(function (t) { mp.appendChild(el('p', 'more-info', t)); });
      var notes = (b.notes || []).concat(b.analysis || []).concat(e.drive && e.drive.dupNote ? [e.drive.dupNote] : []);
      if (notes.length) {
        var det = el('details'); det.appendChild(el('summary', null, '章節檢查（' + notes.length + ' 項）'));
        var ul = el('ul'); notes.forEach(function (n) { ul.appendChild(el('li', null, n)); }); det.appendChild(ul); mp.appendChild(det);
      }
      li.appendChild(mp);
      li = cardEl; li.appendChild(body); setCardFold(li, isCollapsed(e.id));
      grid.appendChild(li);
    });
    updateFoldAll();
    $('storageWarn').hidden = storageOK;
    $('idbWarn').hidden = dbOK;
    renderStorageInfo();
    renderCloud();
  }

  /* ---------- 讀者狀態 ---------- */
  var state = { view: 'shelf', book: null, bookId: null, ch: 0, cum: [], lens: [], total: 1, restoring: false };
  var saveTimer = null;

  var loadAbort = null;
  function setLoading(text, frac) {
    $('loadingText').textContent = text;
    $('loadingBar').hidden = frac == null;
    if (frac != null) $('loadingFill').style.width = Math.round(Math.min(1, Math.max(0, frac)) * 100) + '%';
  }
  // 取得章節：本機／快取直接讀；雲端書（未下載或有新版）在線上時下載 → 切章 → 存入快取
  function loadChapters(entry, signal) {
    var kind = entryKind(entry);
    if (kind === 'local' || kind === 'cached' || kind === 'orphan' || (kind === 'stale' && !navigator.onLine)) {
      return dbGetText(entry.id).then(function (ch) {
        if (ch && ch.length) { if (kind === 'stale') toast('目前離線，先使用這台裝置上的舊版本'); return ch; }
        if (entry.drive) return downloadBook(entry, signal);
        throw new Error('找不到這本書的內容，請重新匯入');
      });
    }
    return downloadBook(entry, signal);
  }
  function downloadBook(entry, signal) {
    var f = entry.drive;
    if (!navigator.onLine) return Promise.reject(new Error('目前離線，這本書還沒下載到這台裝置，連上網路後再開啟'));
    setLoading('連線 Google 雲端硬碟…', 0);
    return ND.download(f.id, f.size, function (got, total) {
      setLoading('下載中 ' + fmtMB(got) + ' / ' + fmtMB(total) + '（' + Math.round(got / total * 100) + '%）', got / total * 0.6);
    }, signal).then(function (buf) {
      if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'abort' });
      setLoading('切分章節…', 0.6);
      return processInWorker(f.name, buf, function (stage, frac) { setLoading(stage + ' ' + Math.round(frac * 100) + '%', 0.6 + frac * 0.35); });
    }).then(function (res) {
      if (!res.chapters || !res.chapters.length) throw new Error('這個檔案沒有可用內容');
      var meta = { id: entry.id, title: entry.title, chapters: res.chapters.length, chars: res.chars, mode: res.mode, firstNo: res.firstNo, lastNo: res.lastNo,
                   notes: res.notes || [], analysis: res.analysis || [], added: Date.now(), srcName: f.name, size: f.size, enc: res.enc,
                   source: 'drive', driveId: f.id, modifiedTime: f.modifiedTime, md5: f.md5Checksum };
      setLoading('存到這台裝置…', 0.97);
      requestPersist();
      return dbPutBook(meta, res.chapters).then(loadLibrary).then(function () { return res.chapters; });
    });
  }
  // 開書前先等雲端進度拉下來（最多 6 秒），避免用舊進度覆蓋其他裝置的新進度
  function waitSync() {
    var p = wakeP || syncing; if (!p) return Promise.resolve();
    return Promise.race([p.catch(function () {}), new Promise(function (r) { setTimeout(r, 6000); })]);
  }
  function openBook(id) {
    state.view = 'read'; state.bookId = id; state.book = null;
    $('shelfView').hidden = true; $('readerView').hidden = false; $('loading').hidden = false;
    setLoading('載入中…', null);
    $('chapterTitle').textContent = ''; $('chapterBody').textContent = '';
    showBars(true);
    var entry = findEntry(id);
    if (loadAbort) loadAbort.abort();
    var ac = window.AbortController ? new AbortController() : null; loadAbort = ac;
    waitSync().then(function () {
      if (state.bookId !== id) return null;
      return loadChapters(entry, ac && ac.signal);
    }).then(function (chapters) {
      if (state.bookId !== id || !chapters) return;
      if (!chapters || !chapters.length) throw new Error('找不到這本書的內容，請重新匯入');
      var book = { id: id, title: entry.title, chapters: chapters };
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
      if (state.bookId !== id) return;
      $('loading').hidden = true;
      if (!(e && e.code === 'abort')) toast('錯誤：' + (e && e.message || e));
      location.hash = '#/';
    });
  }

  function renderChapter(idx, pos) {
    var book = state.book; if (!book) return;
    idx = Math.min(Math.max(idx, 0), book.chapters.length - 1);
    state.ch = idx; state.restoring = true;
    var c = book.chapters[idx];
    $('chapterTitle').textContent = c[0];
    $('barChapter').textContent = String(c[0] || '').trim(); $('barChapter').parentNode.title = (state.book && state.book.title ? state.book.title + ' · ' : '') + String(c[0] || '').trim();
    document.title = c[0] + ' — ' + book.title;
    var body = $('chapterBody'); body.textContent = '';
    var frag = document.createDocumentFragment();
    // 排版優化：段落重排＋引號統一（只影響顯示）；para 位置一律以「原始行號」記錄，舊進度與其他裝置相容
    var tsOn = state.tsOn = settings.typeset !== 'off';
    var paras = window.Typeset.layout(c[1], tsOn);
    state.rawN = paras.length ? paras[paras.length - 1].start + paras[paras.length - 1].count : 0;
    paras.forEach(function (q) {
      var pe = el('p', null, q.text.replace(/^[\s\u3000\u00a0\ufeff]+/, ''));   // 開頭空白一律去掉，縮排交給 CSS   // textContent → 自動跳脫 HTML
      pe.dataset.s = q.start; pe.dataset.n = q.count; frag.appendChild(pe);
    });
    if (!frag.childNodes.length) frag.appendChild(el('p', 'empty', '（本章沒有內容）'));
    body.appendChild(frag);
    var atFirst = idx === 0, atLast = idx === book.chapters.length - 1;
    $('btnPrev').disabled = atFirst;
    $('btnNext').disabled = atLast;
    $('btnShelf2').hidden = !atLast;
    $('nextTitle').textContent = atLast ? '' : '下一章：' + book.chapters[idx + 1][0];
    var m = /^\s*(第\s*[0-9０-９零〇一二兩三四五六七八九十百千萬]+\s*[章回節卷集話])/.exec(c[0]);
    $('endMark').textContent = atLast ? '全書完' : (m ? m[1].replace(/\s+/g, '') + ' 完' : '本章完');
    window.scrollTo(0, 0);
    if (pos && (pos.para > 0 || pos.ratio > 0)) {
      if (typeof pos.para === 'number' && pos.para < state.rawN) scrollToPara(pos.para);
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
  // 回傳目前畫面頂端的「原始行號」：先找到段落，合併段落再依高度比例換算成其中第幾行
  function currentPara() {
    var ps = $('chapterBody').children, n = ps.length; if (!n) return 0;
    var probe = barH() + 6, lo = 0, hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ps[mid].getBoundingClientRect().bottom > probe) hi = mid; else lo = mid + 1;
    }
    var p = ps[lo], s = +p.dataset.s, k = +p.dataset.n || 1;
    if (isNaN(s)) return lo;
    if (k <= 1) return s;
    var r = p.getBoundingClientRect(), f = r.height > 0 ? (probe - r.top) / r.height : 0;
    return s + Math.min(k - 1, Math.max(0, Math.round(f * k)));
  }
  // 捲到原始行號 i 所在的段落（合併段落內依比例定位）
  function scrollToPara(i) {
    var ps = $('chapterBody').children; if (!ps.length) return;
    i = Math.max(i, 0);
    var lo = 0, hi = ps.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; var sm = +ps[mid].dataset.s; if (isNaN(sm) || sm <= i) lo = mid; else hi = mid - 1; }
    var p = ps[lo], s = +p.dataset.s, k = +p.dataset.n || 1, r = p.getBoundingClientRect();
    var off = (!isNaN(s) && k > 1) ? Math.min(k - 1, i - s) / k * r.height : 0;
    window.scrollTo(0, Math.max(0, r.top + window.pageYOffset + off - barH() - 6));
  }
  function chapterRatio() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.pageYOffset / max)) : 1;
  }
  function updateChapterBar() {
    $('chapterBarFill').style.width = (chapterRatio() * 100) + '%';
    if (state.book) {
      var overall = (state.cum[state.ch] + chapterRatio() * state.lens[state.ch]) / state.total;
      $('bbPos').textContent = (state.ch + 1) + ' / ' + state.book.chapters.length + ' 章 · ' + pctStr(overall);
      $('bbPos').title = '第 ' + (state.ch + 1) + ' / ' + state.book.chapters.length + ' 章 · 全書約 ' + pctStr(overall);
      $('bbFill').style.width = Math.min(100, overall * 100) + '%';
    }
  }
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (state.view !== 'read' || !state.book || state.restoring) return;
    var ratio = chapterRatio();
    var rec = progress.books[state.bookId] || {};
    var prevPos = { ch: rec.ch, para: rec.para, ratio: rec.ratio };
    rec.ch = state.ch; rec.title = state.book.chapters[state.ch][0];
    rec.para = currentPara(); rec.ratio = Math.round(ratio * 1000) / 1000;
    rec.pct = Math.min(1, (state.cum[state.ch] + ratio * state.lens[state.ch]) / state.total);
    var changed = rec.ch !== prevPos.ch || rec.para !== prevPos.para || rec.ratio !== prevPos.ratio;
    // 只有位置真的改變才更新時間戳：同步時以 t 判斷哪台裝置較新，停在原處的裝置不該蓋掉別台的新進度
    if (changed || !rec.t) rec.t = Date.now();
    progress.books[state.bookId] = rec;
    if (changed) touch(); else saveProgress();
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
    var nb = { ch: state.ch, title: state.book.chapters[state.ch][0], para: currentPara(), ratio: Math.round(chapterRatio() * 1000) / 1000, t: Date.now() };
    rec.bm.push(nb);
    if (rec.bmDel) rec.bmDel = rec.bmDel.filter(function (d) { return d.k !== nb.ch + ':' + nb.para; });
    if (rec.bm.length > 200) rec.bm.shift();
    rec.t = Date.now();
    touch(); toast('已加入書籤');
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
          saveSettings(true); applySettings();
        }
        touch(); route();
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
      try { w = new Worker('js/worker.js?v=9'); } catch (e) { return fallback(); }
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
      if (progress.books[id]) { progress.books[nid] = progress.books[id]; progress.books[nid].t = Date.now(); delete progress.books[id]; deleted[id] = Date.now(); delete deleted[nid]; saveDeleted(); touch(); }
      if (typeof fold[id] === 'boolean') { fold[nid] = fold[id]; delete fold[id]; saveFold(); }
      return loadLibrary();
    }).then(function () { renderShelf(); toast('已改名'); }).catch(function () { toast('改名失敗'); });
  }

  /* ---------- Google 雲端硬碟：書單 ---------- */
  var driveList = jget(KEY_DLIST, null);       // { folderId, files:[…], at }
  var driveById = {};
  var syncInfo = jget(KEY_SYNC, {}); if (!syncInfo || typeof syncInfo !== 'object') syncInfo = {};
  function saveSyncInfo() { sset(KEY_SYNC, JSON.stringify(syncInfo)); }
  function folderId() { return sget(KEY_FOLDER) || CFG.DEFAULT_FOLDER_ID || ''; }
  function cloudOn() { return CLOUD && ND.isSignedIn(); }
  function indexDrive() {
    driveById = {};
    if (!cloudOn() || !driveList || driveList.folderId !== folderId() || !Array.isArray(driveList.files)) return;
    driveList.files.forEach(function (f) {
      var title = NovelSplit.titleFromFilename(f.name) || '未命名';
      var id = bookIdFor(title), prev = driveById[id];
      var g = Object.assign({}, f, { title: title });
      if (prev) {   // 同書名的多個檔案：用最新修改的那一個
        var keep = (g.modifiedTime > prev.modifiedTime) ? g : prev, other = keep === g ? prev : g;
        keep.dupNote = '雲端資料夾有多個同名檔案，使用最新修改的「' + keep.name + '」（另有「' + other.name + '」）';
        driveById[id] = keep;
      } else driveById[id] = g;
    });
  }
  var listing = null;
  function refreshDriveList(quiet) {
    if (!cloudOn()) return Promise.resolve();
    if (listing) return listing;
    var fid = folderId();
    if (!fid) return Promise.resolve();
    cloudMsg('讀取雲端書單…');
    listing = ND.listTxt(fid).then(function (files) {
      driveList = { folderId: fid, files: files, at: Date.now() }; sset(KEY_DLIST, JSON.stringify(driveList));
      indexDrive(); cloudMsg(files.length ? '' : '這個雲端資料夾裡沒有 .txt 檔');
      if (state.view === 'shelf') renderShelf();
    }).catch(function (e) {
      cloudMsg(e.code === 'offline' ? '目前離線，顯示上次的雲端書單' : e.code === 'auth' ? '' : '無法讀取雲端書單：' + e.message);
      if (!quiet && e.code !== 'auth' && e.code !== 'offline') toast('無法讀取雲端書單：' + e.message);
      if (e.code === 'auth') renderCloud();
    }).then(function () { listing = null; });
    return listing;
  }
  function cloudMsg(t) { var m = $('cloudMsg'); m.textContent = t || ''; m.hidden = !t; }

  /* ---------- 跨裝置進度同步（appDataFolder/novel-reader-progress.json） ---------- */
  var syncing = null, syncAgain = false, pushTimer = null, wakeP = null, lastRemote = null;
  var syncStat = { s: 'idle', msg: '' };
  var dirtySeq = 0;
  function markDirty() { if (!cloudOn()) return; dirtySeq++; sset(KEY_DIRTY, '1'); schedulePush(); renderSync(); }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(function () { syncNow(); }, 8000); }
  function stableStr(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stableStr(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function syncPayload(st) {
    return { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), settings: st.settings, settingsUpdatedAt: st.settingsT, books: st.books, deleted: st.deleted };
  }
  function localState() { return { books: progress.books, deleted: deleted, settings: settings, settingsT: settingsT }; }
  function remoteState(d) {
    d = (d && d.format === FORMAT && d.books && typeof d.books === 'object') ? d : {};
    return { books: d.books || {}, deleted: (d.deleted && typeof d.deleted === 'object') ? d.deleted : {}, settings: d.settings || null, settingsT: +d.settingsUpdatedAt || 0 };
  }
  // 合併：每本書較新的 t 為準；書籤取聯集（刪除過的書籤以刪除時間判斷）；清除進度的紀錄比進度新就刪除；設定較新者為準
  function mergeStates(L, R) {
    var out = { books: {}, deleted: {}, settings: L.settings, settingsT: L.settingsT };
    Object.keys(L.deleted).concat(Object.keys(R.deleted)).forEach(function (id) { out.deleted[id] = Math.max(+L.deleted[id] || 0, +R.deleted[id] || 0); });
    var ids = {}; Object.keys(L.books).concat(Object.keys(R.books)).forEach(function (id) { ids[id] = 1; });
    Object.keys(ids).forEach(function (id) {
      var a = L.books[id], b = R.books[id];
      if (a && typeof a.ch !== 'number') a = null; if (b && typeof b.ch !== 'number') b = null;
      if (!a && !b) return;
      var win = !b || (a && (a.t || 0) >= (b.t || 0)) ? a : b, lose = win === a ? b : a;
      if (out.deleted[id] && out.deleted[id] >= (win.t || 0)) return;
      var rec = clone(win);
      var dels = {};
      [win, lose].forEach(function (r) { ((r && r.bmDel) || []).forEach(function (d) { if (d && d.k) dels[d.k] = Math.max(dels[d.k] || 0, d.t || 0); }); });
      var bms = {}, order = [];
      [win, lose].forEach(function (r) {
        ((r && r.bm) || []).forEach(function (m) {
          var k = m.ch + ':' + m.para;
          if (dels[k] && dels[k] >= (m.t || 0)) return;
          if (!bms[k]) order.push(k);
          if (!bms[k] || (m.t || 0) > (bms[k].t || 0)) bms[k] = clone(m);
        });
      });
      var bm = order.map(function (k) { return bms[k]; }).sort(function (x, y) { return (x.t || 0) - (y.t || 0); }).slice(-200);
      if (bm.length) rec.bm = bm; else delete rec.bm;
      var dl = Object.keys(dels).map(function (k) { return { k: k, t: dels[k] }; }).sort(function (x, y) { return x.t - y.t; }).slice(-200);
      if (dl.length) rec.bmDel = dl; else delete rec.bmDel;
      out.books[id] = rec;
    });
    if (R.settings && R.settingsT > L.settingsT) {
      var ns = Object.assign({}, settings);
      Object.keys(DEFAULTS).concat(Object.keys(EXTRA_DEFAULTS)).forEach(function (k) { if (R.settings[k] != null) ns[k] = R.settings[k]; });
      out.settings = ns; out.settingsT = R.settingsT;
    }
    return out;
  }
  function sameState(a, b) { return stableStr({ b: a.books, d: a.deleted, s: a.settings, t: a.settingsT }) === stableStr({ b: b.books, d: b.deleted, s: b.settings, t: b.settingsT }); }
  function applyMerged(m) {
    var cur = state.view === 'read' && state.book ? clone(progress.books[state.bookId]) : null;
    var settingsChanged = stableStr(m.settings) !== stableStr(settings);
    progress.books = m.books; deleted = m.deleted; saveProgress(); saveDeleted();
    if (settingsChanged || m.settingsT !== settingsT) {
      var anchor = state.view === 'read' && state.book ? currentPara() : -1;
      settings = Object.assign({}, DEFAULTS, EXTRA_DEFAULTS, m.settings); settingsT = m.settingsT; saveSettings(); sset(KEY_ST, String(settingsT)); applySettings();
      if (anchor >= 0) scrollToPara(anchor);
    }
    if (state.view === 'shelf') renderShelf();
    else if (state.book) {
      var nw = progress.books[state.bookId];
      // 其他裝置讀得比較新：跳到那個位置
      if (nw && cur && (nw.t || 0) > (cur.t || 0) && (nw.ch !== cur.ch || nw.para !== cur.para)) {
        renderChapter(Math.min(nw.ch, state.book.chapters.length - 1), { para: nw.para, ratio: nw.ratio });
        toast('已套用其他裝置的進度：' + (nw.title || ('第 ' + (nw.ch + 1) + ' 章')));
      }
      if (!$('drawer').hidden && !$('paneBm').hidden) buildBookmarks();
    }
  }
  function setSync(s, msg) { syncStat = { s: s, msg: msg || '' }; renderSync(); }
  function syncNow() {
    if (!cloudOn()) return Promise.resolve();
    if (syncing) { syncAgain = true; return syncing; }
    if (state.view === 'read' && state.book && !state.restoring) saveNow();   // 先把目前位置寫入
    clearTimeout(pushTimer); pushTimer = null;
    if (!navigator.onLine) { setSync('offline'); return Promise.resolve(); }
    if (!ND.hasToken()) { setSync('needauth'); return Promise.resolve(); }
    setSync('syncing');
    var seq0 = dirtySeq;
    var fid = syncInfo.fileId;
    var files;
    syncing = ND.appFind(SYNC_FILE).then(function (list) {
      files = list;
      if (!files.length) return [];
      return Promise.all(files.map(function (f) { return ND.appRead(f.id).catch(function (e) { if (e.code === 'notfound') return null; throw e; }); }));
    }).then(function (datas) {
      var R = { books: {}, deleted: {}, settings: null, settingsT: 0 };
      datas.forEach(function (d) { if (d) R = mergeStates(remoteState(d), R); });   // 萬一有多個進度檔（兩台裝置同時建立），全部合併
      lastRemote = R;
      var M = mergeStates(localState(), R);
      if (!sameState(M, localState())) applyMerged(M);
      var target = files.length ? files[0].id : null;
      fid = target;
      var text = JSON.stringify(syncPayload(localState()));
      if (!target) return ND.appCreate(SYNC_FILE, text).then(function (id) { fid = id; lastRemote = mergeStates(localState(), R); });
      if (!sameState(localState(), R) || files.length > 1) return ND.appUpdate(target, text).then(function () { lastRemote = clone(localState()); });
    }).then(function () {
      syncInfo.fileId = fid; syncInfo.at = Date.now(); saveSyncInfo();
      if (dirtySeq === seq0) { try { localStorage.removeItem(KEY_DIRTY); } catch (e) { /* ignore */ } } else schedulePush();
      setSync('ok');
    }).catch(function (e) {
      if (e.code === 'offline') setSync('offline');
      else if (e.code === 'auth') setSync('needauth');
      else setSync('error', e.message);
    }).then(function () {
      syncing = null;
      if (syncAgain) { syncAgain = false; return syncNow(); }
    });
    return syncing;
  }
  // 不觸發同步排程的位置存檔（同步前先把目前位置寫入）
  // 頁面關閉／切到背景：用 keepalive 送出最後狀態（不等待結果；下次開啟會再完整同步）
  function flushOnHide() {
    if (!cloudOn() || !sget(KEY_DIRTY) || !syncInfo.fileId || syncing) return;
    var st = lastRemote ? mergeStates(localState(), lastRemote) : localState();
    if (ND.appUpdateKeepalive(syncInfo.fileId, JSON.stringify(syncPayload(st)))) lastRemote = clone(st);
  }
  // 使用者操作時：權杖過期就靜默重新取得（prompt:''，會短暫閃一下 Google 視窗），然後同步
  function cloudWake(interactive) {
    if (!cloudOn()) return Promise.resolve();
    if (ND.hasToken()) { if (interactive) return syncNow(); return Promise.resolve(); }
    if (!interactive || !navigator.onLine) { setSync(navigator.onLine ? 'needauth' : 'offline'); return Promise.resolve(); }
    var p = ND.ensureToken(true).then(function () {
      var l = refreshDriveList(true);
      return Promise.all([syncNow(), l]);
    }, function (e) { setSync(e.code === 'offline' ? 'offline' : 'needauth', e.message); if (e.code !== 'closed') toast(e.message); });
    wakeP = p.then(function () { wakeP = null; });
    return wakeP;
  }
  function renderSync() {
    var t, tip = '', cls = syncStat.s;
    var dirty = !!sget(KEY_DIRTY);
    if (!cloudOn()) t = '';
    else if (syncStat.s === 'syncing') t = '同步中…';
    else if (syncStat.s === 'offline' || (!navigator.onLine && cloudOn())) { t = '離線，稍後同步'; cls = 'offline'; }
    else if (syncStat.s === 'needauth') { t = '需重新連線'; tip = '需要重新連線 Google 才能同步，按 ⟳'; }
    else if (syncStat.s === 'error') { t = '同步錯誤'; tip = '同步錯誤：' + syncStat.msg; }
    else if (syncInfo.at) { t = dirty ? '待同步' : '已同步 ' + fmtTime(syncInfo.at); tip = (dirty ? '有變更待同步 · 上次同步 ' : '上次同步 ') + fmtTime(syncInfo.at); if (dirty) cls = 'dirty'; }
    else { t = dirty ? '待同步' : '尚未同步'; if (dirty) cls = 'dirty'; }
    Array.prototype.forEach.call(document.querySelectorAll('.sync-status'), function (n) { n.textContent = t; n.dataset.s = cls; n.title = tip || t; });
  }
  function fmtTime(t) {
    var d = new Date(t), now = new Date();
    try {
      return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  function renderCloud() {
    var box = $('cloudBox');
    $('cloudDisabled').hidden = CLOUD;
    $('btnSignIn').disabled = !CLOUD;
    var on = cloudOn(), a = CLOUD ? ND.account() : {};
    $('btnSignIn').hidden = on || !CLOUD; $('btnSignOut').hidden = !on; $('cloudSync').hidden = !on; $('btnCloudMenu').hidden = !on;
    if (!on) closeCloudMenu();
    $('cloudAccount').textContent = !CLOUD ? '未啟用' : on ? (a.email ? a.email : '已登入') : '未登入';
    $('cloudAccount').title = $('cloudAccount').textContent;
    $('rowCloud').hidden = !on;
    $('footLocal').hidden = on; $('footCloud').hidden = !on;
    box.dataset.on = on ? '1' : '0';
    renderSync();
  }
  function closeCloudMenu() { $('cloudMenu').hidden = true; $('btnCloudMenu').setAttribute('aria-expanded', 'false'); }
  function signIn() {
    if (!CLOUD) return;
    if (!navigator.onLine) { toast('目前離線，無法登入 Google'); return; }
    cloudMsg('等待 Google 登入…');
    var p = ND.signIn().then(function () {
      cloudMsg(''); renderCloud(); toast('已登入 Google');
      return Promise.all([refreshDriveList(), syncNow()]);
    }, function (e) { cloudMsg(''); renderCloud(); toast(e.message); });
    wakeP = p.then(function () { wakeP = null; });
  }
  function signOut() {
    var drv = LIB.filter(function (m) { return m.source === 'drive'; });
    if (!confirm('確定要登出 Google 嗎？\n登出後不會再同步進度，這台裝置上的進度會保留。')) return;
    var wipe = drv.length && confirm('也要刪除這台裝置上從雲端下載的 ' + drv.length + ' 本書快取嗎？\n（按「取消」則保留，離線仍可閱讀）');
    flushOnHide();
    ND.signOut();
    driveList = null; driveById = {}; try { localStorage.removeItem(KEY_DLIST); localStorage.removeItem(KEY_DIRTY); } catch (e) { /* ignore */ }
    syncInfo = {}; saveSyncInfo(); lastRemote = null; setSync('idle');
    var p = Promise.resolve();
    if (wipe) drv.forEach(function (m) { p = p.then(function () { return dbDelete(m.id); }); });
    p.then(loadLibrary).then(function () { route(); renderShelf(); toast('已登出 Google'); });
  }
  function uncacheBook(id) {
    var b = findLocal(id); if (!b) return;
    if (!confirm('要刪除「' + b.title + '」在這台裝置上的快取嗎？\n（閱讀進度保留，下次開啟會重新從雲端硬碟下載。）')) return;
    dbDelete(id).then(loadLibrary).then(function () { renderShelf(); toast('已清除快取'); }).catch(function () { toast('清除失敗'); });
  }
  function saveFolder(v) {
    var id = v ? ND.parseFolderId(v) : '';
    if (v && !id) { toast('看不懂這個資料夾網址或 ID'); return; }
    if (!id || id === CFG.DEFAULT_FOLDER_ID) { try { localStorage.removeItem(KEY_FOLDER); } catch (e) { /* ignore */ } } else sset(KEY_FOLDER, id);
    $('inpFolder').value = folderId();
    indexDrive(); renderShelf(); toast('已設定雲端書庫資料夾');
    if (cloudOn()) { if (ND.hasToken()) refreshDriveList(); else cloudWake(true); }
  }
  ND && ND.onChange && ND.onChange(function () { renderCloud(); });

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
      if (loadAbort) { loadAbort.abort(); loadAbort = null; }
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
    if (act === 'fold') toggleCard(li);
    else if (act === 'more') { var mp = li.querySelector('.book-more'); mp.hidden = !mp.hidden; b.setAttribute('aria-expanded', mp.hidden ? 'false' : 'true'); }
    else if (act === 'read') { cloudWake(true); location.hash = '#/read/' + id; }
    else if (act === 'uncache') uncacheBook(id);
    else if (act === 'delete') deleteBook(id);
    else if (act === 'rename') renameBook(id);
    else if (act === 'reset') {
      if (confirm('確定要清除「' + findBook(id).title + '」的閱讀進度與書籤嗎？')) { delete progress.books[id]; deleted[id] = Date.now(); saveDeleted(); touch(); renderShelf(); }
    }
  });
  $('btnCloudMenu').addEventListener('click', function (e) {
    e.stopPropagation(); var m = $('cloudMenu'); m.hidden = !m.hidden; this.setAttribute('aria-expanded', m.hidden ? 'false' : 'true');
  });
  $('cloudMenu').addEventListener('click', function () { setTimeout(closeCloudMenu, 0); });
  document.addEventListener('click', function (e) { if (!$('cloudMenu').hidden && !e.target.closest('#cloudMenu')) closeCloudMenu(); });
  $('btnFoldAll').addEventListener('click', function () { foldAll(this.dataset.mode !== 'expand'); });
  $('btnPickBooks').addEventListener('click', pickBooks);
  $('fileBooks').addEventListener('change', function (e) { importFiles(e.target.files); });
  $('btnBack').addEventListener('click', function () { saveNow(); cloudWake(true); location.hash = '#/'; });
  function wakeIfDirty() { if (cloudOn() && !ND.hasToken() && sget(KEY_DIRTY) && navigator.onLine) cloudWake(true); }
  $('btnToc').addEventListener('click', function () { openDrawer('toc'); });
  $('btnShelf2').addEventListener('click', function () { $('btnBack').click(); });
  $('btnBookmark').addEventListener('click', addBookmark);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnShelfSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', closeSettings);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('drawerMask').addEventListener('click', closeDrawer);
  $('btnPrev').addEventListener('click', function () { gotoChapter(state.ch - 1); wakeIfDirty(); });
  $('btnNext').addEventListener('click', function () { gotoChapter(state.ch + 1); wakeIfDirty(); });
  $('btnSignIn').addEventListener('click', signIn);
  $('btnSignOut').addEventListener('click', signOut);
  Array.prototype.forEach.call(document.querySelectorAll('.btn-sync'), function (b) {
    b.addEventListener('click', function () {
      if (!navigator.onLine) { setSync('offline'); toast('目前離線，連上網路後會自動同步'); return; }
      if (ND.hasToken()) { syncNow(); refreshDriveList(); } else cloudWake(true);
    });
  });
  $('btnRefreshList').addEventListener('click', function () { if (ND.hasToken()) refreshDriveList(); else cloudWake(true); });
  $('btnSaveFolder').addEventListener('click', function () { saveFolder($('inpFolder').value); });
  $('inpFolder').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveFolder($('inpFolder').value); });
  $('btnDefaultFolder').addEventListener('click', function () { saveFolder(''); });
  window.addEventListener('pagehide', flushOnHide);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flushOnHide(); return; }
    if (cloudOn() && ND.hasToken()) {
      syncNow();
      if (!driveList || Date.now() - (driveList.at || 0) > 600000) refreshDriveList(true);
    } else renderSync();
  });
  window.addEventListener('online', function () { if (cloudOn() && ND.hasToken()) { syncNow(); if (!driveList) refreshDriveList(true); } else renderSync(); });
  window.addEventListener('offline', function () { if (cloudOn()) setSync('offline'); });
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
    else {
      var gone = rec.bm.splice(i, 1)[0]; rec.bmDel = (rec.bmDel || []).concat([{ k: gone.ch + ':' + gone.para, t: Date.now() }]).slice(-200);
      rec.t = Date.now(); touch(); buildBookmarks();
    }
  });
  $('setFont').addEventListener('input', function (e) { changeSetting('fontSize', parseInt(e.target.value, 10)); });
  $('setLine').addEventListener('input', function (e) { changeSetting('lineHeight', parseFloat(e.target.value)); });
  $('fontMinus').addEventListener('click', function () { changeSetting('fontSize', Math.max(14, settings.fontSize - 1)); });
  $('fontPlus').addEventListener('click', function () { changeSetting('fontSize', Math.min(36, settings.fontSize + 1)); });
  [['segTheme', 'theme'], ['segFont', 'font'], ['segWidth', 'width'], ['segTap', 'tapZones'], ['segTypeset', 'typeset']].forEach(function (p) {
    $(p[0]).addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) changeSetting(p[1], b.dataset.v); });
  });
  $('btnResetSettings').addEventListener('click', function () { Object.assign(settings, DEFAULTS, EXTRA_DEFAULTS); saveSettings(true); applySettings(); });
  $('btnExport').addEventListener('click', exportProgress);
  $('btnExport2').addEventListener('click', exportProgress);
  $('btnImport').addEventListener('click', pickProgress);
  $('btnImport2').addEventListener('click', pickProgress);
  $('fileProgress').addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) importProgress(e.target.files[0]); });

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' && e.target.type !== 'range') { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') { closeDrawer(); closeSettings(); closeCloudMenu(); return; }
    if (state.view !== 'read' || !state.book) return;
    var modal = !$('drawer').hidden || !$('settingsPanel').hidden;
    if (e.key === 'ArrowLeft' && !modal) { e.preventDefault(); gotoChapter(state.ch - 1); }
    else if (e.key === 'ArrowRight' && !modal) { e.preventDefault(); gotoChapter(state.ch + 1); }
    else if ((e.key === 't' || e.key === 'T') && !modal) { openDrawer('toc'); }
  });

  /* ---------- PWA：Service Worker（僅 https 或 localhost） ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
    // 新版 SW 接手（舊版 SW 可能剛用舊快取回應了這次載入）→ 剛開啟就自動重新整理一次，否則提示
    var hadCtrl = !!navigator.serviceWorker.controller, swReloaded = false, t0 = Date.now();
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadCtrl || swReloaded) return; swReloaded = true;
      if (Date.now() - t0 < 15000) { try { saveNow(); } catch (e) {} location.reload(); }
      else toast('已更新到新版，重新開啟即可套用');
    });
  }

  /* ---------- 啟動 ---------- */
  applySettings();
  indexDrive();
  $('inpFolder').value = folderId();
  if (cloudOn()) {
    ND.preload();
    if (ND.hasToken() && navigator.onLine) { syncNow(); refreshDriveList(true); }
    else setSync(navigator.onLine ? 'needauth' : 'offline');
  }
  openDB().then(loadLibrary).catch(function () { LIB = []; }).then(function () {
    route();
    if (LIB.length) requestPersist().then(renderStorageInfo);
    window.__ready = true;
  });
})();
