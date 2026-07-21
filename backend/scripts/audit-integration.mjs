import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'src');
const modules = fs.readdirSync(sourceDir)
  .filter(name => name.endsWith('.mjs'))
  .map(name => path.join(sourceDir, name));
const failures = [];

for (const file of modules) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    failures.push(`${path.basename(file)}: ${(check.stderr || check.stdout || 'sintaxe invalida').trim()}`);
  }
}

const server = fs.readFileSync(path.join(sourceDir, 'server.mjs'), 'utf8');
const manager = fs.readFileSync(path.join(sourceDir, 'manager_observability.mjs'), 'utf8');
const worker = fs.readFileSync(path.join(root, '..', '_worker.js'), 'utf8');
const workerRoutes = JSON.parse(fs.readFileSync(path.join(root, '..', '_routes.json'), 'utf8'));
const requiredFragments = [
  "pathname === '/api/app/ws'",
  "url.pathname !== '/api/app/remote/ws'",
  "message.kind === 'whitelist-ack'",
  "app.post('/api/app/whitelist-ack'",
  'const remoteRelayWsRooms = new Map()',
  'const remoteRelayHttpWaiters = new Map()',
  "const REMOTE_RELAY_NOTIFY_CHANNEL = 'fa_remote_relay_v1'",
  "client.query(`LISTEN ${REMOTE_RELAY_NOTIFY_CHANNEL}`)",
  "kind: 'relay-delivery'",
  'deliveryAck: true',
  'drainPersistedRelayToLocalSocket',
  'async function processAppSyncPayload',
  'APP_KEY_LAST_USED_WRITE_MS',
  "app.get('/api/app/discovery'",
  'managerEnvelope(req',
  'app_connection: getAppConnectionSummary()',
  'managerObservability.registerAdminRoutes',
  "message.kind === 'manager-presence'",
  "origin=CASE WHEN origin='site' THEN 'mixed' ELSE origin END",
];
for (const fragment of requiredFragments) {
  if (!server.includes(fragment)) failures.push(`contrato ausente em server.mjs: ${fragment}`);
}

if (/UPDATE app_integration_keys SET last_used_at=NOW\(\)[^\n]+RETURNING/.test(server)) {
  failures.push('validateAppKey voltou a gravar no banco em toda validacao');
}
if (/while\s*\([^)]*Date\.now[^)]*\)\s*\{[\s\S]{0,500}pool\.query/.test(server)) {
  failures.push('polling ativo de banco detectado no relay remoto');
}
if (!worker.includes("/^\\/api\\/app(?:\\/|$)/")) {
  failures.push('Worker publico nao encaminha o namespace /api/app ao backend');
}
if (!workerRoutes.include?.includes('/api/app/*')) {
  failures.push('_routes.json nao ativa o Worker para /api/app/*');
}
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS manager_installations',
  'CREATE TABLE IF NOT EXISTS manager_health_daily',
  'CREATE TABLE IF NOT EXISTS manager_telemetry_daily',
  'usageTelemetryOptional: true',
  'operationalPresenceRequired: true',
  'sequence <= EXCLUDED.sequence',
  "entry.transport === 'relay-websocket'",
  "entry.lastKind === 'sync'",
]) {
  if (!manager.includes(fragment)) failures.push(`observabilidade ausente: ${fragment}`);
}

if (failures.length) {
  console.error('Falha na auditoria da integracao:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log([
  'Auditoria da integracao aprovada.',
  `${modules.length} modulos do backend com sintaxe valida.`,
  'WebSocket, entrega entre instancias, relay em memoria e ACKs confiaveis presentes.',
].join('\n'));
