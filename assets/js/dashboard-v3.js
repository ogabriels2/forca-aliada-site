(() => {
  'use strict';

  const state = {
    access: null,
    accessFilter: 'queued',
    accessSearch: '',
    accessLoading: false,
    auditTimer: 0,
    settingsDirty: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const tokenValue = () => typeof token !== 'undefined' ? token : localStorage.getItem('fa_token');
  const relativeTime = value => {
    if (!value) return 'Nunca conectado';
    const date = new Date(value);
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
    const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [size, unit] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
    return 'agora';
  };
  const dateTime = value => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

  async function adminApi(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (!navigator.onLine && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      throw new Error('Esta altera\u00e7\u00e3o exige conex\u00e3o. Reconecte-se e tente novamente.');
    }
    if (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW) return previewAdminApi(path, options);
    const response = await apiFetch(path, {
      ...options,
      headers: { Authorization: `Bearer ${tokenValue()}`, ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Não foi possível concluir a operação (${response.status}).`);
    return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

  function previewAdminApi(path) {
    const now = Date.now();
    if (path.includes('/api/admin/access/overview')) {
      return {
        summary: { awaiting_email: 7, awaiting_minecraft: 4, queued: 3, delivered: 12 },
        queue: [
          { id: 31, minecraft_name: 'LunaFA', username: 'luna', email: 'luna@example.com', queued_at: new Date(now - 18 * 60_000).toISOString(), delivered_at: null, delivered_by_name: null, retry_count: 0, status: 'queued' },
          { id: 30, minecraft_name: 'CaioCraft', username: 'caio', email: 'caio@example.com', queued_at: new Date(now - 52 * 60_000).toISOString(), delivered_at: null, delivered_by_name: null, retry_count: 0, status: 'queued' },
          { id: 29, minecraft_name: 'RafaBuilds', username: 'rafa', email: 'rafa@example.com', queued_at: new Date(now - 2.4 * 3600_000).toISOString(), delivered_at: null, delivered_by_name: null, retry_count: 1, status: 'queued' },
          { id: 28, minecraft_name: 'NinaRedstone', username: 'nina', email: 'nina@example.com', queued_at: new Date(now - 28 * 3600_000).toISOString(), delivered_at: new Date(now - 27.8 * 3600_000).toISOString(), delivered_by_name: 'Manager principal', retry_count: 0, status: 'delivered' },
        ],
        manager: { name: 'Manager principal', last_used_at: new Date(now - 43_000).toISOString() },
        delivery_note: 'Reservada significa que o endpoint entregou o item ao Manager; a aplicação no Minecraft ainda depende de uma confirmação futura.',
      };
    }
    if (path.includes('/api/admin/access/whitelist')) return { id: 32, already_queued: false };
    return { ok: true };
  }

  function ensureDialog() {
    let dialog = $('#staff-action-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'staff-action-dialog';
    dialog.className = 'staff-dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'staff-dialog-title');
    dialog.setAttribute('aria-describedby', 'staff-dialog-description');
    dialog.innerHTML = `
      <form id="staff-action-form" novalidate>
        <header class="staff-dialog-head">
          <div><h2 id="staff-dialog-title">Confirmar ação</h2><p id="staff-dialog-description"></p></div>
          <button class="staff-dialog-close" type="button" data-staff-dialog-cancel aria-label="Fechar">×</button>
        </header>
        <div class="staff-dialog-body" id="staff-dialog-body"></div>
        <footer class="staff-dialog-actions">
          <button class="staff-dialog-cancel" type="button" data-staff-dialog-cancel>Cancelar</button>
          <button class="staff-dialog-confirm" id="staff-dialog-confirm" type="submit">Confirmar</button>
        </footer>
      </form>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function openForm({ title, description = '', content = '', confirmLabel = 'Confirmar', danger = false, validate }) {
    const dialog = ensureDialog();
    const form = $('#staff-action-form', dialog);
    const body = $('#staff-dialog-body', dialog);
    const confirmButton = $('#staff-dialog-confirm', dialog);
    $('#staff-dialog-title', dialog).textContent = title;
    $('#staff-dialog-description', dialog).textContent = description;
    body.innerHTML = content;
    confirmButton.textContent = confirmLabel;
    confirmButton.classList.toggle('danger', danger);
    const returnFocus = document.activeElement;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        dialog.close();
        if (returnFocus instanceof HTMLElement) returnFocus.focus();
        resolve(value);
      };
      const cancel = () => finish(null);
      $$('[data-staff-dialog-cancel]', dialog).forEach(button => { button.onclick = cancel; });
      dialog.onclick = event => { if (event.target === dialog) cancel(); };
      dialog.oncancel = event => { event.preventDefault(); cancel(); };
      form.onsubmit = event => {
        event.preventDefault();
        const error = $('#staff-dialog-error', dialog);
        if (error) error.textContent = '';
        try {
          const result = validate ? validate(dialog) : {};
          if (result && typeof result.then === 'function') {
            confirmButton.disabled = true;
            result.then(value => finish(value)).catch(err => { if (error) error.textContent = err.message; }).finally(() => { confirmButton.disabled = false; });
          } else finish(result);
        } catch (err) {
          if (error) error.textContent = err.message;
        }
      };
      dialog.showModal();
      requestAnimationFrame(() => ($('input, textarea, select, button', body) || confirmButton).focus());
    });
  }

  const criticalMeta = {
    clear_reviewed_moderation: {
      title: 'Limpar decisões de moderação já revisadas',
      impact: 'Remove permanentemente da fila os registros já revisados. Conteúdos e eventos de auditoria não são restaurados por esta ação.',
    },
    delete_inactive_accounts: {
      title: 'Exportar e excluir contas inativas',
      impact: 'Gera uma exportação antes de excluir contas limitadas que não tiveram atividade no período escolhido. Relações dependentes podem ser afetadas.',
    },
    reset_merit: {
      title: 'Resetar todo o Mérito',
      impact: 'Define o Mérito de todos os jogadores como zero e recalcula todos os ranks para Ferro. Esta é uma operação sistêmica extrema.',
    },
  };

  window.staffDialog = {
    critical({ action, months = 12 }) {
      const meta = criticalMeta[action] || { title: 'Executar ação crítica', impact: 'Esta alteração afeta dados administrativos.' };
      const expected = action.toUpperCase();
      return openForm({
        title: meta.title,
        description: 'Revise o impacto, informe o motivo e digite a confirmação exata.',
        danger: true,
        confirmLabel: 'Executar ação crítica',
        content: `
          <div class="staff-dialog-impact"><strong>Impacto</strong><br>${esc(meta.impact)}</div>
          ${action === 'delete_inactive_accounts' ? `<div class="staff-dialog-field"><label for="staff-critical-months">Inatividade mínima em meses</label><input id="staff-critical-months" type="number" min="6" max="60" value="${Number(months) || 12}"></div>` : ''}
          <div class="staff-dialog-field"><label for="staff-critical-reason">Motivo obrigatório</label><textarea id="staff-critical-reason" maxlength="500" placeholder="Explique por que esta ação é necessária e qual validação foi feita."></textarea></div>
          <div class="staff-dialog-field"><label for="staff-critical-confirm">Digite ${esc(expected)}</label><input id="staff-critical-confirm" autocomplete="off" spellcheck="false"></div>
          <p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>`,
        validate: root => {
          const reason = $('#staff-critical-reason', root).value.trim();
          const confirmation = $('#staff-critical-confirm', root).value.trim();
          if (reason.length < 8) throw new Error('Descreva o motivo em pelo menos 8 caracteres.');
          if (confirmation !== expected) throw new Error(`Digite ${expected} exatamente como exibido.`);
          return { reason, confirmation, months: Number($('#staff-critical-months', root)?.value || months) };
        },
      });
    },
    notification({ count = 1 }) {
      return openForm({
        title: `Enviar aviso para ${count} ${count === 1 ? 'jogador' : 'jogadores'}`,
        description: 'A mensagem será criada individualmente para as contas selecionadas.',
        confirmLabel: 'Enviar aviso',
        content: `
          <div class="staff-dialog-field"><label for="staff-notify-title">Título</label><input id="staff-notify-title" maxlength="120" placeholder="Assunto do aviso"></div>
          <div class="staff-dialog-field"><label for="staff-notify-body">Mensagem</label><textarea id="staff-notify-body" maxlength="1200" placeholder="Escreva uma mensagem clara e acionável."></textarea></div>
          <p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>`,
        validate: root => {
          const title = $('#staff-notify-title', root).value.trim();
          const body = $('#staff-notify-body', root).value.trim();
          if (!title || !body) throw new Error('Título e mensagem são obrigatórios.');
          return { title, body };
        },
      });
    },
    moderation({ count = 1 }) {
      return openForm({
        title: `Remover ${count} ${count === 1 ? 'conteúdo' : 'conteúdos'}`,
        description: 'A IA apenas auxiliou a triagem. Confirme que o conteúdo foi revisado por uma pessoa.',
        danger: true,
        confirmLabel: 'Remover e registrar decisão',
        content: `
          <div class="staff-dialog-impact">A remoção pode apagar publicações ou limpar imagens de perfil. A decisão será registrada na Auditoria.</div>
          <div class="staff-dialog-field"><label for="staff-moderation-reason">Motivo da decisão</label><textarea id="staff-moderation-reason" maxlength="500" placeholder="Regra violada e contexto da revisão."></textarea></div>
          <p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>`,
        validate: root => {
          const reason = $('#staff-moderation-reason', root).value.trim();
          if (reason.length < 8) throw new Error('Informe um motivo com pelo menos 8 caracteres.');
          return { reason };
        },
      });
    },
    confirm({ title, description, confirmLabel = 'Confirmar', danger = false }) {
      return openForm({
        title,
        description,
        confirmLabel,
        danger,
        content: '<p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>',
        validate: () => true,
      });
    },
    text({ title, description = '', label = 'Notas internas', required = false }) {
      return openForm({
        title,
        description,
        confirmLabel: 'Continuar',
        content: `<div class="staff-dialog-field"><label for="staff-dialog-text">${esc(label)}</label><textarea id="staff-dialog-text" maxlength="500"></textarea></div><p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>`,
        validate: root => {
          const value = $('#staff-dialog-text', root).value.trim();
          if (required && !value) throw new Error('Este campo é obrigatório.');
          return value;
        },
      });
    },
    accessEntry() {
      return openForm({
        title: 'Adicionar à lista de acesso',
        description: 'Cria um envio para o Manager. Use apenas nicks válidos do Minecraft Java.',
        confirmLabel: 'Adicionar à fila',
        content: `
          <div class="staff-dialog-field"><label for="staff-access-name">Nick Minecraft Java</label><input id="staff-access-name" maxlength="16" autocomplete="off" placeholder="Ex.: Jogador_FA"></div>
          <div class="staff-dialog-field"><label for="staff-access-user">ID da conta no site (opcional)</label><input id="staff-access-user" type="number" min="1" placeholder="Vincula o envio a uma conta existente"></div>
          <div class="staff-dialog-impact">Depois de recebido, o estado será “Entregue ao Manager”. A aplicação no Minecraft ainda depende da execução feita pelo aplicativo.</div>
          <p class="staff-dialog-error" id="staff-dialog-error" role="alert"></p>`,
        validate: root => {
          const minecraft_name = $('#staff-access-name', root).value.trim();
          const user_id = Number($('#staff-access-user', root).value) || null;
          if (!/^[A-Za-z0-9_]{2,16}$/.test(minecraft_name)) throw new Error('Use de 2 a 16 letras, números ou _.');
          return { minecraft_name, user_id };
        },
      });
    },
  };

  function ensureAccessModule() {
    if ($('#dashboard-access')) return;
    const content = $('.dashboard-content');
    if (!content) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'dashboard-access';
    card.style.display = 'block';
    card.innerHTML = `
      <div class="staff-access-shell">
        <div class="staff-tool-head">
          <div><h2>Lista de acesso e onboarding</h2><p>Acompanhe desde a criação da conta até a entrega da whitelist ao Manager.</p></div>
          <div class="staff-tool-actions">
            ${typeof session !== 'undefined' && (session?.role === 'owner' || (session?.role === 'observer' && typeof canObserverView === 'function' && canObserverView('infrastructure'))) ? '<button class="v2-btn" type="button" data-staff-open-legacy>Migrações Legacy</button>' : ''}
            <button class="v2-btn primary" type="button" data-staff-add-access>Adicionar à fila</button>
          </div>
        </div>
        <div class="staff-access-summary" aria-label="Resumo do pipeline de acesso">
          <article class="staff-access-stat"><span>Aguarda e-mail</span><strong id="staff-access-email">—</strong><small>Contas ainda não verificadas</small></article>
          <article class="staff-access-stat"><span>Aguarda Minecraft</span><strong id="staff-access-minecraft">—</strong><small>Contas verificadas sem vínculo</small></article>
          <article class="staff-access-stat"><span>Na fila</span><strong id="staff-access-queued">—</strong><small>Aguardando coleta do Manager</small></article>
          <article class="staff-access-stat"><span>Reservadas</span><strong id="staff-access-delivered">—</strong><small>Separadas pelo endpoint do Manager</small></article>
        </div>
        <div class="staff-access-grid">
          <section class="staff-access-panel">
            <div class="staff-tool-head"><div><h3>Fila da whitelist</h3><p>Histórico de envios, destinatário e estado conhecido.</p></div><button class="v2-btn" type="button" data-staff-refresh-access>Atualizar</button></div>
            <div class="staff-access-filters">
              <input id="staff-access-search" type="search" placeholder="Buscar nick, usuário ou e-mail" aria-label="Buscar na fila de acesso">
              <select id="staff-access-filter" aria-label="Filtrar estado"><option value="queued">Na fila</option><option value="delivered">Entregues</option><option value="all">Todos</option></select>
            </div>
            <div class="staff-access-list" id="staff-access-list"><div class="staff-access-empty">Carregando a fila de acesso…</div></div>
          </section>
          <aside class="staff-access-panel">
            <div class="staff-tool-head"><div><h3>Integração Manager</h3><p>Último aplicativo que consumiu a fila.</p></div></div>
            <div class="staff-manager-state" id="staff-manager-state"><strong>Verificando conexão</strong><small>Aguardando dados da integração.</small></div>
            <div class="staff-honesty-note" id="staff-access-note">“Entregue” significa que o Manager recebeu o item. Não confirma, sozinho, que o comando foi aplicado no Minecraft.</div>
            <div class="staff-pipeline" aria-label="Etapas do acesso">
              <div class="staff-pipeline-step"><b>1</b> Conta e e-mail verificados</div>
              <div class="staff-pipeline-step"><b>2</b> Minecraft vinculado</div>
              <div class="staff-pipeline-step"><b>3</b> Entrada criada na fila</div>
              <div class="staff-pipeline-step"><b>4</b> Manager recebe o envio</div>
              <div class="staff-pipeline-step"><b>5</b> Confirmação no servidor — ainda não instrumentada</div>
            </div>
          </aside>
        </div>
      </div>`;
    const before = $('#admin-users-card', content);
    if (before) content.insertBefore(card, before);
    else content.appendChild(card);
    if (typeof DASHBOARD_MODULES !== 'undefined') {
      DASHBOARD_MODULES['dashboard-access'] = {
        title: 'Acesso',
        desc: 'Onboarding, lista de acesso, entrega ao Manager e migrações de identidade.',
      };
    }
  }

  function managerState(manager) {
    const serverState = typeof globalHealthData !== 'undefined' ? globalHealthData : null;
    if (serverState?.app_connected) {
      return { tone: 'live', label: 'Manager conectado', detail: `Heartbeat confirmado ${relativeTime(serverState.app_last_seen)}${manager?.name ? ` · chave ${manager.name}` : ''}` };
    }
    if (serverState?.app_last_seen) {
      const heartbeatAge = Date.now() - new Date(serverState.app_last_seen).getTime();
      return heartbeatAge <= 15 * 60_000
        ? { tone: 'delayed', label: 'Heartbeat atrasado', detail: `Último heartbeat ${relativeTime(serverState.app_last_seen)}` }
        : { tone: 'stale', label: 'Manager desconectado', detail: `Último heartbeat ${relativeTime(serverState.app_last_seen)}` };
    }
    if (!manager?.last_used_at) return { tone: 'stale', label: 'Sem uso registrado', detail: 'Nenhuma chave de integração reportou atividade.' };
    const age = Date.now() - new Date(manager.last_used_at).getTime();
    if (age <= 2 * 60_000) return { tone: 'live', label: 'Ativo recentemente', detail: `${manager.name} · último uso ${relativeTime(manager.last_used_at)}` };
    if (age <= 15 * 60_000) return { tone: 'delayed', label: 'Conexão atrasada', detail: `${manager.name} · último uso ${relativeTime(manager.last_used_at)}` };
    return { tone: 'stale', label: 'Conexão desatualizada', detail: `${manager.name} · último uso ${relativeTime(manager.last_used_at)}` };
  }

  function renderAccessRows() {
    const list = $('#staff-access-list');
    if (!list || !state.access) return;
    const query = state.accessSearch.toLocaleLowerCase('pt-BR');
    const rows = (state.access.queue || []).filter(row => {
      const stateMatch = state.accessFilter === 'all' || row.status === state.accessFilter;
      const searchMatch = !query || [row.minecraft_name, row.username, row.email, row.delivered_by_name].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query));
      return stateMatch && searchMatch;
    });
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'staff-access-empty';
      empty.textContent = state.accessFilter === 'queued' ? 'Nenhuma entrada aguardando o Manager. A fila está em dia.' : 'Nenhuma entrada corresponde aos filtros.';
      list.appendChild(empty);
      return;
    }
    rows.forEach(row => {
      const item = document.createElement('article');
      item.className = 'staff-access-row';
      const identity = document.createElement('div');
      const mc = document.createElement('strong');
      mc.textContent = row.minecraft_name;
      const account = document.createElement('small');
      account.textContent = row.username ? `${row.username} · ${row.email || 'sem e-mail'}` : 'Envio manual sem conta vinculada';
      identity.append(mc, account);
      const queued = document.createElement('div');
      queued.innerHTML = `<strong>Enfileirado</strong><small>${esc(dateTime(row.queued_at))}</small>`;
      const status = document.createElement('span');
      status.className = `staff-access-status ${row.status}`;
      status.textContent = row.status === 'queued' ? 'Na fila' : 'Reservada';
      const delivery = document.createElement('div');
      const deliveryTitle = document.createElement('strong');
      deliveryTitle.textContent = row.delivered_by_name || (row.status === 'delivered' ? 'Manager' : 'Aguardando');
      const deliveryTime = document.createElement('small');
      const retryLabel = Number(row.retry_count || 0) ? ` · ${row.retry_count} ${Number(row.retry_count) === 1 ? 'reenvio' : 'reenvios'}` : '';
      deliveryTime.textContent = `${row.delivered_at ? dateTime(row.delivered_at) : 'Ainda não coletado'}${retryLabel}`;
      delivery.append(deliveryTitle, deliveryTime);
      const action = document.createElement(row.status === 'queued' ? 'span' : 'button');
      if (row.status === 'queued') {
        action.className = 'staff-access-wait';
        action.textContent = 'Aguardando coleta';
      } else {
        action.type = 'button';
        action.className = 'v2-btn';
        action.dataset.staffRequeue = row.id;
        action.dataset.staffRequeueName = row.minecraft_name;
        action.textContent = 'Reenviar';
      }
      item.append(identity, queued, status, delivery, action);
      list.appendChild(item);
    });
  }

  function renderAccess(data) {
    state.access = data;
    const summary = data.summary || {};
    $('#staff-access-email').textContent = Number(summary.awaiting_email || 0).toLocaleString('pt-BR');
    $('#staff-access-minecraft').textContent = Number(summary.awaiting_minecraft || 0).toLocaleString('pt-BR');
    $('#staff-access-queued').textContent = Number(summary.queued || 0).toLocaleString('pt-BR');
    $('#staff-access-delivered').textContent = Number(summary.delivered || 0).toLocaleString('pt-BR');
    const manager = managerState(data.manager);
    const managerBox = $('#staff-manager-state');
    managerBox.className = `staff-manager-state ${manager.tone}`;
    managerBox.replaceChildren();
    const label = document.createElement('strong');
    label.textContent = manager.label;
    const detail = document.createElement('small');
    detail.textContent = manager.detail;
    managerBox.append(label, detail);
    $('#staff-access-note').textContent = data.delivery_note || 'Entregue significa que o endpoint reservou o item para o Manager; não confirma aplicação no servidor.';
    $$('[data-v2-badge="access"]').forEach(badge => {
      const pending = Number(summary.queued || 0);
      badge.textContent = pending;
      badge.hidden = pending === 0;
    });
    renderAccessRows();
  }

  async function loadAccess({ quiet = false } = {}) {
    if (state.accessLoading) return;
    state.accessLoading = true;
    const list = $('#staff-access-list');
    if (!quiet && list && !state.access) list.innerHTML = '<div class="staff-access-empty">Carregando a fila de acesso…</div>';
    try {
      renderAccess(await adminApi('/api/admin/access/overview'));
    } catch (error) {
      if (list) list.innerHTML = `<div class="staff-access-empty">${esc(error.message)}<br><button class="v2-btn" type="button" data-staff-refresh-access style="margin-top:12px">Tentar novamente</button></div>`;
    } finally {
      state.accessLoading = false;
    }
  }

  window.staffAccessWorkspace = { load: loadAccess };

  function applyMicrocopy() {
    const title = $('#admin-card-title');
    if (title) title.textContent = 'Diretório de jogadores e acessos';
    const notificationTitle = $('#admin-notifications-card > h3');
    if (notificationTitle) notificationTitle.innerHTML = 'Comunicação <span>Crie, agende e acompanhe avisos para a comunidade</span>';
    const notificationButton = $('#notif-submit-btn');
    if (notificationButton && !notificationButton.disabled) notificationButton.textContent = 'Enviar aviso';
    const meritTitle = $('#merit-card > h3');
    if (meritTitle) meritTitle.innerHTML = 'Economia <span id="merit-card-sub">Capital, Mérito, ranks e histórico transacional</span>';
    const moderationTitle = $('#moderation-card > div:first-child h3');
    if (moderationTitle) moderationTitle.innerHTML = 'Moderação <span>Triagem assistida por IA e denúncias da comunidade</span>';
    const auditTitle = $('#audit-card h3');
    if (auditTitle) auditTitle.textContent = 'Auditoria e segurança';
    const integrationTitle = $('#app-keys-card > h3');
    if (integrationTitle) integrationTitle.innerHTML = 'Integração do Manager <span>Credenciais do aplicativo oficial</span>';
    const integrationIntro = $('#app-keys-card > div:nth-of-type(1) > p');
    if (integrationIntro) integrationIntro.textContent = 'Crie e revogue credenciais individuais para sincronização. A chave completa aparece uma única vez.';
    const integrationCreate = $('#app-keys-card > div:nth-of-type(1) > button');
    if (integrationCreate) integrationCreate.textContent = 'Gerar chave de integração';
    const commandTrigger = $('#v2-cmd-trigger span');
    if (commandTrigger) commandTrigger.textContent = 'Buscar jogador, ação ou módulo…';
    const analytics = $('#community-analytics');
    if (analytics && !$('#staff-analytics-provenance', analytics)) {
      const note = document.createElement('div');
      note.id = 'staff-analytics-provenance';
      note.className = 'staff-honesty-note staff-analytics-provenance';
      note.textContent = 'Leitura direcional: os indicadores refletem os eventos disponíveis e podem variar em períodos ainda incompletos. Use tendências para decidir e a Auditoria para confirmar ações individuais.';
      analytics.querySelector('h3')?.insertAdjacentElement('afterend', note);
    }
  }

  function setupAuditDebounce() {
    const input = $('#audit-actor-filter');
    if (!input || input.dataset.staffDebounce) return;
    input.dataset.staffDebounce = '1';
    input.removeAttribute('oninput');
    input.oninput = () => {
      clearTimeout(state.auditTimer);
      state.auditTimer = setTimeout(() => {
        auditActorFilter = input.value.trim();
        auditPage = 0;
        fetchAuditLogs();
      }, 350);
    };
  }

  function setSettingsDirty(dirty) {
    state.settingsDirty = Boolean(dirty);
    if (!state.settingsDirty) {
      $('#staff-settings-dirty')?.remove();
      return;
    }
    let marker = $('#staff-settings-dirty');
    if (!marker) {
      marker = document.createElement('span');
      marker.id = 'staff-settings-dirty';
      marker.className = 'staff-settings-dirty';
      marker.textContent = 'Altera\u00e7\u00f5es n\u00e3o salvas';
      $('#v2-settings-body .v2-section-head')?.appendChild(marker);
    }
  }

  function requestSettingsLeave() {
    if (!state.settingsDirty) return true;
    const discard = window.confirm('Existem altera\u00e7\u00f5es n\u00e3o salvas em Configura\u00e7\u00f5es. Deseja descart\u00e1-las e sair?');
    if (discard) setSettingsDirty(false);
    return discard;
  }

  window.staffSettingsGuard = {
    isDirty: () => state.settingsDirty,
    requestLeave: requestSettingsLeave,
  };

  function setupSettingsDirtyState() {
    const body = $('#v2-settings-body');
    if (!body || body.dataset.staffDirtyBound) return;
    body.dataset.staffDirtyBound = '1';
    body.addEventListener('input', event => {
      if (!event.target.matches('input,select,textarea')) return;
      setSettingsDirty(true);
    });
    window.addEventListener('beforeunload', event => {
      if (!state.settingsDirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
    document.addEventListener('staff:settings-saved', () => {
      setSettingsDirty(false);
    });
  }

  function improveHelpSemantics(root = document) {
    $$('[data-help]', root).forEach(element => {
      const description = element.dataset.help?.trim();
      if (description) element.setAttribute('aria-description', description);
    });
  }

  function bindEvents() {
    document.addEventListener('click', async event => {
      if (event.target.closest('[data-staff-add-access]')) {
        const payload = await window.staffDialog.accessEntry();
        if (!payload) return;
        try {
          const result = await adminApi('/api/admin/access/whitelist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          showToast(result.already_queued ? 'Este jogador já estava na fila.' : 'Jogador adicionado à fila de acesso.', result.already_queued ? 'warning' : 'success');
          await loadAccess({ quiet: true });
        } catch (error) { showToast(error.message, 'error'); }
        return;
      }
      if (event.target.closest('[data-staff-refresh-access]')) return loadAccess({ quiet: true });
      if (event.target.closest('[data-staff-open-legacy]')) return window.navigate?.('legacy');
      const requeue = event.target.closest('[data-staff-requeue]');
      if (requeue) {
        const reason = await window.staffDialog.text({
          title: `Reenviar ${requeue.dataset.staffRequeueName}`,
          description: 'O item voltará para a fila e poderá ser coletado novamente pelo Manager. A ação será auditada.',
          label: 'Motivo do reenvio',
          required: true,
        });
        if (reason === null) return;
        try {
          await adminApi(`/api/admin/access/whitelist/${encodeURIComponent(requeue.dataset.staffRequeue)}/requeue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
          showToast('Entrada devolvida à fila de acesso.', 'success');
          await loadAccess({ quiet: true });
        } catch (error) { showToast(error.message, 'error'); }
      }
    });
    document.addEventListener('input', event => {
      if (event.target.id === 'staff-access-search') {
        state.accessSearch = event.target.value.trim();
        renderAccessRows();
      }
    });
    document.addEventListener('change', event => {
      if (event.target.id === 'staff-access-filter') {
        state.accessFilter = event.target.value;
        renderAccessRows();
      }
    });
  }

  function boot() {
    applyMicrocopy();
    setupAuditDebounce();
    setupSettingsDirtyState();
    improveHelpSemantics();
    bindEvents();
    setTimeout(applyMicrocopy, 900);
    setTimeout(() => { applyMicrocopy(); improveHelpSemantics(); }, 2600);
    if (new URL(location.href).searchParams.get('v') === 'access') loadAccess();
  }

  ensureDialog();
  ensureAccessModule();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 40), { once: true });
  else setTimeout(boot, 40);
})();
