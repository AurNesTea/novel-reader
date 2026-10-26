/* Google 登入（Google Identity Services token client）＋ Google Drive REST v3。
   只在使用者登入時才動態載入 https://accounts.google.com/gsi/client（唯一的外部程式）。
   存取權杖只放在記憶體與 sessionStorage（關閉分頁就消失），約 1 小時到期，到期後在使用者操作時以 prompt:'' 靜默重新取得。 */
(function (root) {
  'use strict';
  var CFG = root.NOVEL_READER_CONFIG || {};
  var CLIENT_ID = String(CFG.GOOGLE_CLIENT_ID || '').trim();
  var SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.appdata'];
  var GIS_URL = 'https://accounts.google.com/gsi/client';
  var API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var KEY_TOK = 'novelReader.gtoken.v1';       // sessionStorage：{ t: access_token, exp: ms }
  var KEY_ACC = 'novelReader.google.v1';       // localStorage：{ signedIn, email, name }（不含權杖）

  function E(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

  var tok = null;
  try { tok = JSON.parse(ss(KEY_TOK) || 'null'); } catch (e) { tok = null; }
  var acc = null;
  try { acc = JSON.parse(ls(KEY_ACC) || 'null'); } catch (e) { acc = null; }
  if (!acc || typeof acc !== 'object') acc = { signedIn: false };
  var listeners = [];
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); }
  function saveAcc() { ls(KEY_ACC, JSON.stringify(acc)); }
  function hasToken() { return !!(tok && tok.t && tok.exp - 60000 > Date.now()); }
  function setToken(t, expiresIn) { tok = { t: t, exp: Date.now() + Math.max(60, (+expiresIn || 3600)) * 1000 }; ss(KEY_TOK, JSON.stringify(tok)); }
  function clearToken() { tok = null; ss(KEY_TOK, null); }

  /* ---- GIS 載入（按需） ---- */
  var gisP = null;
  function loadGis() {
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve();
    if (gisP) return gisP;
    gisP = new Promise(function (resolve, reject) {
      if (!navigator.onLine) return reject(E('offline', '目前離線，無法登入 Google'));
      var s = document.createElement('script'); s.src = GIS_URL; s.async = true; s.defer = true;
      var timer = setTimeout(function () { fail(E('offline', '載入 Google 登入元件逾時，請確認網路連線')); }, 20000);
      function fail(err) { clearTimeout(timer); s.remove(); gisP = null; reject(err); }
      s.onload = function () {
        clearTimeout(timer);
        if (root.google && root.google.accounts && root.google.accounts.oauth2) resolve();
        else fail(E('gis', 'Google 登入元件載入失敗'));
      };
      s.onerror = function () { fail(E('offline', '無法載入 Google 登入元件（可能離線或被擋）')); };
      document.head.appendChild(s);
    });
    return gisP;
  }

  /* ---- 權杖 ---- */
  var client = null, pending = null;   // pending: { resolve, reject, timer }
  function finish(err, val) {
    var p = pending; pending = null; if (!p) return;
    clearTimeout(p.timer); if (err) p.reject(err); else p.resolve(val);
  }
  function getClient() {
    if (client) return client;
    var o2 = root.google.accounts.oauth2;
    client = o2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
      callback: function (resp) {
        if (!resp || resp.error) {
          var c = resp && resp.error;
          return finish(c === 'access_denied' ? E('denied', '你沒有同意授權，無法使用雲端硬碟') :
                        (c === 'interaction_required' || c === 'login_required' || c === 'consent_required') ? E('auth', '需要重新登入 Google') :
                        E('auth', 'Google 登入失敗' + (c ? '（' + c + '）' : '')));
        }
        var all = o2.hasGrantedAllScopes ? o2.hasGrantedAllScopes.apply(o2, [resp].concat(SCOPES)) : true;
        if (!all) return finish(E('scope', '需要同時允許「查看雲端硬碟檔案」與「存取應用程式資料」兩項權限，請重新登入並全部勾選'));
        setToken(resp.access_token, resp.expires_in);
        finish(null, resp.access_token);
      },
      error_callback: function (err) {
        var t = err && err.type;
        finish(t === 'popup_failed_to_open' ? E('popup', '登入視窗被瀏覽器擋住了，請允許此網站的彈出式視窗後再試一次') :
               t === 'popup_closed' ? E('closed', '登入視窗已關閉，尚未完成登入') :
               E('auth', 'Google 登入失敗'));
      }
    });
    return client;
  }
  // interactive=true 只能在使用者點擊等操作中呼叫（瀏覽器才允許彈出視窗）
  var inflight = null;
  function ensureToken(interactive) {
    if (!CLIENT_ID) return Promise.reject(E('notconfigured', '尚未設定 Google 用戶端 ID'));
    if (hasToken()) return Promise.resolve(tok.t);
    if (inflight) return inflight;
    if (!interactive) return Promise.reject(E('auth', acc.signedIn ? '需要重新連線 Google' : '尚未登入 Google'));
    if (!navigator.onLine) return Promise.reject(E('offline', '目前離線，無法登入 Google'));
    var first = !acc.signedIn;
    inflight = loadGis().then(function () {
      return new Promise(function (resolve, reject) {
        if (pending) finish(E('auth', '已取消'));
        pending = { resolve: resolve, reject: reject, timer: setTimeout(function () { finish(E('closed', '登入逾時，請再試一次')); }, 180000) };
        var opt = first ? {} : { prompt: '' };
        if (acc.email) opt.login_hint = acc.email;
        try { getClient().requestAccessToken(opt); } catch (e) { finish(E('auth', 'Google 登入失敗：' + e.message)); }
      });
    }).then(function (t) {
      inflight = null;
      if (!acc.signedIn) { acc.signedIn = true; saveAcc(); }
      emit();
      return t;
    }, function (err) { inflight = null; emit(); throw err; });
    return inflight;
  }
  function signIn() {
    return ensureToken(true).then(function () {
      return api(API + '/about?fields=user(displayName,emailAddress)').then(function (r) { return r.json(); }).then(function (j) {
        var u = (j && j.user) || {};
        acc = { signedIn: true, email: u.emailAddress || acc.email || '', name: u.displayName || '' }; saveAcc(); emit();
        return acc;
      }, function () { return acc; });
    });
  }
  function signOut() {
    var t = tok && tok.t;
    clearToken(); acc = { signedIn: false }; saveAcc(); client = null;
    try { if (t && root.google && root.google.accounts && root.google.accounts.oauth2) root.google.accounts.oauth2.revoke(t, function () {}); } catch (e) { /* ignore */ }
    emit();
  }

  /* ---- REST ---- */
  function httpErr(status, body) {
    var m = '';
    try { var j = JSON.parse(body); m = (j.error && (j.error.message || j.error)) || ''; } catch (e) { m = ''; }
    if (status === 404) return E('notfound', '找不到檔案或資料夾（可能已刪除，或這個帳號沒有權限）');
    if (status === 403) return E('forbidden', '沒有權限或超過使用量限制' + (m ? '：' + m : ''));
    if (status === 429 || status >= 500) return E('server', 'Google 伺服器暫時無法回應（' + status + '），請稍後再試');
    return E('http', '雲端硬碟錯誤 ' + status + (m ? '：' + m : ''));
  }
  function api(url, opts) {
    opts = opts || {};
    if (!navigator.onLine) return Promise.reject(E('offline', '目前離線'));
    return ensureToken(false).then(function (t) {
      var h = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
      return fetch(url, Object.assign({}, opts, { headers: h })).catch(function (e) {
        if (e && e.name === 'AbortError') throw E('abort', '已取消');
        throw E('offline', '網路連線失敗');
      });
    }).then(function (res) {
      if (res.status === 401) { clearToken(); emit(); throw E('auth', '登入已過期，需要重新連線 Google'); }
      if (!res.ok) return res.text().then(function (b) { throw httpErr(res.status, b); }, function () { throw httpErr(res.status, ''); });
      return res;
    });
  }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

  // 資料夾網址或 ID → ID
  function parseFolderId(s) {
    s = String(s || '').trim(); if (!s) return '';
    var m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : '';
  }

  function listTxt(folderId) {
    var out = [];
    function page(token) {
      var u = API + '/files?q=' + encodeURIComponent(q(folderId) + ' in parents and trashed=false') +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,size,modifiedTime,md5Checksum,mimeType)') +
        '&pageSize=1000&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
      return api(u).then(function (r) { return r.json(); }).then(function (j) {
        (j.files || []).forEach(function (f) {
          if (f.mimeType === 'application/vnd.google-apps.folder') return;
          if (!/\.txt$/i.test(f.name || '')) return;
          out.push({ id: f.id, name: f.name, size: +f.size || 0, modifiedTime: f.modifiedTime || '', md5Checksum: f.md5Checksum || '' });
        });
        return j.nextPageToken ? page(j.nextPageToken) : out;
      });
    }
    return page('');
  }

  // 下載檔案內容（ArrayBuffer），onProg(已下載位元組, 總位元組)
  function download(fileId, size, onProg, signal) {
    return api(API + '/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', { signal: signal }).then(function (res) {
      var total = size || +res.headers.get('content-length') || 0;
      if (!res.body || !res.body.getReader) return res.arrayBuffer();
      var reader = res.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var buf = new Uint8Array(got), off = 0;
            chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
            return buf.buffer;
          }
          chunks.push(r.value); got += r.value.length; if (onProg) onProg(got, Math.max(total, got));
          return pump();
        });
      }
      return pump().catch(function (e) { if (e && e.code) throw e; if (e && e.name === 'AbortError') throw E('abort', '已取消'); throw E('offline', '下載中斷，請確認網路連線'); });
    });
  }

  /* ---- 應用程式資料夾（appDataFolder：雲端硬碟介面看不到） ---- */
  function appFind(name) {
    var u = API + '/files?spaces=appDataFolder&q=' + encodeURIComponent('name=' + q(name) + ' and trashed=false') +
      '&fields=' + encodeURIComponent('files(id,modifiedTime)') + '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=10';
    return api(u).then(function (r) { return r.json(); }).then(function (j) { return j.files || []; });
  }
  function appRead(fileId) {
    return api(API + '/files/' + encodeURIComponent(fileId) + '?alt=media', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { return null; }
    });
  }
  function appCreate(name, text) {
    var b = 'nrw' + Math.random().toString(36).slice(2);
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: name, parents: ['appDataFolder'], mimeType: 'application/json' }) +
      '\r\n--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
    return api(UPLOAD + '/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body })
      .then(function (r) { return r.json(); }).then(function (j) { return j.id; });
  }
  function appUpdate(fileId, text) {
    return api(UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: text })
      .then(function () { return fileId; });
  }
  // 關閉頁面時的最後一次上傳（不等待結果）
  function appUpdateKeepalive(fileId, text) {
    if (!hasToken() || !fileId || !navigator.onLine) return false;
    if (new Blob([text]).size > 60000) return false;   // keepalive 請求上限 64KB
    try {
      fetch(UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media&fields=id', {
        method: 'PATCH', keepalive: true, body: text,
        headers: { Authorization: 'Bearer ' + tok.t, 'Content-Type': 'application/json; charset=UTF-8' }
      }).catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  root.NovelDrive = {
    configured: !!CLIENT_ID,
    scopes: SCOPES.slice(),
    account: function () { return Object.assign({}, acc); },
    isSignedIn: function () { return !!acc.signedIn; },
    hasToken: hasToken,
    busy: function () { return !!inflight; },
    preload: function () { return CLIENT_ID ? loadGis().catch(function () {}) : Promise.resolve(); },
    ensureToken: ensureToken,
    signIn: signIn,
    signOut: signOut,
    onChange: function (f) { listeners.push(f); },
    parseFolderId: parseFolderId,
    listTxt: listTxt,
    download: download,
    appFind: appFind, appRead: appRead, appCreate: appCreate, appUpdate: appUpdate, appUpdateKeepalive: appUpdateKeepalive
  };
})(typeof self !== 'undefined' ? self : this);
