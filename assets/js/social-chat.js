(function () {
  if (window.FAChat) return;

  const token = localStorage.getItem('fa_token');
  if (!token) return;

  const PROD = 'https://forca-aliada-site.onrender.com';
  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const LOCAL_API = 'http://localhost:3000';
  const STORED_API = IS_LOCAL ? localStorage.getItem('fa_api_base') : '';
  const API_BASE = window.FA_API_BASE || STORED_API || (IS_LOCAL ? LOCAL_API : PROD);
  const bases = [...new Set((IS_LOCAL ? [API_BASE, LOCAL_API, PROD] : [window.FA_API_BASE || PROD, PROD]).filter(Boolean))];

  const state = {
    open: false,
    tab: 'conversations',
    me: null,
    conversations: [],
    groups: [],
    friends: [],
    requests: [],
    people: [],
    current: null,
    currentKind: null,
    messages: [],
    unread: 0,
    search: '',
    groupCreating: false,
    groupName: '',
    groupMemberIds: [],
    busy: false,
    error: '',
    loadingConversations: false,
    loadingGroups: false,
    loadingFriends: false,
    loadingMessages: false,
    warmed: false,
  };

  const icons = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  };

  const root = document.createElement('div');
  root.id = 'fa-chat-root';
  document.body.appendChild(root);
  let fabObserver = null;

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
  const groupNameOf = group => group?.name || 'Grupo';
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
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const timeoutMs = options.timeoutMs || 25000;
    const fetchOptions = { ...options };
    delete fetchOptions.timeoutMs;
    let err;
    for (const base of bases) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, { ...fetchOptions, headers, signal: controller.signal });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      } catch (e) {
        err = e.name === 'AbortError' ? new Error('A API demorou para responder. Tente novamente em alguns segundos.') : e;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw err;
  }

  function render() {
    syncFabPosition();
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

  function updateLauncherBadge() {
    const launcher = root.querySelector('[data-chat-toggle]');
    if (!launcher) {
      render();
      return;
    }
    launcher.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    const currentBadge = launcher.querySelector('.fa-chat-badge');
    if (!state.unread) {
      currentBadge?.remove();
      return;
    }
    const text = state.unread > 99 ? '99+' : String(state.unread);
    if (currentBadge) {
      currentBadge.textContent = text;
    } else {
      launcher.insertAdjacentHTML('beforeend', `<span class="fa-chat-badge">${esc(text)}</span>`);
    }
  }

  function syncFabPosition() {
    const fab = document.querySelector('.fab-post');
    const mobileNav = document.querySelector('.mobile-bottom-nav');
    root.classList.toggle('fa-chat-has-mobile-nav', Boolean(mobileNav));
    if (!fab) {
      root.classList.remove('fa-chat-has-fab');
      return;
    }
    const rect = fab.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || getComputedStyle(fab).display === 'none') {
      root.classList.remove('fa-chat-has-fab');
      return;
    }
    root.classList.add('fa-chat-has-fab');
    const styles = getComputedStyle(fab);
    root.style.setProperty('--fa-chat-fab-right', `${Math.max(14, window.innerWidth - rect.right)}px`);
    root.style.setProperty('--fa-chat-fab-width', `${Math.ceil(rect.width)}px`);
    root.style.setProperty('--fa-chat-fab-bottom', styles.bottom || `${Math.max(14, window.innerHeight - rect.bottom)}px`);
  }

  function recalcUnread() {
    const directUnread = state.conversations.reduce((sum, conv) => sum + Number(conv.unread_count || 0), 0);
    const groupUnread = state.groups.reduce((sum, group) => sum + Number(group.unread_count || 0), 0);
    state.unread = directUnread + groupUnread;
  }

  function updateConversationList() {
    const list = root.querySelector('.fa-chat-list');
    if (!list || state.current) return;
    if (state.tab === 'conversations') list.innerHTML = renderConversations();
    if (state.tab === 'groups') list.innerHTML = renderGroups();
    if (state.tab === 'friends') list.innerHTML = renderFriends();
    updateLauncherBadge();
  }

  function updateMessagesList({ scroll = false } = {}) {
    const list = root.querySelector('[data-chat-messages]');
    if (!list || !state.current) return;
    list.innerHTML = renderMessagesContent();
    if (scroll) updateScroll();
  }

  function renderInbox() {
    return `
      <div class="fa-chat-tabs" role="tablist">
        <button class="fa-chat-tab ${state.tab === 'conversations' ? 'is-active' : ''}" type="button" data-chat-tab="conversations">Conversas</button>
        <button class="fa-chat-tab ${state.tab === 'groups' ? 'is-active' : ''}" type="button" data-chat-tab="groups">Grupos</button>
        <button class="fa-chat-tab ${state.tab === 'friends' ? 'is-active' : ''}" type="button" data-chat-tab="friends">Amigos</button>
      </div>
      <div class="fa-chat-body">
        <div class="fa-chat-search">
          <input type="search" data-chat-search placeholder="${state.tab === 'friends' ? 'Buscar pessoas' : state.tab === 'groups' ? 'Buscar grupos ou membros' : 'Buscar conversa'}" value="${esc(state.search)}" autocomplete="off">
        </div>
        <div class="fa-chat-list">${state.tab === 'friends' ? renderFriends() : state.tab === 'groups' ? renderGroups() : renderConversations()}</div>
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
    if (state.loadingConversations && !rows.length) return loadingRows();
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
    if (state.loadingFriends && !source.length && !requestRows.length) return loadingRows();
    const requestHtml = requestRows.length ? `
      <div class="fa-chat-empty" style="padding:10px 8px;text-align:left"><strong>Seguidores recentes</strong></div>
      ${requestRows.map(person => friendRow(person, true)).join('')}` : '';
    const listHtml = source.length
      ? source.map(person => friendRow(person, false)).join('')
      : '<div class="fa-chat-empty"><strong>Ninguem encontrado</strong>Tente buscar por usuario ou nome do Minecraft.</div>';
    return `${requestHtml}<div class="fa-chat-empty" style="padding:10px 8px;text-align:left"><strong>${state.search.trim() ? 'Resultados' : 'Amigos'}</strong></div>${listHtml}`;
  }

  function renderGroups() {
    if (state.groupCreating) return renderGroupCreator();
    const term = state.search.trim().toLowerCase();
    const rows = state.groups.filter(group => {
      const name = groupNameOf(group).toLowerCase();
      const preview = String(group.last_message_body || group.last_sender_name || '').toLowerCase();
      return !term || name.includes(term) || preview.includes(term);
    });
    const create = `
      <button class="fa-chat-new-group" type="button" data-chat-new-group>
        <span>${icons.plus}</span>
        <strong>Novo grupo</strong>
        <small>Converse com varios amigos em um so lugar</small>
      </button>`;
    if (state.loadingGroups && !rows.length) return `${create}${loadingRows()}`;
    if (!rows.length) {
      return `${create}<div class="fa-chat-empty"><strong>Nenhum grupo ainda</strong>Crie um grupo com amigos ou seguidores para conversar melhor.</div>`;
    }
    return create + rows.map(group => {
      const name = groupNameOf(group);
      const preview = group.last_message_body
        ? `${group.last_sender_name || 'Alguem'}: ${group.last_message_body}`
        : `${Number(group.member_count || 0)} membros`;
      return `
        <button class="fa-chat-row ${group.unread_count ? 'is-unread' : ''}" type="button" data-chat-group="${esc(group.id)}">
          <span class="fa-chat-group-av">${icons.group}</span>
          <span class="fa-chat-row-meta"><strong>${esc(name)}</strong><small>${esc(preview)}</small></span>
          ${group.unread_count ? `<span class="fa-chat-pill">${esc(group.unread_count)}</span>` : `<small>${esc(rel(group.last_message_at || group.group_last_message_at || group.created_at))}</small>`}
        </button>`;
    }).join('');
  }

  function renderGroupCreator() {
    const selected = new Set(state.groupMemberIds.map(String));
    const source = state.search.trim() ? state.people : state.friends;
    const rows = source.filter(person => !state.me || Number(person.id) !== Number(state.me.id));
    return `
      <form class="fa-chat-group-maker" data-chat-group-form>
        <div class="fa-chat-maker-head">
          <button class="fa-chat-icon-btn" type="button" data-chat-cancel-group aria-label="Voltar">${icons.back}</button>
          <div><strong>Novo grupo</strong><small>${selected.size ? `${selected.size} selecionado${selected.size > 1 ? 's' : ''}` : 'Escolha pelo menos uma pessoa'}</small></div>
        </div>
        <input class="fa-chat-group-name" data-chat-group-name maxlength="80" placeholder="Nome do grupo" value="${esc(state.groupName)}" autocomplete="off">
        <div class="fa-chat-selected">${selected.size ? state.groupMemberIds.map(id => {
          const person = [...state.friends, ...state.people].find(item => String(item.id) === String(id));
          return `<span>${esc(nameOf(person || { username: `#${id}` }))}</span>`;
        }).join('') : '<small>Os grupos ajudam a reunir amigos, squads e times sem misturar conversas diretas.</small>'}</div>
        <div class="fa-chat-member-list">
          ${state.loadingFriends && !rows.length ? loadingRows() : rows.length ? rows.map(person => {
            const name = nameOf(person);
            const checked = selected.has(String(person.id));
            return `
              <button class="fa-chat-member ${checked ? 'is-selected' : ''}" type="button" data-chat-member-toggle="${esc(person.id)}">
                <img src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">
                <span><strong>${esc(name)}</strong><small>@${esc(handleOf(person))}</small></span>
                <i>${checked ? '✓' : '+'}</i>
              </button>`;
          }).join('') : '<div class="fa-chat-empty"><strong>Ninguem encontrado</strong>Busque amigos ou perfis publicos.</div>'}
        </div>
        <button class="fa-chat-create" type="submit" ${state.busy || !state.groupName.trim() || !selected.size ? 'disabled' : ''}>Criar grupo</button>
      </form>`;
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

  function loadingRows() {
    return Array.from({ length: 5 }, () => '<div class="fa-chat-skel"><span></span><i></i><b></b></div>').join('');
  }

  function renderThread() {
    const conv = state.current;
    const isGroup = state.currentKind === 'group';
    const name = isGroup ? groupNameOf(conv) : nameOf(conv);
    return `
      <div class="fa-chat-thread">
        <div class="fa-chat-peerbar">
          <button class="fa-chat-icon-btn" type="button" data-chat-back aria-label="Voltar">${icons.back}</button>
          ${isGroup ? `<span class="fa-chat-peer-av fa-chat-group-av">${icons.group}</span>` : `<img class="fa-chat-peer-av" src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">`}
          <div><strong>${esc(name)}</strong><small>${isGroup ? `${Number(conv.member_count || 0)} membros` : `@${esc(handleOf(conv))}${conv.is_friend ? ' - amigo' : ''}`}</small></div>
          ${isGroup ? '<span></span>' : `<button class="fa-chat-icon-btn" type="button" data-chat-profile="${esc(conv.other_id)}" aria-label="Abrir perfil">${icons.user}</button>`}
        </div>
        <div class="fa-chat-messages" data-chat-messages>
          ${renderMessagesContent()}
        </div>
        <form class="fa-chat-compose" data-chat-form>
          <textarea data-chat-input maxlength="500" rows="1" placeholder="Digite uma mensagem" aria-label="Mensagem"></textarea>
          <button class="fa-chat-send" type="submit" aria-label="Enviar">${icons.send}</button>
        </form>
        <div data-chat-char-counter style="text-align:right;font-size:10px;padding:0 8px 4px;opacity:0;transition:opacity 0.15s;color:var(--fa-chat-muted,#888)"></div>
      </div>`;
  }

  function renderMessagesContent() {
    const error = state.error ? `<div class="fa-chat-inline-error"><strong>Falha no chat</strong>${esc(state.error)}</div>` : '';
    if (state.loadingMessages) return `<div class="fa-chat-message-loading">${loadingRows()}</div>`;
    if (state.messages.length) return error + state.messages.map(message => renderMessage(message)).join('');
    const preview = state.current?.last_message_body;
    if (preview) {
      return `${error}<div class="fa-chat-empty"><strong>Historico sincronizando</strong>A conversa existe, mas as mensagens ainda nao chegaram desta sessao. Tente atualizar em alguns segundos.</div>`;
    }
    return `${error}<div class="fa-chat-empty"><strong>Comece a conversa</strong>${state.currentKind === 'group' ? 'As mensagens do grupo ficam aqui.' : 'Mensagens diretas ficam aqui.'}</div>`;
  }

  function renderMessage(message) {
    const isMe = Number(message.sender_id) === Number(state.me?.id);
    const sender = message.minecraft_name || message.username || 'Steve';
    const status = message.client_status === 'pending' ? 'enviando' : message.client_status === 'failed' ? 'nao enviada' : rel(message.created_at);
    return `
      <div class="fa-chat-bubble-row ${isMe ? 'is-me' : ''} ${message.client_status ? `is-${esc(message.client_status)}` : ''}">
        <div class="fa-chat-bubble">${state.currentKind === 'group' && !isMe ? `<span class="fa-chat-bubble-name">${esc(sender)}</span>` : ''}${esc(message.body)}<time>${esc(status)}${message.client_error ? ` - ${esc(message.client_error)}` : ''}</time></div>
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
      if (state.open) updateLauncherBadge();
      else render();
    } catch {
      state.unread = 0;
    }
  }

  async function loadConversations() {
    state.error = '';
    try {
      const data = await api('/api/me/conversations?limit=30');
      state.conversations = Array.isArray(data.rows) ? data.rows : [];
      recalcUnread();
    } catch (e) {
      state.error = e.message || 'Nao foi possivel carregar.';
    }
  }

  async function loadGroups() {
    try {
      const data = await api('/api/me/group-conversations?limit=30');
      state.groups = Array.isArray(data.rows) ? data.rows : [];
      recalcUnread();
    } catch {
      state.groups = [];
      recalcUnread();
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
    state.error = '';
    // [4.5] Partial update: show panel without full DOM rebuild if already rendered
    const panel = root.querySelector('.fa-chat-panel');
    if (panel) {
      panel.classList.add('is-open');
      root.querySelector('[data-chat-toggle]')?.setAttribute('aria-expanded', 'true');
    }
    state.loadingConversations = !state.conversations.length;
    state.loadingGroups = !state.groups.length;
    state.loadingFriends = !state.friends.length;
    if (!panel) render();
    try {
      await ensureMe();
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
    } finally {
      state.loadingConversations = false;
      state.loadingGroups = false;
      state.loadingFriends = false;
      render();
    }
  }

  function closePanel() {
    state.open = false;
    // [4.5] Partial update: just hide panel without full DOM rebuild
    const panel = root.querySelector('.fa-chat-panel');
    if (panel) {
      panel.classList.remove('is-open');
      root.querySelector('[data-chat-toggle]')?.setAttribute('aria-expanded', 'false');
    } else {
      render();
    }
  }

  async function openConversation(conv) {
    state.current = conv;
    state.currentKind = 'direct';
    state.messages = [];
    state.loadingMessages = true;
    render();
    try {
      let data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=50`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && conv.last_message_id) {
        await wait(450);
        data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=50&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      state.messages = rows;
      state.loadingMessages = false;
      conv.unread_count = 0;
      await loadConversations();
      state.current = state.conversations.find(item => Number(item.id) === Number(conv.id)) || conv;
      render();
      updateScroll();
    } catch (e) {
      state.messages = [];
      state.loadingMessages = false;
      state.error = e.message;
      render();
    }
  }

  async function openGroupConversation(group) {
    state.current = group;
    state.currentKind = 'group';
    state.messages = [];
    state.loadingMessages = true;
    render();
    try {
      let data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=50`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && group.last_message_id) {
        await wait(450);
        data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=50&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      state.messages = rows;
      state.loadingMessages = false;
      group.unread_count = 0;
      await loadGroups();
      state.current = state.groups.find(item => Number(item.id) === Number(group.id)) || group;
      render();
      updateScroll();
    } catch (e) {
      state.messages = [];
      state.loadingMessages = false;
      state.error = e.message;
      render();
    }
  }

  async function refreshCurrentMessages() {
    if (!state.current || state.busy) return;
    const isGroup = state.currentKind === 'group';
    const data = await api(`/${isGroup ? 'api/me/group-conversations' : 'api/me/conversations'}/${encodeURIComponent(state.current.id)}/messages?limit=50`);
    const nextMessages = Array.isArray(data.rows) ? data.rows : [];
    const before = state.messages.map(item => item.id).join(',');
    const after = nextMessages.map(item => item.id).join(',');
    if (before !== after) {
      const wasNearBottom = (() => {
        const list = root.querySelector('[data-chat-messages]');
        return !list || (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
      })();
      state.messages = nextMessages;
      updateMessagesList({ scroll: wasNearBottom });
    }
    if (isGroup) {
      await loadGroups();
      state.current = state.groups.find(item => Number(item.id) === Number(state.current.id)) || state.current;
    } else {
      await loadConversations();
      state.current = state.conversations.find(item => Number(item.id) === Number(state.current.id)) || state.current;
    }
    updateLauncherBadge();
  }

  async function openWithUser(user) {
    if (!user?.id) return;
    state.open = true;
    state.current = null;
    state.currentKind = null;
    state.error = '';
    state.loadingConversations = true;
    render();
    try {
      await ensureMe();
      const conv = await api('/api/me/conversations', {
        method: 'POST',
        body: JSON.stringify({ target_id: user.id }),
      });
      await loadConversations();
      await openConversation(conv);
    } finally {
      state.loadingConversations = false;
    }
  }

  async function sendMessage(textarea) {
    const body = textarea.value.trim();
    if (!body || !state.current || state.busy) return;
    const isGroup = state.currentKind === 'group';
    const form = textarea.closest('[data-chat-form]');
    const sendButton = form?.querySelector('.fa-chat-send');
    const tempId = `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const savedBody = textarea.value; // [2.6] save for error recovery
    state.busy = true;
    state.error = '';
    textarea.value = '';
    textarea.disabled = true;
    if (sendButton) sendButton.disabled = true;
    state.messages.push({
      id: tempId,
      sender_id: state.me?.id,
      body,
      created_at: new Date().toISOString(),
      username: state.me?.username,
      minecraft_name: state.me?.minecraft_name,
      client_status: 'pending',
    });
    updateMessagesList({ scroll: true });
    try {
      const msg = await api(`/${isGroup ? 'api/me/group-conversations' : 'api/me/conversations'}/${encodeURIComponent(state.current.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
        timeoutMs: 30000,
      });
      const saved = {
        ...msg,
        username: state.me?.username,
        minecraft_name: state.me?.minecraft_name,
      };
      const idx = state.messages.findIndex(item => item.id === tempId);
      if (idx >= 0) state.messages[idx] = saved;
      else state.messages.push(saved);
      if (isGroup) await loadGroups();
      else await loadConversations();
      updateMessagesList({ scroll: true });
      updateLauncherBadge();
    } catch (e) {
      state.error = e.message || 'Mensagem nao enviada.';
      const failed = state.messages.find(item => item.id === tempId);
      if (failed) {
        failed.client_status = 'failed';
        failed.client_error = state.error;
      }
      textarea.value = savedBody; // [2.6] restore saved content
      updateMessagesList({ scroll: true });
    } finally {
      state.busy = false;
      textarea.disabled = false;
      if (sendButton) sendButton.disabled = false;
      textarea.focus();
    }
  }

  async function followBack(userId) {
    await api(`/api/me/follows/${encodeURIComponent(userId)}`, { method: 'POST' });
    await loadFriends();
    await loadConversations();
    render();
  }

  async function createGroup() {
    const name = state.groupName.trim();
    const memberIds = [...new Set(state.groupMemberIds.map(id => parseInt(id, 10)).filter(Boolean))];
    if (!name || !memberIds.length || state.busy) return;
    state.busy = true;
    updateConversationList();
    try {
      const group = await api('/api/me/group-conversations', {
        method: 'POST',
        body: JSON.stringify({ name, member_ids: memberIds }),
      });
      state.groupCreating = false;
      state.groupName = '';
      state.groupMemberIds = [];
      state.search = '';
      await loadGroups();
      await openGroupConversation(group);
    } catch (e) {
      state.error = e.message || 'Grupo nao criado.';
      render();
    } finally {
      state.busy = false;
    }
  }

  let searchTimer = null;
  root.addEventListener('click', async event => {
    const toggle = event.target.closest('[data-chat-toggle]');
    const close = event.target.closest('[data-chat-close]');
    const tab = event.target.closest('[data-chat-tab]');
    const convBtn = event.target.closest('[data-chat-conv]');
    const groupBtn = event.target.closest('[data-chat-group]');
    const userBtn = event.target.closest('[data-chat-user]');
    const back = event.target.closest('[data-chat-back]');
    const profile = event.target.closest('[data-chat-profile]');
    const newGroup = event.target.closest('[data-chat-new-group]');
    const cancelGroup = event.target.closest('[data-chat-cancel-group]');
    const memberToggle = event.target.closest('[data-chat-member-toggle]');

    try {
      if (toggle) {
        state.open ? closePanel() : await openPanel();
      } else if (close) {
        closePanel();
      } else if (tab) {
        state.tab = tab.dataset.chatTab;
        state.search = '';
        state.groupCreating = false;
        if (state.tab === 'friends') state.loadingFriends = !state.friends.length;
        if (state.tab === 'groups') state.loadingGroups = !state.groups.length;
        render();
        if (state.tab === 'friends') {
          await loadFriends();
          state.loadingFriends = false;
        }
        if (state.tab === 'groups') {
          await Promise.all([loadGroups(), loadFriends()]);
          state.loadingGroups = false;
        }
        render();
      } else if (convBtn) {
        const conv = state.conversations.find(item => Number(item.id) === Number(convBtn.dataset.chatConv));
        if (conv) await openConversation(conv);
      } else if (groupBtn) {
        const group = state.groups.find(item => Number(item.id) === Number(groupBtn.dataset.chatGroup));
        if (group) await openGroupConversation(group);
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
        state.currentKind = null;
        state.messages = [];
        if (state.tab === 'groups') await loadGroups();
        else await loadConversations();
        render();
      } else if (profile) {
        const target = `id:${profile.dataset.chatProfile}`;
        if (typeof window.navigateProfile === 'function') window.navigateProfile(target);
        else location.href = `profile.html?id=${encodeURIComponent(target)}`;
      } else if (newGroup) {
        state.groupCreating = true;
        state.search = '';
        state.loadingFriends = !state.friends.length;
        render();
        await loadFriends();
        state.loadingFriends = false;
        render();
      } else if (cancelGroup) {
        state.groupCreating = false;
        state.groupName = '';
        state.groupMemberIds = [];
        render();
      } else if (memberToggle) {
        const id = String(memberToggle.dataset.chatMemberToggle);
        state.groupMemberIds = state.groupMemberIds.includes(id)
          ? state.groupMemberIds.filter(item => item !== id)
          : [...state.groupMemberIds, id].slice(0, 19);
        updateConversationList();
      }
    } catch (e) {
      state.error = e.message || 'Acao nao concluida.';
      render();
    }
  });

  root.addEventListener('input', event => {
    const groupName = event.target.closest('[data-chat-group-name]');
    if (groupName) {
      state.groupName = groupName.value;
      const submit = root.querySelector('.fa-chat-create');
      if (submit) submit.disabled = state.busy || !state.groupName.trim() || !state.groupMemberIds.length;
      return;
    }
    // [3.2] Character counter for message compose
    const chatInput = event.target.closest('[data-chat-input]');
    if (chatInput) {
      const counter = root.querySelector('[data-chat-char-counter]');
      if (counter) {
        const remaining = 500 - chatInput.value.length;
        const show = chatInput.value.length > 440;
        counter.textContent = show ? `${remaining} restantes` : '';
        counter.style.opacity = show ? '1' : '0';
        counter.style.color = remaining < 20 ? 'var(--fa-chat-danger,#e55)' : 'var(--fa-chat-muted,#888)';
      }
      return;
    }
    const input = event.target.closest('[data-chat-search]');
    if (!input) return;
    state.search = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (state.tab === 'friends' || (state.tab === 'groups' && state.groupCreating)) await searchPeople(state.search);
      const list = root.querySelector('.fa-chat-list');
      if (list) {
        list.innerHTML = state.tab === 'friends' ? renderFriends() : state.tab === 'groups' ? renderGroups() : renderConversations();
        updateLauncherBadge();
      }
    }, 180);
  });

  root.addEventListener('submit', event => {
    const groupForm = event.target.closest('[data-chat-group-form]');
    if (groupForm) {
      event.preventDefault();
      createGroup();
      return;
    }
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
      await Promise.all([loadUnread(), loadConversations(), loadGroups(), loadFriends()]);
      render();
    },
  };

  async function warmChat() {
    if (state.warmed) return;
    state.warmed = true;
    try {
      await ensureMe();
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
      if (state.open && !state.current) render();
      else updateLauncherBadge();
    } catch {
      state.warmed = false;
    }
  }

  render();
  syncFabPosition();
  window.addEventListener('resize', syncFabPosition, { passive: true });
  if ('MutationObserver' in window) {
    fabObserver = new MutationObserver(syncFabPosition);
    fabObserver.observe(document.body, { childList: true, subtree: true });
  }
  loadUnread();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => warmChat(), { timeout: 4000 });
  } else {
    setTimeout(() => warmChat(), 1400);
  }
  let _chatPollFailures = 0;
  setInterval(async () => {
    // [3.11] Skip polling when tab is hidden and not in active conversation
    if (document.hidden && !state.current) return;
    // Exponential backoff: skip every other cycle after 2 consecutive failures
    if (_chatPollFailures >= 2 && _chatPollFailures % 2 !== 0) {
      _chatPollFailures++;
      return;
    }
    try {
      if (!state.open) {
        await loadUnread();
      } else if (state.current) {
        const draft = root.querySelector('[data-chat-input]')?.value || '';
        if (draft.trim()) return;
        await refreshCurrentMessages();
      } else if (state.open) {
        if (state.tab === 'groups') await loadGroups();
        else await loadConversations();
        updateConversationList();
      }
      _chatPollFailures = 0; // reset on success
    } catch (e) {
      _chatPollFailures++;
      state.error = e.message || 'Nao foi possivel atualizar o chat.';
    }
  }, 25000);
})();
