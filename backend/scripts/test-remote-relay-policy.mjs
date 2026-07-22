import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
const registerRoute = source.match(/app\.post\('\/api\/app\/remote\/relay\/register'[\s\S]*?RETURNING room_id, expires_at`/);

assert.ok(registerRoute, 'rota de registro do relay remoto deve existir');
assert.ok(
  /app_remote_relay_rooms\.host_token_hash=EXCLUDED\.host_token_hash/.test(registerRoute[0]),
  'registro deve continuar aceitando o mesmo token do host',
);
assert.ok(
  /app_remote_relay_rooms\.expires_at <= NOW\(\)/.test(registerRoute[0]),
  'registro deve continuar recuperando salas expiradas',
);
assert.ok(
  /app_remote_relay_rooms\.app_key_id IS NOT NULL[\s\S]*EXCLUDED\.app_key_id IS NOT NULL[\s\S]*app_remote_relay_rooms\.app_key_id=EXCLUDED\.app_key_id/.test(registerRoute[0]),
  'registro deve permitir recuperacao da sala pela mesma App Key',
);

console.log('remote relay policy: ok');
