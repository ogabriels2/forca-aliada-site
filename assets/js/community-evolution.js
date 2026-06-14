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
  const reactionCache = new Map();
  let storyGroups = [];
  let activeStoryGroup = 0;
  let activeStoryIndex = 0;
  let storyTimer = null;
  let decorateTimer = null;
  let decorating = false;
  let typingTimer = null;
  let typingHideTimer = null;
  let lastTypingSentAt = 0;

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
        <section class="stories-shell" id="stories-shell" aria-label="Momentos">
          <div class="stories-head"><strong>Momentos</strong><span>expiram em 24 horas</span></div>
          <div class="stories-list" id="stories-list"><div class="skel" style="width:54px;height:54px;border-radius:50%"></div></div>
        </section>`);
    }

    const right = document.querySelector('.right-panel');
    if (right && !document.querySelector('#server-live-card')) {
      right.insertAdjacentHTML('afterbegin', `
        <section class="card panel-card server-live-card" id="server-live-card">
          <div class="panel-head"><h2 class="server-live-title"><i class="live-dot"></i> Servidor ao vivo</h2><strong id="server-live-count">--</strong></div>
          <div class="live-player-stack" id="live-player-stack"></div>
          <p id="server-live-copy">Consultando atividade...</p>
          <div class="server-timeline" id="server-timeline" aria-label="Atividade nas últimas 24 horas"></div>
        </section>`);
    }

    if (!document.querySelector('#pull-indicator')) {
      document.body.insertAdjacentHTML('beforeend', '<div class="pull-indicator" id="pull-indicator">Puxe para atualizar</div>');
    }
    if (!document.querySelector('#story-viewer')) {
      document.body.insertAdjacentHTML('beforeend', `
        <section class="story-viewer" id="story-viewer" hidden aria-label="Visualizador de Momentos">
          <div class="story-stage">
            <div class="story-progress" id="story-progress"></div>
            <div class="story-viewer-head"><img id="story-viewer-av" alt=""><strong id="story-viewer-name"></strong><button type="button" data-story-close aria-label="Fechar">×</button></div>
            <img id="story-viewer-media" alt="Momento">
            <p class="story-content" id="story-viewer-content" hidden></p>
            <button class="story-hit" type="button" data-story-prev aria-label="Anterior"></button>
            <button class="story-hit next" type="button" data-story-next aria-label="Próximo"></button>
          </div>
        </section>`);
    }
    addSchedulePresets();
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

  function reactionMarkup() {
    return `
      <span class="reaction-wrap" data-no-post-nav>
        <button class="pa reaction-trigger" type="button" data-reaction-trigger aria-label="Reagir">＋</button>
        <span class="reaction-picker" hidden>${Object.entries(REACTIONS).map(([code, meta]) =>
          `<button type="button" data-reaction="${code}" title="${safe(meta[1])}">${meta[0]}</button>`).join('')}</span>
      </span>`;
  }

  function renderReactionSummary(card, payload) {
    reactionCache.set(String(card.dataset.postId), payload);
    const actions = card.querySelector('.post-actions');
    if (!actions) return;
    let summary = card.querySelector('.reaction-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'reaction-summary';
      actions.insertAdjacentElement('beforebegin', summary);
    }
    const rows = payload.reactions || [];
    summary.innerHTML = rows.length
      ? rows.slice(0, 4).map(row => `<button type="button" title="${safe(REACTIONS[row.code]?.[1] || row.code)}">${REACTIONS[row.code]?.[0] || '•'}</button>`).join('')
        + `<span>${rows.reduce((sum, row) => sum + Number(row.count || 0), 0)}</span>`
      : '';
    card.querySelectorAll('[data-reaction]').forEach(button => button.classList.toggle('is-on', button.dataset.reaction === payload.my_reaction));
  }

  async function loadReactions(card) {
    if (!card || card.dataset.reactionsLoaded) return;
    card.dataset.reactionsLoaded = '1';
    try {
      const payload = await api(`/api/community/posts/${encodeURIComponent(card.dataset.postId)}/reactions`);
      renderReactionSummary(card, payload);
    } catch {
      delete card.dataset.reactionsLoaded;
    }
  }

  function decorateFeed() {
    if (decorating) return;
    decorating = true;
    updateFilterContext();
    const list = document.querySelector('#feed-list');
    if (!list) { decorating = false; return; }
    list.querySelectorAll('.date-separator').forEach(node => node.remove());
    let previous = '';
    list.querySelectorAll('.post-card').forEach(card => {
      const post = postForCard(card);
      const label = dateLabel(post?.created_at || new Date());
      if (label !== previous) card.insertAdjacentHTML('beforebegin', `<div class="date-separator">${safe(label)}</div>`);
      previous = label;
      const timestamp = card.querySelector('.post-time');
      if (timestamp && post?.created_at) {
        timestamp.dataset.relative = time(post.created_at);
        timestamp.dataset.absolute = new Date(post.created_at).toLocaleString('pt-BR');
        timestamp.title = timestamp.dataset.absolute;
      }
      card.querySelectorAll('.pa-like,.pa-save,.pa-repost').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('is-on'))));
      card.querySelectorAll('.post-content').forEach(formatMarkdown);
      const actions = card.querySelector('.post-actions');
      if (actions && !actions.querySelector('.reaction-wrap')) actions.insertAdjacentHTML('beforeend', reactionMarkup());
      card.querySelectorAll('.post-media img').forEach(img => {
        if (!img.width) img.width = 900;
        if (!img.height) img.height = 700;
      });
      card.querySelectorAll('.av42-sq,.preview-row-av').forEach(img => {
        if (!img.width) img.width = 50;
        if (!img.height) img.height = 50;
        img.decoding = 'async';
      });
      reactionObserver?.observe(card);
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

  const reactionObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => entries.filter(entry => entry.isIntersecting).forEach(entry => {
      reactionObserver.unobserve(entry.target);
      loadReactions(entry.target);
    }), { rootMargin: '250px' })
    : null;

  function scheduleDecorate() {
    if (decorating) return;
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateFeed, 45);
  }

  async function loadStories() {
    const list = document.querySelector('#stories-list');
    if (!list) return;
    try {
      const payload = await api('/api/community/stories');
      const groups = new Map();
      (payload.stories || []).forEach(story => {
        if (!groups.has(String(story.user_id))) groups.set(String(story.user_id), []);
        groups.get(String(story.user_id)).push(story);
      });
      storyGroups = [...groups.values()];
      const mine = state.me || {};
      list.innerHTML = `
        <button class="story-item" type="button" data-story-add>
          <span class="story-ring"><img src="${safe(avatar(mine, 60))}" alt=""><b class="story-add">+</b></span><span>Seu Momento</span>
        </button>
        ${storyGroups.map((group, index) => {
          const first = group[0];
          const viewed = group.every(row => row.viewed_by_me);
          return `<button class="story-item ${viewed ? 'is-viewed' : ''}" type="button" data-story-group="${index}">
            <span class="story-ring"><img src="${safe(avatar(first, 60))}" alt="${safe(displayName(first))}"></span><span>${safe(displayName(first))}</span>
          </button>`;
        }).join('')}`;
    } catch {
      list.innerHTML = '<span style="padding:8px;color:var(--ink-3);font-size:11px">Momentos indisponíveis.</span>';
    }
  }

  async function createStory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        toast('info', 'Preparando Momento', 'Comprimindo e revisando a imagem...');
        const processed = await smartCompress(file, IMG_COMPRESS_PRESETS.post);
        await assertSafeImage(processed, 'inline');
        const form = new FormData();
        form.append('media', processed, `momento-${Date.now()}.webp`);
        const upload = await api('/api/community/upload', { method: 'POST', body: form, timeoutMs: 90000 });
        const mediaUrl = upload.urls?.[0];
        if (!mediaUrl) throw new Error('Upload incompleto.');
        await api('/api/community/stories', { method: 'POST', body: JSON.stringify({ media_url: mediaUrl }) });
        buzz(25);
        toast('success', 'Momento publicado', 'Ele ficará visível por 24 horas.');
        await loadStories();
      } catch (error) {
        toast('error', 'Não foi possível publicar', error.message);
      }
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
    document.querySelector('#story-viewer-av').src = avatar(story, 60);
    document.querySelector('#story-viewer-name').textContent = displayName(story);
    const content = document.querySelector('#story-viewer-content');
    content.textContent = story.content || '';
    content.hidden = !story.content;
    document.querySelector('#story-progress').innerHTML = group.map((_, index) =>
      `<i style="--progress:${index < storyIndex ? '100%' : '0%'}"></i>`).join('');
    api(`/api/community/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' }).catch(() => {});
    clearInterval(storyTimer);
    let elapsed = 0;
    storyTimer = setInterval(() => {
      elapsed += 100;
      const bar = document.querySelectorAll('#story-progress i')[storyIndex];
      bar?.style.setProperty('--progress', `${Math.min(100, elapsed / 50)}%`);
      if (elapsed >= 5000) nextStory();
    }, 100);
  }

  function closeStory() {
    clearInterval(storyTimer);
    const viewer = document.querySelector('#story-viewer');
    if (viewer) viewer.hidden = true;
    document.body.style.overflow = '';
    loadStories();
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
      const [live, hourly] = await Promise.all([api('/api/server/live-players'), api('/api/server/hourly')]);
      const pill = document.querySelector('#server-live-pill');
      pill?.classList.toggle('is-offline', !live.online);
      const pillCopy = document.querySelector('#server-live-pill-copy');
      if (pillCopy) pillCopy.textContent = live.online ? `${live.count} online` : 'Servidor offline';
      const count = document.querySelector('#server-live-count');
      if (count) count.textContent = String(live.count ?? 0);
      const stack = document.querySelector('#live-player-stack');
      if (stack) stack.innerHTML = (live.players || []).slice(0, 8).map(player =>
        `<img src="${safe(avatar(player, 40))}" alt="${safe(displayName(player))}" title="${safe(displayName(player))}">`).join('');
      const copy = document.querySelector('#server-live-copy');
      if (copy) copy.textContent = live.online
        ? `${live.count || 0} jogador(es) conectados agora em ${live.host}.`
        : 'O servidor está temporariamente offline.';
      const hours = hourly.hours || [];
      const max = Math.max(1, ...hours.map(row => Number(row.players || 0)));
      const timeline = document.querySelector('#server-timeline');
      if (timeline) timeline.innerHTML = hours.map(row =>
        `<i style="--h:${Math.max(8, Math.round(Number(row.players || 0) / max * 100))}%" title="${Number(row.players || 0)} jogadores"></i>`).join('');
    } catch {}
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
        <img src="${safe(avatar(player, 50))}" alt="${safe(displayName(player))}">
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
    let wait = 2500;
    while (true) {
      try {
        const response = await fetch(`${API_BASE}/api/community/feed/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
        });
        if (!response.ok || !response.body) throw new Error('stream unavailable');
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
      results.innerHTML = `<div class="discover-grid">
        <section class="search-section"><h2>Descobrir pessoas</h2><div class="discover-row">${(data.players || []).map(player =>
          `<button class="discover-card js-profile" type="button" data-uid="${safe(player.id)}" data-mc="${safe(player.minecraft_name || player.username)}"><img src="${safe(avatar(player, 60))}" alt=""><strong>${safe(displayName(player))}</strong><small>${player.is_online ? 'Online agora' : 'Perfil recomendado'}</small></button>`).join('')}</div></section>
        <section class="search-section"><h2>Posts em destaque</h2>${(data.posts || []).map(post => searchResultPostHTML(post)).join('') || '<p>Sem destaques agora.</p>'}</section>
        <section class="search-section"><h2>Comunidades em alta</h2><div class="search-chip-row">${(data.hashtags || []).map(tag =>
          `<button class="search-chip" type="button" data-hashtag="${safe(tag.tag)}">#${safe(tag.tag)} · ${safe(tag.count)}</button>`).join('')}</div></section>
      </div>`;
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
        <button type="button" data-schedule-clear>Limpar</button>
      </div>`);
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
        box.innerHTML = `
          <div class="search-section"><h2>Pessoas</h2>${(data.players || []).map(searchResultPersonHTML).join('') || '<p>Nenhum jogador encontrado.</p>'}</div>
          <div class="search-section"><h2>Posts</h2>${(data.posts || []).map(searchResultPostHTML).join('') || '<p>Nenhum post encontrado.</p>'}</div>
          <div class="search-section"><h2>Hashtags</h2><div class="search-chip-row">${(data.hashtags || []).map(tag => `<button class="search-chip" data-hashtag="${safe(tag.tag)}" type="button">#${safe(tag.tag)} · ${safe(tag.count)}</button>`).join('') || '<span>Nenhuma hashtag encontrada.</span>'}</div></div>`;
      } catch (error) {
        box.innerHTML = `<div class="empty-card"><div class="empty-icon">${IC.err}</div><h3>Busca indisponível</h3><p>${safe(error.message)}</p></div>`;
      }
    };

    const originalNavigate = Router.navigate.bind(Router);
    Router.navigate = function evolutionNavigate(path, options = {}) {
      try { history.replaceState({ ...(history.state || {}), evoScrollY: scrollY }, document.title); } catch {}
      const run = () => originalNavigate(path, options);
      const result = document.startViewTransition ? document.startViewTransition(run) : run();
      setTimeout(() => {
        const heading = document.querySelector('#route-col:not([hidden]) h1,.feed-col h1');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      }, 220);
      return result;
    };
    window.addEventListener('popstate', event => setTimeout(() => scrollTo({ top: Number(event.state?.evoScrollY || 0), behavior: 'instant' }), 80));
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
      if (event.target.closest('#server-live-pill')) document.querySelector('#server-live-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (event.target.closest('[data-story-add]')) { createStory(); return; }
      const storyGroup = event.target.closest('[data-story-group]');
      if (storyGroup) { openStory(Number(storyGroup.dataset.storyGroup)); return; }
      if (event.target.closest('[data-story-close]')) { closeStory(); return; }
      if (event.target.closest('[data-story-next]')) { nextStory(); return; }
      if (event.target.closest('[data-story-prev]')) { previousStory(); return; }

      const trigger = event.target.closest('[data-reaction-trigger]');
      if (trigger) {
        event.stopPropagation();
        const picker = trigger.parentElement.querySelector('.reaction-picker');
        document.querySelectorAll('.reaction-picker').forEach(node => { if (node !== picker) node.hidden = true; });
        picker.hidden = !picker.hidden;
        return;
      }
      const reaction = event.target.closest('[data-reaction]');
      if (reaction) {
        event.stopPropagation();
        const card = reaction.closest('.post-card');
        const cached = reactionCache.get(String(card.dataset.postId));
        const remove = cached?.my_reaction === reaction.dataset.reaction;
        try {
          const payload = await api(`/api/community/posts/${encodeURIComponent(card.dataset.postId)}/reactions`, {
            method: remove ? 'DELETE' : 'POST',
            body: remove ? undefined : JSON.stringify({ code: reaction.dataset.reaction }),
          });
          renderReactionSummary(card, payload);
          reaction.closest('.reaction-picker').hidden = true;
          buzz(18);
        } catch (error) { toast('error', 'Reação indisponível', error.message); }
        return;
      }

      const timestamp = event.target.closest('.post-time');
      if (timestamp) {
        event.preventDefault();
        event.stopPropagation();
        const expanded = timestamp.getAttribute('aria-expanded') === 'true';
        timestamp.textContent = expanded ? timestamp.dataset.relative : timestamp.dataset.absolute;
        timestamp.setAttribute('aria-expanded', String(!expanded));
        return;
      }
      const nativeShare = event.target.closest('.pa-share');
      if (nativeShare && navigator.share) {
        const card = nativeShare.closest('.post-card');
        const post = postForCard(card);
        event.preventDefault();
        event.stopImmediatePropagation();
        navigator.share({
          title: `Post de ${displayName(post)}`,
          text: String(post?.content || '').slice(0, 180),
          url: new URL(communityUrl({ post: card.dataset.postId }), location.href).href,
        }).catch(() => {});
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
      }
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

    let lightboxY = null;
    document.querySelector('#lb-img-wrap')?.addEventListener('touchstart', event => { lightboxY = event.touches[0]?.clientY ?? null; }, { passive: true });
    document.querySelector('#lb-img-wrap')?.addEventListener('touchend', event => {
      if (lightboxY != null && (event.changedTouches[0]?.clientY || 0) - lightboxY > 120) document.querySelector('#lb-mob-close')?.click();
      lightboxY = null;
    }, { passive: true });

    let storyTouch = null;
    document.querySelector('#story-viewer')?.addEventListener('touchstart', event => {
      storyTouch = event.touches[0] ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    document.querySelector('#story-viewer')?.addEventListener('touchend', event => {
      if (!storyTouch || !event.changedTouches[0]) return;
      const dx = event.changedTouches[0].clientX - storyTouch.x;
      const dy = event.changedTouches[0].clientY - storyTouch.y;
      if (Math.abs(dy) > 110 && dy > 0) closeStory();
      else if (Math.abs(dx) > 65) dx < 0 ? nextStory() : previousStory();
      storyTouch = null;
    }, { passive: true });

    let reactionHold = null;
    document.addEventListener('pointerdown', event => {
      const trigger = event.target.closest('.reaction-trigger');
      if (!trigger) return;
      clearTimeout(reactionHold);
      reactionHold = setTimeout(() => { trigger.parentElement.querySelector('.reaction-picker').hidden = false; buzz(12); }, 650);
    }, { passive: true });
    document.addEventListener('pointerup', () => clearTimeout(reactionHold), { passive: true });
  }

  function init() {
    injectShell();
    patchExistingFunctions();
    bindEvolutionEvents();
    new MutationObserver(scheduleDecorate).observe(document.querySelector('#feed-list'), { childList: true, subtree: true });
    scheduleDecorate();
    loadStories();
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
