import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import util from 'minecraft-server-util';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (corsOrigins.length === 0) return cb(new Error('CORS blocked: no allowed origins configured'));
    if (corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked by policy'));
  },
  credentials: true
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

// ── Configuração do E-mail Blindada e à prova de travamentos ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    // Evita que o Render seja bloqueado por certificados rigorosos
    rejectUnauthorized: false
  },
  // Desiste após 10 segundos para não congelar a tela do usuário
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente mais tarde.' } });

function sanitizeInput(v) { return String(v || '').trim(); }
function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }
function validateUsername(username) { return /^[a-z0-9_]{3,32}$/i.test(username); }

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map((v) => v.trim()).filter(Boolean).map((part) => {
    const idx = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
  }));
}

function issueAuthCookies(res, token) {
  res.cookie('fa_auth', token, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
  res.cookie('fa_csrf', crypto.randomBytes(24).toString('hex'), { httpOnly: false, secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
}

function clearAuthCookies(res) {
  res.clearCookie('fa_auth', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.clearCookie('fa_csrf', { httpOnly: false, secure: true, sameSite: 'none', path: '/' });
}

function requireCsrf(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const cookies = parseCookies(req);
  const headerToken = req.headers['x-csrf-token'];
  if (!cookies.fa_csrf || !headerToken || cookies.fa_csrf !== headerToken) return res.status(403).json({ error: 'csrf check failed' });
  next();
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
      code VARCHAR(6) NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_player_name ON player_sessions(player);
    CREATE INDEX IF NOT EXISTS idx_player_active ON player_sessions(left_at);
    CREATE INDEX IF NOT EXISTS idx_pw_reset_email ON password_resets(email);
  `);
}

async function seedAdmin() {
  const adminUsername = sanitizeInput(process.env.BOOTSTRAP_ADMIN_USERNAME);
  const adminEmail = sanitizeInput(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

  if (!adminUsername || !adminEmail || !adminPassword) return;
  if (!validateUsername(adminUsername) || !validateEmail(adminEmail) || !validatePassword(adminPassword)) return;

  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [adminUsername.toLowerCase()]);
  if (rows.length > 0) return;

  const hash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    'INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
    [adminUsername.toLowerCase(), adminEmail, adminUsername, hash, 'full']
  );
}

function auth(req, res, next) {
  const cookies = parseCookies(req);
  const token = (req.headers.authorization || '').replace('Bearer ', '') || cookies.fa_auth;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

function requireFull(req, res, next) {
  if (req.user?.role !== 'full') return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/cron', async (req, res) => {
  const key = req.query.key || req.headers['x-ingest-secret'];
  if (key !== INGEST_SECRET) return res.status(403).json({ error: 'Acesso negado' });

  try {
    const host = process.env.MC_HOST || 'fa.ogabriels.com';
    const response = await fetch(`https://api.mcstatus.io/v2/status/java/${host}`, { headers: { 'User-Agent': 'forca-aliada-backend/1.0' } });
    if (!response.ok) throw new Error('Falha na API externa');
    
    const data = await response.json();
    const list = data?.players?.list || [];
    const onlinePlayers = list.map(p => p.name_clean || p.name_raw || p.name).filter(Boolean);
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
    console.error('Erro no cron:', err);
    res.status(500).json({ error: 'Falha ao atualizar dados' });
  }
});

// ── ROTAS DE RECUPERAÇÃO DE PALAVRA-PASSE ──

app.post('/api/auth/forgot-password', emailLimiter, async (req, res) => {
  const email = sanitizeInput(req.body?.email).toLowerCase();
  if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

  await pool.query('DELETE FROM password_resets WHERE email = $1 OR expires_at < NOW()', [email]);

  const { rows } = await pool.query('SELECT username FROM users WHERE email = $1', [email]);
  if (rows.length === 0) {
    return res.json({ ok: true }); 
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
  
  await pool.query('INSERT INTO password_resets (email, code, expires_at) VALUES ($1, $2, $3)', [email, code, expiresAt]);

  const mailOptions = {
    from: `"Segurança | Força Aliada" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Código de Recuperação de Palavra-passe',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e5ea; border-radius: 12px;">
        <h2 style="color: #1d1d1f;">Força Aliada</h2>
        <p style="color: #1d1d1f; font-size: 16px;">Olá <strong>${rows[0].username}</strong>,</p>
        <p style="color: #86868b; font-size: 15px;">Recebemos um pedido para repor a palavra-passe da sua conta. Utilize o código de 6 dígitos abaixo no site:</p>
        <div style="background: #f2f2f7; padding: 16px; border-radius: 8px; text-align: center; margin: 24px 0;">
          <strong style="font-size: 32px; letter-spacing: 4px; color: #0071e3;">${code}</strong>
        </div>
        <p style="color: #86868b; font-size: 13px;">Este código expira em 15 minutos. Se não pediu esta alteração, por favor ignore este e-mail.</p>
      </div>
    `
  };

  try {
    if (process.env.SMTP_USER) await transporter.sendMail(mailOptions);
    res.json({ ok: true });
  } catch (error) {
    console.error("SMTP Error:", error);
    res.status(500).json({ error: 'Erro de conexão com servidor de e-mail.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const code = sanitizeInput(req.body?.code);
  const newPassword = req.body?.newPassword;

  if (!validateEmail(email) || !code || !validatePassword(newPassword)) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }

  const { rows } = await pool.query('SELECT * FROM password_resets WHERE email = $1 AND code = $2 AND expires_at > NOW()', [email, code]);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email]);
  await pool.query('DELETE FROM password_resets WHERE email = $1', [email]);

  res.json({ ok: true });
});

// ── ROTAS DE AUTENTICAÇÃO EXISTENTES ──

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeInput(req.body?.minecraftName || username);
  const password = req.body?.password || '';

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password)) {
    return res.status(400).json({ error: 'invalid signup payload' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [username, email, minecraftName, hash, 'limited']);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const login = sanitizeInput(req.body?.login).toLowerCase();
  const password = req.body?.password || '';
  if (!login || !password) return res.status(400).json({ error: 'missing fields' });

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [login]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'invalid credentials' });

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  issueAuthCookies(res, token);
  res.json({ user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role } });
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT username,email,minecraft_name,photo_url,role FROM users WHERE id = $1', [req.user.sub]);
  res.json(rows[0] || {});
});

async function changeMyPassword(req, res) {
  const currentPassword = req.body?.currentPassword || '';
  const newPassword = req.body?.newPassword || '';
  if (!validatePassword(newPassword)) return res.status(400).json({ error: 'invalid new password' });

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) return res.status(401).json({ error: 'invalid current password' });

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.sub]);
  res.json({ ok: true });
}

app.post('/api/me/password', auth, requireCsrf, changeMyPassword);
app.put('/api/me/password', auth, requireCsrf, changeMyPassword);

app.post('/api/snapshots/import', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const secret = req.headers['x-ingest-secret'] || bearer;
  if (secret !== INGEST_SECRET) return res.status(403).json({ error: 'Acesso negado' });

  const payload = req.body?.payload;
  const onlinePlayers = Array.isArray(payload?.onlinePlayers) ? payload.onlinePlayers : [];
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

  res.json({ ok: true });
});

app.get('/api/snapshots/latest', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);
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

app.get('/api/admin/users', auth, requireFull, async (_req, res) => {
  const { rows } = await pool.query('SELECT id, username, email, minecraft_name, photo_url, role, created_at FROM users ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/admin/users', auth, requireFull, requireCsrf, async (req, res) => {
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeInput(req.body?.minecraftName || username);
  const password = req.body?.password || '';
  const role = req.body?.role === 'full' ? 'full' : 'limited';

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password)) return res.status(400).json({ error: 'invalid fields' });

  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [username, email, minecraftName, hash, role]);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.put('/api/admin/users/:id', auth, requireFull, requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const username = sanitizeInput(req.body?.username).toLowerCase();
  const email = sanitizeInput(req.body?.email).toLowerCase();
  const minecraftName = sanitizeInput(req.body?.minecraftName || username);
  const photoUrl = sanitizeInput(req.body?.photoUrl || 'logo.JPG');
  const role = req.body?.role === 'full' ? 'full' : 'limited';
  const newPassword = req.body?.newPassword || '';

  if (!validateUsername(username) || !validateEmail(email)) return res.status(400).json({ error: 'invalid fields' });

  try {
    if (newPassword.trim()) {
      if (!validatePassword(newPassword)) return res.status(400).json({ error: 'invalid new password' });
      const hash = await bcrypt.hash(newPassword, 12);
      const result = await pool.query('UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5, password_hash=$6 WHERE id=$7', [username, email, minecraftName, photoUrl, role, hash, id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'user not found' });
    } else {
      const result = await pool.query('UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6', [username, email, minecraftName, photoUrl, role, id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'user not found' });
    }
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.delete('/api/admin/users/:id', auth, requireFull, requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'user not found' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

migrate().then(seedAdmin).catch(console.error);

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));