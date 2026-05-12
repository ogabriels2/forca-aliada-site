/**

- Força Aliada – Backend API  (server.mjs)
- ─────────────────────────────────────────
- Stack : Node.js (ESM) + Express + PostgreSQL + JWT + bcrypt
- 
- Novidades nesta versão
- ──────────────────────
- • Sistema completo de Notificações
   - Criar notificação (admin/owner)
   - Envio público, por role, por minecraft_name ou para usuário específico
   - Marcar lida / marcar todas lidas
   - Listar com badge de não-lidas
- • Logs de Auditoria
   - Registra automaticamente: login, criação, edição, exclusão de contas,
     envio de notificações, alteração de senha (owner/full)
   - Endpoint GET /api/admin/audit com paginação e filtro por tipo
- • Notas de Jogadores (server-side)
   - CRUD de notas por minecraft_name, vinculadas ao autor
- • Jogadores Não-Registrados
   - GET /api/players/unregistered  – lista players com sessões mas sem conta
- • Preferências do Usuário (server-side)
   - GET / PUT /api/me/preferences
- • Todas as rotas que o account.html e dashboard.html consomem
   mas não tinham endpoint real

*/

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const PROCESS_STARTED_AT = new Date();

// ─────────────────────────────────────────────
// App
// ─────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// CORS
const defaultCorsOrigins = [
  'https://forcaaliada.ogabriels.com',
  'https://forca-aliada-site.vercel.app',
  'https://forca-aliada-site.onrender.com',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const corsOrigins = Array.from(new Set([
  ...defaultCorsOrigins,
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    // Libera se estiver na lista explícita ou se for um domínio github.io
    if (corsOrigins.includes(origin) || origin.endsWith('.github.io')) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Ingest-Secret'],
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.PG_SSL_NO_VERIFY === 'true' ? { rejectUnauthorized: false } : undefined,
});

// ─────────────────────────────────────────────
// Env guards
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32)
throw new Error('JWT_SECRET must be at least 32 chars');

const INGEST_SECRET = process.env.INGEST_SECRET;
if (!INGEST_SECRET || INGEST_SECRET.length < 16)
throw new Error('INGEST_SECRET must be at least 16 chars');

// ─────────────────────────────────────────────
// Rate limiters
// ─────────────────────────────────────────────
const authLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3,  standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente mais tarde.' } });

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function sanitize(v)            { return String(v || '').replace(/[<>]/g, '').trim(); }
function validateEmail(e)       { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function validatePassword(p)    { return typeof p === 'string' && p.length >= 8 && p.length <= 128; }
function validateUsername(u)    { return /^[a-z0-9_]{3,32}$/i.test(u); }

// ─────────────────────────────────────────────
// E-mail (Resend)
// ─────────────────────────────────────────────
async function sendSystemEmail(email, username, code, type = 'verify') {
const key = process.env.RESEND_API_KEY;
if (!key) {
console.log(`\n[DEV] email→${email}  code→${code}  type→${type}\n`);
return;
}
const from    = process.env.EMAIL_FROM || 'no-reply@ogabriels.com';
const subject = type === 'verify' ? 'Verifique sua conta' : 'Código de Recuperação';
const title   = type === 'verify' ? 'Bem-vindo à Força Aliada!' : 'Força Aliada';
const sub     = type === 'verify'
? 'Use o código abaixo para ativar o seu cadastro:'
: 'Utilize o código de 6 dígitos abaixo no site:';
const html = ` <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e5ea;border-radius:12px;"> <h2 style="color:#1d1d1f;">${title}</h2> <p style="color:#1d1d1f;">Olá <strong>${username}</strong>,</p> <p style="color:#86868b;">${sub}</p> <div style="background:#f2f2f7;padding:16px;border-radius:8px;text-align:center;margin:24px 0;"> <strong style="font-size:32px;letter-spacing:4px;color:#0071e3;">${code}</strong> </div> <p style="color:#86868b;font-size:13px;">Este código expira em 15 minutos.</p> </div>`;
try {
await fetch('https://api.resend.com/emails', {
method: 'POST',
headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
body: JSON.stringify({ from, to: email, subject, html }),
});
} catch (e) { console.error('[email]', e); }
}

// ─────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────
async function migrate() {
const migrationStatements = [
  "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, minecraft_name VARCHAR(255), photo_url VARCHAR(255) DEFAULT 'logo.JPG', password_hash VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'limited', is_verified BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT TRUE",
  "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check",
  "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','full','limited'))",

  "CREATE TABLE IF NOT EXISTS player_sessions (id SERIAL PRIMARY KEY, player VARCHAR(255) NOT NULL, entered_at TIMESTAMPTZ NOT NULL, left_at TIMESTAMPTZ, duration_hours FLOAT)",
  "ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS duration_hours FLOAT",
  "CREATE INDEX IF NOT EXISTS idx_player_name ON player_sessions(player)",
  "CREATE INDEX IF NOT EXISTS idx_player_left_at ON player_sessions(left_at DESC)",

  "CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, code VARCHAR(6) NOT NULL, expires_at TIMESTAMPTZ NOT NULL)",
  "CREATE TABLE IF NOT EXISTS email_verifications (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, code VARCHAR(6) NOT NULL, expires_at TIMESTAMPTZ NOT NULL)",

  "CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL, body TEXT NOT NULL, type VARCHAR(50) NOT NULL DEFAULT 'info', icon VARCHAR(20) DEFAULT '🔔', audience VARCHAR(20) NOT NULL DEFAULT 'all', audience_val TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW())",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title VARCHAR(255)",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body TEXT",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'info'",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS icon VARCHAR(20) DEFAULT '🔔'",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience VARCHAR(20) DEFAULT 'all'",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience_val TEXT",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL",
  "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",

  "CREATE TABLE IF NOT EXISTS notification_reads (notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, read_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (notification_id, user_id))",

  "CREATE TABLE IF NOT EXISTS audit_logs (id SERIAL PRIMARY KEY, actor_id INTEGER, actor_name VARCHAR(255), type VARCHAR(50) DEFAULT 'system', target_id INTEGER, target_name VARCHAR(255), message TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW())",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'system'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS message TEXT",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
  "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs(type)",

  "CREATE TABLE IF NOT EXISTS player_notes (id SERIAL PRIMARY KEY, minecraft_name VARCHAR(255) NOT NULL, author_id INTEGER REFERENCES users(id) ON DELETE SET NULL, author_name VARCHAR(255), text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())",
  "CREATE INDEX IF NOT EXISTS idx_notes_mc ON player_notes(LOWER(minecraft_name))",

  "CREATE TABLE IF NOT EXISTS user_preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email_server BOOLEAN DEFAULT TRUE, email_events BOOLEAN DEFAULT TRUE, email_community BOOLEAN DEFAULT TRUE, public_profile BOOLEAN DEFAULT TRUE, show_online BOOLEAN DEFAULT TRUE, public_history BOOLEAN DEFAULT FALSE, theme VARCHAR(20) DEFAULT 'auto', updated_at TIMESTAMPTZ DEFAULT NOW())",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS email_server BOOLEAN DEFAULT TRUE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS email_events BOOLEAN DEFAULT TRUE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS email_community BOOLEAN DEFAULT TRUE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS public_profile BOOLEAN DEFAULT TRUE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS show_online BOOLEAN DEFAULT TRUE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS public_history BOOLEAN DEFAULT FALSE",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'auto'",
  "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
  "ALTER TABLE user_preferences ALTER COLUMN theme SET DEFAULT 'auto'",

  "CREATE TABLE IF NOT EXISTS player_balances (minecraft_name VARCHAR(255) PRIMARY KEY, merit_total INTEGER NOT NULL DEFAULT 0, capital_balance FLOAT NOT NULL DEFAULT 0, rank VARCHAR(50) NOT NULL DEFAULT 'ferro', updated_at TIMESTAMPTZ DEFAULT NOW())",
  "CREATE INDEX IF NOT EXISTS idx_balances_merit ON player_balances(merit_total DESC)",

  "CREATE TABLE IF NOT EXISTS merit_records (id SERIAL PRIMARY KEY, minecraft_name VARCHAR(255) NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, category VARCHAR(50) NOT NULL DEFAULT 'outros', awarded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL, awarded_by_name VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW())",
  "CREATE INDEX IF NOT EXISTS idx_merit_mc ON merit_records(LOWER(minecraft_name))",
  "CREATE INDEX IF NOT EXISTS idx_merit_created ON merit_records(created_at DESC)",

  "CREATE TABLE IF NOT EXISTS capital_records (id SERIAL PRIMARY KEY, minecraft_name VARCHAR(255) NOT NULL, amount FLOAT NOT NULL, type VARCHAR(50) NOT NULL DEFAULT 'ajuste', description TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_by_name VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW())",
  "ALTER TABLE capital_records ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'ajuste'",
  "CREATE INDEX IF NOT EXISTS idx_capital_mc ON capital_records(LOWER(minecraft_name))",

  "CREATE TABLE IF NOT EXISTS server_status_checks (id SERIAL PRIMARY KEY, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), host VARCHAR(255) NOT NULL, online BOOLEAN NOT NULL, players_online INTEGER DEFAULT 0, players_max INTEGER DEFAULT 0, latency_ms INTEGER, version VARCHAR(255))",
  "CREATE INDEX IF NOT EXISTS idx_server_status_checked ON server_status_checks(checked_at DESC)",
];

for (const statement of migrationStatements) {
  try {
    await pool.query(statement);
  } catch (error) {
    console.error('[migrate statement failed]', statement);
    throw error;
  }
}
}

// ─────────────────────────────────────────────
// Seed admin
// ─────────────────────────────────────────────
async function seedAdmin() {
const u = sanitize(process.env.BOOTSTRAP_ADMIN_USERNAME);
const e = sanitize(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
const p = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
if (!u || !e || !p) return;
const { rows } = await pool.query('SELECT id FROM users WHERE username=$1', [u.toLowerCase()]);
if (rows.length) return;
const hash = await bcrypt.hash(p, 12);
await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,TRUE)',
[u.toLowerCase(), e, u, hash, 'owner'],
);
console.log('[seed] admin created:', u.toLowerCase());
}

// ─────────────────────────────────────────────
// Audit helper
// ─────────────────────────────────────────────
async function audit({ actorId, actorName, type, targetId, targetName, message, metadata }) {
try {
await pool.query(
`INSERT INTO audit_logs(actor_id,actor_name,type,target_id,target_name,message,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`,
[actorId || null, actorName || null, type, targetId || null, targetName || null,
message || null, metadata ? JSON.stringify(metadata) : null],
);
} catch (e) { console.error('[audit]', e); }
}

// ─────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────
async function auth(req, res, next) {
const token = (req.headers.authorization || '').replace('Bearer ', '');
if (!token) return res.status(401).json({ error: 'missing token' });
try {
const decoded = jwt.verify(token, JWT_SECRET);
const { rows } = await pool.query(
'SELECT id, role, is_verified, minecraft_name, username FROM users WHERE id=$1',
[decoded.sub],
);
if (!rows.length) return res.status(401).json({ error: 'user deleted' });
req.user = rows[0];
req.user.sub = rows[0].id;
next();
} catch { res.status(401).json({ error: 'invalid token' }); }
}

function requireAdmin(req, res, next) {
if (!['full', 'owner'].includes(req.user?.role))
return res.status(403).json({ error: 'forbidden' });
next();
}

function requireOwner(req, res, next) {
if (req.user?.role !== 'owner')
return res.status(403).json({ error: 'forbidden' });
next();
}

// ─────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) }));

async function fetchMinecraftStatus() {
  const host = process.env.MC_HOST || 'fa.ogabriels.com';
  const started = Date.now();
  const resp = await fetch(`https://api.mcstatus.io/v2/status/java/${host}`, {
    headers: { 'User-Agent': 'forca-aliada-backend/2.0' },
  });
  if (!resp.ok) throw new Error(`mcstatus failed: ${resp.status}`);
  const data = await resp.json();
  const latencyMs = Math.max(0, Date.now() - started);
  const onlinePlayers = (data?.players?.list || [])
    .map(p => p.name_clean || p.name_raw || p.name)
    .filter(Boolean);

  return {
    host,
    checkedAt: new Date(),
    online: Boolean(data?.online),
    version: data?.version?.name_clean || data?.version?.name_raw || data?.version?.name || null,
    players: {
      online: Number(data?.players?.online || onlinePlayers.length || 0),
      max: Number(data?.players?.max || 0),
      list: onlinePlayers,
    },
    latencyMs,
    raw: data,
  };
}

async function recordServerStatus(status) {
  await pool.query(
    'INSERT INTO server_status_checks(host, online, players_online, players_max, latency_ms, version, checked_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [status.host, status.online, status.players.online, status.players.max, status.latencyMs, status.version, status.checkedAt],
  );
}

async function getServerStatusStats(host, currentOnline) {
  const { rows: uptimeRows } = await pool.query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN online THEN 1 ELSE 0 END), 0)::int AS online
     FROM server_status_checks
     WHERE host=$1 AND checked_at >= NOW() - INTERVAL '24 hours'`,
    [host],
  );
  const total = uptimeRows[0]?.total || 0;
  const uptime24hPct = total > 0 ? Math.round(((uptimeRows[0].online || 0) / total) * 100) : (currentOnline ? 100 : 0);

  let onlineSince = null;
  if (currentOnline) {
    const { rows: offlineRows } = await pool.query(
      'SELECT checked_at FROM server_status_checks WHERE host=$1 AND online=FALSE ORDER BY checked_at DESC LIMIT 1',
      [host],
    );
    const params = offlineRows.length ? [host, offlineRows[0].checked_at] : [host];
    const query = offlineRows.length
      ? 'SELECT MIN(checked_at) AS since FROM server_status_checks WHERE host=$1 AND online=TRUE AND checked_at > $2'
      : 'SELECT MIN(checked_at) AS since FROM server_status_checks WHERE host=$1 AND online=TRUE';
    const { rows } = await pool.query(query, params);
    onlineSince = rows[0]?.since || null;
  }

  return { uptime24hPct, onlineSince, samples24h: total };
}

// ─────────────────────────────────────────────
// Status real do servidor para o dashboard
// ─────────────────────────────────────────────
app.get('/api/server/status', auth, requireAdmin, async (_req, res) => {
  const host = process.env.MC_HOST || 'fa.ogabriels.com';
  try {
    const status = await fetchMinecraftStatus();
    await recordServerStatus(status);
    const stats = await getServerStatusStats(status.host, status.online);
    return res.json({
      checked_at: status.checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      minecraft: {
        host: status.host,
        online: status.online,
        version: status.version,
        players: { online: status.players.online, max: status.players.max, list: status.players.list },
        latencyMs: status.latencyMs,
        onlineSince: stats.onlineSince,
        uptime24hPct: stats.uptime24hPct,
        samples24h: stats.samples24h,
      },
    });
  } catch (err) {
    console.error('[server status]', err);
    const checkedAt = new Date();
    const fallback = { host, checkedAt, online: false, version: null, players: { online: 0, max: 0, list: [] }, latencyMs: null };
    await recordServerStatus(fallback).catch(e => console.error('[server status record]', e));
    const stats = await getServerStatusStats(host, false).catch(() => ({ uptime24hPct: 0, onlineSince: null, samples24h: 0 }));
    return res.json({
      checked_at: checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      minecraft: { ...fallback, checkedAt: undefined, onlineSince: null, uptime24hPct: stats.uptime24hPct, samples24h: stats.samples24h, error: 'status unavailable' },
    });
  }
});

// ─────────────────────────────────────────────
// Cron – Minecraft snapshot
// ─────────────────────────────────────────────
app.get('/api/cron', async (req, res) => {
const key = req.query.key || req.headers['x-ingest-secret'];
if (key !== INGEST_SECRET) return res.status(403).json({ error: 'forbidden' });

try {
const status = await fetchMinecraftStatus();
await recordServerStatus(status);
const onlinePlayers = status.players.list;
const now = status.checkedAt;

const active = await pool.query(
  'SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL',
);

for (const row of active.rows) {
  if (!onlinePlayers.includes(row.player)) {
    const dur = (now - new Date(row.entered_at)) / 3600000;
    await pool.query(
      'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
      [now, +dur.toFixed(2), row.player],
    );
  }
}

for (const p of onlinePlayers) {
  const already = active.rows.some(r => r.player === p);
  if (!already)
    await pool.query('INSERT INTO player_sessions(player,entered_at) VALUES($1,$2)', [p, now]);
}

res.json({ ok: true, online: onlinePlayers.length });

} catch (err) {
console.error('[cron]', err);
res.status(500).json({ error: 'snapshot failed' });
}
});

// ─────────────────────────────────────────────
// Ingest (monitor.mjs)
// ─────────────────────────────────────────────
app.post('/api/snapshots/import', async (req, res) => {
const key = req.headers['x-ingest-secret'];
if (key !== INGEST_SECRET) return res.status(403).json({ error: 'forbidden' });

try {
const payload  = req.body?.payload || req.body;
const online   = (payload?.onlinePlayers || []).filter(Boolean);
const now      = new Date();

const active   = await pool.query(
  'SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL',
);

for (const row of active.rows) {
  if (!online.includes(row.player)) {
    const dur = (now - new Date(row.entered_at)) / 3600000;
    await pool.query(
      'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
      [now, +dur.toFixed(2), row.player],
    );
  }
}

for (const p of online) {
  const already = active.rows.some(r => r.player === p);
  if (!already)
    await pool.query('INSERT INTO player_sessions(player,entered_at) VALUES($1,$2)', [p, now]);
}

res.json({ ok: true });

} catch (err) {
console.error('[ingest]', err);
res.status(500).json({ error: 'ingest failed' });
}
});

// ─────────────────────────────────────────────
// AUTH – Signup
// ─────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const password      = req.body?.password || '';

if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password))
return res.status(400).json({ error: 'Dados inválidos.' });

try {
const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,FALSE) RETURNING username,id',
[username, email, minecraftName, hash, 'limited'],
);

const code      = Math.floor(100000 + Math.random() * 900000).toString();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('DELETE FROM email_verifications WHERE email=$1', [email]);
await pool.query(
  'INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)',
  [email, code, expiresAt],
);
await sendSystemEmail(email, rows[0].username, code, 'verify');

// Audit
await audit({ type: 'create', targetId: rows[0].id, targetName: username, message: `Conta criada: ${username}` });

res.json({ ok: true, requireVerification: true, email });

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

// ─────────────────────────────────────────────
// AUTH – Verify email
// ─────────────────────────────────────────────
app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
const email = sanitize(req.body?.email).toLowerCase();
const code  = sanitize(req.body?.code);

if (!validateEmail(email) || !code)
return res.status(400).json({ error: 'Dados inválidos' });

const { rows: ver } = await pool.query(
'SELECT * FROM email_verifications WHERE email=$1 AND code=$2 AND expires_at>NOW()',
[email, code],
);
if (!ver.length) return res.status(400).json({ error: 'Código inválido ou expirado.' });

const { rows: updated } = await pool.query(
'UPDATE users SET is_verified=TRUE WHERE email=$1 RETURNING *',
[email],
);
await pool.query('DELETE FROM email_verifications WHERE email=$1', [email]);

const user = updated[0];
if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
res.json({ token, user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, role: user.role } });
});

// ─────────────────────────────────────────────
// AUTH – Login
// ─────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
const login    = sanitize(req.body?.login).toLowerCase();
const password = req.body?.password || '';
if (!login || !password) return res.status(400).json({ error: 'missing fields' });

const { rows } = await pool.query(
'SELECT * FROM users WHERE username=$1 OR email=$1', [login],
);
const user = rows[0];
if (!user || !(await bcrypt.compare(password, user.password_hash)))
return res.status(401).json({ error: 'invalid credentials' });

if (user.is_verified === false) {
const code      = Math.floor(100000 + Math.random() * 900000).toString();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('DELETE FROM email_verifications WHERE email=$1', [user.email]);
await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [user.email, code, expiresAt]);
await sendSystemEmail(user.email, user.username, code, 'verify');
return res.status(403).json({ error: 'unverified_email', email: user.email });
}

// Audit login
await audit({ actorId: user.id, actorName: user.username, type: 'login', message: `${user.username} fez login no painel` });

const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
res.json({
token,
user: {
username: user.username, email: user.email,
minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role,
},
});
});

// ─────────────────────────────────────────────
// AUTH – Forgot / Reset password
// ─────────────────────────────────────────────
app.post('/api/auth/forgot-password', emailLimiter, async (req, res) => {
const email = sanitize(req.body?.email).toLowerCase();
if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

await pool.query('DELETE FROM password_resets WHERE email=$1 OR expires_at<NOW()', [email]);
const { rows } = await pool.query('SELECT username FROM users WHERE email=$1', [email]);
if (!rows.length) return res.json({ ok: true }); // security: don't reveal existence

const code      = Math.floor(100000 + Math.random() * 900000).toString();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('INSERT INTO password_resets(email,code,expires_at) VALUES($1,$2,$3)', [email, code, expiresAt]);
await sendSystemEmail(email, rows[0].username, code, 'reset');
res.json({ ok: true });
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
const email       = sanitize(req.body?.email).toLowerCase();
const code        = sanitize(req.body?.code);
const newPassword = req.body?.newPassword;

if (!validateEmail(email) || !code || !validatePassword(newPassword))
return res.status(400).json({ error: 'Dados inválidos' });

const { rows } = await pool.query(
'SELECT * FROM password_resets WHERE email=$1 AND code=$2 AND expires_at>NOW()',
[email, code],
);
if (!rows.length) return res.status(400).json({ error: 'Código inválido ou expirado' });

const hash = await bcrypt.hash(newPassword, 12);
await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, email]);
await pool.query('DELETE FROM password_resets WHERE email=$1', [email]);
res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
// ME – Perfil
// ─────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, minecraft_name, photo_url, role, is_verified, created_at FROM users WHERE id=$1',
      [req.user.sub],
    );
    if (!rows.length) return res.status(401).json({ error: 'user deleted' });
    res.json(rows[0]);
  } catch (error) {
    console.error('[GET /api/me error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/me', auth, async (req, res) => {
const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const currentPassword = req.body?.currentPassword || '';

if (!validateUsername(username) || !validateEmail(email))
return res.status(400).json({ error: 'Dados inválidos' });

const { rows } = await pool.query('SELECT password_hash, username, email FROM users WHERE id=$1', [req.user.sub]);
if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid current password' });

try {
await pool.query(
'UPDATE users SET username=$1, email=$2, minecraft_name=$3 WHERE id=$4',
[username, email, minecraftName, req.user.sub],
);

await audit({
  actorId: req.user.sub, actorName: req.user.username,
  type: 'update', targetId: req.user.sub, targetName: username,
  message: `Perfil atualizado: ${rows[0].username} → ${username}`,
});

res.json({ ok: true });

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

// ME – Alterar senha
async function changeMyPassword(req, res) {
const currentPassword = req.body?.currentPassword || '';
const newPassword     = req.body?.newPassword || '';
if (!validatePassword(newPassword))
return res.status(400).json({ error: 'invalid new password' });

const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.sub]);
if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid current password' });

const hash = await bcrypt.hash(newPassword, 12);
await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.sub]);

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'update', targetId: req.user.sub,
message: `${req.user.username} alterou sua senha`,
});

res.json({ ok: true });
}
app.post('/api/me/password', auth, changeMyPassword);
app.put('/api/me/password',  auth, changeMyPassword);

// ME – Deletar conta
app.delete('/api/me', auth, async (req, res) => {
const email    = sanitize(req.body?.email).toLowerCase();
const password = req.body?.password || '';

const { rows } = await pool.query('SELECT email, password_hash, username FROM users WHERE id=$1', [req.user.sub]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });
if (rows[0].email !== email) return res.status(400).json({ error: 'email mismatch' });
if (!(await bcrypt.compare(password, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid password' });

await audit({
actorId: req.user.sub, actorName: rows[0].username,
type: 'delete', targetId: req.user.sub, targetName: rows[0].username,
message: `Conta excluída: ${rows[0].username}`,
});

await pool.query('DELETE FROM users WHERE id=$1', [req.user.sub]);
res.json({ ok: true });
});

// ME – Histórico Minecraft
app.get('/api/me/history', auth, async (req, res) => {
if (!req.user.minecraft_name)
return res.json({ history: [], activeSession: null });

const mc = req.user.minecraft_name.toLowerCase();
const hist = await pool.query(
'SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE LOWER(player)=$1 AND left_at IS NOT NULL ORDER BY entered_at DESC',
[mc],
);
const active = await pool.query(
'SELECT entered_at FROM player_sessions WHERE LOWER(player)=$1 AND left_at IS NULL',
[mc],
);

res.json({
history:       hist.rows,
activeSession: active.rows[0]?.entered_at || null,
});
});

// ─────────────────────────────────────────────
// ME – Preferências (server-side)
// ─────────────────────────────────────────────
const DEFAULT_PREFERENCES = Object.freeze({
  email_server: true,
  email_events: true,
  email_community: true,
  public_profile: true,
  show_online: true,
  public_history: false,
  theme: 'auto',
});
const ALLOWED_THEMES = new Set(['light', 'dark', 'auto']);

function normalizePreferences(input = {}) {
  const prefs = { ...DEFAULT_PREFERENCES };
  for (const key of ['email_server', 'email_events', 'email_community', 'public_profile', 'show_online', 'public_history']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) prefs[key] = Boolean(input[key]);
  }
  if (ALLOWED_THEMES.has(input.theme)) prefs.theme = input.theme;
  return prefs;
}

async function ensureUserPreferences(userId, overrides = {}) {
  const prefs = normalizePreferences(overrides);
  const { rows } = await pool.query(
    `INSERT INTO user_preferences(user_id,email_server,email_events,email_community,public_profile,show_online,public_history,theme,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       email_server=$2,
       email_events=$3,
       email_community=$4,
       public_profile=$5,
       show_online=$6,
       public_history=$7,
       theme=$8,
       updated_at=NOW()
     RETURNING email_server,email_events,email_community,public_profile,show_online,public_history,theme,updated_at`,
    [userId, prefs.email_server, prefs.email_events, prefs.email_community, prefs.public_profile, prefs.show_online, prefs.public_history, prefs.theme],
  );
  return rows[0];
}

app.get('/api/me/preferences', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email_server,email_events,email_community,public_profile,show_online,public_history,theme,updated_at FROM user_preferences WHERE user_id=$1',
    [req.user.sub],
  );
  if (rows.length) return res.json(normalizePreferences(rows[0]));
  const prefs = await ensureUserPreferences(req.user.sub);
  res.json(normalizePreferences(prefs));
});

app.put('/api/me/preferences', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email_server,email_events,email_community,public_profile,show_online,public_history,theme FROM user_preferences WHERE user_id=$1',
    [req.user.sub],
  );
  const prefs = await ensureUserPreferences(req.user.sub, { ...(rows[0] || {}), ...(req.body || {}) });
  await audit({
    actorId: req.user.sub,
    actorName: req.user.username,
    type: 'update',
    targetId: req.user.sub,
    targetName: req.user.username,
    message: 'Preferências da conta atualizadas',
    metadata: { preferences: normalizePreferences(prefs) },
  });
  res.json(normalizePreferences(prefs));
});

// ─────────────────────────────────────────────
// NOTIFICAÇÕES
// ─────────────────────────────────────────────

/**

- GET /api/notifications
- Retorna notificações relevantes para o usuário autenticado.
- Inclui campo `is_read` e metadados.
  */
  app.get('/api/notifications', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, (nr.user_id IS NOT NULL) AS is_read FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 WHERE n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) ORDER BY n.created_at DESC LIMIT 100`, [userId, role, String(userId), mc]);

res.json(rows);
});

/**

- GET /api/notifications/unread-count
- Contagem de não-lidas (para badge).
  */
  app.get('/api/notifications/unread-count', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 WHERE nr.user_id IS NULL AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) )`, [userId, role, String(userId), mc]);

res.json({ count: rows[0].count });
});

/**

- POST /api/notifications/:id/read
- Marca uma notificação como lida.
  */
  app.post('/api/notifications/:id/read', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  const visible = await pool.query(
    `SELECT id FROM notifications
     WHERE id=$1 AND (
       audience='all'
       OR (audience='role' AND audience_val=$2)
       OR (audience='user' AND audience_val=$3::text)
       OR (audience='minecraft' AND LOWER(audience_val)=$4)
     )`,
    [id, role, String(req.user.sub), mc],
  );
  if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });

  await pool.query(`INSERT INTO notification_reads(notification_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);

  res.json({ ok: true });
});

/**

- POST /api/notifications/read-all
- Marca todas as notificações visíveis como lidas.
  */
  app.post('/api/notifications/read-all', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

await pool.query(`INSERT INTO notification_reads(notification_id, user_id) SELECT n.id, $1 FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 WHERE nr.user_id IS NULL AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) ) ON CONFLICT DO NOTHING`, [userId, role, String(userId), mc]);

res.json({ ok: true });
});

/**

- POST /api/admin/notifications
- Cria uma nova notificação.
- 
- Body:
- {
- title        : string  (obrigatório)
- body         : string  (obrigatório)
- type         : 'info' | 'event' | 'system' | 'social' | 'warning'
- icon         : string emoji
- audience     : 'all' | 'role' | 'user' | 'minecraft'
- audience_val : valor dependente do audience
               - role:      'owner' | 'full' | 'limited'
               - user:      id numérico (string)
               - minecraft: nome do jogador
               - all:       ignorado
- }
  */
  app.post('/api/admin/notifications', auth, requireAdmin, async (req, res) => {
  try {
    const title       = sanitize(req.body?.title);
    const body        = sanitize(req.body?.body);
    const type        = ['info','event','system','social','warning'].includes(req.body?.type) ? req.body.type : 'info';
    const icon        = sanitize(req.body?.icon || '🔔').slice(0, 10);
    const audience    = ['all','role','user','minecraft'].includes(req.body?.audience) ? req.body.audience : 'all';
    const audienceVal = req.body?.audience_val ? sanitize(String(req.body.audience_val)) : null;

    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    if (audience === 'role' && !['owner','full','limited'].includes(audienceVal)) return res.status(400).json({ error: 'invalid role' });
    if (audience === 'user') {
      const uid = parseInt(audienceVal);
      if (!uid) return res.status(400).json({ error: 'invalid user id' });
      const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [uid]);
      if (!rows.length) return res.status(404).json({ error: 'user not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, body, type, icon, audience, audienceVal, req.user.sub],
    );

    await audit({
      actorId: req.user.sub, actorName: req.user.username, type: 'notify',
      message: `Notificação criada: "${title}"`, metadata: { notificationId: rows[0].id },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[notification post error]', err);
    res.status(500).json({ error: 'Erro ao criar notificação' });
  }
});

/**

- GET /api/admin/notifications
- Lista todas as notificações com contagem de leituras (admin).
  */
  app.get('/api/admin/notifications', auth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, COUNT(nr.user_id)::int AS read_count FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id GROUP BY n.id, u.username ORDER BY n.created_at DESC  `);
  res.json(rows);
  });

/**

- DELETE /api/admin/notifications/:id
- Remove uma notificação (owner only).
  */
  app.delete('/api/admin/notifications/:id', auth, requireOwner, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

const { rowCount } = await pool.query('DELETE FROM notifications WHERE id=$1', [id]);
if (!rowCount) return res.status(404).json({ error: 'not found' });

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'delete', message: `Notificação #${id} excluída`,
});

res.json({ ok: true });
});

// ─────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────

/**

- GET /api/admin/audit
- Parâmetros: ?type=all|create|update|delete|login|notify&page=0&limit=50
  */
  app.get('/api/admin/audit', auth, requireAdmin, async (req, res) => {
    try {
      const type  = req.query.type && req.query.type !== 'all' ? req.query.type : null;
      const page  = Math.max(0, parseInt(req.query.page  || 0));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));

      const where  = type ? 'WHERE type=$1' : '';
      const params = type ? [type, limit, page * limit] : [limit, page * limit];
      const offset = type ? 3 : 2;

      const listSql = 'SELECT id, actor_id, actor_name, type, target_id, target_name, message, metadata, created_at FROM audit_logs '
        + where
        + ' ORDER BY created_at DESC LIMIT $'
        + (offset - 1)
        + ' OFFSET $'
        + offset;
      const countSql = 'SELECT COUNT(*)::int AS count FROM audit_logs ' + where;

      const { rows } = await pool.query(listSql, params);
      const { rows: total } = await pool.query(countSql, type ? [type] : []);

      res.json({ logs: rows, total: total[0].count });
    } catch (error) {
      console.error('[GET /api/admin/audit error]', error);
      res.status(500).json({ error: 'Erro interno ao carregar logs' });
    }
  });

// ─────────────────────────────────────────────
// NOTAS DE JOGADORES
// ─────────────────────────────────────────────

/**
 * GET /api/admin/notes/:minecraft_name
 */
app.get('/api/admin/notes/:minecraft_name', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.minecraft_name).toLowerCase();
  const { rows } = await pool.query(
    'SELECT * FROM player_notes WHERE LOWER(minecraft_name) = $1 ORDER BY created_at DESC',
    [mc],
  );
  res.json(rows);
});

/**
 * POST /api/admin/notes
 * Body: { minecraft_name: string, text: string }
 */
app.post('/api/admin/notes', auth, requireAdmin, async (req, res) => {
  const { minecraft_name, text } = req.body || {};
  if (!minecraft_name || !text) return res.status(400).json({ error: 'Campos ausentes' });

  const { rows } = await pool.query(
    'INSERT INTO player_notes(minecraft_name, author_id, author_name, text) VALUES($1, $2, $3, $4) RETURNING *',
    [sanitize(minecraft_name), req.user.sub, req.user.username, sanitize(text)],
  );
  res.json(rows[0]);
});

/**
 * DELETE /api/admin/notes/:id
 */
app.delete('/api/admin/notes/:id', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'invalid id' });
  await pool.query('DELETE FROM player_notes WHERE id = $1', [noteId]);
  res.json({ ok: true });
});

/**

- GET /api/player/:name/notes
  */
  app.get('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.name).toLowerCase();
  const { rows } = await pool.query(
  'SELECT id, author_name, text, created_at FROM player_notes WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC',
  [mc],
  );
  res.json(rows);
  });

/**

- POST /api/player/:name/notes
- Body: { text: string }
  */
  app.post('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc   = sanitize(req.params.name);
  const text = sanitize(req.body?.text || '');
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 1000) return res.status(400).json({ error: 'text too long' });

const { rows } = await pool.query(
'INSERT INTO player_notes(minecraft_name,author_id,author_name,text) VALUES($1,$2,$3,$4) RETURNING *',
[mc, req.user.sub, req.user.username, text],
);
res.status(201).json(rows[0]);
});

/**

- DELETE /api/player/:name/notes/:noteId
  */
  app.delete('/api/player/:name/notes/:noteId', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.noteId);
  const mc     = sanitize(req.params.name).toLowerCase();
  if (!noteId) return res.status(400).json({ error: 'invalid id' });

// Owner pode deletar qualquer nota; admin só as suas
const ownClause = req.user.role === 'owner' ? '' : 'AND author_id=$3';
const params    = req.user.role === 'owner'
? [noteId, mc]
: [noteId, mc, req.user.sub];

const { rowCount } = await pool.query(
`DELETE FROM player_notes WHERE id=$1 AND LOWER(minecraft_name)=$2 ${ownClause}`,
params,
);
if (!rowCount) return res.status(404).json({ error: 'note not found or unauthorized' });
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// SNAPSHOTS / HISTÓRICO
// ─────────────────────────────────────────────
app.get('/api/snapshots/latest', auth, requireAdmin, async (req, res) => {
const limit = Math.min(Number(req.query.limit || 500), 2000);

const online  = await pool.query(
'SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL',
);
const history = await pool.query(
'SELECT player, entered_at, left_at, duration_hours FROM player_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT $1',
[limit],
);

res.json({
onlinePlayers: online.rows.map(r => r.player),
activeSessions: online.rows.reduce((acc, r) => ({
...acc, [r.player]: { name: r.player, enteredAt: r.entered_at },
}), {}),
history: history.rows.map(r => ({
player: r.player, enteredAt: r.entered_at,
leftAt: r.left_at, hoursOnline: r.duration_hours,
})),
});
});

// ─────────────────────────────────────────────
// JOGADORES NÃO REGISTRADOS
// ─────────────────────────────────────────────
/**

- GET /api/players/unregistered
- Lista jogadores que têm sessões mas não têm conta vinculada.
- Inclui: total_sessions, total_hours, last_seen, first_seen
  */
  app.get('/api/players/unregistered', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ps.player, COUNT(ps.id)::int AS total_sessions, COALESCE(SUM(ps.duration_hours), 0)::float AS total_hours, MIN(ps.entered_at) AS first_seen, MAX(COALESCE(ps.left_at, ps.entered_at)) AS last_seen 
      FROM player_sessions ps 
      WHERE NOT EXISTS ( SELECT 1 FROM users u WHERE LOWER(u.minecraft_name) = LOWER(ps.player) ) 
      GROUP BY ps.player ORDER BY last_seen DESC LIMIT 500
    `);
    res.json(rows);
  } catch (err) {
    console.error('[unregistered error]', err);
    res.status(500).json({ error: 'Erro ao buscar jogadores' });
  }
});

// ─────────────────────────────────────────────
// HISTÓRICO POR JOGADOR
// ─────────────────────────────────────────────
app.get('/api/player/:name/history', auth, requireAdmin, async (req, res) => {
const mc = sanitize(req.params.name).toLowerCase();
const { rows } = await pool.query(
'SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE LOWER(player)=$1 ORDER BY entered_at DESC',
[mc],
);
res.json(rows);
});

// ─────────────────────────────────────────────
// ADMIN – Gerenciamento de usuários
// ─────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (_req, res) => {
const { rows } = await pool.query(`
  SELECT u.id, u.username, u.email, u.minecraft_name, u.photo_url, u.role, u.is_verified, u.created_at,
    COALESCE(pb.merit_total, 0)     AS merit_total,
    COALESCE(pb.capital_balance, 0) AS capital_balance,
    COALESCE(pb.rank, 'ferro')      AS rank
  FROM users u
  LEFT JOIN player_balances pb ON pb.minecraft_name = LOWER(u.minecraft_name)
  ORDER BY u.id DESC
`);
res.json(rows);
});

app.post('/api/admin/users', auth, requireOwner, async (req, res) => {
const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const password      = req.body?.password || '';
const ALLOWED_ROLES = ['owner','full','limited'];
const role          = ALLOWED_ROLES.includes(req.body?.role) ? req.body.role : 'limited';

if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password))
return res.status(400).json({ error: 'invalid fields' });

try {
const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,TRUE) RETURNING id',
[username, email, minecraftName, hash, role],
);

await audit({
  actorId: req.user.sub, actorName: req.user.username,
  type: 'create', targetId: rows[0].id, targetName: username,
  message: `Conta criada por admin: ${username} (${role})`,
});

res.json(rows[0]);

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

app.put('/api/admin/users/:id', auth, requireOwner, async (req, res) => {
const id            = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });

const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const photoUrl      = sanitize(req.body?.photoUrl || 'logo.JPG');
const ALLOWED_ROLES = ['owner','full','limited'];
const role          = ALLOWED_ROLES.includes(req.body?.role) ? req.body.role : 'limited';

if (!validateUsername(username) || !validateEmail(email))
return res.status(400).json({ error: 'invalid fields' });

try {
const result = await pool.query(
'UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6',
[username, email, minecraftName, photoUrl, role, id],
);
if (!result.rowCount) return res.status(404).json({ error: 'user not found' });

await audit({
  actorId: req.user.sub, actorName: req.user.username,
  type: 'update', targetId: id, targetName: username,
  message: `Conta editada por admin: ${username}`,
});

res.json({ ok: true });

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

app.put('/api/admin/users/:id/password', auth, requireOwner, async (req, res) => {
const id          = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });
const newPassword = req.body?.newPassword || '';
if (!validatePassword(newPassword))
return res.status(400).json({ error: 'invalid new password' });

const { rows: target } = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
if (!target.length) return res.status(404).json({ error: 'user not found' });

const hash = await bcrypt.hash(newPassword, 12);
await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'update', targetId: id, targetName: target[0].username,
message: `Senha redefinida por admin para: ${target[0].username}`,
});

res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, requireOwner, async (req, res) => {
const id = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });

const { rows } = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'delete', targetId: id, targetName: rows[0].username,
message: `Conta deletada por admin: ${rows[0].username}`,
});

await pool.query('DELETE FROM users WHERE id=$1', [id]);
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// SISTEMA DE CAPITAL E MÉRITO
// ─────────────────────────────────────────────

// Mapeamento de cargos por Mérito
const RANKS = [
  { id: 'ferro',     label: 'Ferro',     icon: '🪨', minMerit: 0,    maxMerit: 149,  color: '#8E8E93' },
  { id: 'ouro',      label: 'Ouro',      icon: '🟡', minMerit: 150,  maxMerit: 499,  color: '#FF9F0A' },
  { id: 'diamante',  label: 'Diamante',  icon: '🟢', minMerit: 500,  maxMerit: 999,  color: '#30D158' },
  { id: 'netherite', label: 'Netherite', icon: '⚫', minMerit: 1000, maxMerit: null, color: '#AF52DE' },
];
const ADM_RANK = { id: 'adm', label: 'Administrador', icon: '👑', minMerit: null, maxMerit: null, color: '#0071E3' };

function getRankByMerit(merit) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (merit >= RANKS[i].minMerit) return RANKS[i];
  }
  return RANKS[0];
}

function getRankById(id) {
  if (id === 'adm') return ADM_RANK;
  return RANKS.find(r => r.id === id) || RANKS[0];
}

const RANK_BENEFITS = {
  ferro:     ['Cargo inicial', 'Limite de saque: 64 💰 (1 pack)', 'Acesso padrão ao servidor'],
  ouro:      ['Participação em votações', 'Limite de saque: 128 💰 (2 packs)', 'Menor taxa de juros em empréstimos', 'Acesso à playlist musical no Discord'],
  diamante:  ['Participação em votações', 'Limite de saque: 192 💰 (3 packs)', 'Taxa de juros reduzida', 'Publicação na wiki do servidor'],
  netherite: ['Participação em votações', 'Limite de saque: 320 💰 (5 packs)', 'Taxa de juros mínima', 'Publicação na wiki do servidor', 'Cartão Netherite no Banco'],
  adm:       ['Cargo administrativo', 'Independente do sistema de Mérito', 'Acesso total ao painel'],
};

// Recalcula e persiste o rank de um jogador dado o total de mérito
async function recalcRank(mcName, meritTotal) {
  const rank = getRankByMerit(meritTotal);
  await pool.query(`
    INSERT INTO player_balances(minecraft_name, merit_total, rank, updated_at)
    VALUES($1, $2, $3, NOW())
    ON CONFLICT(minecraft_name) DO UPDATE SET
      merit_total = $2, rank = $3, updated_at = NOW()
  `, [mcName.toLowerCase(), meritTotal, rank.id]);
  return rank;
}

// Garante que um jogador tem registro em player_balances
async function ensureBalance(mcName) {
  const mc = mcName.toLowerCase();
  await pool.query(`
    INSERT INTO player_balances(minecraft_name, merit_total, capital_balance, rank)
    VALUES($1, 0, 0, 'ferro')
    ON CONFLICT(minecraft_name) DO NOTHING
  `, [mc]);
  const { rows } = await pool.query('SELECT * FROM player_balances WHERE minecraft_name=$1', [mc]);
  return rows[0];
}

// ── GET /api/me/merit ─────────────────────────────────────
// Retorna saldo de Mérito, cargo e histórico do jogador logado
app.get('/api/me/merit', auth, async (req, res) => {
  if (!req.user.minecraft_name)
    return res.json({ merit: 0, rank: RANKS[0], nextRank: RANKS[1], progress: 0, records: [] });

  const mc = req.user.minecraft_name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100',
    [mc]
  );

  const merit = balance.merit_total;
  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit,
    rank: { ...rank, benefits: RANK_BENEFITS[rank.id] || [] },
    nextRank: nextRank ? { ...nextRank, benefits: RANK_BENEFITS[nextRank.id] || [] } : null,
    progress,
    records,
  });
});

// ── GET /api/me/capital ───────────────────────────────────
app.get('/api/me/capital', auth, async (req, res) => {
  if (!req.user.minecraft_name)
    return res.json({ capital: 0, records: [] });

  const mc = req.user.minecraft_name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, type, description, created_by_name, created_at FROM capital_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100',
    [mc]
  );

  res.json({ capital: balance.capital_balance, records });
});

// ── GET /api/me/rank-info ─────────────────────────────────
// Retorna cargo atual, progresso e todos os ranks (para UI)
app.get('/api/me/rank-info', auth, async (req, res) => {
  const mc = req.user.minecraft_name?.toLowerCase();
  let merit = 0;
  let rankId = 'ferro';
  
  // Se for staff, usa o rank administrativo
  if (['owner', 'full'].includes(req.user.role)) {
    return res.json({
      merit: null,
      rank: { ...ADM_RANK, benefits: RANK_BENEFITS.adm },
      nextRank: null,
      progress: 100,
      isAdm: true,
      allRanks: [...RANKS, ADM_RANK],
    });
  }

  if (mc) {
    const balance = await ensureBalance(mc);
    merit = balance.merit_total;
    rankId = balance.rank;
  }

  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit,
    rank: { ...rank, benefits: RANK_BENEFITS[rank.id] || [] },
    nextRank: nextRank ? { ...nextRank, benefits: RANK_BENEFITS[nextRank.id] || [] } : null,
    progress,
    isAdm: false,
    allRanks: RANKS,
  });
});

// ── GET /api/leaderboard ──────────────────────────────────
// Ranking público por Mérito
app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || 20)));
  const { rows } = await pool.query(`
    SELECT pb.minecraft_name, pb.merit_total, pb.rank, pb.capital_balance
    FROM player_balances pb
    WHERE pb.merit_total > 0
    ORDER BY pb.merit_total DESC
    LIMIT $1
  `, [limit]);

  res.json(rows.map((r, i) => ({
    position: i + 1,
    minecraft_name: r.minecraft_name,
    merit: r.merit_total,
    rank: getRankById(r.rank),
    capital: r.capital_balance,
  })));
});

// ── GET /api/player/:name/merit ───────────────────────────
app.get('/api/player/:name/merit', auth, requireAdmin, async (req, res) => {
  const mc = req.params.name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 200',
    [mc]
  );

  const merit = balance.merit_total;
  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit, rank, nextRank, progress,
    capital: balance.capital_balance,
    records,
  });
});

// ── POST /api/admin/merit ─────────────────────────────────
// Concede ou remove Mérito de um jogador
app.post('/api/admin/merit', auth, requireAdmin, async (req, res) => {
  const mc       = sanitize(req.body?.minecraft_name).toLowerCase();
  const amount   = parseInt(req.body?.amount);
  const reason   = sanitize(req.body?.reason);
  const category = ['doacao', 'servico', 'evento', 'construcao', 'habito', 'penalidade', 'outros'].includes(req.body?.category)
    ? req.body.category : 'outros';

  if (!mc || isNaN(amount) || amount === 0 || !reason)
    return res.status(400).json({ error: 'Dados inválidos: minecraft_name, amount (≠0) e reason são obrigatórios.' });

  if (Math.abs(amount) > 500)
    return res.status(400).json({ error: 'Limite de ±500 Mérito por transação.' });

  // Garante registro e busca saldo atual
  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT merit_total FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentMerit = cur[0]?.merit_total || 0;
  const newMerit = Math.max(0, currentMerit + amount);

  // Registra a transação
  await pool.query(
    'INSERT INTO merit_records(minecraft_name, amount, reason, category, awarded_by_id, awarded_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, reason, category, req.user.sub, req.user.username]
  );

  // Atualiza saldo e recalcula rank
  const newRank = await recalcRank(mc, newMerit);

  await audit({
    actorId: req.user.sub, actorName: req.user.username,
    type: 'update', targetName: mc,
    message: `Mérito ${amount > 0 ? '+' : ''}${amount} para ${mc}: "${reason}" (cat: ${category}). Total: ${newMerit}. Cargo: ${newRank.label}`,
    metadata: { mc, amount, reason, category, newMerit, newRank: newRank.id },
  });

  res.json({ ok: true, newMerit, rank: { ...newRank, benefits: RANK_BENEFITS[newRank.id] || [] }, prevMerit: currentMerit });
});

// ── POST /api/admin/capital ───────────────────────────────
// Ajusta Capital de um jogador
app.post('/api/admin/capital', auth, requireAdmin, async (req, res) => {
  const mc          = sanitize(req.body?.minecraft_name).toLowerCase();
  const amount      = parseFloat(req.body?.amount);
  const type        = ['credito', 'debito', 'rendimento', 'emprestimo', 'penalidade', 'ajuste'].includes(req.body?.type)
    ? req.body.type : 'ajuste';
  const description = sanitize(req.body?.description);

  if (!mc || isNaN(amount) || amount === 0 || !description)
    return res.status(400).json({ error: 'Dados inválidos.' });

  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT capital_balance FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentCapital = cur[0]?.capital_balance || 0;
  const newCapital = Math.max(0, currentCapital + amount);

  // Registra transação
  await pool.query(
    'INSERT INTO capital_records(minecraft_name, amount, type, description, created_by_id, created_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, type, description, req.user.sub, req.user.username]
  );

  // Atualiza saldo
  await pool.query(
    'UPDATE player_balances SET capital_balance=$1, updated_at=NOW() WHERE minecraft_name=$2',
    [newCapital, mc]
  );

  await audit({
    actorId: req.user.sub, actorName: req.user.username,
    type: 'update', targetName: mc,
    message: `Capital ${amount > 0 ? '+' : ''}${amount} para ${mc}: "${description}" (tipo: ${type}). Saldo: ${newCapital}`,
    metadata: { mc, amount, type, description, newCapital },
  });

  res.json({ ok: true, newCapital, prevCapital: currentCapital });
});

// ── GET /api/admin/merit-records ──────────────────────────
// Histórico completo de Mérito (admin)
app.get('/api/admin/merit-records', auth, requireAdmin, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page || 0));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 50)));
  const mc    = req.query.mc ? sanitize(req.query.mc).toLowerCase() : null;

  const where  = mc ? 'WHERE LOWER(minecraft_name)=$1' : '';
  const params = mc ? [mc, limit, page * limit] : [limit, page * limit];

  const { rows } = await pool.query(
    `SELECT * FROM merit_records ${where} ORDER BY created_at DESC LIMIT $${mc ? 2 : 1} OFFSET $${mc ? 3 : 2}`,
    params
  );
  res.json(rows);
});

// ── GET /api/admin/capital-records ────────────────────────
// Histórico completo de Capital (admin)
app.get('/api/admin/capital-records', auth, requireAdmin, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page || 0));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));
  const mc    = req.query.mc ? sanitize(req.query.mc).toLowerCase() : null;

  const where  = mc ? 'WHERE LOWER(minecraft_name)=$1' : '';
  const params = mc ? [mc, limit, page * limit] : [limit, page * limit];

  const { rows } = await pool.query(
    `SELECT * FROM capital_records ${where} ORDER BY created_at DESC LIMIT $${mc ? 2 : 1} OFFSET $${mc ? 3 : 2}`,
    params
  );
  res.json({ records: rows });
});

// ── GET /api/admin/leaderboard ────────────────────────────
app.get('/api/admin/leaderboard', auth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pb.*, 
      (SELECT COUNT(*) FROM merit_records mr WHERE LOWER(mr.minecraft_name) = pb.minecraft_name) AS total_transactions
    FROM player_balances pb
    ORDER BY pb.merit_total DESC
    LIMIT 100
  `);

  res.json(rows.map((r, i) => ({
    position: i + 1,
    minecraft_name: r.minecraft_name,
    merit: r.merit_total,
    capital: r.capital_balance,
    rank: getRankById(r.rank),
    total_transactions: r.total_transactions,
    updated_at: r.updated_at,
  })));
});

// ── GET /api/admin/players-with-balances ─────────────────
// Lista jogadores com saldo (para autocomplete no admin)
app.get('/api/admin/players-with-balances', auth, requireAdmin, async (req, res) => {
  const q = req.query.q ? `%${sanitize(req.query.q).toLowerCase()}%` : '%';
  const { rows } = await pool.query(`
    SELECT ps.player AS minecraft_name,
      COALESCE(pb.merit_total, 0)     AS merit_total,
      COALESCE(pb.capital_balance, 0) AS capital_balance,
      COALESCE(pb.rank, 'ferro')      AS rank
    FROM (SELECT DISTINCT player FROM player_sessions) ps
    LEFT JOIN player_balances pb ON pb.minecraft_name = LOWER(ps.player)
    WHERE LOWER(ps.player) LIKE $1
    ORDER BY COALESCE(pb.merit_total, 0) DESC
    LIMIT 30
  `, [q]);
  res.json(rows);
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
console.error('[error]', err?.message || err);
res.status(500).json({ error: 'internal error' });
});

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 8787;
migrate()
.then(seedAdmin)
.then(() => {
  app.listen(PORT, () => console.log(`✅  API rodando na porta ${PORT}`));
})
.catch(e => { console.error('[migrate]', e); process.exit(1); });
