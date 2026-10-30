// Service worker: zapamiętuje pliki aplikacji, nie dotyka zapytań do Lichess.
const VERSION = 'ps-v3';
const SHELL = [
  './', './index.html', './style.css', './app.js', './config.js', './notation.js', './ndjson.js',
  './lichess.js', './demo.js', './rooms.js', './chess.js', './manifest.webmanifest', './prywatnosc.html',
  './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Najpierw sieć (świeża wersja), w razie braku sieci – pamięć podręczna.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
