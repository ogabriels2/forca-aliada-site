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
- `CORS_ORIGINS` (CSV com origens permitidas, ex.: `https://forcaaliada.com,https://accounts.ogabriels.com`)
- `MS_CLIENT_ID` (OAuth app da Microsoft/Xbox)
- `MS_CLIENT_SECRET` (OAuth app da Microsoft/Xbox)
- `MS_REDIRECT_URI` (precisa bater 1:1 com o callback cadastrado na Microsoft)

## Variáveis opcionais
- `PORT` (default `8787`)
- `MC_HOST` (default `fa.ogabriels.com`)
- `PG_SSL_NO_VERIFY=true` (somente se seu provedor exigir)
- `START_WITHOUT_DATABASE=true` (forca o boot em modo degradado se o banco falhar)
- `DB_BOOT_RETRY_MS` (intervalo de retry do boot do banco; default `60000`)
- `SCHEDULED_POST_POLL_MS` (intervalo para publicar posts agendados; default `900000`)
- `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`
- `FRONTEND_BASE_URL` (default `https://accounts.ogabriels.com`; usado nos retornos de login e OAuth)
- `PUBLIC_BASE_URL` (default `https://forcaaliada.com`; origem canonica do site, sitemaps e metadados)
- `PUBLIC_SHARE_BASE_URL` (default `PUBLIC_BASE_URL`; origem das share pages)

## Render / banco sem cota

Se o Render mostrar `Your account or project has exceeded the compute time quota`, o erro vem do provedor do PostgreSQL, nao do Node. O backend agora sobe em modo degradado nesse caso: `/healthz` continua respondendo, endpoints que dependem do banco retornam `503 DATABASE_UNAVAILABLE`, e o processo tenta preparar o banco novamente a cada `DB_BOOT_RETRY_MS`.

Para recuperar a aplicacao por completo, restaure a cota/compute do banco, faca upgrade do plano ou atualize `DATABASE_URL` para um Postgres ativo. Quando o banco voltar, o backend tenta rodar as migracoes de novo automaticamente.

## Rodar
```bash
cd backend
npm install
DATABASE_URL='postgres://...' \
JWT_SECRET='coloque-um-segredo-bem-grande-com-32+-chars' \
INGEST_SECRET='coloque-um-segredo-forte-16+-chars' \
CORS_ORIGINS='https://forcaaliada.com,https://accounts.ogabriels.com' \
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
