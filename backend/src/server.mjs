import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'trocar-em-producao';

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      minecraft_name VARCHAR(255),
      photo_url VARCHAR(255) DEFAULT 'logo.JPG',
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'limited',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS player_snapshots (
      id SERIAL PRIMARY KEY,
      generated_at TIMESTAMP NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

async function seedAdmin() {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['gabalarca']);
  if (rows.length > 0) return;
  const hash = bcrypt.hashSync('Famosos1290+', 10);
  await pool.query(
    'INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
    ['gabalarca', 'gabalarcadsmoreira2016@gmail.com', 'gabalarca', hash, 'full']
  );
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

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password, minecraftName } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
      [username.toLowerCase(), email.toLowerCase(), minecraftName || username, hash, 'limited']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [(login || '').toLowerCase()]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role } });
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT username,email,minecraft_name,photo_url,role FROM users WHERE id = $1', [req.user.sub]);
  res.json(rows[0] || {});
});

app.post('/api/me/password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) return res.status(401).json({ error: 'invalid current password' });
  const hash = bcrypt.hashSync(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.sub]);
  res.json({ ok: true });
});

// ── O NOVO ROBÔ (Roda direto no backend) ──
app.get('/api/cron', async (req, res) => {
  // Apenas a sua chave do Render tem permissão para acionar o robô
  if (req.query.key !== process.env.INGEST_SECRET) return res.status(403).json({ error: 'Acesso negado' });

  try {
    const HOST = process.env.MC_HOST || 'fa.ogabriels.com';
    const mcRes = await fetch(`https://api.mcstatus.io/v2/status/java/${HOST}`, { headers: { 'User-Agent': 'forca-aliada-monitor/1.0' } });
    if (!mcRes.ok) throw new Error('Falha api minecraft');
    const status = await mcRes.json();

    let currentPlayers = [];
    if (status?.players?.list) {
        currentPlayers = status.players.list.map(p => p.name_clean || p.name_raw || p.name || 'Desconhecido');
    }
    const now = new Date();

    const { rows } = await pool.query('SELECT payload FROM player_snapshots ORDER BY id DESC LIMIT 1');
    let state = { onlinePlayers: [], history: [], activeSessions: {} };
    if (rows.length > 0) {
      try { state = JSON.parse(rows[0].payload); } catch(e){}
    }

    const activeSessions = state.activeSessions || {};
    const history = state.history || [];

    for (const p of Object.keys(activeSessions)) {
      if (!currentPlayers.includes(p)) {
        const session = activeSessions[p];
        const hoursOnline = (now - new Date(session.enteredAt)) / 3600000;
        history.unshift({
          player: p, enteredAt: session.enteredAt, leftAt: now.toISOString(), hoursOnline: Number(hoursOnline.toFixed(2))
        });
        delete activeSessions[p];
      }
    }

    for (const p of currentPlayers) {
      if (!activeSessions[p]) activeSessions[p] = { name: p, enteredAt: now.toISOString() };
    }

    if (history.length > 500) history.length = 500;

    const newPayload = {
      generatedAt: now.toISOString(),
      onlinePlayers: currentPlayers,
      summary: { onlineNow: currentPlayers.length, maxPlayers: status?.players?.max || 0 },
      history: history,
      activeSessions: activeSessions
    };

    await pool.query('INSERT INTO player_snapshots (generated_at,payload) VALUES ($1,$2)', [now.toISOString(), JSON.stringify(newPayload)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/snapshots/latest', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT generated_at,payload FROM player_snapshots ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) return res.json({ generatedAt: null, onlinePlayers: [], summary: { joinedToday: 0, leftToday: 0, avgHours: 0 }, history: [] });
  const parsed = JSON.parse(rows[0].payload);
  if (req.user.role !== 'full' && Array.isArray(parsed.history)) parsed.history = parsed.history.slice(0, 10);
  res.json(parsed);
});

function requireFull(req, res, next) {
  if (req.user?.role !== 'full') return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/api/admin/users', auth, requireFull, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, email, minecraft_name, photo_url, role, created_at FROM users ORDER BY id DESC');
  res.json(rows);
});

app.put('/api/admin/users/:id', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { username, email, minecraftName, photoUrl, role } = req.body || {};
  if (!username || !email) return res.status(400).json({ error: 'missing fields' });
  try {
    const result = await pool.query(
      'UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6',
      [String(username).toLowerCase(), String(email).toLowerCase(), minecraftName || username, photoUrl || 'logo.JPG', role === 'full' ? 'full' : 'limited', id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'user not found' });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'username/email already exists' });
  }
});

app.delete('/api/admin/users/:id', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'user not found' });
  if (rows[0].username === 'gabalarca') return res.status(400).json({ error: 'cannot delete main admin' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

migrate().then(seedAdmin).catch(console.error);

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));