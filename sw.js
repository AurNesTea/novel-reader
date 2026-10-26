/* Service Worker：快取程式外殼（不含任何小說內容；書在 IndexedDB；不快取 Google 登入／雲端硬碟請求）。路徑皆為相對路徑，可放在 /repo-name/ 子路徑。
   更新程式後請把 VERSION 加 1，並把 index.html 裡 ?v= 一起改掉。
   策略：
   - 安裝時一律繞過瀏覽器 HTTP 快取（cache:'reload'）抓新檔，避免新版快取裡混進舊的 CSS／JS
     （GitHub Pages 回應 max-age=600，舊版 SW 用一般 fetch 會在 10 分鐘內拿到舊檔）。
   - 頁面、CSS、JS、manifest：網路優先（cache:'no-cache' 以 ETag 重新驗證），失敗或逾時才用快取 → 更新下次載入就生效，離線仍可用。
   - 圖示等其他靜態檔：快取優先。 */
var VERSION = 'nrw-v8';
var SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/config.js', 'js/drive.js', 'js/splitter.js', 'js/typeset.js', 'js/worker.js', 'manifest.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
var NET_TIMEOUT = 4000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
        if (!res.ok) throw new Error('install ' + u + ' ' + res.status);
        return c.put(u, res);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isShell(req, url) {
  return req.mode === 'navigate' || /\.(html|css|js|json|webmanifest)$/.test(url.pathname) || /\/$/.test(url.pathname);
}
// 快取鍵不含 ?v=…（查詢字串只用來繞過 HTTP 快取）
function keyOf(url) { return url.origin + url.pathname; }

function networkFirst(req, url) {
  return caches.open(VERSION).then(function (cache) {
    var key = req.mode === 'navigate' && !/\.html$/.test(url.pathname) ? new URL('index.html', self.registration.scope).href : keyOf(url);
    var net = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
      if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    });
    var timer;
    var fallback = new Promise(function (resolve) { timer = setTimeout(resolve, NET_TIMEOUT); }).then(function () { return cache.match(key); });
    return Promise.race([net.then(function (r) { clearTimeout(timer); return r; }), fallback.then(function (hit) { return hit || net; })])
      .catch(function () {
        return cache.match(key).then(function (hit) {
          return hit || (req.mode === 'navigate' ? cache.match(new URL('index.html', self.registration.scope).href) : undefined) || Response.error();
        });
      });
  });
}
function cacheFirst(req, url) {
  return caches.open(VERSION).then(function (cache) {
    return cache.match(keyOf(url)).then(function (hit) {
      return hit || fetch(req).then(function (res) { if (res && res.ok && res.type === 'basic') cache.put(keyOf(url), res.clone()); return res; });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Google 登入與雲端硬碟 API 一律直接走網路，不經過也不寫入快取（書的內容另存在 IndexedDB）
  if (/(^|\.)googleapis\.com$|(^|\.)google\.com$|(^|\.)googleusercontent\.com$/.test(url.hostname)) return;
  if (url.origin !== location.origin) return;
  e.respondWith(isShell(req, url) ? networkFirst(req, url) : cacheFirst(req, url));
});
