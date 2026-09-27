// 圏外でもアプリを開けるようにするための Service Worker
// 画面のファイルを更新したら、CACHE の番号を1つ上げてください。
const CACHE = 'kunchi-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // API（POST）は素通し
  const url = new URL(req.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    // フォント：キャッシュ優先
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== location.origin || url.pathname.endsWith('/api')) return;

  // 画面ファイル：通信優先（4秒で諦めてキャッシュ）→ 更新がすぐ反映され、圏外でも開ける
  e.respondWith(
    (async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('index.html') : null);
        if (hit) return hit;
        throw err;
      }
    })()
  );
});
