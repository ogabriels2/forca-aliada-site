# Backend (API + PostgreSQL)

## Stack
- Node.js + Express
- PostgreSQL (`pg`)
- JWT auth
- Hash de senha com bcrypt
- Segurança: `helmet`, `express-rate-limit`, CORS restritivo por allowlist

## Variáveis obrigatórias
- `DATABASE_URL`
- `JWT_SECRET` (mínimo 32 caracteres)
- `INGEST_SECRET` (mínimo 16 caracteres)
- `CORS_ORIGINS` (CSV com origens permitidas, ex.: `https://forcaaliada.ogabriels.com,https://admin.forcaaliada.com`)
- `MS_CLIENT_ID` (OAuth app da Microsoft/Xbox)
- `MS_CLIENT_SECRET` (OAuth app da Microsoft/Xbox)
- `MS_REDIRECT_URI` (precisa bater 1:1 com o callback cadastrado na Microsoft)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `FACEBOOK_REDIRECT_URI`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`

## Variáveis opcionais
- `PORT` (default `8787`)
- `MC_HOST` (default `fa.ogabriels.com`)
- `PG_SSL_NO_VERIFY=true` (somente se seu provedor exigir)
- `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`
- `FRONTEND_BASE_URL` (default `https://forcaaliada.ogabriels.com`; usado no redirect final do login Microsoft)

## Rodar
```bash
cd backend
npm install
DATABASE_URL='postgres://...' \
JWT_SECRET='coloque-um-segredo-bem-grande-com-32+-chars' \
INGEST_SECRET='coloque-um-segredo-forte-16+-chars' \
CORS_ORIGINS='https://forcaaliada.ogabriels.com' \
npm start
```

API: `http://localhost:8787`

## Endpoints
- `GET /healthz`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me` (Bearer token)
- `POST /api/me/password` (Bearer token)
- `POST /api/snapshots/import` (ingest do monitor)
- `GET /api/snapshots/latest?limit=500` (Bearer token)
- `GET /api/player/:name/history` (Bearer token)
- `GET /api/admin/users` (full admin)
- `POST /api/admin/users` (full admin)
- `PUT /api/admin/users/:id` (full admin)
- `DELETE /api/admin/users/:id` (full admin)

## Integração do monitor
- `INGEST_URL=https://SEU_BACKEND/api/snapshots/import`
- `INGEST_SECRET=...`
- Header recomendado: `X-Ingest-Secret: ...`
