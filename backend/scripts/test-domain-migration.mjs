import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSource = fs.readFileSync(path.resolve(here, '../../_worker.js'), 'utf8');
const backendSource = fs.readFileSync(path.resolve(here, '../src/server.mjs'), 'utf8');
const accountSource = fs.readFileSync(path.resolve(here, '../../account.html'), 'utf8');
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const worker = workerModule.default;

const assetRequests = [];
const env = {
  ASSETS: {
    async fetch(request) {
      assetRequests.push(new URL(request.url).pathname);
      return new Response('asset', { status: 200 });
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
  assert.equal(legacy.headers.get('location'), 'https://forcaaliada.com/community?post=9');

  const legacyWww = await worker.fetch(new Request('https://www.forcaaliada.ogabriels.com/guia'), env);
  assert.equal(legacyWww.status, 301);
  assert.equal(legacyWww.headers.get('location'), 'https://forcaaliada.com/guia');

  const pages = await worker.fetch(new Request('https://forca-aliada-site.pages.dev/community'), env);
  assert.equal(pages.status, 301);
  assert.equal(pages.headers.get('location'), 'https://forcaaliada.com/community');

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

  const forgedOAuthResult = await worker.fetch(new Request('https://accounts.ogabriels.com/auth/oauth-result', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ oauth_token: token, oauth_provider: 'google' }),
  }), env);
  assert.equal(forgedOAuthResult.status, 403);

  const logout = await worker.fetch(new Request('https://forcaaliada.com/logout?next=%2Fguia'), env);
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), 'https://accounts.ogabriels.com/logout?next=%2Fguia');

  const mainApi = await worker.fetch(new Request('https://forcaaliada.com/api/app/sync'), env);
  assert.equal(mainApi.status, 200);
  assert.equal(upstreamRequests.at(-1).url, 'https://forca-aliada-site.onrender.com/api/app/sync');

  assert.doesNotMatch(backendSource, /[?&]oauth_(?:token|onboard)=/);
  assert.doesNotMatch(accountSource, /[?&]link_token=/);

  console.log('domain migration worker tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
