(() => {
  'use strict';

  const state = {
    view: 'command',
    communityPane: 'overview',
    tool: 'activity',
    toolData: {},
    charts: {},
    calendarDate: new Date(),
    playerDirectory: [],
    playerSegment: 'staff',
    playerView: localStorage.getItem('fa_dashboard_player_view') || 'list',
    playerFilters: { role: 'all', rank: 'all', verified: 'all', linked: 'all', access: 'all' },
    selectedPlayers: new Set(),
    selectedModeration: new Set(),
    comparisonOpen: false,
    comparisonDays: { primary: 30, compare: 30 },
    auditTimeline: false,
    lazyRuntime: null,
  };

  const VIEWS = [
    { view: 'command', id: 'command-center', label: 'Centro de Comando', icon: 'layout-dashboard', group: 'Análise' },
    { view: 'analytics', id: 'community-analytics', label: 'Analytics da Comunidade', icon: 'bar-chart-3', group: 'Análise' },
    { view: 'server', id: 'server-overview', label: 'Servidor Minecraft', icon: 'server', group: 'Análise' },
    { view: 'players', id: 'admin-users-card', label: 'Jogadores & Staff', icon: 'users', group: 'Gestão' },
    { view: 'merit', id: 'merit-card', label: 'Mérito & Capital', icon: 'star', group: 'Gestão' },
    { view: 'moderation', id: 'moderation-card', label: 'Moderação', icon: 'shield-alert', group: 'Gestão', badge: 'moderation' },
    { view: 'notifications', id: 'admin-notifications-card', label: 'Broadcast & Avisos', icon: 'megaphone', group: 'Ferramentas' },
    { view: 'legacy', id: 'legacy-migration-card', label: 'Contas Legacy', icon: 'link-2', group: 'Ferramentas', badge: 'legacy' },
    { view: 'integrations', id: 'app-keys-card', label: 'Integrações', icon: 'plug', group: 'Ferramentas', owner: true },
    { view: 'audit', id: 'audit-card', label: 'Auditoria', icon: 'scroll-text', group: 'Sistema' },
    { view: 'tools', id: 'dashboard-tools', label: 'Ferramentas Admin', icon: 'wrench', group: 'Sistema' },
    { view: 'settings', id: 'dashboard-settings', label: 'Configurações', icon: 'settings', group: 'Sistema', owner: true },
  ];
  const VIEW_BY_ID = Object.fromEntries(VIEWS.map((item) => [item.id, item.view]));
  const VIEW_META = Object.fromEntries(VIEWS.map((item) => [item.view, item]));
  const isOwner = () => typeof session !== 'undefined' && session?.role === 'owner';
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const num = (value) => Number(value || 0);
  const compact = (value) => new Intl.NumberFormat('pt-BR', { notation: Math.abs(num(value)) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(num(value));
  const pct = (value) => `${num(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  const money = (value) => num(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const dateTime = (value) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Sem atividade';
  const dateOnly = (value) => value ? new Date(value).toLocaleDateString('pt-BR') : 'Sem atividade';
  const daysAgo = (value) => value ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000)) : 9999;
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const unwrap = (payload) => payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  const authHeaders = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const refreshIcons = () => requestAnimationFrame(() => window.lucide?.createIcons?.());
  const ensureLazyRuntime = () => {
    if (!state.lazyRuntime) state.lazyRuntime = import('./dashboard-v2-lazy.js');
    return state.lazyRuntime;
  };

  async function api(path, options = {}) {
    if (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW) return previewApi(path);
    const response = await apiFetch(path, { ...options, headers: authHeaders(options.headers || {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Erro ${response.status}`);
    return unwrap(payload);
  }

  function previewApi(path) {
    const now = new Date();
    const heatmap = Array.from({ length: 168 }, (_, index) => ({
      day_of_week: Math.floor(index / 24),
      hour_of_day: index % 24,
      unique_players: Math.max(0, Math.round(4 + Math.sin(index / 7) * 4 + ((index % 24) >= 18 && (index % 24) <= 22 ? 14 : 0))),
      actions: Math.max(0, Math.round(2 + Math.cos(index / 9) * 3)),
    }));
    if (path.includes('activity-heatmap')) return heatmap;
    if (path.includes('cohort-retention')) return Array.from({ length: 8 }, (_, cohort) => Array.from({ length: 8 - cohort }, (_, week) => ({
      cohort_week: new Date(now.getTime() - (7 - cohort) * 604800000).toISOString().slice(0, 10),
      weeks_after: week,
      cohort_size: 18 + cohort * 2,
      retained_users: Math.round((18 + cohort * 2) * Math.max(.22, 1 - week * .115)),
      retention_pct: Math.max(22, 100 - week * 11.5),
    }))).flat();
    if (path.includes('/comparison')) return [{ period: 'current', active_users: 142, social_events: 2840, posts: 87, play_hours: 486, unique_players: 71 }, { period: 'previous', active_users: 118, social_events: 2410, posts: 65, play_hours: 412, unique_players: 63 }];
    if (path.includes('uptime-timeline')) {
      const hours = path.includes('days=60') ? 336 : 168;
      return Array.from({ length: hours }, (_, index) => ({ bucket: new Date(now.getTime() - (hours - 1 - index) * 3600000).toISOString(), uptime_pct: index % 51 === 0 ? 55 : index % 17 === 0 ? 92 : 100, peak_players: 8 + index % 21, avg_latency_ms: 42 }));
    }
    if (path.includes('economy-overview')) return {
      summary: { total_merit: 18420, total_capital: 9640, gini_index: .38, transactions_per_day_7d: 12.4 },
      flow: Array.from({ length: 30 }, (_, index) => ({ day: new Date(now.getTime() - (29 - index) * 86400000).toISOString(), credits: 30 + index % 7 * 9, debits: 18 + index % 5 * 7, net: 12 + index % 4 * 2 })),
      merit_velocity: Array.from({ length: 14 }, (_, index) => ({ day: new Date(now.getTime() - (13 - index) * 86400000).toISOString(), transactions: 5 + index % 6, net_merit: 20 + index % 5 * 8 })),
      distribution: [{ label: '0-50', total: 92 }, { label: '51-150', total: 74 }, { label: '151-400', total: 48 }, { label: '400+', total: 19 }],
      rank_distribution: [{ rank: 'ferro', total: 92, avg_merit: 42, avg_capital: 18 }, { rank: 'ouro', total: 74, avg_merit: 281, avg_capital: 91 }, { rank: 'diamante', total: 48, avg_merit: 721, avg_capital: 184 }, { rank: 'netherite', total: 19, avg_merit: 1320, avg_capital: 412 }],
      leaders: ['Steve', 'Alex', 'Gabriel', 'Luna', 'Caio'].map((minecraft_name, index) => ({ minecraft_name, merit_total: 1480 - index * 183, capital_balance: 380 - index * 41, rank: index < 2 ? 'netherite' : 'diamante', weekly_delta: 94 - index * 17 })),
      recent_transactions: Array.from({ length: 12 }, (_, index) => ({ minecraft_name: ['Steve', 'Alex', 'Gabriel', 'Luna'][index % 4], kind: index % 2 ? 'capital' : 'merit', category: 'contribuição', amount: index % 3 ? 12 + index : -(6 + index), staff: 'Direção' })),
      promotions: Array.from({ length: 8 }, (_, index) => ({ minecraft_name: ['Steve', 'Alex', 'Gabriel', 'Luna', 'Caio', 'Rafa', 'Dani', 'Nina'][index], merit_total: 120 + index * 38, next_threshold: index < 1 ? 150 : 500, rank: index < 1 ? 'ferro' : 'ouro' })),
    };
    if (path.includes('churn-risk')) return Array.from({ length: 14 }, (_, index) => ({ id: index + 1, username: `membro${index + 1}`, minecraft_name: ['Steve', 'Alex', 'Gabriel', 'Luna', 'Caio', 'Rafa', 'Dani'][index % 7], last_server_at: new Date(now.getTime() - (15 + index) * 86400000).toISOString(), last_social_at: new Date(now.getTime() - (12 + index * 2) * 86400000).toISOString(), sessions_4w: index % 4, risk_score: Math.min(98, 92 - index * 4) }));
    if (path.includes('staff-performance')) return ['Direção', 'Gabriel', 'Caio', 'Luna'].map((name, index) => ({ actor_name: name, total_actions: 84 - index * 15, moderation_actions: 30 - index * 4, economy_actions: 21 - index * 3, broadcasts: 8 - index, reports_reviewed: 18 - index * 3, avg_report_response_hours: 1.4 + index * .8, posts_moderated: 24 - index * 3, posts_approved: 17 - index * 2, posts_removed: 7 - index, merit_granted: 120 - index * 18, merit_removed: 25 - index * 4, last_action_at: now.toISOString() }));
    if (path.includes('social-graph')) {
      const nodes = Array.from({ length: 28 }, (_, index) => ({ id: index + 1, username: `membro${index + 1}`, minecraft_name: ['Steve', 'Alex', 'Gabriel', 'Luna'][index % 4], display_name: `Membro ${index + 1}`, rank: ['ferro', 'ouro', 'diamante', 'netherite'][index % 4], followers: 28 - index }));
      return { nodes, edges: Array.from({ length: 70 }, (_, index) => ({ source: index % 28 + 1, target: (index * 5 + 3) % 28 + 1 })) };
    }
    if (path.includes('scheduled-posts')) return Array.from({ length: 13 }, (_, index) => ({ id: index + 1, content: `Publicação editorial ${index + 1}: novidades e próximos eventos da comunidade.`, publish_at: new Date(now.getFullYear(), now.getMonth(), 2 + index * 2, 18 + index % 4).toISOString(), status: index % 6 === 0 ? 'failed' : index % 4 === 0 ? 'published' : 'scheduled', username: 'Direção', display_name: 'Direção', media_urls: index % 3 ? [] : ['assets/images/hero.png'] }));
    if (path.includes('players/directory')) return Array.from({ length: 24 }, (_, index) => ({ id: index + 1, username: `membro${index + 1}`, email: `membro${index + 1}@example.com`, minecraft_name: ['Steve', 'Alex', 'Gabriel', 'Luna', 'Caio', 'Rafa'][index % 6] + (index > 5 ? index : ''), role: index === 0 ? 'owner' : index < 4 ? 'full' : 'limited', is_verified: index % 5 !== 0, is_platform_verified: index % 4 === 0, created_at: new Date(now.getTime() - index * 5 * 86400000).toISOString(), merit: index * 43, capital: index * 11, rank: index > 18 ? 'diamante' : index > 8 ? 'ouro' : 'ferro', last_activity: new Date(now.getTime() - index * 3 * 86400000).toISOString(), posts: index + 2, comments: index * 3, sessions: index * 2, total_hours: index * 4.5 }));
    if (path.includes('moderation-overview')) return { summary: { pending_ai: 5, pending_reports: 3, approved: 23, removed: 8, avg_response_hours: 3.4 }, daily: Array.from({ length: 14 }, (_, index) => ({ day: new Date(now.getTime() - (13 - index) * 86400000).toISOString(), reports: 2 + index % 5 })) };
    if (path.includes('audit-overview')) return { heatmap, actors: ['Direção', 'Gabriel', 'Caio', 'Luna', 'Rafa'].map((name, index) => ({ actor_name: name, actions: 72 - index * 11 })) };
    if (path.includes('/timeline')) return Array.from({ length: 12 }, (_, index) => ({ type: ['signup', 'first_session', 'first_post', 'merit', 'audit'][index % 5], timestamp: new Date(now.getTime() - index * 12 * 86400000).toISOString(), label: ['Cadastro criado', 'Primeira sessão no servidor', 'Primeira publicação', 'Mérito +50', 'Perfil verificado'][index % 5], detail: 'Evento de demonstração' }));
    if (path.includes('notification-templates')) return [{ id: 1, title: 'Evento acontecendo!', body: 'Entre no servidor e participe com a comunidade.', type: 'event' }, { id: 2, title: 'Servidor em manutenção', body: 'Voltaremos em breve com melhorias.', type: 'warning' }];
    if (path.includes('server/presence')) return Array.from({ length: 28 }, (_, index) => ({ day: new Date(now.getTime() - (27 - index) * 86400000).toISOString(), unique_players: 8 + index % 9, peak_players: 13 + index % 12 }));
    if (path.includes('/settings')) return { server_ip: 'fa.ogabriels.com', server_port: 25565, max_players: 80, whitelist_enabled: true, maintenance_message: '', moderation_mode: 'ai', broadcast_max_per_day: 8, broadcast_channels: { dashboard: true, push: true, email: false }, rank_thresholds: { ferro: 0, ouro: 150, diamante: 500, netherite: 1000 } };
    return { ok: true, affected: 0 };
  }

  function availableViews() {
    return VIEWS.filter((item) => !item.owner || isOwner()).filter((item) => document.getElementById(item.id));
  }

  function createV2Modules() {
    const content = document.querySelector('.dashboard-content');
    if (!content || document.getElementById('dashboard-tools')) return;
    const tools = document.createElement('div');
    tools.className = 'card';
    tools.id = 'dashboard-tools';
    tools.innerHTML = `
      <nav class="v2-subtabs" id="v2-tool-tabs" aria-label="Ferramentas administrativas">
        ${[
          ['activity', 'grid-3x3', 'Heatmap'],
          ['calendar', 'calendar-days', 'Calendário'],
          ['economy', 'landmark', 'Economia'],
          ['churn', 'radar', 'Churn Risk'],
          ['social', 'share-2', 'Grafo Social'],
          ...(isOwner() ? [['staff', 'badge-check', 'Desempenho da Staff']] : []),
        ].map(([key, ico, label]) => `<button class="v2-subtab ${key === state.tool ? 'active' : ''}" data-v2-tool="${key}">${icon(ico)} ${label}</button>`).join('')}
      </nav>
      <div id="v2-tools-body" class="v2-section"><div class="v2-loading">Preparando ferramentas...</div></div>`;
    content.appendChild(tools);

    const settings = document.createElement('div');
    settings.className = 'card';
    settings.id = 'dashboard-settings';
    if (!isOwner()) settings.style.display = 'none';
    settings.innerHTML = '<div id="v2-settings-body" class="v2-section"><div class="v2-loading">Carregando configurações...</div></div>';
    content.appendChild(settings);

    DASHBOARD_MODULES['dashboard-tools'] = { title: 'Ferramentas Admin', desc: 'Calendário, economia, retenção, churn e inteligência operacional.' };
    DASHBOARD_MODULES['dashboard-settings'] = { title: 'Configurações', desc: 'Parâmetros globais, exportações e controles avançados do sistema.' };
    DASHBOARD_MODULES['admin-notifications-card'] = { title: 'Broadcast & Avisos', desc: 'Crie, visualize, agende e acompanhe comunicações para a comunidade.' };
  }

  function buildSidebar() {
    const accountCard = document.querySelector('.sidebar-profile .account-summary-card');
    if (!accountCard || accountCard.querySelector('.v2-nav')) return;
    accountCard.classList.add('fa-v2-sidebar');
    const groups = [...new Set(availableViews().map((item) => item.group))];
    const nav = document.createElement('nav');
    nav.className = 'v2-nav';
    nav.setAttribute('aria-label', 'Navegação do dashboard');
    nav.innerHTML = groups.map((group) => `
      <div class="v2-nav-group">
        <div class="v2-nav-label">${group}</div>
        ${availableViews().filter((item) => item.group === group).map((item) => `
          <button class="v2-nav-item" type="button" data-v2-view="${item.view}" title="${esc(item.label)}">
            ${icon(item.icon)}<span>${esc(item.label)}</span>
            ${item.badge ? `<b class="v2-nav-badge" data-v2-badge="${item.badge}" hidden>0</b>` : ''}
          </button>`).join('')}
      </div>`).join('');
    const footer = document.createElement('div');
    footer.className = 'v2-sidebar-footer';
    footer.innerHTML = `
      <a class="v2-nav-item" href="account.html">${icon('user-round')}<span>Minha Conta</span></a>
      <button class="v2-nav-item" type="button" data-v2-logout>${icon('log-out')}<span>Sair</span></button>`;
    accountCard.append(nav, footer);
  }

  function buildTopbar() {
    const header = document.querySelector('body > header');
    if (!header || document.getElementById('v2-cmd-trigger')) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'v2-cmd-trigger';
    trigger.className = 'v2-cmd-trigger';
    trigger.innerHTML = `${icon('search')}<span>Buscar ou navegar...</span><kbd>Ctrl K</kbd>`;
    header.insertBefore(trigger, header.querySelector('.header-actions') || header.lastElementChild);

    const actions = document.createElement('div');
    actions.className = 'v2-page-actions';
    actions.id = 'v2-page-actions';
    document.querySelector('.portal-page-head')?.appendChild(actions);
  }

  function buildMobileNavigation() {
    if (document.getElementById('v2-mobile-nav')) return;
    const nav = document.createElement('nav');
    nav.id = 'v2-mobile-nav';
    nav.className = 'v2-mobile-nav';
    nav.setAttribute('aria-label', 'Navegação principal');
    const main = [
      ['command', 'layout-dashboard', 'Início'],
      ['analytics', 'bar-chart-3', 'Analytics'],
      ['players', 'users', 'Players'],
      ['moderation', 'shield-alert', 'Moderação'],
    ];
    nav.innerHTML = main.map(([view, ico, label]) => `<button class="v2-mobile-item" data-v2-view="${view}">${icon(ico)}<span>${label}</span>${view === 'moderation' ? '<b class="v2-nav-badge" data-v2-badge="moderation" hidden>0</b>' : ''}</button>`).join('')
      + `<button class="v2-mobile-item" data-v2-more>${icon('grid-2x2')}<span>Mais</span></button>`;
    document.body.appendChild(nav);
    const menu = document.createElement('div');
    menu.id = 'v2-mobile-menu';
    menu.className = 'v2-mobile-menu';
    menu.innerHTML = availableViews().filter((item) => !main.some(([view]) => view === item.view)).map((item) => `<button class="v2-nav-item" data-v2-view="${item.view}">${icon(item.icon)}<span>${item.label}</span></button>`).join('');
    document.body.appendChild(menu);
  }

  function buildCommandPalette() {
    if (document.getElementById('v2-command-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'v2-command-dialog';
    dialog.className = 'v2-command-dialog';
    dialog.innerHTML = `
      <div class="v2-command-search">${icon('search')}<input id="v2-command-input" autocomplete="off" placeholder="Buscar no dashboard..."><kbd class="cmd-key">Esc</kbd></div>
      <div class="v2-command-results" id="v2-command-results"></div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.getElementById('v2-command-input').addEventListener('input', (event) => renderCommandResults(event.target.value));
  }

  function renderCommandResults(query = '') {
    const target = document.getElementById('v2-command-results');
    if (!target) return;
    const q = query.toLocaleLowerCase('pt-BR').trim();
    const modules = availableViews().filter((item) => !q || item.label.toLocaleLowerCase('pt-BR').includes(q));
    const actions = [
      { label: 'Conceder mérito a um player', icon: 'star', view: 'merit' },
      { label: 'Novo aviso para a comunidade', icon: 'megaphone', view: 'notifications' },
      { label: 'Ver denúncias pendentes', icon: 'flag', view: 'moderation' },
      { label: 'Abrir calendário editorial', icon: 'calendar-days', view: 'tools', tool: 'calendar' },
      { label: 'Monitorar economia', icon: 'landmark', view: 'tools', tool: 'economy' },
    ].filter((item) => !q || item.label.toLocaleLowerCase('pt-BR').includes(q));
    const players = q.length >= 2 ? (state.playerDirectory.length ? state.playerDirectory : globalAdminUsers || [])
      .filter((player) => [player.username, player.minecraft_name, player.email, player.id].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(q)))
      .slice(0, 6) : [];
    target.innerHTML = `
      ${modules.length ? `<div class="v2-command-group-label">Navegação</div>${modules.map((item) => `<button class="v2-command-item" data-v2-view="${item.view}">${icon(item.icon)}<span>${item.label}</span><small>${item.view}</small></button>`).join('')}` : ''}
      ${actions.length ? `<div class="v2-command-group-label">Ações rápidas</div>${actions.map((item) => `<button class="v2-command-item" data-v2-action-view="${item.view}" data-v2-action-tool="${item.tool || ''}">${icon(item.icon)}<span>${item.label}</span></button>`).join('')}` : ''}
      ${players.length ? `<div class="v2-command-group-label">Players</div>${players.map((player) => `<button class="v2-command-item" data-v2-player="${player.id || ''}" data-v2-player-name="${esc(player.minecraft_name || player.username)}"><img loading="lazy" decoding="async" src="https://minotar.net/helm/${encodeURIComponent(player.minecraft_name || 'Steve')}/32.png"><span>${esc(player.username || player.minecraft_name)}</span><small>${esc(player.minecraft_name || '')}</small></button>`).join('')}` : ''}
      ${!modules.length && !actions.length && !players.length ? `<div class="v2-empty">Nenhum resultado para “${esc(query)}”.</div>` : ''}`;
    refreshIcons();
  }

  function openCommandPalette() {
    const dialog = document.getElementById('v2-command-dialog');
    const input = document.getElementById('v2-command-input');
    if (!dialog) return;
    renderCommandResults('');
    dialog.showModal();
    input.value = '';
    setTimeout(() => input.focus(), 30);
  }

  function updateNavigation() {
    document.querySelectorAll('[data-v2-view]').forEach((item) => item.classList.toggle('active', item.dataset.v2View === state.view));
    document.getElementById('v2-mobile-menu')?.classList.remove('active');
    renderPageActions();
  }

  function renderPageActions() {
    const actions = document.getElementById('v2-page-actions');
    if (!actions) return;
    const analytic = ['command', 'analytics', 'server', 'merit', 'audit'].includes(state.view);
    const listExport = ['analytics', 'server', 'players', 'merit', 'moderation', 'notifications', 'audit'].includes(state.view);
    actions.innerHTML = `
      ${analytic ? `<button class="v2-btn" data-v2-compare>${icon('git-compare-arrows')} Comparar períodos</button>` : ''}
      ${listExport ? `<button class="v2-btn" data-v2-export-view>${icon('download')} CSV</button>` : ''}
      <button class="v2-btn" data-v2-refresh>${icon('refresh-cw')} Atualizar</button>`;
    refreshIcons();
  }

  function navigate(view, options = {}) {
    if (!VIEW_META[view] || (VIEW_META[view].owner && !isOwner())) view = 'command';
    const id = VIEW_META[view].id;
    state.view = view;
    setActiveDashboardModule(id, { scroll: false, behavior: 'auto' });
    const eyebrow = document.querySelector('.portal-eyebrow');
    if (eyebrow) eyebrow.textContent = VIEW_META[view].group;
    const url = new URL(location.href);
    url.searchParams.delete('module');
    url.searchParams.set('v', view);
    history[options.replace ? 'replaceState' : 'pushState']({ view }, '', `${url.pathname}${url.search}${url.hash}`);
    updateNavigation();
    loadView(view);
  }

  function loadView(view) {
    if (view === 'command') renderCommandOverview();
    if (view === 'analytics') loadCommunityEnhancements();
    if (view === 'server') loadServerIntelligence();
    if (view === 'players') loadPlayerDirectory();
    if (view === 'merit') loadMeritOverview();
    if (view === 'notifications') loadNotificationWorkspace();
    if (view === 'moderation') loadModerationOverview();
    if (view === 'audit') loadAuditOverview();
    if (view === 'tools') activateTool(state.tool);
    if (view === 'settings') loadSettings();
    lazyImages();
  }

  function percentDelta(current, previous) {
    if (!num(previous)) return { value: num(current) ? 100 : 0, direction: num(current) ? 'up' : 'flat' };
    const value = ((num(current) - num(previous)) / Math.abs(num(previous))) * 100;
    return { value, direction: value > .05 ? 'up' : value < -.05 ? 'down' : 'flat' };
  }

  function deltaHtml(current, previous, suffix = '%') {
    const delta = percentDelta(current, previous);
    const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→';
    return `<span class="v2-delta ${delta.direction}">${arrow} ${Math.abs(delta.value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${suffix} vs anterior</span>`;
  }

  function commandAlerts(summary) {
    const alerts = [];
    if (num(summary.pending_reports)) alerts.push({ tone: 'var(--red)', title: `${summary.pending_reports} denúncia(s) pendente(s)`, body: 'Revise o conteúdo denunciado pela comunidade.', view: 'moderation' });
    if (num(summary.pending_moderation)) alerts.push({ tone: 'var(--amber)', title: `${summary.pending_moderation} item(ns) na fila da IA`, body: 'A fila aguarda uma decisão da staff.', view: 'moderation' });
    if (num(summary.failed_scheduled_posts)) alerts.push({ tone: 'var(--red)', title: `${summary.failed_scheduled_posts} agendamento(s) falharam`, body: 'Reagende os posts no calendário editorial.', view: 'tools', tool: 'calendar' });
    if (num(summary.unverified_users)) alerts.push({ tone: 'var(--accent)', title: `${summary.unverified_users} conta(s) não verificadas`, body: 'Acompanhe o onboarding de novos membros.', view: 'players' });
    if (!alerts.length) alerts.push({ tone: 'var(--green)', title: 'Operação em dia', body: 'Nenhuma pendência crítica neste momento.', view: 'analytics' });
    return alerts.slice(0, 3);
  }

  function renderCommandOverview() {
    const card = document.getElementById('command-center');
    if (!card) return;
    let root = document.getElementById('v2-command-overview');
    if (!root) {
      root = document.createElement('section');
      root.id = 'v2-command-overview';
      root.className = 'v2-section';
      card.insertBefore(root, card.querySelector('.cc-hero') || card.firstChild);
    }
    const data = typeof executiveAnalytics !== 'undefined' ? executiveAnalytics : null;
    if (!data) {
      root.innerHTML = '<div class="v2-loading">Consolidando o pulso da comunidade...</div>';
      return;
    }
    const s = data.summary || {};
    const server = data.server || {};
    const wauDelta = percentDelta(s.wau, Math.max(0, num(s.previous_active_users)));
    const health = Math.max(0, Math.round(100 - num(s.pending_reports) * 3 - num(s.pending_moderation) * 2 - num(s.failed_scheduled_posts) * 4 - (num(s.retention_rate) < 45 ? 12 : 0)));
    const preview = typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW;
    const online = preview || (typeof globalApiData !== 'undefined' && globalApiData?.online);
    const onlineCount = preview ? 18 : (typeof globalHistData !== 'undefined' ? num(globalHistData?.onlinePlayers?.length) : 0);
    const max = typeof globalApiData !== 'undefined' ? num(globalApiData?.players?.max || 80) : 80;
    const alerts = commandAlerts(s);
    const kpis = [
      ['Usuários ativos', s.active_users, s.previous_active_users, 'var(--chart-1)', `${data.period?.days || 30} dias`],
      ['Engajamento', `${num(s.engagement_rate).toFixed(1)}%`, null, 'var(--chart-2)', 'por impressão'],
      ['Retenção', `${num(s.retention_rate).toFixed(1)}%`, null, 'var(--chart-3)', 'base que retornou'],
      ['Horas de jogo', `${num(s.play_hours).toFixed(0)}h`, null, 'var(--chart-4)', `${compact(s.unique_players)} players`],
      ['Posts', s.posts, s.previous_posts, 'var(--chart-6)', 'originais'],
      ['Mensagens', s.messages, null, 'var(--chart-5)', 'privadas e grupos'],
    ];
    root.innerHTML = `
      <div class="v2-north-star">
        <article class="v2-north-card v2-north-main">
          <div class="v2-label">North Star Metric</div>
          <div class="v2-north-value">${compact(s.wau)}</div>
          <div class="v2-north-name">Usuários Ativos Semanais</div>
          <span class="v2-delta ${wauDelta.direction}">${wauDelta.direction === 'up' ? '↑' : wauDelta.direction === 'down' ? '↓' : '→'} ${Math.abs(wauDelta.value).toFixed(1)}% vs referência anterior</span>
        </article>
        <article class="v2-north-card">
          <div class="v2-label">Health Score</div>
          <div class="v2-health-score">${health}<small>/100</small></div>
          <div class="v2-north-name">${health >= 85 ? 'Operação saudável' : health >= 65 ? 'Atenção necessária' : 'Intervenção prioritária'}</div>
          <div class="v2-health-bar"><i style="--value:${health}%;--tone:${health >= 85 ? 'var(--green)' : health >= 65 ? 'var(--amber)' : 'var(--red)'}"></i></div>
        </article>
        <article class="v2-north-card">
          <div class="v2-label">Servidor Minecraft</div>
          <div class="v2-server-live" style="color:${online ? 'var(--green)' : 'var(--red)'}"><i></i>${online ? 'Online agora' : 'Offline / verificando'}</div>
          <div class="v2-server-count">${onlineCount}<small style="font-size:13px;color:var(--ink-3)">/${max}</small></div>
          <div class="v2-north-name">${pct(server.uptime_pct)} uptime no período</div>
        </article>
      </div>
      <div class="v2-kpi-strip">${kpis.map(([label, value, previous, tone, context]) => `
        <article class="v2-kpi-card" style="--tone:${tone}">
          <div class="v2-kpi-label">${label}</div><div class="v2-kpi-value">${typeof value === 'number' ? compact(value) : value}</div>
          ${previous !== null ? deltaHtml(value, previous) : `<div class="v2-kpi-context">${context}</div>`}
        </article>`).join('')}</div>
      <div class="v2-grid">
        <section class="v2-panel span-2"><div class="v2-section-head"><div><h3>Fila de atenção</h3><p>Máximo de três sinais, cada um com ação próxima.</p></div></div>
          <div class="v2-alert-list" style="margin-top:12px">${alerts.map((alert) => `<article class="v2-alert" style="--tone:${alert.tone}"><div><strong>${alert.title}</strong><small>${alert.body}</small></div><button class="v2-btn" data-v2-alert-view="${alert.view}" data-v2-alert-tool="${alert.tool || ''}">Resolver</button></article>`).join('')}</div>
        </section>
        <section class="v2-panel"><div class="v2-section-head"><div><h3>Economia FA</h3><p>Visão rápida da circulação.</p></div><button class="v2-btn" data-v2-action-view="tools" data-v2-action-tool="economy">${icon('arrow-up-right')}</button></div>
          <div class="v2-grid two" style="margin-top:14px"><div><div class="v2-label">Mérito</div><div class="v2-kpi-value">${compact(s.total_merit)}</div></div><div><div class="v2-label">Capital</div><div class="v2-kpi-value">${compact(s.total_capital)}</div></div></div>
        </section>
      </div>`;
    refreshIcons();
  }

  function setupCommunityTabs() {
    const card = document.getElementById('community-analytics');
    if (!card || document.getElementById('v2-community-tabs')) return;
    const tabs = document.createElement('nav');
    tabs.id = 'v2-community-tabs';
    tabs.className = 'v2-subtabs';
    tabs.innerHTML = [
      ['overview', 'Visão Geral'],
      ['content', 'Conteúdo'],
      ['audience', 'Audiência'],
      ['funnel', 'Funil & Jornada'],
      ['server', 'Servidor'],
    ].map(([key, label]) => `<button class="v2-subtab ${key === state.communityPane ? 'active' : ''}" data-v2-community-pane="${key}">${label}</button>`).join('');
    card.insertBefore(tabs, card.querySelector('.context-shortcuts') || card.children[1]);

    [...card.children].forEach((child) => {
      if (child === tabs || child.classList.contains('cc-module-head') || child.classList.contains('context-shortcuts')) return;
      const text = child.textContent.toLocaleLowerCase('pt-BR');
      let pane = 'overview';
      if (child.matches('.ci-kpi-grid,.ci-grid-main') || child.querySelector('.ci-quality-strip')) pane = 'overview';
      else if (child.matches('.ci-content-panel')) pane = 'content';
      else if (/servidor|recorrência dos jogadores/.test(text)) pane = 'server';
      else if (/jornada|funil|stickiness|ativação|contas conectadas/.test(text)) pane = 'funnel';
      else if (/audiência|segmentos|progressão|identidade|aquisição|coortes|contribuidores/.test(text)) pane = 'audience';
      else if (/publicações|conteúdo|assuntos|formatos/.test(text)) pane = 'content';
      child.dataset.ciPane = pane;
    });

    const cohort = document.createElement('section');
    cohort.className = 'v2-panel';
    cohort.dataset.ciPane = 'audience';
    cohort.innerHTML = '<div class="v2-section-head"><div><h3>Retenção por coorte</h3><p>Percentual de membros que continua ativo semana após semana.</p></div></div><div id="v2-cohort-heatmap" class="v2-loading">Carregando coortes...</div>';
    card.appendChild(cohort);
    const heatmap = document.createElement('section');
    heatmap.className = 'v2-panel';
    heatmap.dataset.ciPane = 'server';
    heatmap.innerHTML = '<div class="v2-section-head"><div><h3>Horários mais ativos</h3><p>Atividade do servidor por dia e hora.</p></div></div><div id="v2-community-heatmap" class="v2-loading">Carregando atividade...</div>';
    card.appendChild(heatmap);
    const scatter = document.createElement('section');
    scatter.className = 'v2-panel';
    scatter.dataset.ciPane = 'server';
    scatter.innerHTML = '<div class="v2-section-head"><div><h3>Presença por player</h3><p>Sessões realizadas versus duração média.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-community-scatter"></canvas></div>';
    card.appendChild(scatter);
    const posts = document.createElement('section');
    posts.className = 'v2-panel';
    posts.dataset.ciPane = 'content';
    posts.innerHTML = '<div class="v2-section-head"><div><h3>Top posts com preview</h3><p>Conteúdo com maior impacto no período.</p></div></div><div id="v2-top-posts" class="v2-loading">Carregando posts...</div>';
    card.appendChild(posts);
    switchCommunityPane(state.communityPane);
  }

  function switchCommunityPane(pane) {
    state.communityPane = pane;
    document.querySelectorAll('[data-v2-community-pane]').forEach((button) => button.classList.toggle('active', button.dataset.v2CommunityPane === pane));
    document.querySelectorAll('#community-analytics > [data-ci-pane]').forEach((section) => section.classList.toggle('v2-ci-hidden', section.dataset.ciPane !== pane));
  }

  function renderActivityHeatmap(containerId, rows, valueKey = 'unique_players') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    rows.forEach((row) => { grid[num(row.day_of_week)][num(row.hour_of_day)] = num(row[valueKey]); });
    const max = Math.max(1, ...rows.map((row) => num(row[valueKey])));
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    container.className = 'heatmap-shell';
    container.innerHTML = `<div class="heatmap">
      <div class="heatmap-header"><span></span>${Array.from({ length: 24 }, (_, hour) => `<span class="heatmap-hlabel">${hour % 3 === 0 ? `${hour}h` : ''}</span>`).join('')}</div>
      ${days.map((day, dayIndex) => `<div class="heatmap-row"><span class="heatmap-dlabel">${day}</span>${grid[dayIndex].map((value, hour) => `<span class="heatmap-cell" style="--intensity:${Math.round(value / max * 100)}%" title="${day}, ${hour}h: ${value}"></span>`).join('')}</div>`).join('')}
    </div>`;
  }

  function renderCohortHeatmap(rows) {
    const container = document.getElementById('v2-cohort-heatmap');
    if (!container) return;
    const weeks = Math.max(1, ...rows.map((row) => num(row.weeks_after))) + 1;
    const cohorts = [...new Set(rows.map((row) => row.cohort_week))];
    container.className = 'cohort-shell';
    container.innerHTML = `<div class="cohort-grid" style="--weeks:${weeks}">
      <div class="cohort-row"><span class="cohort-cell label">Coorte</span>${Array.from({ length: weeks }, (_, index) => `<span class="cohort-cell label">Sem +${index}</span>`).join('')}</div>
      ${cohorts.map((cohort) => `<div class="cohort-row"><span class="cohort-cell label">${dateOnly(cohort)}</span>${Array.from({ length: weeks }, (_, index) => {
        const value = rows.find((row) => row.cohort_week === cohort && num(row.weeks_after) === index);
        const retention = value ? num(value.retention_pct) : null;
        return `<span class="cohort-cell" style="--intensity:${retention ?? 0}%;--tone:${retention >= 65 ? 'var(--green)' : retention >= 35 ? 'var(--amber)' : 'var(--red)'}">${retention === null ? '—' : `${retention.toFixed(0)}%`}</span>`;
      }).join('')}</div>`).join('')}
    </div>`;
  }

  function renderTopPosts() {
    const container = document.getElementById('v2-top-posts');
    if (!container) return;
    const rows = typeof executiveAnalytics !== 'undefined' ? executiveAnalytics?.top_content || [] : [];
    container.className = 'v2-feed';
    container.innerHTML = rows.slice(0, 8).map((row) => `
      <article class="v2-feed-row">
        ${row.thumbnail_url ? `<img loading="lazy" decoding="async" src="${esc(row.thumbnail_url)}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover">` : `<span class="v2-score" style="--tone:var(--accent)">${icon(row.has_media ? 'image' : 'text')}</span>`}
        <div><strong>${esc(row.display_name || row.minecraft_name || row.username)}</strong><small>${esc(row.preview || 'Publicação sem texto')}</small></div>
        <div style="text-align:right"><strong>${compact(row.quality_score)} pts</strong><small>${compact(row.impressions)} impressões</small></div>
      </article>`).join('') || '<div class="v2-empty">Nenhuma publicação no período.</div>';
    refreshIcons();
  }

  async function loadCommunityEnhancements() {
    setupCommunityTabs();
    renderTopPosts();
    try {
      const [heatmap, cohorts] = await Promise.all([
        api('/api/admin/analytics/activity-heatmap?days=30'),
        api('/api/admin/analytics/cohort-retention?weeks=8'),
      ]);
      renderActivityHeatmap('v2-community-heatmap', heatmap);
      renderCohortHeatmap(cohorts);
      renderCommunityScatter();
    } catch (error) {
      ['v2-community-heatmap', 'v2-cohort-heatmap'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = `<div class="v2-empty">${esc(error.message)}</div>`;
      });
    }
  }

  function renderCommunityScatter() {
    if (!window.Chart || !document.getElementById('v2-community-scatter')) return;
    const history = typeof globalHistData !== 'undefined' ? globalHistData?.history || [] : [];
    const grouped = new Map();
    history.forEach((row) => {
      const name = row.player || row.name;
      if (!name) return;
      const value = grouped.get(name) || { sessions: 0, hours: 0 };
      value.sessions += 1;
      value.hours += num(row.duration_hours ?? row.hoursOnline);
      grouped.set(name, value);
    });
    const points = [...grouped].slice(0, 60).map(([name, value]) => ({ x: value.sessions, y: value.sessions ? value.hours / value.sessions : 0, name }));
    if (!points.length && typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW) {
      ['Steve','Alex','Gabriel','Luna','Caio','Rafa'].forEach((name, index) => points.push({ x: 3 + index * 2, y: .7 + index * .35, name }));
    }
    destroyChart('communityScatter');
    state.charts.communityScatter = new Chart(document.getElementById('v2-community-scatter'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Players', data: points, backgroundColor: '#1761f0', pointRadius: 6, pointHoverRadius: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, parsing: false, plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.raw.name}: ${ctx.raw.x} sessões · ${ctx.raw.y.toFixed(1)}h média` } } }, scales: { x: { title: { display: true, text: 'Sessões' } }, y: { title: { display: true, text: 'Duração média (h)' } } } },
    });
  }

  function toolHeader(title, description, actions = '') {
    return `<div class="v2-section-head"><div><h2>${title}</h2><p>${description}</p></div><div class="v2-page-actions">${actions}</div></div>`;
  }

  async function activateTool(tool) {
    state.tool = tool;
    document.querySelectorAll('[data-v2-tool]').forEach((button) => button.classList.toggle('active', button.dataset.v2Tool === tool));
    const body = document.getElementById('v2-tools-body');
    if (!body) return;
    body.innerHTML = '<div class="v2-loading">Carregando ferramenta...</div>';
    try {
      if (tool === 'activity') await renderActivityTool(body);
      if (tool === 'calendar') await renderCalendarTool(body);
      if (tool === 'economy') await renderEconomyTool(body);
      if (tool === 'churn') await renderChurnTool(body);
      if (tool === 'social') await renderSocialTool(body);
      if (tool === 'staff') await renderStaffTool(body);
    } catch (error) {
      body.innerHTML = `<div class="v2-empty">${esc(error.message)}</div>`;
    }
    refreshIcons();
  }

  async function renderActivityTool(body) {
    const data = await api('/api/admin/analytics/activity-heatmap?days=30');
    body.innerHTML = `${toolHeader('Heatmap de Atividade', 'Quando a comunidade está mais ativa no servidor.')}<section class="v2-panel"><div id="v2-tool-heatmap"></div></section>`;
    renderActivityHeatmap('v2-tool-heatmap', data);
  }

  async function renderCalendarTool(body) {
    state.toolData.calendar = await api('/api/admin/scheduled-posts');
    body.innerHTML = `${toolHeader('Calendário Editorial', 'Todos os posts agendados, publicados e com falha.', `<button class="v2-btn" data-v2-export-tool="calendar">${icon('download')} CSV</button><button class="v2-btn primary" data-v2-action-view="notifications">${icon('plus')} Novo aviso</button>`)}<section class="v2-panel"><div id="v2-calendar-root"></div><div id="v2-calendar-detail" class="v2-calendar-detail"></div></section>`;
    renderCalendar();
  }

  function renderCalendar() {
    const root = document.getElementById('v2-calendar-root');
    if (!root) return;
    const current = state.calendarDate;
    const year = current.getFullYear();
    const month = current.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - first.getDay());
    const posts = state.toolData.calendar || [];
    const days = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
    root.innerHTML = `
      <div class="v2-calendar-head"><button class="v2-btn" data-v2-calendar-step="-1">${icon('chevron-left')}</button><div class="v2-calendar-title">${current.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</div><button class="v2-btn" data-v2-calendar-step="1">${icon('chevron-right')}</button></div>
      <div class="v2-calendar">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map((day) => `<div class="v2-calendar-label">${day}</div>`).join('')}
      ${days.map((day) => {
        const key = day.toISOString().slice(0, 10);
        const dayPosts = posts.filter((post) => String(post.publish_at).slice(0, 10) === key);
        const today = new Date().toDateString() === day.toDateString();
        return `<button class="v2-calendar-day ${day.getMonth() !== month ? 'muted' : ''} ${today ? 'today' : ''}" data-v2-calendar-day="${key}"><span class="v2-calendar-day-number">${day.getDate()}</span><span class="v2-calendar-dots">${dayPosts.slice(0, 8).map((post) => `<i class="v2-calendar-dot ${post.status}"></i>`).join('')}</span></button>`;
      }).join('')}</div>`;
    refreshIcons();
  }

  function showCalendarDay(key) {
    const detail = document.getElementById('v2-calendar-detail');
    const posts = (state.toolData.calendar || []).filter((post) => String(post.publish_at).slice(0, 10) === key);
    detail.innerHTML = posts.map((post) => `<article class="v2-feed-row"><span class="v2-score" style="--tone:${post.status === 'failed' ? 'var(--red)' : post.status === 'published' ? 'var(--green)' : 'var(--accent)'}">${icon(post.media_urls?.length ? 'image' : 'text')}</span><div><strong>${esc(String(post.content || 'Post agendado').slice(0, 90))}</strong><small>${esc(post.display_name || post.minecraft_name || post.username)} · ${dateTime(post.publish_at)} · ${esc(post.status)}</small></div>${post.status === 'failed' ? `<button class="v2-btn" data-v2-retry-post="${post.id}">Reagendar</button>` : ''}</article>`).join('') || '<div class="v2-empty">Nenhum post agendado neste dia.</div>';
    refreshIcons();
  }

  async function renderEconomyTool(body) {
    const data = await api('/api/admin/analytics/economy-overview?days=30');
    state.toolData.economy = data;
    const s = data.summary;
    body.innerHTML = `${toolHeader('Monitor da Economia', 'Fluxo de capital, mérito, desigualdade e próximas promoções.', `<button class="v2-btn" data-v2-export-tool="economy">${icon('download')} CSV</button>`)}
      <div class="v2-kpi-strip">
        ${[['Capital em circulação', money(s.total_capital), 'var(--chart-5)'],['Mérito distribuído', compact(s.total_merit), 'var(--chart-4)'],['Gini Index', num(s.gini_index).toFixed(2), 'var(--chart-3)'],['Transações/dia', num(s.transactions_per_day_7d).toFixed(1), 'var(--chart-1)']].map(([label,value,tone]) => `<article class="v2-kpi-card" style="--tone:${tone}"><div class="v2-kpi-label">${label}</div><div class="v2-kpi-value">${value}</div><div class="v2-kpi-context">últimos 30 dias</div></article>`).join('')}
      </div>
      <div class="v2-grid two">
        <section class="v2-panel"><div class="v2-section-head"><div><h3>Fluxo de capital</h3><p>Créditos, débitos e saldo líquido diário.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-economy-chart"></canvas></div></section>
        <section class="v2-panel"><div class="v2-section-head"><div><h3>Distribuição de mérito</h3><p>Concentração por faixa.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-distribution-chart"></canvas></div></section>
      </div>
      <div class="v2-grid two"><section class="v2-panel"><div class="v2-section-head"><div><h3>Transações recentes</h3></div></div><div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Player</th><th>Tipo</th><th>Valor</th><th>Staff</th></tr></thead><tbody>${data.recent_transactions.slice(0,10).map((row) => `<tr><td><strong>${esc(row.minecraft_name)}</strong></td><td>${esc(row.kind)} · ${esc(row.category)}</td><td>${num(row.amount) >= 0 ? '+' : ''}${money(row.amount)}</td><td>${esc(row.staff || 'Sistema')}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="v2-panel"><div class="v2-section-head"><div><h3>Próximas promoções</h3><p>Players mais próximos do próximo rank.</p></div></div><div class="v2-performance-list">${data.promotions.slice(0,10).map((row) => { const progress = Math.min(100, num(row.merit_total) / num(row.next_threshold) * 100); return `<article class="v2-performance-row"><div><strong>${esc(row.minecraft_name)}</strong><small>${row.merit_total}/${row.next_threshold} mérito</small><div class="v2-progress"><i style="--value:${progress}%"></i></div></div><span class="rank-badge ${esc(row.rank)}">${esc(row.rank)}</span></article>`; }).join('')}</div></section></div>`;
    renderEconomyCharts(data);
  }

  function destroyChart(key) {
    state.charts[key]?.destroy?.();
    state.charts[key] = null;
  }

  function renderEconomyCharts(data) {
    if (!window.Chart) return;
    destroyChart('economy');
    destroyChart('distribution');
    const flow = data.flow || [];
    state.charts.economy = new Chart(document.getElementById('v2-economy-chart'), {
      type: 'line',
      data: { labels: flow.map((row) => dateOnly(row.day)), datasets: [
        { label: 'Créditos', data: flow.map((row) => row.credits), borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.12)', fill: true, tension: .35 },
        { label: 'Débitos', data: flow.map((row) => row.debits), borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.08)', fill: true, tension: .35 },
        { label: 'Líquido', data: flow.map((row) => row.net), borderColor: '#1761f0', borderDash: [5,4], tension: .35 },
      ] },
      options: { responsive: true, maintainAspectRatio: false },
    });
    state.charts.distribution = new Chart(document.getElementById('v2-distribution-chart'), {
      type: 'bar',
      data: { labels: data.distribution.map((row) => row.label), datasets: [{ label: 'Players', data: data.distribution.map((row) => row.total), backgroundColor: ['#64748b','#b45309','#0a7a64','#6d28d9'], borderRadius: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }

  function injectMeritOverview() {
    const card = document.getElementById('merit-card');
    if (!card || document.getElementById('v2-merit-overview')) return;
    const root = document.createElement('section');
    root.id = 'v2-merit-overview';
    root.className = 'v2-section';
    card.insertBefore(root, card.firstElementChild);
  }

  async function loadMeritOverview() {
    injectMeritOverview();
    const root = document.getElementById('v2-merit-overview');
    if (!root) return;
    root.innerHTML = '<div class="v2-loading">Consolidando a economia da FA...</div>';
    try {
      const data = await api('/api/admin/analytics/economy-overview?days=30');
      state.toolData.economy = data;
      const s = data.summary || {};
      const sumByPlayer = (predicate) => [...(data.recent_transactions || []).filter(predicate).reduce((map, row) => map.set(row.minecraft_name, (map.get(row.minecraft_name) || 0) + Math.abs(num(row.amount))), new Map())].sort((a,b) => b[1]-a[1]).slice(0,5);
      const earners = sumByPlayer((row) => row.kind === 'merit' && num(row.amount) > 0);
      const spenders = sumByPlayer((row) => row.kind === 'capital' && num(row.amount) < 0);
      root.innerHTML = `
        <div class="v2-section-head"><div><h2>Economia da Força Aliada</h2><p>Distribuição, velocidade e progressão de mérito e capital.</p></div><button class="v2-btn" data-v2-action-view="tools" data-v2-action-tool="economy">${icon('arrow-up-right')} Abrir monitor completo</button></div>
        <div class="v2-kpi-strip">${[['Mérito total',compact(s.total_merit),'var(--amber)'],['Capital total',money(s.total_capital),'var(--green)'],['Índice Gini',num(s.gini_index).toFixed(2),'var(--purple)'],['Velocidade/dia',num(s.transactions_per_day_7d).toFixed(1),'var(--accent)']].map(([label,value,tone]) => `<article class="v2-kpi-card" style="--tone:${tone}"><div class="v2-kpi-label">${label}</div><div class="v2-kpi-value">${value}</div><div class="v2-kpi-context">economia consolidada</div></article>`).join('')}</div>
        <section class="v2-panel"><div class="v2-section-head"><div><h3>Podium de mérito</h3><p>Top 3 com variação da última semana.</p></div></div><div class="v2-podium">${(data.leaders || []).slice(0,3).map((row,index) => `<article class="v2-podium-card pos-${index+1}"><span class="v2-podium-rank">${index+1}</span><img loading="lazy" src="https://minotar.net/helm/${encodeURIComponent(row.minecraft_name || 'Steve')}/72.png"><strong>${esc(row.minecraft_name)}</strong><span>${compact(row.merit_total)} mérito</span><small class="${num(row.weekly_delta) >= 0 ? 'up' : 'down'}">${num(row.weekly_delta) >= 0 ? '+' : ''}${row.weekly_delta} na semana</small></article>`).join('')}</div></section>
        <div class="v2-grid two">
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Merit Velocity</h3><p>Transações de mérito nos últimos dias.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-merit-velocity-chart"></canvas></div></section>
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Distribuição por rank</h3><p>Média de mérito e capital disponível no tooltip.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-rank-distribution-chart"></canvas></div></section>
        </div>
        <div class="v2-grid two">
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Top earners</h3><p>Mais mérito recebido no recorte recente.</p></div></div><div class="v2-performance-list">${earners.map(([name,value]) => `<article class="v2-performance-row"><strong>${esc(name)}</strong><span class="v2-delta up">+${compact(value)}</span></article>`).join('') || '<div class="v2-empty">Sem créditos recentes.</div>'}</div></section>
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Top spenders</h3><p>Maior uso de capital no recorte recente.</p></div></div><div class="v2-performance-list">${spenders.map(([name,value]) => `<article class="v2-performance-row"><strong>${esc(name)}</strong><span class="v2-delta down">-${money(value)}</span></article>`).join('') || '<div class="v2-empty">Sem débitos recentes.</div>'}</div></section>
        </div>`;
      renderMeritOverviewCharts(data);
      refreshIcons();
    } catch (error) {
      root.innerHTML = `<div class="v2-empty">${esc(error.message)}</div>`;
    }
  }

  function renderMeritOverviewCharts(data) {
    if (!window.Chart) return;
    destroyChart('meritVelocity');
    destroyChart('rankDistribution');
    const velocity = data.merit_velocity || [];
    state.charts.meritVelocity = new Chart(document.getElementById('v2-merit-velocity-chart'), {
      type: 'line',
      data: { labels: velocity.map((row) => dateOnly(row.day)), datasets: [{ label: 'Transações', data: velocity.map((row) => row.transactions), borderColor: '#b45309', backgroundColor: 'rgba(180,83,9,.12)', fill: true, tension: .35 }] },
      options: { responsive: true, maintainAspectRatio: false },
    });
    const ranks = data.rank_distribution || [];
    state.charts.rankDistribution = new Chart(document.getElementById('v2-rank-distribution-chart'), {
      type: 'doughnut',
      data: { labels: ranks.map((row) => row.rank), datasets: [{ data: ranks.map((row) => row.total), backgroundColor: ['#64748b','#f59e0b','#10b981','#7c3aed'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { afterLabel: (ctx) => { const row = ranks[ctx.dataIndex]; return `Mérito médio: ${row.avg_merit} · Capital médio: ${row.avg_capital}`; } } } } },
    });
  }

  async function renderChurnTool(body) {
    const data = await api('/api/admin/analytics/churn-risk?limit=30');
    state.toolData.churn = data;
    body.innerHTML = `${toolHeader('Radar de Abandono', 'Players com maior risco de se afastar da comunidade.', `<button class="v2-btn" data-v2-export-tool="churn">${icon('download')} CSV</button>`)}
      <section class="v2-panel"><div class="v2-risk-list">${data.map((row) => `<article class="v2-risk-row"><img loading="lazy" decoding="async" src="https://minotar.net/helm/${encodeURIComponent(row.minecraft_name || 'Steve')}/40.png"><div><strong>${esc(row.username)} ${row.minecraft_name ? `<span style="color:var(--ink-3)">${esc(row.minecraft_name)}</span>` : ''}</strong><small>Servidor: ${dateOnly(row.last_server_at)} · Comunidade: ${dateOnly(row.last_social_at)} · Sessões 4 sem: ${row.sessions_4w}</small></div><button class="v2-score" style="--tone:${row.risk_score >= 70 ? 'var(--red)' : row.risk_score >= 40 ? 'var(--amber)' : 'var(--green)'}" data-v2-churn-player="${row.id}" title="Enviar mensagem">${row.risk_score}</button></article>`).join('') || '<div class="v2-empty">Nenhum player em risco relevante.</div>'}</div></section>`;
  }

  async function renderStaffTool(body) {
    if (!isOwner()) throw new Error('Esta ferramenta é exclusiva para owner.');
    const data = await api('/api/admin/analytics/staff-performance?days=30');
    state.toolData.staff = data;
    const max = Math.max(1, ...data.map((row) => num(row.total_actions)));
    body.innerHTML = `${toolHeader('Desempenho da Staff', 'Atividade administrativa interna dos últimos 30 dias.', `<button class="v2-btn" data-v2-export-tool="staff">${icon('download')} CSV</button>`)}
      <section class="v2-panel"><div class="v2-performance-list">${data.map((row) => `<article class="v2-performance-row"><span class="v2-score" style="--tone:var(--accent)">${compact(row.total_actions)}</span><div><strong>${esc(row.actor_name)}</strong><small>${row.moderation_actions} moderação · ${row.economy_actions} economia · ${row.broadcasts} broadcasts</small><div class="v2-progress"><i style="--value:${num(row.total_actions)/max*100}%"></i></div></div><small>${dateOnly(row.last_action_at)}</small></article>`).join('') || '<div class="v2-empty">Nenhuma ação no período.</div>'}</div></section>`;
    body.querySelectorAll('.v2-performance-row').forEach((item, index) => {
      const row = data[index];
      item.querySelector('.v2-progress')?.insertAdjacentHTML('beforebegin', `<small class="v2-staff-detail">${num(row.reports_reviewed)} denúncias · ${num(row.avg_report_response_hours).toFixed(1)}h resposta · ${num(row.posts_moderated)} posts moderados (${num(row.posts_approved)} aprovados / ${num(row.posts_removed)} removidos) · mérito +${num(row.merit_granted)} / -${num(row.merit_removed)}</small>`);
    });
  }

  async function renderSocialTool(body) {
    const data = await api('/api/admin/analytics/social-graph?limit=80');
    body.innerHTML = `${toolHeader('Grafo Social', 'Quem segue quem e quais membros conectam a comunidade.')}<section class="v2-panel"><div class="v2-graph" id="v2-social-graph"></div></section>`;
    renderSocialGraph(data);
  }

  function renderSocialGraph(data) {
    const target = document.getElementById('v2-social-graph');
    if (!target) return;
    const width = 900;
    const height = 350;
    const nodes = data.nodes || [];
    const map = new Map();
    nodes.forEach((node, index) => {
      const angle = index / Math.max(1, nodes.length) * Math.PI * 2;
      const radius = 60 + (index % 4) * 38;
      map.set(num(node.id), { ...node, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius });
    });
    target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafo social">${(data.edges || []).map((edge) => { const a = map.get(num(edge.source)); const b = map.get(num(edge.target)); return a && b ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>` : ''; }).join('')}${nodes.map((node) => { const point = map.get(num(node.id)); return `<g data-v2-player="${node.id}" data-v2-player-name="${esc(node.minecraft_name || node.username)}"><circle cx="${point.x}" cy="${point.y}" r="${Math.min(15,7+num(node.followers)/3)}"/><text x="${point.x+10}" y="${point.y-9}">${esc(node.display_name || node.username)}</text></g>`; }).join('')}</svg>`;
  }

  async function loadSettings() {
    const body = document.getElementById('v2-settings-body');
    if (!body || !isOwner()) return;
    body.innerHTML = '<div class="v2-loading">Carregando configurações...</div>';
    try {
      const settings = await api('/api/admin/settings');
      body.innerHTML = `${toolHeader('Configurações do Dashboard', 'Controles globais e parâmetros operacionais.', `<button class="v2-btn primary" data-v2-save-settings>${icon('save')} Salvar alterações</button>`)}
        <div class="v2-settings-grid">
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Servidor</h3><p>Endereço, capacidade e manutenção.</p></div></div><div class="v2-form-grid" style="margin-top:13px">
            ${settingField('server_ip','IP do servidor',settings.server_ip)}
            ${settingField('server_port','Porta',settings.server_port,'number')}
            ${settingField('max_players','Máximo de players',settings.max_players,'number')}
            ${settingSelect('whitelist_enabled','Whitelist',settings.whitelist_enabled,[['true','Ativada'],['false','Desativada']])}
            ${settingField('maintenance_message','Mensagem de manutenção',settings.maintenance_message,'textarea','full')}
          </div></section>
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Moderação e Broadcast</h3><p>Limites e comportamento padrão.</p></div></div><div class="v2-form-grid" style="margin-top:13px">
            ${settingSelect('moderation_mode','Modo de moderação',settings.moderation_mode,[['manual','Manual'],['ai','IA assistida'],['auto-remove','Remoção automática']])}
            ${settingField('broadcast_max_per_day','Broadcasts por dia',settings.broadcast_max_per_day,'number')}
            ${settingSelect('channel_dashboard','Canal Dashboard',settings.broadcast_channels?.dashboard,[['true','Ativo'],['false','Inativo']])}
            ${settingSelect('channel_push','Canal Push',settings.broadcast_channels?.push,[['true','Ativo'],['false','Inativo']])}
            ${settingSelect('channel_email','Canal E-mail',settings.broadcast_channels?.email,[['true','Ativo'],['false','Inativo']])}
          </div></section>
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Thresholds de Rank</h3><p>Limites de mérito para progressão.</p></div></div><div class="v2-form-grid" style="margin-top:13px">
            ${['ferro','ouro','diamante','netherite'].map((rank) => settingField(`rank_${rank}`,rank,settings.rank_thresholds?.[rank] ?? 0,'number')).join('')}
          </div></section>
          <section class="v2-panel"><div class="v2-section-head"><div><h3>Exportação de dados</h3><p>Dumps completos em JSON para auditoria externa.</p></div></div><div class="v2-page-actions" style="margin-top:13px">${['audit','merit','sessions','users'].map((kind) => `<button class="v2-btn" data-v2-export-kind="${kind}">${icon('download')} ${kind}</button>`).join('')}</div></section>
          <section class="v2-panel v2-danger-zone span-full"><div class="v2-section-head"><div><h3 style="color:var(--red)">Danger Zone</h3><p>Ações irreversíveis exigem digitar o nome exato da ação.</p></div></div><div class="v2-page-actions" style="margin-top:13px">
            <button class="v2-btn danger" data-v2-danger-action="clear_reviewed_moderation">Limpar moderação revisada</button>
            <label class="v2-field" style="min-width:150px"><span>Inatividade (meses)</span><input id="v2-setting-inactive_months" type="number" min="6" max="60" value="12"></label>
            <button class="v2-btn danger" data-v2-danger-action="delete_inactive_accounts">Exportar + excluir inativos</button>
            <button class="v2-btn danger" data-v2-danger-action="reset_merit">Resetar mérito</button>
          </div></section>
        </div>`;
      state.toolData.settings = settings;
      refreshIcons();
    } catch (error) {
      body.innerHTML = `<div class="v2-empty">${esc(error.message)}</div>`;
    }
  }

  function settingField(name, label, value, type = 'text', extra = '') {
    return `<div class="v2-field ${extra}"><label for="v2-setting-${name}">${esc(label)}</label>${type === 'textarea' ? `<textarea id="v2-setting-${name}">${esc(value)}</textarea>` : `<input id="v2-setting-${name}" type="${type}" value="${esc(value)}">`}</div>`;
  }

  function settingSelect(name, label, value, options) {
    return `<div class="v2-field"><label for="v2-setting-${name}">${esc(label)}</label><select id="v2-setting-${name}">${options.map(([key, text]) => `<option value="${key}" ${String(value) === key ? 'selected' : ''}>${text}</option>`).join('')}</select></div>`;
  }

  async function saveSettings() {
    const get = (name) => document.getElementById(`v2-setting-${name}`)?.value;
    const payload = {
      server_ip: get('server_ip'),
      server_port: num(get('server_port')),
      max_players: num(get('max_players')),
      whitelist_enabled: get('whitelist_enabled') === 'true',
      maintenance_message: get('maintenance_message'),
      moderation_mode: get('moderation_mode'),
      broadcast_max_per_day: num(get('broadcast_max_per_day')),
      broadcast_channels: {
        dashboard: get('channel_dashboard') === 'true',
        push: get('channel_push') === 'true',
        email: get('channel_email') === 'true',
      },
      rank_thresholds: Object.fromEntries(['ferro','ouro','diamante','netherite'].map((rank) => [rank, num(get(`rank_${rank}`))])),
    };
    await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    showToast('Configurações salvas.', 'success');
  }

  async function dangerAction(action) {
    const confirmation = prompt(`Esta ação é irreversível. Digite ${action.toUpperCase()} para confirmar.`);
    if (confirmation !== action.toUpperCase()) return;
    navigator.vibrate?.([40,30,80]);
    const months = num(document.getElementById('v2-setting-inactive_months')?.value) || 12;
    const result = await api('/api/admin/settings/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, confirm: confirmation, months }) });
    if (action === 'delete_inactive_accounts' && result.export?.length) downloadJSON(`fa-contas-inativas-${new Date().toISOString().slice(0,10)}.json`, result.export);
    showToast(`${result.affected} registro(s) alterados.`, 'success');
  }

  async function exportSettingsData(kind) {
    const payload = await api(`/api/admin/settings/export/${kind}`);
    downloadJSON(`fa-${kind}-${new Date().toISOString().slice(0,10)}.json`, payload);
  }

  function downloadJSON(filename, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadCSV(filename, headers, rows) {
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportToolData(kind) {
    const date = new Date().toISOString().slice(0, 10);
    if (kind === 'calendar') {
      const rows = state.toolData.calendar || [];
      return downloadCSV(`calendario-editorial-${date}.csv`, ['id','autor','conteudo','publicacao','status'], rows.map((row) => [row.id,row.display_name || row.username,row.content,row.publish_at,row.status]));
    }
    if (kind === 'economy') {
      const rows = state.toolData.economy?.recent_transactions || [];
      return downloadCSV(`economia-${date}.csv`, ['data','player','tipo','categoria','valor','staff'], rows.map((row) => [row.created_at,row.minecraft_name,row.kind,row.category,row.amount,row.staff]));
    }
    if (kind === 'churn') {
      const rows = state.toolData.churn || [];
      return downloadCSV(`churn-risk-${date}.csv`, ['id','usuario','minecraft','risco','ultimo_servidor','ultima_comunidade','sessoes_4_semanas'], rows.map((row) => [row.id,row.username,row.minecraft_name,row.risk_score,row.last_server_at,row.last_social_at,row.sessions_4w]));
    }
    if (kind === 'staff') {
      const rows = state.toolData.staff || [];
      return downloadCSV(`staff-performance-${date}.csv`, ['staff','acoes','moderacao','economia','broadcasts','denuncias','resposta_media_h','posts_moderados','aprovados','removidos','merito_concedido','merito_removido','ultima_acao'], rows.map((row) => [row.actor_name,row.total_actions,row.moderation_actions,row.economy_actions,row.broadcasts,row.reports_reviewed,row.avg_report_response_hours,row.posts_moderated,row.posts_approved,row.posts_removed,row.merit_granted,row.merit_removed,row.last_action_at]));
    }
  }

  function exportCurrentView() {
    const card = document.getElementById(VIEW_META[state.view]?.id);
    if (!card) return;
    const selectors = '.list-item,.mod-item,.audit-item,.admin-notification-item,.v2-feed-row,.v2-performance-row,.v2-risk-row,.v2-top-post,.v2-table tbody tr,.leaderboard-table tbody tr';
    const rows = [...card.querySelectorAll(selectors)]
      .filter((row) => getComputedStyle(row).display !== 'none')
      .map((row) => [row.textContent.replace(/\s+/g, ' ').trim()])
      .filter((row) => row[0]);
    if (!rows.length) return showToast('Nenhuma linha visível para exportar.', 'warning');
    downloadCSV(`fa-${state.view}-${new Date().toISOString().slice(0,10)}.csv`, ['conteudo'], rows);
  }

  function injectPlayerToolbar() {
    const card = document.getElementById('admin-users-card');
    const tabs = card?.querySelector('.admin-tabs-bar');
    if (!card || !tabs || document.getElementById('v2-player-toolbar')) return;
    tabs.style.display = 'none';
    card.querySelector('.rank-filter-bar')?.style.setProperty('display', 'none');
    card.querySelector('.sort-bar')?.style.setProperty('display', 'none');
    const toolbar = document.createElement('div');
    toolbar.id = 'v2-player-toolbar';
    toolbar.className = 'v2-player-toolbar';
    toolbar.innerHTML = `
      <div class="v2-player-tabs">${[['staff','Staff cadastrada'],['all','Todos os players'],['unregistered','Sem cadastro'],['inactive','Inativos (30d+)'],['new','Novos (7d)']].map(([key,label]) => `<button class="v2-player-tab ${key === state.playerSegment ? 'active' : ''}" data-v2-player-segment="${key}">${label}</button>`).join('')}</div>
      <select data-v2-player-filter="access"><option value="all">Qualquer acesso</option><option value="today">Online hoje</option><option value="week">Última semana</option><option value="month">Último mês</option><option value="never">Nunca</option></select>
      <select data-v2-player-filter="verified"><option value="all">Verificação: todas</option><option value="yes">Verificados</option><option value="no">Não verificados</option></select>
      <select data-v2-player-filter="linked"><option value="all">Minecraft: todos</option><option value="yes">Com Minecraft</option><option value="no">Sem Minecraft</option></select>
      <select data-v2-player-filter="role"><option value="all">Role: todas</option><option value="limited">Limited</option><option value="full">Full</option><option value="owner">Owner</option></select>
      <button class="v2-btn" data-v2-player-view="list">${icon('list')}</button><button class="v2-btn" data-v2-player-view="cards">${icon('layout-grid')}</button>`;
    toolbar.querySelector('.v2-player-tabs')?.insertAdjacentHTML('afterend', `<button class="v2-btn v2-filter-toggle" data-v2-filter-toggle>${icon('sliders-horizontal')} Filtros</button>`);
    toolbar.querySelector('[data-v2-player-filter="role"]')?.insertAdjacentHTML('afterend', '<select data-v2-player-filter="rank"><option value="all">Rank: todos</option><option value="ferro">Ferro</option><option value="ouro">Ouro</option><option value="diamante">Diamante</option><option value="netherite">Netherite</option></select>');
    tabs.parentNode.insertBefore(toolbar, tabs);
    const bulk = document.createElement('div');
    bulk.id = 'v2-bulk-bar';
    bulk.className = 'v2-bulk-bar';
    bulk.innerHTML = `<strong><span id="v2-bulk-count">0</span> selecionado(s)</strong><button class="v2-btn" data-v2-bulk-notify>${icon('send')} Enviar aviso</button><button class="v2-btn" data-v2-bulk-export>${icon('download')} Exportar</button><button class="v2-btn" data-v2-bulk-verify>${icon('badge-check')} Verificar</button><button class="v2-btn" data-v2-bulk-clear>${icon('x')} Limpar</button>`;
    card.appendChild(bulk);
    refreshIcons();
  }

  async function loadPlayerDirectory() {
    injectPlayerToolbar();
    try {
      state.playerDirectory = await api('/api/admin/players/directory');
      const byId = new Map(state.playerDirectory.map((item) => [num(item.id), item]));
      if (typeof globalAdminUsers !== 'undefined' && !globalAdminUsers.length) {
        globalAdminUsers = state.playerDirectory.map((item) => ({ ...item, merit_total: item.merit, capital_balance: item.capital }));
      }
      if (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW && typeof globalUnregistered !== 'undefined' && !globalUnregistered.length) {
        globalUnregistered = ['BuilderSemConta', 'ExploradorFA', 'RedstoneMaster'].map((player, index) => ({ player, total_sessions: 9 - index * 2, total_hours: 24 - index * 5, first_seen: new Date(Date.now() - (80 - index * 10) * 86400000).toISOString(), last_seen: new Date(Date.now() - (3 + index * 4) * 86400000).toISOString() }));
      }
      if (typeof globalAdminUsers !== 'undefined') globalAdminUsers.forEach((item) => Object.assign(item, byId.get(num(item.id)) || {}));
      renderAdminTab();
    } catch (error) {
      console.warn('[dashboard-v2 players]', error);
      postProcessPlayerList();
    }
  }

  function setPlayerSegment(segment) {
    state.playerSegment = segment;
    state.selectedPlayers.clear();
    document.querySelectorAll('[data-v2-player-segment]').forEach((button) => button.classList.toggle('active', button.dataset.v2PlayerSegment === segment));
    if (segment === 'unregistered') switchAdminTab('unregistered');
    else switchAdminTab('registered');
    setTimeout(postProcessPlayerList, 0);
  }

  function playerMatches(user) {
    const segment = state.playerSegment;
    if (segment === 'staff' && user.role === 'limited') return false;
    if (segment === 'inactive' && daysAgo(user.last_activity) < 30) return false;
    if (segment === 'new' && daysAgo(user.created_at) > 7) return false;
    if (state.playerFilters.role !== 'all' && user.role !== state.playerFilters.role) return false;
    if (state.playerFilters.rank !== 'all' && String(user.rank || 'ferro').toLowerCase() !== state.playerFilters.rank) return false;
    if (state.playerFilters.verified === 'yes' && !user.is_platform_verified) return false;
    if (state.playerFilters.verified === 'no' && user.is_platform_verified) return false;
    if (state.playerFilters.linked === 'yes' && !user.minecraft_name) return false;
    if (state.playerFilters.linked === 'no' && user.minecraft_name) return false;
    const ago = daysAgo(user.last_activity);
    if (state.playerFilters.access === 'today' && ago > 1) return false;
    if (state.playerFilters.access === 'week' && ago > 7) return false;
    if (state.playerFilters.access === 'month' && ago > 30) return false;
    if (state.playerFilters.access === 'never' && ago < 9999) return false;
    return true;
  }

  function postProcessPlayerList() {
    const list = document.getElementById('admin-users-list');
    if (!list) return;
    list._v2Virtual?.destroy?.();
    appendUnregisteredPlayers(list);
    list.classList.toggle('v2-card-view', state.playerView === 'cards' || innerWidth <= 900);
    list.querySelectorAll('li.list-item').forEach((item) => {
      const call = item.getAttribute('onclick') || '';
      const match = call.match(/,\s*(\d+)\s*\)/);
      const id = match ? num(match[1]) : 0;
      if (!id || state.playerSegment === 'unregistered') {
        item.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
        return;
      }
      const user = state.playerDirectory.find((entry) => num(entry.id) === id) || globalAdminUsers.find((entry) => num(entry.id) === id);
      item.dataset.v2UserId = id;
      const visible = Boolean(user && playerMatches(user));
      item.dataset.v2FilterVisible = visible ? '1' : '0';
      item.style.display = visible ? '' : 'none';
      if (!item.querySelector('.v2-select-box')) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'v2-select-box';
        checkbox.checked = state.selectedPlayers.has(id);
        checkbox.setAttribute('aria-label', `Selecionar ${user?.username || 'player'}`);
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => togglePlayerSelection(id, checkbox.checked));
        item.prepend(checkbox);
      }
      const details = item.querySelector('.item-details');
      if (details && user && !details.querySelector('.v2-player-extra')) {
        details.insertAdjacentHTML('beforeend', `<span class="v2-player-extra">${user.posts || 0} posts · ${user.comments || 0} comentários · ${user.sessions || 0} sessões · ${Number(user.total_hours || 0).toFixed(1)}h</span>`);
      }
      item.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
      installLongPress(item, user);
    });
    updateBulkBar();
    if (state.playerView === 'list' && innerWidth > 900) {
      ensureLazyRuntime()
        .then(({ installVirtualWindow }) => installVirtualWindow(list, { selector: ':scope > li.list-item', rowHeight: 78 }))
        .catch((error) => console.warn('[dashboard-v2 virtual list]', error));
    }
  }

  function appendUnregisteredPlayers(list) {
    list.querySelectorAll('[data-v2-unregistered]').forEach((item) => item.remove());
    if (state.playerSegment !== 'all' || typeof globalUnregistered === 'undefined') return;
    const term = document.getElementById('admin-search')?.value.toLowerCase().trim() || '';
    const rows = globalUnregistered.filter((row) => String(row.player || '').toLowerCase().includes(term));
    list.insertAdjacentHTML('beforeend', rows.map((row) => `<li class="list-item" data-v2-unregistered="${esc(row.player)}" data-v2-player-name="${esc(row.player)}" data-v2-long-press="1">
      <img loading="lazy" decoding="async" src="https://minotar.net/helm/${encodeURIComponent(row.player || 'Steve')}/40.png" class="mc-head">
      <div class="item-details"><strong>${esc(row.player)} <span class="unregistered-badge">Sem cadastro</span></strong><span>${row.total_sessions || 0} sessões · ${Number(row.total_hours || 0).toFixed(1)}h · visto ${dateOnly(row.last_seen)}</span></div>
      <button class="v2-btn" type="button" data-v2-player-name="${esc(row.player)}">Abrir</button>
    </li>`).join(''));
  }

  function togglePlayerSelection(id, selected) {
    if (selected) state.selectedPlayers.add(id);
    else state.selectedPlayers.delete(id);
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = document.getElementById('v2-bulk-bar');
    if (!bar) return;
    bar.classList.toggle('active', state.selectedPlayers.size > 0);
    const count = document.getElementById('v2-bulk-count');
    if (count) count.textContent = state.selectedPlayers.size;
  }

  function selectedDirectory() {
    return state.playerDirectory.filter((item) => state.selectedPlayers.has(num(item.id)));
  }

  async function bulkVerify() {
    await api('/api/admin/users/bulk-verified', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...state.selectedPlayers], verified: true }) });
    showToast('Players verificados.', 'success');
    state.selectedPlayers.clear();
    await loadPlayerDirectory();
  }

  async function bulkNotify() {
    const title = prompt('Título do aviso para os players selecionados:');
    if (!title) return;
    const body = prompt('Mensagem do aviso:');
    if (!body) return;
    await api('/api/admin/users/bulk-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...state.selectedPlayers], title, body, type: 'info', icon: 'bell' }) });
    showToast('Aviso enviado aos players selecionados.', 'success');
  }

  function exportSelectedPlayers() {
    const rows = selectedDirectory();
    const csv = [['id','username','email','minecraft','role','rank','merit','last_activity'], ...rows.map((row) => [row.id,row.username,row.email,row.minecraft_name,row.role,row.rank,row.merit,row.last_activity])].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `players-selecionados-${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function installLongPress(element, user) {
    if (element.dataset.v2LongPress || !user) return;
    element.dataset.v2LongPress = '1';
    let timer;
    element.addEventListener('touchstart', () => { timer = setTimeout(() => { navigator.vibrate?.(25); openPlayerQuickActions(user); }, 600); }, { passive: true });
    ['touchend','touchmove','touchcancel'].forEach((type) => element.addEventListener(type, () => clearTimeout(timer), { passive: true }));
  }

  function openPlayerQuickActions(user) {
    const dialog = document.getElementById('v2-command-dialog');
    if (!dialog) return;
    document.getElementById('v2-command-input').value = user.username;
    document.getElementById('v2-command-results').innerHTML = `<div class="v2-command-group-label">${esc(user.username)}</div>
      <button class="v2-command-item" data-v2-player="${user.id}" data-v2-player-name="${esc(user.minecraft_name || user.username)}">${icon('user-round')}<span>Abrir perfil</span></button>
      <button class="v2-command-item" data-v2-action-view="merit">${icon('star')}<span>Conceder mérito</span></button>
      <button class="v2-command-item" data-v2-quick-notify="${user.id}">${icon('send')}<span>Enviar aviso</span></button>`;
    dialog.showModal();
    refreshIcons();
  }

  function injectNotificationWorkspace() {
    const card = document.getElementById('admin-notifications-card');
    const form = card?.querySelector('.admin-notification-form');
    if (!card || !form || document.getElementById('v2-notification-extras')) return;
    card.querySelector('h3').innerHTML = 'Broadcast &amp; Avisos <span>Comunicação acionável, com preview, templates e agendamento</span>';
    const extras = document.createElement('div');
    extras.id = 'v2-notification-extras';
    extras.innerHTML = `
      <div class="v2-editor-toolbar"><button type="button" data-v2-format="**" title="Negrito">B</button><button type="button" data-v2-format="_" title="Itálico"><i>I</i></button><button type="button" data-v2-format="[]" title="Link">${icon('link')}</button><button type="button" data-v2-format="emoji" title="Emoji">${icon('smile')}</button></div>
      <div class="admin-notification-grid"><input type="datetime-local" id="v2-notif-scheduled" aria-label="Agendar para"><input type="url" id="v2-notif-link" placeholder="Link opcional"></div>
      <div class="v2-template-list" id="v2-template-list"></div>`;
    const textarea = document.getElementById('notif-body-input');
    textarea.parentNode.insertBefore(extras, textarea.nextSibling);
    const preview = document.createElement('aside');
    preview.className = 'v2-notif-preview';
    preview.id = 'v2-notif-preview';
    preview.innerHTML = '<div class="v2-label">Preview real</div><div id="v2-notif-preview-card" style="margin-top:12px"></div>';
    const workspace = document.createElement('div');
    workspace.className = 'v2-notification-workspace';
    form.parentNode.insertBefore(workspace, form);
    workspace.append(form, preview);
    ['notif-title-input','notif-body-input','notif-type-input','notif-icon-input','v2-notif-link'].forEach((id) => document.getElementById(id)?.addEventListener('input', renderNotificationPreview));
    refreshIcons();
  }

  function renderNotificationPreview() {
    const target = document.getElementById('v2-notif-preview-card');
    if (!target) return;
    const title = document.getElementById('notif-title-input')?.value || 'Título do aviso';
    const body = document.getElementById('notif-body-input')?.value || 'A mensagem aparecerá aqui conforme você digita.';
    const type = document.getElementById('notif-type-input')?.value || 'info';
    target.innerHTML = `<article class="v2-notif-preview-card"><span class="v2-score" style="--tone:${type === 'warning' ? 'var(--amber)' : type === 'event' ? 'var(--purple)' : 'var(--accent)'}">${icon(type === 'event' ? 'calendar-days' : type === 'warning' ? 'triangle-alert' : 'bell')}</span><div><strong>${esc(title)}</strong><p>${esc(body).replace(/\*\*(.*?)\*\*/g,'<b>$1</b>').replace(/_(.*?)_/g,'<i>$1</i>').replace(/\n/g,'<br>')}</p></div></article>`;
    refreshIcons();
  }

  async function loadNotificationWorkspace() {
    injectNotificationWorkspace();
    renderNotificationPreview();
    try {
      const templates = await api('/api/admin/notification-templates');
      const target = document.getElementById('v2-template-list');
      if (target) target.innerHTML = `<button class="v2-btn" data-v2-save-template>${icon('bookmark-plus')} Salvar como template</button>${templates.map((item) => `<button class="v2-btn" data-v2-template-id="${item.id}" data-title="${esc(item.title)}" data-body="${esc(item.body)}" data-type="${esc(item.type)}">${esc(item.title)}</button>`).join('')}`;
      refreshIcons();
    } catch (error) {
      console.warn('[dashboard-v2 templates]', error);
    }
  }

  async function submitV2Notification(event) {
    event.preventDefault();
    const payload = {
      title: document.getElementById('notif-title-input').value.trim(),
      body: document.getElementById('notif-body-input').value.trim(),
      type: document.getElementById('notif-type-input').value,
      icon: document.getElementById('notif-icon-input').value.trim() || 'bell',
      audience: document.getElementById('notif-audience-input').value,
      audience_val: document.getElementById('notif-audience-value-input').value.trim(),
      scheduled_for: document.getElementById('v2-notif-scheduled')?.value || null,
      link_url: document.getElementById('v2-notif-link')?.value.trim() || null,
    };
    const button = document.getElementById('notif-submit-btn');
    button.disabled = true;
    button.textContent = payload.scheduled_for ? 'Agendando...' : 'Publicando...';
    try {
      await api('/api/admin/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      showToast(payload.scheduled_for ? 'Aviso agendado.' : 'Aviso publicado.', 'success');
      event.target.reset();
      document.getElementById('notif-icon-input').value = 'bell';
      await Promise.all([loadAdminNotifications(), loadNotifications()]);
      renderNotificationPreview();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Publicar notificação';
    }
  }

  async function saveNotificationTemplate() {
    const payload = { title: document.getElementById('notif-title-input').value.trim(), body: document.getElementById('notif-body-input').value.trim(), type: document.getElementById('notif-type-input').value, icon: document.getElementById('notif-icon-input').value.trim() || 'bell' };
    await api('/api/admin/notification-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    showToast('Template salvo.', 'success');
    loadNotificationWorkspace();
  }

  function applyTemplate(button) {
    document.getElementById('notif-title-input').value = button.dataset.title || '';
    document.getElementById('notif-body-input').value = button.dataset.body || '';
    document.getElementById('notif-type-input').value = button.dataset.type || 'info';
    renderNotificationPreview();
  }

  function formatNotification(marker) {
    const field = document.getElementById('notif-body-input');
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = field.value.slice(start, end);
    let text = marker === 'emoji' ? `${field.value.slice(0,start)}✨${field.value.slice(end)}` :
      marker === '[]' ? `${field.value.slice(0,start)}[${selected || 'texto'}](https://)${field.value.slice(end)}` :
      `${field.value.slice(0,start)}${marker}${selected || 'texto'}${marker}${field.value.slice(end)}`;
    field.value = text;
    field.dispatchEvent(new Event('input'));
    field.focus();
  }

  function injectServerIntelligence() {
    const card = document.getElementById('server-overview');
    if (!card || document.getElementById('v2-server-intelligence')) return;
    const section = document.createElement('section');
    section.id = 'v2-server-intelligence';
    section.className = 'v2-grid two';
    section.innerHTML = `
      <article class="v2-panel"><div class="v2-section-head"><div><h3>Atividade 7×24</h3><p>Intensidade de sessões por horário.</p></div></div><div id="v2-server-heatmap" class="v2-loading">Carregando...</div></article>
      <article class="v2-panel"><div class="v2-section-head"><div><h3>Live Activity Feed</h3><p>Entradas e saídas mais recentes.</p></div></div><div id="v2-server-feed" class="v2-feed"></div></article>
      <article class="v2-panel span-2"><div class="v2-section-head"><div><h3>Linha do tempo de uptime</h3><p>Disponibilidade horária nos últimos 30 dias.</p></div><label class="v2-btn"><input type="checkbox" id="v2-server-compare"> Comparar período anterior</label></div><div id="v2-uptime-timeline" style="margin-top:14px"></div></article>
      <article class="v2-panel span-2"><div class="v2-section-head"><div><h3>Player presence</h3><p>Players únicos, pico simultâneo e comparação anterior.</p></div></div><div class="v2-chart-wrap"><canvas id="v2-server-presence-chart"></canvas></div></article>`;
    card.insertBefore(section, card.querySelector('.dashboard-grid') || card.children[2]);
  }

  async function loadServerIntelligence() {
    injectServerIntelligence();
    try {
      const [heatmap, uptime, presence] = await Promise.all([api('/api/admin/server/activity-heatmap?days=30'), api('/api/admin/server/uptime-timeline?days=60'), api('/api/admin/server/presence?days=28')]);
      state.toolData.serverUptime = uptime;
      state.toolData.serverPresence = presence;
      renderActivityHeatmap('v2-server-heatmap', heatmap);
      renderUptimeTimeline(uptime);
      renderServerFeed();
      renderServerPresence(presence);
    } catch (error) {
      console.warn('[dashboard-v2 server]', error);
    }
  }

  function renderUptimeTimeline(rows) {
    const target = document.getElementById('v2-uptime-timeline');
    if (!target) return;
    const midpoint = Math.floor(rows.length / 2);
    const current = rows.slice(midpoint);
    const previous = rows.slice(0, midpoint);
    const strip = (items) => `<div style="display:flex;gap:2px;overflow-x:auto">${items.map((row) => `<span title="${dateTime(row.bucket)} · ${pct(row.uptime_pct)} · pico ${row.peak_players}" style="flex:1 0 4px;min-width:4px;height:38px;border-radius:3px;background:${num(row.uptime_pct) >= 99 ? 'var(--green)' : num(row.uptime_pct) >= 75 ? 'var(--amber)' : 'var(--red)'};opacity:${.35 + num(row.uptime_pct)/155}"></span>`).join('')}</div>`;
    const compare = document.getElementById('v2-server-compare')?.checked;
    target.innerHTML = rows.length ? `<small class="v2-label">Período atual</small>${strip(current)}${compare && previous.length ? `<small class="v2-label" style="display:block;margin-top:12px">Período anterior</small>${strip(previous)}` : ''}` : '<div class="v2-empty">Sem checks de uptime no período.</div>';
  }

  function renderServerPresence(rows = state.toolData.serverPresence || []) {
    if (!window.Chart || !document.getElementById('v2-server-presence-chart')) return;
    const buckets = rows.map((row) => ({ key: row.day, unique: num(row.unique_players), peak: num(row.peak_players) }));
    const previous = buckets.slice(0,14);
    const current = buckets.slice(14);
    const compare = document.getElementById('v2-server-compare')?.checked;
    destroyChart('serverPresence');
    state.charts.serverPresence = new Chart(document.getElementById('v2-server-presence-chart'), {
      type: 'bar',
      data: { labels: current.map((row) => dateOnly(row.key)), datasets: [
        { type: 'bar', label: 'Pico simultâneo', data: current.map((row) => row.peak), backgroundColor: 'rgba(23,97,240,.18)', borderRadius: 7 },
        { type: 'line', label: 'Players únicos', data: current.map((row) => row.unique), borderColor: '#1761f0', tension: .35 },
        ...(compare ? [{ type: 'line', label: 'Únicos · período anterior', data: previous.map((row) => row.unique), borderColor: '#7b8ca5', borderDash: [5,4], tension: .35 }] : []),
      ] },
      options: { responsive: true, maintainAspectRatio: false },
    });
  }

  function renderServerFeed() {
    const target = document.getElementById('v2-server-feed');
    if (!target) return;
    const history = typeof globalHistData !== 'undefined' ? globalHistData?.history || [] : [];
    const online = typeof globalHistData !== 'undefined' ? globalHistData?.onlinePlayers || [] : [];
    const entries = [
      ...online.slice(0,5).map((player) => ({ player: player.player || player.name || player, type: 'online', at: player.enteredAt || player.entered_at || new Date() })),
      ...history.slice(0,8).map((player) => ({ player: player.player, type: 'offline', at: player.leftAt || player.left_at })),
    ].sort((a,b) => new Date(b.at) - new Date(a.at)).slice(0,10);
    target.innerHTML = entries.map((entry) => `<button class="v2-feed-row" data-v2-player-name="${esc(entry.player)}" style="width:100%;cursor:pointer;text-align:left"><span class="${entry.type === 'online' ? 'status-online' : 'status-offline'}" style="width:8px;height:8px;border-radius:50%"></span><div><strong>${esc(entry.player)}</strong><small>${entry.type === 'online' ? 'entrou no servidor' : 'saiu do servidor'} · ${dateTime(entry.at)}</small></div></button>`).join('') || '<div class="v2-empty">Nenhum evento recente.</div>';
  }

  function injectModerationEnhancements() {
    const card = document.getElementById('moderation-card');
    if (!card || document.getElementById('v2-moderation-overview')) return;
    const overview = document.createElement('section');
    overview.id = 'v2-moderation-overview';
    overview.className = 'v2-section';
    card.insertBefore(overview, card.querySelector('.mod-tabs-bar'));
    const toolbar = document.createElement('div');
    toolbar.className = 'v2-player-toolbar';
    toolbar.innerHTML = `<label style="color:var(--ink-3);font-size:10px;font-weight:800">Confiança IA ≥ <span id="v2-confidence-label">0%</span></label><input type="range" id="v2-confidence" min="0" max="100" value="0"><button class="v2-btn" data-v2-mod-bulk="approve">${icon('check')} Aprovar selecionados</button><button class="v2-btn danger" data-v2-mod-bulk="remove_content">${icon('trash-2')} Remover selecionados</button>`;
    card.querySelector('#mod-panel-ai')?.prepend(toolbar);
    refreshIcons();
  }

  async function loadModerationOverview() {
    injectModerationEnhancements();
    try {
      const data = await api('/api/admin/analytics/moderation-overview?days=14');
      const s = data.summary || {};
      document.getElementById('v2-moderation-overview').innerHTML = `<div class="v2-kpi-strip">${[['Pendentes',num(s.pending_ai)+num(s.pending_reports),'var(--red)'],['Aprovados',s.approved,'var(--green)'],['Removidos',s.removed,'var(--amber)'],['Tempo médio',`${num(s.avg_response_hours).toFixed(1)}h`,'var(--accent)']].map(([label,value,tone]) => `<article class="v2-kpi-card" style="--tone:${tone}"><div class="v2-kpi-label">${label}</div><div class="v2-kpi-value">${value}</div><div class="v2-kpi-context">visão da quinzena</div></article>`).join('')}</div><section class="v2-panel"><div class="v2-section-head"><div><h3>Histórico de decisões</h3><p>Volume de denúncias por dia para identificar incidentes.</p></div></div><div class="v2-chart-wrap small"><canvas id="v2-moderation-chart"></canvas></div></section>`;
      if (window.Chart) {
        destroyChart('moderation');
        state.charts.moderation = new Chart(document.getElementById('v2-moderation-chart'), {
          type: 'line',
          data: { labels: data.daily.map((row) => dateOnly(row.day)), datasets: [{ label: 'Denúncias', data: data.daily.map((row) => row.reports), borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.1)', fill: true, tension: .35 }] },
          options: { responsive: true, maintainAspectRatio: false },
        });
      }
    } catch (error) {
      console.warn('[dashboard-v2 moderation]', error);
    }
  }

  function enhanceModerationItem(item, row) {
    if (!item || item.querySelector('.v2-select-box')) return item;
    item.dataset.v2Confidence = num(row?.ai_confidence || .5) * 100;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'v2-select-box';
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedModeration.add(num(row.id)); else state.selectedModeration.delete(num(row.id));
      item.classList.toggle('v2-selected', checkbox.checked);
    });
    item.querySelector('.mod-item-header')?.prepend(checkbox);
    item.querySelectorAll('.mod-images img').forEach((image) => {
      image.onclick = (event) => { event.stopPropagation(); openImageOverlay(image.src); };
      image.decoding = 'async';
    });
    return item;
  }

  async function bulkModeration(action) {
    const ids = [...state.selectedModeration];
    if (!ids.length) return showToast('Selecione itens da fila.', 'warning');
    navigator.vibrate?.(action === 'remove_content' ? [40,30,80] : 20);
    await Promise.all(ids.map((id) => api(`/api/admin/moderation-queue/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })));
    state.selectedModeration.clear();
    showToast(`${ids.length} item(ns) revisados.`, 'success');
    loadModerationQueue(true);
    loadModerationOverview();
  }

  function openImageOverlay(src) {
    const overlay = document.createElement('div');
    overlay.className = 'v2-image-overlay';
    overlay.innerHTML = `<img src="${esc(src)}" alt="Preview em tela cheia">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  function injectAuditOverview() {
    const card = document.getElementById('audit-card');
    if (!card || document.getElementById('v2-audit-overview')) return;
    const input = document.getElementById('audit-actor-filter');
    if (input) input.placeholder = 'Buscar ator ou mensagem…';
    const overview = document.createElement('section');
    overview.id = 'v2-audit-overview';
    overview.className = 'v2-grid two';
    overview.innerHTML = `<article class="v2-panel"><div class="v2-section-head"><div><h3>Heatmap administrativo</h3><p>Ações por dia e hora.</p></div></div><div id="v2-audit-heatmap" class="v2-loading">Carregando...</div></article><article class="v2-panel"><div class="v2-section-head"><div><h3>Admins mais ativos</h3><p>Volume de ações nos últimos 30 dias.</p></div></div><div id="v2-audit-actors" class="v2-performance-list"></div></article>`;
    card.insertBefore(overview, card.querySelector('.audit-tabs'));
    overview.insertAdjacentHTML('afterend', `<div class="v2-audit-controls"><select class="v2-btn" data-v2-audit-days><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option><option value="365">1 ano</option></select><button class="v2-btn" data-v2-audit-view>${icon('git-commit-horizontal')} Alternar lista/timeline</button></div>`);
    refreshIcons();
  }

  async function applyAuditTimeline() {
    if (!state.auditTimeline || typeof auditLogs === 'undefined') return;
    const list = document.getElementById('audit-log-list');
    if (!list || !auditLogs.length) return;
    const items = [...list.querySelectorAll(':scope > .audit-item')];
    const { groupTimelineByHour } = await ensureLazyRuntime();
    const groups = groupTimelineByHour(auditLogs);
    let offset = 0;
    const nodes = [];
    groups.forEach((group) => {
      const heading = document.createElement('div');
      heading.className = 'v2-audit-hour';
      heading.textContent = `${group.label} · ${group.logs.length} evento(s)`;
      nodes.push(heading, ...items.slice(offset, offset + group.logs.length));
      offset += group.logs.length;
    });
    list.replaceChildren(...nodes);
  }

  async function loadAuditOverview() {
    injectAuditOverview();
    try {
      const data = await api('/api/admin/analytics/audit-overview?days=30');
      renderActivityHeatmap('v2-audit-heatmap', data.heatmap, 'actions');
      const max = Math.max(1, ...data.actors.map((row) => num(row.actions)));
      document.getElementById('v2-audit-actors').innerHTML = data.actors.map((row) => `<article class="v2-performance-row"><span class="v2-score" style="--tone:var(--accent)">${row.actions}</span><div><strong>${esc(row.actor_name)}</strong><div class="v2-progress"><i style="--value:${num(row.actions)/max*100}%"></i></div></div></article>`).join('');
    } catch (error) {
      console.warn('[dashboard-v2 audit]', error);
    }
  }

  async function loadPlayerTimeline(userId) {
    if (!userId) return;
    let panel = document.getElementById('v2-player-timeline-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'v2-player-timeline-panel';
      panel.className = 'staff-insights';
      panel.innerHTML = '<div class="staff-insights-head"><div><h4>Jornada do Player</h4><small>Eventos significativos da conta, comunidade e servidor.</small></div></div><div id="v2-player-timeline" class="v2-loading">Carregando timeline...</div>';
      document.getElementById('staff-profile-insights')?.insertAdjacentElement('afterend', panel) || document.querySelector('#player-modal .modal-body')?.prepend(panel);
    }
    panel.style.display = '';
    const target = document.getElementById('v2-player-timeline');
    target.className = 'v2-loading';
    target.textContent = 'Carregando timeline...';
    try {
      const data = await api(`/api/admin/users/${userId}/timeline`);
      target.className = 'v2-timeline';
      target.innerHTML = data.slice(0,40).map((event) => `<article class="v2-timeline-item" style="--tone:${event.type === 'merit' ? 'var(--amber)' : event.type === 'audit' ? 'var(--red)' : event.type === 'legacy' ? 'var(--purple)' : 'var(--accent)'}"><strong>${esc(event.label)}</strong><small>${dateTime(event.timestamp)}${event.detail ? ` · ${esc(event.detail)}` : ''}</small></article>`).join('') || '<div class="v2-empty">Nenhum evento registrado.</div>';
    } catch (error) {
      target.className = 'v2-empty';
      target.textContent = error.message;
    }
  }

  async function showComparison() {
    state.comparisonOpen = !state.comparisonOpen;
    const card = document.getElementById(VIEW_META[state.view]?.id);
    if (!card) return;
    let panel = card.querySelector(':scope > #v2-comparison-panel');
    if (!state.comparisonOpen) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'v2-comparison-panel';
      panel.className = 'v2-panel';
      card.insertBefore(panel, card.firstElementChild);
    }
    panel.innerHTML = '<div class="v2-loading">Comparando períodos...</div>';
    try {
      const rows = await api(`/api/admin/analytics/comparison?primary_days=${state.comparisonDays.primary}&compare_days=${state.comparisonDays.compare}`);
      const current = rows.find((row) => row.period === 'current') || {};
      const previous = rows.find((row) => row.period === 'previous') || {};
      panel.innerHTML = `<div class="v2-section-head"><div><h3>Período atual vs. 30 dias anteriores</h3><p>Comparação automática de métricas operacionais.</p></div><button class="v2-btn" data-v2-compare>${icon('x')} Fechar</button></div><div class="v2-kpi-strip" style="margin-top:13px">${[['Usuários ativos','active_users'],['Eventos sociais','social_events'],['Posts','posts'],['Horas de jogo','play_hours'],['Players únicos','unique_players']].map(([label,key]) => `<article class="v2-kpi-card"><div class="v2-kpi-label">${label}</div><div class="v2-kpi-value">${compact(current[key])}</div>${deltaHtml(current[key],previous[key])}<div class="v2-kpi-context">Anterior: ${compact(previous[key])}</div></article>`).join('')}</div>`;
      const comparisonOptions = [7,14,30,60,90].map((days) => `<option value="${days}">${days} dias</option>`).join('');
      panel.querySelector('.v2-section-head > div')?.insertAdjacentHTML('beforeend', `<div class="v2-comparison-selects"><label>Período A <select data-v2-comparison-period="primary">${comparisonOptions}</select></label><label>Período B anterior <select data-v2-comparison-period="compare">${comparisonOptions}</select></label></div>`);
      panel.querySelector('[data-v2-comparison-period="primary"]').value = String(state.comparisonDays.primary);
      panel.querySelector('[data-v2-comparison-period="compare"]').value = String(state.comparisonDays.compare);
      panel.querySelector('.v2-section-head h3').textContent = `${state.comparisonDays.primary} dias atuais vs. ${state.comparisonDays.compare} dias anteriores`;
      refreshIcons();
    } catch (error) {
      panel.innerHTML = `<div class="v2-empty">${esc(error.message)}</div>`;
    }
  }

  function setupChartDefaults() {
    if (!window.Chart) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const ink = dark ? '#a8bacc' : '#3d4f68';
    const grid = dark ? 'rgba(255,255,255,.07)' : 'rgba(11,21,36,.07)';
    Chart.defaults.font.family = "'DM Mono', monospace";
    Chart.defaults.font.size = 10;
    Chart.defaults.color = ink;
    Chart.defaults.borderColor = grid;
    Chart.defaults.plugins.tooltip.backgroundColor = dark ? '#1a2540' : '#fff';
    Chart.defaults.plugins.tooltip.borderColor = dark ? 'rgba(255,255,255,.12)' : 'rgba(11,21,36,.1)';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = dark ? '#eef3ff' : '#0b1524';
    Chart.defaults.plugins.tooltip.bodyColor = ink;
    Chart.defaults.plugins.tooltip.cornerRadius = 10;
    Chart.defaults.plugins.tooltip.padding = 12;
  }

  function lazyImages() {
    document.querySelectorAll('img').forEach((image) => {
      if (!image.loading) image.loading = 'lazy';
      if (!image.decoding) image.decoding = 'async';
    });
    document.querySelectorAll('.v2-empty,.empty-state').forEach((empty) => {
      if (empty.closest('dialog') || empty.querySelector('button,a') || empty.dataset.v2Cta) return;
      empty.dataset.v2Cta = '1';
      empty.insertAdjacentHTML('beforeend', `<div style="margin-top:12px"><button class="v2-btn" data-v2-refresh>${icon('refresh-cw')} Tentar novamente</button></div>`);
    });
    refreshIcons();
  }

  function setupSwipeToClose() {
    let startY = 0;
    document.addEventListener('touchstart', (event) => {
      if (event.target.closest('.modal-content')) startY = event.changedTouches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (event) => {
      if (startY && event.changedTouches[0].clientY - startY > 120) closeModal?.();
      startY = 0;
    }, { passive: true });
  }

  function setupPullToRefresh() {
    let startY = 0;
    let pulling = false;
    const content = document.querySelector('.dashboard-content');
    content?.addEventListener('touchstart', (event) => {
      const active = document.querySelector('.dashboard-card-active');
      if ((active?.scrollTop || 0) <= 0) { startY = event.touches[0].clientY; pulling = true; }
    }, { passive: true });
    content?.addEventListener('touchend', (event) => {
      if (pulling && event.changedTouches[0].clientY - startY > 100) {
        navigator.vibrate?.(15);
        refreshActiveView();
      }
      pulling = false;
    }, { passive: true });
  }

  function refreshActiveView() {
    if (state.view === 'command' || state.view === 'analytics') loadExecutiveAnalytics?.(true);
    if (state.view === 'server') { loadData?.(); loadServerIntelligence(); }
    if (state.view === 'players') loadPlayerDirectory();
    if (state.view === 'merit') loadMeritOverview();
    if (state.view === 'moderation') { modRefresh?.(); loadModerationOverview(); }
    if (state.view === 'audit') { fetchAuditLogs?.(); loadAuditOverview(); }
    if (state.view === 'notifications') { loadAdminNotifications?.(); loadNotificationWorkspace(); }
    if (state.view === 'tools') activateTool(state.tool);
    if (state.view === 'settings') loadSettings();
    showToast('Dashboard atualizado.', 'success');
  }

  function bindEvents() {
    document.addEventListener('click', async (event) => {
      const viewButton = event.target.closest('[data-v2-view]');
      if (viewButton) { event.preventDefault(); navigate(viewButton.dataset.v2View); document.getElementById('v2-command-dialog')?.close(); return; }
      if (event.target.closest('[data-v2-logout]')) return logout();
      if (event.target.closest('#v2-cmd-trigger')) return openCommandPalette();
      if (event.target.closest('[data-v2-more]')) return document.getElementById('v2-mobile-menu')?.classList.toggle('active');
      const actionView = event.target.closest('[data-v2-action-view]');
      if (actionView) { const tool = actionView.dataset.v2ActionTool; if (tool) state.tool = tool; navigate(actionView.dataset.v2ActionView); document.getElementById('v2-command-dialog')?.close(); return; }
      const alert = event.target.closest('[data-v2-alert-view]');
      if (alert) { if (alert.dataset.v2AlertTool) state.tool = alert.dataset.v2AlertTool; navigate(alert.dataset.v2AlertView); return; }
      const player = event.target.closest('[data-v2-player-name]');
      if (player && !event.target.closest('[data-v2-churn-player]')) { document.getElementById('v2-command-dialog')?.close(); return openPlayerProfile(player.dataset.v2PlayerName, num(player.dataset.v2Player) || null); }
      const community = event.target.closest('[data-v2-community-pane]');
      if (community) return switchCommunityPane(community.dataset.v2CommunityPane);
      const tool = event.target.closest('[data-v2-tool]');
      if (tool) return activateTool(tool.dataset.v2Tool);
      if (event.target.closest('[data-v2-refresh]')) return refreshActiveView();
      if (event.target.closest('[data-v2-compare]')) return showComparison();
      if (event.target.closest('[data-v2-filter-toggle]')) return document.getElementById('v2-player-toolbar')?.classList.toggle('filters-open');
      if (event.target.closest('[data-v2-audit-view]')) {
        state.auditTimeline = !state.auditTimeline;
        event.target.closest('[data-v2-audit-view]').classList.toggle('active', state.auditTimeline);
        return renderAuditLogs?.();
      }
      const step = event.target.closest('[data-v2-calendar-step]');
      if (step) { state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + num(step.dataset.v2CalendarStep), 1); return renderCalendar(); }
      const day = event.target.closest('[data-v2-calendar-day]');
      if (day) return showCalendarDay(day.dataset.v2CalendarDay);
      const retry = event.target.closest('[data-v2-retry-post]');
      if (retry) { await api(`/api/admin/scheduled-posts/${retry.dataset.v2RetryPost}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); showToast('Post reagendado.', 'success'); return renderCalendarTool(document.getElementById('v2-tools-body')); }
      const segment = event.target.closest('[data-v2-player-segment]');
      if (segment) return setPlayerSegment(segment.dataset.v2PlayerSegment);
      const playerView = event.target.closest('[data-v2-player-view]');
      if (playerView) { state.playerView = playerView.dataset.v2PlayerView; localStorage.setItem('fa_dashboard_player_view', state.playerView); return postProcessPlayerList(); }
      if (event.target.closest('[data-v2-bulk-clear]')) { state.selectedPlayers.clear(); document.querySelectorAll('.v2-select-box').forEach((box) => { box.checked = false; }); return updateBulkBar(); }
      if (event.target.closest('[data-v2-bulk-verify]')) return bulkVerify();
      if (event.target.closest('[data-v2-bulk-notify]')) return bulkNotify();
      if (event.target.closest('[data-v2-bulk-export]')) return exportSelectedPlayers();
      const modBulk = event.target.closest('[data-v2-mod-bulk]');
      if (modBulk) return bulkModeration(modBulk.dataset.v2ModBulk);
      const formatter = event.target.closest('[data-v2-format]');
      if (formatter) return formatNotification(formatter.dataset.v2Format);
      if (event.target.closest('[data-v2-save-template]')) return saveNotificationTemplate();
      const template = event.target.closest('[data-v2-template-id]');
      if (template) return applyTemplate(template);
      if (event.target.closest('[data-v2-save-settings]')) return saveSettings();
      const exportKind = event.target.closest('[data-v2-export-kind]');
      if (exportKind) return exportSettingsData(exportKind.dataset.v2ExportKind);
      const exportTool = event.target.closest('[data-v2-export-tool]');
      if (exportTool) return exportToolData(exportTool.dataset.v2ExportTool);
      if (event.target.closest('[data-v2-export-view]')) return exportCurrentView();
      const danger = event.target.closest('[data-v2-danger-action]');
      if (danger) return dangerAction(danger.dataset.v2DangerAction);
      const churn = event.target.closest('[data-v2-churn-player]');
      if (churn) { state.selectedPlayers = new Set([num(churn.dataset.v2ChurnPlayer)]); return bulkNotify(); }
      const quickNotify = event.target.closest('[data-v2-quick-notify]');
      if (quickNotify) { state.selectedPlayers = new Set([num(quickNotify.dataset.v2QuickNotify)]); document.getElementById('v2-command-dialog')?.close(); return bulkNotify(); }
    });

    document.addEventListener('change', (event) => {
      const filter = event.target.closest('[data-v2-player-filter]');
      if (filter) { state.playerFilters[filter.dataset.v2PlayerFilter] = filter.value; postProcessPlayerList(); }
      const comparison = event.target.closest('[data-v2-comparison-period]');
      if (comparison) {
        state.comparisonDays[comparison.dataset.v2ComparisonPeriod] = num(comparison.value);
        state.comparisonOpen = false;
        showComparison();
      }
      if (event.target.matches('[data-v2-audit-days]')) {
        auditDaysFilter = num(event.target.value);
        auditPage = 0;
        fetchAuditLogs?.();
      }
      if (event.target.id === 'v2-confidence') {
        const threshold = num(event.target.value);
        document.getElementById('v2-confidence-label').textContent = `${threshold}%`;
        document.querySelectorAll('#mod-list-ai .mod-item').forEach((item) => item.style.display = num(item.dataset.v2Confidence) >= threshold ? '' : 'none');
      }
      if (event.target.id === 'v2-server-compare') {
        renderUptimeTimeline(state.toolData.serverUptime || []);
        renderServerPresence();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.getElementById('v2-command-dialog')?.open) {
        document.getElementById('v2-command-dialog').close();
        return;
      }
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); openCommandPalette(); }
      if (/^[1-9]$/.test(event.key) && !/input|textarea|select/i.test(event.target.tagName)) {
        const view = availableViews()[num(event.key) - 1]?.view;
        if (view) navigate(view);
      }
    });
    window.addEventListener('popstate', (event) => navigate(event.state?.view || new URL(location.href).searchParams.get('v') || 'command', { replace: true }));
  }

  function patchExistingFunctions() {
    if (typeof window.loadExecutiveAnalytics === 'function') {
      const original = window.loadExecutiveAnalytics;
      window.loadExecutiveAnalytics = async function patchedExecutiveAnalytics(...args) {
        const result = await original.apply(this, args);
        renderCommandOverview();
        renderTopPosts();
        return result;
      };
    }
    if (typeof window.renderAdminTab === 'function') {
      const original = window.renderAdminTab;
      window.renderAdminTab = function patchedAdminTab(...args) {
        const result = original.apply(this, args);
        setTimeout(postProcessPlayerList, 0);
        return result;
      };
    }
    if (typeof window.renderAuditLogs === 'function') {
      const original = window.renderAuditLogs;
      window.renderAuditLogs = function patchedAuditLogs(...args) {
        const result = original.apply(this, args);
        if (state.auditTimeline) applyAuditTimeline().catch((error) => console.warn('[dashboard-v2 audit timeline]', error));
        return result;
      };
    }
    if (typeof window._modBuildAIItem === 'function') {
      const original = window._modBuildAIItem;
      window._modBuildAIItem = function patchedModerationItem(row) {
        return enhanceModerationItem(original.call(this, row), row);
      };
    }
    if (typeof window.openPlayerProfile === 'function') {
      const original = window.openPlayerProfile;
      window.openPlayerProfile = async function patchedPlayerProfile(name, id) {
        const result = await original.call(this, name, id);
        const userId = id || state.playerDirectory.find((user) => [user.minecraft_name,user.username].some((value) => String(value || '').toLowerCase() === String(name || '').toLowerCase()))?.id;
        if (userId) loadPlayerTimeline(userId);
        return result;
      };
    }
    window.submitAdminNotification = submitV2Notification;
    window.scrollToSection = (id) => navigate(VIEW_BY_ID[id] || id);
    window.navigate = navigate;
    window.openCmdPalette = openCommandPalette;
    window.setupChartDefaults = setupChartDefaults;
  }

  function updateBadges() {
    const moderation = num(document.getElementById('mod-nav-badge')?.textContent);
    const legacy = num(document.getElementById('legacy-nav-pending-badge')?.textContent);
    document.querySelectorAll('[data-v2-badge="moderation"]').forEach((badge) => { badge.textContent = moderation; badge.hidden = !moderation; });
    document.querySelectorAll('[data-v2-badge="legacy"]').forEach((badge) => { badge.textContent = legacy; badge.hidden = !legacy; });
  }

  function boot() {
    createV2Modules();
    buildSidebar();
    buildTopbar();
    buildMobileNavigation();
    buildCommandPalette();
    setupCommunityTabs();
    injectPlayerToolbar();
    injectMeritOverview();
    injectNotificationWorkspace();
    injectServerIntelligence();
    injectModerationEnhancements();
    injectAuditOverview();
    patchExistingFunctions();
    bindEvents();
    setupChartDefaults();
    setupSwipeToClose();
    setupPullToRefresh();
    lazyImages();
    refreshIcons();
    const initial = new URL(location.href).searchParams.get('v') || VIEW_BY_ID[new URL(location.href).searchParams.get('module')] || 'command';
    navigate(initial, { replace: true });
    setInterval(() => { updateBadges(); lazyImages(); if (state.view === 'command') renderCommandOverview(); if (state.view === 'server') renderServerFeed(); }, 3000);
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.view === 'server') { loadData?.(); loadServerIntelligence(); }
      if (state.view === 'command' || state.view === 'analytics') loadExecutiveAnalytics?.(true);
    }, 30000);
    new MutationObserver(() => setupChartDefaults()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0), { once: true });
  else setTimeout(boot, 0);
})();
