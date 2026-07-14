(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const themeMeta = qs('meta[name="theme-color"]');
  const mobileBreakpoint = window.matchMedia('(max-width: 900px)');
  let moreHistoryEntry = false;
  let onlineTimer = 0;
  let updateFrame = 0;

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
        const input = qs('#v2-player-toolbar input[type="search"], #v2-player-toolbar input');
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
    if (themeMeta) themeMeta.content = dark ? '#111511' : '#fffefa';
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
    localStorage.setItem('fa_theme', next);
    document.documentElement.setAttribute('data-theme', next);
    document.dispatchEvent(new CustomEvent('staff:theme-change', { detail: { theme: next } }));
  }

  function syncCharts() {
    if (!window.Chart) return;
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue('--staff-muted').trim();
    const line = styles.getPropertyValue('--staff-line').trim();
    const surface = styles.getPropertyValue('--staff-surface-raised').trim();
    const strong = styles.getPropertyValue('--staff-ink').trim();
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
        chart.update('none');
      } catch (_) { /* A chart can be between construction and first layout. */ }
    });
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

  function updateConnectionState(announce = true) {
    const online = navigator.onLine;
    const banner = qs('#v4-connection-banner');
    document.body.classList.toggle('v4-offline', !online);
    document.body.classList.remove('v4-online-confirmed');
    if (banner) banner.textContent = online
      ? 'Conexão restabelecida. Os dados podem ser atualizados.'
      : 'Offline · consulta preservada; alterações críticas estão bloqueadas.';

    const critical = '[data-staff-add-access],[data-staff-requeue],[data-v2-save-settings],[data-v2-mod-bulk],[data-v2-danger-action],.merit-submit-btn';
    if (!online) {
      qsa(critical).forEach(control => {
        if (control.disabled) return;
        control.disabled = true;
        control.dataset.v4OfflineDisabled = '1';
        control.setAttribute('aria-description', 'Indisponível enquanto o dispositivo está offline.');
      });
    } else {
      qsa('[data-v4-offline-disabled]').forEach(control => {
        control.disabled = false;
        delete control.dataset.v4OfflineDisabled;
        control.removeAttribute('aria-description');
      });
      if (announce) {
        document.body.classList.add('v4-online-confirmed');
        clearTimeout(onlineTimer);
        onlineTimer = setTimeout(() => document.body.classList.remove('v4-online-confirmed'), 2400);
      }
    }
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

      const existing = qsa(':scope > [data-v2-view]', menu);
      const byView = new Map(existing.map(button => [button.dataset.v2View, button]));
      menu.textContent = '';

      const head = document.createElement('header');
      head.className = 'v4-more-head';
      head.innerHTML = `<div><h2 id="v4-more-title">Mais ferramentas</h2><p>Acesso rápido sem perder o contexto atual.</p></div><button class="v4-more-close" type="button" data-v4-more-close aria-label="Fechar">×</button>`;
      menu.appendChild(head);

      const groups = [
        ['Operação e comunidade', ['access', 'merit', 'notifications']],
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

  function setMoreOpen(open, { fromHistory = false, pushHistory = true } = {}) {
    const menu = qs('#v2-mobile-menu');
    const trigger = qs('[data-v2-more]');
    if (!menu || !trigger) return;
    menu.classList.toggle('active', open);
    menu.setAttribute('aria-hidden', String(!open));
    trigger.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('v4-more-open', open);

    if (open) {
      if (pushHistory && !moreHistoryEntry) {
        history.pushState({ ...(history.state || {}), v4More: true }, '', location.href);
        moreHistoryEntry = true;
      }
      setTimeout(() => qs('[data-v4-more-close]', menu)?.focus(), 50);
    } else {
      if (moreHistoryEntry && !fromHistory) history.back();
      moreHistoryEntry = false;
      if (!fromHistory) trigger.focus({ preventScroll: true });
    }
  }

  function pendingCount() {
    const number = selector => Number(String(qs(selector)?.textContent || '0').replace(/\D/g, '')) || 0;
    const operationalQueue = qsa('.staff-signal').find(card => /fila operacional/i.test(qs('.v2-label', card)?.textContent || ''));
    const consolidated = Number(String(qs('.v2-north-value', operationalQueue)?.textContent || '0').replace(/\D/g, '')) || 0;
    if (consolidated) return consolidated;
    const moderationCard = qsa('#moderation-card .v2-kpi-card').find(card => /pendentes/i.test(qs('.v2-kpi-label', card)?.textContent || ''));
    const moderation = Number(String(qs('.v2-kpi-value', moderationCard)?.textContent || '0').replace(/\D/g, '')) || number('#mod-nav-badge');
    return moderation + number('#legacy-nav-pending-badge') + number('#staff-access-queued');
  }

  function updatePendingBadge() {
    const button = qs('#v2-mobile-nav [data-v2-view="moderation"]');
    const badge = qs('[data-v2-badge="moderation"]', button);
    if (!button || !badge) return;
    const total = pendingCount();
    const display = total > 9 ? '9+' : String(total);
    if (badge.textContent !== display) badge.textContent = display;
    if (badge.hidden !== (total === 0)) badge.hidden = total === 0;
    button.setAttribute('aria-label', total ? `Pendências, ${total} itens exigem atenção` : 'Pendências, nenhuma ação no momento');
  }

  function updateActiveChrome() {
    const view = currentView();
    const title = qs('#portal-active-title')?.textContent?.trim() || 'FA Staff';
    const mobileTitle = qs('#v4-mobile-title');
    if (mobileTitle && mobileTitle.textContent !== title) mobileTitle.textContent = title;

    const quick = qs('#v4-quick-action');
    const config = quickActions[view];
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
      if (!navigator.onLine) updateConnectionState(false);
    });
  }

  function bindInteractions() {
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
        setTimeout(() => setMoreOpen(qs('#v2-mobile-menu')?.classList.contains('active'), { pushHistory: true }), 0);
        return;
      }
      const menuView = event.target.closest('#v2-mobile-menu [data-v2-view]');
      if (menuView) setMoreOpen(false, { fromHistory: true, pushHistory: false });
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
    window.addEventListener('online', () => updateConnectionState(true));
    window.addEventListener('offline', () => updateConnectionState(true));
    mobileBreakpoint.addEventListener?.('change', () => {
      if (!mobileBreakpoint.matches && qs('#v2-mobile-menu.active')) setMoreOpen(false, { fromHistory: true, pushHistory: false });
      updateActiveChrome();
    });

    const content = qs('.dashboard-content');
    content?.addEventListener('scroll', () => document.body.classList.toggle('v4-scrolled', content.scrollTop > 20), { passive: true });
    window.visualViewport?.addEventListener('resize', () => {
      document.documentElement.style.setProperty('--staff-visual-height', `${window.visualViewport.height}px`);
    }, { passive: true });
  }

  function observeInterface() {
    new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.type === 'attributes' && mutation.target === document.documentElement)) applyThemeVisuals();
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
    addHeaderEnhancements();
    addStatusElements();
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
    setInterval(updatePendingBadge, 3200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 140), { once: true });
  else setTimeout(boot, 140);
})();
