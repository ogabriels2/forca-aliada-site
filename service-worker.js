const CACHE_VERSION = 'fa-static-v51-home-repair';
const CANONICAL_ORIGIN = 'https://forcaaliada.com';
const OFFLINE_NOT_FOUND_URL = '/__fa-offline-not-found__';
const LEGACY_HOSTS = new Set(['forcaaliada.ogabriels.com', 'www.forcaaliada.ogabriels.com']);
const IS_LEGACY_ORIGIN = LEGACY_HOSTS.has(self.location.hostname);
const STATIC_ASSETS = [
  './',
  'community.html',
  'guia.html',
  'termos.html',
  'privacidade.html',
  'manifest.webmanifest',
  'staff-offline.html',
  'staff.webmanifest',
  'assets/images/app-icons/favicon-32.png',
  'assets/images/app-icons/icon-192.png',
  'assets/images/fa-icon-dark.png',
  'assets/images/fa-icon-light.png',
  'assets/images/og-image.jpg',
  'assets/images/hero.webp',
  'assets/images/sobre.webp',
  'assets/images/status-bg.webp',
  'assets/js/fa-seo.js',
  'assets/js/dashboard-v2.js?v=20260718c',
  'assets/js/dashboard-v2-lazy.js',
  'assets/js/dashboard-v3.js?v=20260716d',
  'assets/js/dashboard-v4.js?v=20260718b',
  'assets/js/dashboard-v5.js?v=20260718d',
  'assets/js/fa-pwa.js',
  'assets/js/fa-pwa.js?v=pwa6-20260722',
  'assets/js/fa-design-system.js',
  'assets/js/fa-design-system.js?v=design-20260722a',
  'assets/js/community-evolution.js',
  'assets/js/community-evolution-20260614f.js',
  'assets/js/community-evolution-20260614g.js',
  'assets/js/community-evolution-20260614h.js',
  'assets/js/community-evolution-20260615a.js',
  'assets/js/fa-design-system-20260615a.js',
  'assets/js/community-social-ui-20260614a.js',
  'assets/js/community-social-refinement-20260615a.js',
  'assets/js/social-chat.js?v=chat17-20260722',
  'assets/css/fa-design-system.css',
  'assets/css/fa-design-system.css?v=design-20260722a',
  'assets/css/home-manager.css?v=20260722a',
  'assets/css/dashboard-v2.css?v=20260718b',
  'assets/css/dashboard-v3.css?v=20260716d',
  'assets/css/dashboard-v4.css?v=20260719b',
  'assets/css/dashboard-v5.css?v=20260718c',
  'assets/css/community-evolution.css',
  'assets/css/community-evolution-20260614f.css',
  'assets/css/community-evolution-20260614h.css',
  'assets/css/community-evolution-20260614i.css',
  'assets/css/community-social-ui-20260614a.css',
  'assets/css/community-social-refinement-20260615a.css',
  'assets/css/social-chat.css',
];

self.addEventListener('install', event => {
  if (IS_LEGACY_ORIGIN) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(STATIC_ASSETS);
    try {
      const notFoundResponse = await fetch('/404', { cache: 'no-store' });
      await cache.put(OFFLINE_NOT_FOUND_URL, notFoundResponse);
    } catch { /* fallback sintético abaixo */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  if (IS_LEGACY_ORIGIN) {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      await Promise.all(windows.map(client => {
        const current = new URL(client.url);
        const target = new URL(current.pathname + current.search + current.hash, CANONICAL_ORIGIN);
        return client.navigate(target.href).catch(() => null);
      }));
      await self.registration.unregister();
    })());
    return;
  }
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (IS_LEGACY_ORIGIN && request.destination === 'document') {
    const target = new URL(url.pathname + url.search + url.hash, CANONICAL_ORIGIN);
    event.respondWith(Promise.resolve(Response.redirect(target.href, 301)));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/share/')) return;

  if (request.destination === 'document') {
    const isStaff = url.pathname.endsWith('/dashboard') || url.pathname.endsWith('/dashboard.html');
    const isCommunity = url.pathname === '/community'
      || url.pathname === '/community.html'
      || url.pathname === '/community/notifications'
      || /^\/community\/(?:post|profile)\/[^/]+$/.test(url.pathname);
    const isHome = url.pathname === '/' || url.pathname === '/index.html';
    const isGuide = url.pathname === '/guia' || url.pathname === '/guia.html';
    const isTerms = url.pathname === '/termos' || url.pathname === '/termos.html';
    const isPrivacy = url.pathname === '/privacidade' || url.pathname === '/privacidade.html';
    event.respondWith(fetch(request).catch(async () => {
      if (isStaff) return caches.match('staff-offline.html');
      const exact = await caches.match(request);
      if (exact) return exact;
      if (isCommunity) return caches.match('community.html');
      if (isGuide) return caches.match('guia.html');
      if (isTerms) return caches.match('termos.html');
      if (isPrivacy) return caches.match('privacidade.html');
      if (isHome) return caches.match('./');
      return (await caches.match(OFFLINE_NOT_FOUND_URL)) || new Response(
        '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Página não encontrada | Força Aliada</title><body><main><h1>Página não encontrada</h1><p>Este endereço não existe e você está offline.</p><a href="/">Voltar ao início</a></main></body></html>',
        { status: 404, headers: { 'Content-Type':'text/html; charset=utf-8' } },
      );
    }));
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
  const base = IS_LEGACY_ORIGIN ? CANONICAL_ORIGIN : self.registration.scope;
  const target = new URL(event.notification.data?.url || '/community/notifications', base).href;
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
