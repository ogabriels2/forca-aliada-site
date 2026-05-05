const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!INGEST_URL || !INGEST_SECRET) {
  console.error('Missing INGEST_URL or INGEST_SECRET');
  process.exit(1);
}

async function main() {
  const res = await fetch(INGEST_URL, {
    method: 'GET',
    headers: {
      'User-Agent': 'forca-aliada-monitor/1.0',
      'X-Ingest-Secret': INGEST_SECRET
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`cron failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  console.log(`Cron executed successfully: ${JSON.stringify(data)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
