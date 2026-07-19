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
const requiredFragments = [
  "pathname === '/api/app/ws'",
  "url.pathname !== '/api/app/remote/ws'",
  "message.kind === 'whitelist-ack'",
  "app.post('/api/app/whitelist-ack'",
  'const remoteRelayWsRooms = new Map()',
  'const remoteRelayHttpWaiters = new Map()',
  'async function processAppSyncPayload',
  'APP_KEY_LAST_USED_WRITE_MS',
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

if (failures.length) {
  console.error('Falha na auditoria da integracao:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log([
  'Auditoria da integracao aprovada.',
  `${modules.length} modulos do backend com sintaxe valida.`,
  'WebSocket, relay em memoria e ACK confiavel da whitelist presentes.',
].join('\n'));
