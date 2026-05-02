import fs from 'node:fs/promises';
import path from 'node:path';

const HOST = process.env.MC_HOST || 'fa.ogabriels.com';
const OUTPUT = path.resolve('data/player-history.json');
const NOW = new Date();
const INGEST_URL = process.env.INGEST_URL || '';
const INGEST_SECRET = process.env.INGEST_SECRET || '';

async function readJsonSafe(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function fetchStatus() {
  const url = `https://api.mcstatus.io/v2/status/java/${HOST}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'forca-aliada-monitor/1.0' } });
  if (!res.ok) throw new Error(`mcstatus failed: ${res.status}`);
  return res.json();
}

async function fetchQueryStatus() {
  try {
    const url = `https://api.mcstatus.io/v2/query/${HOST}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'forca-aliada-monitor/1.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function currentDateKey(dt = new Date()) {
  return dt.toISOString().slice(0, 10);
}

function toHourDiff(startIso, endIso = new Date().toISOString()) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, +(ms / 36e5).toFixed(2));
}

function normalizePlayers(data) {
  if (!data?.players?.list) return [];
  return data.players.list.map((p) => ({
    id: String(p.uuid || p.name_clean || p.name_raw || p.name || '').toLowerCase(),
    name: p.name_clean || p.name_raw || p.name || 'Desconhecido'
  })).filter((p) => p.id);
}

function normalizeQueryPlayers(queryData) {
  const names = queryData?.players?.list || queryData?.players || [];
  if (!Array.isArray(names)) return [];
  return names.map((name) => ({ id: String(name).toLowerCase(), name: String(name) })).filter((p) => p.id);
}

function getOnlineCount(data, playersNow) {
  if (typeof data?.players?.online === 'number') return data.players.online;
  return playersNow.length;
}

async function main() {
  const store = await readJsonSafe(OUTPUT, {
    generatedAt: null,
    onlinePlayers: [],
    summary: { joinedToday: 0, leftToday: 0, avgHours: 0 },
    history: [],
    activeSessions: {},
    totals: { sessionsClosedToday: 0, totalHoursToday: 0 }
  });

  const status = await fetchStatus();
  const queryStatus = await fetchQueryStatus();
  const playersFromStatus = normalizePlayers(status);
  const playersFromQuery = normalizeQueryPlayers(queryStatus);
  const merged = [...playersFromStatus];
  for (const p of playersFromQuery) if (!merged.some((m) => m.id === p.id)) merged.push(p);
  const playersNow = merged;
  const onlineCount = getOnlineCount(status, playersNow);
  const nowIso = NOW.toISOString();
  const dateKey = currentDateKey(NOW);
  const existing = store.activeSessions || {};
  const currentMap = Object.fromEntries(playersNow.map((p) => [p.id, p]));

  for (const p of playersNow) {
    if (!existing[p.id]) {
      existing[p.id] = { name: p.name, enteredAt: nowIso };
      store.history.unshift({ player: p.name, enteredAt: nowIso, leftAt: null, hoursOnline: 0 });
    }
  }

  for (const [id, session] of Object.entries(existing)) {
    if (!currentMap[id]) {
      const leftAt = nowIso;
      const hoursOnline = toHourDiff(session.enteredAt, leftAt);
      delete existing[id];
      store.totals.sessionsClosedToday += 1;
      store.totals.totalHoursToday += hoursOnline;
      const row = store.history.find((h) => h.player === session.name && h.enteredAt === session.enteredAt);
      if (row) {
        row.leftAt = leftAt;
        row.hoursOnline = hoursOnline;
      } else {
        store.history.unshift({ player: session.name, enteredAt: session.enteredAt, leftAt, hoursOnline });
      }
    }
  }

  store.activeSessions = existing;
  store.onlinePlayers = playersNow.map((p) => p.name);
  store.onlineCount = onlineCount;

  const joinedToday = store.history.filter((h) => h.enteredAt?.startsWith(dateKey)).length;
  const leftToday = store.history.filter((h) => h.leftAt?.startsWith(dateKey)).length;
  const avgHours = store.totals.sessionsClosedToday
    ? +(store.totals.totalHoursToday / store.totals.sessionsClosedToday).toFixed(2)
    : 0;
  store.summary = { joinedToday, leftToday, avgHours };
  store.generatedAt = nowIso;
  // Mantém histórico completo para não perder dados ao longo do tempo.

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(store, null, 2) + '\n', 'utf8');

  if (INGEST_URL && INGEST_SECRET) {
    await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: INGEST_SECRET, payload: store })
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
