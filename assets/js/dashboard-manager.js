(function managerDashboardModule() {
  'use strict';

  const root = document.getElementById('app-keys-card');
  if (!root) return;

  const state = {
    data: null,
    loading: false,
    filter: 'all',
    search: '',
    refreshTimer: null,
  };

  const esc = value => typeof escapeHTML === 'function'
    ? escapeHTML(String(value ?? ''))
    : String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const number = new Intl.NumberFormat('pt-BR');

  const ERROR_LABELS = {
    AUTH_REJECTED: ['Credencial rejeitada', 'A chave foi revogada, digitada incorretamente ou não existe mais.'],
    AUTH_MISSING: ['Credencial ausente', 'A instalação tentou conectar sem uma chave configurada.'],
    SYNC_TLS_ERROR: ['Falha HTTPS', 'O Windows não conseguiu validar o canal criptografado.'],
    SYNC_DNS_ERROR: ['Falha de DNS', 'O endereço do backend não pôde ser resolvido.'],
    SYNC_TIMEOUT: ['Tempo esgotado', 'O backend não confirmou a operação dentro do limite.'],
    SYNC_NETWORK_ERROR: ['Rede indisponível', 'A instalação não conseguiu alcançar o backend.'],
    SYNC_WRONG_SERVICE: ['Endpoint incorreto', 'A URL respondeu, mas não era a API do Manager.'],
    SYNC_PROTOCOL_OUTDATED: ['Protocolo antigo', 'Aplicativo e backend estão em versões incompatíveis.'],
    SYNC_PROCESSING_FAILED: ['Falha de processamento', 'O backend recebeu o pedido, mas não concluiu a sincronização.'],
    PRESENCE_UNAVAILABLE: ['Presença indisponível', 'O Manager não conseguiu confirmar o registro operacional.'],
    INSTALLATION_AUTH_REJECTED: ['Registro rejeitado', 'A credencial local de presença precisou ser renovada.'],
  };

  const FEATURE_LABELS = {
    'feature.server': 'Servidor',
    'feature.terminal': 'Terminal',
    'feature.players': 'Jogadores',
    'feature.sync': 'Sincronização',
    'feature.schedule': 'Agenda',
    'feature.mods': 'Mods e plugins',
    'feature.settings': 'Configurações',
    'feature.files': 'Arquivos',
    'feature.backup': 'Backups',
    'feature.updates': 'Atualizações',
    'action.server_start': 'Iniciar servidor',
    'action.server_stop': 'Parar servidor',
    'action.command': 'Comandos enviados',
    'action.backup': 'Backups criados',
    'action.schedule': 'Agendamentos alterados',
    'action.file_read': 'Arquivos consultados',
    'action.file_write': 'Arquivos alterados',
    'action.mod_check': 'Verificações de plugins',
    'action.mod_update': 'Atualizações de plugins',
    'action.remote_control': 'Ações de controle remoto',
    'action.sync_manual': 'Sincronizações manuais',
    'action.update_check': 'Buscas de atualização',
    'action.update_install': 'Atualizações instaladas',
  };

  const ACTIVATION_LABELS = {
    registered: 'Managers registrados',
    server_configured: 'Servidor configurado',
    app_key_linked: 'App Key vinculada',
    site_sync_configured: 'Sincronização configurada',
    usage_telemetry_opt_in: 'Diagnósticos opcionais',
  };

  function previewData() {
    const isoAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
    const installations = [
      { installation_id:'preview-main', app_key_id:1, device_name:'Servidor principal', app_version:'1.1.4', os_family:'Windows 11', os_release:'10.0.26200', arch:'x64', control_mode:'local', runtime_role:'machine-agent', last_transport:'websocket', telemetry_enabled:true, remote_enabled:true, remote_connected:true, agent_enabled:true, agent_healthy:true, server_configured:true, velocity_configured:true, site_sync_configured:true, server_running:true, velocity_running:true, start_with_windows:true, auto_start_enabled:true, backup_enabled:true, schedule_count:4, controller_count:3, online_controller_count:1, app_uptime_seconds:19640, launch_count:28, version_change_count:3, first_seen_at:isoAgo(90000), last_launch_at:isoAgo(330), last_seen_at:isoAgo(.1), latency_ms:34, sync_successes:1842, sync_failures:3, key_name:'Servidor principal', auth_kind:'app_key', online:true },
      { installation_id:'preview-note', app_key_id:2, device_name:'Notebook da administração', app_version:'1.1.4', os_family:'Windows 10', os_release:'10.0.19045', arch:'x64', control_mode:'remote-client', runtime_role:'remote-client', last_transport:'relay-websocket', telemetry_enabled:true, remote_enabled:true, remote_connected:true, agent_enabled:false, agent_healthy:false, site_sync_configured:false, start_with_windows:true, app_uptime_seconds:3820, launch_count:16, version_change_count:2, first_seen_at:isoAgo(50000), last_launch_at:isoAgo(64), last_seen_at:isoAgo(.4), latency_ms:51, sync_successes:0, sync_failures:0, key_name:'Administração', auth_kind:'relay_session', online:true },
      { installation_id:'preview-fresh', device_name:'PC recém-instalado', app_version:'1.1.4', os_family:'Windows 11', os_release:'10.0.26100', arch:'x64', control_mode:'local', runtime_role:'desktop', last_transport:'https-presence', telemetry_enabled:false, remote_enabled:false, remote_connected:false, agent_enabled:false, agent_healthy:false, server_configured:true, site_sync_configured:false, server_running:false, start_with_windows:true, auto_start_enabled:false, backup_enabled:false, schedule_count:0, controller_count:0, online_controller_count:0, app_uptime_seconds:420, launch_count:1, version_change_count:0, first_seen_at:isoAgo(7), last_launch_at:isoAgo(7), last_seen_at:isoAgo(.2), latency_ms:42, sync_successes:0, sync_failures:0, key_name:null, auth_kind:'installation', online:true },
      { installation_id:'preview-reserve', device_name:'PC de suporte', app_version:'1.1.2', os_family:'Windows 11', os_release:'10.0.26100', arch:'x64', control_mode:'remote-client', runtime_role:'remote-client', last_transport:'relay-https', telemetry_enabled:false, remote_enabled:true, remote_connected:false, agent_enabled:false, agent_healthy:false, last_seen_at:isoAgo(18), latency_ms:186, sync_successes:0, sync_failures:0, key_name:'Suporte', auth_kind:'relay_session', online:false, last_error_code:'SYNC_NETWORK_ERROR' },
      { installation_id:'legacy-shared-credential', device_name:'Manager legado', app_version:'1.1.0', os_family:'Windows 10', arch:'x64', control_mode:'local', runtime_role:'desktop', last_transport:'https', telemetry_enabled:false, remote_enabled:false, remote_connected:false, agent_enabled:false, agent_healthy:false, last_seen_at:isoAgo(1900), latency_ms:null, sync_successes:97, sync_failures:8, key_name:null, auth_kind:'legacy', online:false },
    ];
    const trend = Array.from({ length: 14 }, (_, index) => ({
      day: new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10),
      heartbeats: 620 + index * 9,
      syncs: 82 + index * 3,
      successes: 700 + index * 11,
      failures: index === 9 ? 7 : index % 5 === 0 ? 2 : 0,
      websocket: 650 + index * 8,
      https: 34 + index,
      avgLatencyMs: 39 + (index % 4) * 4,
    }));
    return {
      service:'forca-aliada-manager-api', protocol:2, ok:true, generatedAt:new Date().toISOString(), periodDays:30,
      summary:{ totalInstallations:5, online:3, active24h:4, active30d:5, latestVersion:'1.1.5', latestReleasedVersion:'1.1.5', latestObservedVersion:'1.1.4', latestVersionSource:'release', latestVersionAdoptionPct:0, upToDateInstallations:0, outdatedInstallations:5, syncSuccessRatePct:99.4, telemetryOptIn:2, telemetryCoveragePct:40, legacyCredentials:1, linkedInstallations:4, registeredOnly:1, serverConfigured:3, serverRunning:1, siteSyncConfigured:2, remoteEnabled:3, startWithWindows:3, autoStartEnabled:1, launches:52, versionChanges:7, schedules:4, controllers:3 },
      activation:[{stage:'registered',count:5},{stage:'server_configured',count:3},{stage:'app_key_linked',count:4},{stage:'site_sync_configured',count:2},{stage:'usage_telemetry_opt_in',count:2}],
      health:{ api:'operational', database:{status:'ready'}, websocketConnections:2, latestSignalAt:installations[0].last_seen_at },
      release:{ version:'1.1.5', tag:'v1.1.5', name:'Força Aliada Manager 1.1.5', assetName:'Forca-Aliada-Manager-Setup-1.1.5.exe', assetSize:100438956, downloadUrl:'https://github.com/ogabriels2/forca-aliada-releases/releases/download/v1.1.5/Forca-Aliada-Manager-Setup-1.1.5.exe', releasePageUrl:'https://github.com/ogabriels2/forca-aliada-releases/releases/tag/v1.1.5', source:'github-release-api', status:'ready', stale:false },
      distributions:{
        versions:[{name:'1.1.4',count:3},{name:'1.1.2',count:1},{name:'1.1.0',count:1}],
        operatingSystems:[{name:'Windows 11',count:3},{name:'Windows 10',count:2}],
        modes:[{name:'local',count:3},{name:'remote-client',count:2}],
        transports:[{name:'websocket',count:1},{name:'relay-websocket',count:1},{name:'https-presence',count:1},{name:'relay-https',count:1},{name:'https',count:1}],
        runtimeRoles:[{name:'desktop',count:2},{name:'remote-client',count:2},{name:'machine-agent',count:1}],
      },
      trend,
      errors:[{code:'SYNC_NETWORK_ERROR',count:6},{code:'SYNC_WRONG_SERVICE',count:2},{code:'SYNC_TLS_ERROR',count:1}],
      features:[
        {metric:'feature.server',count:684},{metric:'feature.players',count:512},{metric:'feature.terminal',count:331},
        {metric:'feature.mods',count:122},{metric:'action.command',count:94,failures:1},{metric:'action.remote_control',count:76},
      ],
      installations,
      credentials:[
        {id:1,name:'Servidor principal',created_at:isoAgo(8640),last_used_at:isoAgo(1),created_by:'Gabriel',installations:1,online_installations:1,last_seen_at:installations[0].last_seen_at},
        {id:2,name:'Administração',created_at:isoAgo(4320),last_used_at:isoAgo(1),created_by:'Gabriel',installations:1,online_installations:1,last_seen_at:installations[1].last_seen_at},
        {id:3,name:'Suporte',created_at:isoAgo(1440),last_used_at:isoAgo(18),created_by:'Gabriel',installations:1,online_installations:0,last_seen_at:installations[2].last_seen_at},
      ],
      privacy:{ usageTelemetryOptional:true, operationalPresenceRequired:true, excluded:['nomes de jogadores','comandos','logs','endereços IP','caminhos de arquivos','MOTD e conteúdo do servidor'], retentionDays:120 },
    };
  }

  function relativeTime(value) {
    if (!value) return 'Nunca';
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms)) return 'Não informado';
    if (ms < 15_000) return 'Agora';
    if (ms < 60_000) return `Há ${Math.max(1, Math.floor(ms / 1000))} s`;
    if (ms < 3_600_000) return `Há ${Math.floor(ms / 60_000)} min`;
    if (ms < 86_400_000) return `Há ${Math.floor(ms / 3_600_000)} h`;
    return `Há ${Math.floor(ms / 86_400_000)} d`;
  }

  function dateTime(value) {
    if (!value) return 'Não informado';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Não informado' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function duration(value) {
    const seconds = Math.max(0, Number(value || 0));
    if (!seconds) return 'Não informado';
    if (seconds < 60) return `${Math.round(seconds)} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }

  function setLiveState(kind, label) {
    const element = document.getElementById('manager-live-state');
    if (!element) return;
    element.className = `manager-live-state is-${kind}`;
    element.innerHTML = `<span></span>${esc(label)}`;
  }

  function serviceItem(label, detail, status) {
    return `<div class="manager-service-item"><span class="manager-service-dot is-${status}"></span><div><strong>${esc(label)}</strong><small title="${esc(detail)}">${esc(detail)}</small></div></div>`;
  }

  function renderServices(data) {
    const strip = document.getElementById('manager-service-strip');
    const online = Number(data.summary?.online || 0);
    const sockets = Number(data.health?.websocketConnections || 0);
    const database = data.health?.database?.status || 'unknown';
    const latest = data.health?.latestSignalAt;
    const realtimeDetail = sockets > 0
      ? `${sockets} ${sockets === 1 ? 'canal' : 'canais'} WebSocket ativo${sockets === 1 ? '' : 's'}`
      : online > 0 ? 'Instalações usando HTTPS de contingência' : 'Nenhum canal ativo agora';
    strip.innerHTML = [
      serviceItem('Backend', 'API operacional · protocolo ' + (data.protocol || 2), 'online'),
      serviceItem('Tempo real', realtimeDetail, sockets > 0 ? 'online' : online > 0 ? 'warning' : 'offline'),
      serviceItem('Banco', database === 'ready' ? 'Persistência operacional' : database === 'starting' ? 'Inicializando' : 'Persistência indisponível', database === 'ready' ? 'online' : database === 'starting' ? 'warning' : 'offline'),
      serviceItem('Último sinal', latest ? relativeTime(latest) : 'Nenhuma instalação registrada', latest ? 'online' : 'offline'),
    ].join('');
    setLiveState(online > 0 ? 'online' : latest ? 'warning' : 'offline', online > 0 ? `${online} online` : latest ? 'Sem sinal recente' : 'Sem instalações');
  }

  function renderKpis(data) {
    const summary = data.summary || {};
    const success = summary.syncSuccessRatePct;
    const release = data.release || {};
    const releasedVersion = release.version || summary.latestReleasedVersion || summary.latestVersion;
    const trustedReleaseUrl = safeManagerReleaseUrl(release.downloadUrl);
    const trustedPageUrl = safeManagerReleaseUrl(release.releasePageUrl) || 'https://github.com/ogabriels2/forca-aliada-releases/releases/latest';
    const actionUrl = trustedReleaseUrl || trustedPageUrl;
    const actionLabel = trustedReleaseUrl ? 'Baixar app' : 'Ver download';
    const releaseDetail = releasedVersion
      ? `${summary.latestVersionAdoptionPct || 0}% já usam · ${number.format(summary.outdatedInstallations || 0)} para atualizar${release.stale ? ' · confirmação em cache' : ''}`
      : 'Publicação indisponível · abra a página de download';
    const regularCards = [
      ['Conectados agora', number.format(summary.online || 0), summary.online ? 'Presença confirmada pelo backend' : 'Nenhum pulso dentro da janela segura'],
      ['Instalações', number.format(summary.totalInstallations || 0), `${number.format(summary.linkedInstallations || 0)} vinculadas · ${number.format(summary.active24h || 0)} ativas em 24 h`],
    ].map(([label, value, detail]) => `<article class="manager-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`);
    const releaseCard = `<article class="manager-kpi manager-release-kpi"><span>Versão publicada</span><div class="manager-kpi-value-row"><strong>${esc(releasedVersion || 'Não confirmada')}</strong><a class="manager-download-button" href="${esc(actionUrl)}" ${trustedReleaseUrl ? 'download' : 'target="_blank"'} rel="noopener" title="${esc(`${actionLabel}${releasedVersion ? ` ${releasedVersion}` : ''}`)}"><i data-lucide="download" aria-hidden="true"></i>${esc(actionLabel)}</a></div><small>${esc(releaseDetail)}</small></article>`;
    const serverCard = `<article class="manager-kpi"><span>Servidores ativos</span><strong>${esc(number.format(summary.serverRunning || 0))}</strong><small>${esc(`${number.format(summary.serverConfigured || 0)} configurados${success == null ? '' : ` · sync ${success}%`}`)}</small></article>`;
    document.getElementById('manager-kpis').innerHTML = [...regularCards, releaseCard, serverCard].join('');
  }

  function safeManagerReleaseUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
      if (!url.pathname.startsWith('/ogabriels2/forca-aliada-releases/releases/')) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function compareVersions(left, right) {
    const parts = value => String(value || '').replace(/^v/i, '').split(/[.-]/).map(item => Number.parseInt(item, 10) || 0);
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
    }
    return 0;
  }

  function installationStatus(row) {
    if (row.online) return ['online', 'Online'];
    const age = Date.now() - new Date(row.last_seen_at || 0).getTime();
    if (age <= 24 * 60 * 60 * 1000) return ['warning', 'Recente'];
    return ['offline', 'Offline'];
  }

  function transportLabel(value) {
    return value === 'websocket' ? 'Tempo real'
      : value === 'https' ? 'HTTPS de contingência'
      : value === 'https-presence' ? 'Presença HTTPS'
      : value === 'relay-websocket' ? 'Relay em tempo real'
      : value === 'relay-https' ? 'Relay HTTPS'
      : 'Não informado';
  }

  function usesLegacyCredential(row = {}) {
    return String(row.auth_kind || '').startsWith('legacy');
  }

  function isLinkedInstallation(row = {}) {
    return !!row.app_key_id || !!row.key_name || usesLegacyCredential(row);
  }

  function controlModeLabel(row = {}) {
    if (row.control_mode === 'remote-client' || row.control_mode === 'remote' || row.runtime_role === 'remote-client') return 'Controla outro PC';
    if (row.runtime_role === 'machine-agent') return 'Agente do sistema';
    return 'Servidor local';
  }

  function distributionLabel(group, value) {
    if (group === 'Canal') return transportLabel(value);
    if (group === 'Modo') return controlModeLabel({ control_mode: value });
    return value;
  }

  function runtimeRoleLabel(value) {
    return value === 'machine-agent' ? 'Agente em segundo plano'
      : value === 'remote-client' ? 'Aplicativo remoto' : value === 'desktop' ? 'Aplicativo principal' : 'Não informado';
  }

  function renderPresence(data) {
    const list = document.getElementById('manager-presence-list');
    const rows = (data.installations || []).slice(0, 5);
    if (!rows.length) {
      list.innerHTML = '<div class="manager-loading-row">Managers 1.1.4 ou mais recentes aparecem aqui automaticamente após serem abertos.</div>';
      return;
    }
    list.innerHTML = rows.map(row => {
      const [kind, status] = installationStatus(row);
      const integration = row.key_name
        ? `App Key · ${row.key_name}`
        : usesLegacyCredential(row) ? 'Credencial legada' : 'Registro operacional';
      return `<div class="manager-presence-row">
        <div class="manager-presence-main"><span class="manager-device-icon"><i data-lucide="monitor"></i></span><div class="manager-presence-copy"><strong>${esc(row.device_name || 'Manager')}</strong><small>${esc(row.app_version ? `v${row.app_version}` : 'Versão não informada')} · ${esc(integration)}</small></div></div>
        <span class="manager-state-badge is-${kind}"><span class="manager-status-dot is-${kind}"></span>${esc(status)} · ${esc(relativeTime(row.last_seen_at))}</span>
      </div>`;
    }).join('');
  }

  function renderDistributions(data) {
    const container = document.getElementById('manager-distributions');
    const total = Math.max(1, Number(data.summary?.totalInstallations || 0));
    const groups = [
      ['Versões', data.distributions?.versions || []],
      ['Sistema', data.distributions?.operatingSystems || []],
      ['Canal', data.distributions?.transports || []],
      ['Modo', data.distributions?.modes || []],
    ];
    const rows = groups.flatMap(([group, items]) => items.slice(0, 2).map(item => ({ group, ...item })));
    container.innerHTML = rows.length ? rows.map(item => {
      const pct = Math.max(2, Math.round((Number(item.count || 0) / total) * 100));
      return `<div class="manager-distribution-block"><div><span>${esc(item.group)} · ${esc(distributionLabel(item.group, item.name))}</span><strong>${number.format(item.count || 0)}</strong></div><div class="manager-distribution-track"><div class="manager-distribution-fill" style="width:${pct}%"></div></div></div>`;
    }).join('') : '<div class="manager-loading-row">A distribuição aparecerá após a primeira conexão.</div>';
  }

  function filterInstallations(rows) {
    const query = state.search.toLocaleLowerCase('pt-BR');
    const latest = state.data?.summary?.latestVersion;
    return rows.filter(row => {
      if (state.filter === 'online' && !row.online) return false;
      const needsLink = row.server_configured && !isLinkedInstallation(row);
      const current = row.app_version && latest && compareVersions(row.app_version, latest) >= 0;
      if (state.filter === 'attention' && row.online && current && !row.last_error_code && !needsLink) return false;
      if (!query) return true;
      return [row.device_name, row.app_version, row.os_family, row.key_name, row.control_mode, row.installation_id]
        .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query));
    });
  }

  function renderInstallations(data) {
    const body = document.getElementById('manager-installations-body');
    const rows = filterInstallations(data.installations || []);
    document.getElementById('manager-installations-tab-count').textContent = number.format(data.summary?.totalInstallations || 0);
    if (!rows.length) {
      body.innerHTML = '<tr><td class="manager-table-empty" colspan="7">Nenhuma instalação corresponde a este filtro.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(row => {
      const [kind, status] = installationStatus(row);
      const mode = controlModeLabel(row);
      const latency = row.latency_ms !== null && row.latency_ms !== '' && Number.isFinite(Number(row.latency_ms))
        ? ` · ${number.format(row.latency_ms)} ms`
        : '';
      const integration = row.key_name
        ? `App Key · ${row.key_name}`
        : usesLegacyCredential(row) ? 'Credencial legada' : `Registro operacional · ${String(row.installation_id || '').slice(-8)}`;
      const runtime = row.runtime_role === 'remote-client'
        ? (row.remote_connected ? 'Controle remoto ativo' : row.remote_enabled ? 'Remoto disponível' : 'Controle remoto inativo')
        : (row.server_running || row.velocity_running) ? 'Servidor em execução'
          : row.server_configured ? 'Servidor configurado e parado' : 'Sem servidor local configurado';
      return `<tr>
        <td><div class="manager-installation-main"><span class="manager-device-icon"><i data-lucide="monitor"></i></span><div><strong>${esc(row.device_name || 'Manager')}</strong><small>${esc(integration)}</small></div></div></td>
        <td data-label="Estado"><span class="manager-state-badge is-${kind}"><span class="manager-status-dot is-${kind}"></span>${esc(status)}</span></td>
        <td data-label="Versão e sistema"><strong>${esc(row.app_version ? `v${row.app_version}` : 'Não informada')}</strong><small>${esc([row.os_family, row.arch].filter(Boolean).join(' · ') || 'Sistema não informado')}</small></td>
        <td data-label="Modo">${esc(mode)}<small>${esc(runtime)}</small></td>
        <td data-label="Canal"><span class="manager-transport-badge">${esc(transportLabel(row.last_transport))}</span><small>${esc(latency.replace(/^ · /, ''))}</small></td>
        <td data-label="Último sinal" title="${esc(dateTime(row.last_seen_at))}">${esc(relativeTime(row.last_seen_at))}</td>
        <td><button class="manager-table-detail" type="button" data-manager-detail="${esc(row.installation_id)}" title="Ver detalhes" aria-label="Ver detalhes de ${esc(row.device_name || 'Manager')}"><i data-lucide="chevron-right"></i></button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-manager-detail]').forEach(button => button.addEventListener('click', () => openDetails(button.dataset.managerDetail)));
  }

  function barsHtml(items, labelFor = item => item.name, countFor = item => item.count) {
    const max = Math.max(1, ...items.map(item => Number(countFor(item) || 0)));
    if (!items.length) return '<div class="manager-loading-row">Ainda não há dados suficientes.</div>';
    return items.slice(0, 12).map(item => {
      const count = Number(countFor(item) || 0);
      return `<div class="manager-bar-row"><span title="${esc(labelFor(item))}">${esc(labelFor(item))}</span><div class="manager-bar-track"><div class="manager-bar-fill" style="width:${Math.max(2, Math.round((count / max) * 100))}%"></div></div><strong>${number.format(count)}</strong></div>`;
    }).join('');
  }

  function renderActivation(data) {
    const target = document.getElementById('manager-activation');
    if (!target) return;
    const total = Math.max(0, Number(data.summary?.totalInstallations || 0));
    const items = Array.isArray(data.activation) ? data.activation : [
      { stage: 'registered', count: total },
      { stage: 'server_configured', count: data.summary?.serverConfigured || 0 },
      { stage: 'app_key_linked', count: data.summary?.linkedInstallations || 0 },
      { stage: 'site_sync_configured', count: data.summary?.siteSyncConfigured || 0 },
      { stage: 'usage_telemetry_opt_in', count: data.summary?.telemetryOptIn || 0 },
    ];
    target.innerHTML = items.map(item => {
      const count = Math.max(0, Number(item.count || 0));
      const pct = total ? Math.min(100, Math.round((count / total) * 100)) : 0;
      return `<div class="manager-activation-step"><span>${esc(ACTIVATION_LABELS[item.stage] || item.stage)}</span><strong>${number.format(count)}</strong><small>${pct}% das instalações</small><div class="manager-activation-track"><i style="width:${pct}%"></i></div></div>`;
    }).join('');
  }

  function renderUsage(data) {
    renderActivation(data);
    document.getElementById('manager-telemetry-coverage').textContent = `${data.summary?.telemetryCoveragePct || 0}% opt-in`;
    document.getElementById('manager-feature-bars').innerHTML = barsHtml(data.features || [], item => FEATURE_LABELS[item.metric] || item.metric);
    const platformItems = [
      ...(data.distributions?.operatingSystems || []).map(item => ({ ...item, name: `Sistema · ${item.name}` })),
      ...(data.distributions?.modes || []).map(item => ({ ...item, name: `Modo · ${distributionLabel('Modo', item.name)}` })),
    ];
    document.getElementById('manager-platform-bars').innerHTML = barsHtml(platformItems);
    const privacy = data.privacy || {};
    const excluded = Array.isArray(privacy.excluded) ? privacy.excluded.join(', ') : '';
    document.getElementById('manager-privacy-copy').textContent = `Telemetria opcional, agregada e retida por ${privacy.retentionDays || 120} dias. Nunca recebe ${excluded || 'conteúdo privado do servidor'}.`;
  }

  function renderHealth(data) {
    const trend = data.trend || [];
    const max = Math.max(1, ...trend.map(day => Number(day.successes || 0) + Number(day.failures || 0)));
    document.getElementById('manager-health-trend').innerHTML = trend.length ? trend.map(day => {
      const successes = Number(day.successes || 0);
      const failures = Number(day.failures || 0);
      const okHeight = Math.max(2, Math.round((successes / max) * 100));
      const failHeight = failures ? Math.max(3, Math.round((failures / max) * 100)) : 2;
      const label = new Date(`${String(day.day).slice(0,10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      return `<div class="manager-trend-day" data-tip="${esc(`${label}: ${successes} confirmações, ${failures} falhas, ${day.avgLatencyMs ?? '—'} ms`)}"><span style="height:${okHeight}%"></span><span style="height:${failHeight}%"></span></div>`;
    }).join('') : '<div class="manager-loading-row" style="width:100%">O histórico aparecerá após os primeiros sinais.</div>';

    const errors = data.errors || [];
    document.getElementById('manager-error-list').innerHTML = errors.length ? errors.map(item => {
      const [title, description] = ERROR_LABELS[item.code] || [item.code, 'Falha técnica agrupada pelo aplicativo.'];
      return `<div class="manager-error-row"><div><strong>${esc(title)}</strong><small>${esc(description)}</small></div><b>${number.format(item.count || 0)}</b></div>`;
    }).join('') : '<div class="manager-loading-row">Nenhuma falha registrada no período.</div>';
  }

  function renderCredentials(data) {
    const list = document.getElementById('app-keys-list');
    const rows = data.credentials || [];
    const canMutate = session?.role === 'owner';
    root.querySelectorAll('[onclick="generateAppKey()"]')?.forEach(button => { button.hidden = !canMutate; });
    if (!rows.length) {
      list.innerHTML = '<div class="manager-loading-row">Os Managers já podem aparecer por registro operacional. Gere uma App Key somente para sincronizar dados e controlar o servidor pelo site.</div>';
      return;
    }
    list.innerHTML = rows.map(key => {
      const online = Number(key.online_installations || 0);
      const total = Number(key.installations || 0);
      return `<div class="manager-credential-row">
        <div><h5>${esc(key.name)}</h5><p>Criada em ${esc(dateTime(key.created_at))} por ${esc(key.created_by || 'Administrador')} · Último sinal ${esc(relativeTime(key.last_seen_at || key.last_used_at))}</p></div>
        <div class="manager-credential-count"><strong>${online} online</strong><br>${total} instalação${total === 1 ? '' : 'ões'}</div>
        ${canMutate ? `<button class="btn-secondary btn-danger-outline" type="button" data-app-key-revoke="${Number(key.id)}" data-app-key-name="${esc(key.name)}">Revogar</button>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-app-key-revoke]').forEach(button => button.addEventListener('click', () => revokeAppKey(Number(button.dataset.appKeyRevoke), button.dataset.appKeyName || 'Integração')));
  }

  function openDetails(id) {
    const row = (state.data?.installations || []).find(item => item.installation_id === id);
    const dialog = document.getElementById('manager-installation-dialog');
    if (!row || !dialog) return;
    document.getElementById('manager-detail-title').textContent = row.device_name || 'Manager';
    const [kind, status] = installationStatus(row);
    const configuredParts = [row.server_configured ? 'Backend' : '', row.velocity_configured ? 'Velocity' : ''].filter(Boolean);
    const runningParts = [row.server_running ? 'Backend' : '', row.velocity_running ? 'Velocity' : ''].filter(Boolean);
    const values = [
      ['Estado', status], ['Último sinal', dateTime(row.last_seen_at)],
      ['Versão', row.app_version ? `v${row.app_version}` : 'Não informada'], ['Sistema', [row.os_family, row.os_release, row.arch].filter(Boolean).join(' · ') || 'Não informado'],
      ['Modo', controlModeLabel(row)], ['Processo', runtimeRoleLabel(row.runtime_role)],
      ['Canal', transportLabel(row.last_transport)], ['Latência', row.latency_ms == null ? 'Não medida' : `${row.latency_ms} ms`],
      ['Registro do Manager', 'Ativo com credencial própria'], ['Vínculo de dados', row.key_name ? `App Key · ${row.key_name}` : usesLegacyCredential(row) ? 'Credencial legada' : 'Não vinculado'],
      ['Arquivos configurados', configuredParts.join(' + ') || 'Nenhum neste computador'], ['Execução atual', runningParts.length ? `${runningParts.join(' + ')} ligado` : 'Servidor parado'],
      ['Sincronização do site', row.site_sync_configured ? 'Configurada' : 'Não configurada'], ['Telemetria de uso', row.telemetry_enabled ? 'Permitida' : 'Desativada'],
      ['Controle remoto', row.remote_connected ? 'Conectado' : row.remote_enabled ? 'Disponível' : 'Desativado'], ['Agente do Windows', row.agent_healthy ? 'Saudável' : row.agent_enabled ? 'Sem confirmação' : 'Não utilizado'],
      ['Iniciar com Windows', row.start_with_windows ? 'Ativado' : 'Desativado'], ['Início automático do servidor', row.auto_start_enabled ? 'Ativado' : 'Desativado'],
      ['Backups automáticos', row.backup_enabled ? 'Ativados' : 'Desativados'], ['Agendamentos', number.format(row.schedule_count || 0)],
      ['Controladores', `${number.format(row.online_controller_count || 0)} online · ${number.format(row.controller_count || 0)} cadastrados`], ['Tempo aberto nesta sessão', duration(row.app_uptime_seconds)],
      ['Inicializações registradas', number.format(row.launch_count || 0)], ['Trocas de versão', number.format(row.version_change_count || 0)],
      ['Primeiro registro', dateTime(row.first_seen_at)], ['Última abertura', dateTime(row.last_launch_at)],
      ['Sincronizações confirmadas', number.format(row.sync_successes || 0)], ['Falhas', number.format(row.sync_failures || 0)],
      ['Identificador aleatório', row.installation_id], ['Diagnóstico recente', ERROR_LABELS[row.last_error_code]?.[0] || row.last_error_code || 'Nenhuma falha'],
    ];
    document.getElementById('manager-detail-content').innerHTML = `<div class="manager-detail-grid">${values.map(([label, value]) => `<div class="manager-detail-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div><div style="margin-top:14px"><span class="manager-state-badge is-${kind}"><span class="manager-status-dot is-${kind}"></span>${esc(status)}</span></div>`;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function activateTab(tab) {
    const target = root.querySelector(`[data-manager-panel="${CSS.escape(tab)}"]`) ? tab : 'overview';
    root.querySelectorAll('[data-manager-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.managerTab === target));
    root.querySelectorAll('[data-manager-panel]').forEach(panel => {
      const active = panel.dataset.managerPanel === target;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    if (target === 'installations') renderInstallations(state.data || { installations: [], summary: {} });
  }

  function renderAll(data) {
    renderServices(data);
    renderKpis(data);
    renderPresence(data);
    renderDistributions(data);
    renderInstallations(data);
    renderUsage(data);
    renderHealth(data);
    renderCredentials(data);
    document.getElementById('manager-legacy-notice').hidden = !(Number(data.summary?.legacyCredentials || 0) > 0);
    window.lucide?.createIcons?.();
  }

  function renderFailure(error) {
    setLiveState('offline', 'Backend indisponível');
    const strip = document.getElementById('manager-service-strip');
    strip.innerHTML = [
      serviceItem('Backend', error?.message || 'Sem resposta da API', 'offline'),
      serviceItem('Tempo real', 'Estado não confirmado', 'offline'),
      serviceItem('Banco', 'Estado não confirmado', 'warning'),
      serviceItem('Último sinal', state.data?.health?.latestSignalAt ? relativeTime(state.data.health.latestSignalAt) : 'Sem dados', 'warning'),
    ].join('');
  }

  async function load(options = {}) {
    if (state.loading && !options.force) return;
    state.loading = true;
    const button = document.getElementById('manager-refresh-button');
    button?.classList.add('is-spinning');
    try {
      let data;
      if (typeof DASHBOARD_PREVIEW !== 'undefined' && DASHBOARD_PREVIEW) {
        data = previewData();
      } else {
        const response = await apiFetch('/api/admin/manager/overview?days=30', { headers: { Authorization: `Bearer ${token}` } });
        data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || `Backend respondeu HTTP ${response.status}`);
      }
      state.data = data;
      renderAll(data);
    } catch (error) {
      console.error('[manager dashboard]', error);
      renderFailure(error);
    } finally {
      state.loading = false;
      button?.classList.remove('is-spinning');
    }
  }

  root.querySelectorAll('[data-manager-tab]').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.managerTab)));
  root.querySelectorAll('[data-manager-open-tab]').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.managerOpenTab)));
  root.querySelectorAll('[data-manager-filter]').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.managerFilter;
    root.querySelectorAll('[data-manager-filter]').forEach(item => item.classList.toggle('is-active', item === button));
    renderInstallations(state.data || { installations: [], summary: {} });
    window.lucide?.createIcons?.();
  }));
  document.getElementById('manager-installation-search')?.addEventListener('input', event => {
    state.search = event.target.value.trim();
    renderInstallations(state.data || { installations: [], summary: {} });
    window.lucide?.createIcons?.();
  });
  document.getElementById('manager-refresh-button')?.addEventListener('click', () => load({ force: true }));
  root.querySelector('[data-manager-close-dialog]')?.addEventListener('click', () => document.getElementById('manager-installation-dialog')?.close());
  document.getElementById('manager-installation-dialog')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && activeDashboardModule === 'app-keys-card') load({ force: true });
  }, 30_000);

  window.managerConsole = {
    load,
    activateTab,
    loadCredentials: () => load({ force: true }),
  };

  if (session?.role === 'owner' || (session?.role === 'observer' && canObserverView?.('infrastructure'))) load();
  window.lucide?.createIcons?.();
})();
