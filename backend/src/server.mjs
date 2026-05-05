import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'node:crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (corsOrigins.length === 0) return cb(new Error('CORS blocked: no allowed origins configured'));
    if (corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked by policy'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Ingest-Secret', 'X-CSRF-Token']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL_NO_VERIFY === 'true' ? { rejectUnauthorized: false } : undefined
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set with at least 32 characters');

const INGEST_SECRET = process.env.INGEST_SECRET;
if (!INGEST_SECRET || INGEST_SECRET.length < 16) throw new Error('INGEST_SECRET must be set with at least 16 characters');

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente mais tarde.' } });

const TOKEN_TTL = '7d';
const AUTH_COOKIE = 'fa_auth';
const CSRF_COOKIE = 'fa_csrf';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/'
};
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"]|'/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function randomCode() { return String(crypto.randomInt(100000, 1000000)); }
function hashCode(code) { return crypto.createHash('sha256').update(`${JWT_SECRET}:${code}`).digest('hex'); }
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  return raw.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
function getAuthToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  const cookieToken = getCookie(req, AUTH_COOKIE);
  return cookieToken ? decodeURIComponent(cookieToken) : '';
}
function setAuthCookies(res, token) {
  res.cookie(AUTH_COOKIE, token, COOKIE_OPTIONS);
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, csrf, { ...COOKIE_OPTIONS, httpOnly: false });
}
function clearAuthCookies(res) {
  res.clearCookie(AUTH_COOKIE, { ...COOKIE_OPTIONS, maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, { ...COOKIE_OPTIONS, httpOnly: false, maxAge: undefined });
}
async function issueAuth(res, user) {
  const tokenVersion = Number(user.token_version || 0);
  const token = jwt.sign({ sub: user.id, role: user.role, tv: tokenVersion }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  setAuthCookies(res, token);
  return token;
}
function sendAuthResponse(res, _token, user) {
  res.json({
    user: {
      username: user.username,
      email: user.email,
      minecraftName: user.minecraft_name,
      photoUrl: user.photo_url,
      role: user.role
    }
  });
}
function sanitizeMinecraftName(v) {
  const value = sanitizeInput(v);
  return validateMinecraftName(value) ? value : '';
}
function validateMinecraftName(name) { return /^[a-z0-9_]{1,16}$/i.test(name); }
function validatePhotoUrl(url) {
  if (!url) return true;
  return /^(?:[a-z0-9_.-]+|assets\/images\/[a-z0-9_.-]+|https:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?)$/i.test(url);
}
function normalizeLimit(value, fallback = 500, max = 2000) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}
async function countFullAdmins(client = pool) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'full'");
  return rows[0]?.count || 0;
}
async function logAudit(actorId, action, targetUserId, details = {}) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor_user_id, action, target_user_id, details) VALUES ($1,$2,$3,$4)',
      [actorId || null, action, targetUserId || null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Falha ao registrar auditoria', err);
  }
}

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const publicAuthPaths = new Set([
    '/api/auth/login',
    '/api/auth/signup',
    '/api/auth/verify-email',
    '/api/auth/forgot-password',
    '/api/auth/reset-password'
  ]);
  if (publicAuthPaths.has(req.path)) return next();
  const hasBearer = (req.headers.authorization || '').startsWith('Bearer ');
  const hasAuthCookie = Boolean(getCookie(req, AUTH_COOKIE));
  if (!hasBearer && hasAuthCookie && !safeEqual(req.headers['x-csrf-token'], getCookie(req, CSRF_COOKIE))) {
    return res.status(403).json({ error: 'csrf check failed' });
  }
  next();
});

function sanitizeInput(v) { return String(v || '').replace(/[<>]/g, '').trim(); }
function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }
function validateUsername(username) { return /^[a-z0-9_]{3,32}$/i.test(username); }

async function sendSystemEmail(email, username, code, type = 'verify') {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.log(`\n[DEV-MODE] E-mail para: ${email} | Código: ${code}\n`);
    return;
  }
  const senderEmail = process.env.EMAIL_FROM || 'no-reply@ogabriels.com';
  const subject = type === 'verify' ? 'Verifique sua conta' : 'Código de Recuperação';
  const title = type === 'verify' ? 'Bem-vindo à Força Aliada!' : 'Força Aliada';
  const subtitle = type === 'verify' ? 'Use o código abaixo para ativar o seu cadastro de Staff:' : 'Utilize o código de 6 dígitos abaixo no site:';

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e5ea;border-radius:12px;"><h2 style="color:#1d1d1f;">${escapeHtml(title)}</h2><p style="color:#1d1d1f;font-size:16px;">Olá <strong>${escapeHtml(username)}</strong>,</p><p style="color:#86868b;font-size:15px;">${escapeHtml(subtitle)}</p><div style="background:#f2f2f7;padding:16px;border-radius:8px;text-align:center;margin:24px 0;"><strong style="font-size:32px;letter-spacing:4px;color:#0071e3;">${escapeHtml(code)}</strong></div><p style="color:#86868b;font-size:13px;">Este código expira em 15 minutos.</p></div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: senderEmail, to: email, subject, html })
    });
  } catch(e) { console.error('Falha ao enviar email', e); }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      minecraft_name VARCHAR(255),
      photo_url VARCHAR(255) DEFAULT 'logo.JPG',
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'limited' CHECK (role IN ('full', 'limited')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ALTER COLUMN is_verified SET DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS player_sessions (
      id SERIAL PRIMARY KEY,
      player VARCHAR(255) NOT NULL,
      entered_at TIMESTAMP NOT NULL,
      left_at TIMESTAMP,
      duration_hours FLOAT
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(6),
      code_hash VARCHAR(64),
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMP NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(6),
      code_hash VARCHAR(64),
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMP NOT NULL
    );
    ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64);
    ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE password_resets ALTER COLUMN code DROP NOT NULL;
    ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64);
    ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE email_verifications ALTER COLUMN code DROP NOT NULL;
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_player_name ON player_sessions(player);
    CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
  `);
}

async function seedAdmin() {
  const adminUsername = sanitizeInput(process.env.BOOTSTRAP_ADMIN_USERNAME).toLowerCase();
  const adminEmail = sanitizeInput(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

  if (!adminUsername && !adminEmail && !adminPassword) return;
  if (!validateUsername(adminUsername) || !validateEmail(adminEmail) || !validatePassword(adminPassword)) {
    throw new Error('BOOTSTRAP_ADMIN_* inválido: use username válido, e-mail válido e senha com 8 a 128 caracteres');
  }
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [adminUsername, adminEmail]);
  if (rows.length > 0) return;

  const hash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    'INSERT INTO users (username,email,minecraft_name,password_hash,role,is_verified) VALUES ($1,$2,$3,$4,$5,$6)',
    [adminUsername, adminEmail, adminUsername, hash, 'full', true]
  );
}

// ── PROTEÇÃO COM BANCO DE DADOS (Real-Time Auth) ──
async function auth(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'missing token' });
  try { 
    const decoded = jwt.verify(token, JWT_SECRET); 
    // Segurança Ativa: Verifica se o usuário ainda existe e pega o cargo atualizado
    const { rows } = await pool.query('SELECT role, is_verified, token_version FROM users WHERE id = $1', [decoded.sub]);
    if (rows.length === 0) return res.status(401).json({ error: 'user deleted' });
    if (rows[0].is_verified === false) return res.status(403).json({ error: 'unverified_email' });
    if (Number(decoded.tv || 0) !== Number(rows[0].token_version || 0)) return res.status(401).json({ error: 'session revoked' });
    
    req.user = { sub: decoded.sub, role: rows[0].role, is_verified: rows[0].is_verified };
    next(); 
  } 
  catch { res.status(401).json({ error: 'invalid token' }); }
}

function requireFull(req, res, next) {
  // Como o auth lê o BD sempre, req.user.role é sempre 100% fiel à realidade!
  if (req.user?.role !== 'full') return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── ROBÔ DO GITHUB ACTIONS / DESPERTADOR ──
app.get('/api/cron', async (req, res) => {
  const key = req.query.key || req.headers['x-ingest-secret'];
  if (key !== INGEST_SECRET) return res.status(403).json({ error: 'Acesso negado' });

  try {
    const host = process.env.MC_HOST || 'fa.ogabriels.com';
    const response = await fetch(`https://api.mcstatus.io/v2/status/java/${host}`, { headers: { 'User-Agent': 'forca-aliada-backend/1.0' } });
    if (!response.ok) throw new Error('Falha na API externa');
    
    const data = await response.json();
    const list = data?.players?.list || [];
    const onlinePlayers = list.map(p => sanitizeMinecraftName(p.name_clean || p.name_raw || p.name)).filter(Boolean);
    const now = new Date();

    const activeFromDB = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
    
    for (const row of activeFromDB.rows) {
      if (!onlinePlayers.includes(row.player)) {
        const duration = (now - new Date(row.entered_at)) / 3600000;
        await pool.query('UPDATE player_sessions SET left_at = $1, duration_hours = $2 WHERE player = $3 AND left_at IS NULL', [now, Number(duration.toFixed(2)), row.player]);
      }
    }

    for (const p of onlinePlayers) {
      const isAlreadyActive = activeFromDB.rows.some((r) => r.player === p);
      if (!isAlreadyActive) await pool.query('INSERT INTO player_sessions (player, entered_at) VALUES ($1, $2)', [String(p), now]);
    }

    res.json({ ok: true, online: onlinePlayers.length });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao atualizar dados' });
  }
});

// ── RECUPERAÇÃO DE PALAVRA-PASSE ──
app.post('/api/auth/forgot-password', emailLimiter, async (req, res) => {
  const email = sanitizeInput(req.body?.email).toLowerCase();
  if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

  await pool.query('DELETE FROM password_resets WHERE email = $1 OR expires_at < NOW()', [email]);
  const { rows } = await pool.query('SELECT username FROM users WHERE email = $1', [email]);
  if (rows.length === 0) return res.json({ ok: true }); 

  const code = randomCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query('INSERT INTO password_resets (email, code_hash, expires_at) VALUES ($1, $2, $3)', [email, hashCode(code), expiresAt]);

  await sendSystemEmail(email, rows[0].username, code, 'reset');
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const code = sanitizeInput(req.body?.code);
  const newPassword = req.body?.newPassword;

  if (!validateEmail(email) || !code || !validatePassword(newPassword)) return res.status(400).json({ error: 'Dados inválidos' });

  const { rows } = await pool.query('SELECT * FROM password_resets WHERE email = $1 AND expires_at > NOW() ORDER BY id DESC LIMIT 1', [email]);
  const reset = rows[0];
  if (!reset || reset.attempts >= 5 || !safeEqual(reset.code_hash, hashCode(code))) {
    await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE email = $1 AND expires_at > NOW()', [email]);
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE email = $2', [hash, email]);
  await pool.query('DELETE FROM password_resets WHERE email = $1', [email]);
  res.json({ ok: true });
});

// ── AUTENTICAÇÃO E VERIFICAÇÃO ──
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeMinecraftName(req.body?.minecraftName || username);
  const password = req.body?.password || '';

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password) || !validateMinecraftName(minecraftName)) return res.status(400).json({ error: 'Dados inválidos.' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (username,email,minecraft_name,password_hash,role,is_verified) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING username', 
      [username, email, minecraftName, hash, 'limited']
    );

    const code = randomCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
    await pool.query('INSERT INTO email_verifications (email, code_hash, expires_at) VALUES ($1, $2, $3)', [email, hashCode(code), expiresAt]);

    await sendSystemEmail(email, rows[0].username, code, 'verify');

    res.json({ ok: true, requireVerification: true, email });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const code = sanitizeInput(req.body?.code);

  if (!validateEmail(email) || !code) return res.status(400).json({ error: 'Dados inválidos' });

  const { rows } = await pool.query('SELECT * FROM email_verifications WHERE email = $1 AND expires_at > NOW() ORDER BY id DESC LIMIT 1', [email]);
  const verification = rows[0];
  if (!verification || verification.attempts >= 5 || !safeEqual(verification.code_hash, hashCode(code))) {
    await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE email = $1 AND expires_at > NOW()', [email]);
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  }

  const updateRes = await pool.query('UPDATE users SET is_verified = TRUE WHERE email = $1 RETURNING *', [email]);
  await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);

  const user = updateRes.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const token = await issueAuth(res, user);
  sendAuthResponse(res, token, user);
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const login = sanitizeInput(req.body?.login).toLowerCase();
  const password = req.body?.password || '';
  if (!login || !password) return res.status(400).json({ error: 'missing fields' });

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [login]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'invalid credentials' });

  if (user.is_verified === false) {
    const code = randomCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email = $1', [user.email]);
    await pool.query('INSERT INTO email_verifications (email, code_hash, expires_at) VALUES ($1, $2, $3)', [user.email, hashCode(code), expiresAt]);
    await sendSystemEmail(user.email, user.username, code, 'verify');

    return res.status(403).json({ error: 'unverified_email', email: user.email });
  }

  const token = await issueAuth(res, user);
  sendAuthResponse(res, token, user);
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT username,email,minecraft_name,photo_url,role,is_verified FROM users WHERE id = $1', [req.user.sub]);
  if (rows.length === 0) return res.status(401).json({ error: 'user deleted' });
  res.json(rows[0]);
});

async function changeMyPassword(req, res) {
  const currentPassword = req.body?.currentPassword || '';
  const newPassword = req.body?.newPassword || '';
  if (!validatePassword(newPassword)) return res.status(400).json({ error: 'invalid new password' });

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) return res.status(401).json({ error: 'invalid current password' });

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, req.user.sub]);
  clearAuthCookies(res);
  res.json({ ok: true });
}
app.post('/api/me/password', auth, changeMyPassword);
app.put('/api/me/password', auth, changeMyPassword);

// ── DADOS DO DASHBOARD ──
app.get('/api/snapshots/latest', auth, async (req, res) => {
  const limit = normalizeLimit(req.query.limit);
  if (!limit) return res.status(400).json({ error: 'invalid limit' });
  const online = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
  const history = await pool.query('SELECT player, entered_at, left_at, duration_hours FROM player_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT $1', [limit]);
  res.json({
    onlinePlayers: online.rows.map((r) => r.player),
    activeSessions: online.rows.reduce((acc, r) => ({ ...acc, [r.player]: { name: r.player, enteredAt: r.entered_at } }), {}),
    history: history.rows.map((r) => ({ player: r.player, enteredAt: r.entered_at, leftAt: r.left_at, hoursOnline: r.duration_hours }))
  });
});

app.get('/api/player/:name/history', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE player = $1 ORDER BY entered_at DESC', [req.params.name]);
  res.json(rows);
});

// ── ADMIN ──
app.get('/api/admin/users', auth, requireFull, async (_req, res) => {
  const { rows } = await pool.query('SELECT id, username, email, minecraft_name, photo_url, role, is_verified, created_at FROM users ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/admin/users', auth, requireFull, async (req, res) => {
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeMinecraftName(req.body?.minecraftName || username);
  const password = req.body?.password || '';
  const role = req.body?.role === 'full' ? 'full' : 'limited';

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password) || !validateMinecraftName(minecraftName)) return res.status(400).json({ error: 'invalid fields' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO users (username,email,minecraft_name,password_hash,role,is_verified) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id', [username, email, minecraftName, hash, role]);
    await logAudit(req.user.sub, 'admin.user.create', rows[0].id, { role });
    res.json(rows[0]);
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.put('/api/admin/users/:id', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeMinecraftName(req.body?.minecraftName || username);
  const photoUrl = sanitizeInput(req.body?.photoUrl || 'logo.JPG');
  const role = req.body?.role === 'full' ? 'full' : 'limited';
  
  if (!validateUsername(username) || !validateEmail(email) || !validateMinecraftName(minecraftName) || !validatePhotoUrl(photoUrl)) return res.status(400).json({ error: 'invalid fields' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentRes = await client.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [id]);
    const current = currentRes.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    if (id === Number(req.user.sub) && current.role !== role) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot change own role' });
    }
    if (current.role === 'full' && role !== 'full' && await countFullAdmins(client) <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot demote last full admin' });
    }
    await client.query('UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6', [username, email, minecraftName, photoUrl, role, id]);
    await client.query('COMMIT');
    await logAudit(req.user.sub, 'admin.user.update', id, { role });
    res.json({ ok: true });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    res.status(409).json({ error: 'username/email already exists' });
  } finally {
    client.release();
  }
});

app.put('/api/admin/users/:id/password', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const newPassword = req.body?.newPassword || '';
  if (!validatePassword(newPassword)) return res.status(400).json({ error: 'invalid new password' });

  const hash = await bcrypt.hash(newPassword, 12);
  const result = await pool.query('UPDATE users SET password_hash=$1, token_version = token_version + 1 WHERE id=$2', [hash, id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'user not found' });
  await logAudit(req.user.sub, 'admin.user.password', id);
  if (id === Number(req.user.sub)) clearAuthCookies(res);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (id === Number(req.user.sub)) return res.status(400).json({ error: 'cannot delete current user' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT username, role FROM users WHERE id = $1 FOR UPDATE', [id]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    if (target.role === 'full' && await countFullAdmins(client) <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot delete last full admin' });
    }
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    await logAudit(req.user.sub, 'admin.user.delete', id, { username: target.username });
    res.json({ ok: true });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', (_req, res) => { clearAuthCookies(res); res.json({ ok: true }); });
app.use((err, _req, res, _next) => { res.status(500).json({ error: 'internal error' }); });

const PORT = process.env.PORT || 8787;

try {
  await migrate();
  await seedAdmin();
  app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
} catch (err) {
  console.error('Falha ao inicializar API', err);
  process.exit(1);
}