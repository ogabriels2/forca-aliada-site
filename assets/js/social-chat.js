(function () {
  if (window.FAChat) return;

  const safeStorage = (() => {
    try {
      return window.localStorage || window.__FA_STORAGE__ || null;
    } catch {
      return window.__FA_STORAGE__ || null;
    }
  })();
  const token = safeStorage?.getItem('fa_token') || '';
  if (!token) return;

  const PROD = 'https://forca-aliada-site.onrender.com';
  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const LOCAL_API = 'http://localhost:3000';
  const STORED_API = IS_LOCAL ? (safeStorage?.getItem('fa_api_base') || '') : '';
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
    // [FIX] Per-conversation message cache: key = "direct:id" or "group:id"
    _msgCache: {},
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
    pendingDraft: '',
  };

  // [FIX] Cache key helper
  function cacheKey() {
    if (!state.current) return null;
    return `${state.currentKind}:${state.current.id}`;
  }

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

  // [FIX] Stable render: only rebuild full DOM when switching major states.
  // When the panel is open and we're just updating sub-sections, use targeted DOM updates.
  // This eliminates the panel flicker caused by full innerHTML replacement every poll cycle.
  function currentViewKey() {
    return state.current ? `${state.currentKind}:${state.current.id}` : 'inbox';
  }

  function render() {
    syncFabPosition();
    syncBodyChatState();

    const isOpen = state.open;
    const hasCurrent = Boolean(state.current);

    // Launcher button: always update in-place if it exists
    let launcher = root.querySelector('.fa-chat-launcher');
    if (!launcher) {
      // First render — build everything from scratch
      root.innerHTML = buildFullHTML();
      attachComposeAutoResize();
      return;
    }

    // Update launcher badge in-place
    launcher.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    _updateBadgeInLauncher(launcher);

    // Panel visibility
    let panel = root.querySelector('.fa-chat-panel');
    if (!panel) {
      root.innerHTML = buildFullHTML();
      attachComposeAutoResize();
      return;
    }

    // Toggle open class without rebuilding
    panel.classList.toggle('is-open', isOpen);
    panel.classList.toggle('has-thread', hasCurrent);
    panel.classList.toggle('has-inbox', !hasCurrent);

    if (!isOpen) return;

    // Determine if we need to switch between inbox/thread views
    const viewKey = currentViewKey();
    if (panel.dataset.viewKey !== viewKey || !panel.querySelector('.fa-chat-app')) {
      panel.dataset.viewKey = viewKey;
      panel.innerHTML = renderChatApp();
      attachComposeAutoResize();
      if (hasCurrent) updateScroll();
      return;
    }

    updateSidebar();
    if (hasCurrent) {
      const msgList = panel.querySelector('[data-chat-messages]');
      if (msgList) msgList.innerHTML = renderMessagesContent();
    }
  }

  function buildFullHTML() {
    return `
      <button class="fa-chat-launcher" type="button" data-chat-toggle aria-label="Mensagens" aria-expanded="${state.open ? 'true' : 'false'}">
        ${icons.chat}
        ${state.unread ? `<span class="fa-chat-badge">${state.unread > 99 ? '99+' : esc(state.unread)}</span>` : ''}
      </button>
      <section class="fa-chat-panel ${state.open ? 'is-open' : ''} ${state.current ? 'has-thread' : 'has-inbox'}" data-view-key="${esc(currentViewKey())}" aria-label="Mensagens diretas">
        ${renderChatApp()}
      </section>`;
  }

  function renderChatApp() {
    return `
      <div class="fa-chat-app">
        <aside class="fa-chat-sidebar" aria-label="Conversas">
          ${renderSidebar()}
        </aside>
        <section class="fa-chat-stage" aria-label="${state.current ? 'Conversa aberta' : 'Nenhuma conversa selecionada'}">
          ${state.current ? renderThread() : renderThreadEmpty()}
        </section>
      </div>`;
  }

  function renderSidebar() {
    return `
        <div class="fa-chat-top">
          <div class="fa-chat-title">
            <span class="fa-chat-peer-av">${icons.chat}</span>
            <div><strong>Mensagens</strong><span>${state.conversations.length || state.groups.length ? 'Conversas e grupos' : 'Amigos e comunidade'}</span></div>
          </div>
          <button class="fa-chat-icon-btn" type="button" data-chat-close aria-label="Fechar">${icons.close}</button>
        </div>
        ${renderInbox()}`;
  }

  function updateSidebar() {
    const panel = root.querySelector('.fa-chat-panel');
    if (!panel) return;
    panel.classList.toggle('has-thread', Boolean(state.current));
    panel.classList.toggle('has-inbox', !state.current);
    const list = panel.querySelector('.fa-chat-list');
    if (list) {
      if (state.tab === 'conversations') list.innerHTML = renderConversations();
      else if (state.tab === 'groups') list.innerHTML = renderGroups();
      else if (state.tab === 'friends') list.innerHTML = renderFriends();
    }
    panel.querySelectorAll('[data-chat-tab]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.chatTab === state.tab);
    });
  }

  function renderThreadEmpty() {
    return `
      <div class="fa-chat-empty-stage">
        <span class="fa-chat-empty-icon">${icons.chat}</span>
        <strong>Escolha uma conversa</strong>
        <p>Abra um chat recente, busque alguem ou compartilhe uma postagem direto para uma pessoa.</p>
      </div>`;
  }

  function _updateBadgeInLauncher(launcher) {
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

  function updateLauncherBadge() {
    const launcher = root.querySelector('[data-chat-toggle]');
    if (!launcher) { render(); return; }
    launcher.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    _updateBadgeInLauncher(launcher);
  }

  function syncBodyChatState() {
    document.body.classList.toggle('fa-chat-open', Boolean(state.open));
    syncMobileNavState();
  }

  function syncFabPosition() {
    const fab = document.querySelector('.fab-post');
    const mobileNav = document.querySelector('.mobile-bottom-nav');
    const navVisible = Boolean(
      mobileNav
      && getComputedStyle(mobileNav).display !== 'none'
      && mobileNav.getBoundingClientRect().height > 0
    );
    root.classList.toggle('fa-chat-has-mobile-nav', navVisible);
    if (navVisible) {
      const navRect = mobileNav.getBoundingClientRect();
      const bottomGap = Math.max(0, window.innerHeight - navRect.bottom);
      root.style.setProperty('--fa-chat-mobile-nav-height', `${Math.ceil(navRect.height + bottomGap)}px`);
    } else {
      root.style.setProperty('--fa-chat-mobile-nav-height', '0px');
    }
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

  function syncMobileNavState() {
    const nav = document.querySelector('.mobile-bottom-nav');
    if (!nav) return;
    const buttons = Array.from(nav.querySelectorAll('.mbtn'));
    const chatButton = nav.querySelector('#mobile-chat-btn');
    if (!chatButton) return;
    if (state.open) {
      // Marca só o botão do chat como ativo; todos os outros ficam inativos
      buttons.forEach(btn => btn.classList.toggle('is-active', btn === chatButton));
    } else {
      // Chat fechado: remove is-active do botão do chat (a nav cuida dos outros)
      chatButton.classList.remove('is-active');
    }
  }

  function recalcUnread() {
    const directUnread = state.conversations.reduce((sum, conv) => sum + Number(conv.unread_count || 0), 0);
    const groupUnread = state.groups.reduce((sum, group) => sum + Number(group.unread_count || 0), 0);
    state.unread = directUnread + groupUnread;
  }

  function updateConversationList() {
    const panel = root.querySelector('.fa-chat-panel');
    const list = root.querySelector('.fa-chat-list');
    // Sync tab active classes
    if (panel) {
      panel.querySelectorAll('[data-chat-tab]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.chatTab === state.tab);
      });
    }
    if (!list || state.current) return;
    if (state.tab === 'conversations') list.innerHTML = renderConversations();
    if (state.tab === 'groups') list.innerHTML = renderGroups();
    if (state.tab === 'friends') list.innerHTML = renderFriends();
    updateLauncherBadge();
  }

  function updateMessagesList({ scroll = false } = {}) {
    const list = root.querySelector('[data-chat-messages]');
    if (!list || !state.current) return;
    state.messages = dedupeMessages(state.messages);

    // Update cache first
    const k = cacheKey();
    if (k) state._msgCache[k] = state.messages.slice();

    // If loading or no messages, full replace is fine (no existing nodes to preserve)
    if (state.loadingMessages || !state.messages.length) {
      list.innerHTML = renderMessagesContent();
      if (scroll) updateScroll();
      return;
    }

    // Show/update inline error banner without touching messages
    let errBanner = list.querySelector('.fa-chat-inline-error');
    if (state.error) {
      const errHTML = `<div class="fa-chat-inline-error"><strong>Erro ao carregar mensagens</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button></div>`;
      if (!errBanner) list.insertAdjacentHTML('afterbegin', errHTML);
      else errBanner.innerHTML = `<strong>Erro ao carregar mensagens</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button>`;
    } else {
      errBanner?.remove();
    }

    // Remove empty-state placeholder if messages now exist
    list.querySelector('.fa-chat-empty')?.remove();
    list.querySelector('.fa-chat-message-loading')?.remove();
    removeDuplicateMessageNodes(list);

    // --- Differential append: only insert truly new messages ---
    // Build a set of IDs already rendered (data-msg-id) and map tmp→real merges
    const renderedIds = new Set();
    const pendingNodes = new Map(); // tmpId → DOM node
    list.querySelectorAll('[data-msg-id]').forEach(node => {
      const id = node.dataset.msgId;
      renderedIds.add(id);
      if (id.startsWith('tmp-')) pendingNodes.set(id, node);
    });

    // Compute date-separator awareness
    let prevDateLabel = null;
    // Collect existing date labels
    list.querySelectorAll('[data-date-sep]').forEach(sep => {
      // mark existing separators by their label
    });

    const allMsgs = state.messages;
    for (let i = 0; i < allMsgs.length; i++) {
      const msg = allMsgs[i];
      const msgId = String(msg.id);
      const prevMsg = i > 0 ? allMsgs[i - 1] : null;
      const nextMsg = i < allMsgs.length - 1 ? allMsgs[i + 1] : null;

      // --- Date pill separator logic ---
      const msgDate = msg.created_at ? new Date(msg.created_at).toLocaleDateString('pt-BR') : null;
      if (msgDate && msgDate !== prevDateLabel) {
        prevDateLabel = msgDate;
        const sepId = `datesep-${msgDate.replace(/\//g, '-')}`;
        if (!list.querySelector(`[data-date-sep="${CSS.escape(sepId)}"]`)) {
          const label = formatDatePill(msg.created_at);
          const sepHTML = `<div class="fa-chat-date-sep" data-date-sep="${esc(sepId)}"><span>${esc(label)}</span></div>`;
          list.insertAdjacentHTML('beforeend', sepHTML);
        }
      }

      // Grouping context for this message
      const isMe = Number(msg.sender_id) === Number(state.me?.id);
      const sameSenderAsPrev = prevMsg && Number(prevMsg.sender_id) === Number(msg.sender_id) && sameMinute(prevMsg.created_at, msg.created_at);
      const sameSenderAsNext = nextMsg && Number(nextMsg.sender_id) === Number(msg.sender_id) && sameMinute(msg.created_at, nextMsg.created_at);
      const isGroupFirst = !sameSenderAsPrev;
      const isGroupLast = !sameSenderAsNext;
      const alreadyRendered = renderedIds.has(msgId);

      // --- Handle tmp→real merge ---
      if (!alreadyRendered && !msgId.startsWith('tmp-')) {
        // Check if a pending node exists for this real message (matched by body+sender, or explicit index match)
        // Find any pending tmp node that was optimistically sent by me with same body
        let mergedTmp = null;
        pendingNodes.forEach((node, tmpId) => {
          // If this real msg replaced a tmp (already swapped in state.messages at sendMessage), node is stale
          // We detect by checking if a tmp with same content still sits in DOM but not in state
          const sameBubble = (node.querySelector('.fa-chat-bubble')?.textContent || '').includes(String(msg.body || ''));
          const sameSide = node.classList.contains('is-me') === isMe;
          if (!mergedTmp && sameBubble && sameSide && !state.messages.some(m => m.id === tmpId)) {
            mergedTmp = { node, tmpId };
          }
        });
        if (mergedTmp) {
          // Upgrade the tmp node in-place to real message
          const newNode = buildMessageNode(msg, isMe, isGroupFirst, isGroupLast);
          mergedTmp.node.replaceWith(newNode);
          pendingNodes.delete(mergedTmp.tmpId);
          renderedIds.add(msgId);
          continue;
        }
      }

      if (renderedIds.has(msgId)) {
        // Already rendered — update status/grouping classes in-place
        const existingNode = list.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (existingNode) {
          // Update client_status class
          existingNode.classList.toggle('is-pending', msg.client_status === 'pending');
          existingNode.classList.toggle('is-failed', msg.client_status === 'failed');
          // Update grouping classes
          existingNode.classList.toggle('is-group-first', isGroupFirst);
          existingNode.classList.toggle('is-group-last', isGroupLast);
          existingNode.classList.toggle('is-grouped', !isGroupFirst);
          // Update avatar visibility (for group-first only)
          const av = existingNode.querySelector('.fa-chat-bubble-av');
          if (av) av.style.visibility = isGroupFirst ? 'visible' : 'hidden';
          // Update time text
          const timeEl = existingNode.querySelector('time');
          if (timeEl) {
            const status = msg.client_status === 'pending' ? 'enviando' : msg.client_status === 'failed' ? 'não enviada' : rel(msg.created_at);
            timeEl.textContent = status + (msg.client_error ? ` — ${msg.client_error}` : '');
          }
          // Update failed alert icon
          const alertIcon = existingNode.querySelector('.fa-chat-fail-alert');
          if (msg.client_status === 'failed' && !alertIcon) {
            existingNode.querySelector('.fa-chat-bubble-wrap')?.insertAdjacentHTML('afterbegin',
              `<button class="fa-chat-fail-alert" data-chat-retry="${esc(msgId)}" title="Tentar reenviar">⚠</button>`
            );
          } else if (msg.client_status !== 'failed') {
            alertIcon?.remove();
          }
        }
        continue;
      }

      // New message — append to list
      const newNode = buildMessageNode(msg, isMe, isGroupFirst, isGroupLast);
      newNode.classList.add('is-new');
      list.appendChild(newNode);
      renderedIds.add(msgId);

      // Trigger fade-in animation via rAF (class added one frame later)
      requestAnimationFrame(() => newNode.classList.remove('is-new'));
    }

    if (scroll) updateScroll();
  }

  function dedupeMessages(rows) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter(message => {
      const id = String(message?.id ?? '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function removeDuplicateMessageNodes(list) {
    const seen = new Set();
    list.querySelectorAll('[data-msg-id]').forEach(node => {
      const id = node.dataset.msgId;
      if (!id) return;
      if (seen.has(id)) node.remove();
      else seen.add(id);
    });
  }

  // Helper: are two ISO timestamps in the same minute?
  function sameMinute(a, b) {
    if (!a || !b) return false;
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate() &&
      da.getHours() === db.getHours() &&
      da.getMinutes() === db.getMinutes();
  }

  // Helper: build a message DOM node (real Element, not just string)
  function buildMessageNode(msg, isMe, isGroupFirst, isGroupLast) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMessage(msg, isGroupFirst, isGroupLast);
    return wrapper.firstElementChild;
  }

  // Helper: date pill label
  function formatDatePill(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.floor((today - msgDay) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
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

    if (state.error && !rows.length) return `<div class="fa-chat-error"><strong>Chat indisponivel</strong>${esc(state.error)}</div>`;
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
        <span class="fa-chat-av-wrap">
          <img src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'">
          ${person.is_online ? '<span class="fa-chat-online-dot"></span>' : ''}
        </span>
        <span class="fa-chat-friend-meta"><strong>${esc(name)}</strong><small>${esc(meta)}</small></span>
        ${canFollowBack ? '<span class="fa-chat-pill" data-follow-back>+</span>' : ''}
      </button>`;
  }

  function loadingRows() {
    return Array.from({ length: 5 }, () => '<div class="fa-chat-skel"><span></span><i></i><b></b></div>').join('');
  }

  function renderThread() {
    const conv = state.current;
    const isGroup = state.currentKind === 'group';
    const name = isGroup ? groupNameOf(conv) : nameOf(conv);
    const isOnline = !isGroup && conv.is_online;
    const onlineDot = isOnline ? '<span class="fa-chat-online-dot fa-chat-online-dot--peer"></span>' : '';
    return `
      <div class="fa-chat-thread">
        <div class="fa-chat-peerbar">
          <button class="fa-chat-icon-btn" type="button" data-chat-back aria-label="Voltar">${icons.back}</button>
          ${isGroup
            ? `<span class="fa-chat-peer-av fa-chat-group-av">${icons.group}</span>`
            : `<span class="fa-chat-av-wrap fa-chat-av-wrap--peer"><img class="fa-chat-peer-av" src="${skin(name, 50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'"/>${onlineDot}</span>`
          }
          <div><strong>${esc(name)}</strong><small>${isGroup ? `${Number(conv.member_count || 0)} membros` : `@${esc(handleOf(conv))}${isOnline ? ' · online' : conv.is_friend ? ' · amigo' : ''}`}</small></div>
          ${isGroup ? '' : `<button class="fa-chat-icon-btn" type="button" data-chat-profile="${esc(conv.other_id)}" aria-label="Abrir perfil">${icons.user}</button>`}
          <button class="fa-chat-icon-btn" type="button" data-chat-close aria-label="Fechar">${icons.close}</button>
        </div>
        <div class="fa-chat-messages" data-chat-messages>
          ${renderMessagesContent()}
        </div>
        <div class="fa-chat-compose-wrap">
          <div data-chat-char-counter></div>
          <form class="fa-chat-compose" data-chat-form>
            <div class="fa-chat-compose-pill">
              <textarea data-chat-input maxlength="500" rows="1" placeholder="Mensagem..." aria-label="Mensagem"></textarea>
              <button class="fa-chat-send" type="submit" aria-label="Enviar">${icons.send}</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  function renderMessagesContent() {
    const error = state.error ? `<div class="fa-chat-inline-error"><strong>Erro ao carregar mensagens</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button></div>` : '';
    if (state.loadingMessages) {
      return `<div class="fa-chat-message-loading"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Carregando...</span></div>`;
    }
    if (state.error && !state.messages.length) {
      return `${error}<div class="fa-chat-empty"><strong>Historico indisponivel</strong>Use Recarregar ou abra a conversa de novo em alguns segundos.</div>`;
    }
    if (!state.messages.length) {
      return `${error}<div class="fa-chat-empty"><strong>Comece a conversa</strong>${state.currentKind === 'group' ? 'As mensagens do grupo ficam aqui.' : 'Mensagens diretas ficam aqui.'}</div>`;
    }

    // Full render with grouping logic (used on initial load / thread switch)
    let html = error;
    let prevDateLabel = null;
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      const prevMsg = i > 0 ? state.messages[i - 1] : null;
      const nextMsg = i < state.messages.length - 1 ? state.messages[i + 1] : null;
      const isMe = Number(msg.sender_id) === Number(state.me?.id);
      const sameSenderAsPrev = prevMsg && Number(prevMsg.sender_id) === Number(msg.sender_id) && sameMinute(prevMsg.created_at, msg.created_at);
      const sameSenderAsNext = nextMsg && Number(nextMsg.sender_id) === Number(msg.sender_id) && sameMinute(msg.created_at, nextMsg.created_at);
      const isGroupFirst = !sameSenderAsPrev;
      const isGroupLast = !sameSenderAsNext;

      // Date separator
      const msgDate = msg.created_at ? new Date(msg.created_at).toLocaleDateString('pt-BR') : null;
      if (msgDate && msgDate !== prevDateLabel) {
        prevDateLabel = msgDate;
        const sepId = `datesep-${msgDate.replace(/\//g, '-')}`;
        const label = formatDatePill(msg.created_at);
        html += `<div class="fa-chat-date-sep" data-date-sep="${esc(sepId)}"><span>${esc(label)}</span></div>`;
      }

      html += renderMessage(msg, isGroupFirst, isGroupLast);
    }
    return html;
  }

  function renderMessage(message, isGroupFirst = true, isGroupLast = true) {
    const isMe = Number(message.sender_id) === Number(state.me?.id);
    const sender = message.minecraft_name || message.username || 'Steve';
    const status = message.client_status === 'pending' ? 'enviando' : message.client_status === 'failed' ? 'não enviada' : rel(message.created_at);
    const statusText = status + (message.client_error ? ` — ${esc(message.client_error)}` : '');
    const clientClass = message.client_status ? `is-${esc(message.client_status)}` : '';
    const groupClasses = [
      isGroupFirst ? 'is-group-first' : 'is-grouped',
      isGroupLast ? 'is-group-last' : '',
    ].filter(Boolean).join(' ');

    const failAlert = message.client_status === 'failed'
      ? `<button class="fa-chat-fail-alert" data-chat-retry="${esc(message.id)}" title="Tentar reenviar">⚠</button>`
      : '';

    // Avatar: only show on first of group, hidden otherwise (preserves layout)
    const showAvatar = !isMe;
    const avatarHTML = showAvatar
      ? `<img class="fa-chat-bubble-av" src="${skin(sender, 50)}" alt="${esc(sender)}" onerror="this.onerror=null;this.src='${skin('Steve', 50)}'" style="visibility:${isGroupFirst ? 'visible' : 'hidden'}">`
      : `<span class="fa-chat-bubble-av-spacer"></span>`;

    // Show name in group chats, only on first of a block
    const showName = state.currentKind === 'group' && !isMe && isGroupFirst;
    const nameHTML = showName ? `<span class="fa-chat-bubble-name">${esc(sender)}</span>` : '';

    return `
      <div class="fa-chat-bubble-row ${isMe ? 'is-me' : ''} ${clientClass} ${groupClasses}" data-msg-id="${esc(String(message.id))}">
        ${!isMe ? avatarHTML : ''}
        <div class="fa-chat-bubble-wrap">
          ${failAlert}
          <div class="fa-chat-bubble ${isGroupFirst ? 'has-tail' : ''}">${nameHTML}${esc(message.body)}<time>${statusText}</time></div>
        </div>
        ${isMe ? avatarHTML : ''}
      </div>`;
  }

  function updateScroll() {
    requestAnimationFrame(() => {
      const list = root.querySelector('[data-chat-messages]');
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  // [FIX] Auto-resize textarea height as user types
  function attachComposeAutoResize() {
    const textarea = root.querySelector('[data-chat-input]');
    if (!textarea) return;
    textarea.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 110) + 'px';
    });
  }

  function applyPendingDraft() {
    const draft = String(state.pendingDraft || '').trim();
    if (!draft) return;
    const textarea = root.querySelector('[data-chat-input]');
    if (!textarea) return;
    textarea.value = draft.slice(0, 500);
    state.pendingDraft = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
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
      updateLauncherBadge();
    } catch {
      state.unread = 0;
    }
  }

  async function loadConversations() {
    try {
      const data = await api('/api/me/conversations?limit=30');
      state.conversations = Array.isArray(data.rows) ? data.rows : [];
      recalcUnread();
    } catch (e) {
      // Só expõe o erro no inbox (sem conversa aberta).
      // Quando há uma thread aberta o erro de lista não deve poluir o chat.
      if (!state.current) {
        state.error = e.message || 'Nao foi possivel carregar.';
      }
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
    state.tab = 'conversations'; // sempre começa na aba Conversas ao abrir
    state.error = '';
    render();
    state.loadingConversations = !state.conversations.length;
    state.loadingGroups = !state.groups.length;
    state.loadingFriends = !state.friends.length;
    // Only show loading skeletons if lists are empty (first open)
    if (state.loadingConversations || state.loadingGroups || state.loadingFriends) {
      updateConversationList();
    }
    try {
      await ensureMe();
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
    } finally {
      state.loadingConversations = false;
      state.loadingGroups = false;
      state.loadingFriends = false;
      updateConversationList();
      updateLauncherBadge();
    }
  }

  function closePanel() {
    state.open = false;
    // Reset any keyboard-avoidance inline styles
    const panel = root.querySelector('.fa-chat-panel');
    if (panel) { panel.style.height = ''; panel.style.top = ''; }
    render();
  }

  async function openConversation(conv) {
    state.current = conv;
    state.currentKind = 'direct';

    // [FIX] Restore cached messages immediately (no blank flash while loading)
    const k = cacheKey();
    const cached = k ? (state._msgCache[k] || []) : [];
    state.messages = cached;
    state.loadingMessages = cached.length === 0; // only show spinner if truly no history
    state.error = '';

    render();
    if (cached.length) updateScroll();

    try {
      let data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=80`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && conv.last_message_id) {
        await wait(450);
        data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=80&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      state.messages = dedupeMessages(rows);
      state.loadingMessages = false;
      state.error = ''; // mensagens carregadas com sucesso — limpa qualquer erro anterior
      // Update cache
      if (k) state._msgCache[k] = state.messages.slice();

      conv.unread_count = 0;
      // loadConversations pode falhar sem afetar o chat aberto
      try {
        await loadConversations();
      } catch { /* silencioso — não afeta a thread */ }
      state.current = state.conversations.find(item => Number(item.id) === Number(conv.id)) || conv;

      updateMessagesList({ scroll: true });
    } catch (e) {
      state.messages = cached; // fallback to cache on error
      state.loadingMessages = false;
      state.error = (!cached.length && !conv.last_message_id) ? '' : (e.message || 'Erro ao carregar mensagens');
      updateMessagesList({ scroll: false });
    }
  }

  async function openGroupConversation(group) {
    state.current = group;
    state.currentKind = 'group';

    // [FIX] Restore cached messages immediately
    const k = cacheKey();
    const cached = k ? (state._msgCache[k] || []) : [];
    state.messages = cached;
    state.loadingMessages = cached.length === 0;
    state.error = '';

    render();
    if (cached.length) updateScroll();

    try {
      let data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=80`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && group.last_message_id) {
        await wait(450);
        data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=80&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      state.messages = dedupeMessages(rows);
      state.loadingMessages = false;
      state.error = ''; // mensagens carregadas com sucesso — limpa erro anterior
      if (k) state._msgCache[k] = state.messages.slice();

      group.unread_count = 0;
      // loadGroups pode falhar sem afetar o chat aberto
      try {
        await loadGroups();
      } catch { /* silencioso */ }
      state.current = state.groups.find(item => Number(item.id) === Number(group.id)) || group;

      updateMessagesList({ scroll: true });
    } catch (e) {
      state.messages = cached;
      state.loadingMessages = false;
      state.error = (!cached.length && !group.last_message_id) ? '' : (e.message || 'Erro ao carregar mensagens');
      updateMessagesList({ scroll: false });
    }
  }

  async function refreshCurrentMessages() {
    if (!state.current || state.busy) return;
    const isGroup = state.currentKind === 'group';
    const data = await api(`/${isGroup ? 'api/me/group-conversations' : 'api/me/conversations'}/${encodeURIComponent(state.current.id)}/messages?limit=80`);
    const nextMessages = dedupeMessages(Array.isArray(data.rows) ? data.rows : []);

    // Merge: keep pending/failed tmp messages; replace tmp with real if IDs match by index
    const pendingMsgs = state.messages.filter(m => String(m.id).startsWith('tmp-'));
    // Merge server messages into state, preserving pending tmp messages that haven't been confirmed
    const serverIds = new Set(nextMessages.map(m => String(m.id)));
    const merged = [...nextMessages];

    // Re-append any pending/failed tmp messages that server doesn't know about yet
    for (const pending of pendingMsgs) {
      if (!serverIds.has(String(pending.id))) {
        merged.push(pending);
      }
    }

    const before = state.messages.filter(m => !String(m.id).startsWith('tmp-')).map(m => m.id).join(',');
    const after = nextMessages.map(m => m.id).join(',');

    if (before !== after) {
      const list = root.querySelector('[data-chat-messages]');
      const wasNearBottom = !list || (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
      state.messages = merged;
      const k = cacheKey();
      if (k) state._msgCache[k] = merged.slice();
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
    const draft = typeof arguments[1] === 'string'
      ? arguments[1]
      : String(arguments[1]?.draft || '');
    if (draft) state.pendingDraft = draft;
    state.open = true;
    syncBodyChatState();
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
      applyPendingDraft();
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
    const savedBody = textarea.value;
    state.busy = true;
    state.error = '';
    textarea.value = '';
    textarea.style.height = 'auto'; // [FIX] reset textarea height after send
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
      // Update cache
      const k = cacheKey();
      if (k) state._msgCache[k] = state.messages.slice();

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
      textarea.value = savedBody;
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
    updateConversationList();
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
      updateConversationList();
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
    const reload = event.target.closest('[data-chat-reload]');

    try {
      if (toggle) {
        state.open ? closePanel() : await openPanel();
      } else if (close) {
        closePanel();
      } else if (reload) {
        if (!state.current) return;
        if (state.currentKind === 'group') await openGroupConversation(state.current);
        else await openConversation(state.current);
      } else if (tab) {
        state.tab = tab.dataset.chatTab;
        state.search = '';
        state.groupCreating = false;
        if (state.tab === 'friends') state.loadingFriends = !state.friends.length;
        if (state.tab === 'groups') state.loadingGroups = !state.groups.length;
        // Partial update: just refresh list
        updateConversationList();
        if (state.tab === 'friends') {
          await loadFriends();
          state.loadingFriends = false;
        }
        if (state.tab === 'groups') {
          await Promise.all([loadGroups(), loadFriends()]);
          state.loadingGroups = false;
        }
        updateConversationList();
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
        render();
        if (state.tab === 'groups') await loadGroups();
        else await loadConversations();
        updateConversationList();
      } else if (profile) {
        const target = `id:${profile.dataset.chatProfile}`;
        closePanel(); // fecha o chat antes de navegar
        if (typeof window.navigateProfile === 'function') window.navigateProfile(target);
        else location.href = `profile.html?id=${encodeURIComponent(target)}`;
      } else if (newGroup) {
        state.groupCreating = true;
        state.search = '';
        state.loadingFriends = !state.friends.length;
        updateConversationList();
        await loadFriends();
        state.loadingFriends = false;
        updateConversationList();
      } else if (cancelGroup) {
        state.groupCreating = false;
        state.groupName = '';
        state.groupMemberIds = [];
        updateConversationList();
      } else if (memberToggle) {
        const id = String(memberToggle.dataset.chatMemberToggle);
        state.groupMemberIds = state.groupMemberIds.includes(id)
          ? state.groupMemberIds.filter(item => item !== id)
          : [...state.groupMemberIds, id].slice(0, 19);
        updateConversationList();
      }
    } catch (e) {
      state.error = e.message || 'Acao nao concluida.';
      updateConversationList();
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
    const chatInput = event.target.closest('[data-chat-input]');
    if (chatInput) {
      const counter = root.querySelector('[data-chat-char-counter]');
      if (counter) {
        const remaining = 500 - chatInput.value.length;
        const show = chatInput.value.length > 440;
        counter.textContent = show ? `${remaining} restantes` : '';
        counter.style.opacity = show ? '1' : '0';
        counter.style.color = remaining < 20 ? 'var(--fc-red,#ff5f52)' : 'var(--fc-ink-3,#7a756a)';
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

  document.addEventListener('click', event => {
    const navButton = event.target.closest('.mobile-bottom-nav .mbtn');
    if (!navButton) return;
    syncFabPosition();
    if (navButton.id === 'mobile-chat-btn') return;
    if (state.open) closePanel();
  }, true);

  // ── Mobile keyboard: keep compose bar visible above the keyboard ──
  // Uses visualViewport API (Chrome/Safari 13+) to detect when the soft
  // keyboard pushes up the visible area, then shifts the panel height
  // so the compose bar always stays just above the keyboard.
  (function setupKeyboardAvoidance() {
    const vv = window.visualViewport;
    if (!vv) return;

    let rafId = null;
    function onViewportChange() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const panel = root.querySelector('.fa-chat-panel');
        if (!panel || !state.open) return;

        // Only apply on mobile (panel is full-screen)
        if (window.innerWidth > 768) return;

        // How much the keyboard has pushed the viewport up
        const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const navHeight = parseInt(root.style.getPropertyValue('--fa-chat-mobile-nav-height') || '0', 10);

        if (keyboardHeight > 20) {
          // Keyboard is open: shrink the panel so compose is visible above keyboard
          // Subtract navHeight because bottom is already offset by nav
          const offset = Math.max(0, keyboardHeight - navHeight);
          panel.style.height = `calc(${vv.height}px - var(--fa-chat-mobile-nav-height, 0px))`;
          panel.style.top = `${vv.offsetTop}px`;
          // Pass offset to CSS for compose padding
          root.style.setProperty('--fc-keyboard-offset', '0px');
        } else {
          // Keyboard closed: restore full-screen panel
          panel.style.height = '';
          panel.style.top = '';
          root.style.setProperty('--fc-keyboard-offset', '0px');
          // Scroll to bottom after keyboard dismissal
          const msgs = panel.querySelector('[data-chat-messages]');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
      });
    }

    vv.addEventListener('resize', onViewportChange, { passive: true });
    vv.addEventListener('scroll', onViewportChange, { passive: true });
  })();

  window.FAChat = {
    open: openPanel,
    close: closePanel,
    openWithUser,
    shareWithUser: async (user, text) => openWithUser(user, text),
    refresh: async () => {
      await Promise.all([loadUnread(), loadConversations(), loadGroups(), loadFriends()]);
      updateConversationList();
      updateLauncherBadge();
    },
  };

  async function warmChat() {
    if (state.warmed) return;
    state.warmed = true;
    try {
      await ensureMe();
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
      if (state.open && !state.current) updateConversationList();
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
  let _lastPoll = 0;
  setInterval(async () => {
    const now = Date.now();
    // In active thread: poll every 8s. Background unread: poll every 20s. Inbox open: 10s.
    const interval = state.current ? 8000 : (!state.open ? 20000 : 10000);
    if (now - _lastPoll < interval) return;
    if (document.hidden && !state.current) return;
    if (_chatPollFailures >= 3) {
      // Back-off: skip every other tick after 3 failures
      if (_chatPollFailures % 2 !== 0) { _chatPollFailures++; return; }
    }
    _lastPoll = now;
    try {
      if (!state.open) {
        await loadUnread();
      } else if (state.current) {
        await refreshCurrentMessages();
      } else if (state.open) {
        if (state.tab === 'groups') await loadGroups();
        else await loadConversations();
        updateConversationList();
      }
      _chatPollFailures = 0;
    } catch {
      _chatPollFailures++;
      // Poll failures are silent — don't overwrite UI error state
    }
  }, 2000);
})();
