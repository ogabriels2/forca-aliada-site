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
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];
const corsOrigins = Array.from(new Set([
  ...defaultCorsOrigins,
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]));

app.use(cors({
origin(origin, cb) {
if (!origin) return cb(null, true);
if (corsOrigins.includes(origin)) return cb(null, true);
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
await pool.query(`
-- Usuários
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
ALTER TABLE users ADD CONSTRAINT users_role_check
CHECK (role IN ('owner','full','limited'));

-- Sessões Minecraft
CREATE TABLE IF NOT EXISTS player_sessions (
  id            SERIAL PRIMARY KEY,
  player        VARCHAR(255) NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL,
  left_at       TIMESTAMPTZ,
  duration_hours FLOAT
);
CREATE INDEX IF NOT EXISTS idx_player_name      ON player_sessions(player);
CREATE INDEX IF NOT EXISTS idx_player_left_at   ON player_sessions(left_at DESC);

-- Password resets
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

-- Email verifications
CREATE TABLE IF NOT EXISTS email_verifications (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

-- ── NOVO: Notificações ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  body        TEXT         NOT NULL,
  type        VARCHAR(50)  NOT NULL DEFAULT 'info',
  icon        VARCHAR(20)  DEFAULT '🔔',
  -- audience type: 'all' | 'role' | 'user' | 'minecraft'
  audience    VARCHAR(20)  NOT NULL DEFAULT 'all',
  -- audience value: role name, user id (text), or minecraft_name
  audience_val TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Leituras de notificações
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

-- ── NOVO: Logs de auditoria ───────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         SERIAL PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(255),
  type       VARCHAR(50) NOT NULL,   -- create | update | delete | login | system | notify
  target_id  INTEGER,
  target_name VARCHAR(255),
  message    TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type    ON audit_logs(type);

-- ── NOVO: Notas de jogadores ──────────────────────────────
CREATE TABLE IF NOT EXISTS player_notes (
  id           SERIAL PRIMARY KEY,
  minecraft_name VARCHAR(255) NOT NULL,
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name  VARCHAR(255),
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_mc ON player_notes(LOWER(minecraft_name));

-- ── NOVO: Preferências do usuário ─────────────────────────
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

`);
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
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
// Cron – Minecraft snapshot
// ─────────────────────────────────────────────
app.get('/api/cron', async (req, res) => {
const key = req.query.key || req.headers['x-ingest-secret'];
if (key !== INGEST_SECRET) return res.status(403).json({ error: 'forbidden' });

try {
const host = process.env.MC_HOST || 'fa.ogabriels.com';
const resp = await fetch(`https://api.mcstatus.io/v2/status/java/${host}`, {
headers: { 'User-Agent': 'forca-aliada-backend/2.0' },
});
if (!resp.ok) throw new Error('mcstatus failed');
const data = await resp.json();

const list = data?.players?.list || [];
const onlinePlayers = list
  .map(p => p.name_clean || p.name_raw || p.name)
  .filter(Boolean);
const now = new Date();

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
const { rows } = await pool.query(
'SELECT id, username, email, minecraft_name, photo_url, role, is_verified, created_at FROM users WHERE id=$1',
[req.user.sub],
);
if (!rows.length) return res.status(401).json({ error: 'user deleted' });
res.json(rows[0]);
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
  const prefs = await ensureUserPreferences(req.user.sub, req.body || {});
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
  const title       = sanitize(req.body?.title);
  const body        = sanitize(req.body?.body);
  const type        = ['info','event','system','social','warning'].includes(req.body?.type)
  ? req.body.type : 'info';
  const icon        = sanitize(req.body?.icon || '🔔').slice(0, 10);
  const audience    = ['all','role','user','minecraft'].includes(req.body?.audience)
  ? req.body.audience : 'all';
  const audienceVal = req.body?.audience_val ? sanitize(String(req.body.audience_val)) : null;

if (!title || !body)
return res.status(400).json({ error: 'title and body are required' });

// Validações de audience
if (audience === 'role' && !['owner','full','limited'].includes(audienceVal))
return res.status(400).json({ error: 'invalid role' });

if (audience === 'user') {
const uid = parseInt(audienceVal);
if (!uid) return res.status(400).json({ error: 'invalid user id' });
const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [uid]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });
}

const { rows } = await pool.query(` INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
[title, body, type, icon, audience, audienceVal, req.user.sub],
);

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'notify',
message: `Notificação criada: "${title}" (audience: ${audience}${audienceVal ? ` → ${audienceVal}` : ''})`,
metadata: { notificationId: rows[0].id },
});

res.status(201).json(rows[0]);
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
  const type  = req.query.type && req.query.type !== 'all' ? req.query.type : null;
  const page  = Math.max(0, parseInt(req.query.page  || 0));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));

const where  = type ? 'WHERE type=$1' : '';
const params = type ? [type, limit, page * limit] : [limit, page * limit];
const offset = type ? 3 : 2;

const { rows } = await pool.query(
`SELECT id, actor_id, actor_name, type, target_id, target_name, message, metadata, created_at FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${offset - 1} OFFSET $${offset}`,
params,
);

const { rows: total } = await pool.query(
`SELECT COUNT(*)::int AS count FROM audit_logs ${where}`,
type ? [type] : [],
);

res.json({ logs: rows, total: total[0].count });
});

// ─────────────────────────────────────────────
// NOTAS DE JOGADORES
// ─────────────────────────────────────────────

/**

- GET /api/player/:name/notes
  */
  app.get('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc = req.params.name;
  const { rows } = await pool.query(
  'SELECT id, author_name, text, created_at FROM player_notes WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC',
  [mc.toLowerCase()],
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
  const mc     = req.params.name;
  if (!noteId) return res.status(400).json({ error: 'invalid id' });

// Owner pode deletar qualquer nota; admin só as suas
const ownClause = req.user.role === 'owner' ? '' : 'AND author_id=$3';
const params    = req.user.role === 'owner'
? [noteId, mc.toLowerCase()]
: [noteId, mc.toLowerCase(), req.user.sub];

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
  const { rows } = await pool.query(`SELECT ps.player, COUNT(ps.id)::int                         AS total_sessions, COALESCE(SUM(ps.duration_hours), 0)::float AS total_hours, MIN(ps.entered_at)                         AS first_seen, MAX(COALESCE(ps.left_at, ps.entered_at))   AS last_seen FROM player_sessions ps WHERE NOT EXISTS ( SELECT 1 FROM users u WHERE LOWER(u.minecraft_name) = LOWER(ps.player) ) GROUP BY ps.player ORDER BY last_seen DESC LIMIT 500  `);
  res.json(rows);
  });

// ─────────────────────────────────────────────
// HISTÓRICO POR JOGADOR
// ─────────────────────────────────────────────
app.get('/api/player/:name/history', auth, requireAdmin, async (req, res) => {
const { rows } = await pool.query(
'SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE player=$1 ORDER BY entered_at DESC',
[req.params.name],
);
res.json(rows);
});

// ─────────────────────────────────────────────
// ADMIN – Gerenciamento de usuários
// ─────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (_req, res) => {
const { rows } = await pool.query(
'SELECT id, username, email, minecraft_name, photo_url, role, is_verified, created_at FROM users ORDER BY id DESC',
);
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
// Error handler
// ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
console.error('[error]', err?.message || err);
res.status(500).json({ error: 'internal error' });
});

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
migrate()
.then(seedAdmin)
.catch(e => { console.error('[migrate]', e); process.exit(1); });

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✅  API rodando na porta ${PORT}`));