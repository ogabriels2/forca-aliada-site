<div align="center">

<img src="assets/images/app-icons/icon-192.png" width="80" height="80" style="border-radius:16px" alt="Logo da Força Aliada">

# Força Aliada

Site oficial, área de contas, painel de staff e rede social do servidor Minecraft Survival Vanilla Força Aliada.

[Site ao vivo](https://forcaaliada.com) | [Community](https://forcaaliada.com/community) | [API](https://forcaaliada.com/healthz) | [Discord](https://discord.gg/xZmRkB7PWd)

</div>

---

## Visão Rápida

Este repositório junta um frontend estático em HTML, CSS e JavaScript puro com um backend Node.js/Express em `backend/`. O projeto cobre a presença pública do servidor, login/cadastro, perfis, ranking, painel administrativo, integrações do servidor Minecraft e a rede social `Community`.

| Área | Onde fica | Resumo |
|---|---|---|
| Site público | `index.html`, `guia.html`, `post.html` | Landing page, status, guias, SEO e páginas institucionais. |
| Conta | `login.html`, `signup.html`, `account.html`, `profile.html` | Autenticação, preferências, perfil e sessões. |
| Community | `community.html`, `assets/js/community-*`, `assets/css/community-*` | Feed social, stories, comentários, reposts, chat, busca e notificações. |
| Staff | `dashboard.html` | Painel administrativo, usuários, mérito, capital, auditoria e integrações. |
| Backend | `backend/src/server.mjs` e módulos em `backend/src/` | API REST, PostgreSQL, auth JWT, uploads, moderação, feed e notificações. |

## Principais Recursos

- Landing page responsiva com status do servidor Minecraft e informações de crossplay.
- Cadastro, login, recuperação de senha, OAuth social e preferência de tema.
- Perfis com avatar, nick Minecraft, ranks sociais e dados comunitários.
- Rede social com feed, posts, imagens, enquetes, comentários encadeados, stories, reposts, salvos, busca e notificações.
- Chat social e compartilhamento interno entre usuários autenticados.
- Painel de staff com administração de usuários, mérito, capital, logs e app keys.
- Backend Express com PostgreSQL, rate limit, Helmet, CORS allowlist e auditoria.

## Estrutura

```text
forca-aliada-site/
|-- index.html
|-- community.html
|-- login.html
|-- signup.html
|-- account.html
|-- dashboard.html
|-- profile.html
|-- assets/
|   |-- css/
|   |-- js/
|   `-- images/
|-- backend/
|   |-- package.json
|   `-- src/
|       |-- server.mjs
|       |-- feed_v2_server.mjs
|       |-- server_comments_patch.mjs
|       `-- server_comment_thread_fix.mjs
|-- scripts/
|-- data/
|-- service-worker.js
|-- manifest.webmanifest
|-- community.webmanifest
|-- _headers
|-- _routes.json
`-- _worker.js
```

## Rodando Localmente

### Frontend

O frontend não precisa de build. Sirva a raiz do repositório em `localhost:5500`, que já é uma origem esperada pelo backend.

```bash
python -m http.server 5500
```

Depois acesse:

```text
http://localhost:5500/
http://localhost:5500/community.html
```

### Backend

```bash
cd backend
npm install
npm start
```

Por padrão a API sobe em:

```text
http://localhost:3000
```

O `community.html` tenta usar `http://localhost:3000` quando está em `localhost` ou `127.0.0.1`, e cai para a API publicada quando necessário.

## Variáveis de Ambiente

Configure as variáveis no ambiente local ou no painel do Render.

```env
DATABASE_URL=postgres://user:password@host:5432/dbname
JWT_SECRET=troque-por-um-segredo-longo
INGEST_SECRET=troque-por-um-segredo-longo
CORS_ORIGINS=https://forcaaliada.com,https://accounts.ogabriels.com,http://localhost:5500
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=no-reply@seudominio.com
MC_HOST=fa.ogabriels.com
PORT=3000
```

Variáveis úteis em ambientes gerenciados:

```env
PG_SSL_NO_VERIFY=true
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_EMAIL=admin@exemplo.com
BOOTSTRAP_ADMIN_PASSWORD=senha-forte-aqui
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

## Deploy

### Frontend

O frontend é estático. Publique a raiz do repositório em Vercel, Cloudflare Pages ou serviço equivalente.

- Build command: vazio
- Output directory: `.`
- Rotas SPA importantes: `/community`, `/profile` e páginas HTML da raiz
- Arquivos de apoio: `_headers`, `_routes.json`, `_worker.js`, manifests e `service-worker.js`

### Backend

O backend fica em `backend/`.

- Runtime: Node.js
- Build command: `npm install`
- Start command: `npm start`
- Porta: `process.env.PORT` ou `3000`
- Banco: PostgreSQL via `DATABASE_URL`

## API Principal

| Método | Endpoint | Uso |
|---|---|---|
| `GET` | `/healthz` | Saúde da API. |
| `POST` | `/api/auth/signup` | Cadastro. |
| `POST` | `/api/auth/login` | Login. |
| `GET` | `/api/me` | Usuário autenticado. |
| `GET` | `/api/community/feed` | Feed social autenticado. |
| `GET` | `/api/public/community/feed` | Feed público. |
| `POST` | `/api/community/posts` | Criar post. |
| `GET` | `/api/community/posts/:id` | Abrir thread de post. |
| `GET` | `/api/community/posts/:id/comments` | Comentários de primeiro nível. |
| `GET` | `/api/community/comments/:id/thread` | Respostas de um comentário. |
| `POST` | `/api/community/posts/:id/comments/reply` | Responder comentário mantendo alvo real da resposta. |
| `GET` | `/api/admin/users` | Listagem administrativa. |
| `POST` | `/api/admin/merit` | Ajuste de mérito. |
| `POST` | `/api/admin/capital` | Ajuste de capital. |

## Manutenção

- Ao alterar CSS ou JS estático, atualize o query string dos arquivos em HTML para evitar cache antigo em produção.
- Teste a Community em mobile e desktop antes de publicar: feed, stories, menus, lightbox, comentários e login/deslogado.
- Mantenha o backend e os patches de comentários carregados juntos, pois o frontend depende dos campos de threading e ordenação.
- Evite alterar arquivos já modificados por outra pessoa sem revisar o diff antes.
- Antes de deploy, rode pelo menos `node --check` nos scripts alterados e `git diff --check`.

## Direitos Autorais

Copyright 2021-2026 Gabriel Silva Dias Moreira, Força Aliada. Todos os direitos reservados.

O código-fonte deste repositório é disponibilizado publicamente para referência e transparência com a comunidade. Não é permitido reutilizar, copiar, modificar, redistribuir ou criar projetos derivados, parcial ou integralmente, sem autorização expressa e por escrito dos autores.

Repositório público não é sinônimo de código livre. Na ausência de uma licença permissiva, todos os direitos permanecem reservados aos autores.
