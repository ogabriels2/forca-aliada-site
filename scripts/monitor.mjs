const HOST = process.env.MC_HOST || 'fa.ogabriels.com';
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!INGEST_URL || !INGEST_SECRET) {
  console.error('Missing INGEST_URL or INGEST_SECRET');
  process.exit(1);
}

async function fetchStatus() {
  const url = `https://api.mcstatus.io/v2/status/java/${HOST}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'forca-aliada-monitor/1.0' } });
  if (!res.ok) throw new Error(`mcstatus failed: ${res.status}`);
  return res.json();
}

function normalizePlayers(data) {
  if (!data?.players?.list) return [];
  return data.players.list.map((p) => ({
    id: String(p.uuid || p.name_clean || p.name_raw || p.name || '').toLowerCase(),
    name: p.name_clean || p.name_raw || p.name || 'Desconhecido'
  })).filter((p) => p.id);
}

async function main() {
  const status = await fetchStatus();
  const payload = {
    generatedAt: new Date().toISOString(),
    onlinePlayers: normalizePlayers(status).map((p) => p.name),
    summary: {
      onlineNow: Number(status?.players?.online || 0),
      maxPlayers: Number(status?.players?.max || 0)
    },
    raw: status
  };

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': INGEST_SECRET },
    body: JSON.stringify({ payload })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest failed: ${res.status} ${body}`);
  }

  console.log('Snapshot sent successfully');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
