import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSource = fs.readFileSync(path.resolve(here, '../../_worker.js'), 'utf8');
const backendSource = fs.readFileSync(path.resolve(here, '../src/server.mjs'), 'utf8');
const accountSource = fs.readFileSync(path.resolve(here, '../../account.html'), 'utf8');
const loginSource = fs.readFileSync(path.resolve(here, '../../login.html'), 'utf8');
const notFoundSource = fs.readFileSync(path.resolve(here, '../../404.html'), 'utf8');
const indexSource = fs.readFileSync(path.resolve(here, '../../index.html'), 'utf8');
const manifestSource = fs.readFileSync(path.resolve(here, '../../manifest.webmanifest'), 'utf8');
const buildSource = fs.readFileSync(path.resolve(here, '../../scripts/build-pages.mjs'), 'utf8');
const communitySource = fs.readFileSync(path.resolve(here, '../../community.html'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.resolve(here, '../../service-worker.js'), 'utf8');
const communityManifestSource = fs.readFileSync(path.resolve(here, '../../community.webmanifest'), 'utf8');
const pwaSource = fs.readFileSync(path.resolve(here, '../../assets/js/fa-pwa.js'), 'utf8');
const socialChatSource = fs.readFileSync(path.resolve(here, '../../assets/js/social-chat.js'), 'utf8');
const commentThreadSource = fs.readFileSync(path.resolve(here, '../src/server_comment_thread_fix.mjs'), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const worker = workerModule.default;

const assetRequests = [];
const env = {
  ASSETS: {
    async fetch(request) {
      const assetPath = new URL(request.url).pathname;
      assetRequests.push(assetPath);
      if (assetPath.startsWith('/missing/') || assetPath === '/community/not-a-route') {
        return new Response('asset missing', { status: 404 });
      }
      if (assetPath === '/404') {
        return new Response('<!doctype html><main data-page="not-found">Rota fora do mapa</main>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(request.method === 'HEAD' ? null : 'asset', { status: 200 });
    },
  },
};

const originalFetch = globalThis.fetch;
const upstreamRequests = [];
globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  upstreamRequests.push({ url, init });
  if (url.endsWith('/api/me')) {
    return Response.json({ id: 7, username: 'tester', email: 'tester@example.com', minecraft_name: 'Tester', role: 'admin' });
  }
  return Response.json({ service: 'forca-aliada-manager-api', protocol: 2, ok: true });
};

try {
  const www = await worker.fetch(new Request('https://www.forcaaliada.com/guia?q=1'), env);
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('location'), 'https://forcaaliada.com/guia?q=1');

  const legacy = await worker.fetch(new Request('https://forcaaliada.ogabriels.com/community?post=9'), env);
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), 'https://forcaaliada.com/community/post/9');

  const legacyWww = await worker.fetch(new Request('https://www.forcaaliada.ogabriels.com/guia'), env);
  assert.equal(legacyWww.status, 301);
  assert.equal(legacyWww.headers.get('location'), 'https://forcaaliada.com/guia');

  const pages = await worker.fetch(new Request('https://forca-aliada-site.pages.dev/community'), env);
  assert.equal(pages.status, 301);
  assert.equal(pages.headers.get('location'), 'https://forcaaliada.com/community');

  const communityShortcut = await worker.fetch(new Request('https://community.forcaaliada.com/?utm_source=shortcut'), env);
  assert.equal(communityShortcut.status, 301);
  assert.equal(communityShortcut.headers.get('location'), 'https://forcaaliada.com/community?utm_source=shortcut');

  const communityPostShortcut = await worker.fetch(new Request('https://community.forcaaliada.com/post/42?comment=7'), env);
  assert.equal(communityPostShortcut.status, 301);
  assert.equal(communityPostShortcut.headers.get('location'), 'https://forcaaliada.com/community/post/42?comment=7');

  const communityProfileShortcut = await worker.fetch(new Request('https://community.forcaaliada.com/community/profile/id%3A7?source=shortcut'), env);
  assert.equal(communityProfileShortcut.status, 301);
  assert.equal(communityProfileShortcut.headers.get('location'), 'https://forcaaliada.com/community/profile/id%3A7?source=shortcut');

  for (const shortcutPath of ['/api/app/sync', '/service-worker.js', '/community.webmanifest']) {
    const shortcutResponse = await worker.fetch(new Request(`https://community.forcaaliada.com${shortcutPath}`), env);
    assert.equal(shortcutResponse.status, 301, `${shortcutPath} must never be served from the community shortcut`);
    assert.match(shortcutResponse.headers.get('location') || '', /^https:\/\/forcaaliada\.com\/community\//);
  }

  const authAlias = await worker.fetch(new Request('https://account.ogabriels.com/login?next=%2Faccount'), env);
  assert.equal(authAlias.status, 301);
  assert.equal(authAlias.headers.get('location'), 'https://accounts.ogabriels.com/login?next=%2Faccount');

  const legacyApi = await worker.fetch(new Request('https://forcaaliada.ogabriels.com/api/app/sync'), env);
  assert.equal(legacyApi.status, 200);
  assert.equal(upstreamRequests.at(-1).url, 'https://forca-aliada-site.onrender.com/api/app/sync');

  const authAsset = await worker.fetch(new Request('https://accounts.ogabriels.com/login?next=%2Fcommunity'), env);
  assert.equal(authAsset.status, 200);
  assert.equal(assetRequests.at(-1), '/login');
  assert.equal(authAsset.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(authAsset.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(authAsset.headers.get('x-frame-options'), 'DENY');

  const authAssetSlash = await worker.fetch(new Request('https://accounts.ogabriels.com/login/'), env);
  assert.equal(authAssetSlash.status, 200);
  assert.equal(assetRequests.at(-1), '/login');

  const authEscape = await worker.fetch(new Request('https://accounts.ogabriels.com/dashboard?v=access'), env);
  assert.equal(authEscape.status, 301);
  assert.equal(authEscape.headers.get('location'), 'https://forcaaliada.com/dashboard?v=access');

  const start = await worker.fetch(new Request('https://forcaaliada.com/auth/start?auth_path=/login&next=/community?post=4'), env);
  assert.equal(start.status, 200);
  assert.match(start.headers.get('cache-control') || '', /no-store/);
  assert.match(start.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const cookie = start.headers.get('set-cookie') || '';
  const cookieMatch = cookie.match(/(__Host-fa_auth_[A-Za-z0-9_-]+)=([^;]+)/);
  const cookieName = cookieMatch?.[1] || '';
  const state = decodeURIComponent(cookieMatch?.[2] || '');
  assert.match(state, /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(cookieName, /^__Host-fa_auth_[A-Za-z0-9_-]{16}$/);
  const startHtml = await start.text();
  assert.match(startHtml, /accounts\.ogabriels\.com/);
  assert.doesNotMatch(startHtml, /oauth_token=/);

  const invalid = await worker.fetch(new Request('https://forcaaliada.com/auth/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'a.b.c', state: 'invalid', next: '/community' }),
  }), env);
  assert.equal(invalid.status, 403);

  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjd9.signature_value';
  const handoff = await worker.fetch(new Request('https://forcaaliada.com/auth/handoff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `${cookieName}=${encodeURIComponent(state)}`,
    },
    body: new URLSearchParams({ token, state, next: 'https://forcaaliada.com/community?post=4' }),
  }), env);
  assert.equal(handoff.status, 200);
  assert.match(handoff.headers.get('cache-control') || '', /no-store/);
  assert.match(handoff.headers.get('content-security-policy') || '', /script-src 'nonce-/);
  assert.equal(handoff.headers.get('location'), null);
  const handoffHtml = await handoff.text();
  assert.match(handoffHtml, /localStorage\.setItem\('fa_token'/);
  assert.match(handoffHtml, /\/community\?post=4/);
  assert.doesNotMatch(handoffHtml, /location\.replace\([^)]*oauth_token/);

  const mismatch = await worker.fetch(new Request('https://forcaaliada.com/auth/handoff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `${cookieName}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    },
    body: new URLSearchParams({ token, state, next: '/dashboard' }),
  }), env);
  assert.equal(mismatch.status, 403);

  const secondStart = await worker.fetch(new Request('https://forcaaliada.com/auth/start?next=/account'), env);
  const secondCookie = secondStart.headers.get('set-cookie') || '';
  const secondMatch = secondCookie.match(/(__Host-fa_auth_[A-Za-z0-9_-]+)=([^;]+)/);
  assert.notEqual(secondMatch?.[1], cookieName, 'parallel auth flows must use independent cookies');

  const oauthResult = await worker.fetch(new Request('https://accounts.ogabriels.com/auth/oauth-result', {
    method: 'POST',
    headers: {
      Origin: 'https://forca-aliada-site.onrender.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ oauth_token: token, oauth_provider: 'google', oauth_target: 'login' }),
  }), env);
  assert.equal(oauthResult.status, 200);
  assert.equal(oauthResult.headers.get('cache-control'), 'private, no-store, max-age=0');
  const oauthHtml = await oauthResult.text();
  assert.match(oauthHtml, /sessionStorage\.setItem\('fa_oauth_result'/);
  assert.match(oauthHtml, /oauth_result=1/);
  assert.doesNotMatch(oauthHtml, /oauth_result=1[^<]*eyJ/);

  const apexOAuthResult = await worker.fetch(new Request('https://accounts.ogabriels.com/auth/oauth-result', {
    method: 'POST',
    headers: {
      Origin: 'https://forcaaliada.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ oauth_token: token, oauth_provider: 'discord' }),
  }), env);
  assert.equal(apexOAuthResult.status, 200);

  for (const origin of ['null', '', 'https://accounts.ogabriels.com', 'https://evil.example']) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin) headers.Origin = origin;
    const forgedOAuthResult = await worker.fetch(new Request('https://accounts.ogabriels.com/auth/oauth-result', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ oauth_token: token, oauth_provider: 'google' }),
    }), env);
    assert.equal(forgedOAuthResult.status, 403, `OAuth origin ${origin || '(absent)'} must be rejected`);
  }

  const logout = await worker.fetch(new Request('https://forcaaliada.com/logout?next=%2Fguia'), env);
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), 'https://accounts.ogabriels.com/logout?next=%2Fguia');

  const duplicateHome = await worker.fetch(new Request('https://forcaaliada.com/index.html?source=pwa'), env);
  assert.equal(duplicateHome.status, 301);
  assert.equal(duplicateHome.headers.get('location'), 'https://forcaaliada.com/?source=pwa');

  const mainApi = await worker.fetch(new Request('https://forcaaliada.com/api/app/sync'), env);
  assert.equal(mainApi.status, 200);
  assert.equal(upstreamRequests.at(-1).url, 'https://forca-aliada-site.onrender.com/api/app/sync');

  for (const privatePath of [
    '/README.md',
    '/README.md/',
    '/README%2Emd',
    '/backend/package.json',
    '/%62ackend/package.json',
    '/backend%2Fpackage.json',
    '/%2562ackend/package.json',
    '//backend/package.json',
    '/backend%5Cpackage.json',
    '/backend/src/server.mjs',
    '/data/player-history.json',
    '/scripts/monitor.mjs',
    '/.git/HEAD',
    '/%2Egit/HEAD',
    '/%252Egit/HEAD',
    '/wrangler.jsonc',
  ]) {
    const privateResponse = await worker.fetch(new Request(`https://forcaaliada.com${privatePath}`), env);
    assert.equal(privateResponse.status, 404, `${privatePath} must not be public`);
    assert.equal(privateResponse.headers.get('x-robots-tag'), 'noindex, nofollow');
  }

  const publicDiscovery = await worker.fetch(new Request('https://forcaaliada.com/.well-known/forca-aliada-manager.json'), env);
  assert.equal(publicDiscovery.status, 200);
  assert.equal(assetRequests.at(-1), '/.well-known/forca-aliada-manager.json');

  const encodedPublicDiscovery = await worker.fetch(new Request('https://forcaaliada.com/.well-known%2Fforca-aliada-manager.json'), env);
  assert.equal(encodedPublicDiscovery.status, 200);
  assert.equal(assetRequests.at(-1), '/.well-known/forca-aliada-manager.json');

  const encodedApi = await worker.fetch(new Request('https://forcaaliada.com/api%2Fapp%2Fsync'), env);
  assert.equal(encodedApi.status, 200);
  assert.equal(upstreamRequests.at(-1).url, 'https://forca-aliada-site.onrender.com/api/app/sync');

  const postDeepLink = await worker.fetch(new Request('https://forcaaliada.com/community/post/42?comment=7'), env);
  assert.equal(postDeepLink.status, 200);
  assert.equal(postDeepLink.headers.get('location'), null);
  assert.equal(assetRequests.at(-1), '/community');

  const profileDeepLink = await worker.fetch(new Request('https://forcaaliada.com/profile/id%3A7'), env);
  assert.equal(profileDeepLink.status, 301);
  assert.equal(profileDeepLink.headers.get('location'), 'https://forcaaliada.com/community/profile/id%3A7');

  const canonicalProfileDeepLink = await worker.fetch(new Request('https://forcaaliada.com/community/profile/id%3A7'), env);
  assert.equal(canonicalProfileDeepLink.status, 200);
  assert.equal(canonicalProfileDeepLink.headers.get('location'), null);
  assert.equal(assetRequests.at(-1), '/community');

  const notificationsDeepLink = await worker.fetch(new Request('https://forcaaliada.com/community/notifications'), env);
  assert.equal(notificationsDeepLink.status, 200);
  assert.equal(notificationsDeepLink.headers.get('location'), null);
  assert.equal(assetRequests.at(-1), '/community');

  const postHead = await worker.fetch(new Request('https://forcaaliada.com/community/post/42', { method: 'HEAD' }), env);
  assert.equal(postHead.status, 200);
  assert.equal(await postHead.text(), '');
  assert.equal(assetRequests.at(-1), '/community');

  const previewDeepLink = await worker.fetch(new Request('https://preview-123.forca-aliada-site.pages.dev/community/post/42'), env);
  assert.equal(previewDeepLink.status, 200);
  assert.equal(assetRequests.at(-1), '/community');
  assert.equal(previewDeepLink.headers.get('x-robots-tag'), 'noindex, nofollow');

  const legacyPostQuery = await worker.fetch(new Request('https://forcaaliada.com/community?post=42&comment=7'), env);
  assert.equal(legacyPostQuery.status, 301);
  assert.equal(legacyPostQuery.headers.get('location'), 'https://forcaaliada.com/community/post/42?comment=7');

  const legacyProfileQuery = await worker.fetch(new Request('https://forcaaliada.com/community.html?profile=id%3A7&source=legacy'), env);
  assert.equal(legacyProfileQuery.status, 301);
  assert.equal(legacyProfileQuery.headers.get('location'), 'https://forcaaliada.com/community/profile/id%3A7?source=legacy');

  const legacyNotificationsQuery = await worker.fetch(new Request('https://forcaaliada.com/community?notifications=1&source=push'), env);
  assert.equal(legacyNotificationsQuery.status, 301);
  assert.equal(legacyNotificationsQuery.headers.get('location'), 'https://forcaaliada.com/community/notifications?source=push');

  const unknownCommunityRoute = await worker.fetch(new Request('https://forcaaliada.com/community/not-a-route'), env);
  assert.equal(unknownCommunityRoute.status, 404);
  assert.match(await unknownCommunityRoute.text(), /data-page="not-found"/);

  for (const publicMissingPath of ['/missing/route', '/missing/nested/route', '/404', '/404.html']) {
    const missing = await worker.fetch(new Request(`https://forcaaliada.com${publicMissingPath}`), env);
    assert.equal(missing.status, 404, `${publicMissingPath} must be a real 404`);
    assert.match(missing.headers.get('content-type') || '', /^text\/html/);
    assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.match(missing.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.match(await missing.text(), /data-page="not-found"/);
  }

  const missingHead = await worker.fetch(new Request('https://forcaaliada.com/missing/head', { method: 'HEAD' }), env);
  assert.equal(missingHead.status, 404);
  assert.equal(await missingHead.text(), '');

  assert.match(loginSource, /id="view-loggedin" hidden/);
  assert.match(loginSource, /view-loggedin'\)\.hidden = name !== 'loggedin'/);
  assert.match(loginSource, /view-login'\)\.hidden\s+= name !== 'login'/);
  assert.doesNotMatch(loginSource, /#view-loggedin\s*\{[^}]*display:\s*none/);
  assert.match(backendSource, /'Referrer-Policy': 'strict-origin'/);
  assert.match(buildSource, /'404\.html'/);
  assert.match(notFoundSource, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(communitySource, /<base href="\/">/);
  assert.match(communitySource, /`\/community\/post\/\$\{encodeURIComponent\(routeParams\.post\)\}`/);
  assert.match(communitySource, /`\/community\/profile\/\$\{encodeURIComponent\(routeParams\.profile\)\}`/);
  assert.match(communitySource, /url\.pathname = '\/community\/notifications'/);
  assert.match(communitySource, /Router\.register\('\/community\/profile\/:id',renderProfileRoute\)/);
  assert.match(communitySource, /\/api\/public\/community\/posts\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(communitySource, /\/api\/public\/community\/player\/\$\{encodeURIComponent\(identifier\)\}\/full-profile/);
  assert.match(communitySource, /Promise\.resolve\(\{ comments: \[\], sort: 'oldest', has_more: false, next_cursor: null, guest_preview: true \}\)/);
  assert.match(communitySource, /if \(!token\) \{\s*const responseCount = Number\(post\?\.comments_count \|\| 0\)/);
  assert.match(communitySource, /Participe desta conversa/);
  assert.match(communitySource, /data-profile-guest>Entrar para interagir/);
  assert.doesNotMatch(communitySource, /if\(!token\)\{location\.href=`share\/post\/\$\{encodeURIComponent\(id\)\}`;return\}/);
  assert.match(communitySource, /new URL\(authPath, location\.origin\)/);
  assert.match(communitySource, /navigator\.serviceWorker\.register\('\/service-worker\.js',\{scope:'\/'\}\)/);
  assert.match(communitySource, /id="guest-notifications-title">Suas notificações vivem aqui/);
  assert.match(serviceWorkerSource, /fa-static-v51-home-repair/);
  assert.match(serviceWorkerSource, /OFFLINE_NOT_FOUND_URL/);
  assert.match(serviceWorkerSource, /if \(isHome\) return caches\.match\('\.\/'\)/);
  assert.match(communityManifestSource, /"start_url": "\/community\?source=pwa"/);
  assert.match(communityManifestSource, /"url": "\/community\/notifications"/);
  assert.match(pwaSource, /register\('\/service-worker\.js', \{ scope: '\/' \}\)/);
  assert.match(communitySource, /fa-pwa\.js\?v=pwa5-20260722/);
  assert.match(communitySource, /social-chat\.js\?v=chat17-20260722/);
  assert.match(serviceWorkerSource, /social-chat\.js\?v=chat17-20260722/);
  assert.match(indexSource, /fa-pwa\.js\?v=pwa6-20260722/);
  assert.match(indexSource, /data-gallery-index="2"/);
  assert.match(indexSource, /'galeria27\.webp'/);
  assert.match(indexSource, /window\.location\.assign\('\/logout\?next=%2F'\)/);
  assert.match(manifestSource, /"start_url": "\/\?source=pwa"/);
  assert.doesNotMatch(socialChatSource, /community\.html\?post=/);
  assert.match(commentThreadSource, /`\/community\/post\/\$\{encodeURIComponent\(postId\)\}\?comment=/);

  assert.doesNotMatch(backendSource, /[?&]oauth_(?:token|onboard)=/);
  assert.doesNotMatch(accountSource, /[?&]link_token=/);

  console.log('domain migration worker tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
