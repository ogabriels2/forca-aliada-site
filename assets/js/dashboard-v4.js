(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const themeMeta = qs('meta[name="theme-color"]');
  const mobileBreakpoint = window.matchMedia('(max-width: 900px)');
  const primaryMobileViews = new Set(['command', 'moderation', 'social', 'server']);
  const mutatingSelector = [
    '[data-staff-add-access]', '[data-staff-requeue]', '[data-v2-save-settings]',
    '[data-v2-mod-bulk]', '[data-v2-danger-action]', '[data-v2-bulk-verify]',
    '[data-v2-export-kind]', '[data-v2-bulk-export]',
    '[data-v2-bulk-notify]', '[data-v2-retry-post]', '[data-v2-save-template]',
    '[data-v2-quick-notify]', '[data-v2-churn-player]', '.merit-submit-btn',
    '#notif-submit-btn', '#btn-create-account', '#confirm-pw-submit-btn',
    '[data-notification-read]', '#lp-save-btn', '[data-legacy-delete-id]',
    '[data-legacy-action="approve"]', '[data-legacy-action="confirm-reject"]',
  ].join(',');
  let moreHistoryEntry = false;
  let moreReturnFocus = null;
  let onlineTimer = 0;
  let updateFrame = 0;
  let themeSaveRevision = 0;
  let queuedThemePreference = null;
  let themeWriteRun = null;
  const observerMode = () => typeof isObserverSession === 'function' ? isObserverSession() : (typeof session !== 'undefined' && session?.role === 'observer');

  const quickActions = {
    command: { label: 'Buscar', icon: 'search', run: () => qs('#v2-cmd-trigger')?.click() },
    moderation: {
      label: 'Primeiro caso', icon: 'shield-alert', run: () => {
        const item = qs('#moderation-card .mod-item:not([hidden])');
        if (item) item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else window.navigate?.('moderation');
      },
    },
    players: {
      label: 'Buscar', icon: 'user-search', run: () => {
        const input = qs('#admin-search') || qs('#v2-player-toolbar input[type="search"], #v2-player-toolbar input');
        input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => input?.focus(), 260);
      },
    },
    server: { label: 'Atualizar', icon: 'refresh-cw', run: () => qs('#server-overview [data-v2-refresh], [data-v2-refresh]')?.click() },
    access: { label: 'Adicionar', icon: 'key-round', run: () => qs('[data-staff-add-access]')?.click() },
    merit: {
      label: 'Registrar', icon: 'landmark', run: () => {
        const input = qs('#merit-card input:not([type="hidden"]), #merit-card select');
        input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => input?.focus(), 260);
      },
    },
    notifications: {
      label: 'Criar aviso', icon: 'message-square-plus', run: () => {
        const input = qs('#admin-notifications-card input[type="text"], #admin-notifications-card textarea');
        input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => input?.focus(), 260);
      },
    },
    audit: { label: 'Atualizar', icon: 'refresh-cw', run: () => qs('#audit-card [data-v2-refresh], [data-v2-refresh]')?.click() },
  };

  function refreshIcons() {
    requestAnimationFrame(() => window.lucide?.createIcons?.());
  }

  function currentView() {
    return qs('.v2-mobile-item.active[data-v2-view]')?.dataset.v2View
      || qs('.sidebar-profile .v2-nav-item.active[data-v2-view]')?.dataset.v2View
      || new URL(location.href).searchParams.get('v')
      || 'command';
  }

  function applyThemeVisuals() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const styles = getComputedStyle(document.documentElement);
    if (themeMeta) themeMeta.content = (dark ? styles.getPropertyValue('--staff-surface') : styles.getPropertyValue('--staff-canvas')).trim() || (dark ? '#111511' : '#f5f6f2');
    qsa('[data-v4-theme-toggle]').forEach(button => {
      button.innerHTML = dark ? `${icon('sun')}<span class="v4-theme-label">Usar modo claro</span>` : `${icon('moon')}<span class="v4-theme-label">Usar modo escuro</span>`;
      button.setAttribute('aria-label', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
      button.setAttribute('title', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
      button.setAttribute('aria-pressed', String(dark));
    });
    syncCharts();
    refreshIcons();
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fa_theme_revision', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    localStorage.setItem('fa_theme', next);
    localStorage.setItem('fa_theme_pending', next);
    document.documentElement.setAttribute('data-theme', next);
    document.dispatchEvent(new CustomEvent('staff:theme-change', { detail: { theme: next } }));
    persistThemePreference(next);
  }

  function persistThemePreference(theme) {
    if (!['light', 'dark'].includes(theme)) return Promise.resolve();
    queuedThemePreference = theme;
    if (themeWriteRun) return themeWriteRun;

    themeWriteRun = (async () => {
      while (queuedThemePreference) {
        const desiredTheme = queuedThemePreference;
        queuedThemePreference = null;
        const revision = ++themeSaveRevision;
        const localRevision = localStorage.getItem('fa_theme_revision') || '';
        const authToken = localStorage.getItem('fa_token');
        if (!authToken || observerMode() || (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW)) {
          if (!queuedThemePreference && localStorage.getItem('fa_theme_pending') === desiredTheme) {
            localStorage.removeItem('fa_theme_pending');
          }
          continue;
        }
        if (!navigator.onLine) break;
        try {
          const response = await apiFetch('/api/me/preferences', {
            method: 'PUT',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: desiredTheme }),
          });
          if (!response.ok) throw new Error(`Prefer\u00eancia n\u00e3o salva (${response.status}).`);
          if (!queuedThemePreference
            && revision === themeSaveRevision
            && (localStorage.getItem('fa_theme_revision') || '') === localRevision
            && localStorage.getItem('fa_theme') === desiredTheme
            && localStorage.getItem('fa_theme_pending') === desiredTheme) {
            localStorage.removeItem('fa_theme_pending');
          }
        } catch (error) {
          console.warn('[staff theme preference]', error);
        }
      }
    })().finally(() => {
      themeWriteRun = null;
      if (queuedThemePreference && navigator.onLine) persistThemePreference(queuedThemePreference);
    });
    return themeWriteRun;
  }

  function syncCharts() {
    if (!window.Chart) return;
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue('--staff-muted').trim();
    const line = styles.getPropertyValue('--staff-line').trim();
    const surface = styles.getPropertyValue('--staff-surface-raised').trim();
    const strong = styles.getPropertyValue('--staff-ink').trim();
    const chartTones = {
      '#0071e3': styles.getPropertyValue('--staff-blue').trim(),
      '#0a84ff': styles.getPropertyValue('--staff-blue').trim(),
      '#64d2ff': styles.getPropertyValue('--staff-blue').trim(),
      '#34c759': styles.getPropertyValue('--staff-green').trim(),
      '#30d158': styles.getPropertyValue('--staff-green').trim(),
      '#ffd60a': styles.getPropertyValue('--staff-gold').trim(),
      '#ff9f0a': styles.getPropertyValue('--staff-gold').trim(),
      '#ff3b30': styles.getPropertyValue('--staff-red').trim(),
      '#ff453a': styles.getPropertyValue('--staff-red').trim(),
      '#af52de': styles.getPropertyValue('--staff-purple').trim(),
    };
    const semanticTone = value => typeof value === 'string' ? (chartTones[value.toLowerCase()] || value) : value;
    Chart.defaults.color = ink;
    Chart.defaults.borderColor = line;
    Chart.defaults.font.family = styles.getPropertyValue('--ff').trim() || 'system-ui';
    Object.values(Chart.instances || {}).forEach(chart => {
      try {
        const options = chart.options || {};
        Object.values(options.scales || {}).forEach(scale => {
          if (scale.grid) { scale.grid.color = line; scale.grid.drawBorder = false; }
          if (scale.ticks) scale.ticks.color = ink;
          if (scale.title) scale.title.color = ink;
        });
        const legendLabels = options.plugins?.legend?.labels;
        if (legendLabels) {
          legendLabels.color = ink;
          legendLabels.usePointStyle = true;
          legendLabels.boxWidth = 8;
          legendLabels.boxHeight = 8;
        }
        const tooltip = options.plugins?.tooltip;
        if (tooltip) {
          tooltip.backgroundColor = surface;
          tooltip.borderColor = line;
          tooltip.borderWidth = 1;
          tooltip.titleColor = strong;
          tooltip.bodyColor = ink;
          tooltip.padding = 12;
          tooltip.cornerRadius = 12;
        }
        (chart.data?.datasets || []).forEach(dataset => {
          if (Array.isArray(dataset.borderColor)) dataset.borderColor = dataset.borderColor.map(semanticTone);
          else dataset.borderColor = semanticTone(dataset.borderColor);
          if (Array.isArray(dataset.backgroundColor)) dataset.backgroundColor = dataset.backgroundColor.map(semanticTone);
          else dataset.backgroundColor = semanticTone(dataset.backgroundColor);
          if (dataset.pointBorderColor === '#fff' || dataset.pointBorderColor === '#ffffff') dataset.pointBorderColor = surface;
        });
        chart.update('none');
      } catch (_) { /* A chart can be between construction and first layout. */ }
    });
  }

  window.faStaffSyncCharts = syncCharts;

  let chartResizeTimer = 0;
  function resizeChartsAfterLayout() {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      Object.values(window.Chart?.instances || {}).forEach(chart => {
        try { chart.resize(); } catch (_) { /* chart may be disposing */ }
      });
    })), 90);
  }

  function addHeaderEnhancements() {
    const header = qs('body > header');
    const actions = qs('.header-actions', header);
    if (!header || !actions || qs('#v4-theme-toggle')) return;

    const mobileTitle = document.createElement('div');
    mobileTitle.id = 'v4-mobile-title';
    mobileTitle.className = 'v4-mobile-title';
    mobileTitle.setAttribute('aria-hidden', 'true');
    mobileTitle.textContent = qs('#portal-active-title')?.textContent || 'FA Staff';
    header.insertBefore(mobileTitle, qs('#v2-cmd-trigger') || actions);

    const themeButton = document.createElement('button');
    themeButton.id = 'v4-theme-toggle';
    themeButton.className = 'v4-theme-toggle';
    themeButton.type = 'button';
    themeButton.dataset.v4ThemeToggle = '1';
    actions.insertBefore(themeButton, actions.firstElementChild);
    applyThemeVisuals();
  }

  function addStatusElements() {
    if (!qs('#v4-observer-banner')) {
      const observerBanner = document.createElement('aside');
      observerBanner.id = 'v4-observer-banner';
      observerBanner.className = 'v4-observer-banner';
      observerBanner.innerHTML = `${icon('eye')}<div><strong>Modo observador</strong><span>Consulta somente leitura · alterações e exportações estão bloqueadas.</span></div>`;
      observerBanner.setAttribute('role', 'status');
      document.body.appendChild(observerBanner);
    }
    if (!qs('#v4-connection-banner')) {
      const banner = document.createElement('div');
      banner.id = 'v4-connection-banner';
      banner.className = 'v4-connection-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      document.body.appendChild(banner);
    }
    if (!qs('#v4-pull-indicator')) {
      const indicator = document.createElement('div');
      indicator.id = 'v4-pull-indicator';
      indicator.className = 'v4-pull-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.textContent = 'Solte para atualizar';
      document.body.appendChild(indicator);
    }
    updateConnectionState(false);
  }

  function isInlineMutation(element) {
    const handler = element?.getAttribute?.('onclick') || '';
    return /(?:mark(?:All)?NotifRead|submitAdminNotification|generateAppKey|revokeAppKey|saveAdminUser|executeAdminDelete|submitCreateAccount|submitModal(?:Merit|Capital)|submit(?:GrantMerit|AdjustCapital)|addPlayerNote|deletePlayerNote|togglePlatformVerified|resendAdminNotification|modAction(?:AI|Report)|legacyAdmin(?:SavePreset|DeletePreset|Approve|ConfirmReject)|confirmPwSubmit)/i.test(handler);
  }

  function mutationControl(target) {
    const explicit = target?.closest?.(mutatingSelector);
    if (explicit) return explicit;
    const inline = target?.closest?.('[onclick]');
    return isInlineMutation(inline) ? inline : null;
  }

  function mutationControls() {
    const controls = new Set(qsa(mutatingSelector));
    qsa('[onclick]').filter(isInlineMutation).forEach(control => controls.add(control));
    return [...controls];
  }

  function announceOfflineMutation() {
    const message = 'Esta altera\u00e7\u00e3o exige conex\u00e3o. Reconecte-se e tente novamente.';
    if (typeof showToast === 'function') showToast(message, 'warning');
    else {
      const banner = qs('#v4-connection-banner');
      if (banner) banner.textContent = message;
    }
  }

  function announceObserverMutation() {
    const message = 'Modo observador: nenhuma alteração administrativa é permitida.';
    if (typeof showToast === 'function') showToast(message, 'warning');
    else {
      const banner = qs('#v4-observer-banner');
      if (banner) banner.setAttribute('data-announcement', message);
    }
  }

  function updateObserverState() {
    const active = observerMode();
    document.body.classList.toggle('staff-observer-mode', active);
    if (active) {
      mutationControls().forEach(control => {
        if (control.dataset.v4ObserverDisabled) return;
        if ('disabled' in control) control.disabled = true;
        else control.setAttribute('aria-disabled', 'true');
        control.dataset.v4ObserverDisabled = '1';
        control.setAttribute('aria-description', 'Indisponível no modo observador, que é somente leitura.');
      });
      qsa('#v2-settings-body input, #v2-settings-body select, #v2-settings-body textarea, #app-keys-card input, #legacy-migration-card input, #legacy-migration-card select, #legacy-migration-card textarea').forEach(field => {
        if (field.dataset.v4ObserverField) return;
        field.disabled = true;
        field.dataset.v4ObserverField = '1';
      });
      if (!document.body.dataset.v4ObserverMeritReady && typeof switchMeritTab === 'function') {
        document.body.dataset.v4ObserverMeritReady = '1';
        try { switchMeritTab('leaderboard'); } catch (_) { /* Module can still be loading. */ }
      }
    } else {
      qsa('[data-v4-observer-disabled]').forEach(control => {
        if ('disabled' in control) control.disabled = false;
        control.removeAttribute('aria-disabled');
        control.removeAttribute('aria-description');
        delete control.dataset.v4ObserverDisabled;
      });
      qsa('[data-v4-observer-field]').forEach(field => { field.disabled = false; delete field.dataset.v4ObserverField; });
      delete document.body.dataset.v4ObserverMeritReady;
    }
  }

  function installOfflineApiGuard() {
    const original = window.apiFetch;
    if (typeof original !== 'function' || original.__staffOfflineGuard) return;
    const guarded = function staffOfflineApiFetch(path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const administrativePath = /^\/api\/(?:admin(?:\/|$)|player\/[^/]+\/notes(?:\/|$))/i.test(String(path));
      if (observerMode() && administrativePath && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return Promise.reject(new Error('Modo observador: alterações administrativas estão bloqueadas.'));
      }
      if (!navigator.onLine && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return Promise.reject(new Error('Esta altera\u00e7\u00e3o exige conex\u00e3o. Reconecte-se e tente novamente.'));
      }
      return original.apply(this, arguments);
    };
    guarded.__staffOfflineGuard = true;
    guarded.__staffOfflineOriginal = original;
    window.apiFetch = guarded;
  }

  function updateConnectionState(announce = true) {
    const online = navigator.onLine;
    const banner = qs('#v4-connection-banner');
    document.body.classList.toggle('v4-offline', !online);
    document.body.classList.remove('v4-online-confirmed');
    if (banner) banner.textContent = online
      ? 'Conexão restabelecida. Os dados podem ser atualizados.'
      : 'Offline · consulta preservada; alterações críticas estão bloqueadas.';

    if (!online) {
      mutationControls().forEach(control => {
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return;
        if ('disabled' in control) control.disabled = true;
        else control.setAttribute('aria-disabled', 'true');
        control.dataset.v4OfflineDisabled = '1';
        control.setAttribute('aria-description', 'Indisponível enquanto o dispositivo está offline.');
      });
    } else {
      qsa('[data-v4-offline-disabled]').forEach(control => {
        if ('disabled' in control) control.disabled = false;
        control.removeAttribute('aria-disabled');
        delete control.dataset.v4OfflineDisabled;
        control.removeAttribute('aria-description');
      });
      if (announce) {
        document.body.classList.add('v4-online-confirmed');
        clearTimeout(onlineTimer);
        onlineTimer = setTimeout(() => document.body.classList.remove('v4-online-confirmed'), 2400);
      }
    }
    updateObserverState();
  }

  function enhanceMobileNavigation() {
    const nav = qs('#v2-mobile-nav');
    const menu = qs('#v2-mobile-menu');
    if (!nav || !menu) return false;

    const order = ['command', 'moderation', 'players', 'server'];
    order.forEach(view => {
      const button = qs(`[data-v2-view="${view}"]`, nav);
      if (button) nav.appendChild(button);
    });
    const more = qs('[data-v2-more]', nav);
    if (more) nav.appendChild(more);

    const pending = qs('[data-v2-view="moderation"]', nav);
    if (pending) {
      const label = qs('span', pending);
      if (label) label.textContent = 'Pendências';
      pending.setAttribute('title', 'Pendências operacionais');
    }

    if (!menu.dataset.v4Enhanced) {
      menu.dataset.v4Enhanced = '1';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-labelledby', 'v4-more-title');
      menu.setAttribute('aria-hidden', 'true');
      menu.inert = true;

      const existing = qsa(':scope > [data-v2-view]', menu);
      const byView = new Map(existing.map(button => [button.dataset.v2View, button]));
      menu.textContent = '';

      const head = document.createElement('header');
      head.className = 'v4-more-head';
      head.innerHTML = `<div><h2 id="v4-more-title">Mais ferramentas</h2><p>Acesso rápido sem perder o contexto atual.</p></div><button class="v4-more-close" type="button" data-v4-more-close aria-label="Fechar">×</button>`;
      menu.appendChild(head);

      const groups = [
        ['Operação e comunidade', ['players', 'access', 'merit', 'notifications']],
        ['Controle e rastreabilidade', ['audit', 'integrations', 'settings']],
        ['Análises e contexto', ['analytics', 'tools', 'legacy']],
      ];
      groups.forEach(([label, views]) => {
        const buttons = views.map(view => byView.get(view)).filter(Boolean);
        buttons.forEach(button => byView.delete(button.dataset.v2View));
        if (!buttons.length) return;
        const section = document.createElement('section');
        section.className = 'v4-more-section';
        section.innerHTML = `<h3>${label}</h3><div class="v4-more-grid"></div>`;
        buttons.forEach(button => qs('.v4-more-grid', section).appendChild(button));
        menu.appendChild(section);
      });
      if (byView.size) {
        const section = document.createElement('section');
        section.className = 'v4-more-section';
        section.innerHTML = '<h3>Outros</h3><div class="v4-more-grid"></div>';
        byView.forEach(button => qs('.v4-more-grid', section).appendChild(button));
        menu.appendChild(section);
      }

      const footer = document.createElement('footer');
      footer.className = 'v4-more-footer';
      footer.innerHTML = `<a href="account.html">${icon('user-round')} Minha conta</a><button type="button" data-v4-theme-toggle>${icon('moon')}<span class="v4-theme-label">Aparência</span></button>`;
      menu.appendChild(footer);

      const scrim = document.createElement('button');
      scrim.type = 'button';
      scrim.className = 'v4-sheet-scrim';
      scrim.dataset.v4MoreClose = '1';
      scrim.setAttribute('aria-label', 'Fechar menu de ferramentas');
      scrim.setAttribute('aria-hidden', 'true');
      scrim.tabIndex = -1;
      scrim.inert = true;
      document.body.insertBefore(scrim, menu);
    }

    if (!qs('#v4-quick-action')) {
      const button = document.createElement('button');
      button.id = 'v4-quick-action';
      button.className = 'v4-quick-action';
      button.type = 'button';
      button.dataset.v4QuickAction = '1';
      document.body.appendChild(button);
    }
    updateActiveChrome();
    applyThemeVisuals();
    return true;
  }

  function setBackgroundInert(open) {
    qsa('body > header, body > .main-content').forEach(element => {
      if (open) {
        if (element.inert) return;
        element.dataset.v4MoreInert = '1';
        element.inert = true;
      } else if (element.dataset.v4MoreInert) {
        element.inert = false;
        delete element.dataset.v4MoreInert;
      }
    });
  }

  function setMoreOpen(open, { fromHistory = false, pushHistory = true, consumeHistory = false, returnFocus = true } = {}) {
    const menu = qs('#v2-mobile-menu');
    const trigger = qs('[data-v2-more]');
    if (!menu || !trigger) return;
    const scrim = qs('.v4-sheet-scrim');
    const wasOpen = menu.classList.contains('active');
    if (open && !wasOpen) moreReturnFocus = document.activeElement;
    menu.classList.toggle('active', open);
    menu.setAttribute('aria-hidden', String(!open));
    menu.inert = !open;
    trigger.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('v4-more-open', open);
    if (scrim) {
      scrim.inert = !open;
      scrim.setAttribute('aria-hidden', String(!open));
    }
    setBackgroundInert(open);

    if (open) {
      if (pushHistory && !moreHistoryEntry) {
        history.pushState({ ...(history.state || {}), v4More: true }, '', location.href);
        moreHistoryEntry = true;
      }
      setTimeout(() => qs('[data-v4-more-close]', menu)?.focus(), 50);
    } else {
      if (moreHistoryEntry && consumeHistory) {
        const nextState = { ...(history.state || {}) };
        delete nextState.v4More;
        history.replaceState(nextState, '', location.href);
      } else if (moreHistoryEntry && !fromHistory) history.back();
      moreHistoryEntry = false;
      if (returnFocus && !fromHistory) {
        const target = moreReturnFocus instanceof HTMLElement && moreReturnFocus.isConnected ? moreReturnFocus : trigger;
        target.focus({ preventScroll: true });
      }
      moreReturnFocus = null;
    }
    updateActiveChrome();
  }

  window.staffMobileMenu = {
    open: () => setMoreOpen(true),
    close: options => setMoreOpen(false, options),
    toggle: () => setMoreOpen(!qs('#v2-mobile-menu')?.classList.contains('active')),
    isOpen: () => Boolean(qs('#v2-mobile-menu')?.classList.contains('active')),
  };

  function updatePendingBadge() {
    const button = qs('#v2-mobile-nav [data-v2-view="moderation"]');
    if (!button) return;
    const total = Number(String(qs('#mod-nav-badge')?.textContent || '0').replace(/\D/g, '')) || 0;
    const display = total > 9 ? '9+' : String(total);
    qsa('[data-v2-badge="moderation"]').forEach(badge => {
      if (badge.textContent !== display) badge.textContent = display;
      if (badge.hidden !== (total === 0)) badge.hidden = total === 0;
    });
    button.setAttribute('aria-label', total ? `Pendências de moderação, ${total} casos` : 'Pendências de moderação, nenhuma no momento');
  }

  function updateActiveChrome() {
    const view = currentView();
    const title = qs('#portal-active-title')?.textContent?.trim() || 'FA Staff';
    const mobileTitle = qs('#v4-mobile-title');
    if (mobileTitle && mobileTitle.textContent !== title) mobileTitle.textContent = title;
    const more = qs('#v2-mobile-nav [data-v2-more]');
    if (more) {
      const secondaryRoute = !primaryMobileViews.has(view);
      const open = Boolean(qs('#v2-mobile-menu.active'));
      more.classList.toggle('active', secondaryRoute || open);
      if (secondaryRoute) more.setAttribute('aria-current', 'page');
      else more.removeAttribute('aria-current');
    }

    const quick = qs('#v4-quick-action');
    const config = observerMode() && ['access', 'merit', 'notifications'].includes(view) ? null : quickActions[view];
    if (quick) {
      if (quick.hidden !== !config) quick.hidden = !config;
      if (config) {
        const needsRender = quick.dataset.v4ActionView !== view || qs('span', quick)?.textContent !== config.label;
        quick.dataset.v4ActionView = view;
        if (needsRender) quick.innerHTML = `${icon(config.icon)}<span>${config.label}</span>`;
        quick.setAttribute('aria-label', `${config.label} em ${title}`);
      }
    }
    updatePendingBadge();
    refreshIcons();
  }

  function scheduleChromeUpdate() {
    if (updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      updateActiveChrome();
      updateObserverState();
      if (!navigator.onLine) updateConnectionState(false);
    });
  }

  function syncVisualViewport() {
    const viewport = window.visualViewport;
    const height = Math.max(320, Math.round(viewport?.height || window.innerHeight));
    const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
    document.documentElement.style.setProperty('--staff-visual-height', `${height}px`);
    document.documentElement.style.setProperty('--staff-visual-offset-top', `${offsetTop}px`);
    qs('.main-content')?.style.setProperty('height', 'var(--staff-visual-height)', 'important');
    qs('.dashboard-layout')?.style.setProperty('height', 'calc(var(--staff-visual-height) - var(--staff-header-h))', 'important');
    qs('.dashboard-content')?.style.setProperty('height', 'calc(var(--staff-visual-height) - var(--staff-header-h))', 'important');
  }

  function bindInteractions() {
    document.addEventListener('click', event => {
      if (observerMode() && mutationControl(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        announceObserverMutation();
        return;
      }
      if (!navigator.onLine && mutationControl(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        announceOfflineMutation();
        return;
      }
      const bottomDestination = event.target.closest('#v2-mobile-nav [data-v2-view], #v2-mobile-menu [data-v2-view]');
      if (bottomDestination && qs('#v2-mobile-menu.active')) {
        setMoreOpen(false, { consumeHistory: true, returnFocus: false });
      }
    }, true);
    document.addEventListener('submit', event => {
      const submitter = event.submitter || qs('button[type="submit"],input[type="submit"]', event.target);
      const mutationForm = event.target.matches?.('#staff-action-form,.admin-notification-form');
      if (observerMode() && (mutationForm || mutationControl(submitter))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        announceObserverMutation();
        return;
      }
      if (navigator.onLine || (!mutationForm && !mutationControl(submitter))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      announceOfflineMutation();
    }, true);

    document.addEventListener('click', event => {
      const themeButton = event.target.closest('[data-v4-theme-toggle]');
      if (themeButton) {
        event.preventDefault();
        toggleTheme();
        return;
      }
      if (event.target.closest('[data-v4-more-close]')) {
        event.preventDefault();
        setMoreOpen(false);
        return;
      }
      const more = event.target.closest('[data-v2-more]');
      if (more) {
        event.preventDefault();
        window.staffMobileMenu.toggle();
        return;
      }
      const quick = event.target.closest('[data-v4-quick-action]');
      if (quick) quickActions[quick.dataset.v4ActionView]?.run();
    });

    document.addEventListener('keydown', event => {
      const menu = qs('#v2-mobile-menu.active');
      if (!menu) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = qsa('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])', menu).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    window.addEventListener('popstate', () => {
      if (qs('#v2-mobile-menu.active')) setMoreOpen(false, { fromHistory: true, pushHistory: false });
    });
    window.addEventListener('online', () => {
      updateConnectionState(true);
      const pendingTheme = localStorage.getItem('fa_theme_pending');
      if (pendingTheme) persistThemePreference(pendingTheme);
    });
    window.addEventListener('offline', () => updateConnectionState(true));
    window.addEventListener('storage', event => {
      if (event.key !== 'fa_theme' || !['light', 'dark', 'auto'].includes(event.newValue)) return;
      const next = event.newValue === 'auto'
        ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : event.newValue;
      document.documentElement.setAttribute('data-theme', next);
    });
    mobileBreakpoint.addEventListener?.('change', () => {
      if (!mobileBreakpoint.matches && qs('#v2-mobile-menu.active')) setMoreOpen(false, { consumeHistory: true, returnFocus: false });
      updateActiveChrome();
      resizeChartsAfterLayout();
    });
    document.addEventListener('staff:navigation-rebuilt', () => {
      moreHistoryEntry = false;
      moreReturnFocus = null;
      enhanceMobileNavigation();
      updateConnectionState(false);
    });

    const content = qs('.dashboard-content');
    content?.addEventListener('scroll', () => document.body.classList.toggle('v4-scrolled', content.scrollTop > 20), { passive: true });
    window.visualViewport?.addEventListener('resize', () => { syncVisualViewport(); resizeChartsAfterLayout(); }, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
    window.addEventListener('resize', () => { syncVisualViewport(); resizeChartsAfterLayout(); }, { passive: true });
    window.addEventListener('orientationchange', () => { syncVisualViewport(); resizeChartsAfterLayout(); }, { passive: true });
    syncVisualViewport();
  }

  function observeInterface() {
    new MutationObserver(mutations => {
      if (!mutations.some(mutation => mutation.type === 'attributes' && mutation.target === document.documentElement)) return;
      const pendingTheme = localStorage.getItem('fa_theme_pending');
      if ((pendingTheme === 'light' || pendingTheme === 'dark') && document.documentElement.getAttribute('data-theme') !== pendingTheme) {
        document.documentElement.setAttribute('data-theme', pendingTheme);
        return;
      }
      applyThemeVisuals();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    new MutationObserver(scheduleChromeUpdate).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden'],
    });
  }

  function boot() {
    installOfflineApiGuard();
    const pendingTheme = localStorage.getItem('fa_theme_pending');
    if (pendingTheme === 'light' || pendingTheme === 'dark') {
      localStorage.setItem('fa_theme', pendingTheme);
      document.documentElement.setAttribute('data-theme', pendingTheme);
      persistThemePreference(pendingTheme);
    }
    addHeaderEnhancements();
    addStatusElements();
    updateObserverState();
    bindInteractions();
    observeInterface();

    let attempts = 0;
    const waitForNavigation = setInterval(() => {
      attempts += 1;
      if (enhanceMobileNavigation() || attempts > 30) clearInterval(waitForNavigation);
    }, 100);

    setTimeout(() => {
      enhanceMobileNavigation();
      updateActiveChrome();
      applyThemeVisuals();
      updateConnectionState(false);
    }, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 140), { once: true });
  else setTimeout(boot, 140);
})();
