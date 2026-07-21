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
    poolCalls.push({ sql: String(sql), params });
    return { rows: [], rowCount: 0 };
  },
};

const observability = createManagerObservability(pool, {
  getDatabaseState: () => ({ status: 'ready' }),
  getSocketCount: () => 1,
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
assert.equal(failedSyncWrite.params[21], 0);
assert.equal(failedSyncWrite.params[22], 1, 'falha de sync deve entrar apenas no contador de sincronizacao');
const remoteInstallationWrite = clientCalls.find(call =>
  call.sql.includes('INSERT INTO manager_installations')
  && call.params[0] === '70ac127c-e293-47de-aef1-b4355461f234'
);
assert.equal(remoteInstallationWrite.params[21], 0, 'heartbeat remoto nao pode inflar sincronizacoes bem-sucedidas');
assert.equal(remoteInstallationWrite.params[22], 0, 'heartbeat remoto nao pode inflar falhas de sincronizacao');

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

const envelope = managerEnvelope({ managerRequestId: 'request-123456' }, { ok: true });
assert.equal(envelope.service, MANAGER_SERVICE_ID);
assert.equal(envelope.protocol, MANAGER_PROTOCOL_VERSION);
assert.equal(envelope.requestId, 'request-123456');
assert.equal(envelope.ok, true);

for (const table of ['manager_installations', 'manager_health_daily', 'manager_error_daily', 'manager_telemetry_daily']) {
  assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes('origin_transport'));
assert.ok(MANAGER_OBSERVABILITY_SCHEMA_SQL.includes('origin_confidence'));

console.log('Observabilidade do Manager: presenca, privacidade e idempotencia validadas.');
