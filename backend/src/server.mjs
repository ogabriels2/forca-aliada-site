import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const app = express();
app.use(cors());
app.use(express.json());

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
  res.json({ ok: true });
});

app.get('/api/snapshots/latest', auth, (req, res) => {
  const row = db.prepare('SELECT generated_at,payload FROM player_snapshots ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ generatedAt: null, onlinePlayers: [], summary: { joinedToday: 0, leftToday: 0, avgHours: 0 }, history: [] });
  const parsed = JSON.parse(row.payload);
  if (req.user.role !== 'full' && Array.isArray(parsed.history)) parsed.history = parsed.history.slice(0, 10);
  res.json(parsed);
});

migrate();
seedAdmin();
app.listen(8787, () => console.log('API on http://localhost:8787'));
