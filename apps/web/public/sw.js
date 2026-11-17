/**
 * Keeps the web app's own files in this browser, so it opens without the server (the pages
 * themselves are kept by the app, in IndexedDB). The page is fetched fresh when the server
 * answers, and comes from here when it doesn't; the hashed assets come from here once kept.
 * The API, files, published pages and the sync socket are never kept here.
 */
const CACHE = 'workspace-app-v1';

// The first visit loads before this exists: keep the page and the files it starts with now.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        fetch('/', { cache: 'no-cache' }).then(async (response) => {
          if (!response.ok) return;
          const html = await response.clone().text();
          await cache.put('/', response);
          const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          await cache.addAll(assets);
        }),
      )
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/')) return;

  if (request.mode === 'navigate') {
    // The app's page: the server's when it answers (kept for next time), else the kept one.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(() =>
          caches.match('/').then((kept) => kept ?? new Response('Offline', { status: 503 })),
        ),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Hashed names: a kept copy never goes stale.
    event.respondWith(
      caches.match(request).then(
        (kept) =>
          kept ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
