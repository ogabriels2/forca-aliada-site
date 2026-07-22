'use strict';

/**
 * Transferencia a sessao criada no host de contas para o dominio principal.
 *
 * O JWT nunca e colocado na URL. A navegacao final usa um POST tradicional
 * para /auth/handoff e o Worker valida o token novamente antes de permitir
 * que a pagina de destino grave a sessao no localStorage de forcaaliada.com.
 */
(function bootstrapAuthTransfer() {
  const APP_ORIGIN = 'https://forcaaliada.com';
  const AUTH_ORIGIN = 'https://accounts.ogabriels.com';
  const STATE_KEY = 'fa_auth_state';
  const PENDING_KEY = 'fa_auth_pending_handoff';
  const TOKEN_KEY = 'fa_token';
  const SESSION_KEY = 'fa_session';
  const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
  const STATE_TTL_MS = 10 * 60 * 1000;
  const AUTH_PATHS = new Set(['/login', '/login.html', '/signup', '/signup.html', '/recuperar', '/recuperar.html']);

  function safeStoreGet(store, key) {
    try { return store.getItem(key) || ''; } catch { return ''; }
  }

  function safeStoreSet(store, key, value) {
    try { store.setItem(key, value); } catch {}
  }

  function safeStoreRemove(store, key) {
    try { store.removeItem(key); } catch {}
  }

  function readStoredState(store) {
    const raw = safeStoreGet(store, STATE_KEY);
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      const state = String(parsed?.value || '');
      const age = Date.now() - Number(parsed?.at || 0);
      if (STATE_PATTERN.test(state) && age >= 0 && age <= STATE_TTL_MS) return state;
    } catch {}
    safeStoreRemove(store, STATE_KEY);
    return '';
  }

  function storeState(state) {
    const payload = JSON.stringify({ value: state, at: Date.now() });
    safeStoreSet(sessionStorage, STATE_KEY, payload);
    safeStoreSet(localStorage, STATE_KEY, payload);
  }

  function normalizeNext(raw, fallback = '/dashboard') {
    const safeFallback = String(fallback || '/dashboard').startsWith('/') ? String(fallback || '/dashboard') : '/dashboard';
    if (!raw) return safeFallback;
    try {
      const url = new URL(String(raw), APP_ORIGIN);
      if (url.origin !== APP_ORIGIN) return safeFallback;
      const path = url.pathname.replace(/\/{2,}/g, '/');
      if (!path || AUTH_PATHS.has(path.toLowerCase()) || path.startsWith('/auth/')) return safeFallback;
      ['oauth_token', 'ms_token', 'oauth_err', 'ms_err', 'oauth_link_token', 'oauth_email', 'oauth_provider', 'oauth_popup', 'oauth_flow', 'fa_state'].forEach(key => {
        url.searchParams.delete(key);
      });
      return `${path}${url.search}${url.hash}`;
    } catch {
      return safeFallback;
    }
  }

  function captureState() {
    const params = new URLSearchParams(window.location.search);
    const incoming = params.get('fa_state') || '';
    if (STATE_PATTERN.test(incoming)) {
      storeState(incoming);
      params.delete('fa_state');
      const cleanQuery = params.toString();
      history.replaceState({}, document.title, `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${location.hash}`);
      return incoming;
    }
    return readStoredState(sessionStorage) || readStoredState(localStorage);
  }

  function currentAuthPath() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('signup')) return '/signup';
    if (path.includes('recuperar')) return '/recuperar';
    return '/login';
  }

  function hasOAuthResult(params) {
    return ['oauth_token', 'ms_token', 'oauth_err', 'ms_err', 'oauth_link_token', 'oauth_onboard', 'ms_linked'].some(key => params.has(key));
  }

  function ensureFlow(options = {}) {
    if (window.location.origin !== AUTH_ORIGIN) return true;
    if (captureState()) return true;

    const params = new URLSearchParams(window.location.search);
    // Nao descarte um retorno OAuth que ja chegou ao navegador. Quando o
    // fluxo terminar, handoff() cria o estado e retoma a transferencia.
    if (hasOAuthResult(params)) return true;

    const authPath = AUTH_PATHS.has(String(options.authPath || '').toLowerCase())
      ? String(options.authPath)
      : currentAuthPath();
    const next = normalizeNext(
      options.next || params.get('next') || params.get('redirect') || params.get('returnTo'),
      options.fallback || '/dashboard'
    );
    const start = new URL('/auth/start', APP_ORIGIN);
    start.searchParams.set('auth_path', authPath);
    start.searchParams.set('next', next);
    window.location.replace(start.toString());
    return false;
  }

  function submitHandoff(token, user, next) {
    const state = captureState();
    const cleanToken = String(token || '').trim();
    const cleanNext = normalizeNext(next, user && user.role === 'limited' ? '/account' : '/dashboard');
    if (!cleanToken) return false;

    if (window.location.origin !== AUTH_ORIGIN) {
      window.location.href = cleanNext;
      return true;
    }

    if (!state) {
      safeStoreSet(localStorage, TOKEN_KEY, cleanToken);
      if (user) safeStoreSet(localStorage, SESSION_KEY, JSON.stringify(user));
      safeStoreSet(sessionStorage, PENDING_KEY, JSON.stringify({ next: cleanNext, at: Date.now() }));
      ensureFlow({ authPath: '/login', next: cleanNext, fallback: cleanNext });
      return true;
    }

    safeStoreRemove(sessionStorage, STATE_KEY);
    safeStoreRemove(localStorage, STATE_KEY);
    safeStoreRemove(sessionStorage, PENDING_KEY);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${APP_ORIGIN}/auth/handoff`;
    form.hidden = true;
    for (const [name, value] of Object.entries({ token: cleanToken, state, next: cleanNext })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    return true;
  }

  function resumePendingHandoff() {
    if (window.location.origin !== AUTH_ORIGIN || !captureState()) return;
    let pending = null;
    try { pending = JSON.parse(safeStoreGet(sessionStorage, PENDING_KEY) || 'null'); } catch {}
    if (!pending || Date.now() - Number(pending.at || 0) > 10 * 60 * 1000) {
      safeStoreRemove(sessionStorage, PENDING_KEY);
      return;
    }
    const token = safeStoreGet(localStorage, TOKEN_KEY);
    let user = null;
    try { user = JSON.parse(safeStoreGet(localStorage, SESSION_KEY) || 'null'); } catch {}
    if (token) submitHandoff(token, user, pending.next);
  }

  captureState();
  window.FAAuthTransfer = Object.freeze({
    APP_ORIGIN,
    AUTH_ORIGIN,
    normalizeNext,
    ensureFlow,
    handoff: submitHandoff,
    state: captureState,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resumePendingHandoff, { once: true });
  } else {
    resumePendingHandoff();
  }
})();
