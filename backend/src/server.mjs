/**
 * Força Aliada – Backend API  (server.mjs)
 * ─────────────────────────────────────────
 * Stack : Node.js (ESM) + Express + PostgreSQL + JWT + bcrypt
 * * Novidades nesta versão
 * ──────────────────────
 * • Sistema de Integração (App Keys) para Desktop App.
 * • Rota /api/app/sync para receber dados push em tempo real com segurança máxima.
 * • Auto-cura Híbrida: O Site entra em repouso se a App estiver conectada.
 * • Rastreamento de Origem: O banco sabe se a sessão veio da App ou do Site.
 */

import * as util from 'minecraft-server-util';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const PROCESS_STARTED_AT = new Date();

// ── Cache em memória para status do Minecraft (evita bater na API externa a cada request) ──
const _mcStatusCache = { data: null, expiresAt: 0 };
const MC_STATUS_TTL_MS = 30_000; // 30 segundos

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
    if (corsOrigins.includes(origin) || origin.endsWith('.github.io')) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Ingest-Secret', 'x-app-key'],
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

const DEPLOY_SCHEMA_VERSION = 'audit-schema-v4-full-fields';
const AUDIT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id           SERIAL PRIMARY KEY,
    actor_id     INTEGER,
    actor_name   VARCHAR(255),
    type         VARCHAR(50)  DEFAULT 'system',
    severity     VARCHAR(20)  DEFAULT 'info',
    target_id    INTEGER,
    target_name  VARCHAR(255),
    message      TEXT,
    metadata     JSONB,
    ip           VARCHAR(64),
    user_agent   TEXT,
    session_id   INTEGER,
    created_at   TIMESTAMPTZ  DEFAULT NOW()
  )`,
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'system'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS message TEXT",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip VARCHAR(64)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS session_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
  "CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_audit_type     ON audit_logs(type)",
  "CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_logs(actor_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity)",
];

// ─────────────────────────────────────────────
// Env guards
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 chars');
const INGEST_SECRET = process.env.INGEST_SECRET; // Usado agora apenas como Fallback de emergência

// ─────────────────────────────────────────────
// Rate limiters
// ─────────────────────────────────────────────
const authLimiter  = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => {
    audit({
      type: 'security', severity: 'critical',
      message: `Rate limit atingido em ${req.path}`,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      metadata: { path: req.path, method: req.method },
    }).catch(() => {});
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
  },
});
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
if (!key) { return; }
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
const baseSchemaSql = String.raw`
CREATE TABLE IF NOT EXISTS users (
id            SERIAL PRIMARY KEY,
username      VARCHAR(255) UNIQUE NOT NULL,
email         VARCHAR(255) UNIQUE NOT NULL,
minecraft_name VARCHAR(255),
photo_url     VARCHAR(255) DEFAULT 'logo.JPG',
password_hash VARCHAR(255) NOT NULL,
role          VARCHAR(50)  NOT NULL DEFAULT 'limited',
is_verified   BOOLEAN      DEFAULT TRUE,
created_at    TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT TRUE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','full','limited'));

CREATE TABLE IF NOT EXISTS player_sessions (
  id            SERIAL PRIMARY KEY,
  player        VARCHAR(255) NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL,
  left_at       TIMESTAMPTZ,
  duration_hours FLOAT
);
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS duration_hours FLOAT;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS origin VARCHAR(20) DEFAULT 'site';
CREATE INDEX IF NOT EXISTS idx_player_name      ON player_sessions(player);
CREATE INDEX IF NOT EXISTS idx_player_left_at   ON player_sessions(left_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           VARCHAR(64),
  city         VARCHAR(128),
  region       VARCHAR(128),
  country      VARCHAR(128),
  isp          VARCHAR(255),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  revoked      BOOLEAN DEFAULT FALSE
);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS city    VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS region  VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS country VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS isp     VARCHAR(255);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_seen ON user_sessions(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  body        TEXT         NOT NULL,
  type        VARCHAR(50)  NOT NULL DEFAULT 'info',
  icon        VARCHAR(20)  DEFAULT '🔔',
  audience    VARCHAR(20)  NOT NULL DEFAULT 'all',
  audience_val TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'info';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience VARCHAR(20) DEFAULT 'all';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience_val TEXT;

CREATE TABLE IF NOT EXISTS notification_deletes (
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)         ON DELETE CASCADE,
  deleted_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_integration_keys (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS whitelist_queue (
  id             SERIAL PRIMARY KEY,
  minecraft_name VARCHAR(255) NOT NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  queued_at      TIMESTAMPTZ DEFAULT NOW(),
  delivered_at   TIMESTAMPTZ,
  delivered_by   INTEGER REFERENCES app_integration_keys(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_whitelist_queue_delivered ON whitelist_queue(delivered_at);
`;

await pool.query(baseSchemaSql);

const featureSchemaSql = `
CREATE TABLE IF NOT EXISTS player_notes (
  id           SERIAL PRIMARY KEY,
  minecraft_name VARCHAR(255) NOT NULL,
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name  VARCHAR(255),
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_mc ON player_notes(LOWER(minecraft_name));

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_server     BOOLEAN DEFAULT TRUE,
  email_events     BOOLEAN DEFAULT TRUE,
  email_community  BOOLEAN DEFAULT TRUE,
  public_profile   BOOLEAN DEFAULT TRUE,
  show_online      BOOLEAN DEFAULT TRUE,
  public_history   BOOLEAN DEFAULT FALSE,
  theme            VARCHAR(20) DEFAULT 'auto',
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_preferences ALTER COLUMN theme SET DEFAULT 'auto';

CREATE TABLE IF NOT EXISTS player_balances (
  minecraft_name  VARCHAR(255) PRIMARY KEY,
  merit_total     INTEGER      NOT NULL DEFAULT 0,
  capital_balance FLOAT        NOT NULL DEFAULT 0,
  rank            VARCHAR(50)  NOT NULL DEFAULT 'ferro',
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balances_merit ON player_balances(merit_total DESC);

CREATE TABLE IF NOT EXISTS merit_records (
  id              SERIAL PRIMARY KEY,
  minecraft_name  VARCHAR(255) NOT NULL,
  amount          INTEGER      NOT NULL,
  reason          TEXT         NOT NULL,
  category        VARCHAR(50)  NOT NULL DEFAULT 'outros',
  awarded_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_by_name VARCHAR(255),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merit_mc      ON merit_records(LOWER(minecraft_name));
CREATE INDEX IF NOT EXISTS idx_merit_created ON merit_records(created_at DESC);

CREATE TABLE IF NOT EXISTS capital_records (
  id              SERIAL PRIMARY KEY,
  minecraft_name  VARCHAR(255) NOT NULL,
  amount          FLOAT        NOT NULL,
  type            VARCHAR(50)  NOT NULL DEFAULT 'ajuste',
  description     TEXT         NOT NULL,
  created_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name VARCHAR(255),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE capital_records ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'ajuste';
CREATE INDEX IF NOT EXISTS idx_capital_mc ON capital_records(LOWER(minecraft_name));

CREATE TABLE IF NOT EXISTS server_status_checks (
  id             SERIAL PRIMARY KEY,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  host           VARCHAR(255) NOT NULL,
  online         BOOLEAN NOT NULL,
  players_online INTEGER DEFAULT 0,
  players_max    INTEGER DEFAULT 0,
  latency_ms     INTEGER,
  version        VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_server_status_checked ON server_status_checks(checked_at DESC);

-- ─────────────────────────────────────────────
-- NOVA TABELA: INTEGRAÇÕES (MICROSOFT / XBOX)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ms_refresh_token TEXT,
  xbox_xuid        VARCHAR(255),
  mc_uuid          VARCHAR(36) UNIQUE,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integrations_xuid ON user_integrations(xbox_xuid);
`;
await pool.query(featureSchemaSql);

  // Audit schema — executado no boot, não lazily
  for (const statement of AUDIT_SCHEMA_STATEMENTS) {
    await pool.query(statement);
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
const hash = await bcrypt.hash(p, 10);
await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,TRUE)',
[u.toLowerCase(), e, u, hash, 'owner'],
);
}

/**
 * Registra um evento de auditoria no banco de dados.
 */
async function audit({
  actorId = null, actorName = null,
  type, severity = 'info',
  targetId = null, targetName = null,
  message, metadata = null,
  ip = null, userAgent = null, sessionId = null,
}) {
  if (!message) { console.warn('[audit] chamado sem message, ignorando'); return; }
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (actor_id, actor_name, type, severity, target_id, target_name, message, metadata, ip, user_agent, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actorId    || null,
        actorName  || null,
        type,
        severity,
        targetId   || null,
        targetName || null,
        message,
        metadata ? JSON.stringify(metadata) : null,
        ip         || null,
        userAgent  || null,
        sessionId  || null,
      ],
    );
  } catch (e) {
    console.error('[audit FAILED]', { type, message, actorId, error: e.message });
  }
}

/**
 * Wrapper conveniente que extrai IP, User-Agent e sessionId do objeto `req`
 * e repassa para `audit()`. Use este em todos os handlers de rota.
 */
async function auditFromReq(req, opts) {
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
  const userAgent = req.headers['user-agent'] || null;

  let sessionId = null;
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (rawToken) {
      const { createHash } = await import('node:crypto');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const { rows } = await pool.query(
        'SELECT id FROM user_sessions WHERE token_hash=$1 AND revoked=FALSE LIMIT 1',
        [tokenHash],
      );
      sessionId = rows[0]?.id || null;
    }
  } catch { /* sessionId opcional */ }

  return audit({ ...opts, ip, userAgent, sessionId });
}

async function createMinecraftNotification({ minecraftName, title, body, type = 'info', icon = '🔔', createdBy = null }) {
  const mc = sanitize(minecraftName).toLowerCase();
  if (!mc || !title || !body) return null;
  const { rows } = await pool.query(
    `INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by)
     VALUES($1,$2,$3,$4,'minecraft',$5,$6) RETURNING id`,
    [title, body, type, icon, mc, createdBy]
  );
  return rows[0];
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

// ── Keep-alive público (usado pelo GitHub Actions para evitar cold start) ──
app.get('/ping', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ pong: true, ts: Date.now() });
});

// ─────────────────────────────────────────────
// Minecraft Status (Híbrido) - ANTI BLOQUEIO TCPSHIELD
// ─────────────────────────────────────────────
async function fetchMinecraftStatus() {
  const host = process.env.MC_HOST || 'fa.ogabriels.com';
  const started = Date.now();
  let result = null;

  try {
    result = await util.status(host, 25565, { timeout: 2500, enableSRV: false });
  } catch (err1) {
    try {
      result = await util.status(host, 25565, { timeout: 2500, enableSRV: true });
    } catch (err2) {
      const res = await fetch(`https://api.mcstatus.io/v2/status/java/${host}`);
      if (!res.ok) throw new Error('Todas as tentativas de ping falharam.');
      const data = await res.json();
      if (!data.online) throw new Error('Servidor offline reportado pela API.');

      result = {
        version: { name: data.version?.name_raw || data.version?.name },
        players: {
          online: data.players?.online || 0,
          max: data.players?.max || 0,
          sample: data.players?.list?.map(p => ({ name: p.name_raw || p.name })) || []
        },
        roundTripLatency: data.latency
      };
    }
  }

  const latencyMs = Math.max(0, Date.now() - started);
  const onlinePlayers = (result.players.sample || [])
    .map(p => p.name)
    .filter(name => Boolean(name) && name !== 'Anonymous Player');

  return {
    host,
    checkedAt: new Date(),
    online: true,
    version: result.version?.name || null,
    players: {
      online: Number(result.players.online || 0),
      max: Number(result.players.max || 0),
      list: onlinePlayers,
    },
    latencyMs: result.roundTripLatency || latencyMs,
    raw: result,
  };
}

async function fetchMinecraftStatusCached() {
  const now = Date.now();
  if (_mcStatusCache.data && now < _mcStatusCache.expiresAt) {
    return _mcStatusCache.data;
  }
  const fresh = await fetchMinecraftStatus();
  _mcStatusCache.data = fresh;
  _mcStatusCache.expiresAt = now + MC_STATUS_TTL_MS;
  return fresh;
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

app.get('/api/server/status', auth, requireAdmin, async (_req, res) => {
  const host = process.env.MC_HOST || 'fa.ogabriels.com';
  try {
    const status = await fetchMinecraftStatusCached();
    await recordServerStatus(status);

    // --- SISTEMA DE AUTO-CURA (MASTER/SLAVE) ---
    const now = status.checkedAt;
    const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
    
    // Verifica se a App Desktop esteve ativa no último minuto
    const { rows: activeApps } = await pool.query("SELECT id FROM app_integration_keys WHERE last_used_at >= NOW() - INTERVAL '1 minute'");
    const isAppConnected = activeApps.length > 0;

    // Se o Site for o Ativo (App desconectada)
    if (status.online && !isAppConnected) {
      const onlinePlayers = status.players.list;
      const reportedCount = status.players.online;
      const isProxyHidingNames = reportedCount > 0 && onlinePlayers.length === 0;

      if (!isProxyHidingNames) {
        for (const row of active.rows) {
          if (!onlinePlayers.includes(row.player)) {
            const dur = (now - new Date(row.entered_at)) / 3600000;
            await pool.query('UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL', [now, +dur.toFixed(2), row.player]);
          }
        }
        for (const p of onlinePlayers) {
          const already = active.rows.some(r => r.player === p);
          // O Site marca as suas próprias sessões com origin 'site'
          if (!already) await pool.query("INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'site')", [p, now]);
        }
      }
    }
    // Se a App está conectada, o site "cruza os braços" e não faz nada, evitando duplicados!

    const stats = await getServerStatusStats(status.host, status.online);
    return res.json({
      checked_at: status.checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      minecraft: {
        host: status.host, online: status.online, version: status.version,
        players: { online: status.players.online, max: status.players.max, list: status.players.list },
        latencyMs: status.latencyMs, onlineSince: stats.onlineSince, uptime24hPct: stats.uptime24hPct, samples24h: stats.samples24h,
      },
    });
  } catch (err) {
    console.error('[server status]', err);
    const checkedAt = new Date();
    const fallback = { host, checkedAt, online: false, version: null, players: { online: 0, max: 0, list: [] }, latencyMs: null };
    await recordServerStatus(fallback).catch(e => console.error('[server status record]', e));

    // O Servidor caiu de vez. Vamos verificar se a App também caiu antes de auto-deslogar toda a gente
    try {
      const { rows: fallbackApps } = await pool.query("SELECT id FROM app_integration_keys WHERE last_used_at >= NOW() - INTERVAL '1 minute'");
      if (fallbackApps.length === 0) {
        const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
        for (const row of active.rows) {
          const dur = (checkedAt - new Date(row.entered_at)) / 3600000;
          await pool.query('UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL', [checkedAt, +dur.toFixed(2), row.player]);
        }
      }
    } catch (e) {}

    const stats = await getServerStatusStats(host, false).catch(() => ({ uptime24hPct: 0, onlineSince: null, samples24h: 0 }));
    return res.json({
      checked_at: checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      minecraft: { ...fallback, checkedAt: undefined, onlineSince: null, uptime24hPct: stats.uptime24hPct, samples24h: stats.samples24h, error: 'status unavailable' },
    });
  }
});

// ─────────────────────────────────────────────
// CRON e SNAPSHOT
// ─────────────────────────────────────────────
app.get('/api/cron', async (req, res) => {
const key = req.query.key || req.headers['x-ingest-secret'];
if (key !== INGEST_SECRET) return res.status(403).json({ error: 'forbidden' });

try {
  const status = await fetchMinecraftStatusCached();
  await recordServerStatus(status);
  
  const { rows: activeApps } = await pool.query("SELECT id FROM app_integration_keys WHERE last_used_at >= NOW() - INTERVAL '1 minute'");
  const isAppConnected = activeApps.length > 0;

  if (status.online && !isAppConnected) {
    const onlinePlayers = status.players.list;
    const reportedCount = status.players.online;
    const now = status.checkedAt;
    const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
    const isProxyHidingNames = reportedCount > 0 && onlinePlayers.length === 0;

    if (!isProxyHidingNames) {
      for (const row of active.rows) {
        if (!onlinePlayers.includes(row.player)) {
          const dur = (now - new Date(row.entered_at)) / 3600000;
          await pool.query('UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL', [now, +dur.toFixed(2), row.player]);
        }
      }
      for (const p of onlinePlayers) {
        const already = active.rows.some(r => r.player === p);
        if (!already) await pool.query("INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'site')", [p, now]);
      }
    }
  }

  res.json({ ok: true });
} catch (err) {
  res.status(500).json({ error: 'snapshot failed' });
}
});

// ─────────────────────────────────────────────
// DADOS DO DASHBOARD (Lê a origem)
// ─────────────────────────────────────────────
app.get('/api/snapshots/latest', auth, requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  try {
    const online  = await pool.query(
      'SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL'
    );
    const history = await pool.query(
      'SELECT player, entered_at, left_at, duration_hours, origin FROM player_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT $1',
      [limit]
    );

    res.json({
      onlinePlayers: online.rows.map(r => r.player),
      activeSessions: online.rows.reduce((acc, r) => ({
        ...acc, [r.player]: { name: r.player, enteredAt: r.entered_at }
      }), {}),
      history: history.rows.map(r => ({
        player: r.player, enteredAt: r.entered_at,
        leftAt: r.left_at, hoursOnline: r.duration_hours,
        origin: r.origin // Exporta a origem
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar histórico' });
  }
});

// ─────────────────────────────────────────────
// INTEGRAÇÃO DE APLICATIVO (O PUSH)
// ─────────────────────────────────────────────

app.post('/api/admin/app-keys', auth, requireOwner, async (req, res) => {
    const name = sanitize(req.body.name || 'Força Aliada Manager PC');
    const rawKey = 'FA-' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    try {
        const { rows } = await pool.query('INSERT INTO app_integration_keys(name, key_hash, created_by) VALUES($1, $2, $3) RETURNING id, name, created_at', [name, keyHash, req.user.sub]);
        await audit({ actorId: req.user.sub, actorName: req.user.username, type: 'create', message: `Chave de Integração para App criada: "${name}"` });
        res.json({ id: rows[0].id, name: rows[0].name, created_at: rows[0].created_at, key: rawKey });
    } catch (err) { res.status(500).json({ error: 'Erro ao gerar chave' }); }
});

app.get('/api/admin/app-keys', auth, requireOwner, async (req, res) => {
    const { rows } = await pool.query(`SELECT k.id, k.name, k.created_at, k.last_used_at, u.username as created_by FROM app_integration_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`);
    res.json(rows);
});

app.delete('/api/admin/app-keys/:id', auth, requireOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id inválido' });
    const { rows } = await pool.query('DELETE FROM app_integration_keys WHERE id=$1 RETURNING name', [id]);
    if (rows.length) await audit({ actorId: req.user.sub, actorName: req.user.username, type: 'delete', message: `Chave de Integração revogada: "${rows[0].name}"` });
    res.json({ ok: true });
});

app.post('/api/app/sync', async (req, res) => {
    const key = req.headers['x-app-key'] || req.headers['x-ingest-secret']; 
    if (!key) return res.status(401).json({ error: 'Chave não fornecida' });
    let isValid = false;

    if (key === INGEST_SECRET && INGEST_SECRET) {
        isValid = true;
    } else {
        const keyHash = crypto.createHash('sha256').update(key).digest('hex');
        const { rows } = await pool.query('UPDATE app_integration_keys SET last_used_at=NOW() WHERE key_hash=$1 RETURNING id', [keyHash]);
        if (rows.length > 0) isValid = true;
    }

    if (!isValid) return res.status(403).json({ error: 'Chave inválida ou revogada' });

    // Resolve the app key id for queue delivery tracking
    let appKeyId = null;
    try {
        const keyHash = crypto.createHash('sha256').update(key).digest('hex');
        const { rows: kr } = await pool.query('SELECT id FROM app_integration_keys WHERE key_hash=$1', [keyHash]);
        appKeyId = kr[0]?.id || null;
    } catch { /* fallback key has no id */ }

    try {
        const payload  = req.body?.payload || req.body;
        const online   = (payload?.onlinePlayers || []).filter(Boolean);
        const now      = new Date();

        const active   = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');

        for (const row of active.rows) {
            if (!online.includes(row.player)) {
                const dur = (now - new Date(row.entered_at)) / 3600000;
                await pool.query('UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL', [now, +dur.toFixed(2), row.player]);
            }
        }

        for (const p of online) {
            const already = active.rows.some(r => r.player === p);
            // A App marca as sessões como 'app'
            if (!already) await pool.query("INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'app')", [p, now]);
        }

        // ── Whitelist queue: fetch pending items not yet delivered ──
        const { rows: pending } = await pool.query(
          'SELECT id, minecraft_name FROM whitelist_queue WHERE delivered_at IS NULL ORDER BY queued_at ASC LIMIT 50'
        );

        // Mark them delivered atomically
        if (pending.length > 0) {
          const ids = pending.map(r => r.id);
          await pool.query(
            `UPDATE whitelist_queue SET delivered_at=NOW(), delivered_by=$1 WHERE id = ANY($2)`,
            [appKeyId, ids]
          );
        }

        res.json({
          ok: true,
          whitelist_add: pending.map(r => ({ id: r.id, username: r.minecraft_name })),
        });

        await audit({
          type: 'system', severity: 'info',
          message: `App Sync: ${online.length} jogador(es) online registrado(s)${pending.length ? `, ${pending.length} whitelist(s) entregue(s)` : ''}`,
          metadata: {
            onlinePlayers: online,
            sessionsOpened: online.filter(p => !active.rows.some(r => r.player === p)).length,
            sessionsClosed: active.rows.filter(r => !online.includes(r.player)).length,
            whitelistDelivered: pending.map(r => r.minecraft_name),
          },
        });
    } catch (err) { res.status(500).json({ error: 'Falha na sincronização' }); }
});


// ─────────────────────────────────────────────
// AUTH – Microsoft / Xbox / Minecraft
// ─────────────────────────────────────────────

async function exchangeMsCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.MS_REDIRECT_URI,
  });
  const res = await fetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) throw new Error('Falha ao obter token da Microsoft');
  return res.json();
}

async function getXboxLiveToken(msAccessToken) {
  const res = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msAccessToken}` },
      RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT"
    })
  });
  if (!res.ok) throw new Error('Falha na autenticação do Xbox Live');
  return res.json();
}

async function getXSTSToken(xblToken, relyingParty) {
  const res = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: relyingParty, TokenType: "JWT"
    })
  });
  const data = await res.json();
  if (data.XErr === 2148916233) throw new Error('A conta Xbox não foi configurada.');
  if (data.XErr === 2148916238) throw new Error('Conta de criança. Requer aprovação de adulto.');
  if (!res.ok) throw new Error('Falha no XSTS Token');
  return data;
}

async function getMinecraftAccessToken(uhs, xstsToken) {
  const res = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  });
  if (!res.ok) throw new Error('Falha na autenticação da Mojang (Você tem Minecraft Original?)');
  return res.json();
}

async function getMinecraftProfile(mcAccessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { 'Authorization': `Bearer ${mcAccessToken}` }
  });
  if (res.status === 404) throw new Error('Esta conta não possui o Minecraft Java Edition comprado.');
  if (!res.ok) throw new Error('Falha ao obter perfil do Minecraft');
  return res.json();
}

app.get('/api/auth/microsoft/login', (req, res) => {
  const scope = encodeURIComponent("XboxLive.signin XboxLive.offline_access openid email profile");
  const url = `https://login.live.com/oauth20_authorize.srf?client_id=${process.env.MS_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.MS_REDIRECT_URI)}&scope=${scope}`;
  res.redirect(url);
});

app.get('/api/auth/microsoft/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('https://forcaaliada.ogabriels.com/login.html?ms_err=Acesso negado');

  try {
    const msTokens = await exchangeMsCodeForToken(code);
    const xblData = await getXboxLiveToken(msTokens.access_token);
    const uhs = xblData.DisplayClaims.xui[0].uhs;
    const xstsMC = await getXSTSToken(xblData.Token, "rp://api.minecraftservices.com/");
    const xuid = xstsMC.DisplayClaims.xui[0].xid;
    
    const mcTokenData = await getMinecraftAccessToken(uhs, xstsMC.Token);
    const mcProfile = await getMinecraftProfile(mcTokenData.access_token);
    
    const nick = mcProfile.name;
    const uuid = mcProfile.id;

    let userRow;
    const { rows: existingInt } = await pool.query('SELECT user_id FROM user_integrations WHERE mc_uuid = $1', [uuid]);
    
    if (existingInt.length > 0) {
      const { rows: u } = await pool.query('SELECT * FROM users WHERE id = $1', [existingInt[0].user_id]);
      userRow = u[0];
      await pool.query('UPDATE user_integrations SET ms_refresh_token = $1, updated_at = NOW() WHERE user_id = $2', [msTokens.refresh_token, userRow.id]);
    } else {
      const { rows: matchNick } = await pool.query('SELECT * FROM users WHERE LOWER(minecraft_name) = $1', [nick.toLowerCase()]);
      
      if (matchNick.length > 0) {
        userRow = matchNick[0];
      } else {
        const fakeEmail = `${uuid}@xbox.forcaaliada.local`; 
        const randomPass = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
        
        const { rows: newUser } = await pool.query(
          'INSERT INTO users(username, email, minecraft_name, password_hash, role, is_verified) VALUES($1, $2, $3, $4, $5, TRUE) RETURNING *',
          [nick.toLowerCase(), fakeEmail, nick, randomPass, 'limited']
        );
        userRow = newUser[0];
        await pool.query('INSERT INTO whitelist_queue(minecraft_name, user_id) VALUES($1, $2)', [nick, userRow.id]);
      }
      
      await pool.query(
        'INSERT INTO user_integrations(user_id, ms_refresh_token, xbox_xuid, mc_uuid) VALUES($1, $2, $3, $4)',
        [userRow.id, msTokens.refresh_token, xuid, uuid]
      );
    }

    const token = jwt.sign({ sub: userRow.id, role: userRow.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    
    await pool.query(
      `INSERT INTO user_sessions(user_id, token_hash, user_agent, ip, last_seen_at, created_at) VALUES($1,$2,$3,$4,NOW(),NOW())`,
      [userRow.id, tokenHash, req.headers['user-agent'], ip]
    );

    await audit({ actorId: userRow.id, actorName: userRow.username, type: 'login', message: `Login Xbox/Minecraft: ${nick}` });

    res.redirect(`https://forcaaliada.ogabriels.com/login.html?ms_token=${token}`);

  } catch (err) {
    res.redirect(`https://forcaaliada.ogabriels.com/login.html?ms_err=${encodeURIComponent(err.message)}`);
  }
});

// ─────────────────────────────────────────────
// AUTH – Signup (ESSE É O SEU CÓDIGO ORIGINAL QUE CONTINUA INTACTO!)
// ─────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const username      = sanitize(req.body?.username).toLowerCase();
  const email         = sanitize(req.body?.email).toLowerCase();
  const minecraftName = sanitize(req.body?.minecraftName || username);
  const password      = req.body?.password || '';

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password))
    return res.status(400).json({ error: 'Dados inválidos.' });

  try {
    const hash = await bcrypt.hash(password, 10);
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

    await audit({ type: 'create', targetId: rows[0].id, targetName: username, message: `Conta criada: ${username}` });

    res.json({ ok: true, requireVerification: true, email });

  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

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

  await audit({
    actorId: user.id, actorName: user.username,
    type: 'security', severity: 'info',
    message: `E-mail verificado com sucesso: ${user.username}`,
    metadata: { email: user.email },
  });

  // ── Enqueue whitelist addition for the desktop app ──
  if (user.minecraft_name) {
    try {
      await pool.query(
        'INSERT INTO whitelist_queue(minecraft_name, user_id) VALUES($1, $2)',
        [user.minecraft_name, user.id]
      );
    } catch (e) {
      console.error('[whitelist_queue insert]', e);
    }
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, role: user.role } });
});

// A próxima rota já é a de login normal que você tem aí
// app.post('/api/auth/login', authLimiter, async (req, res) => { ...

app.post('/api/auth/login', authLimiter, async (req, res) => {
const login    = sanitize(req.body?.login).toLowerCase();
const password = req.body?.password || '';
if (!login || !password) return res.status(400).json({ error: 'missing fields' });

const { rows } = await pool.query(
'SELECT * FROM users WHERE username=$1 OR email=$1', [login],
);
const user = rows[0];
if (!user || !(await bcrypt.compare(password, user.password_hash))) {
  // Login falho — registrar tentativa
  await audit({
    type: 'security', severity: 'warning',
    message: `Tentativa de login falha para: ${login}`,
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
    metadata: { login },
  });
  return res.status(401).json({ error: 'invalid credentials' });
}

if (user.is_verified === false) {
const code      = Math.floor(100000 + Math.random() * 900000).toString();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('DELETE FROM email_verifications WHERE email=$1', [user.email]);
await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [user.email, code, expiresAt]);
await sendSystemEmail(user.email, user.username, code, 'verify');
return res.status(403).json({ error: 'unverified_email', email: user.email });
}

await auditFromReq(req, {
  actorId: user.id, actorName: user.username,
  type: 'login', severity: 'info',
  message: `Login bem-sucedido: ${user.username}`,
  metadata: { email: user.email, role: user.role },
});

const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

const { createHash } = await import('node:crypto');
const tokenHash = createHash('sha256').update(token).digest('hex');
const ua = req.headers['user-agent'] || null;
const ip = req.ip || req.socket?.remoteAddress || null;
(async () => {
  let city = null, region = null, country = null, isp = null;
  try {
    const cleanIp = (ip || '').replace(/^::ffff:/, '');
    if (cleanIp && cleanIp !== '127.0.0.1' && cleanIp !== '::1') {
      const geoRes = await fetch(`https://ipapi.co/${cleanIp}/json/`, { signal: AbortSignal.timeout(4000) });
      if (geoRes.ok) {
        const g = await geoRes.json();
        city = g.city || null; region = g.region || null; country = g.country_name || null;
        isp  = (g.org || '').replace(/^AS\d+\s*/, '') || null;
      }
    }
  } catch { /* geo opcional */ }
  try {
    await pool.query(
      `INSERT INTO user_sessions(user_id, token_hash, user_agent, ip, city, region, country, isp, last_seen_at, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT(token_hash) DO UPDATE SET last_seen_at=NOW()`,
      [user.id, tokenHash, ua, ip, city, region, country, isp]
    );
  } catch(e) { console.error('[sessions] insert error:', e.message); }
})();

res.json({
token,
user: {
username: user.username, email: user.email,
minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role,
},
});
});

app.post('/api/auth/forgot-password', emailLimiter, async (req, res) => {
const email = sanitize(req.body?.email).toLowerCase();
if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

await pool.query('DELETE FROM password_resets WHERE email=$1 OR expires_at<NOW()', [email]);
const { rows } = await pool.query('SELECT username FROM users WHERE email=$1', [email]);
if (!rows.length) return res.json({ ok: true }); 

const code      = Math.floor(100000 + Math.random() * 900000).toString();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('INSERT INTO password_resets(email,code,expires_at) VALUES($1,$2,$3)', [email, code, expiresAt]);
await sendSystemEmail(email, rows[0].username, code, 'reset');
await audit({
  type: 'security', severity: 'info',
  message: `Código de recuperação de senha enviado para: ${email}`,
  metadata: { email },
});
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

const hash = await bcrypt.hash(newPassword, 10);
await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, email]);
await pool.query('DELETE FROM password_resets WHERE email=$1', [email]);

const { rows: userRows } = await pool.query('SELECT id, username FROM users WHERE email=$1', [email]);
await audit({
  actorId: userRows[0]?.id || null,
  actorName: userRows[0]?.username || email,
  type: 'security', severity: 'warning',
  message: `Senha redefinida via código de recuperação para: ${userRows[0]?.username || email}`,
  metadata: { email },
});

res.json({ ok: true });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    const { createHash } = await import('node:crypto');
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (rawToken) {
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      await pool.query(
        'UPDATE user_sessions SET revoked=TRUE WHERE token_hash=$1',
        [tokenHash],
      );
    }
    await auditFromReq(req, {
      actorId:   req.user?.sub,
      actorName: req.user?.username,
      type:      'logout',
      severity:  'info',
      message:   `${req.user?.username || 'Usuário'} encerrou sessão`,
    });
  } catch { /* logout nunca falha */ }
  res.json({ ok: true });
});

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

async function changeMyPassword(req, res) {
const currentPassword = req.body?.currentPassword || '';
const newPassword     = req.body?.newPassword || '';
if (!validatePassword(newPassword))
return res.status(400).json({ error: 'invalid new password' });

const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.sub]);
if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid current password' });

const hash = await bcrypt.hash(newPassword, 10);
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

// ── Integrações Xbox e Mojang (Área Logada) ─────────────────
app.get('/api/me/xbox/friends', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ms_refresh_token FROM user_integrations WHERE user_id = $1', [req.user.sub]);
    if (!rows.length || !rows[0].ms_refresh_token) throw new Error('Conta não vinculada ao Xbox.');

    // 1. Renova o token da MS
    const params = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
      refresh_token: rows[0].ms_refresh_token, grant_type: 'refresh_token',
    });
    const msRes = await fetch('https://login.live.com/oauth20_token.srf', { method: 'POST', body: params.toString() });
    const msData = await msRes.json();
    await pool.query('UPDATE user_integrations SET ms_refresh_token = $1 WHERE user_id = $2', [msData.refresh_token, req.user.sub]);

    // 2. Busca lista no Xbox Live
    const xblData = await getXboxLiveToken(msData.access_token);
    const uhs = xblData.DisplayClaims.xui[0].uhs;
    const xstsXbox = await getXSTSToken(xblData.Token, "http://xboxlive.com");

    const friendsRes = await fetch('https://peoplehub.xboxlive.com/users/me/people/social/decoration/detail', {
      headers: { 'Authorization': `XBL3.0 x=${uhs};${xstsXbox.Token}`, 'x-xbl-contract-version': '2', 'Accept-Language': 'pt-BR' }
    });
    const friendsData = await friendsRes.json();
    
    // 3. Cruza com o banco do Servidor
    const xuids = (friendsData.people || []).map(p => p.xuid);
    let commonFriends = [];
    if (xuids.length > 0) {
        const { rows: matched } = await pool.query(`
          SELECT u.username, u.minecraft_name 
          FROM user_integrations ui JOIN users u ON ui.user_id = u.id 
          WHERE ui.xbox_xuid = ANY($1)
        `, [xuids]);
        commonFriends = matched;
    }
    res.json({ xboxFriendsTotal: (friendsData.people || []).length, serverFriends: commonFriends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/me/minecraft/skin', auth, async (req, res) => {
  const { skinUrl } = req.body;
  if (!skinUrl) return res.status(400).json({ error: 'URL da skin obrigatória' });

  try {
    const { rows } = await pool.query('SELECT ms_refresh_token FROM user_integrations WHERE user_id = $1', [req.user.sub]);
    if (!rows.length || !rows[0].ms_refresh_token) throw new Error('Conta não vinculada à Microsoft.');

    const params = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
      refresh_token: rows[0].ms_refresh_token, grant_type: 'refresh_token',
    });
    const msRes = await fetch('https://login.live.com/oauth20_token.srf', { method: 'POST', body: params.toString() });
    const msData = await msRes.json();
    await pool.query('UPDATE user_integrations SET ms_refresh_token = $1 WHERE user_id = $2', [msData.refresh_token, req.user.sub]);

    const xblData = await getXboxLiveToken(msData.access_token);
    const xstsMC = await getXSTSToken(xblData.Token, "rp://api.minecraftservices.com/");
    const mcToken = await getMinecraftAccessToken(xblData.DisplayClaims.xui[0].uhs, xstsMC.Token);

    const skinPost = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mcToken.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: "classic", url: skinUrl })
    });

    if (!skinPost.ok) throw new Error('Mojang rejeitou a troca (Verifique URL ou Rate Limit)');
    
    await audit({
      actorId: req.user.sub, actorName: req.user.username, type: 'update',
      message: `${req.user.username} alterou a skin oficial via Painel.`
    });
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ME – Preferências
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
app.get('/api/notifications', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, (nr.user_id IS NOT NULL) AS is_read FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nd.user_id IS NULL AND (n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4)) ORDER BY n.created_at DESC LIMIT 100`, [userId, role, String(userId), mc]);
res.json(rows);
});

app.get('/api/notifications/unread-count', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nr.user_id IS NULL AND nd.user_id IS NULL AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) )`, [userId, role, String(userId), mc]);
res.json({ count: rows[0].count });
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  const visible = await pool.query(
    `SELECT id FROM notifications WHERE id=$1 AND ( audience='all' OR (audience='role' AND audience_val=$2) OR (audience='user' AND audience_val=$3::text) OR (audience='minecraft' AND LOWER(audience_val)=$4) )`,
    [id, role, String(req.user.sub), mc],
  );
  if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });

  await pool.query(`INSERT INTO notification_reads(notification_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);
  res.json({ ok: true });
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  const visible = await pool.query(
    `SELECT id FROM notifications WHERE id=$1 AND ( audience='all' OR (audience='role' AND audience_val=$2) OR (audience='user' AND audience_val=$3::text) OR (audience='minecraft' AND LOWER(audience_val)=$4) )`,
    [id, role, String(req.user.sub), mc],
  );
  if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });

  await pool.query(`INSERT INTO notification_deletes(notification_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();

await pool.query(`INSERT INTO notification_reads(notification_id, user_id) SELECT n.id, $1 FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nr.user_id IS NULL AND nd.user_id IS NULL AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) ) ON CONFLICT DO NOTHING`, [userId, role, String(userId), mc]);
res.json({ ok: true });
});

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

app.get('/api/admin/notifications', auth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, COUNT(nr.user_id)::int AS read_count FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id GROUP BY n.id, u.username ORDER BY n.created_at DESC  `);
  res.json(rows);
});

app.delete('/api/admin/notifications/:id', auth, requireOwner, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

const { rowCount } = await pool.query('DELETE FROM notifications WHERE id=$1', [id]);
if (!rowCount) return res.status(404).json({ error: 'not found' });

await auditFromReq(req, {
  actorId:   req.user.sub,
  actorName: req.user.username,
  type:      'delete',
  severity:  'info',
  targetId:  id,
  message:   `Notificação #${id} deletada por ${req.user.username}`,
});

res.json({ ok: true });
});

// ─────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────
app.get('/api/admin/audit', auth, requireAdmin, async (req, res) => {
  try {
    const type     = req.query.type && req.query.type !== 'all' ? req.query.type : null;
    const severity = req.query.severity && req.query.severity !== 'all' ? req.query.severity : null;
    const actor    = req.query.actor || null;
    const page     = Math.max(0, parseInt(req.query.page  || 0));
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit || 50)));

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (type)     { conditions.push(`type=$${p++}`);              params.push(type); }
    if (severity) { conditions.push(`severity=$${p++}`);          params.push(severity); }
    if (actor)    { conditions.push(`actor_name ILIKE $${p++}`);  params.push(`%${actor}%`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataParams  = [...params, limit, page * limit];
    const countParams = [...params];

    const { rows } = await pool.query(
      `SELECT id, actor_id, actor_name, type, severity, target_id, target_name,
              message, metadata, ip, user_agent, session_id, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      dataParams,
    );

    const { rows: total } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_logs ${where}`,
      countParams,
    );

    res.json({
      logs:       rows,
      total:      total[0].count,
      page,
      limit,
      totalPages: Math.ceil(total[0].count / limit),
    });
  } catch (error) {
    console.error('[GET /api/admin/audit error]', error);
    res.status(500).json({ error: 'Erro interno ao procurar logs.' });
  }
});

app.get('/api/admin/audit/export', auth, requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, actor_name, type, severity, target_name, message, ip, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT 10000`,
    );

    const header = 'id,actor,tipo,severidade,alvo,mensagem,ip,data_hora\n';
    const csv = rows.map(r => [
      r.id,
      `"${(r.actor_name || '').replace(/"/g, '""')}"`,
      r.type,
      r.severity,
      `"${(r.target_name || '').replace(/"/g, '""')}"`,
      `"${(r.message || '').replace(/"/g, '""')}"`,
      r.ip || '',
      new Date(r.created_at).toISOString(),
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
    res.send('\uFEFF' + header + csv); // BOM para Excel PT-BR
  } catch (e) {
    res.status(500).json({ error: 'Falha ao exportar' });
  }
});

// ─────────────────────────────────────────────
// NOTAS DE JOGADORES
// ─────────────────────────────────────────────
app.get('/api/admin/notes/:minecraft_name', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.minecraft_name).toLowerCase();
  const { rows } = await pool.query(
    'SELECT * FROM player_notes WHERE LOWER(minecraft_name) = $1 ORDER BY created_at DESC',
    [mc],
  );
  res.json(rows);
});

app.post('/api/admin/notes', auth, requireAdmin, async (req, res) => {
  const { minecraft_name, text } = req.body || {};
  if (!minecraft_name || !text) return res.status(400).json({ error: 'Campos ausentes' });

  const { rows } = await pool.query(
    'INSERT INTO player_notes(minecraft_name, author_id, author_name, text) VALUES($1, $2, $3, $4) RETURNING *',
    [sanitize(minecraft_name), req.user.sub, req.user.username, sanitize(text)],
  );
  await auditFromReq(req, {
    actorId:    req.user.sub,
    actorName:  req.user.username,
    type:       'create',
    targetName: sanitize(minecraft_name),
    message:    `Nota adicionada ao jogador ${sanitize(minecraft_name)} por ${req.user.username}`,
  });
  res.json(rows[0]);
});

app.delete('/api/admin/notes/:id', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'invalid id' });
  await pool.query('DELETE FROM player_notes WHERE id = $1', [noteId]);
  await auditFromReq(req, {
    actorId:   req.user.sub,
    actorName: req.user.username,
    type:      'delete',
    targetId:  noteId,
    message:   `Nota #${noteId} excluída por ${req.user.username}`,
  });
  res.json({ ok: true });
});

app.get('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.name).toLowerCase();
  const { rows } = await pool.query(
  'SELECT id, author_name, text, created_at FROM player_notes WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC',
  [mc],
  );
  res.json(rows);
});

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

app.delete('/api/player/:name/notes/:noteId', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.noteId);
  const mc     = sanitize(req.params.name).toLowerCase();
  if (!noteId) return res.status(400).json({ error: 'invalid id' });

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
// ANALYTICS & BIG DATA 
// ─────────────────────────────────────────────

app.get('/api/admin/analytics/activity', auth, requireAdmin, async (req, res) => {
  try {
    const { rows: monthly } = await pool.query(`
      SELECT 
        TO_CHAR(entered_at, 'YYYY-MM') as month,
        SUM(duration_hours) as total_hours,
        COUNT(id) as sessions_count
      FROM player_sessions 
      WHERE duration_hours IS NOT NULL
      GROUP BY TO_CHAR(entered_at, 'YYYY-MM')
      ORDER BY month ASC
    `);

    const { rows: topPlayers } = await pool.query(`
      SELECT player, SUM(duration_hours) as total_hours 
      FROM player_sessions 
      WHERE duration_hours IS NOT NULL 
      GROUP BY player 
      ORDER BY total_hours DESC 
      LIMIT 10
    `);

    const { rows: summary } = await pool.query(`
      SELECT 
        COUNT(id)::int as total_sessions, 
        SUM(duration_hours)::float as total_hours,
        COUNT(DISTINCT player)::int as unique_players
      FROM player_sessions
    `);

    res.json({
      summary: summary[0],
      monthly: monthly,
      topPlayers: topPlayers
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Erro ao gerar relatórios analíticos' });
  }
});

app.get('/api/admin/sessions/history', auth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || 0));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20)));
    const search = req.query.q ? `%${sanitize(req.query.q).toLowerCase()}%` : null;

    let query = 'FROM player_sessions WHERE left_at IS NOT NULL';
    let params = [limit, page * limit];

    if (search) {
      query += ' AND LOWER(player) LIKE $3';
      params.push(search);
    }

    const { rows } = await pool.query(
      `SELECT id, player, entered_at, left_at, duration_hours 
       ${query} 
       ORDER BY left_at DESC 
       LIMIT $1 OFFSET $2`,
      params
    );
    
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int as total ${query}`,
      search ? [search] : []
    );

    res.json({ 
      data: rows, 
      total: countRows[0].total, 
      page, 
      limit,
      totalPages: Math.ceil(countRows[0].total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro na paginação de histórico' });
  }
});

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
const hash = await bcrypt.hash(password, 10);
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
const { rows: before } = await pool.query(
  'SELECT username, email, minecraft_name, role FROM users WHERE id=$1', [id]
);

const result = await pool.query(
'UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6',
[username, email, minecraftName, photoUrl, role, id],
);
if (!result.rowCount) return res.status(404).json({ error: 'user not found' });

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'update',
  severity:   before[0]?.role !== role ? 'warning' : 'info',
  targetId:   id,
  targetName: username,
  message:    `Conta editada por admin: ${before[0]?.username || username} → ${username}${before[0]?.role !== role ? ` (cargo: ${before[0]?.role} → ${role})` : ''}`,
  metadata: {
    before: before[0] || null,
    after:  { username, email, minecraftName, role },
  },
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

const hash = await bcrypt.hash(newPassword, 10);
await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'security',
  severity:   'warning',
  targetId:   id,
  targetName: target[0].username,
  message:    `Senha redefinida por admin (${req.user.username}) para o usuário: ${target[0].username}`,
});

res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, requireOwner, async (req, res) => {
const id = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });

const { rows } = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'delete',
  severity:   'critical',
  targetId:   id,
  targetName: rows[0].username,
  message:    `Conta DELETADA por admin (${req.user.username}): ${rows[0].username}`,
  metadata:   { deletedUser: rows[0].username, deletedId: id },
});

await pool.query('DELETE FROM users WHERE id=$1', [id]);
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// SISTEMA DE CAPITAL E MÉRITO
// ─────────────────────────────────────────────

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

app.get('/api/me/rank-info', auth, async (req, res) => {
  const mc = req.user.minecraft_name?.toLowerCase();
  let merit = 0;
  let capital = 0;
  let records = [];
  let capitalRecords = [];

  if (mc) {
    // Garante que o registro existe antes de ler (insert-on-conflict é idempotente)
    await ensureBalance(mc);
    // Lê balance + histórico em paralelo (3 queries simultâneas)
    const [balanceRes, meritRows, capitalRows] = await Promise.all([
      pool.query('SELECT * FROM player_balances WHERE minecraft_name=$1', [mc]),
      pool.query('SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100', [mc]),
      pool.query('SELECT id, amount, type, description, created_by_name, created_at FROM capital_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100', [mc]),
    ]);
    merit = balanceRes.rows[0]?.merit_total || 0;
    capital = balanceRes.rows[0]?.capital_balance || 0;
    records = meritRows.rows;
    capitalRecords = capitalRows.rows;
  }

  if (['owner', 'full'].includes(req.user.role)) {
    return res.json({
      merit,
      capital,
      rank: { ...ADM_RANK, benefits: RANK_BENEFITS.adm },
      nextRank: null,
      progress: 100,
      isAdm: true,
      records,
      capitalRecords,
      allRanks: [...RANKS, ADM_RANK],
    });
  }

  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit,
    capital,
    rank: { ...rank, benefits: RANK_BENEFITS[rank.id] || [] },
    nextRank: nextRank ? { ...nextRank, benefits: RANK_BENEFITS[nextRank.id] || [] } : null,
    progress,
    isAdm: false,
    records,
    capitalRecords,
    allRanks: RANKS,
  });
});

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

app.post('/api/admin/merit', auth, requireAdmin, async (req, res) => {
  const mc       = sanitize(req.body?.minecraft_name).toLowerCase();
  const rawAmount = parseInt(req.body?.amount);
  const op       = ['credit', 'credito', 'add', 'conceder'].includes(req.body?.type) ? 'credit'
    : ['debit', 'debito', 'remove', 'penalidade'].includes(req.body?.type) ? 'debit'
    : null;
  const amount   = op === 'debit' || (!op && rawAmount < 0) ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const reason   = sanitize(req.body?.reason);
  const category = ['doacao', 'servico', 'evento', 'construcao', 'habito', 'acordo', 'penalidade', 'outro', 'outros'].includes(req.body?.category)
    ? (req.body.category === 'outro' ? 'outros' : req.body.category) : 'outros';

  if (!mc || isNaN(rawAmount) || rawAmount === 0 || !reason)
    return res.status(400).json({ error: 'Dados inválidos: minecraft_name, amount (≠0) e reason são obrigatórios.' });

  if (Math.abs(amount) > 500)
    return res.status(400).json({ error: 'Limite de ±500 Mérito por transação.' });

  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT merit_total FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentMerit = cur[0]?.merit_total || 0;
  const newMerit = Math.max(0, currentMerit + amount);

  await pool.query(
    'INSERT INTO merit_records(minecraft_name, amount, reason, category, awarded_by_id, awarded_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, reason, category, req.user.sub, req.user.username]
  );

  const newRank = await recalcRank(mc, newMerit);

  await audit({
    actorId: req.user.sub, actorName: req.user.username,
    type: 'update', targetName: mc,
    message: `Mérito ${amount > 0 ? '+' : ''}${amount} para ${mc}: "${reason}" (cat: ${category}). Total: ${newMerit}. Cargo: ${newRank.label}`,
    metadata: { mc, amount, reason, category, newMerit, newRank: newRank.id },
  });

  const actionText = amount > 0 ? 'ganhou' : 'perdeu';
  const notif = await createMinecraftNotification({
    minecraftName: mc,
    title: amount > 0 ? 'Você ganhou Mérito!' : 'Seu Mérito foi debitado',
    body: `${mc}, você ${actionText} ${Math.abs(amount)} ⭐ de Mérito. Motivo: ${reason}. Total atual: ${newMerit} ⭐. Cargo: ${newRank.label}.`,
    type: amount > 0 ? 'social' : 'warning',
    icon: amount > 0 ? '⭐' : '⚠️',
    createdBy: req.user.sub,
  });
  if (notif) {
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'notification_create', targetId: notif.id, targetName: mc,
      message: `Notificação automática de Mérito enviada para ${mc}`,
      metadata: { notificationId: notif.id, mc, amount, reason, newMerit },
    });
  }

  res.json({ ok: true, newMerit, new_total: newMerit, newRank: newRank.id, new_rank: newRank.label, rank: { ...newRank, benefits: RANK_BENEFITS[newRank.id] || [] }, prevMerit: currentMerit });
});

app.post('/api/admin/capital', auth, requireAdmin, async (req, res) => {
  const mc          = sanitize(req.body?.minecraft_name).toLowerCase();
  const rawAmount   = parseFloat(req.body?.amount);
  const rawType     = req.body?.type;
  const type        = ['credit', 'credito'].includes(rawType) ? 'credito'
    : ['debit', 'debito'].includes(rawType) ? 'debito'
    : ['rendimento', 'emprestimo', 'penalidade', 'ajuste'].includes(rawType) ? rawType
    : 'ajuste';
  const amount      = ['debito', 'penalidade'].includes(type) || (rawType === undefined && rawAmount < 0) ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const description = sanitize(req.body?.description);

  if (!mc || isNaN(rawAmount) || rawAmount === 0 || !description)
    return res.status(400).json({ error: 'Dados inválidos.' });

  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT capital_balance FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentCapital = cur[0]?.capital_balance || 0;
  const newCapital = Math.max(0, currentCapital + amount);

  await pool.query(
    'INSERT INTO capital_records(minecraft_name, amount, type, description, created_by_id, created_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, type, description, req.user.sub, req.user.username]
  );

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

  const actionText = amount > 0 ? 'ganhou' : 'perdeu';
  const notif = await createMinecraftNotification({
    minecraftName: mc,
    title: amount > 0 ? 'Você ganhou Capital!' : 'Seu Capital foi debitado',
    body: `${mc}, você ${actionText} ${Math.abs(amount).toLocaleString('pt-BR')} 💰 de Capital. Motivo: ${description}. Saldo atual: ${newCapital.toLocaleString('pt-BR')} 💰.`,
    type: amount > 0 ? 'social' : 'warning',
    icon: amount > 0 ? '💰' : '⚠️',
    createdBy: req.user.sub,
  });
  if (notif) {
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'notification_create', targetId: notif.id, targetName: mc,
      message: `Notificação automática de Capital enviada para ${mc}`,
      metadata: { notificationId: notif.id, mc, amount, type, description, newCapital },
    });
  }

  res.json({ ok: true, newCapital, new_balance: newCapital, prevCapital: currentCapital });
});

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
// Heartbeat de sessão (atualiza last_seen_at)
// ─────────────────────────────────────────────
app.post('/api/me/session/ping', auth, async (req, res) => {
  try {
    const { createHash } = await import('node:crypto');
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      'UPDATE user_sessions SET last_seen_at=NOW() WHERE token_hash=$1 AND revoked=FALSE',
      [tokenHash]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ─────────────────────────────────────────────
// ME – Sessões web
// ─────────────────────────────────────────────
app.get('/api/me/sessions', auth, async (req, res) => {
  try {
    const { createHash } = await import('node:crypto');
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      `SELECT id, token_hash, user_agent, ip, city, region, country, isp,
              last_seen_at, created_at, revoked
       FROM user_sessions
       WHERE user_id=$1 AND revoked=FALSE
       ORDER BY last_seen_at DESC`,
      [req.user.sub]
    );

    const sessions = rows.map(s => ({
      id:          s.id,
      is_current:  s.token_hash === currentHash,
      user_agent:  s.user_agent,
      ip:          s.ip,
      city:        s.city,
      region:      s.region,
      country:     s.country,
      isp:         s.isp,
      last_seen:   s.last_seen_at,
      created_at:  s.created_at,
    }));

    res.json({ sessions });
  } catch(e) {
    console.error('[GET /api/me/sessions]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/me/sessions/:id', auth, async (req, res) => {
  try {
    const { createHash } = await import('node:crypto');
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      'SELECT id, token_hash FROM user_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'session not found' });
    if (rows[0].token_hash === currentHash)
      return res.status(400).json({ error: 'cannot revoke current session' });

    await pool.query('UPDATE user_sessions SET revoked=TRUE WHERE id=$1', [rows[0].id]);
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `Sessão #${rows[0].id} encerrada remotamente`,
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('[DELETE /api/me/sessions/:id]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/me/sessions', auth, async (req, res) => {
  try {
    const { createHash } = await import('node:crypto');
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = createHash('sha256').update(rawToken).digest('hex');

    const { rowCount } = await pool.query(
      'UPDATE user_sessions SET revoked=TRUE WHERE user_id=$1 AND token_hash!=$2 AND revoked=FALSE',
      [req.user.sub, currentHash]
    );
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `${rowCount} outras sessões encerradas remotamente`,
    });
    res.json({ ok: true, revoked: rowCount });
  } catch(e) {
    console.error('[DELETE /api/me/sessions]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Middleware de captura de tentativas de acesso não autorizado
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if ((res.statusCode === 401 || res.statusCode === 403) && req.user) {
      audit({
        actorId:   req.user?.sub   || null,
        actorName: req.user?.username || null,
        type:      'security',
        severity:  'warning',
        message:   `Acesso negado: ${req.method} ${req.path}`,
        ip:        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        metadata:  { method: req.method, path: req.path, statusCode: res.statusCode },
      }).catch(() => {});
    }
    return originalJson(body);
  };
  next();
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
  app.listen(PORT, () => console.log(`✅  API ${DEPLOY_SCHEMA_VERSION} rodando na porta ${PORT}`));
})
.catch(e => { console.error('[migrate]', e); process.exit(1); });
