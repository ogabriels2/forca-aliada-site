/**
 * Força Aliada — Chat Direto  (social-chat.js)
 * ═══════════════════════════════════════════════════════════════════════════
 * VERSION: chat13-20260608
 *
 * NOVIDADES vs chat7:
 *  • SSE (Server-Sent Events) — recebe mensagens em ≤100ms sem polling
 *    Fallback automático para polling rápido (3s) se SSE não disponível
 *  • Fila de envio paralela — enviar com ↵ antes da anterior terminar; ordem garantida
 *  • Enter envia / Shift+Enter nova linha  (configurável)
 *  • Ticks de status WhatsApp:
 *       ⏳  pending   — enviando (animado)
 *       ✓   sent      — servidor confirmou, peer ainda não recebeu
 *       ✓✓  delivered — peer está online (user_sessions recente)
 *       ✓✓🔵 read     — peer abriu a conversa (last_read_at > msg.created_at)
 *  • Presença instantânea via SSE: online dot atualiza sem re-render
 *  • Heartbeat de sessão leve (POST /api/me/presence a cada 30s)
 *  • Sem remover state.busy — substituído por send queue independente
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  window._faChatScriptVersion = 'chat13-20260608';
  if (window.FAChat) return;

  // ── Storage seguro ────────────────────────────────────────────────────────────
  const safeStorage = (() => {
    try { return window.localStorage || window.__FA_STORAGE__ || null; }
    catch { return window.__FA_STORAGE__ || null; }
  })();
  const token = safeStorage?.getItem('fa_token') || '';
  if (!token) return;

  // ── API bases ─────────────────────────────────────────────────────────────────
  const PROD = 'https://forca-aliada-site.onrender.com';
  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const LOCAL_API = 'http://localhost:3000';
  const STORED_API = IS_LOCAL ? (safeStorage?.getItem('fa_api_base') || '') : '';
  const API_BASE = window.FA_API_BASE || STORED_API || (IS_LOCAL ? LOCAL_API : PROD);
  const bases = [...new Set((IS_LOCAL ? [API_BASE, LOCAL_API, PROD] : [window.FA_API_BASE || PROD, PROD]).filter(Boolean))];

  // ── Estado global ─────────────────────────────────────────────────────────────
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
    _msgCache: {},       // key "direct:id" → msg[]
    unread: 0,
    search: '',
    groupCreating: false,
    groupName: '',
    groupMemberIds: [],
    busy: false,         // mantido para operações não-mensagem (criar grupo, etc.)
    error: '',
    composeError: '',
    recording: {
      active: false,
      locked: false,
      elapsed: 0,
      error: '',
    },
    loadingConversations: false,
    loadingGroups: false,
    loadingFriends: false,
    loadingMessages: false,
    warmed: false,
    pendingDraft: '',
    _sentRequests: new Set(),
    // Delivery status da conversa atual
    _peerLastReadAt: null,    // ISO string
    _peerIsOnline: false,
    _myLastReadAt: null,
    pendingAttachments: [],
    replyTo: null,
    editingMessage: null,
    _socialPreviewCache: new Map(),
    _socialPreviewPending: new Map(),
  };

  // ── Fila de envio independente de state.busy ──────────────────────────────────
  // Permite enviar uma msg antes de a anterior ser confirmada pelo servidor,
  // mantendo a ordem FIFO via Promise chain.
  let _sendQueue = Promise.resolve();

  function queueSend(body) {
    _sendQueue = _sendQueue.then(() => _doSendMessage(body)).catch(() => {});
    return _sendQueue;
  }

  // ── SSE (Server-Sent Events) ──────────────────────────────────────────────────
  let _sseConn = null;           // EventSource atual
  let _sseKey = null;            // "direct:id" ou "group:id"
  let _sseReconnectTimer = null;
  let _sseFallbackActive = false;

  function sseKey() {
    if (!state.current) return null;
    return `${state.currentKind}:${state.current.id}`;
  }

  function openSSE() {
    const key = sseKey();
    if (!key || _sseConn) return;
    if (typeof EventSource === 'undefined') { _sseFallbackActive = true; return; }

    _sseKey = key;
    const [kind, convId] = key.split(':');
    // EventSource não suporta headers customizados — enviamos token como ?_token=
    // O server_chat_realtime.mjs valida esse token identicamente ao header Authorization
    const url = `${bases[0]}/api/me/chat/stream?conv=${encodeURIComponent(convId)}&kind=${kind}&_token=${encodeURIComponent(token)}`;

    try {
      const es = new EventSource(url);
      _sseConn = es;
      _sseFallbackActive = false;

      es.addEventListener('connected', () => {
        _sseFallbackActive = false;
        clearTimeout(_sseReconnectTimer);
      });

      es.addEventListener('message', handleSSEMessage);
      es.addEventListener('update', handleSSEUpdate);
      es.addEventListener('read', handleSSERead);
      es.addEventListener('presence', handleSSEPresence);

      es.onerror = () => {
        // SSE não disponível (servidor sem patch) → cai para polling rápido
        es.close();
        _sseConn = null;
        _sseFallbackActive = true;
      };
    } catch {
      _sseFallbackActive = true;
    }
  }

  function closeSSE() {
    if (_sseConn) { _sseConn.close(); _sseConn = null; }
    _sseKey = null;
    _sseFallbackActive = false;
    clearTimeout(_sseReconnectTimer);
  }

  function handleSSEMessage(evt) {
    try {
      const payload = JSON.parse(evt.data);
      const msg = payload.message || payload;
      if (!msg?.id) return;

      // Ignora se mudou de conversa
      if (!state.current || String(state.current.id) !== String(msg.conversation_id || msg.group_id || '')) {
        // Pode ser notificação de outra conversa — atualiza badge
        loadUnreadSilent();
        return;
      }

      // Adiciona se não existe ainda (o remetente já inseriu via optimistic)
      const alreadyIn = state.messages.some(m =>
        String(m.id) === String(msg.id) ||
        (msg.client_ref && String(m.client_ref || m.id) === String(msg.client_ref)) ||
        (m.client_status === 'pending' && m.body === msg.body && Number(m.sender_id) === Number(msg.sender_id))
      );
      if (!alreadyIn) {
        // Enriquece com dados do me se for minha mensagem
        const isMe = Number(msg.sender_id) === Number(state.me?.id);
        if (isMe) {
          msg.username = state.me?.username;
          msg.minecraft_name = state.me?.minecraft_name;
        }
        state.messages.push(msg);
        state.messages = dedupeMessages(state.messages);
        const k = cacheKey();
        if (k) state._msgCache[k] = state.messages.slice();
        const list = root.querySelector('[data-chat-messages]');
        const wasNearBottom = !list || (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
        updateMessagesList({ scroll: wasNearBottom });
      } else {
        // Talvez seja uma mensagem pending que o servidor confirmou via SSE
        // (quando OUTRO cliente do mesmo user envia)
        replacePendingWithReal(msg);
      }
    } catch { /* parse error silencioso */ }
  }

  function applyMessageUpdate(update = {}) {
    const index = state.messages.findIndex(message => String(message.id) === String(update.id));
    if (index < 0) return;
    state.messages[index] = { ...state.messages[index], ...update };
    const k = cacheKey();
    if (k) state._msgCache[k] = state.messages.slice();
    updateMessagesList({ scroll: false });
  }

  function handleSSEUpdate(evt) {
    try {
      const payload = JSON.parse(evt.data);
      const message = payload.message || payload;
      if (!message?.id || !state.current) return;
      const containerId = message.conversation_id || message.group_id;
      if (String(containerId || '') !== String(state.current.id)) return;
      applyMessageUpdate(message);
    } catch {}
  }

  function handleSSERead(evt) {
    try {
      const payload = JSON.parse(evt.data);
      const { userId, lastReadAt } = payload;
      if (!userId || !lastReadAt) return;

      // Se for o peer lendo
      if (Number(userId) !== Number(state.me?.id)) {
        state._peerLastReadAt = lastReadAt;
        updateAllMessageTicks();
      }
    } catch { /* silencioso */ }
  }

  function handleSSEPresence(evt) {
    try {
      const payload = JSON.parse(evt.data);
      const { userId, online } = payload;
      if (!userId || Number(userId) === Number(state.me?.id)) return;

      state._peerIsOnline = Boolean(online);

      // Atualiza o online dot no peerbar sem re-render completo
      const panel = root.querySelector('.fa-chat-panel');
      const dot = panel?.querySelector('.fa-chat-online-dot.fa-chat-online-dot--peer');
      const peerbar = panel?.querySelector('.fa-chat-peerbar small');

      if (state.currentKind !== 'group') {
        if (online && !dot) {
          const avWrap = panel?.querySelector('.fa-chat-av-wrap--peer');
          avWrap?.insertAdjacentHTML('beforeend', '<span class="fa-chat-online-dot fa-chat-online-dot--peer"></span>');
        } else if (!online && dot) {
          dot.remove();
        }
        if (peerbar) {
          const handle = state.current ? `@${handleOf(state.current)}` : '';
          const friend = state.current?.is_friend ? ' · amigo' : '';
          peerbar.textContent = `${handle}${online ? ' · online' : friend}`;
        }
      }

      // Atualiza ticks quando peer fica online (pode ter delivered)
      if (online) updateAllMessageTicks();
    } catch { /* silencioso */ }
  }

  // ── Ticks de delivery ─────────────────────────────────────────────────────────
  // Estado dos ticks por mensagem (só minhas):
  // pending → sent → delivered → read
  function calcTickStatus(msg) {
    if (msg.client_status === 'pending') return 'pending';
    if (msg.client_status === 'failed')  return 'failed';
    if (String(msg.id).startsWith('tmp-')) return 'pending';

    const msgAt = msg.created_at ? new Date(msg.created_at).getTime() : 0;

    // read: peer abriu depois que a msg foi criada
    if (state._peerLastReadAt) {
      const readAt = new Date(state._peerLastReadAt).getTime();
      if (readAt >= msgAt) return 'read';
    }

    // delivered: peer está online
    if (state._peerIsOnline) return 'delivered';

    // sent: servidor confirmou
    return 'sent';
  }

  const TICK_HTML = {
    pending:   `<svg class="fa-tick" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.8" stroke-dasharray="37.7" stroke-dashoffset="37.7" class="fa-tick-spin"/></svg>`,
    sent:      `<svg class="fa-tick" viewBox="0 0 16 10" fill="none"><path d="M1 5l4 4 9-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    delivered: `<svg class="fa-tick" viewBox="0 0 20 10" fill="none"><path d="M1 5l4 4 9-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 5l4 4 9-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    read:      `<svg class="fa-tick fa-tick--read" viewBox="0 0 20 10" fill="none"><path d="M1 5l4 4 9-8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 5l4 4 9-8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    failed:    `<svg class="fa-tick fa-tick--fail" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  };

  function renderTick(msg) {
    const isMe = Number(msg.sender_id) === Number(state.me?.id);
    if (!isMe) return '';
    const status = calcTickStatus(msg);
    return `<span class="fa-tick-wrap" data-tick-status="${status}">${TICK_HTML[status] || ''}</span>`;
  }

  function updateAllMessageTicks() {
    const list = root.querySelector('[data-chat-messages]');
    if (!list || !state.current) return;
    list.querySelectorAll('[data-msg-id]').forEach(node => {
      const msgId = node.dataset.msgId;
      const msg = state.messages.find(m => String(m.id) === msgId);
      if (!msg) return;
      const isMe = Number(msg.sender_id) === Number(state.me?.id);
      if (!isMe) return;
      const tickWrap = node.querySelector('.fa-tick-wrap');
      if (!tickWrap) return;
      const status = calcTickStatus(msg);
      if (tickWrap.dataset.tickStatus === status) return; // sem mudança
      tickWrap.dataset.tickStatus = status;
      tickWrap.innerHTML = TICK_HTML[status] || '';
    });
  }

  // ── Poll de status (presença + read receipts) ─────────────────────────────────
  // Polled apenas quando SSE está desconectado ou como backup a cada 15s
  async function pollConversationStatus() {
    if (!state.current || state.currentKind === 'group') return;
    try {
      const data = await api(`/api/me/conversations/${encodeURIComponent(state.current.id)}/status`);
      const changed = (
        data.peer_last_read_at !== state._peerLastReadAt ||
        data.peer_is_online !== state._peerIsOnline
      );
      state._peerLastReadAt = data.peer_last_read_at || null;
      state._peerIsOnline   = Boolean(data.peer_is_online);
      state._myLastReadAt   = data.my_last_read_at || null;
      if (changed) updateAllMessageTicks();
    } catch { /* silencioso */ }
  }

  // ── Heartbeat de presença web ─────────────────────────────────────────────────
  let _presenceTimer = null;
  function startPresenceBeacon() {
    stopPresenceBeacon();
    _presenceTimer = setInterval(() => {
      if (!state.open) return;
      const convKey = sseKey();
      api('/api/me/presence', {
        method: 'POST',
        body: JSON.stringify({ conv_key: convKey }),
        timeoutMs: 8000,
      }).catch(() => {});
    }, 30_000);
  }
  function stopPresenceBeacon() {
    clearInterval(_presenceTimer);
    _presenceTimer = null;
  }

  // ── SVG icons ─────────────────────────────────────────────────────────────────
  const icons = {
    chat:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    back:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
    send:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>',
    mic:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
    stop:  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V7a4 4 0 0 1 8 0v4"/><rect x="5" y="11" width="14" height="11" rx="2"/></svg>',
    more:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
    download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    user:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    plus:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    attach:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9.8 17.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 18h10l1-18"/><path d="M10 11v6M14 11v6"/></svg>',
    file:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  };

  // ── DOM root ──────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'fa-chat-root';
  document.body.appendChild(root);
  let fabObserver = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const nameOf = p => p?.minecraft_name || p?.other_minecraft_name || p?.username || p?.other_username || 'Steve';
  const handleOf = p => p?.username || p?.other_username || nameOf(p);
  const groupNameOf = g => g?.name || 'Grupo';
  const skin = (name, size=50) => `https://minotar.net/helm/${encodeURIComponent((name||'Steve').trim()||'Steve')}/${size}.png`;
  const rel = value => {
    if (!value) return '';
    const diff = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (diff < 45)      return 'agora';
    if (diff < 3600)    return `${Math.floor(diff/60)}m`;
    if (diff < 86400)   return `${Math.floor(diff/3600)}h`;
    if (diff < 172800)  return 'ontem';
    return new Date(value).toLocaleDateString('pt-BR', {day:'2-digit',month:'short'});
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const CHAT_MAX_ATTACHMENTS = 4;
  const CHAT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const CHAT_FILE_ACCEPT = [
    'image/*',
    'video/*',
    'audio/*',
    'application/pdf',
    '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.webm',
    '.doc', '.docx',
    '.xls', '.xlsx',
    '.ppt', '.pptx',
    '.txt', '.csv',
    '.zip', '.rar', '.7z',
  ].join(',');
  const CHAT_FILE_EXTENSIONS = new Set(['pdf','mp3','m4a','aac','wav','ogg','oga','opus','webm','doc','docx','xls','xlsx','ppt','pptx','txt','csv','zip','rar','7z']);
  let attachmentSeq = 0;
  const recordingState = {
    recorder: null,
    stream: null,
    chunks: [],
    timer: null,
    startedAt: 0,
    mimeType: '',
    pointerId: null,
    startY: 0,
    pointerReleased: false,
    cancelOnStart: false,
    lockOnStart: false,
    suppressClickUntil: 0,
  };

  function cleanFileName(value = 'arquivo') {
    const name = String(value || 'arquivo')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return (name || 'arquivo').slice(0, 120);
  }

  function extOf(name = '') {
    const parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function attachmentKindFromType(type = '', name = '') {
    const mime = String(type || '').toLowerCase();
    const ext = extOf(name);
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (CHAT_FILE_EXTENSIONS.has(ext)) return 'file';
    return '';
  }

  function formatFileSize(bytes = 0) {
    const size = Number(bytes || 0);
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function normalizeAttachment(att = {}) {
    if (!att || typeof att !== 'object') return null;
    const type = String(att.type || att.kind || attachmentKindFromType(att.mime_type || att.type, att.name)).toLowerCase();
    const url = String(att.url || att.preview_url || '').trim();
    if (!type || !['image','video','audio','pdf','file'].includes(type)) return null;
    return {
      url,
      preview_url: att.preview_url || '',
      type,
      name: cleanFileName(att.name || 'arquivo'),
      mime_type: String(att.mime_type || att.mimetype || '').slice(0, 120),
      size: Number(att.size || att.bytes || 0) || 0,
      width: Number(att.width || 0) || null,
      height: Number(att.height || 0) || null,
      duration: Number(att.duration || 0) || null,
    };
  }

  function messageAttachments(message = {}) {
    return (Array.isArray(message.attachments) ? message.attachments : [])
      .map(normalizeAttachment)
      .filter(Boolean)
      .slice(0, CHAT_MAX_ATTACHMENTS);
  }

  function attachmentPreviewText(attachments = []) {
    const list = Array.isArray(attachments) ? attachments : [];
    if (!list.length) return '';
    if (list.length > 1) return `${list.length} anexos`;
    if (list[0].type === 'image') return 'Imagem';
    if (list[0].type === 'video') return 'Video';
    if (list[0].type === 'audio') return 'Audio';
    if (list[0].type === 'pdf') return 'PDF';
    return 'Arquivo';
  }

  function messagePreviewText(body, attachments) {
    const text = String(body || '').trim();
    return text || attachmentPreviewText(attachments) || '';
  }

  function releaseAttachmentPreviews(items = []) {
    items.forEach(item => {
      if (item?.preview_url?.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.preview_url); } catch {}
      }
    });
  }

  function cacheKey() {
    if (!state.current) return null;
    return `${state.currentKind}:${state.current.id}`;
  }

  // ── API fetch com fallback ────────────────────────────────────────────────────
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const timeoutMs = options.timeoutMs || 35000;
    const fetchOptions = { ...options, cache: 'no-store' };
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
        err = e.name === 'AbortError' ? new Error('A API demorou para responder.') : e;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw err;
  }

  // ── Render helpers ─────────────────────────────────────────────────────────────
  function currentViewKey() {
    return state.current ? `${state.currentKind}:${state.current.id}` : 'inbox';
  }

  function render() {
    syncFabPosition();
    syncBodyChatState();
    const isOpen = state.open;
    const hasCurrent = Boolean(state.current);

    let launcher = root.querySelector('.fa-chat-launcher');
    if (!launcher) {
      root.innerHTML = buildFullHTML();
      attachComposeHandlers();
      initMessageEnhancements(root);
      return;
    }

    launcher.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    _updateBadgeInLauncher(launcher);

    let panel = root.querySelector('.fa-chat-panel');
    if (!panel) {
      root.innerHTML = buildFullHTML();
      attachComposeHandlers();
      initMessageEnhancements(root);
      return;
    }

    panel.classList.toggle('is-open', isOpen);
    panel.classList.toggle('has-thread', hasCurrent);
    panel.classList.toggle('has-inbox', !hasCurrent);

    if (!isOpen) return;

    const viewKey = currentViewKey();
    if (panel.dataset.viewKey !== viewKey || !panel.querySelector('.fa-chat-app')) {
      panel.dataset.viewKey = viewKey;
      panel.innerHTML = renderChatApp();
      attachComposeHandlers();
      initMessageEnhancements(panel);
      if (hasCurrent) updateScroll();
      return;
    }

    updateSidebar();
    if (hasCurrent) {
      const msgList = panel.querySelector('[data-chat-messages]');
      if (msgList) {
        msgList.innerHTML = renderMessagesContent();
        initMessageEnhancements(msgList);
      }
    }
  }

  function buildFullHTML() {
    return `
      <button class="fa-chat-launcher" type="button" data-chat-toggle aria-label="Mensagens" aria-expanded="${state.open}">
        ${icons.chat}
        ${state.unread ? `<span class="fa-chat-badge">${state.unread > 99 ? '99+' : esc(state.unread)}</span>` : ''}
      </button>
      <section class="fa-chat-panel ${state.open?'is-open':''} ${state.current?'has-thread':'has-inbox'}" data-view-key="${esc(currentViewKey())}" aria-label="Mensagens diretas">
        ${renderChatApp()}
      </section>`;
  }

  function renderChatApp() {
    return `
      <div class="fa-chat-app">
        <aside class="fa-chat-sidebar" aria-label="Conversas">${renderSidebar()}</aside>
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
          <div><strong>Mensagens</strong><span>${state.conversations.length||state.groups.length ? 'Conversas e grupos':'Amigos e comunidade'}</span></div>
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
      if (state.tab==='conversations') list.innerHTML = renderConversations();
      else if (state.tab==='groups') list.innerHTML = renderGroups();
      else if (state.tab==='friends') list.innerHTML = renderFriends();
    }
    panel.querySelectorAll('[data-chat-tab]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.chatTab===state.tab);
    });
  }

  function renderThreadEmpty() {
    return `
      <div class="fa-chat-empty-stage">
        <span class="fa-chat-empty-icon">${icons.chat}</span>
        <strong>Escolha uma conversa</strong>
        <p>Abra um chat recente, busque alguém ou compartilhe uma postagem direto para uma pessoa.</p>
      </div>`;
  }

  function _updateBadgeInLauncher(launcher) {
    const currentBadge = launcher.querySelector('.fa-chat-badge');
    if (!state.unread) { currentBadge?.remove(); return; }
    const text = state.unread > 99 ? '99+' : String(state.unread);
    if (currentBadge) currentBadge.textContent = text;
    else launcher.insertAdjacentHTML('beforeend', `<span class="fa-chat-badge">${esc(text)}</span>`);
  }

  function updateLauncherBadge() {
    const launcher = root.querySelector('[data-chat-toggle]');
    if (!launcher) { render(); return; }
    launcher.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    _updateBadgeInLauncher(launcher);
    ['#desktop-chat-btn','#mobile-chat-btn'].forEach(sel => {
      const btn = document.querySelector(sel);
      if (!btn) return;
      let dot = btn.querySelector('.fa-chat-nav-badge');
      if (!state.unread) { dot?.remove(); return; }
      const text = state.unread > 99 ? '99+' : String(state.unread);
      if (dot) dot.textContent = text;
      else {
        btn.style.position = 'relative';
        btn.insertAdjacentHTML('beforeend', `<span class="fa-chat-nav-badge" aria-hidden="true">${esc(text)}</span>`);
      }
    });
  }

  function syncBodyChatState() {
    document.body.classList.toggle('fa-chat-open', Boolean(state.open));
    syncMobileNavState();
  }

  function syncFabPosition() {
    const fab = document.querySelector('.fab-post');
    const mobileNav = document.querySelector('.mobile-bottom-nav');
    const navVisible = Boolean(mobileNav && getComputedStyle(mobileNav).display !== 'none' && mobileNav.getBoundingClientRect().height > 0);
    root.classList.toggle('fa-chat-has-mobile-nav', navVisible);
    if (navVisible) {
      const navRect = mobileNav.getBoundingClientRect();
      root.style.setProperty('--fa-chat-mobile-nav-height', `${Math.ceil(navRect.height + Math.max(0, window.innerHeight - navRect.bottom))}px`);
    } else {
      root.style.setProperty('--fa-chat-mobile-nav-height', '0px');
    }
    if (!fab) { root.classList.remove('fa-chat-has-fab'); return; }
    const rect = fab.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || getComputedStyle(fab).display === 'none') { root.classList.remove('fa-chat-has-fab'); return; }
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
    if (state.open) buttons.forEach(btn => btn.classList.toggle('is-active', btn === chatButton));
    else chatButton.classList.remove('is-active');
  }

  function recalcUnread() {
    state.unread = state.conversations.reduce((s, c) => s + Number(c.unread_count||0), 0)
                 + state.groups.reduce((s, g) => s + Number(g.unread_count||0), 0);
  }

  function updateConversationList() {
    const panel = root.querySelector('.fa-chat-panel');
    const list  = root.querySelector('.fa-chat-list');
    if (panel) panel.querySelectorAll('[data-chat-tab]').forEach(btn => btn.classList.toggle('is-active', btn.dataset.chatTab===state.tab));
    if (!list || state.current) return;
    if (state.tab==='conversations') list.innerHTML = renderConversations();
    if (state.tab==='groups')        list.innerHTML = renderGroups();
    if (state.tab==='friends')       list.innerHTML = renderFriends();
    updateLauncherBadge();
  }

  function updateMessagesList({ scroll = false } = {}) {
    const list = root.querySelector('[data-chat-messages]');
    if (!list || !state.current) return;

    state.messages = dedupeMessages(state.messages);
    const k = cacheKey();
    if (k) state._msgCache[k] = state.messages.slice();

    if (state.loadingMessages || !state.messages.length) {
      list.innerHTML = renderMessagesContent();
      initMessageEnhancements(list);
      if (scroll) updateScroll();
      return;
    }

    // Error banner
    let errBanner = list.querySelector('.fa-chat-inline-error');
    if (state.error) {
      const errHTML = `<div class="fa-chat-inline-error"><strong>Erro ao carregar mensagens</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button></div>`;
      if (!errBanner) list.insertAdjacentHTML('afterbegin', errHTML);
      else errBanner.innerHTML = `<strong>Erro</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button>`;
    } else {
      errBanner?.remove();
    }

    list.querySelector('.fa-chat-empty')?.remove();
    list.querySelector('.fa-chat-message-loading')?.remove();
    removeDuplicateMessageNodes(list);

    const renderedIds = new Set();
    const pendingNodes = new Map();
    list.querySelectorAll('[data-msg-id]').forEach(node => {
      const id = node.dataset.msgId;
      renderedIds.add(id);
      if (id.startsWith('tmp-')) pendingNodes.set(id, node);
    });

    let prevDateLabel = null;
    const allMsgs = state.messages;
    for (let i = 0; i < allMsgs.length; i++) {
      const msg = allMsgs[i];
      const msgId = String(msg.id);
      const prevMsg = i > 0 ? allMsgs[i-1] : null;
      const nextMsg = i < allMsgs.length-1 ? allMsgs[i+1] : null;

      // Date separator
      const msgDate = msg.created_at ? new Date(msg.created_at).toLocaleDateString('pt-BR') : null;
      if (msgDate && msgDate !== prevDateLabel) {
        prevDateLabel = msgDate;
        const sepId = `datesep-${msgDate.replace(/\//g,'-')}`;
        if (!list.querySelector(`[data-date-sep="${CSS.escape(sepId)}"]`)) {
          list.insertAdjacentHTML('beforeend', `<div class="fa-chat-date-sep" data-date-sep="${esc(sepId)}"><span>${esc(formatDatePill(msg.created_at))}</span></div>`);
        }
      }

      const isMe = Number(msg.sender_id) === Number(state.me?.id);
      const samePrev = prevMsg && Number(prevMsg.sender_id)===Number(msg.sender_id) && sameMinute(prevMsg.created_at, msg.created_at);
      const sameNext = nextMsg && Number(nextMsg.sender_id)===Number(msg.sender_id) && sameMinute(msg.created_at, nextMsg.created_at);
      const isGroupFirst = !samePrev;
      const isGroupLast  = !sameNext;

      // tmp→real merge
      if (!renderedIds.has(msgId) && !msgId.startsWith('tmp-')) {
        let mergedTmp = null;
        pendingNodes.forEach((node, tmpId) => {
          if (!mergedTmp && msg.client_ref && String(msg.client_ref) === String(tmpId)) {
            mergedTmp = { node, tmpId };
            return;
          }
          // Busca no body específico para não capturar o timestamp no textContent
          const bodyEl = node.querySelector('.fa-chat-bubble-body');
          const bubbleText = bodyEl ? bodyEl.textContent : (node.querySelector('.fa-chat-bubble')?.textContent||'');
          const sameBubble = bubbleText.includes(String(msg.body||''));
          const sameSide = node.classList.contains('is-me') === isMe;
          if (!mergedTmp && sameBubble && sameSide && !state.messages.some(m=>m.id===tmpId)) {
            mergedTmp = { node, tmpId };
          }
        });
        if (mergedTmp) {
          const newNode = buildMessageNode(msg, isMe, isGroupFirst, isGroupLast);
          mergedTmp.node.replaceWith(newNode);
          pendingNodes.delete(mergedTmp.tmpId);
          renderedIds.add(msgId);
          continue;
        }
      }

      if (renderedIds.has(msgId)) {
        const existingNode = list.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (existingNode) {
          const fingerprint = messageFingerprint(msg);
          if (existingNode.dataset.messageFingerprint !== fingerprint) {
            existingNode.replaceWith(buildMessageNode(msg, isMe, isGroupFirst, isGroupLast));
            continue;
          }
          existingNode.classList.toggle('is-pending', msg.client_status==='pending');
          existingNode.classList.toggle('is-failed',  msg.client_status==='failed');
          existingNode.classList.toggle('is-group-first', isGroupFirst);
          existingNode.classList.toggle('is-group-last',  isGroupLast);
          existingNode.classList.toggle('is-grouped', !isGroupFirst);
          const av = existingNode.querySelector('.fa-chat-bubble-av');
          if (av) av.style.visibility = isGroupFirst ? 'visible' : 'hidden';
          // Atualiza tick
          const tickWrap = existingNode.querySelector('.fa-tick-wrap');
          if (tickWrap && isMe) {
            const status = calcTickStatus(msg);
            if (tickWrap.dataset.tickStatus !== status) {
              tickWrap.dataset.tickStatus = status;
              tickWrap.innerHTML = TICK_HTML[status] || '';
            }
          }
          // Atualiza time
          const timeEl = existingNode.querySelector('time');
          if (timeEl) timeEl.textContent = msgTimeText(msg);
          // Fail alert (fica antes do bubble, dentro do bubble-wrap)
          const alertIcon = existingNode.querySelector('.fa-chat-fail-alert');
          if (msg.client_status==='failed' && !alertIcon) {
            existingNode.querySelector('.fa-chat-bubble-wrap')?.insertAdjacentHTML('afterbegin',
              `<button class="fa-chat-fail-alert" data-chat-retry="${esc(msgId)}" title="Tentar reenviar">⚠</button>`);
          } else if (msg.client_status!=='failed') alertIcon?.remove();
        }
        continue;
      }

      const newNode = buildMessageNode(msg, isMe, isGroupFirst, isGroupLast);
      newNode.classList.add('is-new');
      list.appendChild(newNode);
      renderedIds.add(msgId);
      requestAnimationFrame(() => newNode.classList.remove('is-new'));
    }

    if (scroll) updateScroll();
  }

  function msgTimeText(msg) {
    if (msg.client_status === 'pending') return 'enviando...';
    if (msg.client_status === 'failed')  return `não enviada${msg.client_error ? ` — ${msg.client_error}` : ''}`;
    return rel(msg.created_at);
  }

  function dedupeMessages(rows) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter(m => {
      const id = String(m?.id ?? '');
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
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

  function replacePendingWithReal(realMsg) {
    const list = root.querySelector('[data-chat-messages]');
    if (!list) return;
    const isMe = Number(realMsg.sender_id) === Number(state.me?.id);
    let found = false;
    list.querySelectorAll('[data-msg-id]').forEach(node => {
      if (found) return;
      const id = node.dataset.msgId;
      if (!id.startsWith('tmp-')) return;
      if (realMsg.client_ref && String(realMsg.client_ref) === String(id)) {
        const wasGroupFirst = node.classList.contains('is-group-first');
        const wasGroupLast = node.classList.contains('is-group-last');
        node.dataset.msgId = String(realMsg.id);
        node.classList.remove('is-pending');
        const timeEl = node.querySelector('time');
        if (timeEl) timeEl.textContent = rel(realMsg.created_at);
        const tickWrap = node.querySelector('.fa-tick-wrap');
        if (tickWrap && isMe) {
          const status = calcTickStatus(realMsg);
          tickWrap.dataset.tickStatus = status;
          tickWrap.innerHTML = TICK_HTML[status] || '';
        }
        const idx = state.messages.findIndex(m => String(m.id) === id || String(m.client_ref || '') === String(realMsg.client_ref));
        if (idx >= 0) {
          state.messages[idx] = { ...realMsg, username: state.me?.username, minecraft_name: state.me?.minecraft_name };
          const k = cacheKey();
          if (k) state._msgCache[k] = state.messages.slice();
        }
        node.replaceWith(buildMessageNode({ ...realMsg, username: state.me?.username, minecraft_name: state.me?.minecraft_name }, isMe, wasGroupFirst, wasGroupLast));
        found = true;
        return;
      }
      // Busca o conteúdo no .fa-chat-bubble-body (novo) ou fallback para bubble inteiro
      const bodyEl = node.querySelector('.fa-chat-bubble-body');
      const bubbleText = bodyEl ? bodyEl.textContent : (node.querySelector('.fa-chat-bubble')?.textContent || '');
      if (bubbleText.includes(String(realMsg.body||'')) && node.classList.contains('is-me') === isMe) {
        node.dataset.msgId = String(realMsg.id);
        node.classList.remove('is-pending');
        const timeEl = node.querySelector('time');
        if (timeEl) timeEl.textContent = rel(realMsg.created_at);
        const tickWrap = node.querySelector('.fa-tick-wrap');
        if (tickWrap && isMe) {
          const status = calcTickStatus(realMsg);
          tickWrap.dataset.tickStatus = status;
          tickWrap.innerHTML = TICK_HTML[status] || '';
        }
        // Update state.messages too
        const idx = state.messages.findIndex(m => m.id === id);
        if (idx >= 0) {
          state.messages[idx] = { ...realMsg, username: state.me?.username, minecraft_name: state.me?.minecraft_name };
          const k = cacheKey();
          if (k) state._msgCache[k] = state.messages.slice();
        }
        found = true;
      }
    });
  }

  function sameMinute(a, b) {
    if (!a || !b) return false;
    const da = new Date(a), db = new Date(b);
    return da.getFullYear()===db.getFullYear() && da.getMonth()===db.getMonth() &&
           da.getDate()===db.getDate() && da.getHours()===db.getHours() && da.getMinutes()===db.getMinutes();
  }

  function buildMessageNode(msg, isMe, isGroupFirst, isGroupLast) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMessage(msg, isGroupFirst, isGroupLast);
    const node = wrapper.firstElementChild;
    if (node) {
      node.dataset.messageFingerprint = messageFingerprint(msg);
      initMessageEnhancements(node);
    }
    return node;
  }

  function messageFingerprint(message = {}) {
    return JSON.stringify([
      message.body || '',
      message.edited_at || '',
      Boolean(message.is_deleted),
      message.reply_to_message_id || '',
      message.reply_to?.body || '',
      message.attachments || [],
      message.reactions || [],
      message.my_reactions || [],
    ]);
  }

  function formatDatePill(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date(); today.setHours(0,0,0,0);
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.floor((today - msgDay) / 86400000);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    return d.toLocaleDateString('pt-BR', {weekday:'long', day:'numeric', month:'long'});
  }

  function renderInbox() {
    return `
      <div class="fa-chat-tabs" role="tablist">
        <button class="fa-chat-tab ${state.tab==='conversations'?'is-active':''}" type="button" data-chat-tab="conversations">Conversas</button>
        <button class="fa-chat-tab ${state.tab==='groups'?'is-active':''}" type="button" data-chat-tab="groups">Grupos</button>
        <button class="fa-chat-tab ${state.tab==='friends'?'is-active':''}" type="button" data-chat-tab="friends">Amigos</button>
      </div>
      <div class="fa-chat-body">
        <div class="fa-chat-search">
          <input type="search" data-chat-search placeholder="${state.tab==='friends'?'Buscar pessoas':state.tab==='groups'?'Buscar grupos':'Buscar conversa'}" value="${esc(state.search)}" autocomplete="off">
        </div>
        <div class="fa-chat-list">${state.tab==='friends'?renderFriends():state.tab==='groups'?renderGroups():renderConversations()}</div>
      </div>`;
  }

  function renderConversations() {
    const term = state.search.trim().toLowerCase();
    const rows = state.conversations.filter(c => {
      const n = nameOf(c).toLowerCase(), h = handleOf(c).toLowerCase();
      return !term || n.includes(term) || h.includes(term);
    });
    if (state.error && !rows.length) return `<div class="fa-chat-error"><strong>Não foi possível carregar</strong><small>${esc(state.error)}</small><button class="fa-chat-retry-btn" type="button" data-chat-reload-list>Tentar novamente</button></div>`;
    if (state.loadingConversations && !rows.length) return loadingRows();
    if (!rows.length) return '<div class="fa-chat-empty"><strong>Nenhuma conversa ainda</strong>Abra um perfil e use Mensagem para começar.</div>';
    return rows.map(conv => {
      const name = nameOf(conv);
      const preview = messagePreviewText(conv.last_message_body, conv.last_message_attachments) || (conv.is_friend ? 'Amigos na comunidade' : 'Conversa aberta');
      const verified = conv.is_platform_verified ? `<span class="fa-chat-verified" title="Verificado"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg></span>` : '';
      return `
        <button class="fa-chat-row ${conv.unread_count?'is-unread':''}" type="button" data-chat-conv="${esc(conv.id)}">
          <img src="${skin(name,50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve',50)}'">
          <span class="fa-chat-row-meta"><strong>${esc(name)}${verified}</strong><small>${esc(preview)}</small></span>
          ${conv.unread_count ? `<span class="fa-chat-pill">${esc(conv.unread_count)}</span>` : `<small>${esc(rel(conv.last_message_at||conv.conversation_last_message_at))}</small>`}
        </button>`;
    }).join('');
  }

  function renderFriends() {
    const isSearching = state.search.trim().length > 0;
    const source = isSearching ? state.people : state.friends;
    const requestRows = isSearching ? [] : state.requests;
    if (state.loadingFriends && !source.length && !requestRows.length) return loadingRows();
    const requestHtml = requestRows.length ? `
      <div class="fa-chat-section-head"><strong>Seguidores recentes</strong></div>
      ${requestRows.map(p => friendRow(p,'follow-back')).join('')}` : '';
    const sectionLabel = isSearching ? 'Resultados' : 'Amigos';
    const listHtml = source.length
      ? source.map(p => friendRow(p, isSearching ? (p.is_friend?'friend':'add') : 'friend')).join('')
      : (isSearching
          ? '<div class="fa-chat-empty"><strong>Ninguém encontrado</strong>Tente buscar por usuário ou nome do Minecraft.</div>'
          : '<div class="fa-chat-empty"><strong>Nenhum amigo ainda</strong>Busque jogadores pelo campo acima.</div>');
    return `${requestHtml}<div class="fa-chat-section-head"><strong>${sectionLabel}</strong></div>${listHtml}`;
  }

  function renderGroups() {
    if (state.groupCreating) return renderGroupCreator();
    const term = state.search.trim().toLowerCase();
    const rows = state.groups.filter(g => {
      const n = groupNameOf(g).toLowerCase(), p = String(g.last_message_body||g.last_sender_name||'').toLowerCase();
      return !term || n.includes(term) || p.includes(term);
    });
    const create = `<button class="fa-chat-new-group" type="button" data-chat-new-group><span>${icons.plus}</span><strong>Novo grupo</strong><small>Converse com vários amigos</small></button>`;
    if (state.loadingGroups && !rows.length) return `${create}${loadingRows()}`;
    if (!rows.length) return `${create}<div class="fa-chat-empty"><strong>Nenhum grupo ainda</strong>Crie um grupo com amigos.</div>`;
    return create + rows.map(group => {
      const name = groupNameOf(group);
      const lastPreview = messagePreviewText(group.last_message_body, group.last_message_attachments);
      const preview = lastPreview ? `${group.last_sender_name||'Alguém'}: ${lastPreview}` : `${Number(group.member_count||0)} membros`;
      return `
        <button class="fa-chat-row ${group.unread_count?'is-unread':''}" type="button" data-chat-group="${esc(group.id)}">
          <span class="fa-chat-group-av">${icons.group}</span>
          <span class="fa-chat-row-meta"><strong>${esc(name)}</strong><small>${esc(preview)}</small></span>
          ${group.unread_count ? `<span class="fa-chat-pill">${esc(group.unread_count)}</span>` : `<small>${esc(rel(group.last_message_at||group.group_last_message_at||group.created_at))}</small>`}
        </button>`;
    }).join('');
  }

  function renderGroupCreator() {
    const selected = new Set(state.groupMemberIds.map(String));
    const source = state.search.trim() ? state.people : state.friends;
    const rows = source.filter(p => !state.me || Number(p.id)!==Number(state.me.id));
    return `
      <form class="fa-chat-group-maker" data-chat-group-form>
        <div class="fa-chat-maker-head">
          <button class="fa-chat-icon-btn" type="button" data-chat-cancel-group aria-label="Voltar">${icons.back}</button>
          <div><strong>Novo grupo</strong><small>${selected.size ? `${selected.size} selecionado${selected.size>1?'s':''}` : 'Escolha pelo menos uma pessoa'}</small></div>
        </div>
        <input class="fa-chat-group-name" data-chat-group-name maxlength="80" placeholder="Nome do grupo" value="${esc(state.groupName)}" autocomplete="off">
        <div class="fa-chat-selected">${selected.size ? state.groupMemberIds.map(id => {
          const p = [...state.friends,...state.people].find(p2=>String(p2.id)===String(id));
          return `<span>${esc(nameOf(p||{username:`#${id}`}))}</span>`;
        }).join('') : '<small>Grupos ajudam a reunir amigos, squads e times.</small>'}</div>
        <div class="fa-chat-member-list">
          ${state.loadingFriends && !rows.length ? loadingRows() : rows.length ? rows.map(p => {
            const name = nameOf(p), checked = selected.has(String(p.id));
            return `<button class="fa-chat-member ${checked?'is-selected':''}" type="button" data-chat-member-toggle="${esc(p.id)}"><img src="${skin(name,50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve',50)}'"><span><strong>${esc(name)}</strong><small>@${esc(handleOf(p))}</small></span><i>${checked?'✓':'+'}</i></button>`;
          }).join('') : '<div class="fa-chat-empty"><strong>Ninguém encontrado</strong>Busque amigos ou perfis públicos.</div>'}
        </div>
        <button class="fa-chat-create" type="submit" ${state.busy||!state.groupName.trim()||!selected.size?'disabled':''}>Criar grupo</button>
      </form>`;
  }

  function friendRow(person, kind) {
    const name = nameOf(person);
    const meta = person.bio || (person.is_online?'Online agora':`${person.rank||'Ferro'} - ${Number(person.followers_count||0).toLocaleString('pt-BR')} seg.`);
    const verified = person.is_platform_verified ? `<span class="fa-chat-verified" title="Verificado"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg></span>` : '';
    let actionHtml = '';
    if (kind==='follow-back') actionHtml = `<span class="fa-chat-pill" data-follow-back>+</span>`;
    else if (kind==='add') {
      const sent = state._sentRequests?.has(String(person.id));
      actionHtml = `<button class="fa-chat-add-btn ${sent?'is-sent':''}" type="button" data-add-friend="${esc(person.id)}" title="${sent?'Solicitação enviada':'Adicionar amigo'}">${sent?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>`}</button>`;
    }
    return `
      <button class="fa-chat-friend" type="button" data-chat-user="${esc(person.id)}" data-chat-name="${esc(name)}">
        <span class="fa-chat-av-wrap">
          <img src="${skin(name,50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve',50)}'">
          ${person.is_online ? '<span class="fa-chat-online-dot"></span>' : ''}
        </span>
        <span class="fa-chat-friend-meta"><strong>${esc(name)}${verified}</strong><small>${esc(meta)}</small></span>
        ${actionHtml}
      </button>`;
  }

  function loadingRows() {
    return Array.from({length:5}, ()=>'<div class="fa-chat-skel"><span></span><i></i><b></b></div>').join('');
  }

  function renderThread() {
    const conv = state.current;
    const isGroup = state.currentKind==='group';
    const name = isGroup ? groupNameOf(conv) : nameOf(conv);
    const isOnline = !isGroup && (conv.is_online || state._peerIsOnline);
    const onlineDot = isOnline ? '<span class="fa-chat-online-dot fa-chat-online-dot--peer"></span>' : '';
    const verified = !isGroup && conv.is_platform_verified ? `<span class="fa-chat-verified" title="Verificado"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg></span>` : '';
    return `
      <div class="fa-chat-thread">
        <div class="fa-chat-peerbar">
          <button class="fa-chat-icon-btn" type="button" data-chat-back aria-label="Voltar">${icons.back}</button>
          ${isGroup
            ? `<span class="fa-chat-peer-av fa-chat-group-av">${icons.group}</span>`
            : `<span class="fa-chat-av-wrap fa-chat-av-wrap--peer"><img class="fa-chat-peer-av" src="${skin(name,50)}" alt="${esc(name)}" onerror="this.onerror=null;this.src='${skin('Steve',50)}'"/>${onlineDot}</span>`
          }
          <div><strong>${esc(name)}${verified}</strong><small>${isGroup?`${Number(conv.member_count||0)} membros`:`@${esc(handleOf(conv))}${isOnline?' · online':conv.is_friend?' · amigo':''}`}</small></div>
          ${isGroup ? '' : `<button class="fa-chat-icon-btn" type="button" data-chat-profile="${esc(conv.other_id)}" aria-label="Ver perfil">${icons.user}</button>`}
          <button class="fa-chat-icon-btn" type="button" data-chat-close aria-label="Fechar">${icons.close}</button>
        </div>
        <div class="fa-chat-messages" data-chat-messages>${renderMessagesContent()}</div>
        <div class="fa-chat-compose-wrap">
          <div class="fa-chat-compose-error" data-chat-compose-error>${state.composeError ? esc(state.composeError) : ''}</div>
          <div class="fa-chat-compose-context" data-chat-compose-context>${renderComposeContext()}</div>
          <div class="fa-chat-attachments-preview" data-chat-attachments-preview>${renderPendingAttachments()}</div>
          <div class="fa-chat-recording-panel" data-chat-recording-panel>${renderRecordingPanel()}</div>
          <div data-chat-char-counter></div>
          <form class="fa-chat-compose" data-chat-form>
            <div class="fa-chat-compose-pill">
              <button class="fa-chat-tool-btn" type="button" data-chat-attach aria-label="Anexar arquivo" title="Anexar arquivo">${icons.attach}</button>
              <button class="fa-chat-tool-btn" type="button" data-chat-camera aria-label="Camera" title="Camera">${icons.camera}</button>
              <textarea data-chat-input maxlength="500" rows="1" placeholder="Mensagem... (↵ para enviar)" aria-label="Mensagem"></textarea>
              <button class="fa-chat-tool-btn fa-chat-mic-btn ${state.recording.active?'is-recording':''}" type="button" data-chat-mic aria-label="Gravar audio" title="Gravar audio">${state.recording.active ? icons.stop : icons.mic}</button>
              <button class="fa-chat-send" type="submit" aria-label="Enviar" ${state.pendingAttachments.length || (state.recording.active && state.recording.locked) ? '' : 'disabled'}>${icons.send}</button>
              <input class="fa-chat-file-input" type="file" data-chat-file-input accept="${esc(CHAT_FILE_ACCEPT)}" multiple hidden>
              <input class="fa-chat-file-input" type="file" data-chat-camera-input accept="image/*,video/*" capture="environment" hidden>
            </div>
          </form>
        </div>
      </div>`;
  }

  function renderMessagesContent() {
    const error = state.error ? `<div class="fa-chat-inline-error"><strong>Erro ao carregar mensagens</strong><span>${esc(state.error)}</span><button type="button" data-chat-reload>Recarregar</button></div>` : '';
    if (state.loadingMessages) return `<div class="fa-chat-message-loading"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Carregando...</span></div>`;
    if (state.error && !state.messages.length) return `${error}<div class="fa-chat-empty"><strong>Histórico indisponível</strong>Use Recarregar ou abra a conversa novamente.</div>`;
    if (!state.messages.length) return `${error}<div class="fa-chat-empty"><strong>Comece a conversa</strong>${state.currentKind==='group'?'As mensagens do grupo ficam aqui.':'Mensagens diretas ficam aqui.'}</div>`;

    let html = error;
    let prevDateLabel = null;
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      const prevMsg = i > 0 ? state.messages[i-1] : null;
      const nextMsg = i < state.messages.length-1 ? state.messages[i+1] : null;
      const samePrev = prevMsg && Number(prevMsg.sender_id)===Number(msg.sender_id) && sameMinute(prevMsg.created_at, msg.created_at);
      const sameNext = nextMsg && Number(nextMsg.sender_id)===Number(msg.sender_id) && sameMinute(msg.created_at, nextMsg.created_at);

      const msgDate = msg.created_at ? new Date(msg.created_at).toLocaleDateString('pt-BR') : null;
      if (msgDate && msgDate !== prevDateLabel) {
        prevDateLabel = msgDate;
        const sepId = `datesep-${msgDate.replace(/\//g,'-')}`;
        html += `<div class="fa-chat-date-sep" data-date-sep="${esc(sepId)}"><span>${esc(formatDatePill(msg.created_at))}</span></div>`;
      }
      html += renderMessage(msg, !samePrev, !sameNext);
    }
    return html;
  }

  function formatDuration(seconds = 0) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function renderRecordingPanel() {
    if (!state.recording.active) return '';
    const lockHint = state.recording.locked ? 'Gravacao travada' : 'Solte para enviar · arraste para cima para travar';
    return `
      <div class="fa-chat-recording ${state.recording.locked ? 'is-locked' : ''}">
        <span class="fa-chat-recording-dot"></span>
        <strong>${formatDuration(state.recording.elapsed)}</strong>
        <small>${esc(lockHint)}</small>
        <button type="button" data-chat-record-cancel aria-label="Cancelar gravacao">Cancelar</button>
      </div>`;
  }

  function messageAuthorName(message = {}) {
    if (Number(message.sender_id) === Number(state.me?.id)) return 'Voce';
    return message.minecraft_name || message.username || message.reply_to?.sender_name || 'Jogador';
  }

  function messageSummary(message = {}) {
    return String(message.body || attachmentPreviewText(messageAttachments(message)) || 'Mensagem').replace(/\s+/g, ' ').slice(0, 110);
  }

  function renderComposeContext() {
    const target = state.editingMessage || state.replyTo;
    if (!target) return '';
    const editing = Boolean(state.editingMessage);
    return `<div class="fa-chat-context-card ${editing ? 'is-editing' : 'is-replying'}">
      <span class="fa-chat-context-icon">${editing ? '✎' : '↩'}</span>
      <span class="fa-chat-context-copy"><strong>${editing ? 'Editando mensagem' : `Respondendo a ${esc(messageAuthorName(target))}`}</strong><small>${esc(messageSummary(target))}</small></span>
      <button type="button" data-chat-context-cancel aria-label="Cancelar">${icons.close}</button>
    </div>`;
  }

  function updateComposeContext() {
    const context = root.querySelector('[data-chat-compose-context]');
    if (context) context.innerHTML = renderComposeContext();
    root.querySelector('.fa-chat-compose-wrap')?.classList.toggle('has-context', Boolean(state.replyTo || state.editingMessage));
  }

  function renderPendingAttachments() {
    if (!state.pendingAttachments.length) return '';
    return state.pendingAttachments.map(att => {
      const url = att.preview_url || att.url || '';
      const thumb = att.type === 'image' && url
        ? `<img src="${esc(url)}" alt="${esc(att.name)}">`
        : att.type === 'video' && url
          ? `<video src="${esc(url)}" muted playsinline></video>`
          : `<span class="fa-chat-attach-kind">${esc(att.type === 'pdf' ? 'PDF' : 'FILE')}</span>`;
      return `
        <div class="fa-chat-pending-attachment" data-chat-pending-id="${esc(att.id)}" title="${esc(att.name)}">
          ${thumb}
          <span>${esc(att.name)}</span>
          <button type="button" data-chat-attachment-remove="${esc(att.id)}" aria-label="Remover anexo" title="Remover">${icons.trash}</button>
        </div>`;
    }).join('');
  }

  /* ── Waveform sintético decorativo (20 barras com alturas pseudo-aleatórias) ──
     Gerado deterministicamente a partir do nome do arquivo para ser consistente
     entre renders, sem precisar de dados reais de análise de áudio. */
  function syntheticWaveform(seed = '', bars = 20) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    return Array.from({ length: bars }, (_, i) => {
      h = (Math.imul(1664525, h) + 1013904223) | 0;
      const pct = 20 + ((h >>> 0) % 68); // 20–88%
      return `<span style="height:${pct}%"></span>`;
    }).join('');
  }

  /* ── Player de áudio customizado ──────────────────────────────────────────────
     Renderiza HTML; initAudioPlayer() conecta a lógica depois de inserir no DOM.
     NOTA: o botão de download usa data-audio-dl (não <a href download>) para evitar
     que o browser dispare download automático em URLs do Cloudinary sem extensão
     (application/octet-stream). O click é interceptado em initAudioPlayer() e
     chama downloadAttachment() manualmente. */
  function renderAudioPlayer(att, isMe) {
    const url = att.url || '';
    const name = att.name || 'Áudio';
    // Duração armazenada (em segundos) ou null
    const knownDur = att.duration ? Math.round(Number(att.duration)) : null;
    const durLabel = knownDur ? formatDuration(knownDur) : '0:00';
    const wf = syntheticWaveform(name);
    const hasDl = Boolean(url && !url.startsWith('blob:'));
    return `
      <div class="fa-chat-audio-player ${isMe ? 'is-me' : ''}" data-audio-player data-audio-src="${esc(url)}" data-audio-name="${esc(name)}" data-audio-mime="${esc(att.mime_type || '')}">
        <button class="fa-cap-play" type="button" data-audio-play aria-label="Reproduzir áudio">
          <svg class="fa-cap-icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>
          <svg class="fa-cap-icon-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <div class="fa-cap-body">
          <div class="fa-cap-waveform" data-audio-waveform aria-hidden="true">${wf}</div>
          <div class="fa-cap-progress-track" data-audio-track>
            <div class="fa-cap-progress-fill" data-audio-fill style="width:0%"></div>
            <div class="fa-cap-progress-thumb" data-audio-thumb style="left:0%"></div>
          </div>
          <div class="fa-cap-foot">
            <span class="fa-cap-time" data-audio-time>0:00</span>
            <button class="fa-cap-speed" type="button" data-audio-speed aria-label="Velocidade de reprodução" title="Velocidade">1×</button>
            <span class="fa-cap-dur" data-audio-dur>${esc(durLabel)}</span>
            ${hasDl ? `<button class="fa-cap-dl" type="button" data-audio-dl="${esc(url)}" data-audio-dl-name="${esc(name)}" title="Baixar áudio" aria-label="Baixar áudio">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M5 16l7 5 7-5"/><path d="M3 20h18"/></svg>
            </button>` : ''}
          </div>
        </div>
      </div>`;
  }

  // Ciclo de velocidades do player de áudio
  const AUDIO_SPEEDS = [1, 1.5, 2];
  function nextSpeed(current) {
    const idx = AUDIO_SPEEDS.indexOf(current);
    return AUDIO_SPEEDS[(idx + 1) % AUDIO_SPEEDS.length];
  }
  function speedLabel(speed) {
    return speed === 1 ? '1×' : speed === 1.5 ? '1.5×' : '2×';
  }

  /* ── Inicializa player de áudio num nó já no DOM ──────────────────────────── */
  function initAudioPlayer(playerEl) {
    if (!playerEl || playerEl._audioInited) return;
    playerEl._audioInited = true;

    const src        = playerEl.dataset.audioSrc;
    const mimeHint   = playerEl.dataset.audioMime || '';
    if (!src) return;

    const audio = new Audio();
    audio.preload = 'none';

    // ── Resolução de MIME para Cloudinary raw ─────────────────────────────────
    // O Cloudinary resource_type:'raw' serve SEMPRE Content-Type: application/octet-stream,
    // mesmo com extensão na URL (ex: audio-1234.webm). Isso faz o browser disparar
    // download automático ao setar audio.src = url diretamente.
    //
    // Solução: ao primeiro play, fazemos fetch() da URL com mode:'cors' e criamos
    // um Blob URL com o MIME correto deduzido da extensão ou do campo mime_type
    // salvo no dataset. O browser toca o Blob URL sem disparar download.
    //
    // Se o fetch falhar por CORS (blob: URLs nunca têm CORS), usamos src direto
    // como fallback — nesse caso o browser pode ou não disparar download dependendo
    // da configuração de CORS do Cloudinary da conta.
    let blobUrl      = null;   // blob: URL criado via fetch
    let srcReady     = false;  // true quando audio.src já foi setado
    let loadingBlob  = false;  // fetch em andamento

    function guessMime(url = '', hint = '') {
      if (hint && hint !== 'application/octet-stream') return hint;
      const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
      return { webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg',
               opus: 'audio/ogg;codecs=opus', mp4: 'audio/mp4',
               m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg',
               wav: 'audio/wav' }[ext] || 'audio/webm';
    }

    async function ensureSrc() {
      if (srcReady) return;
      if (loadingBlob) return;
      // Blob: URLs (preview de gravação local) → setar direto, sem fetch
      if (src.startsWith('blob:')) {
        audio.src = src;
        srcReady = true;
        return;
      }
      loadingBlob = true;
      playerEl.classList.add('is-loading');
      try {
        const res = await fetch(src, { mode: 'cors', cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const mime = guessMime(src, mimeHint);
        const blob = new Blob([arrayBuffer], { type: mime });
        blobUrl = URL.createObjectURL(blob);
        audio.src = blobUrl;
        srcReady = true;
      } catch {
        // Fallback: tenta direto — pode funcionar se o Cloudinary estiver configurado
        // para servir o Content-Type correto via transformação fl_attachment:false
        audio.src = src;
        srcReady = true;
      } finally {
        loadingBlob = false;
        playerEl.classList.remove('is-loading');
      }
    }

    let currentSpeed = 1;

    const playBtn  = playerEl.querySelector('[data-audio-play]');
    const trackEl  = playerEl.querySelector('[data-audio-track]');
    const fillEl   = playerEl.querySelector('[data-audio-fill]');
    const thumbEl  = playerEl.querySelector('[data-audio-thumb]');
    const timeEl   = playerEl.querySelector('[data-audio-time]');
    const durEl    = playerEl.querySelector('[data-audio-dur]');
    const wfEl     = playerEl.querySelector('[data-audio-waveform]');
    const speedBtn = playerEl.querySelector('[data-audio-speed]');
    const dlBtn    = playerEl.querySelector('[data-audio-dl]');

    function setPlaying(v) { playerEl.classList.toggle('is-playing', v); }

    function updateProgress() {
      if (!audio.duration || !isFinite(audio.duration)) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      if (fillEl)  fillEl.style.width  = `${pct}%`;
      if (thumbEl) thumbEl.style.left  = `${pct}%`;
      if (timeEl)  timeEl.textContent  = formatDuration(Math.floor(audio.currentTime));
      if (wfEl) {
        const spans = wfEl.querySelectorAll('span');
        const prog  = Math.round((pct / 100) * spans.length);
        spans.forEach((s, i) => s.classList.toggle('played', i < prog));
      }
    }

    // Botão de velocidade 1× → 1.5× → 2× → 1×
    speedBtn?.addEventListener('click', e => {
      e.stopPropagation();
      currentSpeed = nextSpeed(currentSpeed);
      audio.playbackRate = currentSpeed;
      speedBtn.textContent = speedLabel(currentSpeed);
      speedBtn.classList.toggle('is-active', currentSpeed !== 1);
    });

    // Botão de download — chama downloadAttachment() para evitar href direto
    // (que dispararia download automático via octet-stream)
    dlBtn?.addEventListener('click', e => {
      e.stopPropagation();
      const dlUrl  = dlBtn.dataset.audioDl;
      const dlName = dlBtn.dataset.audioDlName;
      if (dlUrl) downloadAttachment(dlUrl, dlName);
    });

    function seekTo(e) {
      if (!audio.duration || !isFinite(audio.duration)) return;
      const rect   = trackEl.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const ratio  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
      updateProgress();
    }

    audio.addEventListener('loadedmetadata', () => {
      if (durEl && audio.duration && isFinite(audio.duration))
        durEl.textContent = formatDuration(Math.floor(audio.duration));
    });
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', () => { setPlaying(false); audio.currentTime = 0; updateProgress(); });
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('play',  () => setPlaying(true));
    audio.addEventListener('error', () => { playerEl.classList.add('has-error'); });

    playBtn?.addEventListener('click', async e => {
      e.stopPropagation();
      // Para qualquer outro player ativo
      root.querySelectorAll('[data-audio-player].is-playing').forEach(el => {
        if (el !== playerEl && el._audioEl) el._audioEl.pause();
      });
      if (!srcReady) {
        await ensureSrc();
        audio.play().catch(() => {});
        return;
      }
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });

    // Seek
    trackEl?.addEventListener('click', e => { e.stopPropagation(); if (srcReady) seekTo(e); });
    let _dragging = false;
    trackEl?.addEventListener('mousedown', e => {
      if (!srcReady) return;
      _dragging = true; seekTo(e);
      const onMove = ev => { if (_dragging) seekTo(ev); };
      const onUp   = () => { _dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    trackEl?.addEventListener('touchstart', e => { if (srcReady) seekTo(e); }, { passive: true });
    trackEl?.addEventListener('touchmove',  e => { if (srcReady) seekTo(e); }, { passive: true });

    playerEl._audioEl  = audio;
    playerEl._blobUrl  = () => blobUrl;
    playerEl._revoke   = () => { if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; } };
  }

  /* ── Inicializa todos os players num container ────────────────────────────── */
  function initAudioPlayers(container) {
    container.querySelectorAll('[data-audio-player]').forEach(initAudioPlayer);
  }

  function socialTargetFromUrl(rawUrl = '') {
    try {
      const parsed = new URL(rawUrl, location.href);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      const allowedHosts = new Set([location.host, ...bases.map(base => {
        try { return new URL(base).host; } catch { return ''; }
      }).filter(Boolean)]);
      if (!allowedHosts.has(parsed.host)) return null;

      const postPath = parsed.pathname.match(/\/share\/post\/(\d+)\/?$/i);
      const commentPath = parsed.pathname.match(/\/share\/comment\/(\d+)\/?$/i);
      const postQuery = parsed.searchParams.get('post')
        || (/(?:^|\/)post\.html$/i.test(parsed.pathname) ? parsed.searchParams.get('id') : '');
      if (postPath?.[1] || /^\d+$/.test(String(postQuery || ''))) {
        return { kind: 'post', id: String(postPath?.[1] || postQuery) };
      }
      if (commentPath?.[1]) return { kind: 'comment', id: String(commentPath[1]) };
    } catch {}
    return null;
  }

  function messageUrls(body = '') {
    return [...String(body || '').matchAll(/https?:\/\/[^\s<>"']+/gi)]
      .map(match => match[0].replace(/[),.;!?]+$/g, ''))
      .filter(Boolean);
  }

  function renderMessageBody(body = '') {
    const text = String(body || '');
    if (!text) return '';
    const re = /https?:\/\/[^\s<>"']+/gi;
    let html = '';
    let cursor = 0;
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      const index = match.index || 0;
      const cleanUrl = raw.replace(/[),.;!?]+$/g, '');
      const suffix = raw.slice(cleanUrl.length);
      html += esc(text.slice(cursor, index));
      const target = socialTargetFromUrl(cleanUrl);
      if (target) {
        const label = target.kind === 'post' ? 'Abrir postagem' : 'Abrir comentario';
        html += `<a class="fa-chat-message-link is-internal" href="${esc(cleanUrl)}" data-chat-open-${target.kind}="${esc(target.id)}">${esc(label)}</a>${esc(suffix)}`;
      } else {
        html += `<a class="fa-chat-message-link" href="${esc(cleanUrl)}" target="_blank" rel="noopener noreferrer">${esc(cleanUrl)}</a>${esc(suffix)}`;
      }
      cursor = index + raw.length;
    }
    html += esc(text.slice(cursor));
    return html;
  }

  function renderInternalSocialPreviews(body = '') {
    const seen = new Set();
    const targets = messageUrls(body).map(socialTargetFromUrl).filter(Boolean).filter(target => {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 2);
    if (!targets.length) return '';
    return `<div class="fa-chat-social-previews">${targets.map(target => `
      <div class="fa-chat-social-preview is-loading" data-chat-social-preview="${target.kind}:${esc(target.id)}">
        <span class="fa-chat-social-preview-shimmer"></span>
        <span class="fa-chat-social-preview-shimmer is-short"></span>
      </div>`).join('')}</div>`;
  }

  function isInternalSocialLinkOnly(body = '') {
    const text = String(body || '').trim();
    const urls = messageUrls(text);
    if (urls.length !== 1 || !socialTargetFromUrl(urls[0])) return false;
    return text.replace(urls[0], '').trim() === '';
  }

  function socialPreviewAuthor(row = {}) {
    return row.display_name || row.minecraft_name || row.username || 'Jogador';
  }

  function renderSocialPreviewCard(kind, payload = {}) {
    if (kind === 'comment') {
      const comment = payload.root_comment || {};
      const post = payload.original_post || {};
      const author = socialPreviewAuthor(comment);
      return `
        <button class="fa-chat-social-card fa-chat-social-card--comment" type="button" data-chat-open-post="${esc(comment.post_id || post.id || '')}">
          <span class="fa-chat-social-card-brand">Forca Aliada · comentario</span>
          <span class="fa-chat-social-card-author"><img src="${skin(comment.minecraft_name || comment.username || 'Steve', 50)}" alt=""><strong>${esc(author)}</strong><small>@${esc(comment.username || comment.minecraft_name || 'jogador')}</small></span>
          <span class="fa-chat-social-card-text">${esc(comment.content || 'Comentario da comunidade')}</span>
          <span class="fa-chat-social-card-context">${esc(String(post.content || 'Abrir conversa completa').slice(0, 120))}</span>
        </button>`;
    }

    const post = payload || {};
    const author = socialPreviewAuthor(post);
    const media = (Array.isArray(post.media_urls) ? post.media_urls : []).filter(Boolean).slice(0, 4);
    const mediaHTML = media.length ? `<span class="fa-chat-social-card-media media-count-${media.length}">${media.map((url, index) => `<img src="${esc(url)}" alt="Imagem ${index + 1} da postagem" loading="lazy">`).join('')}</span>` : '';
    return `
      <button class="fa-chat-social-card ${media.length ? 'has-media' : 'no-media'}" type="button" data-chat-open-post="${esc(post.id || '')}">
        <span class="fa-chat-social-card-main">
          <span class="fa-chat-social-card-brand">Forca Aliada · postagem</span>
          <span class="fa-chat-social-card-author"><img src="${skin(post.minecraft_name || post.username || 'Steve', 50)}" alt=""><strong>${esc(author)}</strong><small>@${esc(post.username || post.minecraft_name || 'jogador')}</small></span>
          ${post.content ? `<span class="fa-chat-social-card-text">${esc(post.content)}</span>` : ''}
        </span>
        ${mediaHTML}
        <span class="fa-chat-social-card-stats">${Number(post.likes_count || 0).toLocaleString('pt-BR')} curtidas · ${Number(post.comments_count || 0).toLocaleString('pt-BR')} comentarios</span>
      </button>`;
  }

  function socialPreviewError(kind, id) {
    return `<button class="fa-chat-social-card is-unavailable" type="button" data-chat-open-${kind}="${esc(id)}"><strong>Conteudo indisponivel</strong><small>Abrir na comunidade</small></button>`;
  }

  async function loadSocialPreview(kind, id) {
    const key = `${kind}:${id}`;
    if (state._socialPreviewCache.has(key)) return state._socialPreviewCache.get(key);
    if (state._socialPreviewPending.has(key)) return state._socialPreviewPending.get(key);
    const pending = api(kind === 'post'
      ? `/api/community/posts/${encodeURIComponent(id)}`
      : `/api/community/comments/${encodeURIComponent(id)}/thread`
    ).then(data => {
      state._socialPreviewCache.set(key, data);
      return data;
    }).finally(() => state._socialPreviewPending.delete(key));
    state._socialPreviewPending.set(key, pending);
    return pending;
  }

  function hydrateInternalPreviews(container) {
    container.querySelectorAll('[data-chat-social-preview]').forEach(async preview => {
      if (preview.dataset.previewReady === '1') return;
      preview.dataset.previewReady = '1';
      const [kind, id] = String(preview.dataset.chatSocialPreview || '').split(':');
      if (!kind || !id) return;
      try {
        const data = await loadSocialPreview(kind, id);
        if (!preview.isConnected) return;
        preview.className = 'fa-chat-social-preview';
        preview.innerHTML = renderSocialPreviewCard(kind, data);
      } catch {
        if (!preview.isConnected) return;
        preview.className = 'fa-chat-social-preview';
        preview.innerHTML = socialPreviewError(kind, id);
      }
    });
  }

  function initMessageEnhancements(container) {
    if (!container) return;
    initAudioPlayers(container);
    initLazyVideos(container);
    hydrateInternalPreviews(container);
  }

  function initLazyVideos(container) {
    container.querySelectorAll('[data-chat-video-src]').forEach(video => {
      if (video.dataset.videoReady === '1') return;
      const activate = () => {
        if (video.dataset.videoReady === '1') return;
        const src = video.dataset.chatVideoSrc;
        if (!src) return;
        video.dataset.videoReady = '1';
        video.src = src;
        video.load();
        video.play().catch(() => {});
      };
      video.addEventListener('click', activate, { once: true });
      video.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') activate();
      }, { once: true });
    });
  }

  function renderMessageAttachments(attachments = [], isMe = false) {
    if (!attachments.length) return '';
    return `<div class="fa-chat-media-grid">${attachments.map((att, idx) => {
      const url = att.preview_url || att.url || '';
      const name = att.name || attachmentPreviewText([att]) || 'Arquivo';
      const size = formatFileSize(att.size);
      const menu = renderAttachmentMenu(att, idx);
      if (att.type === 'image' && url) {
        return `<div class="fa-chat-attachment fa-chat-attachment--image" data-chat-attachment><button class="fa-chat-image-open" type="button" data-chat-image-open="${esc(url)}" data-chat-image-name="${esc(name)}" aria-label="Ver imagem em tela cheia"><img class="fa-chat-media-img" src="${esc(url)}" alt="${esc(name)}" loading="lazy"></button>${menu}</div>`;
      }
      if (att.type === 'video' && url) {
        return `<div class="fa-chat-attachment fa-chat-attachment--video" data-chat-attachment><video class="fa-chat-media-video" data-chat-video-src="${esc(url)}" controls preload="none" playsinline tabindex="0" aria-label="Reproduzir ${esc(name)}"></video>${menu}</div>`;
      }
      if (att.type === 'audio') {
        // Player customizado — sem <audio controls> nativo, sem menu de download via fetch
        return `<div class="fa-chat-attachment fa-chat-attachment--audio" data-chat-attachment>${renderAudioPlayer(att, isMe)}</div>`;
      }
      if (att.type === 'pdf' && url) {
        return `<div class="fa-chat-attachment fa-chat-attachment--pdf" data-chat-attachment><div class="fa-chat-pdf-card"><span class="fa-chat-pdf-icon">PDF</span><span class="fa-chat-file-meta"><strong>${esc(name)}</strong><small>${esc(['Documento PDF', size].filter(Boolean).join(' · '))}</small></span><button class="fa-chat-pdf-download" type="button" data-chat-download-url="${esc(url)}" data-chat-download-name="${esc(name)}" aria-label="Baixar PDF">${icons.download}<span>Baixar</span></button></div></div>`;
      }
      return `
        <div class="fa-chat-attachment fa-chat-attachment--file" data-chat-attachment><div class="fa-chat-file-card">
          <span class="fa-chat-file-icon">${att.type === 'pdf' ? 'PDF' : icons.file}</span>
          <span class="fa-chat-file-meta"><strong>${esc(name)}</strong><small>${esc([att.type === 'pdf' ? 'PDF' : 'Arquivo', size].filter(Boolean).join(' - '))}</small></span>
        </div>${menu}</div>`;
    }).join('')}</div>`;
  }

  function renderAttachmentMenu(att, idx = 0) {
    const url = att.preview_url || att.url || '';
    const name = att.name || attachmentPreviewText([att]) || 'arquivo';
    // Áudio tem download inline no próprio player — não precisa de menu separado
    if (!url || url.startsWith('blob:') || att.type === 'audio' || att.type === 'pdf') return '';
    return `
      <button class="fa-chat-attach-menu-btn" type="button" data-chat-attachment-menu="${esc(idx)}" aria-label="Opcoes do anexo" title="Opcoes">${icons.more}</button>
      <div class="fa-chat-attach-menu" role="menu">
        <button type="button" data-chat-download-url="${esc(url)}" data-chat-download-name="${esc(name)}" role="menuitem">${icons.download}<span>Baixar</span></button>
      </div>`;
  }

  function renderReplyPreview(message = {}) {
    const reply = message.reply_to;
    if (!reply) return '';
    return `<button class="fa-chat-reply-preview" type="button" data-chat-jump-message="${esc(reply.id || '')}">
      <strong>${esc(reply.sender_name || 'Mensagem')}</strong>
      <span>${esc(String(reply.body || 'Mensagem removida').replace(/\s+/g, ' ').slice(0, 110))}</span>
    </button>`;
  }

  function renderMessageReactions(message = {}) {
    const mine = new Set(Array.isArray(message.my_reactions) ? message.my_reactions : []);
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    if (!reactions.length) return '';
    return `<div class="fa-chat-message-reactions">${reactions.map(reaction => `<button type="button" class="${mine.has(reaction.emoji) ? 'is-mine' : ''}" data-chat-message-react="${esc(reaction.emoji)}" data-msg-id="${esc(message.id)}"><span>${esc(reaction.emoji)}</span><b>${Number(reaction.count || 0)}</b></button>`).join('')}</div>`;
  }

  function renderMessageQuickActions(message = {}, isMe = false) {
    if (message.is_deleted || String(message.id).startsWith('tmp-')) return '';
    return `<div class="fa-chat-message-quick-actions" aria-label="Acoes da mensagem">
      <button type="button" data-chat-message-reply="${esc(message.id)}" aria-label="Responder" title="Responder">↩</button>
      <button type="button" data-chat-message-heart="${esc(message.id)}" aria-label="Curtir" title="Curtir">♡</button>
      <button type="button" data-chat-message-menu="${esc(message.id)}" aria-label="Mais opcoes" title="Mais opcoes">${icons.more}</button>
      ${isMe ? `<button type="button" data-chat-message-edit="${esc(message.id)}" aria-label="Editar" title="Editar">✎</button>` : ''}
    </div>`;
  }

  function renderMessage(message, isGroupFirst=true, isGroupLast=true) {
    const isMe = Number(message.sender_id) === Number(state.me?.id);
    const sender = message.minecraft_name || message.username || 'Steve';
    const clientClass = message.client_status ? `is-${esc(message.client_status)}` : '';
    const groupClasses = [isGroupFirst?'is-group-first':'is-grouped', isGroupLast?'is-group-last':''].filter(Boolean).join(' ');
    const failAlert = message.client_status==='failed' ? `<button class="fa-chat-fail-alert" data-chat-retry="${esc(message.id)}" title="Tentar reenviar">⚠</button>` : '';
    const showAvatar = !isMe;
    const avatarHTML = showAvatar
      ? `<img class="fa-chat-bubble-av" src="${skin(sender,50)}" alt="${esc(sender)}" onerror="this.onerror=null;this.src='${skin('Steve',50)}'" style="visibility:${isGroupFirst?'visible':'hidden'}">`
      : `<span class="fa-chat-bubble-av-spacer"></span>`;
    const showName = state.currentKind==='group' && !isMe && isGroupFirst;
    const nameHTML = showName ? `<span class="fa-chat-bubble-name">${esc(sender)}</span>` : '';
    // Tick fica DENTRO da bubble, após o conteúdo, na linha do timestamp (modelo WhatsApp)
    const tickHTML = isMe ? renderTick(message) : '';
    const attachmentsHTML = renderMessageAttachments(messageAttachments(message), isMe);
    const previewHTML = message.body ? renderInternalSocialPreviews(message.body) : '';
    const socialOnly = Boolean(previewHTML && isInternalSocialLinkOnly(message.body));
    const bodyHTML = message.body ? `${socialOnly ? '' : `<span class="fa-chat-bubble-body">${renderMessageBody(message.body)}</span>`}${previewHTML}` : '';
    const replyHTML = renderReplyPreview(message);
    const editedHTML = message.edited_at && !message.is_deleted ? '<span class="fa-chat-edited">editada</span>' : '';
    const reactionsHTML = renderMessageReactions(message);
    const quickActionsHTML = renderMessageQuickActions(message, isMe);

    return `
      <div class="fa-chat-bubble-row ${isMe?'is-me':''} ${clientClass} ${groupClasses}" data-msg-id="${esc(String(message.id))}">
        <span class="fa-chat-swipe-reply" aria-hidden="true">↩</span>
        ${!isMe ? avatarHTML : ''}
        <div class="fa-chat-bubble-wrap">
          ${failAlert}
          ${quickActionsHTML}
          <div class="fa-chat-bubble ${isGroupFirst?'has-tail':''} ${socialOnly?'is-social-only':''}">${nameHTML}${replyHTML}${attachmentsHTML}${bodyHTML}<span class="fa-chat-meta-row">${editedHTML}<time>${esc(msgTimeText(message))}</time>${tickHTML}</span></div>
          ${reactionsHTML}
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

  // ── Compose: auto-resize + Enter/Shift+Enter ──────────────────────────────────
  function setComposeError(message = '') {
    state.composeError = String(message || '');
    const el = root.querySelector('[data-chat-compose-error]');
    if (el) el.textContent = state.composeError;
  }

  function updateSendButtonState() {
    const textarea = root.querySelector('[data-chat-input]');
    const send = root.querySelector('.fa-chat-send');
    if (!send) return;
    const hasBody = Boolean(textarea?.value.trim());
    const canSendRecording = state.recording.active && state.recording.locked;
    send.disabled = !state.current || (!hasBody && !state.pendingAttachments.length && !canSendRecording);
  }

  function updateComposeAttachments() {
    const box = root.querySelector('[data-chat-attachments-preview]');
    if (box) box.innerHTML = renderPendingAttachments();
    updateSendButtonState();
  }

  function addPendingFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const next = state.pendingAttachments.slice();
    const errors = [];

    for (const file of files) {
      if (next.length >= CHAT_MAX_ATTACHMENTS) {
        errors.push('Envie no maximo 4 anexos por mensagem.');
        break;
      }
      const kind = attachmentKindFromType(file.type, file.name);
      if (!kind) {
        errors.push(`${cleanFileName(file.name)} nao e um tipo permitido.`);
        continue;
      }
      if (file.size > CHAT_MAX_ATTACHMENT_BYTES) {
        errors.push(`${cleanFileName(file.name)} passa de 25MB.`);
        continue;
      }
      const previewUrl = ['image', 'video'].includes(kind) ? URL.createObjectURL(file) : '';
      next.push({
        id: `att-${Date.now()}-${++attachmentSeq}`,
        file,
        type: kind,
        name: cleanFileName(file.name),
        mime_type: file.type || '',
        size: file.size || 0,
        preview_url: previewUrl,
      });
    }

    state.pendingAttachments = next;
    setComposeError(errors[0] || '');
    updateComposeAttachments();
  }

  function removePendingAttachment(id) {
    const item = state.pendingAttachments.find(att => String(att.id) === String(id));
    if (item) releaseAttachmentPreviews([item]);
    state.pendingAttachments = state.pendingAttachments.filter(att => String(att.id) !== String(id));
    if (!state.pendingAttachments.length) setComposeError('');
    updateComposeAttachments();
  }

  function clearPendingAttachments() {
    if (state.recording.active) finishAudioRecording({ send: false }).catch(() => {});
    releaseAttachmentPreviews(state.pendingAttachments);
    state.pendingAttachments = [];
    setComposeError('');
    updateComposeAttachments();
  }

  function preferredAudioMimeType() {
    const options = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    return options.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
  }

  function audioExtension(mimeType = '') {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
    return 'webm';
  }

  function updateRecordingUI() {
    const panel = root.querySelector('[data-chat-recording-panel]');
    if (panel) panel.innerHTML = renderRecordingPanel();
    const mic = root.querySelector('[data-chat-mic]');
    if (mic) {
      mic.classList.toggle('is-recording', state.recording.active);
      mic.innerHTML = state.recording.active ? icons.stop : icons.mic;
    }
    root.querySelector('.fa-chat-compose-wrap')?.classList.toggle('is-recording', state.recording.active);
    updateSendButtonState();
  }

  async function startAudioRecording({ pointerId = null, startY = 0 } = {}) {
    if (state.recording.active) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setComposeError('Gravacao de audio indisponivel neste navegador.');
      return;
    }
    if (!state.current) return;
    if (pointerId === null) {
      recordingState.pointerReleased = false;
      recordingState.cancelOnStart = false;
      recordingState.lockOnStart = false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingState.recorder = recorder;
      recordingState.stream = stream;
      recordingState.chunks = [];
      recordingState.mimeType = recorder.mimeType || mimeType || 'audio/webm';
      recordingState.pointerId = pointerId;
      recordingState.startY = startY;
      recordingState.startedAt = Date.now();

      recorder.addEventListener('dataavailable', event => {
        if (event.data?.size) recordingState.chunks.push(event.data);
      });

      recorder.start();
      state.recording = { active: true, locked: Boolean(recordingState.lockOnStart), elapsed: 0, error: '' };
      setComposeError('');
      updateRecordingUI();
      recordingState.timer = setInterval(() => {
        state.recording.elapsed = Math.max(0, Math.floor((Date.now() - recordingState.startedAt) / 1000));
        updateRecordingUI();
      }, 250);
      if (recordingState.cancelOnStart) {
        await finishAudioRecording({ send: false });
      } else if (recordingState.pointerReleased && !state.recording.locked) {
        await finishAudioRecording({ send: true });
      }
    } catch (err) {
      stopRecordingTracks();
      recordingState.recorder = null;
      recordingState.pointerId = null;
      recordingState.pointerReleased = false;
      recordingState.cancelOnStart = false;
      recordingState.lockOnStart = false;
      setComposeError(err?.name === 'NotAllowedError' ? 'Permita o microfone para gravar audio.' : 'Nao foi possivel iniciar a gravacao.');
    }
  }

  function stopRecordingTracks() {
    clearInterval(recordingState.timer);
    recordingState.timer = null;
    recordingState.stream?.getTracks?.().forEach(track => track.stop());
    recordingState.stream = null;
  }

  function lockAudioRecording() {
    if (!state.recording.active || state.recording.locked) return;
    state.recording.locked = true;
    updateRecordingUI();
  }

  function finishAudioRecording({ send = true } = {}) {
    if (!state.recording.active || !recordingState.recorder) return Promise.resolve();
    const recorder = recordingState.recorder;
    const currentConv = state.current;
    const currentKind = state.currentKind;
    const currentMe = state.me;
    const duration = state.recording.elapsed;

    return new Promise(resolve => {
      recorder.addEventListener('stop', () => {
        stopRecordingTracks();
        const chunks = recordingState.chunks.slice();
        const mimeType = recordingState.mimeType || 'audio/webm';
        recordingState.recorder = null;
        recordingState.chunks = [];
        recordingState.pointerId = null;
        recordingState.pointerReleased = false;
        recordingState.cancelOnStart = false;
        recordingState.lockOnStart = false;
        state.recording = { active: false, locked: false, elapsed: 0, error: '' };
        updateRecordingUI();

        if (send && chunks.length && currentConv && currentKind && currentMe) {
          const blob = new Blob(chunks, { type: mimeType });
          const ext = audioExtension(mimeType);
          const name = `audio-${Date.now()}.${ext}`;
          const file = new File([blob], name, { type: mimeType });
          const previewUrl = URL.createObjectURL(blob);
          queueSend({
            body: '',
            attachments: [{
              id: `att-${Date.now()}-${++attachmentSeq}`,
              file,
              type: 'audio',
              name,
              mime_type: mimeType,
              size: file.size,
              duration,
              preview_url: previewUrl,
            }],
            currentConv,
            currentKind,
            currentMe,
          });
        }
        resolve();
      }, { once: true });

      if (recorder.state !== 'inactive') recorder.stop();
      else {
        stopRecordingTracks();
        recordingState.recorder = null;
        recordingState.chunks = [];
        recordingState.pointerId = null;
        recordingState.pointerReleased = false;
        recordingState.cancelOnStart = false;
        recordingState.lockOnStart = false;
        state.recording = { active: false, locked: false, elapsed: 0, error: '' };
        updateRecordingUI();
        resolve();
      }
    });
  }

  function closeAttachmentMenus(except = null) {
    root.querySelectorAll('.fa-chat-attachment.is-menu-open').forEach(node => {
      if (node !== except) node.classList.remove('is-menu-open');
    });
  }

  function toggleAttachmentMenu(button) {
    const attachment = button?.closest('[data-chat-attachment]');
    if (!attachment) return;
    const willOpen = !attachment.classList.contains('is-menu-open');
    closeAttachmentMenus(attachment);
    attachment.classList.toggle('is-menu-open', willOpen);
  }

  async function downloadAttachment(url, name) {
    const safeName = cleanFileName(name || 'arquivo');
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = safeName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.download = safeName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  }

  let chatViewer = null;
  let chatViewerItems = [];
  let chatViewerIndex = 0;
  let chatViewerScale = 1;
  let chatViewerSwipeX = null;

  function currentConversationImages() {
    return state.messages.flatMap(message => messageAttachments(message)
      .filter(att => att.type === 'image' && (att.preview_url || att.url))
      .map(att => ({
        url: att.preview_url || att.url,
        name: att.name || 'Imagem',
        sender: message.minecraft_name || message.username || '',
      })));
  }

  function ensureChatViewer() {
    if (chatViewer?.isConnected) return chatViewer;
    chatViewer = document.createElement('div');
    chatViewer.className = 'fa-chat-viewer';
    chatViewer.setAttribute('aria-hidden', 'true');
    chatViewer.innerHTML = `
      <div class="fa-chat-viewer-bg" data-chat-viewer-close></div>
      <div class="fa-chat-viewer-topbar">
        <div><strong data-chat-viewer-title>Imagem</strong><small data-chat-viewer-count></small></div>
        <div class="fa-chat-viewer-tools">
          <button type="button" data-chat-viewer-zoom-out aria-label="Diminuir zoom">−</button>
          <button type="button" data-chat-viewer-zoom-reset aria-label="Restaurar zoom">100%</button>
          <button type="button" data-chat-viewer-zoom-in aria-label="Aumentar zoom">+</button>
          <button type="button" data-chat-viewer-download aria-label="Baixar imagem">${icons.download}</button>
          <button type="button" data-chat-viewer-close aria-label="Fechar">${icons.close}</button>
        </div>
      </div>
      <button class="fa-chat-viewer-nav is-prev" type="button" data-chat-viewer-prev aria-label="Imagem anterior">${icons.back}</button>
      <div class="fa-chat-viewer-stage" data-chat-viewer-stage><img data-chat-viewer-img alt=""></div>
      <button class="fa-chat-viewer-nav is-next" type="button" data-chat-viewer-next aria-label="Proxima imagem">${icons.back}</button>`;
    document.body.appendChild(chatViewer);

    chatViewer.addEventListener('click', event => {
      if (event.target.closest('[data-chat-viewer-close]')) { closeChatViewer(); return; }
      if (event.target.closest('[data-chat-viewer-prev]')) { moveChatViewer(-1); return; }
      if (event.target.closest('[data-chat-viewer-next]')) { moveChatViewer(1); return; }
      if (event.target.closest('[data-chat-viewer-zoom-in]')) { setChatViewerScale(chatViewerScale + .25); return; }
      if (event.target.closest('[data-chat-viewer-zoom-out]')) { setChatViewerScale(chatViewerScale - .25); return; }
      if (event.target.closest('[data-chat-viewer-zoom-reset]')) { setChatViewerScale(1); return; }
      if (event.target.closest('[data-chat-viewer-download]')) {
        const item = chatViewerItems[chatViewerIndex];
        if (item) downloadAttachment(item.url, item.name);
      }
    });
    chatViewer.querySelector('[data-chat-viewer-stage]')?.addEventListener('wheel', event => {
      event.preventDefault();
      setChatViewerScale(chatViewerScale + (event.deltaY < 0 ? .2 : -.2));
    }, { passive: false });
    chatViewer.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || event.target.closest('button')) return;
      chatViewerSwipeX = event.clientX;
    });
    chatViewer.addEventListener('pointerup', event => {
      if (chatViewerSwipeX === null) return;
      const distance = event.clientX - chatViewerSwipeX;
      chatViewerSwipeX = null;
      if (Math.abs(distance) > 48 && chatViewerScale === 1) moveChatViewer(distance > 0 ? -1 : 1);
    });
    document.addEventListener('keydown', event => {
      if (!chatViewer?.classList.contains('is-open')) return;
      if (event.key === 'Escape') closeChatViewer();
      if (event.key === 'ArrowLeft') moveChatViewer(-1);
      if (event.key === 'ArrowRight') moveChatViewer(1);
      if (event.key === '+' || event.key === '=') setChatViewerScale(chatViewerScale + .25);
      if (event.key === '-') setChatViewerScale(chatViewerScale - .25);
    });
    return chatViewer;
  }

  function setChatViewerScale(value) {
    chatViewerScale = Math.max(.5, Math.min(4, Number(value || 1)));
    const img = chatViewer?.querySelector('[data-chat-viewer-img]');
    const reset = chatViewer?.querySelector('[data-chat-viewer-zoom-reset]');
    if (img) img.style.transform = `scale(${chatViewerScale})`;
    if (reset) reset.textContent = `${Math.round(chatViewerScale * 100)}%`;
  }

  function renderChatViewerItem() {
    const item = chatViewerItems[chatViewerIndex];
    if (!item || !chatViewer) return;
    const img = chatViewer.querySelector('[data-chat-viewer-img]');
    const title = chatViewer.querySelector('[data-chat-viewer-title]');
    const count = chatViewer.querySelector('[data-chat-viewer-count]');
    const prev = chatViewer.querySelector('[data-chat-viewer-prev]');
    const next = chatViewer.querySelector('[data-chat-viewer-next]');
    if (img) { img.src = item.url; img.alt = item.name; }
    if (title) title.textContent = item.name;
    if (count) count.textContent = `${chatViewerIndex + 1} de ${chatViewerItems.length}${item.sender ? ` · ${item.sender}` : ''}`;
    if (prev) prev.hidden = chatViewerItems.length < 2;
    if (next) next.hidden = chatViewerItems.length < 2;
    setChatViewerScale(1);
  }

  function moveChatViewer(direction) {
    if (chatViewerItems.length < 2) return;
    chatViewerIndex = (chatViewerIndex + direction + chatViewerItems.length) % chatViewerItems.length;
    renderChatViewerItem();
  }

  function openChatViewer(url, name = 'Imagem') {
    const viewer = ensureChatViewer();
    chatViewerItems = currentConversationImages();
    let index = chatViewerItems.findIndex(item => item.url === url);
    if (index < 0) {
      chatViewerItems.push({ url, name, sender: '' });
      index = chatViewerItems.length - 1;
    }
    chatViewerIndex = index;
    viewer.classList.add('is-open');
    viewer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('fa-chat-viewer-open');
    renderChatViewerItem();
    viewer.querySelector('[data-chat-viewer-close]')?.focus();
  }

  function closeChatViewer() {
    if (!chatViewer) return;
    chatViewer.classList.remove('is-open');
    chatViewer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('fa-chat-viewer-open');
    chatViewerItems = [];
    chatViewerIndex = 0;
    setChatViewerScale(1);
  }

  function openCommunityPost(postId) {
    if (!postId) return;
    closePanel();
    if (typeof window.navigatePost === 'function') window.navigatePost(String(postId));
    else location.href = `community.html?post=${encodeURIComponent(postId)}`;
  }

  async function openCommunityComment(commentId) {
    if (!commentId) return;
    closePanel();
    if (typeof window.navigateCommentThread === 'function') {
      window.navigateCommentThread(String(commentId));
      return;
    }
    try {
      const data = await loadSocialPreview('comment', String(commentId));
      const postId = data?.root_comment?.post_id || data?.original_post?.id;
      if (postId) location.href = `community.html?post=${encodeURIComponent(postId)}`;
    } catch {}
  }

  async function uploadPendingAttachments(attachments = []) {
    if (!attachments.length) return [];
    const formData = new FormData();
    attachments.forEach(att => formData.append('files', att.file, att.name));
    const data = await api('/api/me/chat/attachments', {
      method: 'POST',
      body: formData,
      timeoutMs: 90000,
    });
    const uploaded = Array.isArray(data.attachments) ? data.attachments.map(normalizeAttachment).filter(Boolean) : [];
    if (uploaded.length !== attachments.length) throw new Error('Nem todos os anexos foram enviados.');
    return uploaded;
  }

  function attachComposeHandlers() {
    const textarea = root.querySelector('[data-chat-input]');
    if (!textarea) return;

    // Auto-resize
    textarea.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 110) + 'px';
      updateSendButtonState();
    });

    // Enter envia / Shift+Enter = nova linha
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const form = this.closest('[data-chat-form]');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });

    textarea.addEventListener('paste', function (e) {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) addPendingFiles(files);
    });

    // Char counter
    textarea.addEventListener('input', function () {
      const counter = root.querySelector('[data-chat-char-counter]');
      if (!counter) return;
      const remaining = 500 - this.value.length;
      const show = this.value.length > 440;
      counter.textContent = show ? `${remaining} restantes` : '';
      counter.style.opacity = show ? '1' : '0';
      counter.style.color = remaining < 20 ? 'var(--fc-red,#ff5f52)' : 'var(--fc-ink-3,#7a756a)';
    });
    updateSendButtonState();
  }

  function applyPendingDraft() {
    const draft = String(state.pendingDraft||'').trim();
    if (!draft) return;
    const textarea = root.querySelector('[data-chat-input]');
    if (!textarea) return;
    textarea.value = draft.slice(0,500);
    state.pendingDraft = '';
    textarea.dispatchEvent(new Event('input', {bubbles:true}));
    textarea.focus();
  }

  // ── API calls ─────────────────────────────────────────────────────────────────
  async function ensureMe() {
    if (state.me) return state.me;
    state.me = await api('/api/me');
    return state.me;
  }

  async function loadUnread() {
    try {
      const data = await api('/api/me/messages/unread-count');
      state.unread = Number(data.count||0);
      updateLauncherBadge();
    } catch { state.unread = 0; }
  }

  async function loadUnreadSilent() {
    try {
      const data = await api('/api/me/messages/unread-count');
      if (Number(data.count||0) !== state.unread) {
        state.unread = Number(data.count||0);
        updateLauncherBadge();
      }
    } catch { /* silencioso */ }
  }

  async function loadConversations() {
    try {
      const data = await api('/api/me/conversations?limit=30');
      state.conversations = Array.isArray(data.rows) ? data.rows : [];
      recalcUnread();
    } catch (e) {
      if (!state.current) state.error = e.message || 'Não foi possível carregar.';
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
      state.friends  = Array.isArray(friends.rows)   ? friends.rows   : [];
      state.requests = Array.isArray(requests.rows)  ? requests.rows  : (Array.isArray(requests) ? requests : []);
    } catch { state.friends = []; state.requests = []; }
  }

  async function searchPeople(term) {
    if (!term.trim()) { state.people = []; return; }
    try {
      const rows = await api(`/api/community/players?${new URLSearchParams({search:term.trim(),limit:'12'})}`);
      state.people = Array.isArray(rows) ? rows : [];
    } catch { state.people = []; }
  }

  // ── Abrir / fechar painel ─────────────────────────────────────────────────────
  async function openPanel() {
    state.open = true;
    if (!state.tab) state.tab = 'conversations';
    state.error = '';
    render();
    state.loadingConversations = !state.conversations.length;
    state.loadingGroups = !state.groups.length;
    state.loadingFriends = !state.friends.length;
    if (state.loadingConversations||state.loadingGroups||state.loadingFriends) updateConversationList();
    startPresenceBeacon();
    try {
      await ensureMe();
    } catch (e) {
      state.loadingConversations = state.loadingGroups = state.loadingFriends = false;
      const msg = e.message||'';
      state.error = (msg.includes('401')||msg.includes('invalid token')||msg.includes('session revoked'))
        ? 'Sessão expirada. Recarregue a página.' : msg||'Serviço indisponível.';
      updateConversationList();
      return;
    }
    try {
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
    } finally {
      state.loadingConversations = state.loadingGroups = state.loadingFriends = false;
      updateConversationList();
      updateLauncherBadge();
    }
  }

  function closePanel() {
    state.open = false;
    state.replyTo = null;
    state.editingMessage = null;
    closeMessageMenu();
    closeSSE();
    stopPresenceBeacon();
    closeChatViewer();
    const panel = root.querySelector('.fa-chat-panel');
    if (panel) { panel.style.height=''; panel.style.top=''; }
    render();
  }

  async function openConversation(conv) {
    // Fecha SSE anterior se era outra conversa
    if (_sseKey && _sseKey !== `direct:${conv.id}`) closeSSE();
    clearPendingAttachments();
    state.replyTo = null;
    state.editingMessage = null;

    state.current = conv;
    state.currentKind = 'direct';
    state._peerLastReadAt = null;
    state._peerIsOnline = conv.is_online || false;

    const k = cacheKey();
    const cached = k ? (state._msgCache[k]||[]) : [];
    state.messages = cached;
    state.loadingMessages = cached.length === 0;
    state.error = '';

    render();
    if (cached.length) updateScroll();

    // Abre SSE imediatamente (antes do fetch — para não perder msgs que chegam durante o load)
    openSSE();

    // Poll de status de delivery em paralelo
    pollConversationStatus().catch(()=>{});

    try {
      let data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=80`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && conv.last_message_id) {
        await wait(350);
        data = await api(`/api/me/conversations/${encodeURIComponent(conv.id)}/messages?limit=80&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      const pending = state.messages.filter(message => String(message.id || '').startsWith('tmp-'));
      const serverClientRefs = new Set(rows.map(message => String(message.client_ref || '')).filter(Boolean));
      state.messages = dedupeMessages([
        ...rows,
        ...pending.filter(message => !serverClientRefs.has(String(message.client_ref || message.id || ''))),
      ]);
      state.loadingMessages = false;
      state.error = '';
      if (k) state._msgCache[k] = state.messages.slice();
      conv.unread_count = 0;
      try { await loadConversations(); } catch { /* silencioso */ }
      state.current = state.conversations.find(c=>Number(c.id)===Number(conv.id)) || conv;
      // Sincroniza peerIsOnline com dados frescos da conversa
      if (state.current.is_online !== undefined) state._peerIsOnline = state.current.is_online;
      updateMessagesList({ scroll: true });
      updateAllMessageTicks();
    } catch (e) {
      state.messages = cached;
      state.loadingMessages = false;
      state.error = (!cached.length && !conv.last_message_id) ? '' : (e.message||'Erro ao carregar mensagens');
      updateMessagesList({ scroll: false });
    }
  }

  async function openGroupConversation(group) {
    if (_sseKey && _sseKey !== `group:${group.id}`) closeSSE();
    clearPendingAttachments();
    state.replyTo = null;
    state.editingMessage = null;

    state.current = group;
    state.currentKind = 'group';
    state._peerLastReadAt = null;
    state._peerIsOnline = false;

    const k = cacheKey();
    const cached = k ? (state._msgCache[k]||[]) : [];
    state.messages = cached;
    state.loadingMessages = cached.length === 0;
    state.error = '';

    render();
    if (cached.length) updateScroll();
    openSSE();

    try {
      let data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=80`);
      let rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && group.last_message_id) {
        await wait(350);
        data = await api(`/api/me/group-conversations/${encodeURIComponent(group.id)}/messages?limit=80&t=${Date.now()}`);
        rows = Array.isArray(data.rows) ? data.rows : [];
      }
      const pending = state.messages.filter(message => String(message.id || '').startsWith('tmp-'));
      const serverClientRefs = new Set(rows.map(message => String(message.client_ref || '')).filter(Boolean));
      state.messages = dedupeMessages([
        ...rows,
        ...pending.filter(message => !serverClientRefs.has(String(message.client_ref || message.id || ''))),
      ]);
      state.loadingMessages = false;
      state.error = '';
      if (k) state._msgCache[k] = state.messages.slice();
      group.unread_count = 0;
      try { await loadGroups(); } catch { /* silencioso */ }
      state.current = state.groups.find(g=>Number(g.id)===Number(group.id)) || group;
      updateMessagesList({ scroll: true });
    } catch (e) {
      state.messages = cached;
      state.loadingMessages = false;
      state.error = (!cached.length && !group.last_message_id) ? '' : (e.message||'Erro ao carregar mensagens');
      updateMessagesList({ scroll: false });
    }
  }

  async function refreshCurrentMessages() {
    if (!state.current) return;
    const isGroup = state.currentKind==='group';
    const data = await api(`/${isGroup?'api/me/group-conversations':'api/me/conversations'}/${encodeURIComponent(state.current.id)}/messages?limit=80`);
    const nextMessages = dedupeMessages(Array.isArray(data.rows) ? data.rows : []);

    const pendingMsgs = state.messages.filter(m=>String(m.id).startsWith('tmp-'));
    const serverIds = new Set(nextMessages.map(m=>String(m.id)));
    const serverClientRefs = new Set(nextMessages.map(m=>String(m.client_ref || '')).filter(Boolean));
    const merged = [...nextMessages];
    for (const pending of pendingMsgs) {
      if (!serverIds.has(String(pending.id)) && !serverClientRefs.has(String(pending.client_ref || pending.id))) merged.push(pending);
    }

    const before = state.messages.filter(m=>!String(m.id).startsWith('tmp-')).map(m=>`${m.id}:${messageFingerprint(m)}`).join('|');
    const after  = nextMessages.map(m=>`${m.id}:${messageFingerprint(m)}`).join('|');

    if (before !== after) {
      const list = root.querySelector('[data-chat-messages]');
      const wasNearBottom = !list || (list.scrollHeight-list.scrollTop-list.clientHeight) < 80;
      state.messages = merged;
      const k = cacheKey();
      if (k) state._msgCache[k] = merged.slice();
      updateMessagesList({ scroll: wasNearBottom });
    }

    if (isGroup) {
      await loadGroups();
      state.current = state.groups.find(g=>Number(g.id)===Number(state.current.id))||state.current;
    } else {
      await loadConversations();
      state.current = state.conversations.find(c=>Number(c.id)===Number(state.current.id))||state.current;
    }
    updateLauncherBadge();
    // Atualiza ticks depois de refresh
    updateAllMessageTicks();
  }

  async function openWithUser(user) {
    if (!user?.id) return;
    const options = typeof arguments[1] === 'string' ? { draft: arguments[1] } : (arguments[1] || {});
    const draft = String(options.draft || '').trim().slice(0, 500);
    const sendNow = Boolean(options.sendNow || options.immediate);
    if (draft && !sendNow) state.pendingDraft = draft;
    state.open = true;
    syncBodyChatState();
    state.current = null;
    state.currentKind = null;
    state.error = '';
    state.loadingConversations = true;
    render();
    try {
      await ensureMe();
      const conv = await api('/api/me/conversations', { method:'POST', body:JSON.stringify({target_id:user.id}) });
      const openingConversation = openConversation(conv);
      if (draft && sendNow) {
        state.pendingDraft = '';
        queueSend({
          body: draft,
          attachments: [],
          currentConv: conv,
          currentKind: 'direct',
          currentMe: state.me,
        });
      }
      await openingConversation;
      if (!sendNow) {
        applyPendingDraft();
      }
      loadConversations().catch(() => {});
      return conv;
    } finally {
      state.loadingConversations = false;
    }
  }

  async function openWithGroup(group) {
    if (!group?.id) return;
    state.open = true;
    syncBodyChatState();
    state.error = '';
    render();
    await ensureMe();
    await openGroupConversation(group);
    loadGroups().catch(() => {});
    return group;
  }

  function currentMessagePath(messageId) {
    if (!state.current) return '';
    return `/${state.currentKind === 'group' ? 'api/me/group-conversations' : 'api/me/conversations'}/${encodeURIComponent(state.current.id)}/messages/${encodeURIComponent(messageId)}`;
  }

  function findMessage(messageId) {
    return state.messages.find(message => String(message.id) === String(messageId));
  }

  function beginReply(messageId) {
    const message = findMessage(messageId);
    if (!message || message.is_deleted) return;
    state.editingMessage = null;
    state.replyTo = message;
    updateComposeContext();
    root.querySelector('[data-chat-input]')?.focus();
  }

  function beginEdit(messageId) {
    const message = findMessage(messageId);
    if (!message || message.is_deleted || Number(message.sender_id) !== Number(state.me?.id)) return;
    state.replyTo = null;
    state.editingMessage = message;
    const input = root.querySelector('[data-chat-input]');
    if (input) {
      input.value = message.body || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    updateComposeContext();
  }

  function cancelComposeContext() {
    state.replyTo = null;
    state.editingMessage = null;
    const input = root.querySelector('[data-chat-input]');
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updateComposeContext();
  }

  async function editCurrentMessage(body) {
    const target = state.editingMessage;
    if (!target || !body) return;
    const update = await api(currentMessagePath(target.id), { method: 'PATCH', body: JSON.stringify({ body }) });
    applyMessageUpdate(update);
    state.editingMessage = null;
    updateComposeContext();
  }

  async function toggleMessageReaction(messageId, emoji = '❤️') {
    const message = findMessage(messageId);
    if (!message || message.is_deleted) return;
    const mine = new Set(Array.isArray(message.my_reactions) ? message.my_reactions : []);
    const removing = mine.has(emoji);
    const path = `${currentMessagePath(messageId)}/reactions${removing ? `/${encodeURIComponent(emoji)}` : ''}`;
    const update = await api(path, { method: removing ? 'DELETE' : 'POST', body: removing ? undefined : JSON.stringify({ emoji }) });
    applyMessageUpdate(update);
  }

  async function deleteMessage(messageId) {
    const message = findMessage(messageId);
    if (!message || Number(message.sender_id) !== Number(state.me?.id)) return;
    if (!window.confirm('Remover esta mensagem?')) return;
    const update = await api(currentMessagePath(messageId), { method: 'DELETE' });
    applyMessageUpdate(update);
  }

  function closeMessageMenu() {
    root.querySelector('.fa-chat-message-menu')?.remove();
  }

  function openMessageMenu(messageId, anchor) {
    const message = findMessage(messageId);
    if (!message || message.is_deleted) return;
    closeMessageMenu();
    const isMe = Number(message.sender_id) === Number(state.me?.id);
    const menu = document.createElement('div');
    menu.className = 'fa-chat-message-menu';
    messageMenuOpenedAt = Date.now();
    menu.setAttribute('role', 'menu');
    menu.dataset.messageMenuId = String(message.id);
    menu.innerHTML = `
      <div class="fa-chat-message-menu-head"><strong>${esc(messageAuthorName(message))}</strong><small>${esc(messageSummary(message))}</small></div>
      <div class="fa-chat-message-menu-emojis">${['❤️','👍','😂','😮','😢','🔥','👏'].map(emoji => `<button type="button" data-chat-message-react="${esc(emoji)}" data-msg-id="${esc(message.id)}">${emoji}</button>`).join('')}</div>
      <div class="fa-chat-message-menu-actions">
        <button type="button" data-chat-message-reply="${esc(message.id)}">↩ <span>Responder</span></button>
        ${isMe ? `<button type="button" data-chat-message-edit="${esc(message.id)}">✎ <span>Editar</span></button>` : ''}
        <button type="button" data-chat-message-copy="${esc(message.id)}">▣ <span>Copiar texto</span></button>
        ${isMe ? `<button type="button" class="is-danger" data-chat-message-delete="${esc(message.id)}">${icons.trash}<span>Remover</span></button>` : ''}
      </div>`;
    root.appendChild(menu);
    const rect = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 2, width: 0 };
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(10, Math.min(innerWidth - menuRect.width - 10, rect.left + rect.width / 2 - menuRect.width / 2))}px`;
    menu.style.top = `${Math.max(10, Math.min(innerHeight - menuRect.height - 10, rect.top - menuRect.height - 8))}px`;
  }

  function jumpToMessage(messageId) {
    const node = root.querySelector(`[data-msg-id="${CSS.escape(String(messageId))}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('is-highlighted');
    setTimeout(() => node.classList.remove('is-highlighted'), 1400);
  }

  // ── Envio de mensagem (fila paralela) ─────────────────────────────────────────
  async function handleFormSubmit(textarea) {
    if (state.recording.active && state.recording.locked) {
      await finishAudioRecording({ send: true });
      return;
    }
    const body = textarea.value.trim();
    const attachments = state.pendingAttachments.slice();
    if ((!body && !attachments.length) || !state.current) return;
    if (body.length > 500) return;
    if (state.editingMessage) {
      try {
        await editCurrentMessage(body);
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        setComposeError(e.message || 'Nao foi possivel editar.');
      }
      return;
    }

    // Captura contexto imediatamente (antes do await)
    const currentConv = state.current;
    const currentKind = state.currentKind;
    const currentMe   = state.me;
    const replyTo = state.replyTo;

    textarea.value = '';
    textarea.style.height = 'auto';
    textarea.focus();
    state.pendingAttachments = [];
    state.replyTo = null;
    setComposeError('');
    updateComposeAttachments();
    updateComposeContext();

    // Atualiza counter
    const counter = root.querySelector('[data-chat-char-counter]');
    if (counter) { counter.textContent = ''; counter.style.opacity='0'; }

    // Enfileira o envio (garante ordem)
    queueSend({ body, attachments, currentConv, currentKind, currentMe, replyTo });
  }

  async function _doSendMessage({ body, attachments = [], currentConv, currentKind, currentMe, replyTo = null }) {
    // Verifica se ainda estamos na mesma conversa
    const stillSameConv = state.current && Number(state.current.id)===Number(currentConv.id) && state.currentKind===currentKind;

    const isGroup = currentKind==='group';
    const tempId = `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const optimistic = {
      id: tempId,
      sender_id: currentMe?.id,
      body,
      created_at: new Date().toISOString(),
      username: currentMe?.username,
      minecraft_name: currentMe?.minecraft_name,
      attachments: attachments.map(att => ({ ...att, file: undefined })),
      _localAttachments: attachments,
      client_ref: tempId,
      client_status: 'pending',
      reply_to_message_id: replyTo?.id || null,
      reply_to: replyTo ? { id: replyTo.id, sender_id: replyTo.sender_id, sender_name: messageAuthorName(replyTo), body: replyTo.body, is_deleted: replyTo.is_deleted } : null,
    };

    // Insere optimistic na conversa certa
    if (stillSameConv) {
      state.messages.push(optimistic);
      updateMessagesList({ scroll: true });
    }

    try {
      const uploadedAttachments = attachments.length ? await uploadPendingAttachments(attachments) : [];
      const msg = await api(
        `/${isGroup?'api/me/group-conversations':'api/me/conversations'}/${encodeURIComponent(currentConv.id)}/messages`,
        {
          method:'POST',
          body:JSON.stringify({ body, attachments: uploadedAttachments, client_ref: tempId, reply_to_message_id: replyTo?.id || null }),
          timeoutMs: attachments.length ? 95000 : 20000,
        }
      );
      releaseAttachmentPreviews(attachments);

      const saved = {
        ...msg,
        username: currentMe?.username,
        minecraft_name: currentMe?.minecraft_name,
        reply_to: optimistic.reply_to,
      };

      if (stillSameConv && state.current && Number(state.current.id)===Number(currentConv.id)) {
        const idx = state.messages.findIndex(m=>String(m.id)===String(tempId) || String(m.client_ref || '')===String(tempId) || String(m.id)===String(msg.id));
        if (idx >= 0) state.messages[idx] = saved;
        else state.messages.push(saved);
        const k = `${currentKind}:${currentConv.id}`;
        if (k) state._msgCache[k] = state.messages.slice();

        // Polling de status imediato pós-envio para detectar entrega rápida
        setTimeout(() => pollConversationStatus(), 1500);

        updateMessagesList({ scroll: true });
        updateLauncherBadge();
      }

      // Atualiza lista de conversas em background
      if (isGroup) loadGroups().catch(()=>{});
      else loadConversations().catch(()=>{});

    } catch (e) {
      // Marca como falhou na UI
      if (stillSameConv) {
        const failed = state.messages.find(m=>m.id===tempId);
        if (failed) {
          failed.client_status = 'failed';
          failed.client_error = e.message || 'Falhou';
        }
        state.error = e.message || 'Mensagem não enviada.';
        updateMessagesList({ scroll: true });
      }
    }
  }

  // ── Retry de mensagem falha ───────────────────────────────────────────────────
  async function retryFailedMessage(tmpId) {
    const msg = state.messages.find(m=>m.id===tmpId);
    if (!msg) return;
    const body = msg.body;
    const attachments = Array.isArray(msg._localAttachments) ? msg._localAttachments : [];
    // Remove a mensagem falha
    state.messages = state.messages.filter(m=>m.id!==tmpId);
    updateMessagesList({ scroll: false });
    // Re-enfileira
    queueSend({ body, attachments, currentConv: state.current, currentKind: state.currentKind, currentMe: state.me });
  }

  async function followBack(userId) {
    await api(`/api/me/follows/${encodeURIComponent(userId)}`, {method:'POST'});
    await loadFriends();
    await loadConversations();
    updateConversationList();
  }

  async function createGroup() {
    const name = state.groupName.trim();
    const memberIds = [...new Set(state.groupMemberIds.map(id=>parseInt(id,10)).filter(Boolean))];
    if (!name || !memberIds.length || state.busy) return;
    state.busy = true;
    updateConversationList();
    try {
      const group = await api('/api/me/group-conversations', {method:'POST', body:JSON.stringify({name, member_ids:memberIds})});
      state.groupCreating = false;
      state.groupName = '';
      state.groupMemberIds = [];
      state.search = '';
      await loadGroups();
      await openGroupConversation(group);
    } catch (e) {
      state.error = e.message||'Grupo não criado.';
      updateConversationList();
    } finally {
      state.busy = false;
    }
  }

  // ── Event delegation ──────────────────────────────────────────────────────────
  let searchTimer = null;
  let attachmentLongPressTimer = null;
  let messageLongPressTimer = null;
  let messageGesture = null;
  let lastMessageTap = { id: '', at: 0 };
  let messageMenuOpenedAt = 0;

  root.addEventListener('click', async event => {
    const toggle      = event.target.closest('[data-chat-toggle]');
    const close       = event.target.closest('[data-chat-close]');
    const tab         = event.target.closest('[data-chat-tab]');
    const convBtn     = event.target.closest('[data-chat-conv]');
    const groupBtn    = event.target.closest('[data-chat-group]');
    const userBtn     = event.target.closest('[data-chat-user]');
    const back        = event.target.closest('[data-chat-back]');
    const profile     = event.target.closest('[data-chat-profile]');
    const newGroup    = event.target.closest('[data-chat-new-group]');
    const cancelGroup = event.target.closest('[data-chat-cancel-group]');
    const memberToggle= event.target.closest('[data-chat-member-toggle]');
    const reload      = event.target.closest('[data-chat-reload]');
    const reloadList  = event.target.closest('[data-chat-reload-list]');
    const addFriend   = event.target.closest('[data-add-friend]');
    const retry       = event.target.closest('[data-chat-retry]');
    const attach      = event.target.closest('[data-chat-attach]');
    const camera      = event.target.closest('[data-chat-camera]');
    const removeAtt   = event.target.closest('[data-chat-attachment-remove]');
    const mic         = event.target.closest('[data-chat-mic]');
    const recordCancel= event.target.closest('[data-chat-record-cancel]');
    const attachMenu  = event.target.closest('[data-chat-attachment-menu]');
    const downloadBtn = event.target.closest('[data-chat-download-url]');
    const imageOpen   = event.target.closest('[data-chat-image-open]');
    const openPost    = event.target.closest('[data-chat-open-post]');
    const openComment = event.target.closest('[data-chat-open-comment]');
    const contextCancel=event.target.closest('[data-chat-context-cancel]');
    const messageReply= event.target.closest('[data-chat-message-reply]');
    const messageEdit = event.target.closest('[data-chat-message-edit]');
    const messageHeart= event.target.closest('[data-chat-message-heart]');
    const messageReact= event.target.closest('[data-chat-message-react]');
    const messageMenu = event.target.closest('[data-chat-message-menu]');
    const messageCopy = event.target.closest('[data-chat-message-copy]');
    const messageDelete=event.target.closest('[data-chat-message-delete]');
    const jumpMessage = event.target.closest('[data-chat-jump-message]');

    if (!attachMenu && !downloadBtn && !event.target.closest('.fa-chat-attach-menu')) {
      closeAttachmentMenus();
    }
    if (!event.target.closest('.fa-chat-message-menu') && !messageMenu && Date.now() - messageMenuOpenedAt > 380) closeMessageMenu();

    try {
      if (contextCancel) {
        event.preventDefault();
        cancelComposeContext();
        return;
      }
      if (jumpMessage) {
        event.preventDefault();
        jumpToMessage(jumpMessage.dataset.chatJumpMessage);
        return;
      }
      if (messageReply) {
        event.preventDefault();
        closeMessageMenu();
        beginReply(messageReply.dataset.chatMessageReply);
        return;
      }
      if (messageEdit) {
        event.preventDefault();
        closeMessageMenu();
        beginEdit(messageEdit.dataset.chatMessageEdit);
        return;
      }
      if (messageHeart) {
        event.preventDefault();
        await toggleMessageReaction(messageHeart.dataset.chatMessageHeart, '❤️');
        return;
      }
      if (messageReact) {
        event.preventDefault();
        const messageId = messageReact.dataset.msgId || messageReact.closest('[data-msg-id]')?.dataset.msgId || root.querySelector('.fa-chat-message-menu')?.dataset.messageMenuId;
        closeMessageMenu();
        await toggleMessageReaction(messageId, messageReact.dataset.chatMessageReact);
        return;
      }
      if (messageMenu) {
        event.preventDefault();
        event.stopPropagation();
        openMessageMenu(messageMenu.dataset.chatMessageMenu, messageMenu.closest('[data-msg-id]')?.querySelector('.fa-chat-bubble') || messageMenu);
        return;
      }
      if (messageCopy) {
        event.preventDefault();
        const message = findMessage(messageCopy.dataset.chatMessageCopy);
        closeMessageMenu();
        if (message?.body) await navigator.clipboard.writeText(message.body);
        return;
      }
      if (messageDelete) {
        event.preventDefault();
        closeMessageMenu();
        await deleteMessage(messageDelete.dataset.chatMessageDelete);
        return;
      }
      if (imageOpen) {
        event.preventDefault();
        event.stopPropagation();
        openChatViewer(imageOpen.dataset.chatImageOpen, imageOpen.dataset.chatImageName || 'Imagem');
        return;
      }
      if (openPost) {
        event.preventDefault();
        event.stopPropagation();
        openCommunityPost(openPost.dataset.chatOpenPost);
        return;
      }
      if (openComment) {
        event.preventDefault();
        event.stopPropagation();
        await openCommunityComment(openComment.dataset.chatOpenComment);
        return;
      }
      if (downloadBtn) {
        event.stopPropagation();
        closeAttachmentMenus();
        await downloadAttachment(downloadBtn.dataset.chatDownloadUrl, downloadBtn.dataset.chatDownloadName);
        return;
      }
      if (attachMenu) {
        event.stopPropagation();
        toggleAttachmentMenu(attachMenu);
        return;
      }
      if (recordCancel) {
        event.stopPropagation();
        await finishAudioRecording({ send: false });
        return;
      }
      if (mic) {
        event.stopPropagation();
        if (Date.now() < recordingState.suppressClickUntil) return;
        if (window.matchMedia?.('(pointer: coarse)').matches) return;
        if (state.recording.active) await finishAudioRecording({ send: true });
        else await startAudioRecording();
        return;
      }
      if (attach) {
        event.stopPropagation();
        root.querySelector('[data-chat-file-input]')?.click();
        return;
      }
      if (camera) {
        event.stopPropagation();
        root.querySelector('[data-chat-camera-input]')?.click();
        return;
      }
      if (removeAtt) {
        event.stopPropagation();
        removePendingAttachment(removeAtt.dataset.chatAttachmentRemove);
        return;
      }
      if (retry) {
        event.stopPropagation();
        await retryFailedMessage(retry.dataset.chatRetry);
        return;
      }
      if (addFriend) {
        event.stopPropagation();
        const userId = String(addFriend.dataset.addFriend);
        if (state._sentRequests.has(userId)) return;
        state._sentRequests.add(userId);
        addFriend.classList.add('is-sent');
        addFriend.title = 'Solicitação enviada';
        addFriend.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
        try {
          await api(`/api/me/follows/${encodeURIComponent(userId)}`, {method:'POST'});
          await loadFriends();
          updateConversationList();
        } catch (e) {
          state._sentRequests.delete(userId);
          addFriend.classList.remove('is-sent');
          addFriend.title = 'Adicionar amigo';
          addFriend.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>`;
          state.error = e.message||'Não foi possível adicionar.';
          updateConversationList();
        }
        return;
      }
      if (toggle) {
        state.open ? closePanel() : await openPanel();
      } else if (close) {
        closePanel();
      } else if (reloadList) {
        state.error = '';
        state.loadingConversations = state.loadingGroups = true;
        updateConversationList();
        try {
          await ensureMe();
          await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
        } finally {
          state.loadingConversations = state.loadingGroups = false;
          updateConversationList();
          updateLauncherBadge();
        }
      } else if (reload) {
        if (!state.current) return;
        if (state.currentKind==='group') await openGroupConversation(state.current);
        else await openConversation(state.current);
      } else if (tab) {
        state.tab = tab.dataset.chatTab;
        state.search = '';
        state.groupCreating = false;
        if (state.tab==='friends') state.loadingFriends = !state.friends.length;
        if (state.tab==='groups')  state.loadingGroups  = !state.groups.length;
        updateConversationList();
        if (state.tab==='friends') {
          state.loadingFriends = true;
          await loadFriends();
          state.loadingFriends = false;
        }
        if (state.tab==='groups') {
          await Promise.all([loadGroups(), loadFriends()]);
          state.loadingGroups = false;
        }
        updateConversationList();
      } else if (convBtn) {
        const conv = state.conversations.find(c=>Number(c.id)===Number(convBtn.dataset.chatConv));
        if (conv) await openConversation(conv);
      } else if (groupBtn) {
        const group = state.groups.find(g=>Number(g.id)===Number(groupBtn.dataset.chatGroup));
        if (group) await openGroupConversation(group);
      } else if (userBtn) {
        const follow = event.target.closest('[data-follow-back]');
        if (follow) {
          event.stopPropagation();
          await followBack(userBtn.dataset.chatUser);
          return;
        }
        await openWithUser({id:userBtn.dataset.chatUser, minecraft_name:userBtn.dataset.chatName});
      } else if (back) {
        closeSSE();
        clearPendingAttachments();
        state.replyTo = null;
        state.editingMessage = null;
        closeMessageMenu();
        state.current = null;
        state.currentKind = null;
        state.messages = [];
        state._peerLastReadAt = null;
        state._peerIsOnline = false;
        render();
        if (state.tab==='groups') await loadGroups();
        else if (state.tab==='friends') await loadFriends();
        else await loadConversations();
        updateConversationList();
      } else if (profile) {
        const target = `id:${profile.dataset.chatProfile}`;
        closePanel();
        if (typeof window.navigateProfile==='function') window.navigateProfile(target);
        else location.href=`profile.html?id=${encodeURIComponent(target)}`;
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
          ? state.groupMemberIds.filter(i=>i!==id)
          : [...state.groupMemberIds, id].slice(0, 19);
        updateConversationList();
      }
    } catch (e) {
      state.error = e.message||'Ação não concluída.';
      updateConversationList();
    }
  });

  root.addEventListener('pointerdown', event => {
    const mic = event.target.closest('[data-chat-mic]');
    if (mic && window.matchMedia?.('(pointer: coarse)').matches) {
      event.preventDefault();
      recordingState.suppressClickUntil = Date.now() + 900;
      recordingState.pointerId = event.pointerId;
      recordingState.startY = event.clientY;
      recordingState.pointerReleased = false;
      recordingState.cancelOnStart = false;
      recordingState.lockOnStart = false;
      startAudioRecording({ pointerId: event.pointerId, startY: event.clientY });
      try { mic.setPointerCapture?.(event.pointerId); } catch {}
      return;
    }

    const messageRow = event.target.closest('[data-msg-id]');
    if (messageRow && !event.target.closest('button,audio,video,a,input,textarea')) {
      messageGesture = {
        pointerId: event.pointerId,
        row: messageRow,
        id: messageRow.dataset.msgId,
        startX: event.clientX,
        startY: event.clientY,
        swiped: false,
        longPressed: false,
      };
      clearTimeout(messageLongPressTimer);
      messageLongPressTimer = setTimeout(() => {
        if (!messageGesture || messageGesture.pointerId !== event.pointerId || messageGesture.swiped) return;
        messageGesture.longPressed = true;
        openMessageMenu(messageGesture.id, messageGesture.row.querySelector('.fa-chat-bubble') || messageGesture.row);
        navigator.vibrate?.(18);
      }, 520);
    }

    const attachment = event.target.closest('[data-chat-attachment]');
    if (!attachment || event.target.closest('button,audio,video,iframe')) return;
    clearTimeout(attachmentLongPressTimer);
    attachmentLongPressTimer = setTimeout(() => {
      closeAttachmentMenus(attachment);
      attachment.classList.add('is-menu-open');
    }, 520);
  }, { passive: false });

  root.addEventListener('pointermove', event => {
    if (recordingState.pointerId === event.pointerId && recordingState.startY - event.clientY > 72) {
      if (state.recording.active && !state.recording.locked) lockAudioRecording();
      else recordingState.lockOnStart = true;
    }
    if (messageGesture?.pointerId === event.pointerId && !messageGesture.longPressed) {
      const dx = event.clientX - messageGesture.startX;
      const dy = event.clientY - messageGesture.startY;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        clearTimeout(messageLongPressTimer);
        messageGesture.row.style.transform = '';
      } else if (Math.abs(dx) > 8) {
        clearTimeout(messageLongPressTimer);
        const distance = Math.max(-76, Math.min(76, dx));
        messageGesture.swiped = Math.abs(distance) > 52;
        messageGesture.row.style.transform = `translateX(${distance * .72}px)`;
        messageGesture.row.classList.toggle('is-swipe-ready', messageGesture.swiped);
      }
    }
  }, { passive: true });

  root.addEventListener('pointerup', async event => {
    clearTimeout(attachmentLongPressTimer);
    clearTimeout(messageLongPressTimer);
    if (messageGesture?.pointerId === event.pointerId) {
      const gesture = messageGesture;
      messageGesture = null;
      gesture.row.style.transform = '';
      gesture.row.classList.remove('is-swipe-ready');
      if (gesture.swiped) {
        beginReply(gesture.id);
        navigator.vibrate?.(12);
      } else if (!gesture.longPressed && event.pointerType === 'touch') {
        const now = Date.now();
        if (lastMessageTap.id === gesture.id && now - lastMessageTap.at < 330) {
          lastMessageTap = { id: '', at: 0 };
          await toggleMessageReaction(gesture.id, '❤️').catch(() => {});
        } else {
          lastMessageTap = { id: gesture.id, at: now };
        }
      }
    }
    if (recordingState.pointerId !== event.pointerId) return;
    if (!state.recording.active) {
      recordingState.pointerReleased = true;
      return;
    }
    const shouldSend = state.recording.active && !state.recording.locked;
    recordingState.pointerId = null;
    if (shouldSend) await finishAudioRecording({ send: true });
  });

  root.addEventListener('pointercancel', async event => {
    clearTimeout(attachmentLongPressTimer);
    clearTimeout(messageLongPressTimer);
    if (messageGesture?.pointerId === event.pointerId) {
      messageGesture.row.style.transform = '';
      messageGesture.row.classList.remove('is-swipe-ready');
      messageGesture = null;
    }
    if (recordingState.pointerId !== event.pointerId) return;
    if (!state.recording.active) {
      recordingState.cancelOnStart = true;
      return;
    }
    recordingState.pointerId = null;
    if (state.recording.active && !state.recording.locked) await finishAudioRecording({ send: false });
  });

  root.addEventListener('dblclick', event => {
    const row = event.target.closest('[data-msg-id]');
    if (!row || event.target.closest('button,a,input,textarea,audio,video')) return;
    toggleMessageReaction(row.dataset.msgId, '❤️').catch(() => {});
  });

  root.addEventListener('contextmenu', event => {
    const row = event.target.closest('[data-msg-id]');
    if (!row || event.target.closest('input,textarea')) return;
    event.preventDefault();
    openMessageMenu(row.dataset.msgId, row.querySelector('.fa-chat-bubble') || row);
  });

  root.addEventListener('input', event => {
    const groupName = event.target.closest('[data-chat-group-name]');
    if (groupName) {
      state.groupName = groupName.value;
      const submit = root.querySelector('.fa-chat-create');
      if (submit) submit.disabled = state.busy || !state.groupName.trim() || !state.groupMemberIds.length;
      return;
    }
    const input = event.target.closest('[data-chat-search]');
    if (!input) return;
    state.search = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (state.tab==='friends' || (state.tab==='groups' && state.groupCreating)) await searchPeople(state.search);
      const list = root.querySelector('.fa-chat-list');
      if (list) {
        list.innerHTML = state.tab==='friends' ? renderFriends() : state.tab==='groups' ? renderGroups() : renderConversations();
        updateLauncherBadge();
      }
    }, 180);
  });

  root.addEventListener('change', event => {
    const fileInput = event.target.closest('[data-chat-file-input], [data-chat-camera-input]');
    if (!fileInput) return;
    addPendingFiles(fileInput.files);
    fileInput.value = '';
  });

  root.addEventListener('submit', event => {
    const groupForm = event.target.closest('[data-chat-group-form]');
    if (groupForm) { event.preventDefault(); createGroup(); return; }
    const form = event.target.closest('[data-chat-form]');
    if (!form) return;
    event.preventDefault();
    const textarea = form.querySelector('[data-chat-input]');
    if (textarea) handleFormSubmit(textarea);
  });

  document.addEventListener('click', event => {
    const navButton = event.target.closest('.mobile-bottom-nav .mbtn');
    if (!navButton) return;
    syncFabPosition();
    if (navButton.id==='mobile-chat-btn') return;
    if (state.open) closePanel();
  }, true);

  // ── Mobile keyboard ────────────────────────────────────────────────────────────
  (function setupKeyboardAvoidance() {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height, rafId = null;
    vv.addEventListener('resize', () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const keyboardClosed = vv.height > prevHeight;
        prevHeight = vv.height;
        if (!keyboardClosed || !state.open || window.innerWidth > 768) return;
        const msgs = root.querySelector('[data-chat-messages]');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      });
    }, { passive: true });
  })();

  // ── Public API ────────────────────────────────────────────────────────────────
  window.FAChat = {
    open: openPanel,
    close: closePanel,
    openWithUser,
    openGroup: openWithGroup,
    shareWithUser: async (user, text) => openWithUser(user, { draft: text, sendNow: true }),
    refresh: async () => {
      await Promise.all([loadUnread(), loadConversations(), loadGroups(), loadFriends()]);
      updateConversationList();
      updateLauncherBadge();
    },
  };

  // ── Warm up ───────────────────────────────────────────────────────────────────
  async function warmChat() {
    if (state.warmed) return;
    state.warmed = true;
    try {
      await ensureMe();
      await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
      if (state.open && !state.current) updateConversationList();
      else updateLauncherBadge();
    } catch { state.warmed = false; }
  }

  render();
  syncFabPosition();
  window.addEventListener('resize', syncFabPosition, { passive: true });
  if ('MutationObserver' in window) {
    fabObserver = new MutationObserver(syncFabPosition);
    fabObserver.observe(document.body, { childList:true, subtree:true });
  }

  loadUnread();

  if ('requestIdleCallback' in window) requestIdleCallback(()=>warmChat(), {timeout:8000});
  else setTimeout(()=>warmChat(), 2000);

  // ── Poll loop ─────────────────────────────────────────────────────────────────
  // Com SSE ativo: polling raro apenas como backup de segurança
  // Sem SSE (fallback): polling mais rápido
  let _chatPollFailures = 0;
  let _lastPoll = 0;
  let _lastStatusPoll = 0;

  setInterval(async () => {
    const now = Date.now();

    // Polling de status de delivery a cada 15s quando em thread ativa
    if (state.current && state.currentKind==='direct' && now - _lastStatusPoll > 15000) {
      _lastStatusPoll = now;
      pollConversationStatus().catch(()=>{});
    }

    // Intervalo adaptativo:
    // SSE ativo em thread → backup a cada 30s
    // Fallback (sem SSE) em thread → 3s
    // Inbox aberto → 10s
    // Background → 25s
    const hasSse = Boolean(_sseConn && !_sseFallbackActive);
    const interval = state.current
      ? (hasSse ? 30000 : 3000)
      : (!state.open ? 25000 : 10000);

    if (now - _lastPoll < interval) return;
    if (document.hidden && !state.current) return;
    if (_chatPollFailures >= 3) {
      if (_chatPollFailures % 2 !== 0) { _chatPollFailures++; return; }
    }
    _lastPoll = now;

    try {
      if (!state.open) {
        await loadUnread();
      } else if (state.current) {
        await refreshCurrentMessages();
      } else {
        if (state.tab==='groups') await loadGroups();
        else await loadConversations();
        updateConversationList();
      }
      _chatPollFailures = 0;
    } catch {
      _chatPollFailures++;
    }
  }, 1500); // tick a cada 1.5s para que o fallback (3s) seja efetivo

})();
