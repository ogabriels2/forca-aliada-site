const CACHE_VERSION = 'fa-static-v3';
const STATIC_ASSETS = [
  './',
  'index.html',
  'community.html',
  'guia.html',
  'assets/images/app-icons/favicon-32.png',
  'assets/images/app-icons/icon-192.png',
  'assets/images/fa-icon-dark.png',
  'assets/images/og-image.jpg',
  'assets/js/fa-seo.js',
  'assets/js/fa-pwa.js',
  'assets/css/social-chat.css',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION)
    .then(cache => cache.addAll(STATIC_ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/share/')) return;

  if (request.destination === 'document') {
    event.respondWith(fetch(request).catch(() => caches.match(request).then(hit => hit || caches.match('index.html'))));
    return;
  }

  if (['image', 'style', 'script', 'font'].includes(request.destination)) {
    event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || 'community.html?notifications=1', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return existing.navigate(target);
    }
    return self.clients.openWindow(target);
  })());
});
