/* Service Worker：快取程式外殼（不含任何小說內容；書在 IndexedDB；不快取 Google 登入／雲端硬碟請求）。路徑皆為相對路徑，可放在 /repo-name/ 子路徑。
   更新程式後請把 VERSION 加 1，讓舊快取失效。 */
var VERSION = 'nrw-v5';
var SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/config.js', 'js/drive.js', 'js/splitter.js', 'js/worker.js', 'manifest.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Google 登入與雲端硬碟 API 一律直接走網路，不經過也不寫入快取（書的內容另存在 IndexedDB）
  if (/(^|\.)googleapis\.com$|(^|\.)google\.com$|(^|\.)googleusercontent\.com$/.test(url.hostname)) return;
  if (url.origin !== location.origin) return;
  // stale-while-revalidate：先用快取（離線可用），背景更新
  e.respondWith(caches.open(VERSION).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit || (req.mode === 'navigate' ? cache.match('index.html') : undefined); });
      return hit || net;
    });
  }));
});
