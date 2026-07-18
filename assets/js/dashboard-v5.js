(() => {
  'use strict';

  const root = () => document.getElementById('social-admin-card');
  const body = () => document.getElementById('social-console-body');
  const live = () => document.getElementById('social-console-live');
  const qs = (selector, scope = document) => scope.querySelector(selector);
  const qsa = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const num = value => Number(value || 0);
  const compact = value => new Intl.NumberFormat('pt-BR', { notation: Math.abs(num(value)) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(num(value));
  const pct = value => `${num(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  const date = value => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const refreshIcons = () => requestAnimationFrame(() => window.lucide?.createIcons?.());
  const isOwner = () => typeof session !== 'undefined' && session?.role === 'owner';
  const isObserver = () => typeof session !== 'undefined' && session?.role === 'observer';
  const canViewModeration = () => !isObserver()
    || (typeof canObserverView === 'function' && canObserverView('moderation_private'));
  const unwrap = payload => payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  const state = {
    pane: 'overview', days: 30, loaded: new Set(), chart: null,
    accountCursor: null, postCursor: null, restrictionCursor: null,
    accountFilters: { q: '', sort: 'reach', status: 'all' },
    postFilters: { q: '', sort: 'recent', format: 'all', status: 'active' },
    drawerReturnFocus: null, drawerCloseTimer: 0, drawerSequence: 0, activeDrawerId: 0, debounce: 0,
  };

  function safeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      const localHttp = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !localHttp) return '';
      return url.href;
    } catch { return ''; }
  }

  function avatarOf(item, size = 80) {
    return safeUrl(item?.profile_photo_url || item?.avatar_url || item?.photo_url)
      || `https://minotar.net/helm/${encodeURIComponent(item?.minecraft_name || item?.username || 'Steve')}/${size}.png`;
  }

  async function request(path, options = {}) {
    if (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW) return preview(path);
    const response = await apiFetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('fa_token') || ''}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Não foi possível concluir (${response.status}).`);
    return unwrap(payload);
  }

  function preview(path) {
    const people = Array.from({ length: 9 }, (_, index) => ({
      id: index + 1, username: `membro${index + 1}`, display_name: `Membro ${index + 1}`,
      minecraft_name: ['Steve', 'Alex', 'Luna', 'Caio'][index % 4], followers: 84 - index * 6,
      posts: 22 - index, impressions: 4200 - index * 260, engagement_rate: 8.7 - index * .4,
      restriction_level: index === 5 ? 2 : null, last_activity_at: new Date(Date.now() - index * 86400000).toISOString(),
    }));
    const posts = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1, author_id: people[index % people.length].id, ...people[index % people.length],
      content: `Publicação completa de demonstração ${index + 1}. Este console preserva o texto integral e reúne contexto, mídia, métricas e ações no mesmo lugar.`,
      created_at: new Date(Date.now() - index * 7200000).toISOString(), impressions: 2500 - index * 190,
      unique_viewers: 1100 - index * 75, likes: 160 - index * 8, comments: 34 - index,
      saves: 27 - index, reposts: 18 - index, engagement_rate: 9.4 - index * .3,
      media_urls: index % 3 === 0 ? ['assets/images/hero.png'] : [], restriction_level: index === 4 ? 1 : null,
    }));
    if (/accounts\/\d+/.test(path)) return { account: people[0], summary: people[0], daily: [], posts: posts.slice(0, 4) };
    if (/posts\/\d+/.test(path)) return { post: posts[0], metrics: posts[0], daily: [], reports: [], restriction: null };
    if (path.includes('/accounts')) return { items: people, next_cursor: null };
    if (path.includes('/posts')) return { items: posts, next_cursor: null };
    if (path.includes('/restrictions')) return { items: [{ id: 1, target_type: 'profile', target_id: 6, target_name: 'membro6', level: 2, delivery_factor: .3, reason_code: 'spam', reason_detail: 'Padrão repetitivo em revisão.', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString(), status: 'active' }] };
    return {
      summary: { impressions: 28420, unique_viewers: 3412, active_creators: 86, posts: 264, interactions: 3870, engagement_rate: 13.6, avg_dwell_ms: 12400, reports: 7, active_restrictions: 1 },
      daily: Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - (13 - i) * 86400000).toISOString(), impressions: 1200 + i * 95, interactions: 180 + i * 12, posts: 8 + i % 5 })),
      top_posts: posts.slice(0, 5), active_restrictions: 1,
    };
  }

  function announce(message, tone = '') {
    const target = live();
    if (!target) return;
    target.textContent = message || '';
    target.dataset.tone = tone;
  }

  function loading(label = 'Carregando dados da rede social…') {
    if (!body()) return;
    body().innerHTML = `<div class="social-console-loading"><span></span><span></span><span></span><p>${esc(label)}</p></div>`;
  }

  function failure(error, retryPane = state.pane) {
    if (!body()) return;
    body().innerHTML = `<div class="social-empty">${icon('cloud-alert')}<strong>Não foi possível carregar esta área</strong><p>${esc(error?.message || 'Tente novamente em instantes.')}</p><button class="btn-export social-load-more" type="button" data-social-retry="${esc(retryPane)}">Tentar novamente</button></div>`;
    refreshIcons();
  }

  function kpi(label, value, detail, tone = '') {
    return `<article class="social-kpi" ${tone ? `data-tone="${tone}"` : ''}><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
  }

  function statusBadge(level, status = 'active') {
    if (!canViewModeration()) return '<span class="social-status is-warning">Censurado</span>';
    const normalizedStatus = String(status || 'active').toLowerCase();
    if (!['active', 'normal'].includes(normalizedStatus)) {
      const labels = { removed: 'Removida', pending: 'Em revisão', rejected: 'Rejeitada' };
      return `<span class="social-status is-warning">${esc(labels[normalizedStatus] || normalizedStatus)}</span>`;
    }
    if (level) return `<span class="social-status is-restricted">Entrega nível ${esc(level)}</span>`;
    return '<span class="social-status">Normal</span>';
  }

  function metricsOf(item = {}) {
    return {
      impressions: num(item.impressions ?? item.view_count ?? item.reach),
      viewers: num(item.unique_viewers ?? item.viewers),
      likes: num(item.likes ?? item.likes_count),
      comments: num(item.comments ?? item.comments_count),
      saves: num(item.saves ?? item.saves_count),
      reposts: num(item.reposts ?? item.reposts_count),
    };
  }

  async function loadOverview(force = false) {
    loading('Consolidando alcance, participação e sinais de segurança…');
    try {
      const data = await request(`/api/admin/community/overview?days=${state.days}`);
      const summary = data.summary || data.totals || data || {};
      const impressions = num(summary.impressions);
      const interactions = num(summary.interactions ?? summary.engagements);
      const rate = summary.engagement_rate ?? (impressions ? interactions / impressions * 100 : 0);
      const moderationCensored = !canViewModeration() || summary.moderation_censored || data.moderation_censored;
      body().innerHTML = `
        <section class="social-kpi-grid">
          ${kpi('Alcance', compact(impressions), `${compact(summary.unique_viewers)} pessoas únicas`, 'blue')}
          ${kpi('Interações', compact(interactions), `${pct(rate)} por impressão`, 'green')}
          ${kpi('Criadores ativos', compact(summary.active_creators), `${compact(summary.posts)} publicações`, 'gold')}
          ${kpi('Atenção média', `${(num(summary.avg_dwell_ms) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}s`, 'por impressão medida')}
          ${kpi('Denúncias', moderationCensored ? 'Censurado' : compact(summary.reports ?? summary.pending_reports), moderationCensored ? 'acesso definido pelo proprietário' : 'no período', !moderationCensored && num(summary.reports ?? summary.pending_reports) ? 'red' : '')}
          ${kpi('Entrega limitada', moderationCensored ? 'Censurado' : compact(summary.active_restrictions ?? data.active_restrictions), moderationCensored ? 'acesso definido pelo proprietário' : 'restrições ativas', !moderationCensored && num(summary.active_restrictions ?? data.active_restrictions) ? 'red' : '')}
        </section>
        <section class="social-overview-layout">
          <article class="social-panel social-chart-panel">
            <div class="social-panel-head"><div><h3>Distribuição e resposta</h3><p>Evolução diária do conteúdo entregue e das ações recebidas.</p></div><span class="social-status">${state.days} dias</span></div>
            <div class="social-chart-wrap"><canvas id="social-overview-chart" aria-label="Tendência diária da rede social"></canvas></div>
          </article>
          <article class="social-panel">
            <div class="social-panel-head"><div><h3>Conteúdo em destaque</h3><p>Abra para ver a publicação inteira e agir.</p></div></div>
            <div class="social-rank-list">${renderTopPosts(data.top_posts || data.top_content || [])}</div>
          </article>
        </section>`;
      renderOverviewChart(data.daily || data.trend || []);
      state.loaded.add('overview');
      refreshIcons();
      if (force) announce('Visão geral atualizada agora.', 'success');
    } catch (error) { failure(error, 'overview'); }
  }

  function renderTopPosts(items) {
    if (!items.length) return '<div class="social-empty"><strong>Nenhuma publicação no período</strong><p>O ranking aparecerá quando houver alcance medido.</p></div>';
    return items.slice(0, 6).map(item => {
      const name = item.display_name || item.minecraft_name || item.username || `Perfil #${item.author_id || ''}`;
      const value = metricsOf(item).impressions || num(item.score);
      return `<button class="social-rank-item" type="button" data-social-post="${esc(item.id || item.post_id)}"><img src="${esc(avatarOf(item, 76))}" alt="" loading="lazy"><span><strong>${esc(name)}</strong><small>${esc(item.content || item.preview || 'Publicação com mídia')}</small></span><b>${compact(value)}</b></button>`;
    }).join('');
  }

  function renderOverviewChart(rows) {
    state.chart?.destroy?.();
    const canvas = qs('#social-overview-chart');
    if (!canvas || !window.Chart) return;
    const css = getComputedStyle(document.documentElement);
    state.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: rows.map(row => new Date(row.day || row.bucket).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })),
        datasets: [
          { label: 'Impressões', data: rows.map(row => num(row.impressions)), borderColor: css.getPropertyValue('--staff-blue').trim(), backgroundColor: 'transparent', tension: .35, borderWidth: 2, pointRadius: 0 },
          { label: 'Interações', data: rows.map(row => num(row.interactions ?? row.engagements)), borderColor: css.getPropertyValue('--staff-green').trim(), backgroundColor: 'transparent', tension: .35, borderWidth: 2, pointRadius: 0 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 16 } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
    });
    window.faStaffSyncCharts?.();
  }

  function accountFilters() {
    const moderationOptions = canViewModeration()
      ? '<option value="normal">Entrega normal</option><option value="restricted">Entrega limitada</option>'
      : '';
    return `<form class="social-filterbar" data-social-account-filters>
      <label class="social-search">Buscar conta${icon('search')}<input name="q" type="search" value="${esc(state.accountFilters.q)}" placeholder="Nome, @usuário ou Minecraft" autocomplete="off"></label>
      <label>Status<select name="status"><option value="all">Todos</option>${moderationOptions}</select></label>
      <label>Ordenar por<select name="sort"><option value="reach">Maior alcance</option><option value="engagement">Engajamento</option><option value="followers">Seguidores</option><option value="recent">Atividade recente</option></select></label>
      <button class="btn-export" type="submit">Aplicar filtros</button>
    </form>`;
  }

  async function loadAccounts({ append = false } = {}) {
    if (!append) loading('Localizando contas e calculando desempenho…');
    try {
      const query = new URLSearchParams({ days: String(state.days), q: state.accountFilters.q, sort: state.accountFilters.sort, status: state.accountFilters.status, limit: '30' });
      if (append && state.accountCursor) query.set('cursor', state.accountCursor);
      const data = await request(`/api/admin/community/accounts?${query}`);
      const items = data.items || data.rows || [];
      state.accountCursor = data.next_cursor || null;
      const table = renderAccounts(items);
      if (append) {
        const tbody = qs('#social-accounts-rows');
        if (tbody) tbody.insertAdjacentHTML('beforeend', table.rows);
        qs('[data-social-more-accounts]')?.remove();
        if (state.accountCursor) body().insertAdjacentHTML('beforeend', '<button class="btn-export social-load-more" type="button" data-social-more-accounts>Carregar mais contas</button>');
      } else {
        body().innerHTML = `${accountFilters()}${table.html}${state.accountCursor ? '<button class="btn-export social-load-more" type="button" data-social-more-accounts>Carregar mais contas</button>' : ''}`;
        const form = qs('[data-social-account-filters]');
        if (form) {
          form.elements.status.value = state.accountFilters.status;
          form.elements.sort.value = state.accountFilters.sort;
        }
      }
      state.loaded.add('accounts');
      refreshIcons();
    } catch (error) { if (!append) failure(error, 'accounts'); else announce(error.message, 'error'); }
  }

  function renderAccounts(items) {
    if (!items.length) return { rows: '', html: '<div class="social-empty">' + icon('user-search') + '<strong>Nenhuma conta encontrada</strong><p>Remova algum filtro ou tente outra busca.</p></div>' };
    const rows = items.map(item => `<tr tabindex="0" role="button" data-social-account="${esc(item.id || item.user_id)}" aria-label="Abrir analytics de ${esc(item.display_name || item.username)}">
      <td><div class="social-account-cell"><img src="${esc(avatarOf(item))}" alt="" loading="lazy"><span><strong>${esc(item.display_name || item.minecraft_name || item.username)}</strong><span>@${esc(item.username || item.minecraft_name || item.id)}</span></span></div></td>
      <td>${compact(item.impressions ?? item.reach)}</td><td>${pct(item.engagement_rate)}</td><td>${compact(item.followers)}</td><td>${compact(item.posts)}</td><td>${statusBadge(item.restriction_level, item.status)}</td><td>${esc(date(item.last_activity_at || item.last_seen_at))}</td>
    </tr>`).join('');
    return { rows, html: `<div class="social-table-wrap mobile-scroll-affordance" tabindex="0" aria-label="Tabela de contas; deslize horizontalmente para ver todas as métricas"><table class="social-table"><thead><tr><th>Conta</th><th>Alcance</th><th>Engajamento</th><th>Seguidores</th><th>Posts</th><th>Entrega</th><th>Atividade</th></tr></thead><tbody id="social-accounts-rows">${rows}</tbody></table></div>` };
  }

  function postFilters() {
    const moderationOptions = canViewModeration()
      ? '<option value="normal">Ativas sem limitação</option><option value="restricted">Entrega limitada</option><option value="reported">Denunciada</option><option value="removed">Removida</option>'
      : '';
    const moderationSort = canViewModeration() ? '<option value="reports">Mais denúncias</option>' : '';
    return `<form class="social-filterbar" data-social-post-filters>
      <label class="social-search">Buscar publicação${icon('search')}<input name="q" type="search" value="${esc(state.postFilters.q)}" placeholder="Texto completo, autor ou ID" autocomplete="off"></label>
      <label>Formato<select name="format"><option value="all">Todos</option><option value="text">Texto</option><option value="media">Com mídia</option><option value="poll">Enquete</option><option value="repost">Repost</option></select></label>
      <label>Estado<select name="status"><option value="active">Ativas</option>${moderationOptions}<option value="pinned">Fixadas</option></select></label>
      <label>Ordenar<select name="sort"><option value="recent">Mais recentes</option><option value="reach">Maior alcance</option><option value="engagement">Maior engajamento</option>${moderationSort}</select></label>
      <button class="btn-export" type="submit">Aplicar</button>
    </form>`;
  }

  async function loadPosts({ append = false } = {}) {
    if (!append) loading('Carregando publicações completas e métricas…');
    try {
      const query = new URLSearchParams({ days: String(state.days), q: state.postFilters.q, sort: state.postFilters.sort, format: state.postFilters.format, status: state.postFilters.status, limit: '20' });
      if (append && state.postCursor) query.set('cursor', state.postCursor);
      const data = await request(`/api/admin/community/posts?${query}`);
      const items = data.items || data.rows || [];
      state.postCursor = data.next_cursor || null;
      if (append) {
        qs('#social-post-list')?.insertAdjacentHTML('beforeend', renderPostCards(items));
        qs('[data-social-more-posts]')?.remove();
        if (state.postCursor) body().insertAdjacentHTML('beforeend', '<button class="btn-export social-load-more" type="button" data-social-more-posts>Carregar mais publicações</button>');
      } else {
        body().innerHTML = `${postFilters()}${items.length ? `<div class="social-post-list" id="social-post-list">${renderPostCards(items)}</div>` : `<div class="social-empty">${icon('files')}<strong>Nenhuma publicação encontrada</strong><p>Ajuste os filtros para ampliar a busca.</p></div>`}${state.postCursor ? '<button class="btn-export social-load-more" type="button" data-social-more-posts>Carregar mais publicações</button>' : ''}`;
        const form = qs('[data-social-post-filters]');
        if (form) Object.entries(state.postFilters).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
      }
      state.loaded.add('posts');
      refreshIcons();
    } catch (error) { if (!append) failure(error, 'posts'); else announce(error.message, 'error'); }
  }

  function renderMedia(urls) {
    const list = (Array.isArray(urls) ? urls : []).map(safeUrl).filter(Boolean);
    if (!list.length) return '';
    return `<div class="social-post-media">${list.map(url => /\.(mp4|webm|mov)(\?|$)/i.test(url) ? `<video src="${esc(url)}" controls preload="metadata"></video>` : `<img src="${esc(url)}" alt="Mídia da publicação" loading="lazy">`).join('')}</div>`;
  }

  function renderPostCards(items) {
    return items.map(item => {
      const m = metricsOf(item);
      const postId = item.id || item.post_id;
      const moderationStatus = String(item.moderation_status || 'active').toLowerCase();
      const isActive = moderationStatus === 'active';
      return `<article class="social-post-card" data-post-id="${esc(postId)}">
        <header class="social-post-head"><img class="social-avatar" src="${esc(avatarOf(item))}" alt="" loading="lazy"><span><strong>${esc(item.display_name || item.minecraft_name || item.username || `Perfil #${item.author_id}`)}</strong><small>${esc(date(item.created_at))}${item.is_pinned ? ' · fixada' : ''}</small></span>${statusBadge(item.restriction_level, moderationStatus)}</header>
        <div class="social-post-content">${esc(item.content || '') || '<span style="color:var(--staff-muted)">Publicação sem texto</span>'}</div>
        ${renderMedia(item.media_urls)}
        <div class="social-post-metrics"><span><b>${compact(m.impressions)}</b>impressões</span><span><b>${compact(m.viewers)}</b>pessoas</span><span><b>${compact(m.likes + m.comments + m.saves + m.reposts)}</b>interações</span><span><b>${pct(item.engagement_rate)}</b>taxa</span></div>
        <footer class="social-post-actions"><button class="social-mini-action" type="button" data-social-post="${esc(postId)}">Ver analytics</button>${isActive ? `<button class="social-mini-action" type="button" data-social-open-post="${esc(postId)}">Abrir publicação</button><button class="social-mini-action" type="button" data-social-copy-post="${esc(postId)}">Copiar link</button>${!isObserver() ? `<button class="social-mini-action" type="button" data-social-pin-post="${esc(postId)}" data-pinned="${item.is_pinned ? '1' : '0'}">${item.is_pinned ? 'Desafixar' : 'Fixar'}</button>` : ''}${isOwner() ? `<button class="social-mini-action is-danger" type="button" data-social-restrict="post" data-target-id="${esc(postId)}">Limitar entrega</button>` : ''}` : '<span class="social-status is-warning">Conteúdo preservado para auditoria</span>'}</footer>
      </article>`;
    }).join('');
  }

  async function loadDelivery({ append = false } = {}) {
    if (!canViewModeration()) {
      body().innerHTML = `<div class="social-empty">${icon('eye-off')}<strong>Censurado</strong><p>O proprietário não liberou dados de moderação e controles de entrega para este observador.</p></div>`;
      state.loaded.add('delivery');
      refreshIcons();
      return;
    }
    if (!append) loading('Carregando políticas ativas e histórico de entrega…');
    try {
      const query = new URLSearchParams({ status: 'all', limit: '40' });
      if (append && state.restrictionCursor) query.set('cursor', state.restrictionCursor);
      const data = await request(`/api/admin/community/restrictions?${query}`);
      const items = data.items || data.rows || [];
      state.restrictionCursor = data.next_cursor || null;
      const content = renderRestrictions(items);
      if (append) {
        qs('#social-restriction-list')?.insertAdjacentHTML('beforeend', content);
        qs('[data-social-more-restrictions]')?.remove();
      } else {
        body().innerHTML = `<div class="social-panel-head"><div><h3>Controles de alcance</h3><p>Reduções são invisíveis ao alvo, expiram automaticamente e deixam trilha de auditoria.</p></div>${isOwner() ? '<button class="btn-export" type="button" data-social-new-restriction>' + icon('shield-plus') + ' Nova restrição</button>' : ''}</div>${items.length ? `<div class="social-restriction-list" id="social-restriction-list">${content}</div>` : `<div class="social-empty">${icon('shield-check')}<strong>Nenhuma restrição registrada</strong><p>A entrega está operando sem limitações administrativas.</p></div>`}`;
      }
      if (state.restrictionCursor) body().insertAdjacentHTML('beforeend', '<button class="btn-export social-load-more" type="button" data-social-more-restrictions>Carregar histórico</button>');
      state.loaded.add('delivery');
      refreshIcons();
    } catch (error) { if (!append) failure(error, 'delivery'); else announce(error.message, 'error'); }
  }

  function renderRestrictions(items) {
    return items.map(item => {
      const target = item.target_name || item.username || `${item.target_type === 'profile' ? 'Perfil' : 'Publicação'} #${item.target_id}`;
      const end = item.ends_at || item.expires_at;
      return `<article class="social-restriction is-level-${esc(item.level)}"><div><h4>${esc(target)} · nível ${esc(item.level)}</h4><p>${esc(item.reason_detail || item.reason_code || 'Motivo administrativo não informado.')}</p><div class="social-restriction-meta"><span>${esc(item.target_type === 'profile' ? 'Perfil' : 'Publicação')}</span><span>Entrega ${pct(num(item.delivery_factor) * 100)}</span><span>${end ? `até ${date(end)}` : 'permanente'}</span><span>${esc(item.status || 'active')}</span></div></div>${isOwner() && (item.status || 'active') === 'active' ? `<button class="social-mini-action" type="button" data-social-revoke="${esc(item.id)}">Restaurar entrega</button>` : ''}</article>`;
    }).join('');
  }

  async function openAccount(id) {
    const drawerId = openDrawer('Analytics da conta', 'Carregando perfil e desempenho…', '<div class="social-console-loading"><span></span><span></span><span></span></div>');
    try {
      const data = await request(`/api/admin/community/accounts/${encodeURIComponent(id)}/analytics?days=${state.days}`);
      if (state.activeDrawerId !== drawerId) return;
      const account = data.account || data.profile || data.user || {};
      const summary = data.summary || data.metrics || account;
      const posts = (data.posts?.items || data.posts || data.top_posts || []).map(post => ({ ...account, ...post }));
      setDrawerContent('Analytics da conta', `Janela de ${state.days} dias`, `
        <section class="social-drawer-section"><div class="social-detail-identity"><img src="${esc(avatarOf(account, 124))}" alt=""><div><strong>${esc(account.display_name || account.minecraft_name || account.username || `Perfil #${id}`)}</strong><span>@${esc(account.username || account.minecraft_name || id)}</span>${statusBadge(account.restriction_level || data.restriction?.level)}</div></div><div class="social-detail-kpis"><div><b>${compact(summary.impressions)}</b><span>impressões</span></div><div><b>${compact(summary.unique_viewers)}</b><span>pessoas alcançadas</span></div><div><b>${pct(summary.engagement_rate)}</b><span>engajamento</span></div><div><b>${compact(summary.followers)}</b><span>seguidores</span></div><div><b>${compact(summary.profile_views)}</b><span>visitas ao perfil</span></div><div><b>${compact(summary.followers_gained)}</b><span>novos seguidores</span></div><div><b>${compact(summary.reports)}</b><span>denúncias</span></div><div><b>${(num(summary.avg_dwell_ms) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}s</b><span>atenção média</span></div></div></section>
        <section class="social-drawer-section"><h3>Publicações recentes</h3><div class="social-post-list">${posts.length ? renderPostCards(posts.slice(0, 6)) : '<div class="social-empty"><strong>Sem publicações no período</strong></div>'}</div></section>`,
        `<button class="btn-export" type="button" data-social-open-profile="${esc(id)}">Abrir perfil público</button>${isOwner() ? `<button class="btn-primary" type="button" data-social-restrict="profile" data-target-id="${esc(id)}">Limitar entrega do perfil</button>` : ''}`, drawerId);
    } catch (error) { setDrawerContent('Analytics da conta', '', `<div class="social-empty"><strong>Não foi possível carregar</strong><p>${esc(error.message)}</p></div>`, '', drawerId); }
  }

  async function openPost(id) {
    const drawerId = openDrawer('Analytics da publicação', 'Carregando conteúdo completo…', '<div class="social-console-loading"><span></span><span></span><span></span></div>');
    try {
      const data = await request(`/api/admin/community/posts/${encodeURIComponent(id)}?days=${state.days}`);
      if (state.activeDrawerId !== drawerId) return;
      const post = data.post || data.item || data;
      const m = data.metrics ? metricsOf({ ...post, ...data.metrics }) : metricsOf(post);
      const metrics = data.metrics || post;
      const moderationStatus = String(post.moderation_status || 'active').toLowerCase();
      const isActive = moderationStatus === 'active';
      setDrawerContent('Analytics da publicação', `Publicada em ${date(post.created_at)}`, `
        <section class="social-drawer-section"><div class="social-post-head" style="padding:0"><img class="social-avatar" src="${esc(avatarOf(post))}" alt=""><span><strong>${esc(post.display_name || post.minecraft_name || post.username || `Perfil #${post.author_id}`)}</strong><small>@${esc(post.username || post.minecraft_name || post.author_id)}</small></span>${statusBadge(post.restriction_level || data.restriction?.level, moderationStatus)}</div><div class="social-post-content" style="padding-inline:0">${esc(post.content || '') || 'Publicação sem texto'}</div>${renderMedia(post.media_urls)}</section>
        <section class="social-drawer-section"><h3>Desempenho</h3><div class="social-detail-kpis"><div><b>${compact(m.impressions)}</b><span>impressões</span></div><div><b>${compact(m.viewers)}</b><span>pessoas</span></div><div><b>${compact(m.likes)}</b><span>curtidas</span></div><div><b>${compact(m.comments)}</b><span>comentários</span></div><div><b>${compact(m.saves)}</b><span>salvos</span></div><div><b>${compact(m.reposts)}</b><span>reposts</span></div><div><b>${pct(metrics.engagement_rate)}</b><span>engajamento</span></div><div><b>${(num(metrics.avg_dwell_ms) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}s</b><span>atenção média</span></div></div></section>
        ${(data.reports || []).length ? `<section class="social-drawer-section"><h3>Denúncias</h3>${data.reports.map(report => `<p style="color:var(--staff-muted);font-size:11px">${esc(report.reason || report.reason_code)} · ${esc(date(report.created_at))}</p>`).join('')}</section>` : ''}`,
        isActive ? `<button class="btn-export" type="button" data-social-open-post="${esc(id)}">Abrir publicação</button><button class="btn-export" type="button" data-social-copy-post="${esc(id)}">Copiar link</button>${!isObserver() ? `<button class="btn-export" type="button" data-social-pin-post="${esc(id)}" data-pinned="${post.is_pinned ? '1' : '0'}">${post.is_pinned ? 'Desafixar' : 'Fixar'}</button>` : ''}${isOwner() ? `<button class="btn-primary" type="button" data-social-restrict="post" data-target-id="${esc(id)}">Limitar entrega</button>` : ''}` : '<span class="social-status is-warning">Publicação removida · somente auditoria</span>', drawerId);
    } catch (error) { setDrawerContent('Analytics da publicação', '', `<div class="social-empty"><strong>Não foi possível carregar</strong><p>${esc(error.message)}</p></div>`, '', drawerId); }
  }

  function openDrawer(title, subtitle, content, actions = '') {
    const existingDrawer = qs('.social-drawer');
    const returnFocus = existingDrawer ? state.drawerReturnFocus : document.activeElement;
    clearTimeout(state.drawerCloseTimer);
    state.drawerCloseTimer = 0;
    qsa('.social-drawer, .social-drawer-backdrop').forEach(element => element.remove());
    document.body.classList.remove('modal-open');
    state.drawerReturnFocus = returnFocus;
    const drawerId = ++state.drawerSequence;
    state.activeDrawerId = drawerId;
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'social-drawer-backdrop';
    backdrop.dataset.socialDrawerClose = '1';
    backdrop.setAttribute('aria-label', 'Fechar painel lateral');
    const drawer = document.createElement('aside');
    drawer.className = 'social-drawer';
    drawer.dataset.socialDrawerId = String(drawerId);
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `<header class="social-drawer-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="social-drawer-close" type="button" data-social-drawer-close aria-label="Fechar">${icon('x')}</button></header><div class="social-drawer-body">${content}</div><footer class="social-drawer-actions">${actions}</footer>`;
    document.body.append(backdrop, drawer);
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => { backdrop.classList.add('is-open'); drawer.classList.add('is-open'); qs('[data-social-drawer-close]', drawer)?.focus(); });
    refreshIcons();
    return drawerId;
  }

  function setDrawerContent(title, subtitle, content, actions = '', drawerId = state.activeDrawerId) {
    if (!drawerId || state.activeDrawerId !== drawerId) return false;
    const drawer = qsa('.social-drawer').find(element => Number(element.dataset.socialDrawerId) === drawerId);
    if (!drawer) return false;
    qs('.social-drawer-head h2', drawer).textContent = title;
    qs('.social-drawer-head p', drawer).textContent = subtitle;
    qs('.social-drawer-body', drawer).innerHTML = content;
    qs('.social-drawer-actions', drawer).innerHTML = actions;
    qs('.social-drawer-actions', drawer).hidden = !actions;
    refreshIcons();
    return true;
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    const drawer = qs('.social-drawer');
    const backdrop = qs('.social-drawer-backdrop');
    if (!drawer && !backdrop) return;
    const returnFocus = state.drawerReturnFocus;
    const drawerId = Number(drawer?.dataset.socialDrawerId || 0);
    if (state.activeDrawerId === drawerId) state.activeDrawerId = 0;
    clearTimeout(state.drawerCloseTimer);
    drawer?.classList.remove('is-open');
    backdrop?.classList.remove('is-open');
    state.drawerCloseTimer = setTimeout(() => {
      drawer?.remove();
      backdrop?.remove();
      if (!qs('.social-drawer')) document.body.classList.remove('modal-open');
      state.drawerCloseTimer = 0;
      if (state.drawerReturnFocus === returnFocus) state.drawerReturnFocus = null;
    }, 210);
    if (restoreFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function restrictionComposer(type = 'profile', id = '') {
    if (!isOwner()) return announce('Apenas o proprietário pode alterar a entrega.', 'error');
    openDrawer('Limitar entrega', 'Controle proporcional, temporário e auditável', `
      <form class="social-restriction-form" data-social-restriction-form>
        <div class="social-form-grid"><label>Alvo<select name="target_type"><option value="profile">Perfil</option><option value="post">Publicação</option></select></label><label>ID do alvo<input name="target_id" inputmode="numeric" pattern="[0-9]+" required value="${esc(id)}" placeholder="Ex.: 248"></label></div>
        <label>Nível de redução<div class="social-level-options">${[[1,'65%'],[2,'30%'],[3,'8%'],[4,'0%']].map(([level, factor]) => `<label><input type="radio" name="level" value="${level}" ${level === 1 ? 'checked' : ''}><span><b>${level}</b><small>${factor} da entrega</small></span></label>`).join('')}</div></label>
        <div class="social-form-grid"><label>Duração<select name="duration_hours" data-social-restriction-duration><option value="6">6 horas</option><option value="24" selected>24 horas</option><option value="72">3 dias</option><option value="168">7 dias</option><option value="720">30 dias</option><option value="0">Permanente</option></select></label><label>Categoria<select name="reason_code" required><option value="spam">Spam ou manipulação</option><option value="safety">Risco à comunidade</option><option value="quality">Baixa qualidade recorrente</option><option value="investigation">Em investigação</option><option value="other">Outro</option></select></label></div>
        <label>Superfícies<div style="display:flex;flex-wrap:wrap;gap:10px"><label><input type="checkbox" name="surfaces" value="feed" checked> Feed</label><label><input type="checkbox" name="surfaces" value="trending" checked> Em alta</label><label><input type="checkbox" name="surfaces" value="discover" checked> Descoberta</label><label><input type="checkbox" name="surfaces" value="search" checked> Busca</label><label><input type="checkbox" name="surfaces" value="notifications" checked> Notificações</label><label><input type="checkbox" name="surfaces" value="sitemap" checked> Busca externa / sitemap</label></div></label>
        <label>Justificativa detalhada<textarea name="reason_detail" rows="4" maxlength="500" required placeholder="Descreva sinais observados, contexto e objetivo da medida."></textarea></label>
        <label style="display:flex;grid-template-columns:auto 1fr;align-items:start"><input type="checkbox" name="confirmed" required><span>Confirmo que revisei o impacto e que esta medida deve ficar registrada na auditoria.</span></label>
        <label data-social-permanent-confirm hidden style="display:flex;grid-template-columns:auto 1fr;align-items:start"><input type="checkbox" name="permanent_confirmed"><span>Confirmo separadamente que esta restrição não terá expiração automática.</span></label>
        <button class="btn-primary" type="submit">Aplicar controle de alcance</button>
      </form>`, '');
    qs('[name="target_type"]', qs('.social-drawer'))?.setAttribute('value', type);
    const typeSelect = qs('[name="target_type"]', qs('.social-drawer'));
    if (typeSelect) typeSelect.value = type;
  }

  async function submitRestriction(form) {
    const submit = qs('button[type="submit"]', form);
    const fields = new FormData(form);
    const durationHours = num(fields.get('duration_hours'));
    const permanent = durationHours === 0;
    if (permanent && !fields.has('permanent_confirmed')) return announce('Confirme explicitamente a aplicação permanente.', 'error');
    const payload = {
      target_type: fields.get('target_type'), target_id: num(fields.get('target_id')),
      level: num(fields.get('level')), duration_hours: durationHours,
      ends_at: durationHours ? new Date(Date.now() + durationHours * 3600000).toISOString() : null,
      permanent,
      ...(permanent ? { confirm: 'RESTRINGIR PERMANENTEMENTE' } : {}),
      surfaces: fields.getAll('surfaces'), reason_code: fields.get('reason_code'),
      reason_detail: String(fields.get('reason_detail') || '').trim(),
    };
    if (!payload.target_id || !payload.reason_detail || !payload.surfaces.length) return announce('Preencha alvo, justificativa e ao menos uma superfície.', 'error');
    submit.disabled = true;
    submit.textContent = 'Aplicando…';
    try {
      await request('/api/admin/community/restrictions', { method: 'POST', body: JSON.stringify(payload) });
      closeDrawer();
      state.loaded.delete('delivery');
      announce('Controle de alcance aplicado e registrado na auditoria.', 'success');
      if (state.pane === 'delivery') loadDelivery();
    } catch (error) { announce(error.message, 'error'); submit.disabled = false; submit.textContent = 'Aplicar controle de alcance'; }
  }

  async function revokeRestriction(id) {
    if (!isOwner()) return;
    const reason = window.prompt('Motivo para restaurar a entrega:');
    if (!reason?.trim()) return;
    try {
      await request(`/api/admin/community/restrictions/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      announce('Entrega restaurada e ação auditada.', 'success');
      loadDelivery();
    } catch (error) { announce(error.message, 'error'); }
  }

  async function togglePin(id, pinned, button) {
    if (isObserver()) return;
    button.disabled = true;
    try {
      await request(`/api/admin/posts/${encodeURIComponent(id)}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned: !pinned }) });
      announce(`Publicação ${pinned ? 'desafixada' : 'fixada'}.`, 'success');
      state.loaded.delete('posts');
      if (state.pane === 'posts') loadPosts();
      else openPost(id);
    } catch (error) { announce(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function selectPane(pane, { force = false } = {}) {
    if (!['overview', 'accounts', 'posts', 'delivery'].includes(pane)) pane = 'overview';
    if (pane === 'delivery' && !canViewModeration()) pane = 'overview';
    state.pane = pane;
    qsa('[data-social-pane]', root()).forEach(button => {
      const active = button.dataset.socialPane === pane;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    if (force) state.loaded.delete(pane);
    announce('');
    if (pane === 'overview') loadOverview(force);
    if (pane === 'accounts') loadAccounts();
    if (pane === 'posts') loadPosts();
    if (pane === 'delivery') loadDelivery();
  }

  function bind() {
    const card = root();
    if (!card || card.dataset.socialBound) return;
    card.dataset.socialBound = '1';
    const deliveryTab = qs('[data-social-pane="delivery"]', card);
    if (deliveryTab && !canViewModeration()) {
      deliveryTab.hidden = true;
      deliveryTab.setAttribute('aria-hidden', 'true');
    }
    card.addEventListener('click', event => {
      const pane = event.target.closest('[data-social-pane]');
      if (pane) return selectPane(pane.dataset.socialPane);
      if (event.target.closest('[data-social-refresh]')) return selectPane(state.pane, { force: true });
      const retry = event.target.closest('[data-social-retry]');
      if (retry) return selectPane(retry.dataset.socialRetry, { force: true });
      if (event.target.closest('[data-social-more-accounts]')) return loadAccounts({ append: true });
      if (event.target.closest('[data-social-more-posts]')) return loadPosts({ append: true });
      if (event.target.closest('[data-social-more-restrictions]')) return loadDelivery({ append: true });
      const account = event.target.closest('[data-social-account]');
      if (account) return openAccount(account.dataset.socialAccount);
      const post = event.target.closest('[data-social-post]');
      if (post) return openPost(post.dataset.socialPost);
      if (event.target.closest('[data-social-new-restriction]')) return restrictionComposer();
    });
    card.addEventListener('submit', event => {
      if (event.target.matches('[data-social-account-filters]')) {
        event.preventDefault(); const data = new FormData(event.target);
        state.accountFilters = { q: String(data.get('q') || '').trim(), status: data.get('status'), sort: data.get('sort') }; loadAccounts();
      }
      if (event.target.matches('[data-social-post-filters]')) {
        event.preventDefault(); const data = new FormData(event.target);
        state.postFilters = { q: String(data.get('q') || '').trim(), format: data.get('format'), status: data.get('status'), sort: data.get('sort') }; loadPosts();
      }
    });
    card.addEventListener('input', event => {
      if (!event.target.matches('[data-social-account-filters] input[type="search"], [data-social-post-filters] input[type="search"]')) return;
      clearTimeout(state.debounce);
      state.debounce = setTimeout(() => event.target.form?.requestSubmit(), 420);
    });
    qs('#social-period', card)?.addEventListener('change', event => {
      state.days = Math.max(7, Math.min(90, num(event.target.value) || 30));
      state.loaded.clear();
      selectPane(state.pane, { force: true });
    });
  }

  document.addEventListener('click', event => {
    if (event.target.closest('[data-social-drawer-close]')) return closeDrawer();
    const analytics = event.target.closest('[data-social-post]');
    if (analytics && !root()?.contains(analytics)) return openPost(analytics.dataset.socialPost);
    const restrict = event.target.closest('[data-social-restrict]');
    if (restrict) return restrictionComposer(restrict.dataset.socialRestrict, restrict.dataset.targetId);
    const revoke = event.target.closest('[data-social-revoke]');
    if (revoke) return revokeRestriction(revoke.dataset.socialRevoke);
    const pin = event.target.closest('[data-social-pin-post]');
    if (pin) return togglePin(pin.dataset.socialPinPost, pin.dataset.pinned === '1', pin);
    const open = event.target.closest('[data-social-open-post]');
    if (open) return window.open(`post.html?id=${encodeURIComponent(open.dataset.socialOpenPost)}`, '_blank', 'noopener');
    const publicProfile = event.target.closest('[data-social-open-profile]');
    if (publicProfile) return window.open(`profile.html?id=${encodeURIComponent(publicProfile.dataset.socialOpenProfile)}`, '_blank', 'noopener');
    const copy = event.target.closest('[data-social-copy-post]');
    if (copy) {
      const link = new URL(`post.html?id=${encodeURIComponent(copy.dataset.socialCopyPost)}`, location.href).href;
      navigator.clipboard?.writeText(link).then(() => announce('Link da publicação copiado.', 'success')).catch(() => window.prompt('Copie o link:', link));
    }
  });
  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-social-restriction-form]')) return;
    event.preventDefault(); submitRestriction(event.target);
  });
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-social-restriction-duration]')) return;
    const form = event.target.closest('[data-social-restriction-form]');
    const confirmation = qs('[data-social-permanent-confirm]', form);
    const checkbox = qs('[name="permanent_confirmed"]', confirmation);
    const permanent = event.target.value === '0';
    if (confirmation) confirmation.hidden = !permanent;
    if (checkbox) {
      checkbox.required = permanent;
      if (!permanent) checkbox.checked = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && qs('.social-drawer')) { event.preventDefault(); closeDrawer(); return; }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-social-account]')) { event.preventDefault(); openAccount(event.target.dataset.socialAccount); }
    const drawer = qs('.social-drawer.is-open');
    if (event.key !== 'Tab' || !drawer) return;
    const focusable = qsa('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', drawer).filter(item => item.offsetParent !== null);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  });

  window.openSocialPostDrawer = openPost;
  window.staffSocialWorkspace = {
    load({ force = false } = {}) { bind(); selectPane(state.pane, { force }); },
    openAccount,
    openPost,
    restrict: restrictionComposer,
  };
  if (document.readyState !== 'loading') bind();
  else document.addEventListener('DOMContentLoaded', bind, { once: true });
})();
