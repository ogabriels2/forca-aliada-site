const API_ORIGIN = 'https://forca-aliada-site.onrender.com';
const APP_ORIGIN = 'https://forcaaliada.com';
const AUTH_ORIGIN = 'https://accounts.ogabriels.com';
const APP_HOST = 'forcaaliada.com';
const WWW_HOST = 'www.forcaaliada.com';
const COMMUNITY_HOST = 'community.forcaaliada.com';
const AUTH_HOST = 'accounts.ogabriels.com';
const AUTH_ALIAS_HOST = 'account.ogabriels.com';
const PAGES_HOST = 'forca-aliada-site.pages.dev';
const PAGES_PREVIEW_SUFFIX = '.forca-aliada-site.pages.dev';
const LEGACY_HOSTS = new Set([
  'forcaaliada.ogabriels.com',
  'www.forcaaliada.ogabriels.com',
]);
const AUTH_STATE_COOKIE_PREFIX = '__Host-fa_auth_';
const AUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OAUTH_RESULT_ORIGINS = new Set([API_ORIGIN, APP_ORIGIN]);
const HSTS_HEADER = 'max-age=31536000';

const PRIVATE_PATH_PATTERNS = [
  /^\/(?:backend|data|scripts|node_modules|\.pages-dist)(?:\/|$)/i,
  /^\/(?!\.well-known(?:\/|$))(?:[^/]*\/)*\.[^/]+(?:\/|$)/i,
  /\.(?:md|mjs|cjs|map|lock|log|env)$/i,
  /^\/(?:package(?:-lock)?\.json|wrangler\.(?:jsonc|toml)|\.assetsignore|\.gitignore)$/i,
];

const DYNAMIC_PATHS = [
  /^\/healthz$/,
  /^\/api(?:\/|$)/,
  /^\/share\//,
  /^\/sitemap(?:-[a-z0-9-]+)?\.xml$/,
  /^\/sitemap-posts-page-\d+\.xml$/,
];

const AUTH_PATHS = new Map([
  ['/login', '/login.html'],
  ['/login.html', '/login.html'],
  ['/signup', '/signup.html'],
  ['/signup.html', '/signup.html'],
  ['/recuperar', '/recuperar.html'],
  ['/recuperar.html', '/recuperar.html'],
]);

function canonicalPathname(pathname) {
  let value = String(pathname || '/');

  // URL.pathname intentionally preserves escaped separators and some escaped
  // characters. Decode repeatedly so encoded/double-encoded private paths
  // cannot bypass route classification. Invalid or excessively nested
  // encodings are rejected instead of falling through to the SPA shell.
  for (let round = 0; round < 8; round += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return '';
    }
    if (decoded === value) break;
    value = decoded;
  }
  if (/%[0-9a-f]{2}/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return '';

  const segments = [];
  for (const segment of value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}` || '/';
}

function normalizedPathname(pathname) {
  return canonicalPathname(pathname).toLowerCase();
}

function authAssetFor(pathname) {
  return AUTH_PATHS.get(normalizedPathname(pathname)) || '';
}

function isDynamicPath(pathname) {
  return DYNAMIC_PATHS.some(pattern => pattern.test(pathname));
}

function isPrivatePath(pathname) {
  return PRIVATE_PATH_PATTERNS.some(pattern => pattern.test(String(pathname || '/')));
}

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Strict-Transport-Security': HSTS_HEADER,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

async function brandedNotFound(env, request, { preview = false } = {}) {
  const assetUrl = new URL('/404', request.url);
  const assetRequest = new Request(assetUrl, {
    method: 'GET',
    headers: request.headers,
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(assetResponse.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Language', 'pt-BR');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('Strict-Transport-Security', HSTS_HEADER);
  headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests");
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (preview) headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  return new Response(request.method === 'HEAD' ? null : assetResponse.body, {
    status: 404,
    headers,
  });
}

function randomBase64Url(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function safeNext(value, fallback = '/dashboard') {
  try {
    const url = new URL(String(value || fallback), APP_ORIGIN);
    if (url.origin !== APP_ORIGIN) return fallback;
    const path = url.pathname.replace(/\/{2,}/g, '/');
    if (!path || authAssetFor(path) || path.startsWith('/auth/') || path === '/logout') return fallback;
    return `${path}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function legacyAppRouteTarget(requestUrl, pathname) {
  const isCommunityRoot = /^\/community(?:\.html)?$/i.test(pathname);
  const legacyProfile = pathname.match(/^\/profile\/([^/]+)$/i);
  if (!isCommunityRoot && !legacyProfile) return null;

  const target = new URL('/community', APP_ORIGIN);
  target.search = requestUrl.search;

  if (legacyProfile) {
    target.pathname = `/community/profile/${encodeURIComponent(legacyProfile[1])}`;
    return target;
  }

  const post = target.searchParams.get('post');
  const profile = target.searchParams.get('profile');
  const notifications = target.searchParams.get('notifications');
  if (!post && !profile && notifications !== '1') return null;

  if (post) target.pathname = `/community/post/${encodeURIComponent(post)}`;
  else if (profile) target.pathname = `/community/profile/${encodeURIComponent(profile)}`;
  else target.pathname = '/community/notifications';

  target.searchParams.delete('post');
  target.searchParams.delete('profile');
  target.searchParams.delete('notifications');
  return target;
}

function isCommunityShellPath(pathname) {
  return /^\/community\/(?:post|profile)\/[^/]+$/.test(pathname)
    || pathname === '/community/notifications';
}

function communityShellRequest(request) {
  const assetUrl = new URL('/community', request.url);
  assetUrl.search = '';
  assetUrl.hash = '';
  return new Request(assetUrl, request);
}

function communityShortcutTarget(requestUrl, pathname) {
  const shortEntity = pathname.match(/^\/(post|profile)\/([^/]+)$/i);
  const canonicalEntity = pathname.match(/^\/community\/(post|profile)\/([^/]+)$/i);
  let targetPath;
  if (pathname === '/' || /^\/index\.html$/i.test(pathname)) {
    targetPath = '/community';
  } else if (/^\/community(?:\.html)?$/i.test(pathname)) {
    targetPath = '/community';
  } else if (shortEntity) {
    targetPath = `/community/${shortEntity[1].toLowerCase()}/${encodeURIComponent(shortEntity[2])}`;
  } else if (canonicalEntity) {
    targetPath = `/community/${canonicalEntity[1].toLowerCase()}/${encodeURIComponent(canonicalEntity[2])}`;
  } else if (/^\/community\//i.test(pathname)) {
    targetPath = pathname;
  } else {
    targetPath = `/community${pathname}`;
  }

  const target = new URL(targetPath, APP_ORIGIN);
  target.search = requestUrl.search;
  target.hash = requestUrl.hash;
  return legacyAppRouteTarget(target, targetPath) || target;
}

function authCookieName(state) {
  return `${AUTH_STATE_COOKIE_PREFIX}${String(state || '').slice(0, 16)}`;
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function redirectTo(url, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: url.toString(),
      'Cache-Control': status === 301 ? 'public, max-age=3600' : 'no-store',
      'Strict-Transport-Security': HSTS_HEADER,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function secureHtml(body, nonce, status = 200, extraHeaders = {}) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Força Aliada</title><style nonce="${nonce}">html{color-scheme:dark;background:#060c16;font:16px system-ui,sans-serif}body{min-height:100vh;display:grid;place-items:center;margin:0;color:#f4f4f5}.card{max-width:34rem;padding:2rem;text-align:center}.muted{color:#a1a1aa;font-size:.9rem}a{color:#d6b464}</style></head><body><main class="card">${body}</main></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Strict-Transport-Security': HSTS_HEADER,
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

function authError(message, status = 400) {
  const nonce = randomBase64Url(18);
  const safeMessage = String(message || 'Não foi possível concluir o acesso.').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  return secureHtml(`<h1>Acesso não concluído</h1><p>${safeMessage}</p><p class="muted"><a href="${APP_ORIGIN}/auth/start">Tentar novamente</a></p>`, nonce, status);
}

function authStart(requestUrl) {
  const requestedAuthPath = normalizedPathname(requestUrl.searchParams.get('auth_path') || '/login');
  const assetPath = AUTH_PATHS.get(requestedAuthPath) || '/login.html';
  const publicAuthPath = assetPath.replace(/\.html$/, '');
  const next = safeNext(requestUrl.searchParams.get('next'));
  const state = randomBase64Url(32);
  const target = new URL(publicAuthPath, AUTH_ORIGIN);
  target.searchParams.set('fa_state', state);
  target.searchParams.set('next', next);
  const nonce = randomBase64Url(18);
  const script = `<script nonce="${nonce}">try{sessionStorage.setItem('fa_auth_state',${scriptJson(state)});location.replace(${scriptJson(target.toString())})}catch(e){document.getElementById('status').textContent='Não foi possível iniciar o acesso. Recarregue a página.'}</script>`;
  return secureHtml(`<h1>Preparando seu acesso…</h1><p id="status" class="muted">Você será redirecionado com segurança.</p>${script}`, nonce, 200, {
    'Set-Cookie': `${authCookieName(state)}=${encodeURIComponent(state)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=None`,
  });
}

async function validateSessionToken(token) {
  let upstream;
  try {
    upstream = await fetch(`${API_ORIGIN}/api/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
    });
  } catch {
    return { ok: false, status: 503, error: 'O serviço de contas está temporariamente indisponível. Tente novamente.' };
  }
  if (!upstream.ok) return { ok: false, status: 403, error: 'A sessão expirou ou foi recusada. Entre novamente.' };
  try {
    return { ok: true, me: await upstream.json() };
  } catch {
    return { ok: false, status: 502, error: 'A resposta da conta foi inválida.' };
  }
}

function publicSession(me) {
  return {
    id: me.id,
    username: me.username,
    email: me.email,
    minecraftName: me.minecraft_name || null,
    role: me.role,
  };
}

async function authHandoff(request) {
  if (request.method !== 'POST') return authError('Método não permitido.', 405);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return authError('Formato de autenticação inválido.', 415);
  }

  const rawBody = await request.text();
  if (rawBody.length > 12_000) return authError('Solicitação de autenticação muito grande.', 413);
  const form = new URLSearchParams(rawBody);
  const token = String(form.get('token') || '').trim();
  const state = String(form.get('state') || '').trim();
  const next = safeNext(form.get('next'));
  const cookieName = authCookieName(state);
  const cookieState = cookieValue(request, cookieName);

  if (!AUTH_STATE_PATTERN.test(state)) return authError('Estado de autenticação ausente ou inválido.', 403);
  if (cookieState && cookieState !== state) return authError('Esta tentativa de acesso expirou. Inicie novamente.', 403);
  if (token.length > 4096 || !JWT_PATTERN.test(token)) return authError('Sessão de autenticação inválida.', 403);

  const validation = await validateSessionToken(token);
  if (!validation.ok) return authError(validation.error, validation.status);

  const session = publicSession(validation.me);
  const nonce = randomBase64Url(18);
  const script = `<script nonce="${nonce}">(function(){const expected=sessionStorage.getItem('fa_auth_state')||'';const received=${scriptJson(state)};if(!expected||expected!==received){document.getElementById('status').textContent='A verificação de segurança expirou. Inicie o acesso novamente.';document.getElementById('retry').hidden=false;return}sessionStorage.removeItem('fa_auth_state');localStorage.setItem('fa_token',${scriptJson(token)});localStorage.setItem('fa_session',JSON.stringify(${scriptJson(session)}));history.replaceState({},document.title,'/auth/complete');location.replace(${scriptJson(next)})})()</script>`;
  return secureHtml(`<h1>Acesso confirmado</h1><p id="status" class="muted">Abrindo a Força Aliada…</p><p id="retry" hidden><a href="${APP_ORIGIN}/auth/start">Iniciar novamente</a></p>${script}`, nonce, 200, {
    'Set-Cookie': `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`,
  });
}

async function authOAuthResult(request) {
  if (request.method !== 'POST') return authError('Método não permitido.', 405);
  const origin = request.headers.get('Origin') || '';
  if (!OAUTH_RESULT_ORIGINS.has(origin)) return authError('Origem do resultado OAuth não autorizada.', 403);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return authError('Formato do resultado OAuth inválido.', 415);
  }

  const rawBody = await request.text();
  if (rawBody.length > 20_000) return authError('Resultado OAuth muito grande.', 413);
  const form = new URLSearchParams(rawBody);
  const oauthToken = String(form.get('oauth_token') || '').trim();
  const onboardToken = String(form.get('oauth_onboard') || '').trim();
  const linkToken = String(form.get('oauth_link_token') || '').trim();
  const provider = String(form.get('oauth_provider') || '').trim().toLowerCase();
  const email = String(form.get('oauth_email') || '').trim();
  const popup = form.get('oauth_popup') === '1';
  const flow = String(form.get('oauth_flow') || '').trim();
  const target = form.get('oauth_target') === 'signup' || onboardToken ? 'signup' : 'login';
  const sessionToken = oauthToken || onboardToken;

  if (!sessionToken && !linkToken) return authError('Resultado OAuth vazio.', 400);
  if (sessionToken && (sessionToken.length > 4096 || !JWT_PATTERN.test(sessionToken))) {
    return authError('Sessão OAuth inválida.', 403);
  }
  if (linkToken && (linkToken.length > 8192 || !JWT_PATTERN.test(linkToken))) {
    return authError('Confirmação OAuth inválida.', 403);
  }
  if (provider && !/^[a-z0-9_-]{2,32}$/.test(provider)) return authError('Provedor OAuth inválido.', 400);
  if (email.length > 320 || flow.length > 80) return authError('Metadados OAuth inválidos.', 400);

  if (sessionToken) {
    const validation = await validateSessionToken(sessionToken);
    if (!validation.ok) return authError(validation.error, validation.status);
  }

  const result = {
    created_at: Date.now(),
    ...(oauthToken ? { oauth_token: oauthToken } : {}),
    ...(onboardToken ? { oauth_onboard: onboardToken } : {}),
    ...(linkToken ? { oauth_link_token: linkToken } : {}),
    ...(provider ? { oauth_provider: provider } : {}),
    ...(email ? { oauth_email: email } : {}),
    ...(popup ? { oauth_popup: '1' } : {}),
    ...(flow ? { oauth_flow: flow } : {}),
  };
  const destination = new URL(target === 'signup' ? '/signup' : '/login', AUTH_ORIGIN);
  destination.searchParams.set('oauth_result', '1');
  const nonce = randomBase64Url(18);
  const script = `<script nonce="${nonce}">try{sessionStorage.setItem('fa_oauth_result',JSON.stringify(${scriptJson(result)}));history.replaceState({},document.title,'/auth/oauth-result');location.replace(${scriptJson(destination.toString())})}catch(e){document.getElementById('status').textContent='Não foi possível concluir o acesso. Tente novamente.'}</script>`;
  return secureHtml(`<h1>Autenticação confirmada</h1><p id="status" class="muted">Finalizando com segurança…</p>${script}`, nonce, 200, {
    'Cross-Origin-Opener-Policy': 'unsafe-none',
  });
}

function authLogout(requestUrl) {
  const next = safeNext(requestUrl.searchParams.get('next'), '/');
  const nonce = randomBase64Url(18);
  const script = `<script nonce="${nonce}">(function(){let token='';try{token=localStorage.getItem('fa_token')||''}catch(e){}if(token){fetch(${scriptJson(`${APP_ORIGIN}/api/auth/logout`)},{method:'POST',headers:{Authorization:'Bearer '+token},keepalive:true}).catch(function(){})}for(const store of [localStorage,sessionStorage]){for(const key of ['fa_token','fa_session','fa_auth_state','fa_auth_pending_handoff','fa_oauth_result']){try{store.removeItem(key)}catch(e){}}}location.replace(${scriptJson(new URL(next, APP_ORIGIN).toString())})})()</script>`;
  return secureHtml(`<h1>Saindo da conta…</h1><p class="muted">Encerrando sua sessão em todos os domínios da Força Aliada.</p>${script}`, nonce, 200, {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${APP_ORIGIN}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    'Cross-Origin-Opener-Policy': 'unsafe-none',
  });
}

async function proxyToApi(request, requestUrl) {
  const upstream = new URL(requestUrl.pathname + requestUrl.search, API_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  headers.set('X-Forwarded-Host', requestUrl.host);
  headers.set('X-Forwarded-Proto', 'https');
  return fetch(upstream, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
}

async function serveAsset(env, request, { auth = false, preview = false } = {}) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  const contentType = (headers.get('Content-Type') || '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Strict-Transport-Security', HSTS_HEADER);

  if (auth) {
    headers.set('Cache-Control', 'private, no-store, max-age=0');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (isHtml) {
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
      headers.set('X-Frame-Options', 'SAMEORIGIN');
      headers.set('Content-Security-Policy', "frame-ancestors 'self'");
    }
    if (preview) headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = canonicalPathname(url.pathname);
    if (!path) return notFound();
    const routeUrl = new URL(url);
    routeUrl.pathname = path;
    const routedRequest = new Request(routeUrl, request);
    const authAsset = authAssetFor(path);

    if (host === COMMUNITY_HOST) {
      return redirectTo(communityShortcutTarget(routeUrl, path), 301);
    }

    if (host === WWW_HOST) {
      const canonical = legacyAppRouteTarget(routeUrl, path) || new URL(routeUrl);
      canonical.hostname = APP_HOST;
      return redirectTo(canonical, 301);
    }

    if (host === PAGES_HOST) {
      const canonical = legacyAppRouteTarget(routeUrl, path)
        || new URL(routeUrl.pathname + routeUrl.search + routeUrl.hash, APP_ORIGIN);
      return redirectTo(canonical, 301);
    }

    if (LEGACY_HOSTS.has(host)) {
      if (/^\/api\/app(?:\/|$)/.test(path)) return proxyToApi(routedRequest, routeUrl);
      if (authAsset) {
        const authUrl = new URL(authAsset.replace(/\.html$/, ''), AUTH_ORIGIN);
        authUrl.search = routeUrl.search;
        return redirectTo(authUrl, 302);
      }
      const canonical = legacyAppRouteTarget(routeUrl, path)
        || new URL(routeUrl.pathname + routeUrl.search + routeUrl.hash, APP_ORIGIN);
      return redirectTo(canonical, 301);
    }

    if (host === AUTH_ALIAS_HOST) {
      const canonical = new URL(routeUrl);
      canonical.hostname = AUTH_HOST;
      return redirectTo(canonical, 301);
    }

    if (host === AUTH_HOST) {
      if (path === '/logout') return authLogout(routeUrl);
      if (path === '/auth/oauth-result') return authOAuthResult(request);
      if (path === '/' || path === '/index.html') return redirectTo(new URL('/login', AUTH_ORIGIN), 302);
      if (authAsset) {
        if (!['GET', 'HEAD'].includes(request.method)) return authError('Método não permitido.', 405);
        const assetUrl = new URL(routeUrl);
        // Pages canonicalizes `/*.html` back to the extensionless URL. Fetch
        // the public path directly so auth hosts do not bounce to themselves.
        assetUrl.pathname = authAsset.replace(/\.html$/, '');
        return serveAsset(env, new Request(assetUrl, request), { auth: true });
      }
      const canonical = new URL(routeUrl.pathname + routeUrl.search + routeUrl.hash, APP_ORIGIN);
      return redirectTo(canonical, 301);
    }

    if (host === APP_HOST) {
      if (path === '/index.html') {
        const homeUrl = new URL('/', APP_ORIGIN);
        homeUrl.search = routeUrl.search;
        homeUrl.hash = routeUrl.hash;
        return redirectTo(homeUrl, 301);
      }
      if (path === '/logout') {
        const logoutUrl = new URL('/logout', AUTH_ORIGIN);
        logoutUrl.searchParams.set('next', safeNext(routeUrl.searchParams.get('next'), '/'));
        return redirectTo(logoutUrl, 302);
      }
      if (path === '/auth/start') return authStart(routeUrl);
      if (path === '/auth/handoff') return authHandoff(request);
      if (path === '/auth/complete') return redirectTo(new URL('/', APP_ORIGIN), 302);
      if (authAsset) {
        const start = new URL('/auth/start', APP_ORIGIN);
        start.searchParams.set('auth_path', authAsset.replace(/\.html$/, ''));
        const requestedNext = routeUrl.searchParams.get('next') || routeUrl.searchParams.get('redirect') || routeUrl.searchParams.get('returnTo');
        if (requestedNext) start.searchParams.set('next', safeNext(requestedNext));
        return authStart(start);
      }
      const legacyAppRoute = legacyAppRouteTarget(routeUrl, path);
      if (legacyAppRoute) return redirectTo(legacyAppRoute, 301);
      if (isPrivatePath(path)) return notFound();
      if (isDynamicPath(path)) return proxyToApi(routedRequest, routeUrl);
      if (path === '/404' || path === '/404.html') return brandedNotFound(env, routedRequest);
      if (!['GET', 'HEAD'].includes(request.method)) return notFound();
      const assetRequest = isCommunityShellPath(path) ? communityShellRequest(routedRequest) : routedRequest;
      const assetResponse = await serveAsset(env, assetRequest);
      return assetResponse.status === 404
        ? brandedNotFound(env, routedRequest)
        : assetResponse;
    }

    if (host.endsWith(PAGES_PREVIEW_SUFFIX)) {
      if (authAsset) {
        const start = new URL('/auth/start', APP_ORIGIN);
        start.searchParams.set('auth_path', authAsset.replace(/\.html$/, ''));
        return redirectTo(start, 302);
      }
      const legacyAppRoute = legacyAppRouteTarget(routeUrl, path);
      if (legacyAppRoute) return redirectTo(legacyAppRoute, 302);
      if (isPrivatePath(path)) return notFound();
      if (isDynamicPath(path)) return proxyToApi(routedRequest, routeUrl);
      if (path === '/404' || path === '/404.html') return brandedNotFound(env, routedRequest, { preview: true });
      if (!['GET', 'HEAD'].includes(request.method)) return notFound();
      const assetRequest = isCommunityShellPath(path) ? communityShellRequest(routedRequest) : routedRequest;
      const assetResponse = await serveAsset(env, assetRequest, { preview: true });
      return assetResponse.status === 404
        ? brandedNotFound(env, routedRequest, { preview: true })
        : assetResponse;
    }

    const canonical = new URL(routeUrl.pathname + routeUrl.search + routeUrl.hash, APP_ORIGIN);
    return redirectTo(canonical, 301);
  },
};
