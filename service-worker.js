/* ============================================================
   Service Worker — caches app shell for offline use
   ============================================================ */

const CACHE_NAME = 'volunteer-app-v46';
const APP_SHELL = [
  './',
  './index.html',
  './admin.html',
  './checkin.html',
  './app.js',
  './chat-assistant.js',
  './ai-features.js',
  './ai-learn.js',
  './config.js',
  './manifest.json',
  './icon.svg',
  './cert-template.png',
  './gta-banner.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch(() => {/* ignore individual failures */})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Don't cache POSTs to the Apps Script endpoint
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        // Cache new GET responses opportunistically
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => {
          try { cache.put(event.request, resClone); } catch (e) {}
        });
        return res;
      }).catch(() => cached);
    })
  );
});
