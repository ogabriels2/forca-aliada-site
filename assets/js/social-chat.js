(function () {
  if (window.FAChat) return;

  const token = localStorage.getItem('fa_token');
  if (!token) return;

  const PROD = 'https://forca-aliada-site.onrender.com';
  const API_BASE = window.FA_API_BASE
    || localStorage.getItem('fa_api_base')
    || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:3000' : PROD);
  const bases = [...new Set([API_BASE, PROD].filter(Boolean))];

  const state = {
    open: false,
    tab: 'conversations',
    me: null,
    conversations: [],
    friends: [],
    requests: [],
    people: [],
    current: null,
    messages: [],
    unread: 0,
    search: '',
    busy: false,
    error: '',
  };

  const icons = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  };

  const root = document.createElement('div');
  root.id = 'fa-chat-root';
  document.body.appendChild(root);

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch]));

  const nameOf = person => person?.minecraft_name
    || person?.other_minecraft_name
    || person?.username
    || person?.other_username
    || 'Steve';

  const handleOf = person => person?.username || person?.other_username || nameOf(person);
  const skin = (name, size = 50) => `https://minotar.net/helm/${encodeURIComponent((name || 'Steve').trim() || 'Steve')}/${size}.png`;
  const rel = value => {
    if (!value) return '';
    const d = new Date(value);
    const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (diff < 45) return 'agora';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 172800) return 'ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  };

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let err;
    for (const base of bases) {
      try {
        const res = await fetch(`${base}${path}`, { ...options, headers });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  function render() {
    root.innerHTML = `
      <button class="fa-chat-launcher" type="button" data-chat-toggle aria-label="Mensagens" aria-expanded="${state.open ? 'true' : 'false'}">
        ${icons.chat}
        ${state.unread ? `<span class="fa-chat-badge">${state.unread > 99 ? '99+' : esc(state.unread)}</span>` : ''}
      </button>
      <section class="fa-chat-panel ${state.open ? 'is-open' : ''}" aria-label="Mensagens diretas">
        <div class="fa-chat-top">
          <div class="fa-chat-title">
            <span class="fa-chat-peer-av" style="display:grid;place-items:center">${icons.chat}</span>
            <div><strong>Mensagens</strong><span>${state.current ? 'Conversa direta' : 'Amigos e comunidade'}</span></div>
          </div>
          <button class="fa-chat-icon-btn" type="button" data-chat-close aria-label="Fechar">${icons.close}</button>
        </div>
        ${state.current ? renderThread() : renderInbox()}
      </section>`;
  }

  function renderInbox() {
    return `
      <div class="fa-chat-tabs" role="tablist">
        <button class="fa-chat-tab ${state.tab === 'conversations' ? 'is-active' : ''}" type="button" data-chat-tab="conversations">Conversas</button>
        <button class="fa-chat-tab ${state.tab === 'friends' ? 'is-active' : ''}" type="button" data-chat-tab="friends">Amigos</button>
      </div>
      <div class="fa-chat-body">
        <div class="fa-chat-search">
          <input type="search" data-chat-search placeholder="${state.tab === 'friends' ? 'Buscar pessoas' : 'Buscar conversa'}" value="${esc(state.search)}" autocomplete="off">
        </div>
        <div class="fa-chat-list">${state.tab === 'friends' ? renderFriends() : renderConversations()}</div>
      </div>`;
  }

  function renderConversations() {
    const term = state.search.trim().toLowerCase();
    const rows = state.conversations.filter(conv => {
      const name = nameOf(conv).toLowerCase();
      const handle = handleOf(conv).toLowerCase();
      return !term || name.includes(term) || handle.includes(term);
    });

    if (state.error) return `<div class="fa-chat-error"><strong>Chat indisponivel</strong>${esc(state.error)}</div>`;
    if (!rows.length) {
      return '<div class="fa-chat-empty"><strong>Nenhuma conversa ainda</strong>Abra um perfil e use Mensagem para comecar.</div>';
    }
    return rows.map(conv => {
      const name = nameOf(conv);
      const preview = conv.last_message_body || (conv.is_friend ? 'Amigos na comunidade' : 'Conversa aberta');
      return `
        <button class="fa-chat-row ${conv.unread_count ? 'is-unread' : ''}" type="button" data-chat-conv="${esc(conv.id)}">
          <img src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">
          <span class="fa-chat-row-meta"><strong>${esc(name)}</strong><small>${esc(preview)}</small></span>
          ${conv.unread_count ? `<span class="fa-chat-pill">${esc(conv.unread_count)}</span>` : `<small>${esc(rel(conv.last_message_at || conv.conversation_last_message_at))}</small>`}
        </button>`;
    }).join('');
  }

  function renderFriends() {
    const source = state.search.trim() ? state.people : state.friends;
    const requestRows = state.search.trim() ? [] : state.requests;
    const requestHtml = requestRows.length ? `
      <div class="fa-chat-empty" style="padding:10px 8px;text-align:left"><strong>Seguidores recentes</strong></div>
      ${requestRows.map(person => friendRow(person, true)).join('')}` : '';
    const listHtml = source.length
      ? source.map(person => friendRow(person, false)).join('')
      : '<div class="fa-chat-empty"><strong>Ninguem encontrado</strong>Tente buscar por usuario ou nome do Minecraft.</div>';
    return `${requestHtml}<div class="fa-chat-empty" style="padding:10px 8px;text-align:left"><strong>${state.search.trim() ? 'Resultados' : 'Amigos'}</strong></div>${listHtml}`;
  }

  function friendRow(person, canFollowBack) {
    const name = nameOf(person);
    const meta = person.bio || (person.is_online ? 'Online agora' : `${person.rank || 'Ferro'} - ${Number(person.followers_count || 0).toLocaleString('pt-BR')} seg.`);
    return `
      <button class="fa-chat-friend" type="button" data-chat-user="${esc(person.id)}" data-chat-name="${esc(name)}">
        <img src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">
        <span class="fa-chat-friend-meta"><strong>${esc(name)}</strong><small>${esc(meta)}</small></span>
        ${canFollowBack ? '<span class="fa-chat-pill" data-follow-back>+</span>' : (person.is_online ? '<span class="fa-chat-status"></span>' : '')}
      </button>`;
  }

  function renderThread() {
    const conv = state.current;
    const name = nameOf(conv);
    return `
      <div class="fa-chat-thread">
        <div class="fa-chat-peerbar">
          <button class="fa-chat-icon-btn" type="button" data-chat-back aria-label="Voltar">${icons.back}</button>
          <img class="fa-chat-peer-av" src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">
          <div><strong>${esc(name)}</strong><small>@${esc(handleOf(conv))}${conv.is_friend ? ' - amigo' : ''}</small></div>
          <button class="fa-chat-icon-btn" type="button" data-chat-profile="${esc(conv.other_id)}" aria-label="Abrir perfil">${icons.user}</button>
        </div>
        <div class="fa-chat-messages" data-chat-messages>
          ${state.messages.length ? state.messages.map(message => renderMessage(message)).join('') : '<div class="fa-chat-empty"><strong>Comece a conversa</strong>Mensagens diretas ficam aqui.</div>'}
        </div>
        <form class="fa-chat-compose" data-chat-form>
          <textarea data-chat-input maxlength="500" rows="1" placeholder="Digite uma mensagem" aria-label="Mensagem"></textarea>
          <button class="fa-chat-send" type="submit" aria-label="Enviar">${icons.send}</button>
        </form>
      </div>`;
  }

  function renderMessage(message) {
    const isMe = Number(message.sender_id) === Number(state.me?.id);
    return `
      <div class="fa-chat-bubble-row ${isMe ? 'is-me' : ''}">
        <div class="fa-chat-bubble">${esc(message.body)}<time>${esc(rel(message.created_at))}</time></div>
      </div>`;
  }

  function updateScroll() {
    requestAnimationFrame(() => {
      const list = root.querySelector('[data-chat-messages]');
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  async function ensureMe() {
    if (state.me) return state.me;
    state.me = await api('/api/me');
    return state.me;
  }

  async function loadUnread() {
    try {
      const data = await api('/api/me/messages/unread-count');
      state.unread = Number(data.count || 0);
      render();
    } catch {
      state.unread = 0;
    }
  }

  async function loadConversations() {
    state.error = '';
    try {
      const data = await api('/api/me/conversations?limit=30');
      state.conversations = Array.isArray(data.rows) ? data.rows : [];
      state.unread = state.conversations.reduce((sum, conv) => sum + Number(conv.unread_count || 0), 0);
    } catch (e) {
      state.error = e.message || 'Nao foi possivel carregar.';
    }
  }

  async function loadFriends() {
    try {
      const [friends, requests] = await Promise.all([
        api('/api/me/friends?limit=50'),
        api('/api/me/friend-requests?limit=20'),
      ]);
      state.friends = Array.isArray(friends.rows) ? friends.rows : [];
      state.requests = Array.isArray(requests.rows) ? requests.rows : (Array.isArray(requests) ? requests : []);
    } catch {
      state.friends = [];
      state.requests = [];
    }
  }

  async function searchPeople(term) {
    if (!term.trim()) {
      state.people = [];
      return;
    }
    try {
      const params = new URLSearchParams({ search: term.trim(), limit: '12' });
      const rows = await api(`/api/community/players?${params}`);
      state.people = Array.isArray(rows) ? rows : [];
    } catch {
      state.people = [];
    }
  }

  async function openPanel() {
    state.open = true;
    await ensureMe();
    render();
    await Promise.all([loadConversations(), loadFriends()]);
    render();
  }

  function closePanel() {
    state.open = false;
    render();
  }

  async function openConversation(conv) {
    state.current = conv;
    state.messages = [];
    render();
    try {
      const data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=50`);
      state.messages = Array.isArray(data.rows) ? data.rows : [];
      conv.unread_count = 0;
      await loadConversations();
      state.current = state.conversations.find(item => Number(item.id) === Number(conv.id)) || conv;
      render();
      updateScroll();
    } catch (e) {
      state.messages = [];
      state.error = e.message;
      render();
    }
  }

  async function openWithUser(user) {
    if (!user?.id) return;
    state.open = true;
    state.current = null;
    render();
    await ensureMe();
    const conv = await api('/api/me/conversations', {
      method: 'POST',
      body: JSON.stringify({ target_id: user.id }),
    });
    await loadConversations();
    await openConversation(conv);
  }

  async function sendMessage(textarea) {
    const body = textarea.value.trim();
    if (!body || !state.current || state.busy) return;
    state.busy = true;
    textarea.value = '';
    try {
      const msg = await api(`/api/me/conversations/${encodeURIComponent(state.current.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      state.messages.push({
        ...msg,
        username: state.me?.username,
        minecraft_name: state.me?.minecraft_name,
      });
      await loadConversations();
      render();
      updateScroll();
    } catch (e) {
      textarea.value = body;
      state.error = e.message;
      render();
    } finally {
      state.busy = false;
    }
  }

  async function followBack(userId) {
    await api(`/api/me/follows/${encodeURIComponent(userId)}`, { method: 'POST' });
    await loadFriends();
    await loadConversations();
    render();
  }

  let searchTimer = null;
  root.addEventListener('click', async event => {
    const toggle = event.target.closest('[data-chat-toggle]');
    const close = event.target.closest('[data-chat-close]');
    const tab = event.target.closest('[data-chat-tab]');
    const convBtn = event.target.closest('[data-chat-conv]');
    const userBtn = event.target.closest('[data-chat-user]');
    const back = event.target.closest('[data-chat-back]');
    const profile = event.target.closest('[data-chat-profile]');

    try {
      if (toggle) {
        state.open ? closePanel() : await openPanel();
      } else if (close) {
        closePanel();
      } else if (tab) {
        state.tab = tab.dataset.chatTab;
        state.search = '';
        render();
        if (state.tab === 'friends') await loadFriends();
        render();
      } else if (convBtn) {
        const conv = state.conversations.find(item => Number(item.id) === Number(convBtn.dataset.chatConv));
        if (conv) await openConversation(conv);
      } else if (userBtn) {
        const follow = event.target.closest('[data-follow-back]');
        if (follow) {
          event.stopPropagation();
          await followBack(userBtn.dataset.chatUser);
          return;
        }
        await openWithUser({ id: userBtn.dataset.chatUser, minecraft_name: userBtn.dataset.chatName });
      } else if (back) {
        state.current = null;
        state.messages = [];
        await loadConversations();
        render();
      } else if (profile) {
        location.href = `profile.html?id=id:${encodeURIComponent(profile.dataset.chatProfile)}`;
      }
    } catch (e) {
      state.error = e.message || 'Acao nao concluida.';
      render();
    }
  });

  root.addEventListener('input', event => {
    const input = event.target.closest('[data-chat-search]');
    if (!input) return;
    state.search = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (state.tab === 'friends') await searchPeople(state.search);
      render();
      const next = root.querySelector('[data-chat-search]');
      if (next) {
        next.focus();
        next.selectionStart = next.selectionEnd = next.value.length;
      }
    }, 180);
  });

  root.addEventListener('submit', event => {
    const form = event.target.closest('[data-chat-form]');
    if (!form) return;
    event.preventDefault();
    const textarea = form.querySelector('[data-chat-input]');
    sendMessage(textarea);
  });

  window.FAChat = {
    open: openPanel,
    close: closePanel,
    openWithUser,
    refresh: async () => {
      await Promise.all([loadUnread(), loadConversations(), loadFriends()]);
      render();
    },
  };

  render();
  loadUnread();
  setInterval(async () => {
    if (state.current) {
      const draft = root.querySelector('[data-chat-input]')?.value || '';
      if (draft.trim()) return;
      await openConversation(state.current);
    } else if (state.open) {
      await loadConversations();
      render();
    } else {
      await loadUnread();
    }
  }, 15000);
})();
