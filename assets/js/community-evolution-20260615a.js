(() => {
  'use strict';

  const REACTIONS = {
    heart: ['♥', 'Amei'],
    fire: ['🔥', 'Fogo'],
    trophy: ['🏆', 'Conquista'],
    shocked: ['😮', 'Surpresa'],
    diamond: ['💎', 'Diamante'],
    handshake: ['🤝', 'Juntos'],
  };
  const evoQueue = [];
  const locallyViewedStories = new Set();
  let storyGroups = [];
  let storyUsers = new Map();
  let activeStoryGroup = 0;
  let activeStoryIndex = 0;
  let storyTimer = null;
  let storyFrame = null;
  let storyElapsed = 0;
  let storyPaused = false;
  let storySuppressClickUntil = 0;
  let storyGesture = null;
  let storyLastTap = 0;
  let storyReplySending = false;
  let decorateTimer = null;
  let decorating = false;
  let typingTimer = null;
  let typingHideTimer = null;
  let lastTypingSentAt = 0;
  let pendingCommentFocus = null;

  const safe = value => typeof esc === 'function' ? esc(value) : String(value || '');
  const buzz = pattern => {
    try { navigator.vibrate?.(pattern); } catch {}
  };
  const postForCard = card => {
    const recordId = String(card?.dataset?.recordId || '');
    const postId = String(card?.dataset?.postId || '');
    return state.posts.find(row => String(row.id) === recordId)
      || state.posts.find(row => String(row.repost_of_id || row.id) === postId)
      || null;
  };

  function injectShell() {
    const topbar = document.querySelector('.topbar-inner');
    const search = document.querySelector('.top-search');
    if (topbar && search && !document.querySelector('#server-live-pill')) {
      search.insertAdjacentHTML('beforebegin', `
        <button class="server-live-pill" id="server-live-pill" type="button" aria-label="Ver jogadores online">
          <i></i><span id="server-live-pill-copy">Servidor</span>
        </button>`);
    }

    const feedTabs = document.querySelector('.feed-tabs');
    if (feedTabs && !feedTabs.querySelector('[data-tab="saved"]')) {
      feedTabs.insertAdjacentHTML('beforeend', `
        <button class="tab" role="tab" aria-selected="false" data-tab="saved">Salvos</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="trending">Em alta</button>`);
    }
    const rail = document.querySelector('.rail-nav');
    if (rail && !rail.querySelector('[data-filter="saved"]')) {
      rail.insertAdjacentHTML('beforeend', `
        <button class="rnav-item" data-filter="saved"><span aria-hidden="true">◇</span> Salvos</button>
        <button class="rnav-item" data-filter="trending"><span aria-hidden="true">↗</span> Em alta</button>`);
    }
    const drawer = document.querySelector('.mobile-drawer-nav');
    if (drawer && !drawer.querySelector('[data-drawer-filter="saved"]')) {
      drawer.insertAdjacentHTML('beforeend', `
        <button class="mobile-drawer-item" type="button" data-drawer-filter="saved"><span aria-hidden="true">◇</span><span>Salvos</span></button>
        <button class="mobile-drawer-item" type="button" data-drawer-filter="trending"><span aria-hidden="true">↗</span><span>Em alta</span></button>`);
    }

    const friends = document.querySelector('#friends-bar');
    if (friends && !document.querySelector('#stories-shell')) {
      friends.insertAdjacentHTML('beforebegin', `
        <section class="stories-shell social-strip" id="stories-shell" aria-label="Stories">
          <div class="stories-list" id="stories-list"><div class="social-strip-skeleton skel"></div><div class="social-strip-skeleton skel"></div><div class="social-strip-skeleton skel"></div></div>
        </section>`);
      friends.remove();
    }

    const right = document.querySelector('.right-panel');
    if (right && !document.querySelector('#server-live-card')) {
      right.insertAdjacentHTML('afterbegin', `
        <section class="card panel-card server-live-card" id="server-live-card">
          <div class="panel-head"><h2 class="server-live-title"><i class="live-dot"></i> Servidor ao vivo</h2><strong id="server-live-count">Pulso</strong></div>
          <div class="live-player-stack" id="live-player-stack"></div>
          <p id="server-live-copy">Aguardando sinal do servidor...</p>
          <div class="server-timeline" id="server-timeline" aria-label="Atividade nas últimas 24 horas"></div>
        </section>`);
    }

    if (!document.querySelector('#pull-indicator')) {
      document.body.insertAdjacentHTML('beforeend', '<div class="pull-indicator" id="pull-indicator">Puxe para atualizar</div>');
    }
    if (!document.querySelector('#story-viewer')) {
      document.body.insertAdjacentHTML('beforeend', `
        <section class="story-viewer" id="story-viewer" hidden aria-label="Visualizador de stories">
          <button class="story-nav prev" type="button" data-story-prev aria-label="Story anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
          <div class="story-stage">
            <div class="story-progress" id="story-progress"></div>
            <div class="story-viewer-head" data-story-profile role="button" tabindex="0" aria-label="Abrir perfil">
              <img id="story-viewer-av" alt="">
              <div class="story-viewer-meta"><strong id="story-viewer-name"></strong><span id="story-viewer-time"></span></div>
              <div class="story-viewer-actions">
                <button class="story-share" type="button" data-story-share aria-label="Compartilhar story" title="Compartilhar story"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg></button>
                <button class="story-delete" type="button" data-story-delete aria-label="Apagar seu story" title="Apagar story" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg></button>
                <button type="button" data-story-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </div>
            </div>
            <img id="story-viewer-media" alt="Story">
            <p class="story-content" id="story-viewer-content" hidden></p>
            <div class="story-gesture-feedback" id="story-gesture-feedback" aria-hidden="true"><span></span></div>
            <div class="story-reaction-burst" id="story-reaction-burst" aria-hidden="true"></div>
            <button class="story-owner-stats" id="story-owner-stats" type="button" data-story-viewers hidden><span class="story-owner-avatars" id="story-owner-avatars"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span id="story-view-count"></span></button>
            <form class="story-reply-bar" id="story-reply-bar" data-story-reply hidden>
              <input id="story-reply-input" maxlength="500" autocomplete="off" placeholder="Enviar mensagem..." aria-label="Responder ao story">
              <button class="story-reaction-open" type="button" data-story-reactions aria-label="Reagir ao story" aria-expanded="false">☺</button>
              <button class="story-like" type="button" data-story-like aria-label="Curtir story" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg></button>
              <button class="story-reply-send" type="submit" aria-label="Enviar resposta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button>
            </form>
            <div class="story-reaction-tray" id="story-reaction-tray" hidden>${Object.entries(REACTIONS).map(([code, meta]) => `<button type="button" data-story-reaction="${code}" aria-label="${safe(meta[1])}">${meta[0]}<span>${safe(meta[1])}</span></button>`).join('')}</div>
            <div class="story-pause-indicator" id="story-pause-indicator" hidden><i></i><i></i></div>
            <button class="story-hit" type="button" data-story-prev aria-label="Anterior"></button>
            <button class="story-hit next" type="button" data-story-next aria-label="Próximo"></button>
          </div>
          <button class="story-nav next" type="button" data-story-next aria-label="Próximo story"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>
        </section>`);
    }
    addSchedulePresets();
  }

  function isGuestExperience() {
    return document.body.classList.contains('guest-mode') || !(typeof token !== 'undefined' && token);
  }

  function sheetOverlayOpen() {
    return Boolean(document.querySelector('.backdrop.show,.social-sheet-overlay.show'));
  }

  function stabilizeFeedLayout() {
    const feed = document.querySelector('#feed-col');
    const header = feed?.querySelector('.col-header');
    const stories = document.querySelector('#stories-shell');
    if (feed && header && stories && stories.parentElement === feed && stories.previousElementSibling !== header) {
      header.insertAdjacentElement('afterend', stories);
    }
    if (stories) stories.dataset.evoReady = '1';

    const guest = isGuestExperience();
    document.body.classList.toggle('community-guest-clean', guest);
    document.querySelectorAll('[data-tab="saved"],[data-filter="saved"],[data-drawer-filter="saved"]').forEach(node => { node.hidden = guest; });
    if (!guest) return;

    document.querySelector('.profile-mini')?.classList.add('is-guest-card');
    const playerList = document.querySelector('#player-list');
    if (playerList && (playerList.querySelector('.skel') || !playerList.textContent.trim())) {
      playerList.innerHTML = '<div class="guest-panel-empty"><strong>Rede reservada</strong><span>Entre para ver jogadores, amigos e perfis recomendados.</span></div>';
    }
    const liveCount = document.querySelector('#server-live-count');
    if (liveCount && liveCount.textContent.trim() === '--') liveCount.textContent = 'Pulso';
    const liveCopy = document.querySelector('#server-live-copy');
    if (liveCopy && /Consultando/i.test(liveCopy.textContent || '')) liveCopy.textContent = 'Aguardando sinal do servidor...';
  }

  function updateFilterContext() {
    const header = document.querySelector('.col-header > div:first-child');
    if (!header) return;
    header.querySelector('.feed-context-chip')?.remove();
    const labels = { saved: 'Posts salvos', trending: 'Em alta nas últimas 24 horas' };
    const text = state.hashtag ? `#${state.hashtag}` : labels[state.filter];
    if (!text) return;
    header.insertAdjacentHTML('beforeend', `<span class="feed-context-chip">${safe(text)} <button type="button" data-clear-feed-context aria-label="Limpar filtro">×</button></span>`);
  }

  function dateLabel(value) {
    const date = new Date(value);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const delta = Math.round((start - day) / 86400000);
    if (delta === 0) return 'Hoje';
    if (delta === 1) return 'Ontem';
    return date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  }

  function formatMarkdown(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('a,button,strong,em,code')) nodes.push(node);
    }
    nodes.forEach(node => {
      const value = node.nodeValue || '';
      if (!/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/.test(value)) return;
      const template = document.createElement('template');
      template.innerHTML = safe(value)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      node.replaceWith(template.content);
    });
  }

  function decorateFeed() {
    if (decorating) return;
    decorating = true;
    updateFilterContext();
    const list = document.querySelector('#feed-list');
    if (!list) { decorating = false; return; }
    list.querySelectorAll('.date-separator').forEach(node => node.remove());
    list.querySelectorAll('.post-card').forEach(card => {
      const post = postForCard(card);
      const timestamp = card.querySelector('.post-time');
      if (timestamp && post?.created_at) {
        timestamp.dataset.relative = time(post.created_at);
        timestamp.dataset.absolute = new Date(post.created_at).toLocaleString('pt-BR');
        timestamp.title = timestamp.dataset.absolute;
      }
      card.querySelectorAll('.pa-like,.pa-save,.pa-repost').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('is-on'))));
      card.querySelectorAll('.post-content').forEach(formatMarkdown);
      card.querySelectorAll('.reaction-wrap,.reaction-summary').forEach(node => node.remove());
      card.querySelectorAll('.post-media img').forEach(img => {
        if (!img.width) img.width = 900;
        if (!img.height) img.height = 700;
      });
      card.querySelectorAll('.av42-sq,.preview-row-av').forEach(img => {
        if (!img.width) img.width = 50;
        if (!img.height) img.height = 50;
        img.decoding = 'async';
      });
      decorateFeedStoryAvatars(card);
      const author = displayName(post);
      card.querySelector('.pa-like')?.setAttribute('aria-label', `${card.querySelector('.pa-like')?.classList.contains('is-on') ? 'Descurtir' : 'Curtir'} post de ${author}`);
      card.querySelector('.pa-comment')?.setAttribute('aria-label', `Abrir comentários do post de ${author}`);
      card.querySelector('.pa-repost')?.setAttribute('aria-label', `Repostar post de ${author}`);
      card.querySelector('.pa-save')?.setAttribute('aria-label', `Salvar post de ${author}`);
    });
    document.querySelectorAll('.follow-btn,[data-pf-follow]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.on === '1')));
    decorateProfilePresence();
    setTimeout(() => { decorating = false; }, 0);
  }

  function rebuildStoryUsers() {
    storyUsers = new Map();
    storyGroups.forEach((group, groupIndex) => {
      const first = group?.[0];
      if (!first?.user_id) return;
      const firstUnseen = group.findIndex(story => !story.viewed_by_me);
      storyUsers.set(String(first.user_id), {
        groupIndex,
        firstUnseen,
        hasUnseen: firstUnseen >= 0,
      });
    });
  }

  function decorateFeedStoryAvatars(root = document) {
    root.querySelectorAll?.('.post-card .post-av-col img.js-profile,#thread-hero .post-layout > img.js-profile').forEach(img => {
      const uid = img.dataset.uid || '';
      const storyMeta = uid ? storyUsers.get(String(uid)) : null;
      img.classList.remove('feed-story-avatar', 'has-unseen-story');
      delete img.dataset.feedStoryUser;
      img.removeAttribute('title');
      if (!storyMeta) return;
      img.classList.add('feed-story-avatar');
      img.dataset.feedStoryUser = String(uid);
      img.title = storyMeta.hasUnseen ? 'Ver story' : 'Rever story';
      if (storyMeta.hasUnseen) img.classList.add('has-unseen-story');
    });
  }

  window.openFeedStoryByUser = function openFeedStoryByUser(userId) {
    const storyMeta = storyUsers.get(String(userId || ''));
    if (!storyMeta) return false;
    const startIndex = storyMeta.firstUnseen >= 0 ? storyMeta.firstUnseen : 0;
    openStory(storyMeta.groupIndex, startIndex);
    return true;
  };

  async function decorateProfilePresence() {
    const hero = document.querySelector('#route-col .profile-hero');
    const profile = state.profileData?.profile;
    if (!hero || !profile?.id || hero.dataset.presenceLoaded) return;
    hero.dataset.presenceLoaded = '1';
    try {
      const presence = await api(`/api/community/player/${encodeURIComponent(profile.id)}/web-presence`);
      const target = hero.querySelector('.profile-activity-chips');
      if (!target) return;
      const online = Boolean(presence.is_online);
      const copy = online ? 'Online na comunidade' : presence.last_seen_at ? `Visto ${time(presence.last_seen_at)}` : 'Offline na comunidade';
      target.insertAdjacentHTML('beforeend', `<span class="web-presence-chip ${online ? 'is-online' : ''}"><i class="live-dot"></i>${safe(copy)}</span>`);
    } catch {}
  }

  function scheduleDecorate() {
    if (decorating) return;
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateFeed, 45);
  }

  function restorePendingCommentFocus() {
    if (!pendingCommentFocus) return;
    const target = document.querySelector(`#route-col [data-comment-id="${CSS.escape(String(pendingCommentFocus))}"]`);
    if (!target) return;
    pendingCommentFocus = null;
    target.classList.add('is-return-focus');
    target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
    setTimeout(() => {
      target.classList.remove('is-return-focus');
      target.removeAttribute('tabindex');
    }, 2400);
  }

  async function loadStories() {
    const list = document.querySelector('#stories-list');
    if (!list) return;
    if (!token) {
      storyUsers = new Map();
      decorateFeedStoryAvatars();
      list.innerHTML = `<button class="story-item story-action story-action-story" type="button" data-story-add><span class="story-action-circle">+</span><span class="story-label">Novo story</span></button>
        <button class="story-item story-action story-action-friend" type="button" data-social-add-friend><span class="story-action-circle">+</span><span class="story-label">Adicionar</span></button>
        <span class="social-strip-error">Entre para ver stories e amigos.</span>`;
      const meta = document.querySelector('#social-strip-meta');
      if (meta) meta.textContent = 'Login necessario';
      return;
    }
    try {
      const [payload, friendsPayload] = await Promise.all([
        api('/api/community/stories'),
        api('/api/me/friends?limit=250').catch(() => ({ rows: [] })),
      ]);
      const groups = new Map();
      (payload.stories || []).forEach(story => {
        if (locallyViewedStories.has(String(story.id))) story.viewed_by_me = true;
        if (!groups.has(String(story.user_id))) groups.set(String(story.user_id), []);
        groups.get(String(story.user_id)).push(story);
      });
      groups.forEach(group => group.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)));
      const mine = state.me || {};
      const allGroups = [...groups.values()];
      const myGroup = allGroups.find(group => Number(group[0]?.user_id) === Number(mine.id));
      const otherGroups = allGroups.filter(group => group !== myGroup);
      const unseenGroups = otherGroups.filter(group => group.some(row => !row.viewed_by_me));
      const viewedGroups = otherGroups.filter(group => group.every(row => row.viewed_by_me));
      storyGroups = [...(myGroup ? [myGroup] : []), ...unseenGroups, ...viewedGroups];
      rebuildStoryUsers();
      const friends = Array.isArray(friendsPayload.rows) ? friendsPayload.rows : [];
      const storyUserIds = new Set(storyGroups.map(group => String(group[0]?.user_id)));
      const friendsWithoutStories = friends.filter(friend => !storyUserIds.has(String(friend.id)));
      const myGroupIndex = storyGroups.findIndex(group => Number(group[0]?.user_id) === Number(mine.id));
      const myStoryItem = myGroupIndex >= 0
        ? `<div class="story-item is-own">
            <button class="story-ring-button" type="button" data-story-group="${myGroupIndex}" aria-label="Ver seu story">
              <span class="story-ring"><img class="story-avatar-img" width="64" height="64" src="${safe(avatar(mine, 60))}" alt="" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(mine),60))}'"></span>
              <span class="story-label">Seu story</span>
              <span class="story-state-label">Atividade</span>
            </button>
          </div>`
        : '';
      const addStory = `<button class="story-item story-action story-action-story" type="button" data-story-add aria-label="Adicionar story">
        <span class="story-action-circle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3l1.4-1.8h2.2L14.5 5h3A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z"/><circle cx="12" cy="12" r="3.2"/><path d="M18.5 3v4M16.5 5h4"/></svg></span>
        <span class="story-label">Novo story</span><span class="story-state-label">Compartilhar</span>
      </button>`;
      const addFriend = `<button class="story-item story-action story-action-friend" type="button" data-social-add-friend aria-label="Adicionar amigo">
        <span class="story-action-circle"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.5-3.5 2.4-5.2 5.5-5.2s5 1.7 5.5 5.2M18 7v6M15 10h6"/></svg></span>
        <span class="story-label">Adicionar</span><span class="story-state-label">Amigo</span>
      </button>`;
      const storyItems = storyGroups.map((group, index) => {
        if (index === myGroupIndex) return '';
        const first = group[0];
        const viewed = group.every(row => row.viewed_by_me);
        return `<button class="story-item ${viewed ? 'is-viewed' : 'is-unseen'}" type="button" data-story-group="${index}" aria-label="${viewed ? 'Rever' : 'Ver novo'} story de ${safe(displayName(first))}">
          <span class="story-ring"><img class="story-avatar-img" width="64" height="64" src="${safe(avatar(first, 60))}" alt="${safe(displayName(first))}" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(first),60))}'"></span>
          <span class="story-label">${safe(displayName(first))}</span><span class="story-state-label">${viewed ? 'Visto' : 'Novo story'}</span>
        </button>`;
      }).join('');
      const friendItems = friendsWithoutStories.map(friend => {
        const name = displayName(friend);
        const mc = friend.minecraft_name || friend.username || '';
        return `<button class="story-item social-friend js-profile" type="button" data-uid="${safe(friend.id)}" data-mc="${safe(mc)}" aria-label="Abrir perfil de ${safe(name)}">
          <span class="story-ring"><img class="story-avatar-img" width="64" height="64" src="${safe(avatar(friend, 60))}" alt="${safe(name)}" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(name,60))}'">${friend.is_online ? '<i class="social-online-dot" aria-label="Online"></i>' : ''}</span>
          <span class="story-label">${safe(name)}</span><span class="story-state-label">${friend.is_online ? 'Online' : 'Amigo'}</span>
        </button>`;
      }).join('');
      list.innerHTML = `
        ${addStory}${addFriend}${myStoryItem}${storyItems}${friendItems}`;
      decorateFeedStoryAvatars();
      const meta = document.querySelector('#social-strip-meta');
      if (meta) meta.textContent = `${unseenGroups.length} novo${unseenGroups.length === 1 ? '' : 's'} · ${friends.length} amigo${friends.length === 1 ? '' : 's'}`;
    } catch {
      storyUsers = new Map();
      decorateFeedStoryAvatars();
      list.innerHTML = `<button class="story-item story-action story-action-story" type="button" data-story-add><span class="story-action-circle">+</span><span class="story-label">Novo story</span></button>
        <button class="story-item story-action story-action-friend" type="button" data-social-add-friend><span class="story-action-circle">+</span><span class="story-label">Adicionar</span></button>
        <span class="social-strip-error">Não foi possível atualizar amigos e stories.</span>`;
    } finally {
      if (!token) {
        storyUsers = new Map();
        decorateFeedStoryAvatars();
        const meta = document.querySelector('#social-strip-meta');
        if (meta) meta.textContent = 'Login necessario';
        const error = list.querySelector('.social-strip-error');
        if (error) error.textContent = 'Entre para ver stories e amigos.';
      }
    }
  }

  async function createStory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      const back = document.createElement('div');
      back.className = 'backdrop show';
      back.innerHTML = `
        <div class="sheet story-composer-sheet" role="dialog" aria-modal="true" aria-labelledby="story-composer-title">
          <div class="sheet-header">
            <div><h2 id="story-composer-title">Novo story</h2><p class="schedule-subtitle">Compartilhe um momento que desaparece em 24 horas.</p></div>
            <button class="close-btn" type="button" data-story-compose-cancel aria-label="Fechar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </div>
          <div class="story-composer-body">
            <div class="story-composer-preview"><img src="${safe(previewUrl)}" alt="Prévia do story"></div>
            <div class="story-composer-options">
              <label>Legenda opcional<textarea maxlength="280" data-story-caption placeholder="Escreva algo sobre este momento..."></textarea></label>
              <p class="story-composer-tip">A imagem será otimizada antes da publicação. Somente seus seguidores verão este story.</p>
            </div>
          </div>
          <div class="sheet-footer">
            <button class="btn btn-secondary" type="button" data-story-compose-cancel>Cancelar</button>
            <button class="btn btn-primary" type="button" data-story-compose-publish>Compartilhar story</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      document.body.classList.add('modal-open');
      const close = () => {
        URL.revokeObjectURL(previewUrl);
        back.remove();
        if (!document.querySelectorAll('.backdrop.show').length) document.body.classList.remove('modal-open');
      };
      back.addEventListener('click', async event => {
        if (event.target === back || event.target.closest('[data-story-compose-cancel]')) { close(); return; }
        const publish = event.target.closest('[data-story-compose-publish]');
        if (!publish) return;
        setBtnLoad(publish, true, 'Publicando');
        try {
          const processed = await smartCompress(file, IMG_COMPRESS_PRESETS.post);
          await assertSafeImage(processed, 'inline');
          const form = new FormData();
          form.append('media', processed, `story-${Date.now()}.webp`);
          const upload = await api('/api/community/upload', { method: 'POST', body: form, timeoutMs: 90000 });
          const mediaUrl = upload.urls?.[0];
          if (!mediaUrl) throw new Error('Upload incompleto.');
          const content = back.querySelector('[data-story-caption]')?.value.trim() || '';
          await api('/api/community/stories', { method: 'POST', body: JSON.stringify({ media_url: mediaUrl, content }) });
          close();
          buzz(25);
          toast('success', 'Story publicado', 'Ele ficará visível por 24 horas.');
          await loadStories();
        } catch (error) {
          setBtnLoad(publish, false, 'Compartilhar story');
          toast('error', 'Não foi possível publicar', error.message);
        }
      });
    };
    input.click();
  }

  function storyFilterCSS(filter = 'normal') {
    switch (filter) {
      case 'warm': return 'saturate(1.18) contrast(1.06) sepia(.14)';
      case 'cinema': return 'contrast(1.18) saturate(.92) brightness(.94)';
      case 'dream': return 'saturate(1.12) brightness(1.08) blur(.2px)';
      case 'noir': return 'grayscale(1) contrast(1.14) brightness(.96)';
      default: return 'none';
    }
  }

  function imageBitmapFromFile(file) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem invalida.')); };
      image.src = url;
    });
  }

  async function renderStoryBlob(file, { scale = 1, rotation = 0, filter = 'normal' } = {}) {
    const source = await imageBitmapFromFile(file);
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d', { alpha: false });
    const sourceWidth = source.width || source.naturalWidth || 1080;
    const sourceHeight = source.height || source.naturalHeight || 1920;
    const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const effectiveWidth = rotated ? sourceHeight : sourceWidth;
    const effectiveHeight = rotated ? sourceWidth : sourceHeight;
    const cover = Math.max(canvas.width / effectiveWidth, canvas.height / effectiveHeight) * Math.max(1, Number(scale) || 1);

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.filter = storyFilterCSS(filter);
    ctx.drawImage(source, -sourceWidth * cover / 2, -sourceHeight * cover / 2, sourceWidth * cover, sourceHeight * cover);
    ctx.restore();
    if (typeof source.close === 'function') source.close();

    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png', .95));
  }

  async function createStory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      let zoom = 1;
      let rotation = 0;
      let filter = 'normal';
      const back = document.createElement('div');
      back.className = 'backdrop show story-camera-backdrop';
      back.innerHTML = `
        <div class="sheet story-camera-sheet" role="dialog" aria-modal="true" aria-labelledby="story-composer-title">
          <div class="story-camera-head" data-sheet-drag-handle>
            <button class="story-camera-icon" type="button" data-story-compose-cancel aria-label="Fechar"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            <div><h2 id="story-composer-title">Novo story</h2><p>Edite como uma camera antes de publicar.</p></div>
            <button class="story-camera-icon" type="button" data-story-compose-repick aria-label="Trocar imagem"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5M3 12A9 9 0 0 1 18.5 5.8L21 8M21 3v5h-5"/></svg></button>
          </div>
          <div class="story-camera-body">
            <div class="story-camera-frame" aria-label="Previa do story">
              <img src="${safe(previewUrl)}" alt="Previa do story" data-story-preview>
              <div class="story-camera-glow" aria-hidden="true"></div>
              <div class="story-camera-hint"><span>Arraste o zoom e gire para enquadrar</span></div>
            </div>
            <aside class="story-camera-controls">
              <label class="story-caption-field"><span>Legenda</span><textarea maxlength="280" data-story-caption placeholder="Escreva algo rapido..."></textarea></label>
              <label class="story-zoom-field"><span>Zoom</span><input type="range" min="1" max="2.4" value="1" step=".02" data-story-zoom></label>
              <div class="story-camera-actions" role="group" aria-label="Ajustes do story">
                <button type="button" data-story-rotate="-90">Girar esquerda</button>
                <button type="button" data-story-rotate="90">Girar direita</button>
              </div>
              <div class="story-filter-row" role="group" aria-label="Filtros">
                <button type="button" class="is-on" data-story-filter="normal">Original</button>
                <button type="button" data-story-filter="warm">Quente</button>
                <button type="button" data-story-filter="cinema">Cinema</button>
                <button type="button" data-story-filter="dream">Dream</button>
                <button type="button" data-story-filter="noir">Noir</button>
              </div>
              <p class="story-camera-tip">A publicacao sai em formato 9:16, otimizada e visivel por 24 horas.</p>
            </aside>
          </div>
          <div class="story-camera-footer">
            <button class="btn btn-secondary" type="button" data-story-compose-cancel>Cancelar</button>
            <button class="btn btn-primary" type="button" data-story-compose-publish>Compartilhar story</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      document.body.classList.add('modal-open');
      window.prepareDraggableSheets?.(back);
      const preview = back.querySelector('[data-story-preview]');
      const syncPreview = () => {
        if (!preview) return;
        preview.style.transform = `scale(${zoom}) rotate(${rotation}deg)`;
        preview.style.filter = storyFilterCSS(filter);
      };
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        URL.revokeObjectURL(previewUrl);
        if (!document.querySelectorAll('.backdrop.show').length) document.body.classList.remove('modal-open');
      };
      const close = () => {
        if (window.closeEphemeralSheet) window.closeEphemeralSheet(back, cleanup);
        else { back.remove(); cleanup(); }
      };
      back._sheetClose = close;
      back.addEventListener('input', event => {
        if (!event.target.matches('[data-story-zoom]')) return;
        zoom = Number(event.target.value || 1);
        syncPreview();
      });
      back.addEventListener('click', async event => {
        if (event.target === back || event.target.closest('[data-story-compose-cancel]')) { close(); return; }
        if (event.target.closest('[data-story-compose-repick]')) { close(); createStory(); return; }
        const rotateButton = event.target.closest('[data-story-rotate]');
        if (rotateButton) {
          rotation = (rotation + Number(rotateButton.dataset.storyRotate || 0)) % 360;
          buzz(12);
          syncPreview();
          return;
        }
        const filterButton = event.target.closest('[data-story-filter]');
        if (filterButton) {
          filter = filterButton.dataset.storyFilter || 'normal';
          back.querySelectorAll('[data-story-filter]').forEach(button => button.classList.toggle('is-on', button === filterButton));
          syncPreview();
          return;
        }
        const publish = event.target.closest('[data-story-compose-publish]');
        if (!publish) return;
        setBtnLoad(publish, true, 'Publicando');
        try {
          const rendered = await renderStoryBlob(file, { scale: zoom, rotation, filter });
          const storyFile = rendered ? new File([rendered], `story-source-${Date.now()}.png`, { type: 'image/png' }) : file;
          const preset = (typeof IMG_COMPRESS_PRESETS !== 'undefined' && (IMG_COMPRESS_PRESETS.story || IMG_COMPRESS_PRESETS.post)) || { maxSizeMB: .65, maxWidthOrHeight: 1920, initialQuality: .9 };
          const processed = await smartCompress(storyFile, preset);
          await assertSafeImage(processed, 'story');
          const form = new FormData();
          form.append('media', processed, `story-${Date.now()}.webp`);
          const upload = await api('/api/community/upload', { method: 'POST', body: form, timeoutMs: 90000 });
          const mediaUrl = upload.urls?.[0];
          if (!mediaUrl) throw new Error('Upload incompleto.');
          const content = back.querySelector('[data-story-caption]')?.value.trim() || '';
          await api('/api/community/stories', { method: 'POST', body: JSON.stringify({ media_url: mediaUrl, content }) });
          close();
          buzz(25);
          toast('success', 'Story publicado', 'Ele ficara visivel por 24 horas.');
          await loadStories();
        } catch (error) {
          setBtnLoad(publish, false, 'Compartilhar story');
          toast('error', 'Nao foi possivel publicar', error.message);
        }
      });
      syncPreview();
    };
    input.click();
  }

  function openStory(groupIndex, storyIndex = 0) {
    if (!storyGroups[groupIndex]?.[storyIndex]) return;
    activeStoryGroup = groupIndex;
    activeStoryIndex = storyIndex;
    const group = storyGroups[groupIndex];
    const story = group[storyIndex];
    const viewer = document.querySelector('#story-viewer');
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    document.querySelector('#story-viewer-media').src = story.media_url;
    const storyAvatar = document.querySelector('#story-viewer-av');
    storyAvatar.onerror = () => { storyAvatar.onerror = null; storyAvatar.src = fallbackAvatar(displayName(story), 60); };
    storyAvatar.src = avatar(story, 60);
    document.querySelector('#story-viewer-name').textContent = displayName(story);
    document.querySelector('#story-viewer-time').textContent = time(story.created_at);
    const profileLink = document.querySelector('[data-story-profile]');
    if (profileLink) {
      profileLink.dataset.uid = String(story.user_id || '');
      profileLink.dataset.mc = String(story.minecraft_name || story.username || '');
      profileLink.setAttribute('aria-label', `Abrir perfil de ${displayName(story)}`);
    }
    const content = document.querySelector('#story-viewer-content');
    content.textContent = story.content || '';
    content.hidden = !story.content;
    const isOwner = Number(story.user_id) === Number(state.me?.id);
    const deleteButton = document.querySelector('[data-story-delete]');
    if (deleteButton) deleteButton.hidden = !isOwner;
    const ownerStats = document.querySelector('#story-owner-stats');
    if (ownerStats) ownerStats.hidden = !isOwner;
    const replyBar = document.querySelector('#story-reply-bar');
    if (replyBar) replyBar.hidden = isOwner;
    const replyInput = document.querySelector('#story-reply-input');
    if (replyInput) replyInput.value = '';
    const liked = story.my_reaction === 'heart';
    const like = document.querySelector('[data-story-like]');
    like?.classList.toggle('is-on', liked);
    like?.setAttribute('aria-pressed', String(liked));
    like?.setAttribute('aria-label', liked ? 'Remover curtida do story' : 'Curtir story');
    const tray = document.querySelector('#story-reaction-tray');
    if (tray) tray.hidden = true;
    tray?.querySelectorAll('[data-story-reaction]').forEach(button => button.classList.toggle('is-on', button.dataset.storyReaction === story.my_reaction));
    document.querySelector('[data-story-reactions]')?.setAttribute('aria-expanded', 'false');
    document.querySelector('#story-pause-indicator')?.setAttribute('hidden', '');
    const stage = document.querySelector('.story-stage');
    if (stage) {
      stage.style.transform = '';
      stage.style.opacity = '';
      stage.classList.remove('is-gesturing');
    }
    const viewCount = document.querySelector('#story-view-count');
    if (viewCount) viewCount.textContent = `${Number(story.views_count || 0)} visualiza${Number(story.views_count || 0) === 1 ? 'ção' : 'ções'}`;
    document.querySelector('#story-progress').innerHTML = group.map((_, index) =>
      `<i style="--progress:${index < storyIndex ? '100%' : '0%'}"></i>`).join('');
    api(`/api/community/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' }).catch(() => {});
    if (!isOwner) {
      story.viewed_by_me = true;
      locallyViewedStories.add(String(story.id));
      rebuildStoryUsers();
      decorateFeedStoryAvatars();
    }
    if (isOwner) loadStoryViewerPreview(story.id);
    clearInterval(storyTimer);
    cancelAnimationFrame(storyFrame);
    storyElapsed = 0;
    storyPaused = false;
    let previousFrame = performance.now();
    const tick = now => {
      if (!storyPaused && !document.hidden) storyElapsed += Math.max(0, now - previousFrame);
      previousFrame = now;
      const bar = document.querySelectorAll('#story-progress i')[storyIndex];
      bar?.style.setProperty('--progress', `${Math.min(100, storyElapsed / 50)}%`);
      if (storyElapsed >= 5000) {
        nextStory();
        return;
      }
      storyFrame = requestAnimationFrame(tick);
    };
    storyFrame = requestAnimationFrame(tick);
  }

  function activeStory() {
    return storyGroups[activeStoryGroup]?.[activeStoryIndex] || null;
  }

  function storyFeedback(copy, tone = '') {
    const node = document.querySelector('#story-gesture-feedback');
    if (!node) return;
    node.className = `story-gesture-feedback show ${tone}`.trim();
    node.querySelector('span').textContent = copy;
    clearTimeout(storyFeedback.timer);
    storyFeedback.timer = setTimeout(() => { node.className = 'story-gesture-feedback'; }, 650);
  }

  function storyBurst(symbol = '♥') {
    const root = document.querySelector('#story-reaction-burst');
    if (!root) return;
    root.innerHTML = Array.from({ length: 9 }, (_, index) => `<i style="--i:${index};--x:${Math.round((Math.random() - .5) * 150)}px;--y:${-60 - Math.round(Math.random() * 120)}px">${symbol}</i>`).join('');
    root.classList.remove('show');
    void root.offsetWidth;
    root.classList.add('show');
    setTimeout(() => { root.classList.remove('show'); root.innerHTML = ''; }, 900);
  }

  async function reactToStory(code, { quiet = false } = {}) {
    const story = activeStory();
    if (!story || Number(story.user_id) === Number(state.me?.id)) return;
    const previous = story.my_reaction || null;
    const remove = previous === code;
    story.my_reaction = remove ? null : code;
    const like = document.querySelector('[data-story-like]');
    like?.classList.toggle('is-on', story.my_reaction === 'heart');
    like?.setAttribute('aria-pressed', String(story.my_reaction === 'heart'));
    document.querySelector('#story-reaction-tray')?.querySelectorAll('[data-story-reaction]').forEach(button => button.classList.toggle('is-on', button.dataset.storyReaction === story.my_reaction));
    if (!remove) {
      buzz(code === 'heart' ? [12, 35, 12] : 18);
      storyBurst(REACTIONS[code]?.[0] || '♥');
      if (!quiet) storyFeedback(`${REACTIONS[code]?.[1] || 'Reação'} enviada`, 'success');
    }
    try {
      await api(`/api/community/stories/${encodeURIComponent(story.id)}/reactions`, {
        method: remove ? 'DELETE' : 'POST',
        body: remove ? undefined : JSON.stringify({ code }),
      });
    } catch (error) {
      story.my_reaction = previous;
      like?.classList.toggle('is-on', previous === 'heart');
      like?.setAttribute('aria-pressed', String(previous === 'heart'));
      toast('error', 'Reação não enviada', error.message);
    }
  }

  async function replyToStory(message) {
    const story = activeStory();
    const text = String(message || '').trim();
    if (!story || !text || storyReplySending || Number(story.user_id) === Number(state.me?.id)) return;
    storyReplySending = true;
    storyPaused = true;
    const send = document.querySelector('.story-reply-send');
    if (send) send.disabled = true;
    try {
      if (!window.FAChat?.openWithUser) throw new Error('Chat indisponível neste momento.');
      const storyUrl = new URL(communityUrl({ story: story.id }), location.href).href;
      await window.FAChat.openWithUser(
        { id: story.user_id, minecraft_name: story.minecraft_name, username: story.username },
        { draft: `Resposta ao seu story: ${text}\n${storyUrl}`, sendNow: true },
      );
      document.querySelector('#story-reply-input').value = '';
      storyFeedback('Mensagem enviada', 'success');
      buzz([10, 45, 10]);
      setTimeout(closeStory, 500);
    } catch (error) {
      toast('error', 'Resposta não enviada', error.message);
    } finally {
      storyReplySending = false;
      storyPaused = false;
      if (send) send.disabled = false;
    }
  }

  async function loadStoryViewerPreview(storyId) {
    const avatars = document.querySelector('#story-owner-avatars');
    if (!avatars) return;
    try {
      const payload = await api(`/api/community/stories/${encodeURIComponent(storyId)}/viewers`);
      avatars.innerHTML = (payload.viewers || []).slice(0, 3).map(person => `<img src="${safe(avatar(person, 32))}" alt="" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(person),32))}'">`).join('');
    } catch { avatars.innerHTML = ''; }
  }

  async function openStoryViewers() {
    const story = activeStory();
    if (!story || Number(story.user_id) !== Number(state.me?.id)) return;
    storyPaused = true;
    const back = document.createElement('div');
    back.className = 'backdrop show story-viewers-backdrop';
    back.innerHTML = `<section class="sheet story-viewers-sheet" role="dialog" aria-modal="true" aria-labelledby="story-viewers-title">
      <div class="sheet-header"><div><h2 id="story-viewers-title">Atividade do story</h2><p class="schedule-subtitle">Visualizações e reações em tempo real.</p></div><button class="close-btn" data-story-viewers-close aria-label="Fechar">×</button></div>
      <div class="story-viewers-list"><div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div></div>
    </section>`;
    document.body.appendChild(back);
    window.prepareDraggableSheets?.(back);
    const finishClose = () => { storyPaused = false; };
    const close = () => {
      if (window.closeEphemeralSheet) window.closeEphemeralSheet(back, finishClose);
      else { back.remove(); finishClose(); }
    };
    back._sheetClose = close;
    back.addEventListener('click', event => { if (event.target === back || event.target.closest('[data-story-viewers-close],.story-viewer-row')) close(); });
    try {
      const payload = await api(`/api/community/stories/${encodeURIComponent(story.id)}/viewers`);
      const rows = payload.viewers || [];
      back.querySelector('.story-viewers-list').innerHTML = rows.length ? rows.map(person => `
        <button class="story-viewer-row js-profile" type="button" data-uid="${safe(person.id)}" data-mc="${safe(person.minecraft_name || person.username)}">
          <img src="${safe(avatar(person, 50))}" alt="" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(person),50))}'"><span><strong>${safe(displayName(person))}</strong><small>Viu ${safe(time(person.viewed_at))}</small></span>${person.reaction ? `<b title="${safe(REACTIONS[person.reaction]?.[1] || 'Reagiu')}">${REACTIONS[person.reaction]?.[0] || '♥'}</b>` : ''}
        </button>`).join('') : '<div class="story-viewers-empty"><strong>Ainda sem visualizações</strong><span>As pessoas que assistirem aparecerão aqui.</span></div>';
    } catch (error) {
      back.querySelector('.story-viewers-list').innerHTML = `<div class="story-viewers-empty"><strong>Não foi possível carregar</strong><span>${safe(error.message)}</span></div>`;
    }
  }

  function closeStory() {
    clearInterval(storyTimer);
    cancelAnimationFrame(storyFrame);
    storyFrame = null;
    const viewer = document.querySelector('#story-viewer');
    if (viewer) viewer.hidden = true;
    document.querySelector('#story-reaction-tray')?.setAttribute('hidden', '');
    document.querySelector('#story-pause-indicator')?.setAttribute('hidden', '');
    const stage = document.querySelector('.story-stage');
    if (stage) {
      stage.style.transform = '';
      stage.style.opacity = '';
      stage.style.transition = '';
      stage.classList.remove('is-gesturing');
    }
    storyGesture = null;
    storyPaused = false;
    document.body.style.overflow = '';
    const currentUrl = new URL(location.href);
    if (currentUrl.searchParams.has('story')) {
      currentUrl.searchParams.delete('story');
      history.replaceState(history.state, document.title, currentUrl.pathname + currentUrl.search + currentUrl.hash);
    }
    loadStories();
  }
  function storyShareDetails(story = activeStory()) {
    if (!story) return null;
    return {
      id: story.id,
      kind: 'story',
      url: new URL(communityUrl({ story: story.id }), location.href).href,
      title: `Story de ${displayName(story)} na Forca Aliada`,
      text: String(story.content || 'Veja este story na comunidade Forca Aliada').slice(0, 180),
    };
  }
  function shareActiveStory() {
    const details = storyShareDetails();
    if (!details) return;
    if (typeof window.openShareDetails === 'function') {
      storyPaused = true;
      const modal = document.querySelector('#share-modal');
      const resume = new MutationObserver(() => {
        if (modal?.classList.contains('show')) return;
        storyPaused = false;
        resume.disconnect();
      });
      if (modal) resume.observe(modal, { attributes: true, attributeFilter: ['class', 'aria-hidden'] });
      window.openShareDetails(details);
    }
    else navigator.share?.({ title: details.title, text: details.text, url: details.url }).catch(() => {});
  }
  function openStoryFromUrl() {
    const storyId = new URL(location.href).searchParams.get('story');
    if (!storyId) return false;
    for (let groupIndex = 0; groupIndex < storyGroups.length; groupIndex += 1) {
      const storyIndex = storyGroups[groupIndex].findIndex(story => String(story.id) === String(storyId));
      if (storyIndex >= 0) {
        openStory(groupIndex, storyIndex);
        return true;
      }
    }
    return false;
  }
  async function deleteActiveStory() {
    const story = storyGroups[activeStoryGroup]?.[activeStoryIndex];
    if (!story || Number(story.user_id) !== Number(state.me?.id)) return;
    storyPaused = true;
    const confirmed = await confirmDialog({
      title: 'Apagar story',
      msg: 'Este story será removido imediatamente para todos.',
      confirmText: 'Apagar story',
      danger: true,
    });
    if (!confirmed) { storyPaused = false; return; }
    try {
      await api(`/api/community/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' });
      toast('success', 'Story apagado', '');
      closeStory();
    } catch (error) {
      storyPaused = false;
      toast('error', 'Não foi possível apagar', error.message);
    }
  }
  function nextStory() {
    const group = storyGroups[activeStoryGroup] || [];
    if (activeStoryIndex + 1 < group.length) openStory(activeStoryGroup, activeStoryIndex + 1);
    else if (activeStoryGroup + 1 < storyGroups.length) openStory(activeStoryGroup + 1, 0);
    else closeStory();
  }
  function previousStory() {
    if (activeStoryIndex > 0) openStory(activeStoryGroup, activeStoryIndex - 1);
    else if (activeStoryGroup > 0) openStory(activeStoryGroup - 1, storyGroups[activeStoryGroup - 1].length - 1);
  }

  async function loadServerLive() {
    try {
      const live = await api('/api/server/live-players');
      let hourly = { hours: [] };
      try { hourly = await api('/api/server/hourly'); } catch {}
      const players = Array.isArray(live.players) ? live.players
        : Array.isArray(live.online_players) ? live.online_players
        : [];
      const countValue = Number(live.count ?? live.online_count ?? players.length ?? 0);
      const explicitStatus = live.online ?? live.is_online ?? live.server_online ?? live.isOnline;
      const statusText = String(live.status || '').toLowerCase();
      const onlineKnown = explicitStatus !== undefined || ['online', 'offline'].includes(statusText) || countValue > 0;
      const online = countValue > 0 || explicitStatus === true || statusText === 'online';
      const pill = document.querySelector('#server-live-pill');
      pill?.classList.toggle('is-offline', onlineKnown && !online);
      pill?.classList.toggle('is-unknown', !onlineKnown);
      const pillCopy = document.querySelector('#server-live-pill-copy');
      const hasPlayers = online && countValue > 0;
      if (pillCopy) pillCopy.textContent = hasPlayers ? 'Servidor ativo' : online ? 'Tudo calmo' : onlineKnown ? 'Servidor offline' : 'Verificando servidor';
      const count = document.querySelector('#server-live-count');
      if (count) count.textContent = hasPlayers ? 'Ao vivo' : online ? 'Calmo' : onlineKnown ? 'Offline' : 'Status';
      const stack = document.querySelector('#live-player-stack');
      if (stack) stack.innerHTML = players.slice(0, 8).map(player =>
        `<img src="${safe(avatar(player, 40))}" alt="${safe(displayName(player))}" title="${safe(displayName(player))}" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(player),40))}'">`).join('');
      const copy = document.querySelector('#server-live-copy');
      if (copy) copy.textContent = hasPlayers
        ? 'Há movimento no servidor agora. Abra a busca para encontrar a turma.'
        : online ? 'A rede está em silêncio por enquanto. Bom momento para puxar assunto no feed.'
        : onlineKnown ? 'O servidor está temporariamente offline.' : 'O status ao vivo está sendo atualizado. A comunidade continua disponível.';
      const hours = hourly.hours || [];
      const max = Math.max(1, ...hours.map(row => Number(row.players || 0)));
      const timeline = document.querySelector('#server-timeline');
      if (timeline) timeline.innerHTML = hours.map(row =>
        `<i style="--h:${Math.max(8, Math.round(Number(row.players || 0) / max * 100))}%" title="${Number(row.players || 0) > 0 ? 'Movimento recente' : 'Sem movimento'}"></i>`).join('');
    } catch {
      const pill = document.querySelector('#server-live-pill');
      pill?.classList.remove('is-offline');
      pill?.classList.add('is-unknown');
      const pillCopy = document.querySelector('#server-live-pill-copy');
      if (pillCopy) pillCopy.textContent = 'Verificando servidor';
      const count = document.querySelector('#server-live-count');
      if (count) count.textContent = 'Status';
      const copy = document.querySelector('#server-live-copy');
      if (copy) copy.textContent = 'O status ao vivo está sendo atualizado. A comunidade continua disponível.';
    }
  }

  async function loadServerActivity() {
    try {
      const payload = await api('/api/server/activity');
      const player = payload.activity?.[0];
      const list = document.querySelector('#feed-list');
      if (!player || !list || list.querySelector('.server-activity-card')) return;
      const cards = list.querySelectorAll('.post-card');
      const anchor = cards[Math.min(2, cards.length - 1)];
      if (!anchor) return;
      anchor.insertAdjacentHTML('afterend', `<aside class="server-activity-card" aria-label="Atividade recente do servidor">
        <img src="${safe(avatar(player, 50))}" alt="${safe(displayName(player))}" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(player),50))}'">
        <div><strong>${safe(displayName(player))} entrou no servidor</strong><small>${safe(time(player.entered_at))} · ${safe(player.origin || 'Minecraft')}</small></div>
        <i class="live-dot" aria-hidden="true"></i>
      </aside>`);
    } catch {}
  }

  async function loadMeritProgress() {
    try {
      const info = await api('/api/me/rank-info');
      const rail = document.querySelector('.left-rail');
      if (!rail || rail.querySelector('#merit-progress-card')) return;
      const current = info.rank?.label || info.rank?.name || info.rank?.id || 'Rank atual';
      const next = info.nextRank?.label || info.nextRank?.name || info.nextRank?.id || 'nível máximo';
      rail.querySelector('.profile-mini')?.insertAdjacentHTML('afterend', `<section class="card merit-card" id="merit-progress-card">
        <div class="merit-card-head"><strong>${safe(current)}</strong><span>${safe(info.progress || 0)}%</span></div>
        <div class="progress-track"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, Number(info.progress || 0)))}%"></div></div>
        <small>${safe(info.merit || 0)} de mérito · próximo: ${safe(next)}</small>
      </section>`);
    } catch {}
  }

  async function streamFeed() {
    if (!token) return;
    let wait = 2500;
    while (true) {
      try {
        const response = await fetch(`${API_BASE}/api/community/feed/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
        });
        if (!response.ok || !response.body) throw new Error('stream unavailable');
        if (!window.faCommunityFeedStreamActive) {
          window.faCommunityFeedStreamActive = true;
          window.dispatchEvent(new CustomEvent('fa:community-stream-state', { detail: { active: true } }));
        }
        wait = 2500;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';
          for (const block of events) {
            if (block.includes('event: notification')) {
              loadNotifs().catch(() => {});
              if (new URLSearchParams(location.search).get('notifications') === '1') loadNotificationsPage({ reset: true, markViewed: true }).catch(() => {});
              continue;
            }
            if (block.includes('event: typing')) {
              const rawTyping = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
              if (rawTyping) window.dispatchEvent(new CustomEvent('fa:community-typing', { detail: JSON.parse(rawTyping) }));
              continue;
            }
            if (!block.includes('event: new-post')) continue;
            const raw = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
            const event = raw ? JSON.parse(raw) : null;
            if (!event?.postId || state.routeActive) continue;
            const post = await api(`/api/community/posts/${encodeURIComponent(event.postId)}`);
            if (state.posts.some(row => String(row.repost_of_id || row.id) === String(post.id))) continue;
            evoQueue.unshift(post);
            const pill = document.querySelector('#new-posts-pill');
            const copy = document.querySelector('#new-posts-count');
            if (copy) copy.textContent = evoQueue.length === 1 ? '1 nova postagem' : `${evoQueue.length} novas postagens`;
            if (pill) pill.hidden = false;
          }
        }
      } catch {}
      if (window.faCommunityFeedStreamActive) {
        window.faCommunityFeedStreamActive = false;
        window.dispatchEvent(new CustomEvent('fa:community-stream-state', { detail: { active: false } }));
      }
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = Math.min(30000, wait * 1.7);
    }
  }

  function mergeLivePosts() {
    if (!evoQueue.length) return false;
    const incoming = evoQueue.splice(0);
    const existing = new Set(state.posts.map(row => String(row.repost_of_id || row.id)));
    const fresh = incoming.filter(row => !existing.has(String(row.repost_of_id || row.id)));
    if (!fresh.length) return true;
    state.posts = [...fresh, ...state.posts];
    const list = document.querySelector('#feed-list');
    list?.querySelectorAll('.date-separator').forEach(node => node.remove());
    list?.insertAdjacentHTML('afterbegin', fresh.map(postCardHTML).join(''));
    list?.querySelectorAll('.post-card').forEach(card => {
      if (fresh.some(row => String(row.id) === String(card.dataset.recordId))) card.classList.add('is-new');
    });
    ImpressionTracker.reObserve();
    scheduleDecorate();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }

  async function loadDiscover() {
    const results = document.querySelector('#search-page-results');
    if (!results) return;
    try {
      const data = await api('/api/community/discover');
      (data.posts || []).forEach(post => {
        const idx = state.posts.findIndex(item => Number(item.id) === Number(post.id));
        if (idx >= 0) state.posts[idx] = { ...state.posts[idx], ...post };
        else state.posts.push(post);
      });
      results.innerHTML = `<div class="discover-grid">
        <section class="search-section"><h2>Descobrir pessoas</h2><div class="discover-row">${(data.players || []).map(player =>
          `<button class="discover-card js-profile" type="button" data-uid="${safe(player.id)}" data-mc="${safe(player.minecraft_name || player.username)}"><img src="${safe(avatar(player, 60))}" alt="" onerror="this.onerror=null;this.src='${safe(fallbackAvatar(displayName(player),60))}'"><span><strong>${safe(displayName(player))}</strong><small>${player.is_online ? 'Online agora' : 'Perfil recomendado'}</small></span></button>`).join('')}</div></section>
        <section class="search-section discover-posts"><h2>Posts em destaque</h2>${(data.posts || []).map(postCardHTML).join('') || '<p>Sem destaques agora.</p>'}</section>
        <section class="search-section"><h2>Comunidades em alta</h2><div class="search-chip-row">${(data.hashtags || []).map(tag =>
          `<button class="search-chip" type="button" data-hashtag="${safe(tag.tag)}">#${safe(tag.tag)} · ${safe(tag.count)}</button>`).join('')}</div></section>
      </div>`;
      scheduleDecorate();
    } catch {}
  }

  function addSchedulePresets() {
    const input = document.querySelector('#modal-schedule-at');
    if (!input || document.querySelector('.schedule-presets')) return;
    input.closest('.post-schedule-head')?.insertAdjacentHTML('afterend', `
      <div class="schedule-presets">
        <button type="button" data-schedule-hours="1">Em 1 hora</button>
        <button type="button" data-schedule-hours="24">Amanhã</button>
        <button type="button" data-schedule-next-week>Próxima semana</button>
      </div>`);
  }

  function syncScheduleUI() {
    const input = document.querySelector('#modal-schedule-at');
    const trigger = document.querySelector('[data-open-schedule-modal]');
    const copy = document.querySelector('#schedule-trigger-copy');
    const publish = document.querySelector('#modal-publish-btn');
    if (!input || !trigger || !copy) return;
    const date = input.value ? new Date(input.value) : null;
    const scheduled = Boolean(date && !Number.isNaN(date.getTime()));
    trigger.classList.toggle('is-on', scheduled);
    copy.textContent = scheduled
      ? date.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '')
      : 'Agendar';
    if (publish && !publish.querySelector('.spin')) publish.textContent = scheduled ? 'Agendar' : 'Publicar';
  }

  async function checkRankUp() {
    try {
      const info = await api('/api/me/rank-info');
      const current = String(info.rank?.id || info.rank?.label || info.current_rank || '');
      const key = 'fa_last_seen_rank_v1';
      const previous = localStorage.getItem(key);
      localStorage.setItem(key, current);
      if (!previous || previous === current) return;
      const node = document.createElement('div');
      node.className = 'rankup-celebration';
      node.innerHTML = `<strong>Novo rank: ${safe(current)}</strong>`;
      document.body.appendChild(node);
      buzz([30, 50, 60]);
      setTimeout(() => node.remove(), 3000);
    } catch {}
  }

  function patchExistingFunctions() {
    const originalRenderFeed = renderFeed;
    renderFeed = function evolutionRenderFeed(options) {
      const result = originalRenderFeed(options);
      scheduleDecorate();
      setTimeout(loadServerActivity, 90);
      return result;
    };
    const originalSwitchTab = switchTab;
    switchTab = function evolutionSwitchTab(filter) {
      const result = originalSwitchTab(filter);
      updateFilterContext();
      return result;
    };
    const originalNotifText = notifText;
    notifText = function evolutionNotifText(notification) {
      const text = originalNotifText(notification);
      const more = Math.max(0, Number(notification.group_count || 1) - 1);
      return more ? `${text} e mais ${more}` : text;
    };
    const originalRenderNotifs = renderNotifs;
    renderNotifs = function evolutionRenderNotifs() {
      const result = originalRenderNotifs();
      const title = document.querySelector('.notif-head strong');
      if (title) title.textContent = state.notifUnread ? `${state.notifUnread} nova${state.notifUnread === 1 ? '' : 's'}` : 'Tudo em dia';
      return result;
    };
    const originalHydrateSearch = hydrateSearchPage;
    hydrateSearchPage = async function evolutionHydrateSearch(term = '') {
      const result = await originalHydrateSearch(term);
      if (!term) await loadDiscover();
      return result;
    };
    runSearchPage = async function evolutionRunSearchPage(term) {
      const q = String(term || '').trim();
      const box = document.querySelector('#search-page-results');
      if (!box) return;
      if (!q) { await loadDiscover(); return; }
      box.innerHTML = Array.from({ length: 5 }, () => '<div class="skel" style="height:58px;border-radius:8px;margin-bottom:8px"></div>').join('');
      try {
        const data = await api(`/api/community/search?q=${encodeURIComponent(q)}&type=all`);
        (data.posts || []).forEach(post => {
          const idx = state.posts.findIndex(item => Number(item.id) === Number(post.id));
          if (idx >= 0) state.posts[idx] = { ...state.posts[idx], ...post };
          else state.posts.push(post);
        });
        box.innerHTML = `
          <div class="search-section"><h2>Pessoas</h2>${(data.players || []).map(searchResultPersonHTML).join('') || '<p>Nenhum jogador encontrado.</p>'}</div>
          <div class="search-section discover-posts"><h2>Posts</h2>${(data.posts || []).map(postCardHTML).join('') || '<p>Nenhum post encontrado.</p>'}</div>
          <div class="search-section"><h2>Hashtags</h2><div class="search-chip-row">${(data.hashtags || []).map(tag => `<button class="search-chip" data-hashtag="${safe(tag.tag)}" type="button">#${safe(tag.tag)} · ${safe(tag.count)}</button>`).join('') || '<span>Nenhuma hashtag encontrada.</span>'}</div></div>`;
        scheduleDecorate();
      } catch (error) {
        box.innerHTML = `<div class="empty-card"><div class="empty-icon">${IC.err}</div><h3>Busca indisponível</h3><p>${safe(error.message)}</p></div>`;
      }
    };

    const originalNavigate = Router.navigate.bind(Router);
    Router.navigate = function evolutionNavigate(path, options = {}) {
      const feedScrollY = state.routeActive
        ? Number(state.feedScrollY || history.state?.feedScrollY || history.state?.evoScrollY || 0)
        : Math.max(0, scrollY || document.documentElement.scrollTop || 0);
      if (!state.routeActive && typeof rememberFeedScroll === 'function') rememberFeedScroll();
      else if (!state.routeActive) state.feedScrollY = feedScrollY;
      try { history.replaceState({ ...(history.state || {}), evoScrollY: feedScrollY, feedScrollY }, document.title); } catch {}
      const run = () => originalNavigate(path, options);
      const result = document.startViewTransition ? document.startViewTransition(run) : run();
      setTimeout(() => {
        const heading = document.querySelector('#route-col:not([hidden]) h1,.feed-col h1');
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
          setTimeout(() => heading.removeAttribute('tabindex'), 0);
        }
      }, 220);
      return result;
    };
    window.addEventListener('popstate', event => setTimeout(() => {
      const url = new URL(location.href);
      const plainFeed = (url.pathname.replace(/\/+$/, '') === '/community' || url.pathname.replace(/\/+$/, '') === '/community.html') && !url.search;
      if (plainFeed) scrollTo({ top: Number(event.state?.feedScrollY ?? event.state?.evoScrollY ?? 0), behavior: 'instant' });
    }, 80));
  }

  function bindEvolutionEvents() {
    document.addEventListener('click', async event => {
      const tab = event.target.closest('[data-tab="saved"],[data-tab="trending"]');
      if (tab) { switchTab(tab.dataset.tab); return; }
      const rail = event.target.closest('[data-filter="saved"],[data-filter="trending"]');
      if (rail) { switchTab(rail.dataset.filter); return; }
      const drawer = event.target.closest('[data-drawer-filter="saved"],[data-drawer-filter="trending"]');
      if (drawer) { switchTab(drawer.dataset.drawerFilter); return; }
      if (event.target.closest('[data-clear-feed-context]')) { state.hashtag = ''; state.searchQuery = ''; switchTab('all'); return; }
      const backToPost = event.target.closest('[data-back-to-post]');
      if (backToPost) pendingCommentFocus = document.querySelector('#subthread-root [data-comment-id]')?.dataset.commentId || null;
      if (event.target.closest('#server-live-pill')) document.querySelector('#server-live-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (event.target.closest('[data-story-add]')) { if (!token) { (window.promptGuestAccount || window.openGuestAccountPrompt || (() => { location.href = loginUrlForCurrentPage(); }))('story'); return; } createStory(); return; }
      if (event.target.closest('[data-social-add-friend]')) { if (!token) { (window.promptGuestAccount || window.openGuestAccountPrompt || (() => { location.href = loginUrlForCurrentPage(); }))('friend'); return; } openModal('friend-modal'); return; }
      const socialProfile = event.target.closest('.social-friend.js-profile,.discover-card.js-profile,.story-viewer-row.js-profile');
      if (socialProfile) {
        const identifier = socialProfile.dataset.uid ? `id:${socialProfile.dataset.uid}` : socialProfile.dataset.mc;
        if (document.querySelector('#story-viewer')?.hidden === false) closeStory();
        if (identifier) navigateProfile(identifier);
        return;
      }
      const storyGroup = event.target.closest('[data-story-group]');
      if (storyGroup) {
        const groupIndex = Number(storyGroup.dataset.storyGroup);
        const firstUnseen = storyGroups[groupIndex]?.findIndex(story => !story.viewed_by_me) ?? -1;
        openStory(groupIndex, firstUnseen >= 0 ? firstUnseen : 0);
        return;
      }
      if (event.target.closest('[data-story-close]')) { closeStory(); return; }
      if (event.target.closest('[data-story-delete]')) { deleteActiveStory(); return; }
      if (event.target.closest('[data-story-share]')) { event.stopPropagation(); shareActiveStory(); return; }
      if (event.target.closest('[data-story-viewers]')) { openStoryViewers(); return; }
      if (event.target.closest('[data-story-like]')) { reactToStory('heart'); return; }
      const storyReaction = event.target.closest('[data-story-reaction]');
      if (storyReaction) {
        reactToStory(storyReaction.dataset.storyReaction);
        document.querySelector('#story-reaction-tray').hidden = true;
        document.querySelector('[data-story-reactions]')?.setAttribute('aria-expanded', 'false');
        storyPaused = false;
        return;
      }
      if (event.target.closest('[data-story-reactions]')) {
        const tray = document.querySelector('#story-reaction-tray');
        tray.hidden = !tray.hidden;
        event.target.closest('[data-story-reactions]').setAttribute('aria-expanded', String(!tray.hidden));
        storyPaused = !tray.hidden;
        if (!tray.hidden) storyFeedback('Escolha uma reação');
        return;
      }
      const storyNext = event.target.closest('[data-story-next]');
      if (storyNext) {
        event.preventDefault();
        event.stopPropagation();
        if (!matchMedia('(pointer: coarse)').matches || Date.now() >= storySuppressClickUntil) nextStory();
        return;
      }
      const storyPrev = event.target.closest('[data-story-prev]');
      if (storyPrev) {
        event.preventDefault();
        event.stopPropagation();
        if (!matchMedia('(pointer: coarse)').matches || Date.now() >= storySuppressClickUntil) previousStory();
        return;
      }
      const storyProfile = event.target.closest('[data-story-profile]');
      if (storyProfile && !event.target.closest('.story-viewer-actions')) {
        const identifier = storyProfile.dataset.uid ? `id:${storyProfile.dataset.uid}` : storyProfile.dataset.mc;
        closeStory();
        if (identifier) navigateProfile(identifier);
        return;
      }
      if (event.target.closest('[data-open-schedule-modal]')) {
        openModal('schedule-modal');
        loadScheduledPosts().catch(() => {});
        syncScheduleUI();
        setTimeout(() => document.querySelector('#modal-schedule-at')?.focus(), 80);
        return;
      }
      if (event.target.closest('[data-apply-schedule]')) { syncScheduleUI(); closeModal('schedule-modal'); return; }

      const timestamp = event.target.closest('.post-time');
      if (timestamp) {
        if (timestamp.matches('a[href]') || timestamp.dataset.action === 'open-thread') return;
        event.preventDefault();
        event.stopPropagation();
        const expanded = timestamp.getAttribute('aria-expanded') === 'true';
        timestamp.textContent = expanded ? timestamp.dataset.relative : timestamp.dataset.absolute;
        timestamp.setAttribute('aria-expanded', String(!expanded));
        return;
      }
      if (event.target.closest('#new-posts-pill') && mergeLivePosts()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.target.closest('#new-posts-pill').hidden = true;
        return;
      }
      const preset = event.target.closest('[data-schedule-hours],[data-schedule-next-week],[data-schedule-clear]');
      if (preset) {
        const input = document.querySelector('#modal-schedule-at');
        if (!input) return;
        if (preset.hasAttribute('data-schedule-clear')) input.value = '';
        else {
          const hours = preset.hasAttribute('data-schedule-next-week') ? 24 * 7 : Number(preset.dataset.scheduleHours || 1);
          const date = new Date(Date.now() + hours * 3600000);
          input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
        syncScheduleUI();
        if (preset.hasAttribute('data-schedule-clear')) closeModal('schedule-modal');
        return;
      }
      if (event.target.closest('#modal-publish-btn')) setTimeout(syncScheduleUI, 700);
    }, true);

    document.addEventListener('click', event => {
      if (event.target.closest('.pa-like,.follow-btn,#inline-publish-btn,#modal-publish-btn')) buzz(15);
    });
    document.addEventListener('drop', event => {
      const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
      if (!files.length || event.target.closest('.composer,.sheet')) return;
      event.preventDefault();
      openModal('post-modal');
      queueMediaFiles('modal', files);
    });
    document.addEventListener('dragover', event => {
      if ([...(event.dataTransfer?.items || [])].some(item => item.kind === 'file')) event.preventDefault();
    });
    document.addEventListener('input', event => {
      if (event.target.matches('#modal-schedule-at')) syncScheduleUI();
      if (!event.target.closest('[data-chat-input]')) return;
      const recipientId = document.querySelector('[data-chat-profile]')?.dataset.chatProfile;
      if (!recipientId) return;
      if (Date.now() - lastTypingSentAt > 800) {
        lastTypingSentAt = Date.now();
        api('/api/community/typing', { method: 'POST', body: JSON.stringify({ recipient_id: recipientId, is_typing: true }) }).catch(() => {});
      }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => api('/api/community/typing', { method: 'POST', body: JSON.stringify({ recipient_id: recipientId, is_typing: false }) }).catch(() => {}), 1300);
    });
    document.addEventListener('submit', event => {
      const form = event.target.closest('[data-story-reply]');
      if (!form) return;
      event.preventDefault();
      replyToStory(form.querySelector('#story-reply-input')?.value);
    });
    document.addEventListener('focusin', event => {
      if (event.target.closest('#story-reply-input')) storyPaused = true;
    });
    document.addEventListener('focusout', event => {
      if (event.target.closest('#story-reply-input')) storyPaused = false;
    });
    window.addEventListener('fa:community-typing', event => {
      const detail = event.detail || {};
      const activeId = document.querySelector('[data-chat-profile]')?.dataset.chatProfile;
      if (String(activeId || '') !== String(detail.actorId || '')) return;
      let node = document.querySelector('.fa-community-typing');
      if (!node) {
        node = document.createElement('div');
        node.className = 'fa-community-typing';
        document.querySelector('[data-chat-form]')?.insertAdjacentElement('beforebegin', node);
      }
      node.textContent = detail.isTyping ? 'Digitando' : '';
      node.hidden = !detail.isTyping;
      clearTimeout(typingHideTimer);
      typingHideTimer = setTimeout(() => { if (node) node.hidden = true; }, 2200);
    });

    let pullStart = null;
    let pulled = false;
    addEventListener('touchstart', event => {
      if (scrollY <= 0 && event.touches.length === 1) pullStart = event.touches[0].clientY;
    }, { passive: true });
    addEventListener('touchmove', event => {
      if (pullStart == null) return;
      pulled = event.touches[0].clientY - pullStart > 82;
      const indicator = document.querySelector('#pull-indicator');
      indicator?.classList.toggle('show', pulled);
      if (indicator) indicator.textContent = pulled ? 'Solte para atualizar' : 'Puxe para atualizar';
    }, { passive: true });
    addEventListener('touchend', () => {
      document.querySelector('#pull-indicator')?.classList.remove('show');
      if (pulled && !state.loading) { buzz(20); _refreshFeedWithVariety(); }
      pullStart = null;
      pulled = false;
    }, { passive: true });

    const storyViewer = document.querySelector('#story-viewer');
    const storyStage = document.querySelector('.story-stage');
    storyViewer?.addEventListener('touchstart', event => {
      if (sheetOverlayOpen()) return;
      if (event.touches.length !== 1 || event.target.closest('.story-reply-bar,.story-reaction-tray,.story-viewer-actions,.story-owner-stats')) return;
      const touch = event.touches[0];
      storyGesture = { x: touch.clientX, y: touch.clientY, at: Date.now(), dx: 0, dy: 0, axis: null };
    }, { passive: true });
    storyViewer?.addEventListener('touchmove', event => {
      if (sheetOverlayOpen()) return;
      if (!storyGesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      storyGesture.dx = touch.clientX - storyGesture.x;
      storyGesture.dy = touch.clientY - storyGesture.y;
      if (!storyGesture.axis && Math.hypot(storyGesture.dx, storyGesture.dy) > 9) {
        storyGesture.axis = Math.abs(storyGesture.dx) > Math.abs(storyGesture.dy) * 1.15 ? 'x' : 'y';
        storyPaused = true;
        storyStage?.classList.add('is-gesturing');
      }
      if (!storyGesture.axis || !storyStage) return;
      event.preventDefault();
      if (storyGesture.axis === 'x') {
        const resisted = storyGesture.dx * .72;
        storyStage.style.transform = `translate3d(${resisted}px,0,0) scale(.985)`;
        storyFeedback(storyGesture.dx < 0 ? 'Próximo story' : 'Story anterior');
      } else {
        const down = Math.max(0, storyGesture.dy);
        const up = Math.min(0, storyGesture.dy);
        storyStage.style.transform = `translate3d(0,${down * .72 + up * .28}px,0) scale(${1 - Math.min(.08, Math.abs(storyGesture.dy) / 1800)})`;
        storyStage.style.opacity = String(1 - Math.min(.35, down / 700));
        storyFeedback(storyGesture.dy > 0 ? 'Solte para fechar' : (Number(activeStory()?.user_id) === Number(state.me?.id) ? 'Solte para ver a atividade' : 'Solte para reagir'));
      }
    }, { passive: false });
    storyViewer?.addEventListener('touchend', event => {
      if (sheetOverlayOpen()) { storyGesture = null; return; }
      if (!storyGesture || !event.changedTouches[0]) return;
      const { dx, dy, at, axis } = storyGesture;
      const elapsed = Math.max(1, Date.now() - at);
      const velocity = Math.hypot(dx, dy) / elapsed;
      const resetStage = () => {
        if (!storyStage) return;
        storyStage.style.transition = 'transform 280ms var(--ease-spring),opacity 180ms var(--ease-ui)';
        storyStage.style.transform = '';
        storyStage.style.opacity = '';
        storyStage.classList.remove('is-gesturing');
        setTimeout(() => { storyStage.style.transition = ''; }, 300);
      };
      if (axis === 'y' && dy > 90 && (velocity > .22 || dy > 130)) {
        storySuppressClickUntil = Date.now() + 400;
        buzz(18);
        closeStory();
      } else if (axis === 'y' && dy < -72) {
        storySuppressClickUntil = Date.now() + 400;
        buzz(14);
        if (Number(activeStory()?.user_id) === Number(state.me?.id)) openStoryViewers();
        else {
          const tray = document.querySelector('#story-reaction-tray');
          tray.hidden = false;
          document.querySelector('[data-story-reactions]')?.setAttribute('aria-expanded', 'true');
          storyPaused = true;
        }
        resetStage();
      } else if (axis === 'x' && Math.abs(dx) > 62 && (velocity > .18 || Math.abs(dx) > 100)) {
        storySuppressClickUntil = Date.now() + 400;
        buzz(8);
        dx < 0 ? nextStory() : previousStory();
      } else if (!axis && elapsed < 280) {
        const now = Date.now();
        if (now - storyLastTap < 310) {
          storySuppressClickUntil = now + 420;
          reactToStory('heart', { quiet: true });
          storyFeedback('Curtiu o story', 'success');
        }
        storyLastTap = now;
        resetStage();
      } else {
        resetStage();
      }
      storyPaused = Boolean(document.querySelector('.story-viewers-backdrop')) || !document.querySelector('#story-reaction-tray')?.hidden;
      storyGesture = null;
    }, { passive: true });

    let storyPressAt = 0;
    let storyPressTimer = null;
    document.querySelector('.story-stage')?.addEventListener('pointerdown', event => {
      if (sheetOverlayOpen()) return;
      if (event.pointerType !== 'mouse') return;
      if (event.target.closest('.story-reply-bar,.story-reaction-tray,.story-viewer-actions,.story-owner-stats')) return;
      storyPressAt = Date.now();
      storyPaused = true;
      clearTimeout(storyPressTimer);
      storyPressTimer = setTimeout(() => {
        document.querySelector('#story-pause-indicator')?.removeAttribute('hidden');
        storyFeedback('Pausado');
      }, 120);
    }, { passive: true });
    document.querySelector('.story-stage')?.addEventListener('pointerup', () => {
      if (storyPressAt && Date.now() - storyPressAt > 350) storySuppressClickUntil = Date.now() + 250;
      clearTimeout(storyPressTimer);
      storyPressAt = 0;
      storyPaused = false;
      document.querySelector('#story-pause-indicator')?.setAttribute('hidden', '');
    }, { passive: true });
    document.querySelector('.story-stage')?.addEventListener('pointercancel', () => {
      clearTimeout(storyPressTimer);
      storyPressAt = 0;
      storyPaused = false;
      document.querySelector('#story-pause-indicator')?.setAttribute('hidden', '');
    }, { passive: true });
    document.addEventListener('keydown', event => {
      if (document.querySelector('#story-viewer')?.hidden !== false) return;
      if (sheetOverlayOpen()) return;
      if (event.key === 'Enter' && event.target.closest('[data-story-profile]')) {
        const target = event.target.closest('[data-story-profile]');
        closeStory();
        navigateProfile(target.dataset.uid ? `id:${target.dataset.uid}` : target.dataset.mc);
      }
      else if (event.key === 'ArrowRight') nextStory();
      else if (event.key === 'ArrowLeft') previousStory();
      else if (event.key === 'Escape') closeStory();
      else if (event.key === ' ') { event.preventDefault(); storyPaused = !storyPaused; }
    });

  }

  function init() {
    injectShell();
    stabilizeFeedLayout();
    patchExistingFunctions();
    bindEvolutionEvents();
    const feedList = document.querySelector('#feed-list');
    if (feedList) new MutationObserver(scheduleDecorate).observe(feedList, { childList: true, subtree: true });
    const routeCol = document.querySelector('#route-col');
    if (routeCol) new MutationObserver(restorePendingCommentFocus).observe(routeCol, { childList: true, subtree: true });
    const feedCol = document.querySelector('#feed-col');
    if (feedCol) new MutationObserver(stabilizeFeedLayout).observe(feedCol, { childList: true });
    scheduleDecorate();
    syncScheduleUI();
    loadStories().then(openStoryFromUrl);
    setTimeout(stabilizeFeedLayout, 500);
    setTimeout(stabilizeFeedLayout, 1800);
    setTimeout(() => loadStories().then(openStoryFromUrl), 1400);
    loadServerLive();
    loadServerActivity();
    loadMeritProgress();
    checkRankUp();
    streamFeed();
    setInterval(loadStories, 60000);
    setInterval(loadServerLive, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
