import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(cors());
app.use(express.json());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..', '..');
app.use(express.static(webRoot));

const db = new Database('backend/data/app.db');
const JWT_SECRET = process.env.JWT_SECRET || 'trocar-em-producao';

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      minecraft_name TEXT,
      photo_url TEXT DEFAULT 'logo.JPG',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'limited',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS player_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS player_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      entered_at TEXT,
      left_at TEXT,
      hours_online REAL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'monitor',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(nickname, entered_at, left_at)
    );
  `);
}

function seedAdmin() {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get('gabalarca');
  if (exists) return;
  const hash = bcrypt.hashSync('Famosos1290+', 10);
  db.prepare('INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES (?,?,?,?,?)')
    .run('gabalarca', 'gabalarcadsmoreira2016@gmail.com', 'gabalarca', hash, 'full');
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
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

app.post('/api/auth/signup', (req, res) => {
  const { username, email, password, minecraftName } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES (?,?,?,?,?)')
      .run(username.toLowerCase(), email.toLowerCase(), minecraftName || username, hash, 'limited');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get((login || '').toLowerCase(), (login || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role } });
});

app.get('/login', (_req, res) => res.sendFile(path.join(webRoot, 'login.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(webRoot, 'signup.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(webRoot, 'dashboard.html')));
app.get('/login.html', (_req, res) => res.sendFile(path.join(webRoot, 'login.html')));
app.get('/signup.html', (_req, res) => res.sendFile(path.join(webRoot, 'signup.html')));
app.get('/dashboard.html', (_req, res) => res.sendFile(path.join(webRoot, 'dashboard.html')));

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT username,email,minecraft_name,photo_url,role FROM users WHERE id = ?').get(req.user.sub);
  res.json(user);
});

app.post('/api/me/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.sub);
  if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) return res.status(401).json({ error: 'invalid current password' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.sub);
  res.json({ ok: true });
});

app.post('/api/snapshots/import', (req, res) => {
  const { secret, payload } = req.body;
  if (secret !== (process.env.INGEST_SECRET || 'change-ingest')) return res.status(403).json({ error: 'forbidden' });
  db.prepare('INSERT INTO player_snapshots (generated_at,payload) VALUES (?,?)').run(new Date().toISOString(), JSON.stringify(payload));
  const now = new Date().toISOString();
  const onlinePlayers = Array.isArray(payload?.onlinePlayers) ? payload.onlinePlayers : [];
  for (const nick of onlinePlayers) {
    db.prepare(`INSERT INTO players (nickname, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(nickname) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(nick, now, now);
  }
  const history = Array.isArray(payload?.history) ? payload.history : [];
  for (const h of history) {
    if (!h?.player) continue;
    db.prepare(`INSERT INTO players (nickname, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(nickname) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(h.player, h.enteredAt || now, h.leftAt || now);
    db.prepare(`INSERT OR IGNORE INTO player_events (nickname, entered_at, left_at, hours_online, source)
      VALUES (?, ?, ?, ?, 'monitor')`).run(h.player, h.enteredAt || null, h.leftAt || null, Number(h.hoursOnline || 0));
  }
  res.json({ ok: true });
});

app.get('/api/live-status', async (_req, res) => {
  try {
    const response = await fetch('https://api.mcstatus.io/v2/status/java/fa.ogabriels.com');
    if (!response.ok) return res.status(502).json({ error: 'upstream error' });
    const data = await response.json();
    const list = (data.players?.list || []).map((p) => p.name_clean || p.name_raw || p.name).filter(Boolean);
    res.json({
      online: !!data.online,
      onlineCount: typeof data.players?.online === 'number' ? data.players.online : list.length,
      onlinePlayers: list
    });
  } catch {
    res.status(500).json({ error: 'failed to fetch live status' });
  }
});

app.get('/api/snapshots/latest', auth, (req, res) => {
  const row = db.prepare('SELECT generated_at,payload FROM player_snapshots ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ generatedAt: null, onlinePlayers: [], onlineCount: 0, summary: { joinedToday: 0, leftToday: 0, avgHours: 0 }, history: [] });
  const parsed = JSON.parse(row.payload);
  const dbHistory = db.prepare('SELECT nickname as player, entered_at as enteredAt, left_at as leftAt, hours_online as hoursOnline FROM player_events ORDER BY id DESC LIMIT 1000').all();
  if (dbHistory.length) parsed.history = dbHistory;
  const liveCount = db.prepare('SELECT COUNT(*) as c FROM players WHERE last_seen_at >= datetime(\"now\", \"-15 minutes\")').get();
  parsed.onlineCount = Math.max(Number(parsed.onlineCount || 0), Number(liveCount?.c || 0));
  if (req.user.role !== 'full' && Array.isArray(parsed.history)) parsed.history = parsed.history.slice(0, 10);
  res.json(parsed);
});

app.get('/api/admin/users', auth, requireFull, (req, res) => {
  const users = db.prepare('SELECT id,username,email,minecraft_name,photo_url,role,created_at FROM users ORDER BY id DESC').all();
  res.json(users);
});

app.put('/api/admin/users/:id', auth, requireFull, (req, res) => {
  const id = Number(req.params.id);
  const { username, email, minecraftName, newPassword } = req.body || {};
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  try {
    db.prepare('UPDATE users SET username=?, email=?, minecraft_name=? WHERE id=?')
      .run(String(username || '').toLowerCase(), String(email || '').toLowerCase(), minecraftName || '', id);
    if (newPassword) {
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
    }
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

migrate();
seedAdmin();
app.listen(8787, () => console.log('API on http://localhost:8787'));
