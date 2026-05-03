import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import util from 'minecraft-server-util';

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
    
    CREATE TABLE IF NOT EXISTS player_sessions (
      id SERIAL PRIMARY KEY,
      player VARCHAR(255) NOT NULL,
      entered_at TIMESTAMP NOT NULL,
      left_at TIMESTAMP,
      duration_hours FLOAT
    );
    CREATE INDEX IF NOT EXISTS idx_player_name ON player_sessions(player);
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

function requireFull(req, res, next) {
  if (req.user?.role !== 'full') return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── ROTAS DE AUTH (Login/Signup/Senha) ──
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password, minecraftName } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    await pool.query('INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [username.toLowerCase(), email.toLowerCase(), minecraftName || username, hash, 'limited']);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: 'username/email already exists' }); }
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

// ── ROBÔ DE PING (CRON) ──
app.get('/api/cron', async (req, res) => {
  if (req.query.key !== process.env.INGEST_SECRET) return res.status(403).json({ error: 'Acesso negado' });

  try {
    const HOST = process.env.MC_HOST || 'fa.ogabriels.com';
    const status = await util.status(HOST, 25565, { timeout: 5000, enableSRV: true });
    const currentPlayers = (status?.players?.sample || []).map(p => p.name);
    const now = new Date();

    const activeFromDB = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
    for (const row of activeFromDB.rows) {
      if (!currentPlayers.includes(row.player)) {
        const duration = (now - new Date(row.entered_at)) / 3600000;
        await pool.query('UPDATE player_sessions SET left_at = $1, duration_hours = $2 WHERE player = $3 AND left_at IS NULL', [now, Number(duration.toFixed(2)), row.player]);
      }
    }

    for (const p of currentPlayers) {
      const isAlreadyActive = activeFromDB.rows.some(r => r.player === p);
      if (!isAlreadyActive) {
        await pool.query('INSERT INTO player_sessions (player, entered_at) VALUES ($1, $2)', [p, now]);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BUSCA DE DADOS PARA O DASHBOARD ──
app.get('/api/snapshots/latest', auth, async (req, res) => {
  const online = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
  const history = await pool.query('SELECT player, entered_at, left_at, duration_hours FROM player_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT 500');

  res.json({
    onlinePlayers: online.rows.map(r => r.player),
    activeSessions: online.rows.reduce((acc, r) => {
      acc[r.player] = { name: r.player, enteredAt: r.entered_at };
      return acc;
    }, {}),
    history: history.rows.map(r => ({
      player: r.player,
      enteredAt: r.entered_at,
      leftAt: r.left_at,
      hoursOnline: r.duration_hours
    }))
  });
});

app.get('/api/player/:name/history', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE player = $1 ORDER BY entered_at DESC', [req.params.name]);
  res.json(rows);
});

// ── ADMIN: GERENCIAR USUÁRIOS ──
app.get('/api/admin/users', auth, requireFull, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, email, minecraft_name, photo_url, role, created_at FROM users ORDER BY id DESC');
  res.json(rows);
});

// ADMIN: CRIAR USUÁRIO DIRETO (NOVO)
app.post('/api/admin/users', auth, requireFull, async (req, res) => {
  const { username, email, password, minecraftName, role } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });
  
  const hash = bcrypt.hashSync(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username,email,minecraft_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
      [username.toLowerCase(), email.toLowerCase(), minecraftName || username, hash, role === 'full' ? 'full' : 'limited']
    );
    res.json({ ok: true });
  } catch (e) { 
    res.status(409).json({ error: 'username/email already exists' }); 
  }
});

// ADMIN: ATUALIZAR USUÁRIO (COM SUPORTE A NOVA SENHA)
app.put('/api/admin/users/:id', auth, requireFull, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  
  const { username, email, minecraftName, photoUrl, role, newPassword } = req.body || {};
  if (!username || !email) return res.status(400).json({ error: 'missing fields' });
  
  try {
    let query = 'UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5';
    let params = [String(username).toLowerCase(), String(email).toLowerCase(), minecraftName || username, photoUrl || 'logo.JPG', role === 'full' ? 'full' : 'limited'];
    
    if (newPassword && newPassword.trim() !== '') {
      query += ', password_hash=$6 WHERE id=$7';
      params.push(bcrypt.hashSync(newPassword, 10), id);
    } else {
      query += ' WHERE id=$6';
      params.push(id);
    }

    const result = await pool.query(query, params);
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