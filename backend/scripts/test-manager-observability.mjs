import assert from 'node:assert/strict';
import {
  MANAGER_OBSERVABILITY_SCHEMA_SQL,
  MANAGER_PROTOCOL_VERSION,
  MANAGER_SERVICE_ID,
  createManagerObservability,
  managerEnvelope,
} from '../src/manager_observability.mjs';

const clientCalls = [];
const poolCalls = [];
let connectCount = 0;
const client = {
  async query(sql, params = []) {
    clientCalls.push({ sql: String(sql), params });
    return { rows: [], rowCount: 0 };
  },
  release() {},
};
const pool = {
  async connect() {
    connectCount += 1;
    return client;
  },
  async query(sql, params = []) {
    const source = String(sql);
    poolCalls.push({ sql: source, params });
    if (source.includes('COUNT(*)::int AS total_installations')) {
      return {
        rows: [{
          total_installations: 2,
          online: 0,
          active_24h: 2,
          active_30d: 2,
          telemetry_opt_in: 0,
          linked_installations: 2,
        }],
        rowCount: 1,
      };
    }
    if (source.includes('SELECT dimension, name, COUNT(*)::int AS count')) {
      return { rows: [{ dimension: 'version', name: '1.1.3', count: 2 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

const observability = createManagerObservability(pool, {
  getDatabaseState: () => ({ status: 'ready' }),
  getSocketCount: () => 1,
  getLatestRelease: async () => ({
    version: '1.1.5', tag: 'v1.1.5', name: 'Forca Aliada Manager 1.1.5',
    assetName: 'Forca-Aliada-Manager-Setup-1.1.5.exe', assetSize: 100438956,
    downloadUrl: 'https://github.com/ogabriels2/forca-aliada-releases/releases/download/v1.1.5/Forca-Aliada-Manager-Setup-1.1.5.exe',
    releasePageUrl: 'https://github.com/ogabriels2/forca-aliada-releases/releases/tag/v1.1.5',
    source: 'github-release-api', status: 'ready', stale: false,
  }),
});
const auth = { appKeyId: 7, keyName: 'PC principal', authKind: 'app_key' };
const metadata = {
  installationId: '9fcdfc61-5ad7-48bd-88d0-8b49ddd1a860',
  deviceName: 'Servidor Casa',
  appVersion: '1.1.3',
  osFamily: 'Windows 11',
  controlMode: 'local',
  runtimeRole: 'desktop',
  telemetryEnabled: true,
  latencyMs: 18,
};

await observability.recordSignal({ auth, metadata, transport: 'websocket', kind: 'heartbeat', ok: true });
assert.equal(connectCount, 1, 'primeiro sinal deve persistir a instalacao');
assert.ok(clientCalls.some(call => call.sql.includes('INSERT INTO manager_installations')));
assert.ok(clientCalls.some(call => call.sql.includes('INSERT INTO manager_health_daily')));
assert.equal(observability.isAnyOnline(), true);

const connection = observability.connectionSummary();
assert.equal(connection.connected, true);
assert.equal(connection.deviceName, 'Servidor Casa');
assert.equal(connection.transport, 'websocket');
assert.equal(connection.authKind, 'app_key');
assert.equal(connection.keyName, 'PC principal');
assert.equal(connection.confidence, 'verified');

await new Promise(resolve => setTimeout(resolve, 2));
await observability.recordSignal({
  auth,
  metadata: {
    ...metadata,
    installationId: '70ac127c-e293-47de-aef1-b4355461f234',
    deviceName: 'Notebook remoto',
    controlMode: 'remote-client',
    runtimeRole: 'remote-client',
  },
  transport: 'relay-websocket',
  kind: 'heartbeat',
  ok: true,
});
assert.equal(observability.latestSignal().meta.deviceName, 'Servidor Casa', 'cliente remoto nao pode substituir a origem do servidor');
assert.equal(observability.latestSignal({ includeRemoteClients: true }).meta.deviceName, 'Notebook remoto');
assert.equal(observability.connectionSummary().onlineInstallations, 1, 'resumo do servidor deve excluir clientes remotos');
assert.equal(observability.isAnyOnline({ includeRemoteClients: true }), true);

const overview = await observability.loadOverview(30);
assert.equal(overview.summary.latestVersion, '1.1.5', 'versao publicada deve vir do release, nao dos PCs conectados');
assert.equal(overview.summary.latestReleasedVersion, '1.1.5');
assert.equal(overview.summary.latestObservedVersion, '1.1.3');
assert.equal(overview.summary.latestVersionAdoptionPct, 0);
assert.equal(overview.summary.outdatedInstallations, 2);
assert.equal(overview.release.version, '1.1.5');
assert.match(overview.release.downloadUrl, /^https:\/\/github\.com\/ogabriels2\/forca-aliada-releases\//);

await observability.recordSignal({
  auth,
  metadata: { ...metadata, latencyMs: 24 },
  transport: 'websocket',
  kind: 'heartbeat',
  ok: true,
});
assert.equal(connectCount, 2, 'latencia volatil nao deve causar escrita extra de presenca por pulso');

await observability.recordSignal({
  auth,
  metadata: { ...metadata, appVersion: '1.1.4', lastErrorCode: 'SYNC_NETWORK_ERROR' },
  transport: 'https',
  kind: 'sync',
  ok: false,
  errorCode: 'SYNC_NETWORK_ERROR',
});
const errorWrite = clientCalls.find(call => call.sql.includes('INSERT INTO manager_error_daily'));
assert.ok(errorWrite, 'falhas devem usar contagem diaria normalizada');
assert.match(errorWrite.sql, /occurrence_count=manager_error_daily\.occurrence_count \+ EXCLUDED\.occurrence_count/);
const failedSyncWrite = clientCalls.filter(call => call.sql.includes('INSERT INTO manager_installations')).at(-1);
assert.equal(failedSyncWrite.params[34], 0);
assert.equal(failedSyncWrite.params[35], 1, 'falha de sync deve entrar apenas no contador de sincronizacao');
const remoteInstallationWrite = clientCalls.find(call =>
  call.sql.includes('INSERT INTO manager_installations')
  && call.params[0] === '70ac127c-e293-47de-aef1-b4355461f234'
);
assert.equal(remoteInstallationWrite.params[34], 0, 'heartbeat remoto nao pode inflar sincronizacoes bem-sucedidas');
assert.equal(remoteInstallationWrite.params[35], 0, 'heartbeat remoto nao pode inflar falhas de sincronizacao');

const day = new Date().toISOString().slice(0, 10);
const telemetry = await observability.ingestTelemetry(auth, {
  manager: metadata,
  day,
  sequence: 4,
  metrics: {
    'feature.server': { count: 3, failures: 0, durationMs: 12 },
    'private.player': { count: 500, failures: 0, durationMs: 0 },
  },
});
assert.deepEqual(telemetry, { accepted: true, sequence: 4 });
const telemetryWrite = poolCalls.find(call => call.sql.includes('INSERT INTO manager_telemetry_daily'));
assert.ok(telemetryWrite, 'snapshot agregado deve ser persistido');
const persistedMetrics = JSON.parse(telemetryWrite.params[3]);
assert.deepEqual(Object.keys(persistedMetrics), ['feature.server'], 'backend deve reaplicar a allowlist');
assert.match(telemetryWrite.sql, /sequence <= EXCLUDED\.sequence/, 'snapshot precisa ser idempotente por sequencia');

const disabled = await observability.ingestTelemetry(auth, {
  manager: { ...metadata, telemetryEnabled: false },
  day,
  sequence: 5,
  metrics: { 'feature.server': { count: 4 } },
});
assert.equal(disabled.accepted, false, 'backend deve respeitar telemetria desativada');

const presenceOnly = createManagerObservability(pool);
await presenceOnly.recordSignal({
  auth: { isValid: true, authKind: 'installation' },
  metadata: {
    ...metadata,
    installationId: '5c8fa2c0-b572-46cc-8e5d-81393f231297',
    sessionId: 'session-presence-only',
    serverConfigured: true,
    serverRunning: true,
    scheduleCount: 4,
  },
  transport: 'https-presence',
  kind: 'presence',
  ok: true,
});
assert.equal(presenceOnly.isAnyOnline(), false, 'presenca operacional nao pode declarar o servidor conectado');
assert.equal(presenceOnly.isAnyOnline({ includeRemoteClients: true }), true, 'dashboard deve enxergar a instalacao registrada');

let registeredInstallation = null;
let registeredTokenHash = '';
const registrationAppKeyValues = [];
const credentialClient = {
  async query(sql, params = []) {
    const source = String(sql);
    if (source.includes('SELECT i.app_key_id') && source.includes('FOR UPDATE OF i')) {
      return { rows: registeredInstallation ? [registeredInstallation] : [] };
    }
    if (source.includes('SELECT token_hash FROM manager_installation_credentials')) {
      return { rows: registeredTokenHash ? [{ token_hash: registeredTokenHash }] : [] };
    }
    if (source.includes('INSERT INTO manager_installations')) {
      if (source.includes('first_seen_at')) registrationAppKeyValues.push(params[1]);
      registeredInstallation ||= { app_key_id: null, auth_kind: 'installation', key_name: null };
    }
    if (source.includes('INSERT INTO manager_installation_credentials')) {
      registeredTokenHash = params[1];
    }
    return { rows: [], rowCount: 1 };
  },
  release() {},
};
const credentialPool = {
  async connect() { return credentialClient; },
  async query(sql) {
    if (String(sql).includes('FROM manager_installation_credentials c')) {
      return {
        rows: registeredTokenHash
          ? [{ token_hash: registeredTokenHash, app_key_id: null, key_name: null }]
          : [],
      };
    }
    return { rows: [], rowCount: 0 };
  },
};
const credentialObservability = createManagerObservability(credentialPool);
const registrationMetadata = {
  ...metadata,
  installationId: '73c1a6bd-4a92-43b6-a82d-9bd0116139b9',
  telemetryEnabled: false,
};
const registration = await credentialObservability.registerInstallation({ metadata: registrationMetadata });
assert.match(registration.installationToken, /^fai_v1_[a-zA-Z0-9_-]{32,160}$/);
assert.equal(registration.tokenIssued, true);
assert.equal((await credentialObservability.authenticateInstallation(registrationMetadata.installationId, registration.installationToken)).isValid, true);
assert.equal((await credentialObservability.authenticateInstallation(registrationMetadata.installationId, `${registration.installationToken}x`)).isValid, false);
const existingRegistration = await credentialObservability.registerInstallation({
  metadata: registrationMetadata,
  presentedToken: registration.installationToken,
});
assert.equal(existingRegistration.tokenIssued, false, 'token valido deve ser reutilizado sem expor outro segredo');
await assert.rejects(
  credentialObservability.registerInstallation({ metadata: registrationMetadata }),
  error => error.code === 'INSTALLATION_ALREADY_REGISTERED' && error.status === 409,
);

registeredInstallation = null;
registeredTokenHash = '';
const legacyRegistration = await createManagerObservability(credentialPool).registerInstallation({
  metadata: {
    ...registrationMetadata,
    installationId: 'f57f7877-a611-433d-a03e-5667445a0ad0',
  },
  appAuth: {
    isValid: true,
    appKeyId: null,
    keyName: 'Credencial legada',
    authKind: 'legacy',
  },
});
assert.equal(legacyRegistration.linkedToAppKey, true, 'credencial legada valida deve manter compatibilidade');
assert.equal(registrationAppKeyValues.at(-1), null, 'credencial legada nao pode virar o app_key_id 0');

const envelope = managerEnvelope({ managerRequestId: 'request-123456' }, { ok: true });
assert.equal(envelope.service, MANAGER_SERVICE_ID);
assert.equal(envelope.protocol, MANAGER_PROTOCOL_VERSION);
assert.equal(envelope.requestId, 'request-123456');
assert.equal(envelope.ok, true);

for (const table of ['manager_installations', 'manager_installation_credentials', 'manager_health_daily', 'manager_error_daily', 'manager_telemetry_daily']) {
  assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes('origin_transport'));
assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes('origin_confidence'));

console.log('Observabilidade do Manager: presenca, privacidade e idempotencia validadas.');
