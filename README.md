<div align="center">

<img src="assets/images/logo.JPG" width="80" height="80" style="border-radius:16px" alt="Força Aliada Logo">

# Força Aliada — Site Oficial

**Site institucional e painel de gestão do servidor Minecraft Survival Vanilla Força Aliada.**  
Ativo e estável desde 2021. Sem resets. Sem pay-to-win.

[![Keep Backend Alive](https://github.com/ogabriels2/forca-aliada-site/actions/workflows/keep-alive.yml/badge.svg)](https://github.com/ogabriels2/forca-aliada-site/actions/workflows/keep-alive.yml)
[![Direitos Reservados](https://img.shields.io/badge/copyright-todos%20os%20direitos%20reservados-red.svg)](#direitos-autorais)

[**Site ao vivo**](https://forcaaliada.ogabriels.com) · [**API Backend**](https://forca-aliada-site.onrender.com/healthz) · [**Discord**](https://discord.gg/xZmRkB7PWd)

</div>

---

## Visão geral

Este repositório contém dois projetos distintos que funcionam juntos:

| Projeto | Tecnologia | Hospedagem | Descrição |
|---|---|---|---|
| **Frontend** | HTML + CSS + JS puro | Vercel / GitHub Pages | Páginas públicas e painel administrativo |
| **Backend** (`src/`) | Node.js + Express + PostgreSQL | Render Free Tier | API REST com autenticação JWT |

---

## Funcionalidades

### Páginas públicas
- **Landing page** com status ao vivo do servidor Minecraft (via `mcstatus.io`)
- Sistema de **crossplay** (Java + Bedrock) com IPs copiáveis
- Galeria, FAQ, seção de Sistema de Capital & Mérito

### Sistema de contas
- Cadastro com verificação de e-mail (código PIN via [Resend](https://resend.com))
- Login, recuperação de senha, gerenciamento de sessões ativas
- Perfil vinculado ao nick do Minecraft (skin via [Minotar](https://minotar.net))
- Preferências de tema (claro / escuro / automático), sincronizadas com a API

### Painel administrativo (`dashboard.html`)
- Monitoramento do servidor Minecraft em tempo real
- Histórico de sessões de jogadores
- Sistema de **Mérito** (⭐ reputação não-comprável) e **Capital** (💰 esmeraldas)
- Progressão de ranks: Ferro → Ouro → Diamante → Netherite
- Gestão de usuários, notificações e logs de auditoria completos
- Integração com o **Força Aliada Manager** (app desktop) via App Keys

---

## Arquitetura

```
forca-aliada-site/
├── index.html          # Landing page pública
├── login.html          # Autenticação
├── signup.html         # Cadastro + verificação de e-mail
├── account.html        # Painel da conta do usuário
├── dashboard.html      # Painel administrativo (staff only)
├── recuperar.html      # Recuperação de senha
├── assets/
│   └── images/         # Logos, hero, galeria, prints
├── src/
│   └── server.mjs      # API backend (Express ESM)
├── .github/
│   └── workflows/
│       └── keep-alive.yml   # Cron de keep-alive para o Render
└── package.json
```

### Fluxo de autenticação

```
Browser → POST /api/auth/signup → bcrypt hash (10 rounds) → INSERT users
                                → INSERT email_verifications
                                → Resend API (e-mail com PIN)

Browser → POST /api/auth/verify-email → UPDATE is_verified=TRUE
                                      → INSERT whitelist_queue
                                      → JWT (7 dias)

Browser → GET /api/me (Bearer JWT) → SELECT users + sessions
```

---

## Stack técnica

### Frontend
- HTML5 semântico, CSS custom properties, JavaScript vanilla (ESM-like via scripts inline)
- Sem framework, sem bundler — zero dependências de build
- Tema claro/escuro com preferência sincronizada na API e fallback em `localStorage`
- `requestIdleCallback` para fetches não críticos (tema, rank), evitando bloqueio do primeiro paint

### Backend
| Pacote | Função |
|---|---|
| `express` | Framework HTTP |
| `pg` | Client PostgreSQL (Pool) |
| `bcryptjs` | Hash de senhas (10 rounds) |
| `jsonwebtoken` | Autenticação stateless (JWT HS256, 7d) |
| `helmet` | Headers de segurança HTTP |
| `express-rate-limit` | Proteção contra brute force |
| `cors` | Allowlist de origens |
| `minecraft-server-util` | Ping direto ao servidor MC |
| `crypto` (Node built-in) | Hash de tokens de sessão (SHA-256) |

### Infraestrutura gratuita
| Serviço | Uso |
|---|---|
| **Render Free** | Hospedagem do backend Node.js |
| **Neon / Supabase** | PostgreSQL gerenciado |
| **Vercel** | Hospedagem do frontend estático |
| **Resend** | Envio de e-mails transacionais (verificação, recuperação) |
| **GitHub Actions** | Cron de keep-alive do backend (a cada 14 min) |
| **Minotar** | API de skins do Minecraft |
| **mcstatus.io** | Fallback para status do servidor |

---

## Configuração local

### Pré-requisitos
- Node.js 18+
- PostgreSQL 14+ (local ou instância gerenciada)

### Backend

```bash
cd forca-aliada-site
npm install

# Copiar e preencher as variáveis de ambiente
cp .env.example .env

# Iniciar o servidor (porta 8787 por padrão)
node src/server.mjs
```

### Variáveis de ambiente obrigatórias

Criar um arquivo `.env` na raiz do projeto (ou configurar no painel do Render):

```env
# Banco de dados
DATABASE_URL=postgres://user:password@host:5432/dbname

# Segredos (gerar valores aleatórios longos)
JWT_SECRET=minimo-32-caracteres-aleatorios-aqui
INGEST_SECRET=minimo-16-caracteres-aqui

# CORS — origens permitidas (CSV)
CORS_ORIGINS=https://forcaaliada.ogabriels.com,http://localhost:5500

# E-mail (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=no-reply@seudominio.com

# Minecraft
MC_HOST=fa.ogabriels.com
```

### Variáveis opcionais

```env
PORT=8787                        # Porta do servidor (padrão: 8787)
PG_SSL_NO_VERIFY=true            # Para provedores que exigem SSL sem verificação

# Cria automaticamente um usuário owner na primeira inicialização
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_EMAIL=admin@exemplo.com
BOOTSTRAP_ADMIN_PASSWORD=senha-forte-aqui
```

### Frontend

O frontend é estático — basta servir os arquivos HTML. Para desenvolvimento local:

```bash
# Usando qualquer servidor estático (ex.: Live Server no VS Code)
# ou via npx:
npx serve . --port 5500
```

A `API_BASE` nos HTMLs aponta para `https://forca-aliada-site.onrender.com`. Para apontar para o backend local, alterar a constante `API_BASE` nos arquivos HTML desejados:

```javascript
// Em cada HTML, localizar:
const API_BASE = 'https://forca-aliada-site.onrender.com';

// Alterar para:
const API_BASE = 'http://localhost:8787';
```

---

## Deploy

### Backend (Render)

1. Criar um novo **Web Service** no [Render](https://render.com)
2. Conectar este repositório
3. Configurar:
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.mjs`
   - **Environment:** Node
4. Adicionar todas as variáveis de ambiente listadas acima
5. Deploy automático a cada push na branch `main`

### Frontend (Vercel)

1. Importar o repositório no [Vercel](https://vercel.com)
2. Framework Preset: **Other** (sem build step)
3. Output Directory: `.` (raiz)
4. Deploy — os HTMLs são servidos diretamente

### Keep-alive automático (GitHub Actions)

O arquivo `.github/workflows/keep-alive.yml` faz ping no endpoint `/ping` do backend a cada **14 minutos**, impedindo que o Render Free hiberne o servidor.

Para ativar, nenhuma configuração adicional é necessária — o workflow roda automaticamente após o primeiro push. Para verificar o status:

```
GitHub → Actions → Keep Backend Alive
```

---

## API — Endpoints principais

### Públicos
| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/healthz` | Status do backend (uptime, versão) |
| `GET` | `/ping` | Keep-alive minimalista |
| `GET` | `/api/leaderboard` | Ranking público de Mérito |
| `POST` | `/api/auth/signup` | Cadastro de conta |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/forgot-password` | Solicitar código de recuperação |
| `POST` | `/api/auth/reset-password` | Redefinir senha com código |
| `POST` | `/api/auth/verify-email` | Verificar e-mail com PIN |

### Autenticados (Bearer JWT)
| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/me` | Dados do usuário autenticado |
| `PUT` | `/api/me` | Atualizar perfil |
| `GET` | `/api/me/preferences` | Preferências (tema, notificações) |
| `PUT` | `/api/me/preferences` | Salvar preferências |
| `GET` | `/api/me/rank-info` | Mérito, Capital e rank atual |
| `GET` | `/api/me/history` | Histórico de sessões no servidor MC |
| `GET` | `/api/me/sessions` | Sessões web ativas |
| `POST` | `/api/me/password` | Alterar senha |
| `POST` | `/api/auth/logout` | Encerrar sessão |

### Administrativos (role: `full` ou `owner`)
| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/server/status` | Status do servidor MC + auto-cura de sessões |
| `GET` | `/api/snapshots/latest` | Histórico de jogadores |
| `GET` | `/api/admin/users` | Listar usuários |
| `POST` | `/api/admin/merit` | Conceder ou debitar Mérito |
| `POST` | `/api/admin/capital` | Ajustar Capital |
| `GET` | `/api/admin/audit` | Logs de auditoria |
| `POST` | `/api/admin/notifications` | Criar notificação |

### Integração com App Desktop (App Key)
| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/app/sync` | Push de jogadores online (header `x-app-key`) |
| `GET` | `/api/admin/app-keys` | Listar chaves de integração |
| `POST` | `/api/admin/app-keys` | Gerar nova chave |
| `DELETE` | `/api/admin/app-keys/:id` | Revogar chave |

---

## Segurança

| Controle | Implementação |
|---|---|
| Hash de senhas | `bcryptjs` — 10 rounds (OWASP recomendado) |
| Autenticação | JWT HS256, expiry 7 dias, token hash (SHA-256) no banco |
| Rate limiting | 20 req/15 min em rotas de auth, 3 req/15 min em rotas de e-mail |
| Cabeçalhos HTTP | `helmet` (CSP, HSTS, X-Frame-Options, etc.) |
| CORS | Allowlist explícita de origens — não usa `*` |
| Auditoria | Todas as ações sensíveis são registradas em `audit_logs` com IP, user agent e actor |
| XSS | `sanitize()` em todos os inputs antes de persistir |
| SQL Injection | Queries parametrizadas em 100% dos casos (`pool.query($1, [value])`) |
| Sessões | Revogação individual ou em massa; `revoked` flag no banco |

---

## Sistema de Mérito e Capital

A Força Aliada opera com dois sistemas paralelos e independentes:

### Mérito (⭐)
- Reputação comunitária — **permanente, não-transferível, não-comprável**
- Concedido por admins por doações, serviços, construções e eventos
- Desbloqueia ranks progressivos:

| Rank | Mérito mínimo | Limite de saque | Benefício extra |
|---|---|---|---|
| 🪨 Ferro | 0 ⭐ | 64 💰 | Acesso padrão |
| 🟡 Ouro | 150 ⭐ | 128 💰 | Direito a voto |
| 🟢 Diamante | 500 ⭐ | 192 💰 | Publicação na wiki |
| ⚫ Netherite | 1.000 ⭐ | 320 💰 | Juros mínimos no banco |

### Capital (💰)
- Moeda econômica — esmeraldas digitais
- Circula livremente entre jogadores
- Gerado por comércio, serviços e rendimento no banco do servidor

---

## Direitos Autorais

© 2021–2026 Força Aliada. Todos os direitos reservados.

O código-fonte deste repositório é disponibilizado publicamente para fins de **referência e transparência** com a comunidade. Não é permitido reutilizar, copiar, modificar, redistribuir ou criar projetos derivados — parcial ou integralmente — sem autorização expressa e por escrito dos autores.

> Repositório público não é sinônimo de código livre. Na ausência de um arquivo de licença permissiva, a lei de direitos autorais (Convenção de Berna, incorporada ao ordenamento brasileiro pela Lei 9.610/98) reserva todos os direitos aos criadores por padrão.

