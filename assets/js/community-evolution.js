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
  let storyElapsed = 0;
  let storyPaused = false;
  let storySuppressClickUntil = 0;
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
        <section class="stories-shell" id="stories-shell" aria-label="Stories">
          <div class="stories-head"><strong>Stories</strong><span>Visíveis por 24 h</span></div>
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
        <section class="story-viewer" id="story-viewer" hidden aria-label="Visualizador de stories">
          <button class="story-nav prev" type="button" data-story-prev aria-label="Story anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
          <div class="story-stage">
            <div class="story-progress" id="story-progress"></div>
            <div class="story-viewer-head">
              <img id="story-viewer-av" alt="">
              <div class="story-viewer-meta"><strong id="story-viewer-name"></strong><span id="story-viewer-time"></span></div>
              <div class="story-viewer-actions">
                <button class="story-delete" type="button" data-story-delete aria-label="Apagar seu story" title="Apagar story" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg></button>
                <button type="button" data-story-close aria-label="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </div>
            </div>
            <img id="story-viewer-media" alt="Story">
            <p class="story-content" id="story-viewer-content" hidden></p>
            <span class="story-owner-stats" id="story-owner-stats" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span id="story-view-count"></span></span>
            <button class="story-hit" type="button" data-story-prev aria-label="Anterior"></button>
            <button class="story-hit next" type="button" data-story-next aria-label="Próximo"></button>
          </div>
          <button class="story-nav next" type="button" data-story-next aria-label="Próximo story"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>
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
          `<button type="button" data-reaction="${code}" aria-label="${safe(meta[1])}" aria-pressed="false" title="${safe(meta[1])}">${meta[0]}</button>`).join('')}</span>
      </span>`;
  }

  function optimisticReactionPayload(payload, nextCode) {
    const previousCode = payload?.my_reaction || null;
    const rows = (payload?.reactions || []).map(row => ({ ...row, count: Number(row.count || 0) }));
    const counts = new Map(rows.map(row => [row.code, row]));
    if (previousCode && previousCode !== nextCode && counts.has(previousCode)) {
      counts.get(previousCode).count = Math.max(0, counts.get(previousCode).count - 1);
    }
    if (nextCode && previousCode !== nextCode) {
      if (!counts.has(nextCode)) counts.set(nextCode, { code: nextCode, count: 0 });
      counts.get(nextCode).count += 1;
    }
    return {
      reactions: [...counts.values()].filter(row => row.count > 0).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      my_reaction: nextCode,
    };
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
    card.querySelectorAll('[data-reaction]').forEach(button => {
      const selected = button.dataset.reaction === payload.my_reaction;
      button.classList.toggle('is-on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
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
    try {
      const payload = await api('/api/community/stories');
      const groups = new Map();
      (payload.stories || []).forEach(story => {
        if (!groups.has(String(story.user_id))) groups.set(String(story.user_id), []);
        groups.get(String(story.user_id)).push(story);
      });
      storyGroups = [...groups.values()];
      const mine = state.me || {};
      const myGroupIndex = storyGroups.findIndex(group => Number(group[0]?.user_id) === Number(mine.id));
      const myGroup = storyGroups[myGroupIndex];
      const myStoryItem = myGroup
        ? `<div class="story-item ${myGroup.every(row => row.viewed_by_me) ? 'is-viewed' : ''}">
            <button class="story-ring-button" type="button" data-story-group="${myGroupIndex}" aria-label="Ver seu story">
              <span class="story-ring"><img src="${safe(avatar(mine, 60))}" alt=""></span>
              <span class="story-label">Seu story</span>
            </button>
            <button class="story-add" type="button" data-story-add aria-label="Adicionar story">+</button>
          </div>`
        : `<button class="story-item" type="button" data-story-add>
            <span class="story-ring"><img src="${safe(avatar(mine, 60))}" alt=""></span>
            <span class="story-label">Seu story</span>
            <b class="story-add">+</b>
          </button>`;
      list.innerHTML = `
        ${myStoryItem}
        ${storyGroups.map((group, index) => {
          if (index === myGroupIndex) return '';
          const first = group[0];
          const viewed = group.every(row => row.viewed_by_me);
          return `<button class="story-item ${viewed ? 'is-viewed' : ''}" type="button" data-story-group="${index}">
            <span class="story-ring"><img src="${safe(avatar(first, 60))}" alt="${safe(displayName(first))}"></span><span class="story-label">${safe(displayName(first))}</span>
          </button>`;
        }).join('')}`;
    } catch {
      list.innerHTML = '<span style="padding:8px;color:var(--ink-3);font-size:11px">Stories indisponíveis.</span>';
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
    document.querySelector('#story-viewer-time').textContent = time(story.created_at);
    const content = document.querySelector('#story-viewer-content');
    content.textContent = story.content || '';
    content.hidden = !story.content;
    const isOwner = Number(story.user_id) === Number(state.me?.id);
    const deleteButton = document.querySelector('[data-story-delete]');
    if (deleteButton) deleteButton.hidden = !isOwner;
    const ownerStats = document.querySelector('#story-owner-stats');
    if (ownerStats) ownerStats.hidden = !isOwner;
    const viewCount = document.querySelector('#story-view-count');
    if (viewCount) viewCount.textContent = `${Number(story.views_count || 0)} visualiza${Number(story.views_count || 0) === 1 ? 'ção' : 'ções'}`;
    document.querySelector('#story-progress').innerHTML = group.map((_, index) =>
      `<i style="--progress:${index < storyIndex ? '100%' : '0%'}"></i>`).join('');
    api(`/api/community/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' }).catch(() => {});
    clearInterval(storyTimer);
    storyElapsed = 0;
    storyPaused = false;
    storyTimer = setInterval(() => {
      if (storyPaused || document.hidden) return;
      storyElapsed += 100;
      const bar = document.querySelectorAll('#story-progress i')[storyIndex];
      bar?.style.setProperty('--progress', `${Math.min(100, storyElapsed / 50)}%`);
      if (storyElapsed >= 5000) nextStory();
    }, 100);
  }

  function closeStory() {
    clearInterval(storyTimer);
    const viewer = document.querySelector('#story-viewer');
    if (viewer) viewer.hidden = true;
    document.body.style.overflow = '';
    loadStories();
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
              if (new URLSearchParams(location.search).get('notifications') === '1') loadNotificationsPage({ reset: true }).catch(() => {});
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
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
          setTimeout(() => heading.removeAttribute('tabindex'), 0);
        }
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
      const backToPost = event.target.closest('[data-back-to-post]');
      if (backToPost) pendingCommentFocus = document.querySelector('#subthread-root [data-comment-id]')?.dataset.commentId || null;
      if (event.target.closest('#server-live-pill')) document.querySelector('#server-live-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (event.target.closest('[data-story-add]')) { createStory(); return; }
      const storyGroup = event.target.closest('[data-story-group]');
      if (storyGroup) {
        const groupIndex = Number(storyGroup.dataset.storyGroup);
        const firstUnseen = storyGroups[groupIndex]?.findIndex(story => !story.viewed_by_me) ?? -1;
        openStory(groupIndex, firstUnseen >= 0 ? firstUnseen : 0);
        return;
      }
      if (event.target.closest('[data-story-close]')) { closeStory(); return; }
      if (event.target.closest('[data-story-delete]')) { deleteActiveStory(); return; }
      if (event.target.closest('[data-story-next]')) { if (Date.now() >= storySuppressClickUntil) nextStory(); return; }
      if (event.target.closest('[data-story-prev]')) { if (Date.now() >= storySuppressClickUntil) previousStory(); return; }
      if (event.target.closest('[data-open-schedule-modal]')) {
        openModal('schedule-modal');
        loadScheduledPosts().catch(() => {});
        syncScheduleUI();
        setTimeout(() => document.querySelector('#modal-schedule-at')?.focus(), 80);
        return;
      }
      if (event.target.closest('[data-apply-schedule]')) { syncScheduleUI(); closeModal('schedule-modal'); return; }

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
        const cached = reactionCache.get(String(card.dataset.postId)) || { reactions: [], my_reaction: null };
        const remove = cached.my_reaction === reaction.dataset.reaction;
        const optimistic = optimisticReactionPayload(cached, remove ? null : reaction.dataset.reaction);
        renderReactionSummary(card, optimistic);
        reaction.closest('.reaction-picker').hidden = true;
        buzz(18);
        try {
          const payload = await api(`/api/community/posts/${encodeURIComponent(card.dataset.postId)}/reactions`, {
            method: remove ? 'DELETE' : 'POST',
            body: remove ? undefined : JSON.stringify({ code: reaction.dataset.reaction }),
          });
          renderReactionSummary(card, payload);
        } catch (error) {
          renderReactionSummary(card, cached);
          toast('error', 'Reação indisponível', error.message);
        }
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
      if (Math.abs(dy) > 110 && dy > 0) { storySuppressClickUntil = Date.now() + 300; closeStory(); }
      else if (Math.abs(dx) > 65) { storySuppressClickUntil = Date.now() + 300; dx < 0 ? nextStory() : previousStory(); }
      storyTouch = null;
    }, { passive: true });

    let storyPressAt = 0;
    document.querySelector('.story-stage')?.addEventListener('pointerdown', event => {
      if (!event.target.closest('.story-hit')) return;
      storyPressAt = Date.now();
      storyPaused = true;
    }, { passive: true });
    document.querySelector('.story-stage')?.addEventListener('pointerup', () => {
      if (storyPressAt && Date.now() - storyPressAt > 350) storySuppressClickUntil = Date.now() + 250;
      storyPressAt = 0;
      storyPaused = false;
    }, { passive: true });
    document.querySelector('.story-stage')?.addEventListener('pointercancel', () => {
      storyPressAt = 0;
      storyPaused = false;
    }, { passive: true });
    document.addEventListener('keydown', event => {
      if (document.querySelector('#story-viewer')?.hidden !== false) return;
      if (event.key === 'ArrowRight') nextStory();
      else if (event.key === 'ArrowLeft') previousStory();
      else if (event.key === 'Escape') closeStory();
      else if (event.key === ' ') { event.preventDefault(); storyPaused = !storyPaused; }
    });

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
    new MutationObserver(restorePendingCommentFocus).observe(document.querySelector('#route-col'), { childList: true, subtree: true });
    scheduleDecorate();
    syncScheduleUI();
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
