# Backend profissional (API + DB)

## Stack
- Node.js + Express
- SQLite (`better-sqlite3`)
- JWT auth
- Hash de senha com bcrypt

## Rodar
```bash
cd backend
npm install
JWT_SECRET='troque-isto' INGEST_SECRET='troque-isto' npm start
```
API: `http://localhost:8787`

## Endpoints
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me` (Bearer token)
- `POST /api/me/password` (Bearer token)
- `POST /api/snapshots/import` (ingest do monitor)
- `GET /api/snapshots/latest` (Bearer token)

## Integração do monitor
No workflow/cron, use:
- `INGEST_URL=http://SEU_BACKEND/api/snapshots/import`
- `INGEST_SECRET=...`
