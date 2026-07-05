/**
 * Força Aliada – Backend API  (server.mjs)
 * ─────────────────────────────────────────
 * Stack : Node.js (ESM) + Express + PostgreSQL + JWT + bcrypt
 *
 * Funcionalidades principais
 * ──────────────────────────
 * • Sistema de Integração (App Keys) para Desktop App.
 * • POST /api/app/heartbeat — App sinaliza presença a cada 10s (leve, só memória).
 * • POST /api/app/sync      — Recebe push de sessões/eventos em tempo real.
 * • GET  /api/app/whitelist-queue — App busca novos cadastros pendentes.
 * • Máquina de estados do servidor Minecraft (unknown/offline/online).
 * • Detecção de TCPShield com Offline MOTD via 4 heurísticas em cascata.
 * • Cloud Lockout: após shutdown explícito, bloqueia reconexão do heartbeat por 60s.
 * • Auto-cura Híbrida: Site entra em repouso se o App estiver conectado.
 * • Rastreamento de Origem: banco distingue sessões abertas pelo App vs pelo Site.
 */

import * as util from 'minecraft-server-util';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import https from 'https';
import {
  feedV2SchemaSql,
  impressionsEndpoint,
  savePostEndpoint,
  unsavePostEndpoint,
  notInterestedEndpoint,
  undoNotInterestedEndpoint,
  feedV2Endpoint,
} from './feed_v2_server.mjs';
import {
  commentUpgradeSchemaSql,
  registerCommentUpgradeEndpoints,
} from './server_comments_patch.mjs';
import { registerCommentThreadFix } from './server_comment_thread_fix.mjs';
import { registerAdminAnalytics } from './admin_analytics.mjs';
import {
  DASHBOARD_V2_SCHEMA_SQL,
  registerAdminDashboardV2,
} from './admin_dashboard_v2.mjs';
import {
  registerChatRealtime,
  notifyNewMessage,
  notifyMessageUpdate,
  notifyRead,
} from './server_chat_realtime.mjs';
import {
  registerLegacyMigration,
  LEGACY_MIGRATION_SCHEMA_SQL,
} from './server_legacy_migration.mjs';
import {
  COMMUNITY_EVOLUTION_SCHEMA_SQL,
  emitCommunityEvent,
  registerCommunityEvolution,
} from './community_evolution.mjs';

const PROCESS_STARTED_AT = new Date();

// ── Cache em memória para status do Minecraft ──────────────────────────────────
// Cache de status do Minecraft.
// TTL: 50s — ligeiramente menor que o intervalo de polling do dashboard (60s).
// Isso garante que quando o dashboard chama /api/server/status no ciclo de 60s,
// o cache já expirou e um ping fresco é feito, eliminando dados stale no pior caso.
// Sem cache nenhum, cada request ao dashboard dispararia um ping completo (UDP + TCP + mcstatus.io)
// que pode levar 3-8s, tornando o endpoint lento para múltiplos admins simultâneos.
const _mcStatusCache = { data: null, expiresAt: 0 };
const MC_STATUS_TTL_MS = 50_000; // 50s < 60s (ciclo do dashboard) → sempre dado fresco no poll

// ── Estado em memória do heartbeat do App (sem I/O de banco) ──────────────────
// O app deve chamar POST /api/app/heartbeat a cada 10 segundos.
// Se não receber nada em APP_HEARTBEAT_TIMEOUT_MS, considera desconectado.
const _appHeartbeat = {
  lastSeenAt: 0,   // timestamp Unix em ms da última chamada
  keyId: null,
  keyName: null,
};
const APP_HEARTBEAT_TIMEOUT_MS = 30_000; // 30s — tolerância de 3 ciclos

function isAppConnectedInMemory() {
  return Date.now() - _appHeartbeat.lastSeenAt < APP_HEARTBEAT_TIMEOUT_MS;
}

// ── Máquina de estados do servidor Minecraft ──────────────────────────────────
//
// Problema que essa máquina resolve:
//
//  1. O TCPShield faz cache do MOTD do servidor e responde ao ping de status
//     mesmo quando o servidor real está OFFLINE. Isso faz o site reportar
//     "online" erroneamente.
//
//  2. Quando o app sinaliza shutdown mas o admin liga o servidor diretamente
//     (sem o app), o site ficaria preso em "offline" indefinidamente.
//
// Solução: máquina de 3 estados + detecção de ping "superficial" do TCPShield.
//
//  Estados:
//   'unknown'  — sem informação confiável, usa detecção de ping com filtro TCPShield
//   'offline'  — app sinalizou shutdown OU ping confirmou offline real
//   'online'   — app sinalizou startup OU ping real confirmou online
//
//  Transições:
//   any  → 'online'   via: app envia serverStarted:true  OU  ping real responde
//   any  → 'offline'  via: app envia serverStopped:true
//  'offline' → 'unknown' após FORCED_RECHECK_MS sem app conectado
//                       (permite que modo nuvem cheque se servidor subiu externamente)
//
// Detecção de ping "real" vs TCPShield:
//   O TCPShield responde ao status ping em <2ms (é cache local).
//   Um servidor Minecraft real tem RTT mínimo de ~5ms mesmo na mesma LAN.
//   Se a latência for < TCPSHIELD_MIN_LATENCY_MS E não tiver lista de
//   jogadores (que o TCPShield omite), consideramos suspeito de TCPShield.
//   Nesse caso, retornamos 'online' mas com flag tcpshield_suspect: true,
//   e o status real é determinado pelo _mcState em vez do ping.

const FORCED_RECHECK_MS        = 3 * 60_000; // 3 min sem app → sai de 'offline' para 'unknown'
const TCPSHIELD_MIN_LATENCY_MS = 5;           // pings mais rápidos que isso são suspeitos (sem Offline MOTD)

// ── Detecção de TCPShield com Offline MOTD ────────────────────────────────────
//
// Com "Offline MOTD enabled" no TCPShield, o proxy responde ao status ping TCP
// mesmo quando o backend está offline — com latência real de datacenter (~20-80ms)
// e MOTD customizado. Isso quebra o critério de latência < 5ms.
//
// Solução em camadas:
//
//  Camada 1 — UDP Query (porta 25565, protocolo Query do Minecraft):
//    O TCPShield NÃO proxeia UDP. Se queryFull() responder → servidor real online.
//    Se der timeout → sem UDP ou servidor offline.
//    Requer enable-query=true no server.properties (configurável via variável MC_QUERY_PORT).
//
//  Camada 2 — Heurística de conteúdo do MOTD:
//    Compara o MOTD retornado com o MOTD offline configurado (MC_OFFLINE_MOTD env var).
//    Se bater exatamente → é o MOTD do TCPShield → offline.
//
//  Camada 3 — mcstatus.io (já existente):
//    Consulta de um datacenter externo diferente. Se mcstatus.io também ver "online"
//    com a mesma contagem de 0 players e mesmo MOTD → provavelmente TCPShield em ambos.
//    mcstatus.io tem cache próprio de ~30s então não é 100% confiável sozinho.
//
//  Camada 4 — players.online > 0 como confirmação positiva:
//    Se o servidor reporta jogadores online, ele definitivamente está rodando.
//    O Offline MOTD do TCPShield sempre retorna 0 jogadores.
//
// A variável MC_QUERY_PORT define a porta UDP para o Query (padrão: mesma porta TCP, 25565).
// Se MC_QUERY_DISABLED=true, pula a camada UDP e vai direto para as outras.

// ── Controle de heartbeat pós-shutdown ────────────────────────────────────────
// Quando o app envia serverStopped, zeramos o lastSeenAt do heartbeat para que o site
// entre em modo nuvem imediatamente. Porém o app continua mandando heartbeats normalmente.
// Para evitar que o próximo heartbeat (em ~10s) reconecte o app e saia do modo nuvem,
// bloqueamos novos heartbeats por CLOUD_MODE_LOCKOUT_MS após um shutdown explícito.
// O bloqueio é levantado quando o app envia serverStarted:true (server foi relançado).
const CLOUD_MODE_LOCKOUT_MS = 60_000; // 60s após serverStopped, heartbeats não reconectam
const _cloudLockout = {
  active: false,
  since:  0,
};

function activateCloudLockout() {
  _cloudLockout.active = true;
  _cloudLockout.since  = Date.now();
  console.info(`[cloud-lockout] Ativado — heartbeats bloqueados por ${CLOUD_MODE_LOCKOUT_MS / 1000}s após shutdown`);
}

function releaseCloudLockout() {
  if (_cloudLockout.active) {
    console.info('[cloud-lockout] Liberado — app pode se reconectar como master');
  }
  _cloudLockout.active = false;
  _cloudLockout.since  = 0;
}

// Retorna true se heartbeats ainda estão bloqueados (modo nuvem obrigatório após shutdown)
function isCloudLockoutActive() {
  if (!_cloudLockout.active) return false;
  if (Date.now() - _cloudLockout.since > CLOUD_MODE_LOCKOUT_MS) {
    releaseCloudLockout(); // Expirou — app pode se reconectar
    return false;
  }
  return true;
}

const _mcState = {
  state: 'unknown',        // 'unknown' | 'offline' | 'online'
  setAt: 0,                // quando o estado foi estabelecido
  setBy: 'init',           // 'app_signal' | 'ping' | 'init'
};

function setMcState(state, setBy) {
  const prev = _mcState.state;
  _mcState.state  = state;
  _mcState.setAt  = Date.now();
  _mcState.setBy  = setBy;
  if (prev !== state) {
    console.info(`[mc-state] ${prev} → ${state} (por: ${setBy})`);
  }
  // Invalida o cache imediatamente quando o estado muda por sinal do app
  if (setBy === 'app_signal') {
    _mcStatusCache.data     = null;
    _mcStatusCache.expiresAt = 0;
  }
}

// Retorna true se devemos confiar no _mcState em vez do resultado do ping.
// Usado para suprimir falsos "online" do TCPShield após shutdown sinalizado.
function isMcStateTrustworthy() {
  if (_mcState.state === 'unknown') return false;
  if (_mcState.state === 'online')  return false; // 'online' via sinal do app é sempre confiável
  if (_mcState.state === 'offline') {
    // Se o app está desconectado há muito tempo, liberamos para o ping
    // checar se o servidor foi ligado externamente
    if (!isAppConnectedInMemory()) {
      const timeSinceSet = Date.now() - _mcState.setAt;
      if (timeSinceSet > FORCED_RECHECK_MS) {
        // Volta para 'unknown' automaticamente — modo nuvem vai detectar
        setMcState('unknown', 'timeout');
        return false;
      }
    }
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// App
// ─────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(compression());

// CORS
const defaultCorsOrigins = [
  'https://forcaaliada.ogabriels.com',
  'https://forca-aliada-site.vercel.app',
  'https://forca-aliada-site.onrender.com',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const corsOrigins = Array.from(new Set([
  ...defaultCorsOrigins,
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    console.warn('[cors blocked]', origin);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Ingest-Secret', 'x-app-key'],
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

cloudinary.config(process.env.CLOUDINARY_URL
  ? { secure: true }
  : {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });

const communityMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 4,
    fileSize: 10 * 1024 * 1024, // Limite seguro aumentado para 10MB
  },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(file.mimetype || '')) {
      return cb(new Error('Envie apenas imagens.'));
    }
    cb(null, true);
  },
});

function communityMediaUploadMiddleware(req, res, next) {
  communityMediaUpload.any()(req, res, err => {
    if (!err) return next();
    
    console.error('[MULTER ERROR DETAILED]:', err); 
    
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'A imagem pode ter no máximo 10MB.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Envie no máximo 4 imagens por post.'
          : `Upload inválido (${err.code}).`;
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: err.message || 'Upload inválido.' });
  });
}

const CHAT_ATTACHMENT_MAX_FILES = 4;
const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const CHAT_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'pdf', 'file']);
const CHAT_ALLOWED_FILE_EXTENSIONS = new Set([
  'pdf',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'webm',
  'doc', 'docx',
  'xls', 'xlsx',
  'ppt', 'pptx',
  'txt', 'csv',
  'zip', 'rar', '7z',
]);

function chatAttachmentKind(file = {}) {
  const mime = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(mime)) return 'image';
  if (/^video\/(mp4|webm|quicktime|x-matroska|x-msvideo|mpeg)$/i.test(mime)) return 'video';
  if (/^audio\//i.test(mime)) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (CHAT_ALLOWED_FILE_EXTENSIONS.has(ext)) return 'file';
  return null;
}

function cleanFileName(value = 'arquivo') {
  const cleaned = sanitizeText(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'arquivo').slice(0, 120);
}

const chatAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: CHAT_ATTACHMENT_MAX_FILES,
    fileSize: CHAT_ATTACHMENT_MAX_BYTES,
  },
  fileFilter(_req, file, cb) {
    if (!chatAttachmentKind(file)) {
      return cb(new Error('Tipo de arquivo nao permitido.'));
    }
    cb(null, true);
  },
});

function chatAttachmentUploadMiddleware(req, res, next) {
  chatAttachmentUpload.array('files', CHAT_ATTACHMENT_MAX_FILES)(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Cada anexo pode ter no maximo 25MB.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Envie no maximo 4 anexos por mensagem.'
          : `Upload invalido (${err.code}).`;
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: err.message || 'Upload invalido.' });
  });
}

function cloudinaryIsConfigured() {
  return Boolean(process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET));
}

// ─────────────────────────────────────────────
// MODERAÇÃO DE IMAGENS – Google Vision SafeSearch
// ─────────────────────────────────────────────
// Níveis retornados pela API para cada categoria:
//   UNKNOWN, VERY_UNLIKELY, UNLIKELY, POSSIBLE, LIKELY, VERY_LIKELY
//
// Lógica de 3 camadas:
//   REJEITAR  → conteúdo claramente impróprio (LIKELY / VERY_LIKELY)
//   SUSPEITO  → zona cinza (LIKELY sem chegar a VERY_LIKELY em racy) → publica mas entra na fila de moderação
//   APROVADO  → UNLIKELY / VERY_UNLIKELY / POSSIBLE → sobe normalmente
//
// A moderação só roda se GOOGLE_VISION_API_KEY estiver configurada.
// Sem a chave, o upload prossegue normalmente (fail-open intencional
// para não bloquear o site caso a chave não esteja configurada ainda).

const VISION_LIKELIHOOD_SCORE = {
  UNKNOWN: 0,
  VERY_UNLIKELY: 1,
  UNLIKELY: 2,
  POSSIBLE: 3,
  LIKELY: 4,
  VERY_LIKELY: 5,
};

// Retorna: { verdict: 'approved' | 'suspicious' | 'rejected', reason, scores }
async function moderateImageBuffer(buffer) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;

  // ── DIAGNÓSTICO: remover após confirmar funcionamento ──────────────────────
  console.log('[Vision API] moderateImageBuffer chamado');
  console.log('[Vision API] GOOGLE_VISION_API_KEY presente:', !!apiKey);
  console.log('[Vision API] Tamanho do buffer:', buffer?.length ?? 0, 'bytes');
  // ──────────────────────────────────────────────────────────────────────────

  if (!apiKey) {
    console.warn('[Vision API] Chave ausente — imagem liberada sem moderação (fail-open).');
    return { verdict: 'approved', reason: 'vision_not_configured', scores: {} };
  }

  const body = JSON.stringify({
    requests: [{
      image: { content: buffer.toString('base64') },
      features: [{ type: 'SAFE_SEARCH_DETECTION' }],
    }],
  });

  let rawResponse;
  try {
    rawResponse = await new Promise((resolve, reject) => {
      const req = https.request(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        res => {
          // ── DIAGNÓSTICO ──
          console.log('[Vision API] HTTP status da resposta:', res.statusCode);
          // ─────────────────
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            // ── DIAGNÓSTICO ──
            console.log('[Vision API] Resposta bruta:', data.slice(0, 500));
            // ─────────────────
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Resposta inválida da Vision API.')); }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout na Vision API.')); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn('[Vision API] Falha na chamada, imagem liberada:', err.message);
    return { verdict: 'approved', reason: 'vision_error', scores: {} };
  }

  const annotation = rawResponse?.responses?.[0]?.safeSearchAnnotation;
  if (!annotation) {
    console.warn('[Vision API] Resposta sem safeSearchAnnotation:', JSON.stringify(rawResponse));
    return { verdict: 'approved', reason: 'vision_no_annotation', scores: {} };
  }

  const scores = {
    adult:    VISION_LIKELIHOOD_SCORE[annotation.adult]    ?? 0,
    violence: VISION_LIKELIHOOD_SCORE[annotation.violence] ?? 0,
    racy:     VISION_LIKELIHOOD_SCORE[annotation.racy]     ?? 0,
    medical:  VISION_LIKELIHOOD_SCORE[annotation.medical]  ?? 0,
  };

  // ── DIAGNÓSTICO ──
  console.log('[Vision API] Scores:', JSON.stringify(scores));
  console.log('[Vision API] Annotation raw:', JSON.stringify(annotation));
  console.log('[Vision API] Verdict final:', scores.adult >= 4 || scores.violence >= 4 ? 'REJECTED' : scores.adult >= 3 || scores.violence >= 3 || scores.racy >= 3 ? 'SUSPICIOUS' : 'APPROVED');
  // ─────────────────

  // REJEITAR: qualquer categoria claramente imprópria
  const REJECT_THRESHOLD = 4; // LIKELY ou VERY_LIKELY
  if (scores.adult >= REJECT_THRESHOLD || scores.violence >= REJECT_THRESHOLD) {
    const reason = scores.adult >= REJECT_THRESHOLD ? 'adult_content' : 'violent_content';
    return { verdict: 'rejected', reason, scores };
  }

  // SUSPEITO: zona cinza — publica mas entra na fila de revisão do admin
  // POSSIBLE (3) é suficiente para marcar como suspeito (zona cinza, revisão humana necessária).
  // Anterior: SUSPICIOUS_THRESHOLD era 4 (igual ao REJECT), tornando esse bloco inalcançável.
  const SUSPICIOUS_THRESHOLD = 3; // POSSIBLE → entra na fila do admin
  if (
    scores.adult >= SUSPICIOUS_THRESHOLD ||
    scores.violence >= SUSPICIOUS_THRESHOLD ||
    scores.racy >= SUSPICIOUS_THRESHOLD
  ) {
    return { verdict: 'suspicious', reason: 'possible_inappropriate', scores };
  }

  return { verdict: 'approved', reason: 'clean', scores };
}

// Insere o conteúdo na fila de moderação do admin
async function queueForModeration(contentType, contentId) {
  try {
    await pool.query(
      `INSERT INTO moderation_queue (content_type, content_id, report_count, created_at)
       VALUES ($1, $2, 0, NOW())
       ON CONFLICT (content_type, content_id) DO NOTHING`,
      [contentType, contentId],
    );
  } catch (err) {
    console.error('[Moderation] Falha ao enfileirar conteúdo suspeito:', err.message);
  }
}

// ─────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL_NO_VERIFY === 'true' ? { rejectUnauthorized: false } : undefined,
});

function readNonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const DB_BOOT_RETRY_MS = readNonNegativeIntEnv('DB_BOOT_RETRY_MS', 60_000);
const SCHEDULED_POST_POLL_MS = Math.max(
  60_000,
  readNonNegativeIntEnv('SCHEDULED_POST_POLL_MS', 15 * 60_000),
);
const dbStartupState = {
  ready: false,
  lastError: null,
  lastAttemptAt: null,
  readyAt: null,
};

function summarizeDbError(error) {
  const message = String(error?.message || error || 'Erro desconhecido no banco de dados');
  return {
    message,
    code: error?.code || null,
    severity: error?.severity || null,
    detail: error?.detail || null,
    hint: error?.hint || null,
  };
}

function isDatabaseComputeQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('compute time quota')
    || message.includes('exceeded the compute')
    || message.includes('exceeded compute');
}

function shouldStartWithoutDatabase(error) {
  return process.env.START_WITHOUT_DATABASE === 'true' || isDatabaseComputeQuotaError(error);
}

function markDatabaseReady() {
  dbStartupState.ready = true;
  dbStartupState.lastError = null;
  dbStartupState.readyAt = new Date().toISOString();
}

function markDatabaseUnavailable(error) {
  dbStartupState.ready = false;
  dbStartupState.lastAttemptAt = new Date().toISOString();
  dbStartupState.lastError = summarizeDbError(error);
}

function databaseStartupHint(error) {
  if (isDatabaseComputeQuotaError(error)) {
    return 'O provedor do Postgres recusou a conexao porque a cota de compute acabou. Aumente/restaure a cota ou troque DATABASE_URL para um banco ativo.';
  }
  return 'Falha ao preparar o banco no boot.';
}

function logDatabaseStartupError(error, label = '[startup:db]') {
  const summary = summarizeDbError(error);
  console.error(label, {
    ...summary,
    action: databaseStartupHint(error),
  });
}

app.use((req, res, next) => {
  if (dbStartupState.ready || !dbStartupState.lastError) return next();

  const healthPaths = new Set(['/healthz', '/api/healthz', '/ping', '/admin/health']);
  if (healthPaths.has(req.path)) return next();

  if (DB_BOOT_RETRY_MS > 0) {
    res.set('Retry-After', String(Math.ceil(DB_BOOT_RETRY_MS / 1000)));
  }

  return res.status(503).json({
    error: 'Banco de dados temporariamente indisponivel.',
    code: 'DATABASE_UNAVAILABLE',
    database: dbStartupState.lastError,
  });
});

let runtimeDashboardSettingsCache = { value: {}, expiresAt: 0 };
async function getRuntimeDashboardSettings(force = false) {
  if (!force && Date.now() < runtimeDashboardSettingsCache.expiresAt) return runtimeDashboardSettingsCache.value;
  try {
    const { rows } = await pool.query('SELECT settings FROM admin_dashboard_settings WHERE id=1');
    runtimeDashboardSettingsCache = { value: rows[0]?.settings || {}, expiresAt: Date.now() + 30000 };
  } catch {
    runtimeDashboardSettingsCache = { value: {}, expiresAt: Date.now() + 5000 };
  }
  return runtimeDashboardSettingsCache.value;
}

const DEPLOY_SCHEMA_VERSION = 'oauth-microsoft-multi-account-v5';
const AUDIT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id           SERIAL PRIMARY KEY,
    actor_id     INTEGER,
    actor_name   VARCHAR(255),
    type         VARCHAR(50)  DEFAULT 'system',
    severity     VARCHAR(20)  DEFAULT 'info',
    target_id    INTEGER,
    target_name  VARCHAR(255),
    message      TEXT,
    metadata     JSONB,
    ip           VARCHAR(64),
    user_agent   TEXT,
    session_id   INTEGER,
    created_at   TIMESTAMPTZ  DEFAULT NOW()
  )`,
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'system'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action VARCHAR(50) DEFAULT 'system'",
  "UPDATE audit_logs SET action = COALESCE(action, type, 'system') WHERE action IS NULL",
  "ALTER TABLE audit_logs ALTER COLUMN action SET DEFAULT 'system'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info'",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_name VARCHAR(255)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS message TEXT",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip VARCHAR(64)",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS session_id INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
  "CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_audit_type     ON audit_logs(type)",
  "CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_logs(actor_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity)",
];

// ─────────────────────────────────────────────
// Env guards
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 chars');
const INGEST_SECRET = process.env.INGEST_SECRET; // Usado agora apenas como Fallback de emergência
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'https://forcaaliada.ogabriels.com').replace(/\/+$/, '');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuração ausente: ${name}`);
  return value;
}

// ─────────────────────────────────────────────
// Rate limiters
// ─────────────────────────────────────────────
const authLimiter  = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => {
    audit({
      type: 'security', severity: 'critical',
      message: `Rate limit atingido em ${req.path}`,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      metadata: { path: req.path, method: req.method },
    }).catch(() => {});
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
  },
});
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3,  standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente novamente mais tarde.' } });

// Limitador rigoroso para APIs externas (Xbox / Mojang) para evitar banimento do App ID
const xboxApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos de janela
  limit: 3, // Máximo de 3 sincronizações por usuário a cada 5 minutos
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite atingido. Para proteger sua conta e o servidor, aguarde 5 minutos antes de sincronizar novamente.' }
});

// [SEC-01] Rate limiter for post creation - prevents race condition in manual count check
const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  limit: 10,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de 10 posts por hora atingido.' },
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de uploads por hora atingido.' },
});
const affiliationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas alteracoes de afiliadas. Aguarde alguns minutos.' },
});
const impressionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit:    60,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Limite de impressões atingido.' },
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function sanitize(v)            { return String(v || '').replace(/[<>]/g, '').trim(); }
function sanitizeText(v)        { return String(v ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim(); }
function generateVerificationCode() { return crypto.randomInt(100000, 1000000).toString(); }
function validateEmail(e)       { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function validatePassword(p)    { return typeof p === 'string' && p.length >= 8 && p.length <= 128; }
function validateUsername(u)    { return /^[a-z0-9_]{3,32}$/i.test(u); }

// ─────────────────────────────────────────────
// E-mail (Resend)
// ─────────────────────────────────────────────
async function sendSystemEmail(email, username, code, type = 'verify') {
const key = process.env.RESEND_API_KEY;
if (!key) { return; }
const from    = process.env.EMAIL_FROM || 'no-reply@ogabriels.com';

let subject, title, sub, accentColor, extraWarning = '';

if (type === 'verify') {
  subject = 'Verifique sua conta';
  title   = 'Bem-vindo à Força Aliada!';
  sub     = 'Use o código abaixo para ativar o seu cadastro:';
  accentColor = '#0071e3';
} else if (type === 'delete_account') {
  subject = '⚠️ Confirmação de exclusão de conta';
  title   = 'Solicitação de exclusão de conta';
  sub     = 'Recebemos uma solicitação para excluir permanentemente sua conta. Use o código abaixo para confirmar:';
  accentColor = '#ff3b30';
  extraWarning = '<p style="color:#ff3b30;font-size:13px;font-weight:600;margin-top:8px;">⚠️ Esta ação é irreversível. Se você não solicitou isso, ignore este e-mail — sua conta continuará segura.</p>';
} else {
  subject = 'Código de Recuperação';
  title   = 'Força Aliada';
  sub     = 'Utilize o código de 6 dígitos abaixo no site:';
  accentColor = '#0071e3';
}

const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e5ea;border-radius:12px;"> <h2 style="color:#1d1d1f;">${title}</h2> <p style="color:#1d1d1f;">Olá <strong>${username}</strong>,</p> <p style="color:#86868b;">${sub}</p> <div style="background:#f2f2f7;padding:16px;border-radius:8px;text-align:center;margin:24px 0;"> <strong style="font-size:32px;letter-spacing:4px;color:${accentColor};">${code}</strong> </div> <p style="color:#86868b;font-size:13px;">Este código expira em 15 minutos.</p>${extraWarning} </div>`;
try {
await fetch('https://api.resend.com/emails', {
method: 'POST',
headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
body: JSON.stringify({ from, to: email, subject, html }),
});
} catch (e) { console.error('[email]', e); }
}

// ─────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────
async function migrate() {
const baseSchemaSql = String.raw`
CREATE TABLE IF NOT EXISTS users (
id            SERIAL PRIMARY KEY,
username      VARCHAR(255) UNIQUE NOT NULL,
email         VARCHAR(255) UNIQUE NOT NULL,
minecraft_name VARCHAR(255),
photo_url     VARCHAR(255) DEFAULT 'assets/images/fa-icon-dark.png',
password_hash VARCHAR(255) NOT NULL,
role          VARCHAR(50)  NOT NULL DEFAULT 'limited',
is_verified   BOOLEAN      DEFAULT TRUE,
created_at    TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','full','limited'));
UPDATE users
SET photo_url = 'assets/images/fa-icon-dark.png'
WHERE photo_url IS NULL
   OR lower(photo_url) IN ('logo.jpg','logo.jpeg','assets/images/logo.jpg','assets/images/logo.jpeg','/assets/images/logo.jpg','/assets/images/logo.jpeg');

CREATE TABLE IF NOT EXISTS player_sessions (
  id            SERIAL PRIMARY KEY,
  player        VARCHAR(255) NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL,
  left_at       TIMESTAMPTZ,
  duration_hours FLOAT
);
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS duration_hours FLOAT;
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS origin VARCHAR(20) DEFAULT 'site';
CREATE INDEX IF NOT EXISTS idx_player_name      ON player_sessions(player);
CREATE INDEX IF NOT EXISTS idx_player_left_at   ON player_sessions(left_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           VARCHAR(64),
  city         VARCHAR(128),
  region       VARCHAR(128),
  country      VARCHAR(128),
  isp          VARCHAR(255),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  revoked      BOOLEAN DEFAULT FALSE
);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS city    VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS region  VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS country VARCHAR(128);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS isp     VARCHAR(255);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_seen ON user_sessions(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(6)   NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  body        TEXT         NOT NULL,
  type        VARCHAR(50)  NOT NULL DEFAULT 'info',
  icon        VARCHAR(20)  DEFAULT '🔔',
  audience    VARCHAR(20)  NOT NULL DEFAULT 'all',
  audience_val TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'info';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience VARCHAR(20) DEFAULT 'all';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience_val TEXT;

CREATE TABLE IF NOT EXISTS notification_deletes (
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)         ON DELETE CASCADE,
  deleted_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_integration_keys (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS whitelist_queue (
  id             SERIAL PRIMARY KEY,
  minecraft_name VARCHAR(255) NOT NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  queued_at      TIMESTAMPTZ DEFAULT NOW(),
  delivered_at   TIMESTAMPTZ,
  delivered_by   INTEGER REFERENCES app_integration_keys(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_whitelist_queue_delivered ON whitelist_queue(delivered_at);
`;

await pool.query(baseSchemaSql);

const featureSchemaSql = `
CREATE TABLE IF NOT EXISTS player_notes (
  id           SERIAL PRIMARY KEY,
  minecraft_name VARCHAR(255) NOT NULL,
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name  VARCHAR(255),
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_mc ON player_notes(LOWER(minecraft_name));

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_server     BOOLEAN DEFAULT TRUE,
  email_events     BOOLEAN DEFAULT TRUE,
  email_community  BOOLEAN DEFAULT TRUE,
  public_profile   BOOLEAN DEFAULT TRUE,
  show_online      BOOLEAN DEFAULT TRUE,
  public_history   BOOLEAN DEFAULT FALSE,
  theme            VARCHAR(20) DEFAULT 'dark',
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_preferences ALTER COLUMN theme SET DEFAULT 'dark';

CREATE TABLE IF NOT EXISTS player_balances (
  minecraft_name  VARCHAR(255) PRIMARY KEY,
  merit_total     INTEGER      NOT NULL DEFAULT 0,
  capital_balance FLOAT        NOT NULL DEFAULT 0,
  rank            VARCHAR(50)  NOT NULL DEFAULT 'ferro',
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balances_merit ON player_balances(merit_total DESC);

CREATE TABLE IF NOT EXISTS merit_records (
  id              SERIAL PRIMARY KEY,
  minecraft_name  VARCHAR(255) NOT NULL,
  amount          INTEGER      NOT NULL,
  reason          TEXT         NOT NULL,
  category        VARCHAR(50)  NOT NULL DEFAULT 'outros',
  awarded_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_by_name VARCHAR(255),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merit_mc      ON merit_records(LOWER(minecraft_name));
CREATE INDEX IF NOT EXISTS idx_merit_created ON merit_records(created_at DESC);

CREATE TABLE IF NOT EXISTS capital_records (
  id              SERIAL PRIMARY KEY,
  minecraft_name  VARCHAR(255) NOT NULL,
  amount          FLOAT        NOT NULL,
  type            VARCHAR(50)  NOT NULL DEFAULT 'ajuste',
  description     TEXT         NOT NULL,
  created_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name VARCHAR(255),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);
ALTER TABLE capital_records ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'ajuste';
CREATE INDEX IF NOT EXISTS idx_capital_mc ON capital_records(LOWER(minecraft_name));

CREATE TABLE IF NOT EXISTS server_status_checks (
  id             SERIAL PRIMARY KEY,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  host           VARCHAR(255) NOT NULL,
  online         BOOLEAN NOT NULL,
  players_online INTEGER DEFAULT 0,
  players_max    INTEGER DEFAULT 0,
  latency_ms     INTEGER,
  version        VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_server_status_checked ON server_status_checks(checked_at DESC);

-- ─────────────────────────────────────────────
-- NOVA TABELA: INTEGRAÇÕES (MICROSOFT / XBOX)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_integrations (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ms_refresh_token TEXT,
  xbox_xuid        VARCHAR(255),
  mc_uuid          VARCHAR(64) UNIQUE,
  mc_edition       VARCHAR(10) DEFAULT 'java',
  mc_name          VARCHAR(255),
  xbox_gamertag    VARCHAR(255),
  is_primary       BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
-- Altera o tipo da coluna mc_uuid para suportar IDs sintéticos Bedrock ('bedrock_' + xuid)
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS ms_refresh_token TEXT;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS xbox_xuid VARCHAR(255);
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS mc_uuid VARCHAR(64);
ALTER TABLE user_integrations ALTER COLUMN mc_uuid TYPE VARCHAR(64);
-- Adiciona coluna mc_edition se ainda não existir (migração idempotente)
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS mc_edition VARCHAR(10) DEFAULT 'java';
-- Migra a versao antiga da tabela (user_id era PRIMARY KEY) para multiplas contas Microsoft.
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE user_integrations DROP CONSTRAINT IF EXISTS user_integrations_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_integrations'::regclass
      AND conname = 'user_integrations_pkey'
  ) THEN
    ALTER TABLE user_integrations ADD CONSTRAINT user_integrations_pkey PRIMARY KEY (id);
  END IF;
END $$;
ALTER TABLE user_integrations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS mc_name VARCHAR(255);
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS xbox_gamertag VARCHAR(255);
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE;
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
UPDATE user_integrations ui
SET mc_name = COALESCE(ui.mc_name, u.minecraft_name),
    is_primary = COALESCE(ui.is_primary, TRUE)
FROM users u
WHERE ui.user_id = u.id;
WITH ranked_integrations AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COALESCE(updated_at, created_at) DESC, id ASC) AS rn
  FROM user_integrations
)
UPDATE user_integrations ui
SET is_primary = (ri.rn = 1)
FROM ranked_integrations ri
WHERE ui.id = ri.id
  AND NOT EXISTS (
    SELECT 1 FROM user_integrations ui2
    WHERE ui2.user_id = ui.user_id
      AND ui2.is_primary = TRUE
  );
CREATE INDEX IF NOT EXISTS idx_integrations_xuid ON user_integrations(xbox_xuid);
CREATE INDEX IF NOT EXISTS idx_integrations_user ON user_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_primary ON user_integrations(user_id, is_primary);

CREATE TABLE IF NOT EXISTS social_accounts (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           VARCHAR(32) NOT NULL,
  provider_user_id   VARCHAR(255) NOT NULL,
  provider_email     VARCHAR(255),
  refresh_token      TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, provider_user_id),
  UNIQUE(user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_provider_email ON social_accounts(provider, provider_email);

-- Tabela para verificação por e-mail na exclusão de conta
-- Separada de email_verifications para evitar conflito de tipos/propósito
CREATE TABLE IF NOT EXISTS delete_account_verifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       VARCHAR(6) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_delete_verify_user ON delete_account_verifications(user_id);

-- Tabela da Rede Social (Seguidores)
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS account_affiliations (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  scopes TEXT[] NOT NULL DEFAULT ARRAY['post']::text[],
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  CHECK (owner_user_id <> delegate_user_id),
  UNIQUE(owner_user_id, delegate_user_id)
);
CREATE INDEX IF NOT EXISTS idx_account_affiliations_delegate ON account_affiliations(delegate_user_id, status);
CREATE INDEX IF NOT EXISTS idx_account_affiliations_owner ON account_affiliations(owner_user_id, status);

-- Adiciona a coluna Bio/Status nas preferências, se não existir
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS bio VARCHAR(160) DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS display_name VARCHAR(40) DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS profile_layout VARCHAR(24) DEFAULT 'posts';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS profile_links JSONB DEFAULT '[]'::jsonb;

-- ─────────────────────────────────────────────
-- REDE SOCIAL: POSTAGENS E CURTIDAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  likes_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS edit_count INTEGER DEFAULT 0;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS repost_of_id INTEGER REFERENCES user_posts(id) ON DELETE CASCADE;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE user_posts SET created_by_user_id = author_id WHERE created_by_user_id IS NULL;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS media_urls TEXT[] DEFAULT '{}'::text[];
ALTER TABLE user_posts ALTER COLUMN media_urls SET DEFAULT '{}'::text[];
UPDATE user_posts SET media_urls = '{}'::text[] WHERE media_urls IS NULL;
ALTER TABLE user_posts ALTER COLUMN media_urls SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_posts_author ON user_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_user_posts_created_by ON user_posts(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_user_posts_date ON user_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_posts_pinned ON user_posts(is_pinned DESC, pinned_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_posts_repost_of ON user_posts(repost_of_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_posts_repost_once ON user_posts(author_id, repost_of_id) WHERE repost_of_id IS NOT NULL AND content = '';

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER REFERENCES user_posts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS media_urls TEXT[] DEFAULT '{}'::text[];
UPDATE post_comments SET media_urls = '{}'::text[] WHERE media_urls IS NULL;
ALTER TABLE post_comments ALTER COLUMN media_urls SET DEFAULT '{}'::text[];
ALTER TABLE post_comments ALTER COLUMN media_urls SET NOT NULL;
DROP INDEX IF EXISTS idx_comments_post;
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, created_at ASC);

-- ── Polls ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_polls (
  id SERIAL PRIMARY KEY,
  post_id INTEGER UNIQUE REFERENCES user_posts(id) ON DELETE CASCADE,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_polls_post ON post_polls(post_id);

CREATE TABLE IF NOT EXISTS post_poll_options (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER REFERENCES post_polls(id) ON DELETE CASCADE,
  text VARCHAR(80) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  votes_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON post_poll_options(poll_id, sort_order);

CREATE TABLE IF NOT EXISTS post_poll_votes (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER REFERENCES post_polls(id) ON DELETE CASCADE,
  option_id INTEGER REFERENCES post_poll_options(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (poll_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON post_poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON post_poll_votes(user_id);
-- ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_tag_affinity (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag VARCHAR(64) NOT NULL,
  affinity_score NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (affinity_score >= 0 AND affinity_score <= 10),
  last_interacted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_user_tag_affinity_user_score ON user_tag_affinity(user_id, affinity_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_tag_affinity_tag ON user_tag_affinity(tag);

CREATE OR REPLACE FUNCTION fa_apply_tag_affinity(p_user_id INTEGER, p_post_id INTEGER, p_delta NUMERIC)
RETURNS VOID AS $$
DECLARE
  post_text TEXT;
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;

  SELECT COALESCE(original.content, p.content)
    INTO post_text
  FROM user_posts p
  LEFT JOIN user_posts original ON original.id = p.repost_of_id
  WHERE p.id = p_post_id;

  IF post_text IS NULL OR post_text = '' THEN
    RETURN;
  END IF;

  WITH tags AS (
    SELECT DISTINCT LOWER(rx.tag_match[1]) AS tag
    FROM regexp_matches(post_text, '#([[:alnum:]_]{2,32})', 'g') AS rx(tag_match)
  )
  INSERT INTO user_tag_affinity(user_id, tag, affinity_score, last_interacted_at)
  SELECT p_user_id,
         tags.tag,
         LEAST(10.0, GREATEST(0.0, p_delta)),
         NOW()
  FROM tags
  WHERE p_delta > 0
     OR EXISTS (
       SELECT 1
       FROM user_tag_affinity uta
       WHERE uta.user_id = p_user_id AND uta.tag = tags.tag
     )
  ON CONFLICT (user_id, tag) DO UPDATE
    SET affinity_score = LEAST(10.0, GREATEST(0.0, user_tag_affinity.affinity_score + p_delta)),
        last_interacted_at = NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fa_post_likes_affinity_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Like: weak positive signal. Weight +1 keeps lightweight reactions useful but not dominant.
    PERFORM fa_apply_tag_affinity(NEW.user_id, NEW.post_id, 1.0);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Unlike: remove the like signal without allowing negative affinity.
    PERFORM fa_apply_tag_affinity(OLD.user_id, OLD.post_id, -1.0);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_likes_affinity ON post_likes;
CREATE TRIGGER trg_post_likes_affinity
AFTER INSERT OR DELETE ON post_likes
FOR EACH ROW EXECUTE FUNCTION fa_post_likes_affinity_trigger();

CREATE OR REPLACE FUNCTION fa_post_comments_affinity_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_deleted, FALSE) = FALSE THEN
      -- Comment: stronger positive signal. Weight +2 means "I cared enough to answer".
      PERFORM fa_apply_tag_affinity(NEW.author_id, NEW.post_id, 2.0);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.is_deleted, FALSE) = FALSE THEN
      PERFORM fa_apply_tag_affinity(OLD.author_id, OLD.post_id, -2.0);
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(OLD.is_deleted, FALSE) = FALSE AND COALESCE(NEW.is_deleted, FALSE) = TRUE THEN
      PERFORM fa_apply_tag_affinity(OLD.author_id, OLD.post_id, -2.0);
    ELSIF COALESCE(OLD.is_deleted, FALSE) = TRUE AND COALESCE(NEW.is_deleted, FALSE) = FALSE THEN
      PERFORM fa_apply_tag_affinity(NEW.author_id, NEW.post_id, 2.0);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_comments_affinity ON post_comments;
CREATE TRIGGER trg_post_comments_affinity
AFTER INSERT OR UPDATE OF is_deleted OR DELETE ON post_comments
FOR EACH ROW EXECUTE FUNCTION fa_post_comments_affinity_trigger();

CREATE TABLE IF NOT EXISTS content_mentions (
  id SERIAL PRIMARY KEY,
  content_type VARCHAR(20) NOT NULL, -- 'post' | 'comment'
  content_id INTEGER NOT NULL,
  mentioned_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('post','comment','user')),
  content_id INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('spam','hate_speech','harassment','inappropriate','misinformation','other')),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed_kept','reviewed_removed','dismissed')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  action_taken VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (reporter_id, content_type, content_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_queue (
  id BIGSERIAL PRIMARY KEY,
  content_type VARCHAR(20) NOT NULL,
  content_id INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL DEFAULT 'reports_threshold',
  report_count INTEGER DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (content_type, content_id)
);

CREATE TABLE IF NOT EXISTS social_notifications (
  id BIGSERIAL PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(20),
  entity_id INTEGER,
  preview_text TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'post_like';
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS entity_type VARCHAR(20);
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS preview_text TEXT;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE social_notifications ALTER COLUMN actor_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_notif_recipient ON social_notifications(recipient_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_notif_entity ON social_notifications(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_user_posts_feed ON user_posts(id DESC) WHERE is_pinned = FALSE;
CREATE INDEX IF NOT EXISTS idx_user_follows_pair ON user_follows(follower_id, following_id);

CREATE TABLE IF NOT EXISTS direct_conversations (
  id BIGSERIAL PRIMARY KEY,
  participant_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (participant_a < participant_b),
  UNIQUE (participant_a, participant_b)
);
CREATE INDEX IF NOT EXISTS idx_direct_conversations_a ON direct_conversations(participant_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_conversations_b ON direct_conversations(participant_b, last_message_at DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_ref VARCHAR(80),
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation ON direct_messages(conversation_id, id DESC);
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
UPDATE direct_messages SET attachments = '[]'::jsonb WHERE attachments IS NULL;
ALTER TABLE direct_messages ALTER COLUMN attachments SET DEFAULT '[]'::jsonb;
ALTER TABLE direct_messages ALTER COLUMN attachments SET NOT NULL;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS client_ref VARCHAR(80);
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES direct_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_direct_messages_reply ON direct_messages(reply_to_message_id);

CREATE TABLE IF NOT EXISTS direct_message_reactions (
  message_id BIGINT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_direct_message_reactions_message ON direct_message_reactions(message_id);

CREATE TABLE IF NOT EXISTS direct_conversation_reads (
  conversation_id BIGINT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_groups_owner ON chat_groups(owner_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(user_id, group_id);

CREATE TABLE IF NOT EXISTS chat_group_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_ref VARCHAR(80),
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group ON chat_group_messages(group_id, id DESC);
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
UPDATE chat_group_messages SET attachments = '[]'::jsonb WHERE attachments IS NULL;
ALTER TABLE chat_group_messages ALTER COLUMN attachments SET DEFAULT '[]'::jsonb;
ALTER TABLE chat_group_messages ALTER COLUMN attachments SET NOT NULL;
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS client_ref VARCHAR(80);
ALTER TABLE chat_group_messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES chat_group_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_group_messages_reply ON chat_group_messages(reply_to_message_id);

CREATE TABLE IF NOT EXISTS group_message_reactions (
  message_id BIGINT NOT NULL REFERENCES chat_group_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_group_message_reactions_message ON group_message_reactions(message_id);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id BIGSERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '',
  media_urls TEXT[] NOT NULL DEFAULT '{}'::text[],
  poll_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  poll_duration_hours INTEGER NOT NULL DEFAULT 24,
  publish_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','publishing','published','cancelled','failed')),
  published_post_id INTEGER REFERENCES user_posts(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(status, publish_at);

-- Analytics indexes: keep command-center aggregations responsive as the community grows.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_sessions_entered ON player_sessions(entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_comments_created_author ON post_comments(created_at DESC, author_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_post_likes_created_user ON post_likes(created_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created_follower ON user_follows(created_at DESC, follower_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_created_sender ON direct_messages(created_at DESC, sender_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_group_messages_created_sender ON chat_group_messages(created_at DESC, sender_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_reports_created_status ON content_reports(created_at DESC, status);
CREATE INDEX IF NOT EXISTS idx_moderation_created_status ON moderation_queue(created_at DESC, status);
`;
await pool.query(featureSchemaSql);
  await pool.query(feedV2SchemaSql); // Feed v2: post_impressions, post_saves, feed_not_interested, triggers
  await pool.query(commentUpgradeSchemaSql); // Comment upgrade: parent_comment_id, comment_likes, likes_count, reply_count, triggers
  await pool.query(DASHBOARD_V2_SCHEMA_SQL); // Staff dashboard v2: settings, templates and scheduled broadcasts
  await pool.query(COMMUNITY_EVOLUTION_SCHEMA_SQL); // Community evolution: stories, reactions, image polls and grouped notifications

  // Audit schema — executado no boot, não lazily
  for (const statement of AUDIT_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }

  // Legacy migration schema — tabelas de migração de conta pirata→original
  await pool.query(LEGACY_MIGRATION_SCHEMA_SQL);
}

// ─────────────────────────────────────────────
// Seed admin
// ─────────────────────────────────────────────
async function seedAdmin() {
const u = sanitize(process.env.BOOTSTRAP_ADMIN_USERNAME);
const e = sanitize(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
const p = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
if (!u || !e || !p) return;
const { rows } = await pool.query('SELECT id FROM users WHERE username=$1', [u.toLowerCase()]);
if (rows.length) return;
const hash = await bcrypt.hash(p, 10);
await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,TRUE)',
[u.toLowerCase(), e, u, hash, 'owner'],
);
}

/**
 * Registra um evento de auditoria no banco de dados.
 */
async function audit({
  actorId = null, actorName = null,
  type, severity = 'info',
  targetId = null, targetName = null,
  message, metadata = null,
  ip = null, userAgent = null, sessionId = null,
}) {
  if (!message) { console.warn('[audit] chamado sem message, ignorando'); return; }
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (actor_id, actor_name, type, action, severity, target_id, target_name, message, metadata, ip, user_agent, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        actorId    || null,
        actorName  || null,
        type || 'system',
        type || 'system',
        severity,
        targetId   || null,
        targetName || null,
        message,
        metadata ? JSON.stringify(metadata) : null,
        ip         || null,
        userAgent  || null,
        sessionId  || null,
      ],
    );
  } catch (e) {
    console.error('[audit FAILED]', { type, message, actorId, error: e.message });
  }
}

/**
 * Wrapper conveniente que extrai IP, User-Agent e sessionId do objeto `req`
 * e repassa para `audit()`. Use este em todos os handlers de rota.
 */
async function auditFromReq(req, opts) {
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
  const userAgent = req.headers['user-agent'] || null;

  let sessionId = null;
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (rawToken) {
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const { rows } = await pool.query(
        'SELECT id FROM user_sessions WHERE token_hash=$1 AND revoked=FALSE LIMIT 1',
        [tokenHash],
      );
      sessionId = rows[0]?.id || null;
    }
  } catch { /* sessionId opcional */ }

  return audit({ ...opts, ip, userAgent, sessionId });
}

async function createMinecraftNotification({ minecraftName, title, body, type = 'info', icon = '🔔', createdBy = null }) {
  const mc = sanitize(minecraftName).toLowerCase();
  if (!mc || !title || !body) return null;
  const { rows } = await pool.query(
    `INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by)
     VALUES($1,$2,$3,$4,'minecraft',$5,$6) RETURNING id`,
    [title, body, type, icon, mc, createdBy]
  );
  return rows[0];
}

const SOCIAL_NOTIFICATION_TYPES = new Set([
  'new_follower',
  'post_like',
  'comment',
  'mention_post',
  'mention_comment',
  'direct_message',
  'repost',
  'friend_joined',
  'moderation_warn',
  'comment_like',
  'comment_reply',
  'message_reaction',
  'scheduled_post_published',
  'story_reaction',
  'creator_post',
  'creator_story',
  'creator_repost',
  'creator_reply',
]);

const REPORT_CONTENT_TYPES = new Set(['post', 'comment', 'user']);
const REPORT_REASONS = new Set(['spam', 'hate_speech', 'harassment', 'inappropriate', 'misinformation', 'other']);
const AFFILIATION_SCOPES = new Set(['post']);
const CHAT_REACTIONS = new Set(['❤️', '👍', '😂', '😮', '😢', '🔥', '👏']);

function isPrivileged(role) {
  return ['full', 'owner'].includes(role);
}

function socialRankSql(userAlias = 'u', balanceAlias = 'pb') {
  return `CASE
    WHEN ${userAlias}.role = 'owner' THEN 'owner'
    WHEN ${userAlias}.role = 'full' THEN 'adm'
    WHEN NULLIF(TRIM(COALESCE(${userAlias}.minecraft_name, '')), '') IS NULL THEN NULL
    ELSE COALESCE(${balanceAlias}.rank, 'ferro')
  END`;
}

function socialMeritSql(userAlias = 'u', balanceAlias = 'pb') {
  return `CASE
    WHEN ${userAlias}.role IN ('owner', 'full') THEN COALESCE(${balanceAlias}.merit_total, 0)
    WHEN NULLIF(TRIM(COALESCE(${userAlias}.minecraft_name, '')), '') IS NULL THEN NULL
    ELSE COALESCE(${balanceAlias}.merit_total, 0)
  END`;
}

function primaryIntegrationFieldsSql(userAlias = 'u') {
  return `(
    SELECT json_build_object(
      'mc_edition', ui.mc_edition,
      'xbox_xuid', ui.xbox_xuid,
      'xbox_gamertag', ui.xbox_gamertag
    )
    FROM user_integrations ui
    WHERE ui.user_id = ${userAlias}.id
    ORDER BY ui.is_primary DESC, ui.updated_at DESC NULLS LAST, ui.created_at DESC NULLS LAST, ui.id DESC
    LIMIT 1
  )`;
}

async function resolvePublishAuthor(requestUserId, requestedAuthorId, db = pool) {
  const executorId = Number(requestUserId);
  const parsedRequested = requestedAuthorId === undefined || requestedAuthorId === null || requestedAuthorId === ''
    ? executorId
    : parseInt(requestedAuthorId, 10);
  if (!executorId || !Number.isInteger(parsedRequested) || parsedRequested <= 0) {
    const err = new Error('Identidade de publicacao invalida.');
    err.status = 400;
    throw err;
  }

  const { rows: authorRows } = await db.query(
    `SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.role, u.is_platform_verified,
            COALESCE(up.display_name, '') AS display_name,
            COALESCE(up.avatar_url, '') AS avatar_url,
            COALESCE(up.cover_url, '') AS cover_url,
            ${socialRankSql('u', 'pb')} AS rank,
            ${socialMeritSql('u', 'pb')} AS merit,
            ${primaryIntegrationFieldsSql('u')} AS integration
     FROM users u
     LEFT JOIN user_preferences up ON up.user_id = u.id
     LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
     WHERE u.id = $1
     LIMIT 1`,
    [parsedRequested],
  );
  const author = authorRows[0];
  if (!author) {
    const err = new Error('Conta de publicacao nao encontrada.');
    err.status = 404;
    throw err;
  }

  if (parsedRequested === executorId) {
    return { authorId: executorId, executorId, delegated: false, affiliationId: null, author };
  }

  const { rows: affiliationRows } = await db.query(
    `SELECT id
     FROM account_affiliations
     WHERE owner_user_id = $1
       AND delegate_user_id = $2
       AND status = 'active'
       AND 'post' = ANY(scopes)
     LIMIT 1`,
    [parsedRequested, executorId],
  );
  if (!affiliationRows.length) {
    const err = new Error('Voce nao tem autorizacao ativa para publicar por esta conta.');
    err.status = 403;
    throw err;
  }

  return {
    authorId: parsedRequested,
    executorId,
    delegated: true,
    affiliationId: affiliationRows[0].id,
    author,
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizePostMediaUrls(input) {
  const values = Array.isArray(input) ? input : [];
  let cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  if (!cloudName && process.env.CLOUDINARY_URL) {
    try { cloudName = new URL(process.env.CLOUDINARY_URL).hostname; } catch {}
  }
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    if (urls.length >= 4) break;
    const raw = String(value || '').trim();
    if (!raw || raw.length > 700 || seen.has(raw)) continue;
    try {
      const url = new URL(raw);
      const isCloudinaryImage = url.protocol === 'https:'
        && url.hostname === 'res.cloudinary.com'
        && url.pathname.startsWith(`/${cloudName || ''}/image/upload/`);
      if (!isCloudinaryImage) continue;
      seen.add(raw);
      urls.push(url.href);
    } catch {}
  }
  return urls;
}

function normalizeClientRef(value = '') {
  const raw = String(value || '').trim();
  return /^[a-z0-9:_-]{1,80}$/i.test(raw) ? raw : null;
}

function normalizeChatAttachmentUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 1200) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeChatAttachments(input) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of values) {
    if (out.length >= CHAT_ATTACHMENT_MAX_FILES) break;
    if (!item || typeof item !== 'object') continue;
    const url = normalizeChatAttachmentUrl(item.url || item.secure_url);
    const type = String(item.type || item.kind || '').toLowerCase();
    if (!url || !CHAT_ATTACHMENT_TYPES.has(type) || seen.has(url)) continue;
    const size = Math.max(0, Math.min(Number(item.size || item.bytes || 0) || 0, CHAT_ATTACHMENT_MAX_BYTES));
    const width = Number(item.width || 0) || null;
    const height = Number(item.height || 0) || null;
    const duration = Number(item.duration || 0) || null;
    out.push({
      url,
      type,
      name: cleanFileName(item.name || item.original_filename || 'arquivo'),
      mime_type: String(item.mime_type || item.mimetype || '').slice(0, 120),
      size,
      width,
      height,
      duration,
    });
    seen.add(url);
  }
  return out;
}

function chatAttachmentPreviewText(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  if (list.length > 1) return `${list.length} anexos`;
  const type = list[0]?.type;
  if (type === 'image') return 'Imagem';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'pdf') return 'PDF';
  return 'Arquivo';
}

function parseCommunityIdentifier(identifier = '') {
  const raw = sanitize(decodeURIComponent(String(identifier || ''))).trim();
  const idMatch = raw.match(/^id:(\d+)$/i);
  if (idMatch) return { raw, byId: true, value: Number(idMatch[1]) };
  return { raw, byId: false, value: raw.toLowerCase() };
}

function rankBenefits(rank) {
  const id = String(rank || 'ferro').toLowerCase();
  if (id.includes('netherite')) return ['Destaque maximo no perfil', 'Prioridade em eventos', 'Badge lendario'];
  if (id.includes('diamante')) return ['Destaque verde no feed', 'Beneficios de temporada', 'Badge raro'];
  if (id.includes('ouro')) return ['Badge dourado', 'Maior visibilidade social', 'Eventos especiais'];
  if (id.includes('admin') || id.includes('staff') || id.includes('full') || id.includes('owner')) return ['Ferramentas de moderacao', 'Destaque institucional', 'Sinalizacao de confianca'];
  return ['Progressao inicial', 'Base para ranks maiores', 'Perfil publico gamificado'];
}

function buildProfileBadges(profile = {}, stats = {}) {
  const merit = Number(profile.merit || 0);
  const followers = Number(profile.followers_count || 0);
  const posts = Number(profile.posts_count || 0);
  const hours = Number(stats.total_hours || 0);
  const badges = [];

  if (merit >= 150) badges.push({ id: 'ouro', label: 'Ouro Social', description: 'Alcancou 150 pontos de merito.', progress: 100 });
  else badges.push({ id: 'ouro-next', label: 'Rumo ao Ouro', description: 'Faltam pontos de merito para o rank Ouro.', progress: Math.round((merit / 150) * 100) });

  if (followers >= 10) badges.push({ id: 'networker', label: 'Conector', description: 'Tem pelo menos 10 seguidores na comunidade.', progress: 100 });
  else badges.push({ id: 'networker-next', label: 'Conector', description: 'Construa sua rede de seguidores.', progress: Math.round((followers / 10) * 100) });

  if (posts >= 25) badges.push({ id: 'voz-ativa', label: 'Voz Ativa', description: 'Publicou 25 posts no feed.', progress: 100 });
  else badges.push({ id: 'voz-ativa-next', label: 'Voz Ativa', description: 'Continue puxando conversa no feed.', progress: Math.round((posts / 25) * 100) });

  if (hours >= 20) badges.push({ id: 'veterano', label: 'Veterano', description: 'Somou 20 horas ou mais no servidor.', progress: 100 });
  else badges.push({ id: 'veterano-next', label: 'Veterano', description: 'Jogue mais horas para desbloquear.', progress: Math.round((hours / 20) * 100) });

  return badges.slice(0, 8);
}

function htmlEscape(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function plainText(value = '', max = 180) {
  return sanitizeText(value)
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .trim()
    .slice(0, max);
}

function publicAssetUrl(path = '/assets/images/og-image.jpg') {
  return new URL(path, `${FRONTEND_BASE_URL}/`).href;
}

function publicPageUrl(path = '/') {
  return new URL(path, `${FRONTEND_BASE_URL}/`).href;
}

const PUBLIC_SHARE_BASE_URL = (process.env.PUBLIC_SHARE_BASE_URL || FRONTEND_BASE_URL).replace(/\/+$/, '');

function absolutePublicUrl(value = '') {
  if (!value) return '';
  try {
    const url = new URL(String(value), `${FRONTEND_BASE_URL}/`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function publicShareBaseUrl(req) {
  return PUBLIC_SHARE_BASE_URL || FRONTEND_BASE_URL;
}

function publicSharePageUrl(req, path = '/') {
  return new URL(path, `${publicShareBaseUrl(req)}/`).href;
}

function firstMediaUrl(mediaUrls) {
  const list = Array.isArray(mediaUrls) ? mediaUrls : [];
  const raw = list.find(Boolean);
  return absolutePublicUrl(raw);
}

function isoDate(value = Date.now()) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function renderShareHtml({
  title,
  description,
  image,
  canonical,
  redirectUrl,
  type = 'website',
  jsonLd = {},
  breadcrumbs = [],
  extraContent = '',
  noindex = false,
  primaryActionLabel = 'Abrir na FA Community',
  additionalLinks = [],
}) {
  const safeTitle = title || 'Forca Aliada';
  const safeDescription = description || 'Comunidade Forca Aliada.';
  const safeImage = image || publicAssetUrl('/assets/images/og-image.jpg');
  const safeCanonical = canonical || publicPageUrl('/');
  const safeRedirect = redirectUrl || safeCanonical;
  const graph = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  if (breadcrumbs.length) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: item.url,
      })),
    });
  }
  const ld = { '@context': 'https://schema.org', '@graph': graph };
  const breadcrumbHtml = breadcrumbs.length ? `<nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbs.map((item, index) => (
    index === breadcrumbs.length - 1
      ? `<span aria-current="page">${htmlEscape(item.name)}</span>`
      : `<a href="${htmlEscape(item.url)}">${htmlEscape(item.name)}</a><span aria-hidden="true">/</span>`
  )).join('')}</nav>` : '';
  const linksHtml = additionalLinks.length ? `<aside class="more"><h2>Explore a Forca Aliada</h2><div>${additionalLinks.map(link => `<a href="${htmlEscape(link.url)}">${htmlEscape(link.label)}</a>`).join('')}</div></aside>` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(safeTitle)}</title>
<meta name="description" content="${htmlEscape(safeDescription)}">
<meta name="author" content="Forca Aliada">
<meta name="robots" content="${noindex ? 'noindex,nofollow,noarchive' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1'}">
<link rel="canonical" href="${htmlEscape(safeCanonical)}">
<link rel="alternate" hreflang="pt-BR" href="${htmlEscape(safeCanonical)}">
<link rel="alternate" hreflang="x-default" href="${htmlEscape(safeCanonical)}">
<meta property="og:type" content="${htmlEscape(type)}">
<meta property="og:site_name" content="Forca Aliada">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${htmlEscape(safeTitle)}">
<meta property="og:description" content="${htmlEscape(safeDescription)}">
<meta property="og:url" content="${htmlEscape(safeCanonical)}">
<meta property="og:image" content="${htmlEscape(safeImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${htmlEscape(safeTitle)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlEscape(safeTitle)}">
<meta name="twitter:description" content="${htmlEscape(safeDescription)}">
<meta name="twitter:image" content="${htmlEscape(safeImage)}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
:root{color-scheme:dark;--bg:#07111e;--surface:#0f1d2d;--surface2:#14263b;--text:#f4f8ff;--muted:#a9b8cc;--line:#29415d;--accent:#68dca8;--blue:#82afff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% -10%,#17365a 0,transparent 38%),var(--bg);color:var(--text);font:17px/1.65 system-ui,-apple-system,Segoe UI,sans-serif}a{color:var(--blue)}.top,main,.more,footer{width:min(900px,calc(100% - 36px));margin:auto}.top{display:flex;justify-content:space-between;align-items:center;padding:22px 0}.brand{color:var(--text);font-weight:900;text-decoration:none;letter-spacing:.05em}.top nav{display:flex;gap:18px}.breadcrumbs{display:flex;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:.9rem;margin-bottom:20px}.breadcrumbs a{color:var(--muted)}main{padding:52px 0}.card,.more{background:linear-gradient(145deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:25px;padding:clamp(22px,5vw,44px);box-shadow:0 24px 90px rgba(0,0,0,.22)}h1{font-size:clamp(2rem,6vw,4rem);line-height:1.06;letter-spacing:-.04em;margin:0 0 18px}.description{font-size:1.15rem;color:var(--muted);white-space:pre-wrap}.cta{display:inline-block;margin-top:22px;background:var(--accent);color:#052216;padding:12px 18px;border-radius:999px;font-weight:900;text-decoration:none}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}.stat{background:#081521;border:1px solid var(--line);border-radius:14px;padding:9px 13px;color:var(--muted)}.media{display:grid;gap:12px;margin-top:24px}.media img{display:block;width:100%;height:auto;max-height:660px;object-fit:cover;border-radius:18px;background:#07111e}.post-list{display:grid;gap:12px;margin-top:24px}.post-card{display:block;background:#081521;border:1px solid var(--line);border-radius:16px;padding:16px;color:var(--text);text-decoration:none}.post-card small{color:var(--muted)}.more{margin-top:22px;padding:26px}.more h2{margin-top:0;font-size:1.1rem}.more div{display:flex;gap:14px;flex-wrap:wrap}footer{padding:38px 0 60px;color:var(--muted);display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}@media(max-width:620px){.top nav{display:none}main{padding-top:28px}}
</style>
</head>
<body>
<header class="top"><a class="brand" href="${htmlEscape(publicPageUrl('/'))}">FORCA ALIADA</a><nav><a href="${htmlEscape(publicPageUrl('/guia'))}">Guia</a><a href="${htmlEscape(publicPageUrl('/community'))}">Comunidade</a></nav></header>
<main>
${breadcrumbHtml}
<article class="card">
<h1>${htmlEscape(safeTitle)}</h1>
<p class="description">${htmlEscape(safeDescription)}</p>
${extraContent}
<a class="cta" href="${htmlEscape(safeRedirect)}">${htmlEscape(primaryActionLabel)}</a>
</article>
</main>
${linksHtml}
<footer><span>Forca Aliada, ativa desde 2021.</span><span><a href="${htmlEscape(publicPageUrl('/termos'))}">Termos</a> · <a href="${htmlEscape(publicPageUrl('/privacidade'))}">Privacidade</a></span></footer>
</body>
</html>`;
}

function renderShareNotFound(title, description) {
  return renderShareHtml({
    title,
    description,
    canonical: publicPageUrl('/community'),
    redirectUrl: publicPageUrl('/community'),
    noindex: true,
    primaryActionLabel: 'Voltar para a comunidade',
    jsonLd: { '@type': 'WebPage', name: title, description },
  });
}

function setShareResponseHeaders(res, cacheControl) {
  res.set({
    'Cache-Control': cacheControl,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
}

function renderPostMedia(mediaUrls = [], alt = '') {
  const media = mediaUrls.map(absolutePublicUrl).filter(Boolean).slice(0, 4);
  if (!media.length) return '';
  return `<div class="media">${media.map((url, index) => `<img src="${htmlEscape(url)}" alt="${htmlEscape(`${alt} - imagem ${index + 1}`)}" title="${htmlEscape(alt)}" width="1200" height="675" loading="${index ? 'lazy' : 'eager'}" decoding="async">`).join('')}</div>`;
}

function renderPublicPostList(posts = [], heading = 'Posts recentes') {
  if (!posts.length) return '';
  return `<section class="post-list"><h2>${htmlEscape(heading)}</h2>${posts.slice(0, 6).map(post => {
    const excerpt = plainText(post.content, 150) || 'Publicacao com imagem na comunidade.';
    return `<a class="post-card" href="${htmlEscape(publicPageUrl(`/share/post/${encodeURIComponent(post.id)}`))}">${htmlEscape(excerpt)}<br><small>${Number(post.likes_count || 0)} curtidas · ${Number(post.comments_count || 0)} comentarios</small></a>`;
  }).join('')}</section>`;
}

async function loadPublicPost(postId) {
  const id = parseInt(postId, 10);
  if (!id) return null;
  const { rows } = await pool.query(`
    SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
           (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count,
           (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
           u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.role, u.is_platform_verified,
           COALESCE(up.display_name, '') AS display_name,
           COALESCE(up.avatar_url, '') AS avatar_url,
           COALESCE(up.public_profile, TRUE) AS public_profile,
           ${primaryIntegrationFieldsSql('u')} AS integration,
           ${socialRankSql('u', 'pb')} AS rank,
           ${socialMeritSql('u', 'pb')} AS merit
    FROM user_posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN user_preferences up ON up.user_id = u.id
    LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
    WHERE p.id = $1
      AND p.repost_of_id IS NULL
      AND COALESCE(up.public_profile, TRUE) = TRUE
    LIMIT 1
  `, [id]);
  return rows[0] || null;
}

async function loadPublicProfile(identifier) {
  const ident = parseCommunityIdentifier(identifier);
  const where = ident.byId ? 'u.id = $1' : '(LOWER(u.minecraft_name) = $1 OR LOWER(u.username) = $1)';
  const { rows: profileRows } = await pool.query(`
    SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.created_at, u.role, u.is_platform_verified,
           COALESCE(up.bio, '') AS bio,
           COALESCE(up.display_name, '') AS display_name,
           COALESCE(up.avatar_url, '') AS avatar_url,
           COALESCE(up.cover_url, '') AS cover_url,
           COALESCE(up.profile_layout, 'posts') AS profile_layout,
           COALESCE(up.profile_links, '[]'::jsonb) AS profile_links,
           COALESCE(up.public_profile, TRUE) AS public_profile,
           COALESCE(up.public_history, FALSE) AS public_history,
           ${primaryIntegrationFieldsSql('u')} AS integration,
           ${socialRankSql('u', 'pb')} AS rank,
           ${socialMeritSql('u', 'pb')} AS merit,
           COALESCE(pb.capital_balance, 0) AS capital,
           (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count,
           (SELECT COUNT(*) FROM user_follows WHERE follower_id = u.id)::int AS following_count,
           (SELECT COUNT(*) FROM user_follows f1
            JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
            WHERE f1.follower_id = u.id)::int AS friends_count,
           (SELECT COUNT(*) FROM user_posts WHERE author_id = u.id AND repost_of_id IS NULL)::int AS posts_count
    FROM users u
    LEFT JOIN user_preferences up ON up.user_id = u.id
    LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
    WHERE ${where}
      AND COALESCE(up.public_profile, TRUE) = TRUE
    LIMIT 1
  `, [ident.value]);
  const profile = profileRows[0];
  if (!profile) return null;

  const [postsResult, statsResult, dailyResult] = await Promise.all([
    pool.query(`
      SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
             (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.is_deleted = FALSE)::int AS comments_count,
             (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count
      FROM user_posts p
      WHERE p.author_id = $1
        AND p.repost_of_id IS NULL
      ORDER BY p.is_pinned DESC, p.pinned_at DESC NULLS LAST, p.created_at DESC
      LIMIT 12
    `, [profile.id]),
    profile.public_history ? pool.query(`
      SELECT COUNT(*)::int AS total_sessions,
             COALESCE(SUM(duration_hours),0)::float AS total_hours,
             MAX(entered_at) AS last_seen
      FROM player_sessions
      WHERE LOWER(player)=LOWER($1)
    `, [profile.minecraft_name || profile.username]) : Promise.resolve({ rows: [{ total_sessions: 0, total_hours: 0, last_seen: null }] }),
    profile.public_history ? pool.query(`
      SELECT date_trunc('day', entered_at)::date AS day,
             COALESCE(SUM(duration_hours),0)::float AS hours
      FROM player_sessions
      WHERE LOWER(player)=LOWER($1)
        AND entered_at > NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `, [profile.minecraft_name || profile.username]) : Promise.resolve({ rows: [] }),
  ]);
  const gameStats = profile.public_history ? { ...(statsResult.rows[0] || {}), daily_hours: dailyResult.rows } : null;
  return {
    profile: { ...profile, rank_benefits: rankBenefits(profile.rank) },
    posts: postsResult.rows,
    replies: [],
    reposts: [],
    media: [],
    game_stats: gameStats,
    badges: buildProfileBadges(profile, gameStats || {}),
    follow_since: null,
  };
}

app.get('/api/public/community/posts/:id', async (req, res) => {
  try {
    const post = await loadPublicPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post publico nao encontrado' });
    res.json(post);
  } catch (e) {
    console.error('[GET /api/public/community/posts/:id]', e);
    res.status(500).json({ error: 'Erro ao buscar post publico' });
  }
});

app.get('/api/public/community/feed', async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 30);
  const cursor = parseInt(req.query.cursor_id || req.query.cursor, 10) || null;
  const search = req.query.search ? `%${sanitize(req.query.search).toLowerCase()}%` : null;
  const hashtag = req.query.hashtag ? `%#${sanitize(req.query.hashtag).replace(/^#/, '').toLowerCase()}%` : null;
  const params = [limit];
  const conditions = [
    'p.repost_of_id IS NULL',
    'COALESCE(up.public_profile, TRUE) = TRUE',
  ];
  if (cursor) {
    params.push(cursor);
    conditions.push(`p.id < $${params.length}`);
  }
  if (search) {
    params.push(search);
    conditions.push(`(LOWER(COALESCE(p.content, '')) LIKE $${params.length} OR LOWER(COALESCE(u.minecraft_name, u.username, '')) LIKE $${params.length})`);
  }
  if (hashtag) {
    params.push(hashtag);
    conditions.push(`LOWER(COALESCE(p.content, '')) LIKE $${params.length}`);
  }
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned, p.pinned_at,
             p.created_by_user_id, NULL::integer AS repost_of_id,
             u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.role, u.is_platform_verified,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             COALESCE(up.cover_url, '') AS cover_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count,
             (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
             (SELECT COUNT(*) FROM post_saves ps WHERE ps.post_id = p.id)::int AS saves_count,
             FALSE AS liked_by_me, FALSE AS reposted_by_me, FALSE AS saved_by_me,
             '[]'::json AS recent_comments, NULL::json AS poll
      FROM user_posts p
      JOIN users u ON p.author_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.is_pinned DESC, p.pinned_at DESC NULLS LAST, p.id DESC
      LIMIT $1
    `, params);
    const lastId = rows.at(-1)?.id || null;
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=1800');
    res.json({
      posts: rows,
      next_cursor: rows.length === limit && lastId ? { score: 0, id: lastId } : null,
      has_more: rows.length === limit,
      public_preview: true,
    });
  } catch (e) {
    console.error('[GET /api/public/community/feed]', e);
    res.status(500).json({ error: 'Erro ao buscar o feed publico.' });
  }
});

app.get('/api/public/community/player/:identifier/full-profile', async (req, res) => {
  try {
    const payload = await loadPublicProfile(req.params.identifier);
    if (!payload) return res.status(404).json({ error: 'Perfil publico nao encontrado' });
    res.json(payload);
  } catch (e) {
    console.error('[GET /api/public/community/player/:identifier/full-profile]', e);
    res.status(500).json({ error: 'Erro ao buscar perfil publico' });
  }
});

app.get('/share/post/:id', async (req, res) => {
  try {
    const post = await loadPublicPost(req.params.id);
    if (!post) {
      setShareResponseHeaders(res, 'public, max-age=60, s-maxage=300');
      return res.status(404).type('html').send(renderShareNotFound('Post indisponivel | Forca Aliada', 'Este post nao existe, foi removido ou nao pertence a um perfil publico.'));
    }
    const author = post.display_name || post.minecraft_name || post.username || 'Jogador';
    const description = plainText(post.content, 260) || `${author} compartilhou uma publicacao com a comunidade Minecraft Forca Aliada.`;
    const image = firstMediaUrl(post.media_urls) || absolutePublicUrl(post.avatar_url) || absolutePublicUrl(post.photo_url) || publicAssetUrl('/assets/images/og-image.jpg');
    const canonical = publicSharePageUrl(req, `/share/post/${encodeURIComponent(post.id)}`);
    const redirectUrl = publicPageUrl(`/post?id=${encodeURIComponent(post.id)}`);
    const authorIdentifier = post.minecraft_name || post.username || `id:${post.author_id}`;
    const authorUrl = publicSharePageUrl(req, `/share/profile/${encodeURIComponent(authorIdentifier)}`);
    const related = await pool.query(`
      SELECT p.id, p.content, p.media_urls, p.created_at,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count
      FROM user_posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE p.id <> $1
        AND p.repost_of_id IS NULL
        AND COALESCE(up.public_profile, TRUE) = TRUE
        AND (array_length(p.media_urls, 1) > 0 OR length(trim(COALESCE(p.content, ''))) >= 40)
      ORDER BY ((SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) +
                (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE) * 2) DESC,
               p.created_at DESC
      LIMIT 4
    `, [post.id]);
    const stats = `<div class="stats"><span class="stat">${Number(post.likes_count || 0)} curtidas</span><span class="stat">${Number(post.comments_count || 0)} comentarios</span><span class="stat">${Number(post.reposts_count || 0)} reposts</span><a class="stat" href="${htmlEscape(authorUrl)}">Perfil de ${htmlEscape(author)}</a></div>`;
    const postImages = (post.media_urls || []).map(absolutePublicUrl).filter(Boolean);
    setShareResponseHeaders(res, 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    res.type('html').send(renderShareHtml({
      title: `Post de ${author} | Forca Aliada`,
      description,
      image,
      canonical,
      redirectUrl,
      type: 'article',
      breadcrumbs: [
        { name: 'Inicio', url: publicPageUrl('/') },
        { name: 'Comunidade', url: publicPageUrl('/community') },
        { name: `Post de ${author}`, url: canonical },
      ],
      extraContent: `${stats}${renderPostMedia(post.media_urls, `Post de ${author}`)}${renderPublicPostList(related.rows, 'Mais posts da comunidade')}`,
      additionalLinks: [
        { label: 'Conheca o servidor', url: publicPageUrl('/') },
        { label: 'Leia o guia', url: publicPageUrl('/guia') },
        { label: `Veja o perfil de ${author}`, url: authorUrl },
      ],
      jsonLd: {
        '@type': 'SocialMediaPosting',
        '@id': canonical,
        headline: `Post de ${author}`,
        articleBody: plainText(post.content, 5000),
        datePublished: post.created_at,
        dateModified: post.updated_at || post.created_at,
        inLanguage: 'pt-BR',
        url: canonical,
        author: {
          '@type': 'Person',
          name: author,
          url: authorUrl,
          image: absolutePublicUrl(post.avatar_url) || absolutePublicUrl(post.photo_url) || (post.minecraft_name ? `https://minotar.net/helm/${encodeURIComponent(post.minecraft_name)}/80.png` : undefined),
        },
        publisher: {
          '@type': 'Organization',
          name: 'Forca Aliada',
          url: publicPageUrl('/'),
          logo: { '@type': 'ImageObject', url: publicAssetUrl('/assets/images/logo.JPG') },
        },
        mainEntityOfPage: canonical,
        image: postImages.length ? postImages : [image],
        isPartOf: { '@type': 'WebApplication', name: 'FA Community', url: publicPageUrl('/community') },
        interactionStatistic: [
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: Number(post.likes_count || 0) },
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: Number(post.comments_count || 0) },
          { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ShareAction', userInteractionCount: Number(post.reposts_count || 0) },
        ],
      },
    }));
  } catch (e) {
    console.error('[GET /share/post/:id]', e);
    setShareResponseHeaders(res, 'public, max-age=60, s-maxage=300');
    res.status(500).type('html').send(renderShareNotFound('Post temporariamente indisponivel | Forca Aliada', 'Nao foi possivel carregar este post agora.'));
  }
});

app.get('/share/profile/:identifier', async (req, res) => {
  try {
    const payload = await loadPublicProfile(req.params.identifier);
    const profile = payload?.profile;
    if (!profile) {
      setShareResponseHeaders(res, 'public, max-age=60, s-maxage=300');
      return res.status(404).type('html').send(renderShareNotFound('Perfil indisponivel | Forca Aliada', 'Este perfil nao existe ou foi definido como privado.'));
    }
    const name = profile.display_name || profile.minecraft_name || profile.username || 'Jogador';
    const description = plainText(profile.bio, 240) || `${name} e jogador da comunidade Minecraft Forca Aliada, com ${Number(profile.followers_count || 0)} seguidores e ${Number(profile.posts_count || 0)} posts publicos.`;
    const skinImage = profile.minecraft_name ? `https://minotar.net/avatar/${encodeURIComponent(profile.minecraft_name)}/300` : '';
    const image = absolutePublicUrl(profile.avatar_url) || absolutePublicUrl(profile.photo_url) || skinImage || publicAssetUrl('/assets/images/og-image.jpg');
    const identifier = profile.minecraft_name || profile.username || `id:${profile.id}`;
    const canonical = publicSharePageUrl(req, `/share/profile/${encodeURIComponent(identifier)}`);
    const redirectUrl = publicPageUrl(`/profile?id=${encodeURIComponent(identifier)}`);
    const profileLinks = Array.isArray(profile.profile_links)
      ? profile.profile_links.map(link => absolutePublicUrl(link?.url || link)).filter(Boolean).slice(0, 8)
      : [];
    const stats = `<div class="stats"><span class="stat">Rank ${htmlEscape(profile.rank || 'Ferro')}</span><span class="stat">${Number(profile.merit || 0)} de merito</span><span class="stat">${Number(profile.followers_count || 0)} seguidores</span><span class="stat">${Number(profile.posts_count || 0)} posts</span></div>`;
    setShareResponseHeaders(res, 'public, max-age=1800, s-maxage=43200, stale-while-revalidate=604800');
    res.type('html').send(renderShareHtml({
      title: `${name} | Perfil Forca Aliada`,
      description,
      image,
      canonical,
      redirectUrl,
      type: 'profile',
      breadcrumbs: [
        { name: 'Inicio', url: publicPageUrl('/') },
        { name: 'Comunidade', url: publicPageUrl('/community') },
        { name, url: canonical },
      ],
      extraContent: `${stats}${renderPublicPostList(payload.posts, `Posts recentes de ${name}`)}`,
      primaryActionLabel: `Ver perfil completo de ${name}`,
      additionalLinks: [
        { label: 'Conheca o servidor', url: publicPageUrl('/') },
        { label: 'Leia o guia', url: publicPageUrl('/guia') },
        { label: 'Explore a comunidade', url: publicPageUrl('/community') },
      ],
      jsonLd: {
        '@type': 'ProfilePage',
        '@id': canonical,
        url: canonical,
        inLanguage: 'pt-BR',
        dateCreated: profile.created_at,
        mainEntityOfPage: canonical,
        mainEntity: {
          '@type': 'Person',
          name,
          alternateName: profile.username ? `@${profile.username}` : undefined,
          description,
          image,
          url: canonical,
          sameAs: profileLinks,
          interactionStatistic: [
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: Number(profile.followers_count || 0) },
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CreateAction', userInteractionCount: Number(profile.posts_count || 0) },
          ],
        },
      },
    }));
  } catch (e) {
    console.error('[GET /share/profile/:identifier]', e);
    setShareResponseHeaders(res, 'public, max-age=60, s-maxage=300');
    res.status(500).type('html').send(renderShareNotFound('Perfil temporariamente indisponivel | Forca Aliada', 'Nao foi possivel carregar este perfil agora.'));
  }
});

app.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /share/post/',
    'Allow: /share/profile/',
    'Disallow: /api/',
    'Disallow: /admin/',
    'Disallow: /oauth/',
    'Disallow: /sitemap',
    '',
  ].join('\n'));
});

const SITEMAP_POST_PAGE_SIZE = 5000;
const PUBLIC_POST_QUALITY_SQL = `
  p.repost_of_id IS NULL
  AND COALESCE(up.public_profile, TRUE) = TRUE
  AND (
    array_length(p.media_urls, 1) > 0
    OR length(trim(COALESCE(p.content, ''))) >= 40
    OR (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) +
       (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE) >= 5
  )
`;

function sitemapDocument(items = []) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${items.map(item => `<url><loc>${htmlEscape(item.loc)}</loc><lastmod>${isoDate(item.lastmod)}</lastmod><changefreq>${item.changefreq || 'weekly'}</changefreq><priority>${item.priority || '0.6'}</priority>${(item.images || []).map(imageUrl => `<image:image><image:loc>${htmlEscape(imageUrl)}</image:loc></image:image>`).join('')}</url>`).join('\n')}
</urlset>`;
}

function sendSitemapError(res, label, error) {
  console.error(`[GET ${label}]`, error);
  res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
}

app.get('/sitemap.xml', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM user_posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE ${PUBLIC_POST_QUALITY_SQL}
    `);
    const postPages = Math.max(1, Math.ceil(Number(rows[0]?.count || 0) / SITEMAP_POST_PAGE_SIZE));
    const sitemaps = [
      publicSharePageUrl(req, '/sitemap-pages.xml'),
      publicSharePageUrl(req, '/sitemap-profiles.xml'),
      ...Array.from({ length: postPages }, (_, index) => publicSharePageUrl(req, `/sitemap-posts-page-${index + 1}.xml`)),
    ];
    res.set('Cache-Control', 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map(loc => `<sitemap><loc>${htmlEscape(loc)}</loc><lastmod>${isoDate()}</lastmod></sitemap>`).join('\n')}
</sitemapindex>`);
  } catch (e) {
    sendSitemapError(res, '/sitemap.xml', e);
  }
});

app.get('/sitemap-pages.xml', (req, res) => {
  const today = isoDate();
  const pages = [
    { loc: publicPageUrl('/'), lastmod: today, changefreq: 'daily', priority: '1.0', images: [publicAssetUrl('/assets/images/hero.webp')] },
    { loc: publicPageUrl('/guia'), lastmod: today, changefreq: 'weekly', priority: '0.9', images: [publicAssetUrl('/assets/images/og-image.jpg')] },
    { loc: publicPageUrl('/community'), lastmod: today, changefreq: 'daily', priority: '0.8' },
    { loc: publicPageUrl('/termos'), lastmod: today, changefreq: 'yearly', priority: '0.3' },
    { loc: publicPageUrl('/privacidade'), lastmod: today, changefreq: 'yearly', priority: '0.3' },
  ];
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  res.type('application/xml').send(sitemapDocument(pages));
});

app.get('/sitemap-profiles.xml', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, COALESCE(up.avatar_url, '') AS avatar_url,
             COALESCE(up.updated_at, u.created_at) AS updated_at
      FROM users u
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE COALESCE(up.public_profile, TRUE) = TRUE
      ORDER BY updated_at DESC
      LIMIT 50000
    `);
    const items = rows.map(row => {
      const identifier = row.minecraft_name || row.username || `id:${row.id}`;
      const avatar = absolutePublicUrl(row.avatar_url) || absolutePublicUrl(row.photo_url);
      return {
        loc: publicSharePageUrl(req, `/share/profile/${encodeURIComponent(identifier)}`),
        lastmod: row.updated_at,
        changefreq: 'weekly',
        priority: '0.7',
        images: avatar ? [avatar] : [],
      };
    });
    res.set('Cache-Control', 'public, max-age=1800, s-maxage=43200, stale-while-revalidate=86400');
    res.type('application/xml').send(sitemapDocument(items));
  } catch (e) {
    sendSitemapError(res, '/sitemap-profiles.xml', e);
  }
});

async function postsSitemapHandler(req, res) {
  const page = Math.max(1, Number(req.params.page || 1));
  const offset = (page - 1) * SITEMAP_POST_PAGE_SIZE;
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.media_urls, COALESCE(p.updated_at, p.created_at) AS updated_at,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count
      FROM user_posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE ${PUBLIC_POST_QUALITY_SQL}
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [SITEMAP_POST_PAGE_SIZE, offset]);
    const items = rows.map(row => {
      const engagement = Number(row.likes_count || 0) + Number(row.comments_count || 0);
      return {
        loc: publicSharePageUrl(req, `/share/post/${encodeURIComponent(row.id)}`),
        lastmod: row.updated_at,
        changefreq: engagement >= 10 ? 'daily' : 'weekly',
        priority: engagement >= 10 ? '0.8' : '0.6',
        images: (row.media_urls || []).map(absolutePublicUrl).filter(Boolean).slice(0, 10),
      };
    });
    res.set('Cache-Control', 'public, max-age=900, s-maxage=21600, stale-while-revalidate=86400');
    res.type('application/xml').send(sitemapDocument(items));
  } catch (e) {
    sendSitemapError(res, '/sitemap-posts.xml', e);
  }
}

app.get('/sitemap-posts.xml', postsSitemapHandler);
app.get('/sitemap-posts-page-:page.xml', postsSitemapHandler);

async function createSocialNotification({ recipientId, actorId, type, entityType = null, entityId = null, previewText = '' }, db = pool) {
  const recipient = Number(recipientId);
  const actor = actorId ? Number(actorId) : null;
  if (!recipient || !actor || recipient === actor || !SOCIAL_NOTIFICATION_TYPES.has(type)) return null;

  const { rows: blocked } = await db.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id=$1 AND blocked_id=$2)
        OR (blocker_id=$2 AND blocked_id=$1)
     LIMIT 1`,
    [recipient, actor],
  );
  if (blocked.length) return null;

  const preview = sanitizeText(previewText || '').slice(0, 120);
  const groupable = new Set(['post_like', 'repost', 'comment_like']);
  if (groupable.has(type) && entityId) {
    const { rows: refreshed } = await db.query(
      `UPDATE social_notifications
       SET actor_id=$2,
           actor_ids=CASE
             WHEN COALESCE(actor_ids,'[]'::jsonb) @> jsonb_build_array($2::integer) THEN COALESCE(actor_ids,'[]'::jsonb)
             ELSE COALESCE(actor_ids,'[]'::jsonb) || jsonb_build_array($2::integer)
           END,
           group_count=CASE
             WHEN COALESCE(actor_ids,'[]'::jsonb) @> jsonb_build_array($2::integer) THEN COALESCE(group_count,1)
             ELSE COALESCE(group_count,1) + 1
           END,
           preview_text=$6,
           is_read=FALSE,
           created_at=NOW()
       WHERE id=(
         SELECT id FROM social_notifications
         WHERE recipient_id=$1
           AND type=$3
           AND COALESCE(entity_type,'')=COALESCE($4,'')
           AND COALESCE(entity_id,0)=COALESCE($5,0)
         ORDER BY created_at DESC
         LIMIT 1
       )
       RETURNING id,group_count`,
      [recipient, actor, type, entityType, entityId, preview],
    );
    if (refreshed.length) {
      setTimeout(() => emitCommunityEvent('notification', { recipientId: recipient, notificationId: refreshed[0].id, type }), 350);
      return { ...refreshed[0], refreshed: true };
    }
  }

  const { rows } = await db.query(
    `INSERT INTO social_notifications(recipient_id, actor_id, type, entity_type, entity_id, preview_text, actor_ids)
     VALUES($1,$2,$3,$4,$5,$6,jsonb_build_array($2::integer))
     RETURNING id`,
    [recipient, actor, type, entityType, entityId, preview],
  );
  if (rows[0]) setTimeout(() => emitCommunityEvent('notification', { recipientId: recipient, notificationId: rows[0].id, type }), 350);
  return rows[0] || null;
}

async function notifyProfileSubscribers({
  creatorId,
  type,
  entityType = null,
  entityId = null,
  previewText = '',
  allOnly = false,
}) {
  const creator = Number(creatorId);
  if (!creator || !SOCIAL_NOTIFICATION_TYPES.has(type)) return [];
  const { rows } = await pool.query(
    `SELECT f.follower_id AS recipient_id
     FROM user_follows f
     LEFT JOIN profile_notification_preferences p
       ON p.subscriber_id=f.follower_id AND p.creator_id=f.following_id
     WHERE f.following_id=$1
       AND COALESCE(p.level,'off') <> 'off'
       AND ($2::boolean = FALSE OR COALESCE(p.level,'off') = 'all')`,
    [creator, Boolean(allOnly)],
  );
  return Promise.allSettled(rows.map(row => createSocialNotification({
    recipientId: row.recipient_id,
    actorId: creator,
    type,
    entityType,
    entityId,
    previewText,
  })));
}

let optionalTxSeq = 0;
async function optionalTransactionStep(client, label, fn) {
  const savepoint = `optional_step_${++optionalTxSeq}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
    await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
    console.warn(`[${label} skipped]`, err?.message || err);
    return null;
  }
}

async function assertNoSocialBlock(viewerId, targetId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id=$1 AND blocked_id=$2)
        OR (blocker_id=$2 AND blocked_id=$1)
     LIMIT 1`,
    [viewerId, targetId],
  );
  return rows.length === 0;
}

function directPair(userId, targetId) {
  const a = Number(userId);
  const b = Number(targetId);
  return a < b ? [a, b] : [b, a];
}

function directConversationSelect(extraWhere = '') {
  return `
    SELECT c.id, c.created_at, c.last_message_at AS conversation_last_message_at,
           other_u.id AS other_id,
           other_u.username AS other_username,
           other_u.minecraft_name AS other_minecraft_name,
           other_u.photo_url AS other_photo_url,
           other_u.is_platform_verified,
           ${socialRankSql('other_u', 'pb')} AS other_rank,
           COALESCE(pb.merit_total, 0) AS other_merit,
           EXISTS(SELECT 1 FROM user_follows f1
                  JOIN user_follows f2 ON f2.follower_id = other_u.id AND f2.following_id = $1
                  WHERE f1.follower_id = $1 AND f1.following_id = other_u.id) AS is_friend,
           last_msg.id AS last_message_id,
           last_msg.body AS last_message_body,
           COALESCE(last_msg.attachments, '[]'::jsonb) AS last_message_attachments,
           last_msg.sender_id AS last_message_sender_id,
           last_msg.created_at AS last_message_at,
           COALESCE(unread.count, 0)::int AS unread_count
    FROM direct_conversations c
    JOIN users other_u ON other_u.id = CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END
    LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(other_u.minecraft_name)
    LEFT JOIN LATERAL (
      SELECT id, body, attachments, sender_id, created_at
      FROM direct_messages
      WHERE conversation_id = c.id AND is_deleted = FALSE
      ORDER BY id DESC
      LIMIT 1
    ) last_msg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS count
      FROM direct_messages dm
      LEFT JOIN direct_conversation_reads dcr ON dcr.conversation_id = c.id AND dcr.user_id = $1
      WHERE dm.conversation_id = c.id
        AND dm.sender_id != $1
        AND dm.is_deleted = FALSE
        AND dm.created_at > COALESCE(dcr.last_read_at, 'epoch'::timestamptz)
    ) unread ON TRUE
    WHERE (c.participant_a = $1 OR c.participant_b = $1)
      ${extraWhere}
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id = $1 AND ub.blocked_id = other_u.id)
           OR (ub.blocker_id = other_u.id AND ub.blocked_id = $1)
      )
  `;
}

// ─────────────────────────────────────────────

// ── Session token validation cache (60s TTL) for auth middleware ──────────────
const _sessionCache = new Map(); // tokenHash → { valid: bool, expiresAt: number }
const SESSION_CACHE_TTL_MS = 60_000;
function getCachedSession(tokenHash) {
  const entry = _sessionCache.get(tokenHash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _sessionCache.delete(tokenHash); return null; }
  return entry.valid;
}
function setCachedSession(tokenHash, valid) {
  _sessionCache.set(tokenHash, { valid, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  // Housekeeping: clear expired entries periodically
  if (_sessionCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _sessionCache) { if (v.expiresAt < now) _sessionCache.delete(k); }
  }
}
function invalidateSessionCache(tokenHash) { _sessionCache.delete(tokenHash); }

// Auth middleware
// ─────────────────────────────────────────────
async function auth(req, res, next) {
const token = (req.headers.authorization || '').replace('Bearer ', '');
if (!token) return res.status(401).json({ error: 'missing token' });
try {
const decoded = jwt.verify(token, JWT_SECRET);
const { rows } = await pool.query(
'SELECT id, role, is_verified, minecraft_name, username FROM users WHERE id=$1',
[decoded.sub],
);
if (!rows.length) return res.status(401).json({ error: 'user deleted' });

// [SEC-03] Verify token is not revoked (with in-memory cache to avoid DB hit per request)
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const cached = getCachedSession(tokenHash);
if (cached === false) return res.status(401).json({ error: 'session revoked' });
if (cached === null) {
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM user_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked=FALSE LIMIT 1',
    [tokenHash, rows[0].id],
  );
  const valid = sessionRows.length > 0;
  setCachedSession(tokenHash, valid);
  if (!valid) return res.status(401).json({ error: 'session revoked' });
}

req.user = rows[0];
req.user.sub = rows[0].id;
next();
} catch { res.status(401).json({ error: 'invalid token' }); }
}

function requireAdmin(req, res, next) {
if (!['full', 'owner'].includes(req.user?.role))
return res.status(403).json({ error: 'forbidden' });
next();
}

function requireOwner(req, res, next) {
if (req.user?.role !== 'owner')
return res.status(403).json({ error: 'forbidden' });
next();
}

// ─────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────
const healthHandler = (_req, res) => res.json({
  ok: true,
  startedAt: PROCESS_STARTED_AT.toISOString(),
  uptimeSeconds: Math.floor(process.uptime()),
  build: String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 12) || null,
  database: dbStartupState.ready
    ? { status: 'ready', readyAt: dbStartupState.readyAt }
    : dbStartupState.lastError
      ? { status: 'unavailable', lastAttemptAt: dbStartupState.lastAttemptAt, error: dbStartupState.lastError }
      : { status: 'starting' },
});
app.get('/healthz', healthHandler);
app.get('/api/healthz', healthHandler);

// Admin-only health endpoint with detailed diagnostics
app.get('/admin/health', auth, requireAdmin, (_req, res) => res.json({
  ok: true,
  startedAt: PROCESS_STARTED_AT.toISOString(),
  uptimeSeconds: Math.floor(process.uptime()),
  database: dbStartupState.ready
    ? { status: 'ready', readyAt: dbStartupState.readyAt }
    : dbStartupState.lastError
      ? { status: 'unavailable', lastAttemptAt: dbStartupState.lastAttemptAt, error: dbStartupState.lastError }
      : { status: 'starting' },
  mc_state: _mcState,
  cloud_lockout: { active: _cloudLockout.active, since: _cloudLockout.since || null },
  app_connected: isAppConnectedInMemory(),
  tcpshield_detection: {
    query_enabled: process.env.MC_QUERY_DISABLED !== 'true',
    offline_motd_configured: Boolean(process.env.MC_OFFLINE_MOTD),
  },
}));

// ── Keep-alive público (usado pelo GitHub Actions para evitar cold start) ──
app.get('/ping', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ pong: true, ts: Date.now() });
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Minecraft Status — Híbrido com detecção de TCPShield
// ─────────────────────────────────────────────
//
// Fluxo de decisão:
//
//  1. Se _mcState é confiável e diz 'offline' → retorna offline sem ping
//     (evita falso positivo do TCPShield após shutdown sinalizado pelo app)
//
//  2. Tenta UDP Query (bypassa TCPShield completamente).
//     Se responder → online real confirmado.
//     Requer enable-query=true no server.properties. Desativar com MC_QUERY_DISABLED=true.
//
//  3. Tenta ping TCP de status (sem SRV, depois com SRV como fallback).
//
//  4. Analisa o resultado do ping com 3 heurísticas de detecção de TCPShield:
//
//     Heurística A — players.max === 0 (sinal mais forte e mais confiável):
//       Um servidor Minecraft REAL nunca reporta max=0.
//       O TCPShield "Offline MOTD" retorna max=0 por não conhecer o backend offline.
//       Se max=0 → TCPShield respondendo → servidor offline.
//       Checa mcstatus.io para confirmar/enriquecer dados antes de declarar offline.
//       Se mcstatus.io também retornar max=0 → offline confirmado.
//       Se mcstatus.io retornar max>0 → servidor online (TCPShield estava enganoso,
//       mas o servidor real está acessível de outro datacenter).
//
//     Heurística B — latência < 5ms sem sample list:
//       TCPShield sem "Offline MOTD" responde do cache local em <1ms.
//       Um servidor real tem RTT mínimo de ~5ms mesmo na mesma LAN.
//
//     Heurística C — MOTD corresponde a MC_OFFLINE_MOTD (env var):
//       Compara o MOTD retornado com o texto configurado no TCPShield.
//
//  5. Se ping TCP falha completamente → tenta mcstatus.io (com verificação de max=0)
//     → Se tudo falha → offline

async function fetchMinecraftStatus() {
  const dashboardSettings = await getRuntimeDashboardSettings();
  const host          = dashboardSettings.server_ip || process.env.MC_HOST || 'fa.ogabriels.com';
  const queryPort     = parseInt(dashboardSettings.server_port || process.env.MC_QUERY_PORT || '25565');
  const queryDisabled = process.env.MC_QUERY_DISABLED === 'true';
  const offlineMotd   = (process.env.MC_OFFLINE_MOTD || '').trim().toLowerCase();

  // ── Passo 1: verificar máquina de estados ────────────────────────────────
  // Se o app sinalizou shutdown E ainda não expirou o período de recheck,
  // retorna offline sem nem tentar o ping.
  if (isMcStateTrustworthy() && _mcState.state === 'offline') {
    return {
      host, checkedAt: new Date(), online: false,
      version: null, players: { online: 0, max: 0, list: [] },
      latencyMs: null, raw: null, source: 'state_machine',
    };
  }

  // ── Passo 2: UDP Query — bypassa TCPShield completamente ─────────────────
  // O TCPShield não proxeia UDP. Uma resposta aqui = servidor real online.
  // Requer enable-query=true no server.properties.
  if (!queryDisabled) {
    try {
      const qStart = Date.now();
      const qResult = await util.queryFull(host, queryPort, { timeout: 2500, enableSRV: false });
      const qLatency = Date.now() - qStart;
      // Resposta UDP recebida — servidor definitivamente online
      if (_mcState.state !== 'online') setMcState('online', 'ping');
      return {
        host, checkedAt: new Date(), online: true,
        version: qResult.version || null,
        players: {
          online: qResult.players?.online || 0,
          max:    qResult.players?.max    || 0,
          list:   (qResult.players?.list  || []).filter(Boolean),
        },
        latencyMs: qLatency,
        raw: qResult, source: 'udp_query',
      };
    } catch (_qErr) {
      // UDP falhou — pode ser: servidor offline, query desabilitado, ou firewall.
      // Não concluímos offline aqui; continuamos com TCP + heurísticas.
    }
  }

  // ── Passo 3: ping TCP direto ──────────────────────────────────────────────
  const started = Date.now();
  let result    = null;
  let latencyMs = null;
  let pingFailed = false;

  try {
    result = await util.status(host, queryPort, { timeout: 3000, enableSRV: false });
    latencyMs = Math.max(0, Date.now() - started);
  } catch (_err1) {
    try {
      const srvStart = Date.now();
      result = await util.status(host, queryPort, { timeout: 3000, enableSRV: true });
      latencyMs = Math.max(0, Date.now() - srvStart);
    } catch (_err2) {
      pingFailed = true;
    }
  }

  // ── Passo 4: análise do resultado do ping TCP ─────────────────────────────
  if (result && !pingFailed) {
    const reportedOnline = Number(result.players?.online || 0);
    const hasSample      = (result.players?.sample || []).length > 0;
    const isFastPing     = latencyMs < TCPSHIELD_MIN_LATENCY_MS;

    // Confirmação positiva imediata: se há jogadores reportados, é real.
    // (TCPShield Offline MOTD sempre retorna 0 jogadores)
    if (reportedOnline > 0) {
      if (_mcState.state !== 'online') setMcState('online', 'ping');
      const onlinePlayers = (result.players?.sample || [])
        .map(p => p.name).filter(n => Boolean(n) && n !== 'Anonymous Player');
      return {
        host, checkedAt: new Date(), online: true,
        version: result.version?.name || null,
        players: { online: reportedOnline, max: Number(result.players?.max || 0), list: onlinePlayers },
        latencyMs: result.roundTripLatency || latencyMs,
        raw: result, source: 'ping',
      };
    }

    // 0 jogadores reportados — pode ser TCPShield Offline MOTD ou servidor vazio real.
    // Aplicamos heurísticas em cascata, em ordem de confiança:
    const reportedMax = Number(result.players?.max || 0);

    // Heurística A — max = 0 (sinal mais forte, exclusivo do TCPShield):
    //   Um servidor Minecraft REAL nunca reporta max=0. Mesmo vazio, reporta max=N
    //   conforme configurado no server.properties (ex: 20, 100, 250).
    //   O TCPShield "Offline MOTD" retorna max=0 porque não tem como saber o
    //   valor real do backend offline. Este sinal sozinho já é suficiente.
    const maxIsZero = reportedMax === 0;

    // Heurística B: latência sub-5ms (TCPShield sem Offline MOTD — cache local)
    const stateOffline   = _mcState.state === 'offline' && _mcState.setBy === 'app_signal';
    const latencySuspect = isFastPing && !hasSample;

    // Heurística C: MOTD bate com o Offline MOTD configurado (MC_OFFLINE_MOTD env)
    let motdSuspect = false;
    if (offlineMotd) {
      const returnedMotd = (
        result.motd?.clean ||
        result.description?.text ||
        result.description ||
        ''
      ).toString().trim().toLowerCase();
      motdSuspect = returnedMotd.length > 0 && (returnedMotd === offlineMotd || returnedMotd.includes(offlineMotd));
    }

    const tcpShieldSuspect = maxIsZero || latencySuspect || motdSuspect || stateOffline;

    if (tcpShieldSuspect) {
      // Segunda opinião: mcstatus.io consulta de datacenter diferente.
      try {
        const apiRes = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(host)}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (apiRes.ok) {
          const data = await apiRes.json();
          const extMax    = Number(data.players?.max    || 0);
          const extOnline = Number(data.players?.online || 0);

          if (!data.online) {
            setMcState('offline', 'ping');
            return {
              host, checkedAt: new Date(), online: false,
              version: null, players: { online: 0, max: 0, list: [] },
              latencyMs: null, raw: data, source: 'mcstatus_confirmed_offline',
            };
          }

          // mcstatus.io diz online — mas se max=0, o TCPShield também enganou o mcstatus.io.
          // max=0 em QUALQUER fonte → offline.
          if (extMax === 0) {
            setMcState('offline', 'ping');
            return {
              host, checkedAt: new Date(), online: false,
              version: null, players: { online: 0, max: 0, list: [] },
              latencyMs: null, raw: data, source: 'tcpshield_max_zero_confirmed',
            };
          }

          // mcstatus.io retornou max > 0 → servidor real online (pode estar vazio)
          if (_mcState.state !== 'online') setMcState('online', 'ping');
          const list = (data.players?.list || []).map(p => p.name_raw || p.name).filter(Boolean);
          return {
            host, checkedAt: new Date(), online: true,
            version: data.version?.name_raw || data.version?.name || null,
            players: { online: extOnline, max: extMax, list },
            latencyMs: data.latency || latencyMs,
            raw: data, source: extOnline > 0 ? 'mcstatus_online' : 'mcstatus_empty_online',
          };
        }
      } catch (_apiErr) {
        // mcstatus.io inacessível — decidimos pelos sinais locais
        if (maxIsZero || stateOffline || motdSuspect) {
          // Sinais fortes o suficiente mesmo sem mcstatus.io
          if (stateOffline) {
            return {
              host, checkedAt: new Date(), online: false,
              version: null, players: { online: 0, max: 0, list: [] },
              latencyMs: null, raw: null, source: 'state_machine_fallback',
            };
          }
          setMcState('offline', 'ping');
          return {
            host, checkedAt: new Date(), online: false,
            version: null, players: { online: 0, max: 0, list: [] },
            latencyMs: null, raw: null,
            source: maxIsZero ? 'tcpshield_max_zero_fallback' : 'offline_motd_match_fallback',
          };
        }
        // latencySuspect apenas, sem mcstatus.io → benefício da dúvida → online
      }
    }

    // Sem suspeita de TCPShield (max > 0, latência real, MOTD não bate, app não sinalizou)
    // → servidor online real, possivelmente vazio
    const onlinePlayers = (result.players?.sample || [])
      .map(p => p.name).filter(n => Boolean(n) && n !== 'Anonymous Player');
    if (_mcState.state !== 'online') setMcState('online', 'ping');
    return {
      host, checkedAt: new Date(), online: true,
      version: result.version?.name || null,
      players: {
        online: reportedOnline,
        max:    reportedMax,
        list:   onlinePlayers,
      },
      latencyMs: result.roundTripLatency || latencyMs,
      raw: result, source: 'ping',
    };
  }

  // ── Passo 5: ping TCP falhou completamente — tenta mcstatus.io ───────────
  try {
    const apiRes = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(host)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!apiRes.ok) throw new Error('mcstatus.io HTTP ' + apiRes.status);
    const data = await apiRes.json();

    if (!data.online) {
      setMcState('offline', 'ping');
      return {
        host, checkedAt: new Date(), online: false,
        version: null, players: { online: 0, max: 0, list: [] },
        latencyMs: null, raw: data, source: 'mcstatus_offline',
      };
    }

    // TCP falhou mas mcstatus.io respondeu — ainda assim checar max=0
    // (TCPShield pode ter enganado o mcstatus.io com Offline MOTD)
    const extMaxFallback = Number(data.players?.max || 0);
    if (extMaxFallback === 0) {
      setMcState('offline', 'ping');
      return {
        host, checkedAt: new Date(), online: false,
        version: null, players: { online: 0, max: 0, list: [] },
        latencyMs: null, raw: data, source: 'tcpshield_max_zero_mcstatus',
      };
    }

    const onlinePlayers = (data.players?.list || []).map(p => p.name_raw || p.name).filter(Boolean);
    if (_mcState.state !== 'online') setMcState('online', 'ping');
    return {
      host, checkedAt: new Date(), online: true,
      version: data.version?.name_raw || data.version?.name || null,
      players: { online: data.players?.online || 0, max: extMaxFallback, list: onlinePlayers },
      latencyMs: data.latency || null,
      raw: data, source: 'mcstatus_online',
    };
  } catch (_err3) {
    console.warn('[mc-status] Todas as tentativas falharam');
    setMcState('offline', 'ping');
    return {
      host, checkedAt: new Date(), online: false,
      version: null, players: { online: 0, max: 0, list: [] },
      latencyMs: null, raw: null, source: 'failed',
    };
  }
}

async function fetchMinecraftStatusCached() {
  const now = Date.now();
  if (_mcStatusCache.data && now < _mcStatusCache.expiresAt) {
    return _mcStatusCache.data;
  }
  const fresh = await fetchMinecraftStatus();
  const dashboardSettings = await getRuntimeDashboardSettings();
  if (dashboardSettings.max_players) fresh.players.max = Number(dashboardSettings.max_players);
  _mcStatusCache.data      = fresh;
  _mcStatusCache.expiresAt = now + MC_STATUS_TTL_MS;
  return fresh;
}

async function recordServerStatus(status) {
  await pool.query(
    'INSERT INTO server_status_checks(host, online, players_online, players_max, latency_ms, version, checked_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [status.host, status.online, status.players.online, status.players.max, status.latencyMs, status.version, status.checkedAt],
  );
}

async function getServerStatusStats(host, currentOnline) {
  const { rows: uptimeRows } = await pool.query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN online THEN 1 ELSE 0 END), 0)::int AS online
     FROM server_status_checks
     WHERE host=$1 AND checked_at >= NOW() - INTERVAL '24 hours'`,
    [host],
  );
  const total = uptimeRows[0]?.total || 0;
  const uptime24hPct = total > 0 ? Math.round(((uptimeRows[0].online || 0) / total) * 100) : (currentOnline ? 100 : 0);

  let onlineSince = null;
  if (currentOnline) {
    const { rows: offlineRows } = await pool.query(
      'SELECT checked_at FROM server_status_checks WHERE host=$1 AND online=FALSE ORDER BY checked_at DESC LIMIT 1',
      [host],
    );
    const params = offlineRows.length ? [host, offlineRows[0].checked_at] : [host];
    const query = offlineRows.length
      ? 'SELECT MIN(checked_at) AS since FROM server_status_checks WHERE host=$1 AND online=TRUE AND checked_at > $2'
      : 'SELECT MIN(checked_at) AS since FROM server_status_checks WHERE host=$1 AND online=TRUE';
    const { rows } = await pool.query(query, params);
    onlineSince = rows[0]?.since || null;
  }

  return { uptime24hPct, onlineSince, samples24h: total };
}

app.get('/api/server/status', auth, requireAdmin, async (_req, res) => {
  const runtimeSettings = await getRuntimeDashboardSettings();
  const host = runtimeSettings.server_ip || process.env.MC_HOST || 'fa.ogabriels.com';
  try {
    const status = await fetchMinecraftStatusCached();
    await recordServerStatus(status);

    // --- SISTEMA DE AUTO-CURA (MASTER/SLAVE) ---
    // Usa heartbeat em memória: se o app mandou sinal nos últimos 30s, ele é o master
    const appConnected = isAppConnectedInMemory();

    if (!appConnected) {
      // Site assume controle — reconcilia sessões abertas com o que o MC reporta
      const now = status.checkedAt;
      const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');

      if (!status.online) {
        // Servidor offline e app não está conectado: fecha TODAS as sessões abertas
        for (const row of active.rows) {
          const dur = (now - new Date(row.entered_at)) / 3600000;
          await pool.query(
            'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
            [now, +dur.toFixed(2), row.player]
          );
        }
      } else {
        const onlinePlayers = status.players.list;
        const reportedCount = status.players.online;
        const isProxyHidingNames = reportedCount > 0 && onlinePlayers.length === 0;

        if (!isProxyHidingNames) {
          // Fecha sessões de quem não aparece mais na lista
          for (const row of active.rows) {
            if (!onlinePlayers.includes(row.player)) {
              const dur = (now - new Date(row.entered_at)) / 3600000;
              await pool.query(
                'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
                [now, +dur.toFixed(2), row.player]
              );
            }
          }
          // Abre sessões de novos jogadores detectados pelo site
          for (const p of onlinePlayers) {
            const already = active.rows.some(r => r.player === p);
            if (!already) {
              await pool.query(
                "INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'site')",
                [p, now]
              );
            }
          }
        }
      }
    }
    // Se o App está conectado (heartbeat recente), o site não faz nada — evita duplicados

    const stats = await getServerStatusStats(status.host, status.online);
    return res.json({
      checked_at: status.checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      app_connected: appConnected,
      app_last_seen: _appHeartbeat.lastSeenAt ? new Date(_appHeartbeat.lastSeenAt).toISOString() : null,
      // Estado da máquina de estados — para o dashboard mostrar modo nuvem corretamente
      mc_state: {
        state:  _mcState.state,   // 'unknown' | 'offline' | 'online'
        set_by: _mcState.setBy,   // 'app_signal' | 'ping' | 'init' | 'timeout'
        set_at: _mcState.setAt ? new Date(_mcState.setAt).toISOString() : null,
      },
      // cloud_mode: true quando o site opera sem o app (ping autônomo a cada 1 min)
      cloud_mode: !appConnected,
      maintenance_message: runtimeSettings.maintenance_message || '',
      whitelist_enabled: runtimeSettings.whitelist_enabled !== false,
      minecraft: {
        host: status.host, online: status.online, version: status.version,
        players: { online: status.players.online, max: status.players.max, list: status.players.list },
        latencyMs: status.latencyMs, onlineSince: stats.onlineSince, uptime24hPct: stats.uptime24hPct, samples24h: stats.samples24h,
        status_source: status.source || 'ping', // 'ping'|'mcstatus_online'|'mcstatus_confirmed_offline'|'state_machine'|'state_machine_fallback'|'failed'
      },
    });
  } catch (err) {
    console.error('[server status]', err);
    const checkedAt = new Date();
    const fallback = { host, checkedAt, online: false, version: null, players: { online: 0, max: 0, list: [] }, latencyMs: null };
    await recordServerStatus(fallback).catch(e => console.error('[server status record]', e));

    const appConnected = isAppConnectedInMemory();
    if (!appConnected) {
      try {
        const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
        for (const row of active.rows) {
          const dur = (checkedAt - new Date(row.entered_at)) / 3600000;
          await pool.query(
            'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
            [checkedAt, +dur.toFixed(2), row.player]
          );
        }
      } catch (e) { console.error('[server status close sessions]', e); }
    }

    const stats = await getServerStatusStats(host, false).catch(() => ({ uptime24hPct: 0, onlineSince: null, samples24h: 0 }));
    return res.json({
      checked_at: checkedAt.toISOString(),
      backend: { startedAt: PROCESS_STARTED_AT.toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
      app_connected: appConnected,
      app_last_seen: _appHeartbeat.lastSeenAt ? new Date(_appHeartbeat.lastSeenAt).toISOString() : null,
      mc_state: {
        state:  _mcState.state,
        set_by: _mcState.setBy,
        set_at: _mcState.setAt ? new Date(_mcState.setAt).toISOString() : null,
      },
      cloud_mode: !appConnected,
      maintenance_message: runtimeSettings.maintenance_message || '',
      whitelist_enabled: runtimeSettings.whitelist_enabled !== false,
      minecraft: { ...fallback, checkedAt: undefined, onlineSince: null, uptime24hPct: stats.uptime24hPct, samples24h: stats.samples24h, status_source: 'failed', error: 'status unavailable' },
    });
  }
});

// ─────────────────────────────────────────────
// CRON e SNAPSHOT
// ─────────────────────────────────────────────
app.get('/api/cron', async (req, res) => {
const key = req.headers['x-ingest-secret'];
if (key !== INGEST_SECRET) return res.status(403).json({ error: 'forbidden' });

try {
  const status = await fetchMinecraftStatusCached();
  await recordServerStatus(status);
  
  // Usa heartbeat em memória — sem bater no banco
  const appConnected = isAppConnectedInMemory();

  if (!appConnected) {
    const now = status.checkedAt;
    const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');

    if (!status.online) {
      // Cron detectou offline e app não está ativa: fecha todas as sessões
      for (const row of active.rows) {
        const dur = (now - new Date(row.entered_at)) / 3600000;
        await pool.query(
          'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
          [now, +dur.toFixed(2), row.player]
        );
      }
    } else {
      const onlinePlayers = status.players.list;
      const reportedCount = status.players.online;
      const isProxyHidingNames = reportedCount > 0 && onlinePlayers.length === 0;

      if (!isProxyHidingNames) {
        for (const row of active.rows) {
          if (!onlinePlayers.includes(row.player)) {
            const dur = (now - new Date(row.entered_at)) / 3600000;
            await pool.query(
              'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
              [now, +dur.toFixed(2), row.player]
            );
          }
        }
        for (const p of onlinePlayers) {
          const already = active.rows.some(r => r.player === p);
          if (!already) {
            await pool.query(
              "INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'site')",
              [p, now]
            );
          }
        }
      }
    }
  }

  await pool.query(`
    UPDATE user_posts p
    SET likes_count = counts.real_count
    FROM (
      SELECT p2.id AS post_id, COUNT(pl.user_id)::int AS real_count
      FROM user_posts p2
      LEFT JOIN post_likes pl ON pl.post_id = p2.id
      GROUP BY p2.id
    ) counts
    WHERE counts.post_id = p.id
      AND p.likes_count IS DISTINCT FROM counts.real_count
  `);

  res.json({ ok: true, app_connected: appConnected, server_online: status.online });
} catch (err) {
  res.status(500).json({ error: 'snapshot failed' });
}
});

// ─────────────────────────────────────────────
// DADOS DO DASHBOARD (Lê a origem)
// ─────────────────────────────────────────────
app.get('/api/snapshots/latest', auth, requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  try {
    const online  = await pool.query(
      'SELECT player, entered_at, origin FROM player_sessions WHERE left_at IS NULL'
    );
    const history = await pool.query(
      'SELECT player, entered_at, left_at, duration_hours, origin FROM player_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT $1',
      [limit]
    );

    res.json({
      onlinePlayers: online.rows.map(r => r.player),
      activeSessions: online.rows.reduce((acc, r) => ({
        ...acc, [r.player]: { name: r.player, enteredAt: r.entered_at, origin: r.origin || 'site' }
      }), {}),
      history: history.rows.map(r => ({
        player: r.player, enteredAt: r.entered_at,
        leftAt: r.left_at, hoursOnline: r.duration_hours,
        origin: r.origin || 'site'
      })),
      app_connected: isAppConnectedInMemory(),
      app_last_seen: _appHeartbeat.lastSeenAt ? new Date(_appHeartbeat.lastSeenAt).toISOString() : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar histórico' });
  }
});

// ─────────────────────────────────────────────
// INTEGRAÇÃO DE APLICATIVO (O PUSH)
// ─────────────────────────────────────────────

// ── Helper: valida a chave do app e retorna { isValid, appKeyId } ──
async function validateAppKey(key) {
  if (!key) return { isValid: false, appKeyId: null };
  if (key === INGEST_SECRET && INGEST_SECRET) return { isValid: true, appKeyId: null };
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const { rows } = await pool.query(
    'UPDATE app_integration_keys SET last_used_at=NOW() WHERE key_hash=$1 RETURNING id, name',
    [keyHash]
  );
  if (!rows.length) return { isValid: false, appKeyId: null };
  return { isValid: true, appKeyId: rows[0].id, keyName: rows[0].name };
}

/**
 * POST /api/app/heartbeat
 * Chamado pelo app a cada 10 segundos para sinalizar que está ativo.
 * Operação leve — só atualiza memória + last_used_at no banco (1 query).
 * Não reconcilia sessões; essa responsabilidade é do /api/app/sync.
 */
app.post('/api/app/heartbeat', async (req, res) => {
  const key = req.headers['x-app-key'] || req.headers['x-ingest-secret'];
  const { isValid, appKeyId, keyName } = await validateAppKey(key).catch(() => ({ isValid: false }));
  if (!isValid) return res.status(403).json({ error: 'Chave inválida ou revogada' });

  const wasDisconnected = !isAppConnectedInMemory();

  // Se o cloud lockout está ativo (shutdown recente), não registramos o heartbeat como
  // "app conectado" — o app está vivo mas o servidor foi explicitamente desligado.
  // O lockout expira em CLOUD_MODE_LOCKOUT_MS ou quando serverStarted:true chegar.
  if (isCloudLockoutActive()) {
    // Respondemos OK para o app não achar que há um problema de rede,
    // mas não atualizamos lastSeenAt — o modo nuvem permanece ativo.
    return res.json({ ok: true, cloud_lockout: true, server_time: new Date().toISOString() });
  }

  _appHeartbeat.lastSeenAt = Date.now();
  if (appKeyId) { _appHeartbeat.keyId = appKeyId; _appHeartbeat.keyName = keyName || null; }

  // Se o app estava desconectado (timeout) e voltou: invalida o cache para que o próximo
  // /api/server/status faça um ping fresco (não retorna dados velhos do período offline).
  // O estado da máquina (_mcState) é mantido — se era 'offline' por sinal do app e ainda
  // está dentro do FORCED_RECHECK_MS, continua sendo respeitado; se expirou, o
  // isMcStateTrustworthy() já teria revertido para 'unknown' automaticamente.
  if (wasDisconnected) {
    console.info(`[heartbeat] App reconectado após timeout (chave: ${_appHeartbeat.keyName || 'fallback'})`);
    _mcStatusCache.data      = null;
    _mcStatusCache.expiresAt = 0;
  }

  res.json({ ok: true, server_time: new Date().toISOString() });
});

/**
 * GET /api/app/whitelist-queue
 * Retorna itens pendentes da fila de whitelist (ainda não entregues ao app).
 * Usado pelo app desktop para buscar novos cadastros mesmo fora do ciclo de sync.
 */
app.get('/api/app/whitelist-queue', async (req, res) => {
  const key = req.headers['x-app-key'] || req.headers['x-ingest-secret'];
  const { isValid, appKeyId } = await validateAppKey(key).catch(() => ({ isValid: false }));
  if (!isValid) return res.status(403).json({ error: 'Chave inválida ou revogada' });

  try {
    const { rows: pending } = await pool.query(
      'SELECT id, minecraft_name, queued_at FROM whitelist_queue WHERE delivered_at IS NULL ORDER BY queued_at ASC LIMIT 50'
    );

    if (pending.length > 0) {
      const ids = pending.map(r => r.id);
      await pool.query(
        `UPDATE whitelist_queue SET delivered_at=NOW(), delivered_by=$1 WHERE id = ANY($2)`,
        [appKeyId, ids]
      );
    }

    res.json({
      ok: true,
      pending: pending.map(r => ({ id: r.id, username: r.minecraft_name, queued_at: r.queued_at })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar fila' });
  }
});

app.post('/api/admin/app-keys', auth, requireOwner, async (req, res) => {
    const name = sanitize(req.body.name || 'Força Aliada Manager PC');
    const rawKey = 'FA-' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    try {
        const { rows } = await pool.query('INSERT INTO app_integration_keys(name, key_hash, created_by) VALUES($1, $2, $3) RETURNING id, name, created_at', [name, keyHash, req.user.sub]);
        await audit({ actorId: req.user.sub, actorName: req.user.username, type: 'create', message: `Chave de Integração para App criada: "${name}"` });
        res.json({ id: rows[0].id, name: rows[0].name, created_at: rows[0].created_at, key: rawKey });
    } catch (err) { res.status(500).json({ error: 'Erro ao gerar chave' }); }
});

app.get('/api/admin/app-keys', auth, requireOwner, async (req, res) => {
    const { rows } = await pool.query(`SELECT k.id, k.name, k.created_at, k.last_used_at, u.username as created_by FROM app_integration_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`);
    res.json(rows);
});

app.delete('/api/admin/app-keys/:id', auth, requireOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id inválido' });
    const { rows } = await pool.query('DELETE FROM app_integration_keys WHERE id=$1 RETURNING name', [id]);
    if (rows.length) await audit({ actorId: req.user.sub, actorName: req.user.username, type: 'delete', message: `Chave de Integração revogada: "${rows[0].name}"` });
    res.json({ ok: true });
});

app.post('/api/app/sync', async (req, res) => {
    const key = req.headers['x-app-key'] || req.headers['x-ingest-secret']; 
    if (!key) return res.status(401).json({ error: 'Chave não fornecida' });

    const { isValid, appKeyId } = await validateAppKey(key).catch(() => ({ isValid: false }));
    if (!isValid) return res.status(403).json({ error: 'Chave inválida ou revogada' });

    // Sync também atualiza o heartbeat em memória (garante que site não interfira durante sync)
    _appHeartbeat.lastSeenAt = Date.now();
    if (appKeyId) _appHeartbeat.keyId = appKeyId;

    try {
        const payload  = req.body?.payload || req.body;
        const online   = (payload?.onlinePlayers || []).filter(Boolean);
        const now      = new Date();

        // ── Sinal de shutdown: app avisou que o servidor foi desligado ──
        // Fecha todas as sessões abertas IMEDIATAMENTE, sem esperar o heartbeat expirar.
        // Ativa o cloud lockout para que heartbeats subsequentes do app não
        // reconectem o modo app antes que o servidor realmente suba de novo.
        if (payload?.serverStopped === true) {
            _appHeartbeat.lastSeenAt = 0; // invalida heartbeat → modo nuvem imediato
            activateCloudLockout();       // bloqueia reconexão via heartbeat por CLOUD_MODE_LOCKOUT_MS
            setMcState('offline', 'app_signal');
            const active = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');
            for (const row of active.rows) {
                const dur = (now - new Date(row.entered_at)) / 3600000;
                await pool.query(
                    'UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL',
                    [now, +dur.toFixed(2), row.player]
                );
            }
            await audit({
                type: 'system', severity: 'info',
                message: 'App sinalizou shutdown do servidor — sessões encerradas, modo nuvem ativado',
                metadata: { sessionsClosed: active.rows.length },
            });
            return res.json({ ok: true, mode: 'cloud', whitelist_add: [] });
        }

        // ── Sinal de startup: app avisou que o servidor subiu ──
        // Libera o cloud lockout: o servidor foi relançado pelo app.
        if (payload?.serverStarted === true) {
            releaseCloudLockout(); // app pode voltar a ser master
            setMcState('online', 'app_signal');
        }

        const active   = await pool.query('SELECT player, entered_at FROM player_sessions WHERE left_at IS NULL');

        for (const row of active.rows) {
            if (!online.includes(row.player)) {
                const dur = (now - new Date(row.entered_at)) / 3600000;
                await pool.query('UPDATE player_sessions SET left_at=$1, duration_hours=$2 WHERE player=$3 AND left_at IS NULL', [now, +dur.toFixed(2), row.player]);
            }
        }

        for (const p of online) {
            const already = active.rows.some(r => r.player === p);
            // A App marca as sessões como 'app'
            if (!already) await pool.query("INSERT INTO player_sessions(player,entered_at,origin) VALUES($1,$2,'app')", [p, now]);
        }

        // ── Whitelist queue: fetch pending items not yet delivered ──
        const { rows: pending } = await pool.query(
          'SELECT id, minecraft_name FROM whitelist_queue WHERE delivered_at IS NULL ORDER BY queued_at ASC LIMIT 50'
        );

        // Mark them delivered atomically
        if (pending.length > 0) {
          const ids = pending.map(r => r.id);
          await pool.query(
            `UPDATE whitelist_queue SET delivered_at=NOW(), delivered_by=$1 WHERE id = ANY($2)`,
            [appKeyId, ids]
          );
        }

        res.json({
          ok: true,
          whitelist_add: pending.map(r => ({ id: r.id, username: r.minecraft_name })),
        });

        await audit({
          type: 'system', severity: 'info',
          message: `App Sync: ${online.length} jogador(es) online registrado(s)${pending.length ? `, ${pending.length} whitelist(s) entregue(s)` : ''}`,
          metadata: {
            onlinePlayers: online,
            serverStarted: payload?.serverStarted || false,
            sessionsOpened: online.filter(p => !active.rows.some(r => r.player === p)).length,
            sessionsClosed: active.rows.filter(r => !online.includes(r.player)).length,
            whitelistDelivered: pending.map(r => r.minecraft_name),
          },
        });
    } catch (err) { res.status(500).json({ error: 'Falha na sincronização' }); }
});


// ─────────────────────────────────────────────
// AUTH – Microsoft / Xbox / Minecraft
// ─────────────────────────────────────────────

async function exchangeMsCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: requireEnv('MS_CLIENT_ID'),
    client_secret: requireEnv('MS_CLIENT_SECRET'),
    code,
    grant_type: 'authorization_code',
    redirect_uri: requireEnv('MS_REDIRECT_URI'),
  });
  const res = await fetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) throw new Error('Falha ao obter token da Microsoft');
  return res.json();
}

async function getXboxLiveToken(msAccessToken) {
  const res = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msAccessToken}` },
      RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT"
    })
  });
  if (!res.ok) throw new Error('Falha na autenticação do Xbox Live');
  return res.json();
}

async function getXSTSToken(xblToken, relyingParty) {
  const res = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: relyingParty, TokenType: "JWT"
    })
  });
  const data = await res.json();
  if (data.XErr === 2148916233) throw new Error('A conta Xbox não foi configurada.');
  if (data.XErr === 2148916238) throw new Error('Conta de criança. Requer aprovação de adulto.');
  if (!res.ok) throw new Error('Falha no XSTS Token');
  return data;
}

async function getMinecraftAccessToken(uhs, xstsToken) {
  const res = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  });
  if (!res.ok) {
    let detail = '';
    try { const d = await res.json(); detail = d?.error || d?.errorMessage || ''; } catch {}
    const hint = detail ? ` (${detail})` : '';
    throw new Error(`Falha na autenticação da Mojang${hint}`);
  }
  return res.json();
}

/**
 * Tenta obter o perfil do Minecraft Java Edition.
 * Retorna null (sem lançar) se a conta não possui Java Edition,
 * permitindo fallback para o fluxo Bedrock/Xbox.
 */
async function tryGetMinecraftJavaProfile(mcAccessToken) {
  try {
    const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { 'Authorization': `Bearer ${mcAccessToken}` }
    });
    if (res.status === 404) return null; // Sem Java Edition — não é um erro fatal
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Busca o Gamertag Xbox do usuário autenticado via token XSTS para xboxlive.com.
 * Usado como identidade principal para contas Bedrock (sem Java Edition).
 */
async function getXboxGamertag(uhs, xstsXboxToken) {
  try {
    const res = await fetch('https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag', {
      headers: {
        'Authorization': `XBL3.0 x=${uhs};${xstsXboxToken}`,
        'x-xbl-contract-version': '2',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const setting = (data?.profileUsers?.[0]?.settings || []).find(s => s.id === 'Gamertag');
    return setting?.value || null;
  } catch {
    return null;
  }
}

function microsoftEditionLabel(edition) {
  return edition === 'bedrock' ? 'Bedrock' : 'Java';
}

async function linkMicrosoftIntegration({ userId, msRefreshToken, xuid, mcUuid, edition, nick, gamertag = null }) {
  const cleanXuid = sanitize(xuid);
  const cleanUuid = sanitize(mcUuid);
  const cleanEdition = edition === 'bedrock' ? 'bedrock' : 'java';
  const cleanNick = sanitize(nick);
  const cleanGamertag = sanitize(gamertag || nick) || null;

  if (!userId || !cleanXuid || !cleanUuid || !cleanNick) {
    throw new Error('Dados Microsoft/Xbox incompletos para vincular a conta.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!userRows[0]) throw new Error('Conta não encontrada para vinculação.');

    const { rows: primaryRows } = await client.query(
      'SELECT id FROM user_integrations WHERE user_id=$1 AND is_primary=TRUE LIMIT 1',
      [userId]
    );

    const { rows: existingRows } = await client.query(
      `SELECT * FROM user_integrations
       WHERE xbox_xuid=$1 OR mc_uuid=$2
       ORDER BY CASE WHEN user_id=$3 THEN 0 ELSE 1 END, updated_at DESC NULLS LAST, id ASC
       LIMIT 1`,
      [cleanXuid, cleanUuid, userId]
    );

    const existing = existingRows[0] || null;
    const previousUserId = existing && Number(existing.user_id) !== Number(userId) ? existing.user_id : null;
    const shouldBePrimary = primaryRows.length === 0 || existing?.is_primary === true;

    if (shouldBePrimary) {
      await client.query('UPDATE user_integrations SET is_primary=FALSE WHERE user_id=$1', [userId]);
    }

    let integration;
    if (existing) {
      const { rows } = await client.query(
        `UPDATE user_integrations
         SET user_id=$1,
             ms_refresh_token=COALESCE($2, ms_refresh_token),
             xbox_xuid=$3,
             mc_uuid=$4,
             mc_edition=$5,
             mc_name=$6,
             xbox_gamertag=$7,
             is_primary=$8,
             updated_at=NOW()
         WHERE id=$9
         RETURNING *`,
        [userId, msRefreshToken || null, cleanXuid, cleanUuid, cleanEdition, cleanNick, cleanGamertag, shouldBePrimary, existing.id]
      );
      integration = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO user_integrations
           (user_id, ms_refresh_token, xbox_xuid, mc_uuid, mc_edition, mc_name, xbox_gamertag, is_primary)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [userId, msRefreshToken || null, cleanXuid, cleanUuid, cleanEdition, cleanNick, cleanGamertag, shouldBePrimary]
      );
      integration = rows[0];
    }

    if (previousUserId) {
      const { rows: oldPrimary } = await client.query(
        'SELECT id FROM user_integrations WHERE user_id=$1 AND is_primary=TRUE LIMIT 1',
        [previousUserId]
      );
      if (!oldPrimary.length) {
        await client.query(
          `UPDATE user_integrations
           SET is_primary=TRUE
           WHERE id = (
             SELECT id FROM user_integrations
             WHERE user_id=$1
             ORDER BY updated_at DESC NULLS LAST, id ASC
             LIMIT 1
           )`,
          [previousUserId]
        );
      }
    }

    if (!userRows[0].minecraft_name || shouldBePrimary) {
      await client.query('UPDATE users SET minecraft_name=$1 WHERE id=$2', [cleanNick, userId]);
      userRows[0].minecraft_name = cleanNick;
    }

    if (cleanEdition === 'java') {
      // Arquitetura defensiva: Só insere na fila se o jogador já não estiver lá
      await client.query(
        `INSERT INTO whitelist_queue(minecraft_name, user_id) 
         SELECT $1::varchar, $2::int 
         WHERE NOT EXISTS (
           SELECT 1 FROM whitelist_queue WHERE minecraft_name = $1
         )`,
        [cleanNick, userId]
      );
    }

    await client.query('COMMIT');
    return { user: userRows[0], integration, transferredFromUserId: previousUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function oauthRedirectError(res, message, provider = 'oauth') {
  return res.redirect(`${FRONTEND_BASE_URL}/login.html?oauth_provider=${encodeURIComponent(provider)}&oauth_err=${encodeURIComponent(message)}`);
}

async function issueSessionToken(req, userRow) {
  const token = jwt.sign({ sub: userRow.id, role: userRow.role }, JWT_SECRET, { expiresIn: '7d' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  await pool.query(
    `INSERT INTO user_sessions(user_id, token_hash, user_agent, ip, last_seen_at, created_at)
     VALUES($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT(token_hash) DO UPDATE SET last_seen_at=NOW(), revoked=FALSE`,
    [userRow.id, tokenHash, req.headers['user-agent'] || null, ip]
  );
  setCachedSession(tokenHash, true);
  return token;
}

async function createSessionAndRedirect(res, req, userRow, provider = 'oauth', isNew = false) {
  const token = await issueSessionToken(req, userRow);
  const actionLabel = isNew ? `Cadastro + login social (${provider})` : `Login social (${provider})`;
  await audit({ actorId: userRow.id, actorName: userRow.username, type: isNew ? 'create' : 'login', message: actionLabel });
  // Se é conta nova via OAuth social (não Microsoft), redireciona para onboarding de cadastro
  // O onboarding guia o usuário pela vinculação da conta Microsoft e cópia do IP
  if (isNew && provider !== 'microsoft') {
    return res.redirect(
      `${FRONTEND_BASE_URL}/signup.html?oauth_onboard=${encodeURIComponent(token)}&oauth_provider=${encodeURIComponent(provider)}`
    );
  }
  return res.redirect(`${FRONTEND_BASE_URL}/login.html?oauth_token=${encodeURIComponent(token)}&oauth_provider=${encodeURIComponent(provider)}`);
}

// ─────────────────────────────────────────────
// OAuth Helpers — CSRF State + Username util
// ─────────────────────────────────────────────

/**
 * Gera N bytes aleatórios em base64url (sem +, /, =).
 * Usado para gerar usernames únicos em contas criadas via OAuth.
 */
function randomBase64Url(n = 16) {
  return crypto.randomBytes(n).toString('base64url');
}

/**
 * Mapa em memória de OAuth states pendentes (proteção CSRF).
 * Chave: state string | Valor: { provider, expiresAt }
 * TTL: 10 minutos — tempo suficiente para o usuário autorizar.
 */
const _oauthStates = new Map();

function buildOAuthState(provider, linkUserId = null, meta = {}) {
  const state = randomBase64Url(24);
  _oauthStates.set(state, {
    provider,
    linkUserId,  // se fornecido, o callback deve vincular ao usuário existente em vez de fazer login
    popup: meta.popup === true,
    flowId: meta.flowId ? sanitize(meta.flowId).slice(0, 80) : null,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  // Housekeeping leve: remove states expirados a cada chamada
  const now = Date.now();
  for (const [k, v] of _oauthStates) {
    if (v.expiresAt < now) _oauthStates.delete(k);
  }
  return state;
}

function readOAuthState(state, provider) {
  const entry = _oauthStates.get(state);
  if (!entry) throw new Error('State OAuth inválido ou expirado');
  if (Date.now() > entry.expiresAt) {
    _oauthStates.delete(state);
    throw new Error('State OAuth expirado');
  }
  if (entry.provider !== provider) throw new Error('State OAuth de provider diferente');
  _oauthStates.delete(state); // one-use: consumido após validação
  return entry;
}

function oauthFrontendUrl(path, params = {}, stateEntry = null) {
  const url = new URL(path, FRONTEND_BASE_URL + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  if (stateEntry?.popup) url.searchParams.set('oauth_popup', '1');
  if (stateEntry?.flowId) url.searchParams.set('oauth_flow', stateEntry.flowId);
  return url.toString();
}

async function upsertSocialAccount({ provider, providerUserId, providerEmail, refreshToken, profileName }) {
  const normalizedEmail = sanitize(providerEmail).toLowerCase() || null;
  const providerId = sanitize(providerUserId);
  if (!providerId) throw new Error('Perfil social inválido');

  // 1. Já existe um social_account com esse provider + provider_user_id?
  //    → Usuário já vinculado: apenas atualiza token e faz login direto.
  const { rows: linked } = await pool.query(
    `SELECT u.* FROM social_accounts sa JOIN users u ON u.id=sa.user_id WHERE sa.provider=$1 AND sa.provider_user_id=$2 LIMIT 1`,
    [provider, providerId]
  );
  if (linked[0]) {
    await pool.query(
      `UPDATE social_accounts SET provider_email=$1, refresh_token=COALESCE($2, refresh_token), updated_at=NOW() WHERE provider=$3 AND provider_user_id=$4`,
      [normalizedEmail, refreshToken || null, provider, providerId]
    );
    return { status: 'ok', user: linked[0] };
  }

  // 2. Existe uma conta com esse e-mail?
  if (normalizedEmail) {
    const { rows: existingByEmail } = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [normalizedEmail]);
    if (existingByEmail[0]) {
      const existingUser = existingByEmail[0];

      // 2a. Esse usuário JÁ tem esse provider vinculado (mas com provider_user_id diferente)?
      //     → Pode acontecer se o usuário mudou o ID no provedor (raro) ou duplicidade de e-mail.
      //     → Sobrescreve silenciosamente o provider_user_id e faz login direto.
      const { rows: existingLink } = await pool.query(
        `SELECT id FROM social_accounts WHERE user_id=$1 AND provider=$2 LIMIT 1`,
        [existingUser.id, provider]
      );
      if (existingLink[0]) {
        await pool.query(
          `UPDATE social_accounts SET provider_user_id=$1, provider_email=$2, refresh_token=COALESCE($3, refresh_token), updated_at=NOW() WHERE user_id=$4 AND provider=$5`,
          [providerId, normalizedEmail, refreshToken || null, existingUser.id, provider]
        );
        return { status: 'ok', user: existingUser };
      }

      // 2b. O usuário tem conta mas esse provider nunca foi vinculado.
      //     → Precisa de confirmação explícita do usuário (nova vinculação).
      const linkToken = jwt.sign(
        { provider, providerUserId: providerId, providerEmail: normalizedEmail, profileName: sanitize(profileName), refreshToken: refreshToken || null },
        JWT_SECRET,
        { expiresIn: '10m' }
      );
      return { status: 'needs_confirmation', linkToken, email: normalizedEmail };
    }
  }

  // 3. Nenhuma conta existente → cria nova conta via OAuth.
  const baseName = sanitize(profileName).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || `${provider}_user`;
  const username = `${baseName}_${randomBase64Url(4).toLowerCase()}`;
  const fallbackEmail = normalizedEmail || `${provider}_${providerId}@oauth.forcaaliada.local`;
  const randomPass = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
  const { rows: created } = await pool.query(
    `INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,NULL,$3,'limited',TRUE) RETURNING *`,
    [username, fallbackEmail, randomPass]
  );
  await pool.query(
    `INSERT INTO social_accounts(user_id,provider,provider_user_id,provider_email,refresh_token) VALUES($1,$2,$3,$4,$5)`,
    [created[0].id, provider, providerId, normalizedEmail, refreshToken || null]
  );
  return { status: 'ok', user: created[0], isNew: true };
}

app.get('/api/auth/microsoft/login', (req, res) => {
  // Proteção CSRF: gera um state único para o fluxo Microsoft/Xbox
  // (o mesmo mecanismo usado pelos outros providers via registerGenericOAuth)

  // Se link_token for fornecido (fluxo de vinculação a partir da account.html),
  // extrai o userId para armazenar no state — o callback irá vincular ao usuário existente
  let linkUserId = null;
  const rawLinkToken = req.query.link_token;
  if (rawLinkToken) {
    try {
      const payload = jwt.verify(rawLinkToken, JWT_SECRET);
      linkUserId = payload.sub || null;
    } catch (_) {
      // Token inválido ou expirado — ignora e segue fluxo normal de login
    }
  }

  const state = buildOAuthState('microsoft', linkUserId, {
    popup: req.query.popup === '1' || req.query.oauth_popup === '1',
    flowId: req.query.flow_id || req.query.oauth_flow || null,
  });

  // ⚠️  IMPORTANTE: "offline_access" deve ficar no nível raiz (fora do XboxLive.*)
  //     para garantir que a Microsoft devolva o refresh_token.
  //     O scope NÃO deve ser duplamente encodado — deixe o URLSearchParams cuidar disso.
  const params = new URLSearchParams({
    client_id:     requireEnv('MS_CLIENT_ID'),
    response_type: 'code',
    redirect_uri:  requireEnv('MS_REDIRECT_URI'),
    scope:         'XboxLive.signin XboxLive.offline_access offline_access openid email profile',
    response_mode: 'query',
    state,
    prompt:        'select_account', // <-- A MÁGICA AQUI: Força a MS a perguntar qual conta usar
  });
  res.redirect(`https://login.live.com/oauth20_authorize.srf?${params.toString()}`);
});

app.post('/api/auth/oauth/confirm-link', authLimiter, async (req, res) => {
  try {
    const token = sanitize(req.body?.linkToken);
    const confirm = Boolean(req.body?.confirm);
    if (!token) return res.status(400).json({ error: 'missing link token' });
    if (!confirm) return res.status(400).json({ error: 'confirmation required' });
    const payload = jwt.verify(token, JWT_SECRET);
    const provider = sanitize(payload.provider).toLowerCase();
    const providerUserId = sanitize(payload.providerUserId);
    const providerEmail = sanitize(payload.providerEmail).toLowerCase();
    if (!provider || !providerUserId || !providerEmail) return res.status(400).json({ error: 'invalid token' });
    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [providerEmail]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'account not found' });
    await pool.query(
      `INSERT INTO social_accounts(user_id,provider,provider_user_id,provider_email,refresh_token)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET user_id=EXCLUDED.user_id, provider_email=EXCLUDED.provider_email, refresh_token=COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token), updated_at=NOW()`,
      [user.id, provider, providerUserId, providerEmail, payload.refreshToken || null]
    );
    const appToken = await issueSessionToken(req, user);
    // Registra a sessão igual aos outros fluxos de login
    await audit({ actorId: user.id, actorName: user.username, type: 'login', message: `Conta vinculada e login social (${provider})` });
    res.json({ token: appToken, user: { username: user.username, email: user.email, role: user.role, minecraftName: user.minecraft_name } });
  } catch (_err) {
    res.status(400).json({ error: 'invalid or expired link token' });
  }
});

function registerGenericOAuth({ provider, authUrl, tokenUrl, profileLoader, scope }) {
  app.get(`/api/auth/${provider}/login`, (req, res) => {
    // Se link_token for fornecido (fluxo de vinculação a partir da account.html),
    // extrai o userId para armazenar no state
    let linkUserId = null;
    const rawLinkToken = req.query.link_token;
    if (rawLinkToken) {
      try {
        const payload = jwt.verify(rawLinkToken, JWT_SECRET);
        linkUserId = payload.sub || null;
      } catch (_) { /* token inválido — ignora */ }
    }

    const state = buildOAuthState(provider, linkUserId, {
      popup: req.query.popup === '1' || req.query.oauth_popup === '1',
      flowId: req.query.flow_id || req.query.oauth_flow || null,
    });
    const params = new URLSearchParams({
      client_id: requireEnv(`${provider.toUpperCase()}_CLIENT_ID`),
      redirect_uri: requireEnv(`${provider.toUpperCase()}_REDIRECT_URI`),
      response_type: 'code',
      scope,
      state,
    });
    if (provider === 'facebook') params.set('auth_type', 'rerequest');
    res.redirect(`${authUrl}?${params.toString()}`);
  });

  app.get(`/api/auth/${provider}/callback`, async (req, res) => {
    let stateEntry = null;
    try {
      const { code, state } = req.query;
      if (state) stateEntry = readOAuthState(state, provider);
      if (!code) {
        return res.redirect(oauthFrontendUrl('login.html', {
          oauth_provider: provider,
          oauth_err: 'Acesso negado',
        }, stateEntry));
      }
      if (!stateEntry) throw new Error('State OAuth inválido ou expirado');
      const linkUserId = stateEntry?.linkUserId || null;

      const tParams = new URLSearchParams({
        client_id: requireEnv(`${provider.toUpperCase()}_CLIENT_ID`),
        client_secret: requireEnv(`${provider.toUpperCase()}_CLIENT_SECRET`),
        redirect_uri: requireEnv(`${provider.toUpperCase()}_REDIRECT_URI`),
        code: String(code),
        grant_type: 'authorization_code',
      });
      const tkRes = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: tParams.toString() });
      const tkData = await tkRes.json();
      if (!tkRes.ok || !tkData.access_token) throw new Error('Falha ao obter token OAuth');
      const profile = await profileLoader(tkData.access_token);

      // Fluxo de vinculação: usuário já logado na account.html
      if (linkUserId) {
        const { rows: existingUser } = await pool.query('SELECT * FROM users WHERE id = $1', [linkUserId]);
        if (!existingUser[0]) throw new Error('Conta não encontrada para vinculação.');
        const userRow = existingUser[0];

        // Vincula a conta social ao usuário existente
        await pool.query(
          `INSERT INTO social_accounts(user_id, provider, provider_user_id, provider_email, refresh_token)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT (provider, provider_user_id)
           DO UPDATE SET user_id=EXCLUDED.user_id, provider_email=EXCLUDED.provider_email,
             refresh_token=COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token), updated_at=NOW()`,
          [userRow.id, provider, profile.id, profile.email || null, tkData.refresh_token || null]
        );

        await audit({ actorId: userRow.id, actorName: userRow.username, type: 'update', message: `${provider} vinculado via account.html` });

        // Redireciona para login.html — o popup detecta e fecha com postMessage
        const token = await issueSessionToken(req, userRow);
        return res.redirect(oauthFrontendUrl('login.html', {
          oauth_token: token,
          oauth_provider: provider,
        }, stateEntry));
      }

      // Fluxo normal de login
      const outcome = await upsertSocialAccount({
        provider,
        providerUserId: profile.id,
        providerEmail: profile.email,
        refreshToken: tkData.refresh_token,
        profileName: profile.name
      });
      if (outcome.status === 'needs_confirmation') {
        return res.redirect(oauthFrontendUrl('login.html', {
          oauth_provider: provider,
          oauth_link_token: outcome.linkToken,
          oauth_email: outcome.email,
        }, stateEntry));
      }
      return createSessionAndRedirect(res, req, outcome.user, provider, outcome.isNew === true);
    } catch (err) {
      return res.redirect(oauthFrontendUrl('login.html', {
        oauth_provider: provider,
        oauth_err: err.message || 'Falha no login social',
      }, stateEntry));
    }
  });
}

registerGenericOAuth({
  provider: 'google',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  profileLoader: async (token) => {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error('Falha ao obter perfil Google');
    return { id: d.sub, email: d.email, name: d.name };
  }
});

registerGenericOAuth({
  provider: 'facebook',
  authUrl: 'https://www.facebook.com/v20.0/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/v20.0/oauth/access_token',
  scope: 'email,public_profile',
  profileLoader: async (token) => {
    const r = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(token)}`);
    const d = await r.json();
    if (!r.ok) throw new Error('Falha ao obter perfil Facebook');
    return { id: d.id, email: d.email || null, name: d.name };
  }
});

registerGenericOAuth({
  provider: 'discord',
  authUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  scope: 'identify email',
  profileLoader: async (token) => {
    const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error('Falha ao obter perfil Discord');
    return { id: d.id, email: d.email || null, name: d.global_name || d.username };
  }
});

/**
 * GET /api/auth/microsoft/callback
 *
 * Suporte a Java Edition E Bedrock Edition:
 *
 *  Fluxo unificado:
 *   1. Troca o código OAuth por tokens da Microsoft.
 *   2. Obtém token Xbox Live (XBL) — comum a ambas as edições.
 *   3. Tenta obter token XSTS para Minecraft Services (Java Edition).
 *      Se falhar com XErr 2148916238 (conta infantil), aborta com mensagem clara.
 *   4. Tenta autenticar na Mojang e buscar o perfil Java.
 *      → Se bem-sucedido: edition = 'java', nick = nome Java, uuid = UUID Java.
 *   5. Se a conta NÃO tiver Java Edition (perfil retorna null/404):
 *      → Obtém token XSTS para xboxlive.com e busca o Gamertag.
 *      → edition = 'bedrock', nick = Gamertag, uuid = 'bedrock_' + xuid.
 *      → Whitelist pelo Gamertag (que é o nick no Bedrock com BedrockConnect/Geyser).
 *   6. Upsert do usuário e da integração no banco, cria sessão JWT.
 *
 *  Segurança:
 *   - Não armazena tokens em query strings além do JWT assinado pelo servidor.
 *   - Refresh token da MS armazenado apenas na tabela user_integrations.
 *   - XUID usado como chave de busca para re-autenticações futuras (evita duplicatas).
 *   - UUID sintético para Bedrock ('bedrock_' + xuid) garante unicidade na coluna mc_uuid.
 */
app.get('/api/auth/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;

  // Valida o CSRF state — protege contra ataques de redirecionamento forjado
  // O state pode estar ausente em deploys antigos (retrocompatibilidade) — apenas loga o aviso
  let stateEntry = null;
  if (state) {
    try {
      stateEntry = readOAuthState(state, 'microsoft');
    } catch (stateErr) {
      console.warn('[microsoft/callback] State inválido:', stateErr.message);
      return res.redirect(`${FRONTEND_BASE_URL}/login.html?oauth_provider=microsoft&oauth_err=${encodeURIComponent('Sessão de autenticação expirada. Tente novamente.')}`);
    }
  }

  // linkUserId presente → fluxo de vinculação (usuário já logado na account.html)
  if (!code) {
    return res.redirect(oauthFrontendUrl('login.html', {
      oauth_provider: 'microsoft',
      oauth_err: 'Acesso negado',
    }, stateEntry));
  }

  const linkUserId = stateEntry?.linkUserId || null;

  try {
    // ── Passo 1: Tokens Microsoft ────────────────────────────────────────────
    const msTokens = await exchangeMsCodeForToken(code);

    // ── Passo 2: Token Xbox Live (XBL) — compartilhado Java + Bedrock ───────
    const xblData = await getXboxLiveToken(msTokens.access_token);
    const uhs     = xblData.DisplayClaims.xui[0].uhs;

    // ── Passo 2.5: XSTS para Xbox Live (Obrigatório para obter o XUID) ──────
    // O token XBL primário não possui o 'xid'. Precisamos do token XSTS do Xbox.
    let xstsXbox;
    try {
      xstsXbox = await getXSTSToken(xblData.Token, 'http://xboxlive.com');
    } catch (xboxErr) {
      throw new Error('Falha ao autenticar no Xbox Live. Verifique sua configuração do Xbox.');
    }
    
    // Agora sim o XUID e o Gamertag são garantidos!
    const xuid = xstsXbox.DisplayClaims.xui[0].xid;
    let gamertag = xstsXbox.DisplayClaims.xui[0].gtg || null;

    // ── Passo 3: XSTS para Minecraft Services (necessário para Java) ─────────
    // Se a conta for infantil, xstsMC lança erro automaticamente e bloqueia o acesso.
    let xstsMC;
    try {
      xstsMC = await getXSTSToken(xblData.Token, 'rp://api.minecraftservices.com/');
    } catch (xstsErr) {
      // Erros de conta infantil (2148916238) ou conta sem configuração (2148916233)
      // são relançados com a mensagem amigável já definida em getXSTSToken.
      throw xstsErr;
    }

    // ── Passo 4: Tentar Java Edition ─────────────────────────────────────────
    let edition    = 'java';
    let nick       = null;
    let mcUuid     = null;

    try {
      const mcTokenData = await getMinecraftAccessToken(uhs, xstsMC.Token);
      const javaProfile = await tryGetMinecraftJavaProfile(mcTokenData.access_token);

      if (javaProfile && javaProfile.id && javaProfile.name) {
        nick   = javaProfile.name;
        mcUuid = javaProfile.id;
        // edition permanece 'java'
      } else {
        // Conta autenticada na Mojang mas sem Java Edition — cai para Bedrock
        edition = 'bedrock';
      }
    } catch {
      // Qualquer falha na autenticação Mojang → trata como Bedrock
      edition = 'bedrock';
    }

    // ── Passo 5: Fallback Bedrock (sem Java Edition) ─────────────────────────
    if (edition === 'bedrock') {
      if (!gamertag) {
        gamertag = await getXboxGamertag(uhs, xstsXbox.Token);
      }
      if (!gamertag) {
        throw new Error('Não foi possível obter seu Gamertag Xbox. Verifique se sua conta Xbox está configurada e tente novamente.');
      }

      nick   = gamertag;
      // UUID sintético único para Bedrock — garante unicidade sem conflito com UUIDs Java
      mcUuid = `bedrock_${xuid}`;
    }

    // ── Passo 6: Upsert do usuário e integração ───────────────────────────────

    let userRow;

    // ── FLUXO DE VINCULAÇÃO (link_token fornecido pela account.html) ─────────
    if (linkUserId) {
      // Capturar nick anterior ANTES de sobrescrever (para detectar conta legacy)
      const { rows: prevUserRows } = await pool.query('SELECT minecraft_name FROM users WHERE id=$1', [linkUserId]);
      const previousMcNameLink = prevUserRows[0]?.minecraft_name || null;

      const linked = await linkMicrosoftIntegration({
        userId: linkUserId,
        msRefreshToken: msTokens.refresh_token,
        xuid,
        mcUuid,
        edition,
        nick,
        gamertag: edition === 'bedrock' ? nick : null,
      });
      userRow = linked.user;

      // Detectar dados legacy do nick anterior (ex: CaioLeal → Porralho)
      legacyMigrationService.detectLegacyOnOAuthCallback(linkUserId, previousMcNameLink, nick).catch(() => {});

      const editionLabelNew = microsoftEditionLabel(edition);
      await audit({
        actorId: userRow.id, actorName: userRow.username,
        type: 'update', severity: 'info',
        message: `Xbox vinculado via account.html (${editionLabelNew}): ${nick}`,
        metadata: { edition, nick, xuid, mcUuid, integrationId: linked.integration?.id, transferredFromUserId: linked.transferredFromUserId },
      });

      return res.redirect(oauthFrontendUrl('login.html', {
            oauth_token: await issueSessionToken(req, userRow),
            oauth_provider: 'microsoft',
          }, stateEntry));
        }

    // ── FLUXO NORMAL DE LOGIN ────────────────────────────────────────────────

    // 6a. Já existe integração salva com esse XUID? → usuário retornante
    const { rows: existingByXuid } = await pool.query(
      'SELECT user_id FROM user_integrations WHERE xbox_xuid = $1 OR mc_uuid = $2 ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1',
      [xuid, mcUuid]
    );

    if (existingByXuid.length > 0) {
      const { rows: u } = await pool.query('SELECT * FROM users WHERE id = $1', [existingByXuid[0].user_id]);
      userRow = u[0];
      const previousMcNameLogin = userRow.minecraft_name || null;
      // Atualiza refresh token e mc_uuid (pode ter mudado de Java→Bedrock ou vice-versa)
      await linkMicrosoftIntegration({
        userId: userRow.id,
        msRefreshToken: msTokens.refresh_token,
        xuid,
        mcUuid,
        edition,
        nick,
        gamertag: edition === 'bedrock' ? nick : null,
      });
      // Garante que minecraft_name está atualizado (Gamertag pode mudar no Xbox)
      await pool.query(
        "UPDATE users SET minecraft_name = $1 WHERE id = $2 AND (minecraft_name IS NULL OR minecraft_name = '')",
        [nick, userRow.id]
      );
      // Detectar dados legacy se o nick mudou (ex: CaioLeal → Porralho)
      legacyMigrationService.detectLegacyOnOAuthCallback(userRow.id, previousMcNameLogin, nick).catch(() => {});
    } else {
      // 6b. Novo usuário — verifica se já existe conta com esse nick (cadastro manual)
      const { rows: matchNick } = await pool.query(
        'SELECT * FROM users WHERE LOWER(minecraft_name) = $1 LIMIT 1',
        [nick.toLowerCase()]
      );

      if (matchNick.length > 0) {
        // Conta manual com mesmo nick → vincula integração a ela
        userRow = matchNick[0];
      } else {
        // Conta totalmente nova via Xbox/Microsoft
        // Email sintético: diferencia Java de Bedrock no endereço para evitar colisão
        const domainSuffix = edition === 'bedrock' ? 'bedrock.forcaaliada.local' : 'xbox.forcaaliada.local';
        const fakeEmail    = `${xuid}@${domainSuffix}`;
        const randomPass   = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

        // Username derivado do nick, sanitizado para não ter caracteres inválidos
        // Gamertags Xbox podem ter espaços — substituímos por underscores
        const safeUsername = nick.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32) || `xbox_${xuid.slice(-8)}`;

        const { rows: newUser } = await pool.query(
          `INSERT INTO users(username, email, minecraft_name, password_hash, role, is_verified)
           VALUES($1, $2, $3, $4, 'limited', TRUE) RETURNING *`,
          [safeUsername, fakeEmail, nick, randomPass]
        );
        userRow = newUser[0];

        // Enfileira na whitelist automaticamente para jogadores de Java Edition
        if (edition === 'java') {
          // Arquitetura defensiva: Só insere na fila se o jogador já não estiver lá
          await pool.query(
            `INSERT INTO whitelist_queue(minecraft_name, user_id) 
             SELECT $1::varchar, $2::int 
             WHERE NOT EXISTS (
               SELECT 1 FROM whitelist_queue WHERE minecraft_name = $1
             )`,
            [nick, userRow.id]
          );
        }
      }

      // 6c. Salva/vincula a integração Microsoft/Xbox
      await pool.query(
        `UPDATE users SET minecraft_name = $1 WHERE id = $2 AND (minecraft_name IS NULL OR minecraft_name = '')`,
        [nick, userRow.id]
      );

      await linkMicrosoftIntegration({
        userId: userRow.id,
        msRefreshToken: msTokens.refresh_token,
        xuid,
        mcUuid,
        edition,
        nick,
        gamertag: edition === 'bedrock' ? nick : null,
      });
    }

    // ── Passo 7: Cria sessão JWT e redireciona ────────────────────────────────
    const token     = jwt.sign({ sub: userRow.id, role: userRow.role }, JWT_SECRET, { expiresIn: '7d' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;

    await pool.query(
      `INSERT INTO user_sessions(user_id, token_hash, user_agent, ip, last_seen_at, created_at)
       VALUES($1,$2,$3,$4,NOW(),NOW())`,
      [userRow.id, tokenHash, req.headers['user-agent'] || null, ip]
    );

    const editionLabel = edition === 'bedrock' ? 'Bedrock' : 'Java';
    await audit({
      actorId: userRow.id, actorName: userRow.username,
      type: 'login', severity: 'info',
      message: `Login Microsoft/Xbox (${editionLabel}): ${nick}`,
      metadata: { edition, nick, xuid, mcUuid },
    });

    // Usa o parâmetro genérico oauth_token (compatível com o handler do login.html)
    res.redirect(`${FRONTEND_BASE_URL}/login.html?oauth_token=${encodeURIComponent(token)}&oauth_provider=microsoft`);

  } catch (err) {
    console.error('[microsoft/callback]', err?.message || err);
    res.redirect(oauthFrontendUrl('login.html', {
      oauth_provider: 'microsoft',
      oauth_err: err.message || 'Erro ao autenticar com a Microsoft',
    }, stateEntry));
  }
});

// ─────────────────────────────────────────────
// AUTH – Signup (ESSE É O SEU CÓDIGO ORIGINAL QUE CONTINUA INTACTO!)
// ─────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const username = sanitize(req.body?.username).toLowerCase();
  const email    = sanitize(req.body?.email).toLowerCase();
  const password = req.body?.password || '';

  // minecraft_name não é aceito no cadastro manual —
  // o nick só é definido ao vincular conta Microsoft/Xbox após o login.
  if (req.body?.minecraftName !== undefined) {
    return res.status(400).json({
      error: 'O nick de Minecraft não pode ser definido no cadastro. Vincule sua conta Xbox após criar a conta.',
    });
  }

  if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password))
    return res.status(400).json({ error: 'Dados inválidos.' });

  try {
    // ── Verifica conflitos antes de inserir ──────────────────────────────────
    const { rows: existing } = await pool.query(
      'SELECT id, email, username, is_verified FROM users WHERE email=$1 OR username=$2',
      [email, username]
    );

    // Caso 1: conta com esse e-mail já existe e está verificada → não podemos substituí-la
    const byEmail = existing.find(r => r.email === email);
    if (byEmail && byEmail.is_verified) {
      return res.status(409).json({ error: 'email_verified_exists' });
    }

    // Caso 2: conta com esse username já existe (e-mail diferente ou verificada) → username indisponível
    const byUsername = existing.find(r => r.username === username);
    if (byUsername && (!byEmail || byEmail.id !== byUsername.id)) {
      return res.status(409).json({ error: 'username taken' });
    }

    // Caso 3: conta com esse e-mail existe mas ainda NÃO foi verificada
    // → atualiza username e senha (usuário pode ter errado e quer tentar de novo),
    //   gera novo código e reenvia. Não cria duplicidade.
    if (byEmail && !byEmail.is_verified) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE users SET username=$1, password_hash=$2 WHERE email=$3',
        [username, hash, email]
      );
      const code      = generateVerificationCode();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await pool.query('DELETE FROM email_verifications WHERE email=$1', [email]);
      await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [email, code, expiresAt]);
      await sendSystemEmail(email, username, code, 'verify');
      return res.json({ ok: true, requireVerification: true, email, resumed: true });
    }

    // Caso 4: conta completamente nova — cria normalmente
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,NULL,$3,$4,FALSE) RETURNING username,id',
      [username, email, hash, 'limited'],
    );

    const code      = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email=$1', [email]);
    await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [email, code, expiresAt]);
    await sendSystemEmail(email, rows[0].username, code, 'verify');

    await audit({ type: 'create', targetId: rows[0].id, targetName: username, message: `Conta criada: ${username} (sem MC — aguarda vinculação Xbox)` });
    res.json({ ok: true, requireVerification: true, email });

  } catch (e) {
    console.error('[signup]', e?.message || e);
    res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
  }
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  const email = sanitize(req.body?.email).toLowerCase();
  const code  = sanitize(req.body?.code);

  if (!validateEmail(email) || !code)
    return res.status(400).json({ error: 'Dados inválidos' });

  const { rows: ver } = await pool.query(
    'SELECT * FROM email_verifications WHERE email=$1 AND code=$2 AND expires_at>NOW()',
    [email, code],
  );
  if (!ver.length) return res.status(400).json({ error: 'Código inválido ou expirado.' });

  const { rows: updated } = await pool.query(
    'UPDATE users SET is_verified=TRUE WHERE email=$1 RETURNING *',
    [email],
  );
  await pool.query('DELETE FROM email_verifications WHERE email=$1', [email]);

  const user = updated[0];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  await audit({
    actorId: user.id, actorName: user.username,
    type: 'security', severity: 'info',
    message: `E-mail verificado com sucesso: ${user.username}`,
    metadata: { email: user.email },
  });

  // ── Enqueue whitelist addition for the desktop app ──
  if (user.minecraft_name) {
    try {
      // Arquitetura defensiva para evitar duplicidade na fila
      await pool.query(
        `INSERT INTO whitelist_queue(minecraft_name, user_id) 
         SELECT $1::varchar, $2::int 
         WHERE NOT EXISTS (
           SELECT 1 FROM whitelist_queue WHERE minecraft_name = $1
         )`,
        [user.minecraft_name, user.id]
      );
    } catch (e) {
      console.error('[whitelist_queue insert]', e);
    }
  }

  const token = await issueSessionToken(req, user);
  res.json({ token, user: { username: user.username, email: user.email, minecraftName: user.minecraft_name, role: user.role } });
});

// A próxima rota já é a de login normal que você tem aí
// app.post('/api/auth/login', authLimiter, async (req, res) => { ...

app.post('/api/auth/login', authLimiter, async (req, res) => {
const login    = sanitize(req.body?.login).toLowerCase();
const password = req.body?.password || '';
if (!login || !password) return res.status(400).json({ error: 'missing fields' });

const { rows } = await pool.query(
'SELECT * FROM users WHERE username=$1 OR email=$1', [login],
);
const user = rows[0];
if (!user || !(await bcrypt.compare(password, user.password_hash))) {
  // Login falho — registrar tentativa
  await audit({
    type: 'security', severity: 'warning',
    message: `Tentativa de login falha para: ${login}`,
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
    metadata: { login },
  });
  return res.status(401).json({ error: 'invalid credentials' });
}

if (user.is_verified === false) {
const code      = generateVerificationCode();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('DELETE FROM email_verifications WHERE email=$1', [user.email]);
await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [user.email, code, expiresAt]);
await sendSystemEmail(user.email, user.username, code, 'verify');
return res.status(403).json({ error: 'unverified_email', email: user.email });
}

await auditFromReq(req, {
  actorId: user.id, actorName: user.username,
  type: 'login', severity: 'info',
  message: `Login bem-sucedido: ${user.username}`,
  metadata: { email: user.email, role: user.role },
});

const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const ua = req.headers['user-agent'] || null;
const ip = req.ip || req.socket?.remoteAddress || null;
(async () => {
  let city = null, region = null, country = null, isp = null;
  try {
    const cleanIp = (ip || '').replace(/^::ffff:/, '');
    if (cleanIp && cleanIp !== '127.0.0.1' && cleanIp !== '::1') {
      const geoRes = await fetch(`https://ipapi.co/${cleanIp}/json/`, { signal: AbortSignal.timeout(4000) });
      if (geoRes.ok) {
        const g = await geoRes.json();
        city = g.city || null; region = g.region || null; country = g.country_name || null;
        isp  = (g.org || '').replace(/^AS\d+\s*/, '') || null;
      }
    }
  } catch { /* geo opcional */ }
  try {
    await pool.query(
      `INSERT INTO user_sessions(user_id, token_hash, user_agent, ip, city, region, country, isp, last_seen_at, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT(token_hash) DO UPDATE SET last_seen_at=NOW()`,
      [user.id, tokenHash, ua, ip, city, region, country, isp]
    );
  } catch(e) { console.error('[sessions] insert error:', e.message); }
})();

res.json({
token,
user: {
username: user.username, email: user.email,
minecraftName: user.minecraft_name, photoUrl: user.photo_url, role: user.role,
},
});
});

app.post('/api/auth/forgot-password', emailLimiter, async (req, res) => {
const email = sanitize(req.body?.email).toLowerCase();
if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

await pool.query('DELETE FROM password_resets WHERE email=$1 OR expires_at<NOW()', [email]);
const { rows } = await pool.query('SELECT username FROM users WHERE email=$1', [email]);
if (!rows.length) return res.json({ ok: true }); 

const code      = generateVerificationCode();
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
await pool.query('INSERT INTO password_resets(email,code,expires_at) VALUES($1,$2,$3)', [email, code, expiresAt]);
await sendSystemEmail(email, rows[0].username, code, 'reset');
await audit({
  type: 'security', severity: 'info',
  message: `Código de recuperação de senha enviado para: ${email}`,
  metadata: { email },
});
res.json({ ok: true });
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
const email       = sanitize(req.body?.email).toLowerCase();
const code        = sanitize(req.body?.code);
const newPassword = req.body?.newPassword;

if (!validateEmail(email) || !code || !validatePassword(newPassword))
return res.status(400).json({ error: 'Dados inválidos' });

const { rows } = await pool.query(
'SELECT * FROM password_resets WHERE email=$1 AND code=$2 AND expires_at>NOW()',
[email, code],
);
if (!rows.length) return res.status(400).json({ error: 'Código inválido ou expirado' });

const hash = await bcrypt.hash(newPassword, 10);
await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, email]);
await pool.query('DELETE FROM password_resets WHERE email=$1', [email]);

const { rows: userRows } = await pool.query('SELECT id, username FROM users WHERE email=$1', [email]);
await audit({
  actorId: userRows[0]?.id || null,
  actorName: userRows[0]?.username || email,
  type: 'security', severity: 'warning',
  message: `Senha redefinida via código de recuperação para: ${userRows[0]?.username || email}`,
  metadata: { email },
});

res.json({ ok: true });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (rawToken) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await pool.query(
        'UPDATE user_sessions SET revoked=TRUE WHERE token_hash=$1',
        [tokenHash],
      );
      invalidateSessionCache(tokenHash);
    }
    await auditFromReq(req, {
      actorId:   req.user?.sub,
      actorName: req.user?.username,
      type:      'logout',
      severity:  'info',
      message:   `${req.user?.username || 'Usuário'} encerrou sessão`,
    });
  } catch { /* logout nunca falha */ }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// ME – Perfil
// ─────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, u.minecraft_name, u.photo_url, u.role, u.is_verified, u.is_platform_verified, u.created_at,
              COALESCE(up.display_name, '') AS display_name,
              COALESCE(up.avatar_url, '') AS avatar_url,
              COALESCE(up.cover_url, '') AS cover_url,
              COALESCE(up.profile_layout, 'posts') AS profile_layout,
              ${primaryIntegrationFieldsSql('u')} AS integration,
              ${socialRankSql('u', 'pb')} AS rank,
              ${socialMeritSql('u', 'pb')} AS merit
       FROM users u
       LEFT JOIN user_preferences up ON up.user_id = u.id
       LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
       WHERE u.id=$1`,
      [req.user.sub],
    );
    if (!rows.length) return res.status(401).json({ error: 'user deleted' });
    res.json(rows[0]);
  } catch (error) {
    console.error('[GET /api/me error]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/me', auth, async (req, res) => {
const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const currentPassword = req.body?.currentPassword || '';

if (!validateUsername(username) || !validateEmail(email))
return res.status(400).json({ error: 'Dados inválidos' });

const { rows } = await pool.query('SELECT password_hash, username, email FROM users WHERE id=$1', [req.user.sub]);
if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid current password' });

try {
await pool.query(
'UPDATE users SET username=$1, email=$2, minecraft_name=$3 WHERE id=$4',
[username, email, minecraftName, req.user.sub],
);

await audit({
  actorId: req.user.sub, actorName: req.user.username,
  type: 'update', targetId: req.user.sub, targetName: username,
  message: `Perfil atualizado: ${rows[0].username} → ${username}`,
});

res.json({ ok: true });

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

async function changeMyPassword(req, res) {
const currentPassword = req.body?.currentPassword || '';
const newPassword     = req.body?.newPassword || '';
if (!validatePassword(newPassword))
return res.status(400).json({ error: 'invalid new password' });

const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.sub]);
if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid current password' });

const hash = await bcrypt.hash(newPassword, 10);
await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.sub]);

await audit({
actorId: req.user.sub, actorName: req.user.username,
type: 'update', targetId: req.user.sub,
message: `${req.user.username} alterou sua senha`,
});

res.json({ ok: true });
}
app.post('/api/me/password', auth, changeMyPassword);
app.put('/api/me/password',  auth, changeMyPassword);

// ─────────────────────────────────────────────
// ME – Solicitar exclusão de conta (envia código por e-mail)
// ─────────────────────────────────────────────
app.post('/api/me/delete-request', auth, emailLimiter, async (req, res) => {
  const password = req.body?.password || '';

  try {
    const { rows } = await pool.query('SELECT email, password_hash, username FROM users WHERE id=$1', [req.user.sub]);
    if (!rows.length) return res.status(404).json({ error: 'user not found' });

    // Valida senha antes de enviar o código
    if (!(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'invalid password' });
    }

    const user = rows[0];
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Upsert: se já existe uma solicitação pendente, substitui
    await pool.query(
      `INSERT INTO delete_account_verifications(user_id, code, expires_at)
       VALUES($1, $2, $3)
       ON CONFLICT(user_id) DO UPDATE SET code=$2, expires_at=$3, created_at=NOW()`,
      [req.user.sub, code, expiresAt]
    );

    await sendSystemEmail(user.email, user.username, code, 'delete_account');

    await auditFromReq(req, {
      actorId: req.user.sub, actorName: user.username,
      type: 'security', severity: 'warning',
      message: `Código de exclusão de conta enviado para ${user.email}`,
    });

    // Retorna os últimos 4 caracteres do e-mail para exibir no frontend (ex: "...@gmail.com")
    const emailMasked = user.email.replace(/(.{2}).+(@.+)/, '$1***$2');
    res.json({ ok: true, emailMasked });
  } catch (e) {
    console.error('[POST /api/me/delete-request]', e);
    res.status(500).json({ error: 'Erro ao enviar código de verificação.' });
  }
});

app.delete('/api/me', auth, emailLimiter, async (req, res) => {
const email    = sanitize(req.body?.email).toLowerCase();
const password = req.body?.password || '';
const emailCode = sanitize(req.body?.emailCode || '');

const { rows } = await pool.query('SELECT email, password_hash, username FROM users WHERE id=$1', [req.user.sub]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });
if (rows[0].email !== email) return res.status(400).json({ error: 'email mismatch' });
if (!(await bcrypt.compare(password, rows[0].password_hash)))
return res.status(401).json({ error: 'invalid password' });

// Etapa 2: verificar código de e-mail
if (!emailCode) return res.status(400).json({ error: 'email_code_required' });

const { rows: verRows } = await pool.query(
  'SELECT code, expires_at FROM delete_account_verifications WHERE user_id=$1',
  [req.user.sub]
);
if (!verRows.length) return res.status(400).json({ error: 'code_not_requested' });
if (new Date(verRows[0].expires_at) < new Date()) return res.status(400).json({ error: 'code_expired' });
if (!emailCode || !/^\d{6}$/.test(String(emailCode))) return res.status(400).json({ error: 'invalid_code' });
if (!crypto.timingSafeEqual(Buffer.from(verRows[0].code), Buffer.from(String(emailCode)))) return res.status(400).json({ error: 'invalid_code' });

// Remove o código usado
await pool.query('DELETE FROM delete_account_verifications WHERE user_id=$1', [req.user.sub]);

await audit({
actorId: req.user.sub, actorName: rows[0].username,
type: 'delete', severity: 'critical', targetId: req.user.sub, targetName: rows[0].username,
message: `Conta excluída pelo próprio usuário (verificação por e-mail confirmada): ${rows[0].username}`,
});

await pool.query('DELETE FROM users WHERE id=$1', [req.user.sub]);
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// HELPER: Renova o access_token Microsoft com o refresh_token salvo no banco.
// Verifica erros, salva o novo refresh_token e retorna o access_token pronto para uso.
// Lança erro descritivo se o refresh_token estiver expirado/ausente.
// ─────────────────────────────────────────────
async function refreshMsAccessToken(userId, integrationId = null, edition = null) {
  const { rows } = await pool.query(
    `SELECT id, ms_refresh_token
     FROM user_integrations
     WHERE user_id = $1
       AND ($2::bigint IS NULL OR id = $2::bigint)
       AND ($3::text IS NULL OR mc_edition = $3::text)
       AND ms_refresh_token IS NOT NULL
     ORDER BY is_primary DESC, updated_at DESC NULLS LAST, id ASC
     LIMIT 1`,
    [userId, integrationId, edition]
  );
  if (!rows.length || !rows[0].ms_refresh_token) {
    throw new Error('Conta não vinculada à Microsoft. Vincule sua conta Xbox nas configurações.');
  }

  const params = new URLSearchParams({
    client_id:     requireEnv('MS_CLIENT_ID'),
    client_secret: requireEnv('MS_CLIENT_SECRET'),
    refresh_token: rows[0].ms_refresh_token,
    grant_type:    'refresh_token',
    scope:         'XboxLive.signin XboxLive.offline_access offline_access',
  });

  const msRes = await fetch('https://login.live.com/oauth20_token.srf', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  const msData = await msRes.json();

  if (!msRes.ok || !msData.access_token) {
    // Refresh token expirado ou revogado — limpa do banco para evitar loops
    const errCode = msData.error || 'unknown';
    if (['invalid_grant', 'unauthorized_client', 'interaction_required'].includes(errCode)) {
      // Token revogado: remove a integração para forçar nova vinculação
      await pool.query(
        'UPDATE user_integrations SET ms_refresh_token = NULL, updated_at = NOW() WHERE id = $1',
        [rows[0].id]
      );
      throw new Error(
        'Sua sessão Microsoft expirou ou foi revogada. ' +
        'Acesse Conta → Conexões e vincule o Xbox novamente.'
      );
    }
    throw new Error(
      `Falha ao renovar autenticação Microsoft (${errCode}). Tente novamente mais tarde.`
    );
  }

  // Salva o novo refresh_token (rotação de tokens)
  if (msData.refresh_token) {
    await pool.query(
      'UPDATE user_integrations SET ms_refresh_token = $1, updated_at = NOW() WHERE id = $2',
      [msData.refresh_token, rows[0].id]
    );
  }

  return msData.access_token;
}

// ─────────────────────────────────────────────
// ME – Contas sociais vinculadas
// ─────────────────────────────────────────────
app.get('/api/me/social-accounts', auth, async (req, res) => {
  try {
    // Busca social_accounts (Google, Facebook, Discord)
    const { rows: social } = await pool.query(
      `SELECT provider, provider_email, created_at, updated_at FROM social_accounts WHERE user_id=$1`,
      [req.user.sub]
    );

    // Busca integração Microsoft/Xbox separadamente (tabela user_integrations)
    const { rows: msRows } = await pool.query(
      `SELECT id, xbox_xuid, mc_uuid, mc_edition, mc_name, xbox_gamertag, is_primary, created_at, updated_at
       FROM user_integrations
       WHERE user_id=$1
       ORDER BY is_primary DESC, updated_at DESC NULLS LAST, id ASC`,
      [req.user.sub]
    );

    // Monta lista de provedores disponíveis + status de vinculação
    const linked = {};
    social.forEach(s => {
      linked[s.provider] = {
        provider: s.provider,
        provider_email: s.provider_email,
        linked_at: s.updated_at || s.created_at,
        linked: true,
      };
    });

    const microsoftAccounts = msRows.filter(row => row.xbox_xuid);
    if (microsoftAccounts.length > 0) {
      const primary = microsoftAccounts.find(row => row.is_primary) || microsoftAccounts[0];
      linked['microsoft'] = {
        provider: 'microsoft',
        provider_email: null,
        xbox_xuid: primary.xbox_xuid,
        mc_uuid: primary.mc_uuid,
        mc_edition: primary.mc_edition,
        mc_name: primary.mc_name,
        xbox_gamertag: primary.xbox_gamertag,
        linked_at: primary.updated_at || primary.created_at,
        linked: true,
        accounts: microsoftAccounts.map(row => ({
          id: row.id,
          provider: 'microsoft',
          xbox_xuid: row.xbox_xuid,
          mc_uuid: row.mc_uuid,
          mc_edition: row.mc_edition || 'java',
          mc_name: row.mc_name || row.xbox_gamertag || null,
          xbox_gamertag: row.xbox_gamertag || null,
          is_primary: row.is_primary === true,
          linked_at: row.updated_at || row.created_at,
          linked: true,
        })),
      };
    }

    res.json({ accounts: linked });
  } catch (e) {
    console.error('[GET /api/me/social-accounts]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/me/social-accounts/microsoft/:integrationId/primary', auth, async (req, res) => {
  const integrationId = Number(req.params.integrationId);
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    return res.status(400).json({ error: 'invalid integration id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, mc_name, xbox_gamertag
       FROM user_integrations
       WHERE id=$1 AND user_id=$2
       LIMIT 1`,
      [integrationId, req.user.sub]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not linked' });
    }

    await client.query('UPDATE user_integrations SET is_primary=FALSE WHERE user_id=$1', [req.user.sub]);
    await client.query(
      'UPDATE user_integrations SET is_primary=TRUE, updated_at=NOW() WHERE id=$1 AND user_id=$2',
      [integrationId, req.user.sub]
    );

    const nextMinecraftName = rows[0].mc_name || rows[0].xbox_gamertag || null;
    if (nextMinecraftName) {
      await client.query('UPDATE users SET minecraft_name=$1 WHERE id=$2', [nextMinecraftName, req.user.sub]);
    }
    await client.query('COMMIT');

    await auditFromReq(req, {
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `Conta Microsoft principal atualizada: ${nextMinecraftName || integrationId}`,
    });

    res.json({ ok: true, minecraftName: nextMinecraftName });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PATCH /api/me/social-accounts/microsoft/:integrationId/primary]', e);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

app.delete('/api/me/social-accounts/microsoft/:integrationId', auth, async (req, res) => {
  const integrationId = Number(req.params.integrationId);
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    return res.status(400).json({ error: 'invalid integration id' });
  }

  try {
    const { rows } = await pool.query(
      'DELETE FROM user_integrations WHERE id=$1 AND user_id=$2 RETURNING id, mc_name, is_primary',
      [integrationId, req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'not linked' });

    if (rows[0].is_primary) {
      const { rows: nextRows } = await pool.query(
        `UPDATE user_integrations
         SET is_primary=TRUE
         WHERE id = (
           SELECT id FROM user_integrations
           WHERE user_id=$1
           ORDER BY updated_at DESC NULLS LAST, id ASC
           LIMIT 1
         )
         RETURNING mc_name`,
        [req.user.sub]
      );
      if (nextRows[0]?.mc_name) {
        await pool.query('UPDATE users SET minecraft_name=$1 WHERE id=$2', [nextRows[0].mc_name, req.user.sub]);
      } else if (rows[0].mc_name) {
        await pool.query(
          'UPDATE users SET minecraft_name=NULL WHERE id=$1 AND minecraft_name=$2',
          [req.user.sub, rows[0].mc_name]
        );
      }
    }

    await auditFromReq(req, {
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `Vinculo Microsoft removido: ${rows[0].mc_name || integrationId}`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/me/social-accounts/microsoft/:integrationId]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/me/social-accounts/:provider', auth, async (req, res) => {
  const provider = sanitize(req.params.provider).toLowerCase();
  const allowed = ['google', 'facebook', 'discord', 'microsoft'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'invalid provider' });

  try {
    if (provider === 'microsoft') {
      // Remove integração Microsoft/Xbox — NÃO remove minecraft_name do usuário (pode ter sido vinculado manualmente)
      const { rows } = await pool.query(
        'DELETE FROM user_integrations WHERE user_id=$1 RETURNING mc_name',
        [req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'not linked' });
      const removedNames = rows.map(row => row.mc_name).filter(Boolean);
      if (removedNames.length) {
        await pool.query(
          'UPDATE users SET minecraft_name=NULL WHERE id=$1 AND minecraft_name = ANY($2)',
          [req.user.sub, removedNames]
        );
      }
    } else {
      const { rowCount } = await pool.query(
        'DELETE FROM social_accounts WHERE user_id=$1 AND provider=$2',
        [req.user.sub, provider]
      );
      if (!rowCount) return res.status(404).json({ error: 'not linked' });
    }

    await auditFromReq(req, {
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `Vínculo social removido: ${provider}`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/me/social-accounts/:provider]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/me/history', auth, async (req, res) => {
if (!req.user.minecraft_name)
return res.json({ history: [], activeSession: null });

const mc = req.user.minecraft_name.toLowerCase();
const hist = await pool.query(
'SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE LOWER(player)=$1 AND left_at IS NOT NULL ORDER BY entered_at DESC',
[mc],
);
const active = await pool.query(
'SELECT entered_at FROM player_sessions WHERE LOWER(player)=$1 AND left_at IS NULL',
[mc],
);

res.json({
history:       hist.rows,
activeSession: active.rows[0]?.entered_at || null,
});
});

// ─────────────────────────────────────────────
// SOCIAL / COMUNIDADE (Estilo Roblox/Twitter)
// ─────────────────────────────────────────────

// Lista pública de jogadores (Para a página Comunidade)
// SOCIAL V2: rotas profissionais de comunidade, registradas antes das legadas.
app.get('/api/community/players', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const search = req.query.search ? `%${sanitize(req.query.search).toLowerCase()}%` : null;
  const onlyFollowing = String(req.query.following || '').toLowerCase() === 'true';
  const params = [req.user.sub];
  const conditions = [
    'COALESCE(up.public_profile, TRUE) = TRUE',
    'u.id != $1',
    `NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
         OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
    )`,
  ];

  if (search) {
    params.push(search);
    conditions.push(`(LOWER(COALESCE(up.display_name, '')) LIKE $${params.length} OR LOWER(COALESCE(u.minecraft_name, '')) LIKE $${params.length} OR LOWER(u.username) LIKE $${params.length})`);
  }

  if (onlyFollowing) {
    conditions.push('EXISTS(SELECT 1 FROM user_follows uf WHERE uf.follower_id = $1 AND uf.following_id = u.id)');
  }

  params.push(limit);

  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified, COALESCE(up.bio, '') AS bio,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             COALESCE(pb.capital_balance, 0) AS capital,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             COALESCE(up.cover_url, '') AS cover_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count,
             (SELECT COUNT(*) FROM user_follows f1
              JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
              WHERE f1.follower_id = u.id)::int AS friends_count,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS is_following,
             EXISTS(SELECT 1 FROM user_follows f1
                    JOIN user_follows f2 ON f2.follower_id = u.id AND f2.following_id = $1
                    WHERE f1.follower_id = $1 AND f1.following_id = u.id) AS is_friend,
             EXISTS(SELECT 1 FROM player_sessions ps WHERE ps.left_at IS NULL AND LOWER(ps.player) = LOWER(u.minecraft_name)) AS is_online
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${conditions.join(' AND ')}
      ORDER BY is_online DESC, followers_count DESC, merit DESC, u.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/community/players]', e);
    res.status(500).json({ error: 'Erro ao buscar comunidade' });
  }
});

app.get('/api/community/player/:identifier/full-profile', auth, async (req, res) => {
  const ident = parseCommunityIdentifier(req.params.identifier);
  const where = ident.byId ? 'u.id = $2' : '(LOWER(u.minecraft_name) = $2 OR LOWER(u.username) = $2)';

  try {
    const { rows: profileRows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.created_at, u.role, u.is_platform_verified,
             COALESCE(up.bio, '') AS bio,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             COALESCE(up.cover_url, '') AS cover_url,
             COALESCE(up.profile_layout, 'posts') AS profile_layout,
             COALESCE(up.profile_links, '[]'::jsonb) AS profile_links,
             COALESCE(up.public_profile, TRUE) AS public_profile,
             COALESCE(up.public_history, FALSE) AS public_history,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             COALESCE(pb.capital_balance, 0) AS capital,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count,
             (SELECT COUNT(*) FROM user_follows WHERE follower_id = u.id)::int AS following_count,
             (SELECT COUNT(*) FROM user_follows f1
              JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
              WHERE f1.follower_id = u.id)::int AS friends_count,
             (SELECT COUNT(*) FROM user_posts WHERE author_id = u.id)::int AS posts_count,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id=$1 AND following_id=u.id) AS is_following,
             CASE
               WHEN EXISTS(SELECT 1 FROM user_follows WHERE follower_id=$1 AND following_id=u.id)
               THEN COALESCE((SELECT level FROM profile_notification_preferences WHERE subscriber_id=$1 AND creator_id=u.id), 'off')
               ELSE 'off'
             END AS notification_level,
             EXISTS(SELECT 1 FROM user_follows f1
                    JOIN user_follows f2 ON f2.follower_id = u.id AND f2.following_id = $1
                    WHERE f1.follower_id = $1 AND f1.following_id = u.id) AS is_friend,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=u.id) AS is_blocked_by_me,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=u.id AND blocked_id=$1) AS has_blocked_me
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${where}
      LIMIT 1
    `, [req.user.sub, ident.value]);

    const profile = profileRows[0];
    if (!profile) return res.status(404).json({ error: 'Jogador nao encontrado' });
    if (profile.has_blocked_me || (profile.is_blocked_by_me && Number(profile.id) !== Number(req.user.sub))) {
      return res.status(403).json({ error: 'Perfil indisponivel.' });
    }
    if (!profile.public_profile && Number(profile.id) !== Number(req.user.sub)) {
      return res.status(403).json({ error: 'Este perfil e privado.' });
    }

    const profileUserId = profile.id;
    const mcName = profile.minecraft_name || profile.username;
    const canSeeHistory = Boolean(profile.public_history) || Number(profile.id) === Number(req.user.sub);

    const [postsResult, repliesResult, repostsResult, statsResult, dailyResult, followResult] = await Promise.all([
      pool.query(`
        SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned,
               p.created_by_user_id,
               (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
               (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
               (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.is_deleted = FALSE)::int AS comments_count,
               EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=$1) AS liked_by_me,
               EXISTS(SELECT 1 FROM user_posts rp WHERE rp.repost_of_id=p.id AND rp.author_id=$1 AND rp.content = '') AS reposted_by_me
        FROM user_posts p
        WHERE p.author_id=$2
          AND p.repost_of_id IS NULL
        ORDER BY p.is_pinned DESC, p.pinned_at DESC NULLS LAST, p.created_at DESC
        LIMIT 12
      `, [req.user.sub, profileUserId]),
      pool.query(`
        SELECT pc.id AS comment_id, pc.content AS comment_content, pc.created_at AS comment_created_at,
               p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned,
               p.created_by_user_id,
               au.id AS author_id, au.username, au.minecraft_name, au.photo_url, au.role,
               COALESCE(aup.display_name, '') AS display_name,
               COALESCE(aup.avatar_url, '') AS avatar_url,
               ${primaryIntegrationFieldsSql('au')} AS integration,
               ${socialRankSql('au', 'pb')} AS rank,
               ${socialMeritSql('au', 'pb')} AS merit,
               (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
               (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
               (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.is_deleted = FALSE)::int AS comments_count,
               EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=$1) AS liked_by_me,
               EXISTS(SELECT 1 FROM user_posts rp WHERE rp.repost_of_id=p.id AND rp.author_id=$1 AND rp.content = '') AS reposted_by_me
        FROM post_comments pc
         JOIN user_posts p ON p.id = pc.post_id
         JOIN users au ON au.id = p.author_id
         LEFT JOIN user_preferences aup ON aup.user_id = au.id
         LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(au.minecraft_name)
        WHERE pc.author_id = $2
          AND pc.is_deleted = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id = $1 AND ub.blocked_id = au.id)
               OR (ub.blocker_id = au.id AND ub.blocked_id = $1)
          )
        ORDER BY pc.created_at DESC
        LIMIT 20
      `, [req.user.sub, profileUserId]),
      pool.query(`
        SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned, p.created_by_user_id, p.repost_of_id,
               op.content AS repost_original_content,
               op.media_urls AS repost_original_media_urls,
               op.created_at AS repost_original_created_at,
               ou.id AS repost_original_author_id,
                ou.username AS repost_original_username,
                ou.minecraft_name AS repost_original_minecraft_name,
                ou.photo_url AS repost_original_photo_url,
                ou.role AS repost_original_role,
                COALESCE(oup.display_name, '') AS repost_original_display_name,
                COALESCE(oup.avatar_url, '') AS repost_original_avatar_url,
                ${primaryIntegrationFieldsSql('ou')} AS repost_original_integration,
                ${socialRankSql('ou', 'opb')} AS repost_original_rank,
               ${socialMeritSql('ou', 'opb')} AS repost_original_merit,
               (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = COALESCE(p.repost_of_id, p.id))::int AS likes_count,
               (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = COALESCE(p.repost_of_id, p.id))::int AS reposts_count,
               (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = COALESCE(p.repost_of_id, p.id) AND pc.is_deleted = FALSE)::int AS comments_count,
               EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = COALESCE(p.repost_of_id, p.id) AND pl.user_id = $1) AS liked_by_me,
               EXISTS(SELECT 1 FROM user_posts rp WHERE rp.repost_of_id = COALESCE(p.repost_of_id, p.id) AND rp.author_id = $1 AND rp.content = '') AS reposted_by_me
        FROM user_posts p
         JOIN user_posts op ON op.id = p.repost_of_id
         JOIN users ou ON ou.id = op.author_id
         LEFT JOIN user_preferences oup ON oup.user_id = ou.id
         LEFT JOIN player_balances opb ON LOWER(opb.minecraft_name) = LOWER(ou.minecraft_name)
        WHERE p.author_id = $2
          AND p.repost_of_id IS NOT NULL
        ORDER BY p.created_at DESC
        LIMIT 20
      `, [req.user.sub, profileUserId]),
      canSeeHistory ? pool.query(`
        SELECT COUNT(*)::int AS total_sessions,
               COALESCE(SUM(duration_hours),0)::float AS total_hours,
               MAX(entered_at) AS last_seen
        FROM player_sessions
        WHERE LOWER(player)=LOWER($1)
      `, [mcName]) : Promise.resolve({ rows: [{ total_sessions: 0, total_hours: 0, last_seen: null }] }),
      canSeeHistory ? pool.query(`
        SELECT date_trunc('day', entered_at)::date AS day,
               COALESCE(SUM(duration_hours),0)::float AS hours
        FROM player_sessions
        WHERE LOWER(player)=LOWER($1)
          AND entered_at > NOW() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `, [mcName]) : Promise.resolve({ rows: [] }),
      pool.query('SELECT created_at FROM user_follows WHERE follower_id=$1 AND following_id=$2', [req.user.sub, profileUserId]),
    ]);

    const gameStats = canSeeHistory ? { ...(statsResult.rows[0] || {}), daily_hours: dailyResult.rows } : null;
    res.json({
      profile: { ...profile, rank_benefits: rankBenefits(profile.rank) },
      posts: postsResult.rows,
      replies: repliesResult.rows,
      reposts: repostsResult.rows,
      media: [],
      game_stats: gameStats,
      badges: buildProfileBadges(profile, gameStats || {}),
      follow_since: followResult.rows[0]?.created_at || null,
    });
  } catch (e) {
    console.error('[GET /api/community/player/:identifier/full-profile]', e);
    res.status(500).json({ error: 'Erro ao buscar perfil completo' });
  }
});

app.get('/api/community/player/:identifier', auth, async (req, res) => {
  const ident = parseCommunityIdentifier(req.params.identifier);
  const where = ident.byId ? 'u.id = $2' : '(LOWER(u.minecraft_name) = $2 OR LOWER(u.username) = $2)';
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.created_at, u.role, u.is_platform_verified,
             COALESCE(up.bio, '') AS bio,
             COALESCE(up.public_profile, TRUE) AS public_profile,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             COALESCE(pb.capital_balance, 0) AS capital,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count,
             (SELECT COUNT(*) FROM user_follows WHERE follower_id = u.id)::int AS following_count,
             (SELECT COUNT(*) FROM user_follows f1
              JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
              WHERE f1.follower_id = u.id)::int AS friends_count,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS is_following,
             EXISTS(SELECT 1 FROM user_follows f1
                    JOIN user_follows f2 ON f2.follower_id = u.id AND f2.following_id = $1
                    WHERE f1.follower_id = $1 AND f1.following_id = u.id) AS is_friend,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=u.id) AS is_blocked_by_me,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=u.id AND blocked_id=$1) AS has_blocked_me
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${where}
      LIMIT 1
    `, [req.user.sub, ident.value]);

    if (!rows.length) return res.status(404).json({ error: 'Jogador nao encontrado' });
    if (rows[0].has_blocked_me || (rows[0].is_blocked_by_me && Number(rows[0].id) !== Number(req.user.sub))) {
      return res.status(403).json({ error: 'Perfil indisponivel.' });
    }
    if (!rows[0].public_profile && Number(rows[0].id) !== Number(req.user.sub)) {
      return res.status(403).json({ error: 'Este perfil e privado.' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/community/player/:identifier]', e);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// Ver perfil público de um jogador específico
app.get('/api/community/player/:mc_name', auth, async (req, res) => {
  const mcName = sanitize(req.params.mc_name).toLowerCase();
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.created_at, up.bio, up.public_profile,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank, ${socialMeritSql('u', 'pb')} AS merit,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) AS followers_count,
             (SELECT COUNT(*) FROM user_follows WHERE follower_id = u.id) AS following_count,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS is_following
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE LOWER(u.minecraft_name) = $2 LIMIT 1
    `, [req.user.sub, mcName]);

    if (!rows.length) return res.status(404).json({ error: 'Jogador não encontrado' });
    if (!rows[0].public_profile && rows[0].id !== req.user.sub) {
      return res.status(403).json({ error: 'Este perfil é privado.' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// Seguir um jogador
app.get('/api/me/blocks', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 50);
  const cursor = req.query.cursor ? sanitize(req.query.cursor) : null;
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, ub.created_at,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank
      FROM user_blocks ub
      JOIN users u ON u.id = ub.blocked_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ub.blocker_id = $1
        AND ($2::timestamptz IS NULL OR ub.created_at < $2::timestamptz)
      ORDER BY ub.created_at DESC
      LIMIT $3
    `, [req.user.sub, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    res.json({ rows: page, next_cursor: rows.length > limit ? page.at(-1)?.created_at : null, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/me/blocks]', e);
    res.status(500).json({ error: 'Erro ao listar bloqueios' });
  }
});

app.post('/api/me/blocks/:userId', auth, async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId || targetId === req.user.sub) return res.status(400).json({ error: 'ID invalido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: target } = await client.query('SELECT id, username, minecraft_name FROM users WHERE id=$1', [targetId]);
    if (!target.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }
    await client.query('INSERT INTO user_blocks(blocker_id, blocked_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [req.user.sub, targetId]);
    await client.query(
      `DELETE FROM user_follows
       WHERE (follower_id=$1 AND following_id=$2)
          OR (follower_id=$2 AND following_id=$1)`,
      [req.user.sub, targetId],
    );
    await client.query('COMMIT');
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'security',
      severity: 'warning',
      targetId,
      targetName: target[0].minecraft_name || target[0].username,
      message: `Usuario bloqueado: ${target[0].minecraft_name || target[0].username}`,
    });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/me/blocks/:userId]', e);
    res.status(500).json({ error: 'Erro ao bloquear usuario' });
  } finally {
    client.release();
  }
});

app.delete('/api/me/blocks/:userId', auth, async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return res.status(400).json({ error: 'ID invalido' });
  try {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.sub, targetId]);
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'security',
      severity: 'info',
      targetId,
      message: `Usuario desbloqueado: #${targetId}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/me/blocks/:userId]', e);
    res.status(500).json({ error: 'Erro ao desbloquear usuario' });
  }
});

app.post('/api/me/follows/:targetId', auth, async (req, res) => {
  const targetId = parseInt(req.params.targetId, 10);
  if (!targetId || targetId === req.user.sub) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rows: target } = await pool.query('SELECT id, username, minecraft_name FROM users WHERE id=$1', [targetId]);
    if (!target.length) return res.status(404).json({ error: 'Usuario nao encontrado' });

    const allowed = await assertNoSocialBlock(req.user.sub, targetId);
    if (!allowed) return res.status(403).json({ error: 'Nao e possivel seguir este usuario.' });

    const { rowCount } = await pool.query(
      'INSERT INTO user_follows(follower_id, following_id) VALUES($1, $2) ON CONFLICT DO NOTHING',
      [req.user.sub, targetId],
    );
    if (rowCount > 0) {
      await pool.query(
        `INSERT INTO profile_notification_preferences(subscriber_id,creator_id,level)
         VALUES($1,$2,'off')
         ON CONFLICT(subscriber_id,creator_id) DO NOTHING`,
        [req.user.sub, targetId],
      );
      await createSocialNotification({
        recipientId: targetId,
        actorId: req.user.sub,
        type: 'new_follower',
        entityType: 'user',
        entityId: req.user.sub,
        previewText: `${req.user.minecraft_name || req.user.username} comecou a seguir voce.`,
      }).catch(err => console.error('[follow notification failed]', err));
      if (target[0]?.minecraft_name) {
        createMinecraftNotification({
          minecraftName: target[0].minecraft_name,
          title: 'Novo Seguidor!',
          body: `${req.user.minecraft_name || req.user.username} comecou a seguir voce.`,
          type: 'social',
          icon: '👤',
          createdBy: req.user.sub,
        }).catch(err => console.warn('[follow minecraft notification skipped]', err?.message || err));
      }
    }
    res.json({ ok: true, created: rowCount > 0 });
  } catch (e) {
    console.error('[POST /api/me/follows/:targetId]', e);
    res.status(500).json({ error: 'Erro ao seguir' });
  }
});

// Legacy endpoint disabled - returns 404 to signal clients to update
app.post('/api/me/follows-legacy-disabled/:targetId', auth, (_req, res) => {
  res.status(404).json({ error: 'Endpoint legado desativado. Use /api/me/follows/:targetId' });
});

// Parar de seguir
app.delete('/api/me/follows/:targetId', auth, async (req, res) => {
  const targetId = parseInt(req.params.targetId, 10);
  try {
    await pool.query('DELETE FROM user_follows WHERE follower_id=$1 AND following_id=$2', [req.user.sub, targetId]);
    await pool.query('DELETE FROM profile_notification_preferences WHERE subscriber_id=$1 AND creator_id=$2', [req.user.sub, targetId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/me/follows/:targetId]', e);
    res.status(500).json({ error: 'Erro ao deixar de seguir' });
  }
});

// ─────────────────────────────────────────────
app.get('/api/me/friends', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 250);
  const search = req.query.search ? `%${sanitize(req.query.search).toLowerCase()}%` : null;
  const params = [req.user.sub];
  const conditions = [
    'f1.follower_id = $1',
    `NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
         OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
    )`,
  ];

  if (search) {
    params.push(search);
    conditions.push(`(LOWER(COALESCE(u.minecraft_name, '')) LIKE $${params.length} OR LOWER(u.username) LIKE $${params.length})`);
  }
  params.push(limit);

  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
             f1.created_at AS followed_at,
             f2.created_at AS friend_since,
             COALESCE(up.bio, '') AS bio,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count,
             EXISTS(SELECT 1 FROM player_sessions ps WHERE ps.left_at IS NULL AND LOWER(ps.player) = LOWER(u.minecraft_name)) AS is_online
      FROM user_follows f1
      JOIN user_follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
      JOIN users u ON u.id = f1.following_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${conditions.join(' AND ')}
      ORDER BY is_online DESC, f2.created_at DESC, followers_count DESC
      LIMIT $${params.length}
    `, params);
    res.json({ rows });
  } catch (e) {
    console.error('[GET /api/me/friends]', e);
    res.status(500).json({ error: 'Erro ao listar amigos' });
  }
});

app.get('/api/me/friend-requests', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 50);
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
             uf.created_at,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id)::int AS followers_count
      FROM user_follows uf
      JOIN users u ON uf.follower_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE uf.following_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM user_follows back
          WHERE back.follower_id = $1 AND back.following_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY uf.created_at DESC
      LIMIT $2
    `, [req.user.sub, limit]);
    res.json({ rows });
  } catch (e) {
    console.error('[GET /api/me/friend-requests]', e);
    res.status(500).json({ error: 'Erro ao buscar solicitacoes' });
  }
});

app.get('/api/me/messages/unread-count', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT (
        SELECT COUNT(*)
        FROM direct_messages dm
        JOIN direct_conversations c ON c.id = dm.conversation_id
        LEFT JOIN direct_conversation_reads dcr ON dcr.conversation_id = c.id AND dcr.user_id = $1
        WHERE (c.participant_a = $1 OR c.participant_b = $1)
          AND dm.sender_id != $1
          AND dm.is_deleted = FALSE
          AND dm.created_at > COALESCE(dcr.last_read_at, 'epoch'::timestamptz)
      )::int + (
        SELECT COUNT(*)
        FROM chat_group_messages gm
        JOIN chat_group_members member ON member.group_id = gm.group_id AND member.user_id = $1
        WHERE gm.sender_id != $1
          AND gm.is_deleted = FALSE
          AND gm.created_at > COALESCE(member.last_read_at, 'epoch'::timestamptz)
      )::int AS count
    `, [req.user.sub]);
    res.json({ count: rows[0]?.count || 0 });
  } catch (e) {
    console.error('[GET /api/me/messages/unread-count]', e);
    res.status(500).json({ error: 'Erro ao contar mensagens' });
  }
});

app.get('/api/me/conversations', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 60);
  try {
    const { rows } = await pool.query(`
      ${directConversationSelect()}
      ORDER BY COALESCE(last_msg.created_at, c.last_message_at, c.created_at) DESC
      LIMIT $2
    `, [req.user.sub, limit]);
    res.json({ rows });
  } catch (e) {
    console.error('[GET /api/me/conversations]', e);
    res.status(500).json({ error: 'Erro ao listar conversas' });
  }
});

app.post('/api/me/conversations', auth, async (req, res) => {
  const targetId = parseInt(req.body?.target_id ?? req.body?.user_id, 10);
  if (!targetId || targetId === req.user.sub) return res.status(400).json({ error: 'Usuario invalido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: targetRows } = await client.query(
      `SELECT u.id,
              COALESCE(up.public_profile, TRUE) AS public_profile,
              EXISTS(SELECT 1 FROM user_follows f1
                     JOIN user_follows f2 ON f2.follower_id = u.id AND f2.following_id = $2
                     WHERE f1.follower_id = $2 AND f1.following_id = u.id) AS is_friend
       FROM users u
       LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [targetId, req.user.sub],
    );
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario nao encontrado' });
    }
    if (!targetRows[0].public_profile && !targetRows[0].is_friend) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Este perfil recebe mensagens apenas de amigos.' });
    }
    const { rows: blocked } = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1)
       LIMIT 1`,
      [req.user.sub, targetId],
    );
    if (blocked.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Nao e possivel enviar mensagem para este usuario.' });
    }

    const [participantA, participantB] = directPair(req.user.sub, targetId);
    const { rows } = await client.query(
      `INSERT INTO direct_conversations(participant_a, participant_b, created_by)
       VALUES($1, $2, $3)
       ON CONFLICT(participant_a, participant_b)
       DO UPDATE SET last_message_at = direct_conversations.last_message_at
       RETURNING id`,
      [participantA, participantB, req.user.sub],
    );
    await client.query(
      `INSERT INTO direct_conversation_reads(conversation_id, user_id, last_read_at)
       VALUES($1, $2, NOW())
       ON CONFLICT(conversation_id, user_id) DO NOTHING`,
      [rows[0].id, req.user.sub],
    );
    await client.query('COMMIT');

    const { rows: convRows } = await pool.query(`${directConversationSelect('AND c.id = $2')} LIMIT 1`, [req.user.sub, rows[0].id]);
    res.status(201).json(convRows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/me/conversations]', e);
    res.status(500).json({ error: 'Erro ao abrir conversa' });
  } finally {
    client.release();
  }
});

app.get('/api/me/conversations/:id/messages', auth, async (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  const limit = clampInt(req.query.limit, 40, 1, 80);
  const beforeId = req.query.before ? parseInt(req.query.before, 10) : null;
  if (!conversationId) return res.status(400).json({ error: 'Conversa invalida' });
  const params = [conversationId, req.user.sub, limit];
  const cursorClause = beforeId ? 'AND dm.id < $4' : '';
  if (beforeId) params.push(beforeId);

  try {
    const { rows: allowed } = await pool.query(
      `SELECT 1 FROM direct_conversations
       WHERE id=$2 AND (participant_a=$1 OR participant_b=$1)
       LIMIT 1`,
      [req.user.sub, conversationId],
    );
    if (!allowed.length) return res.status(404).json({ error: 'Conversa nao encontrada' });

    const { rows } = await pool.query(`
      SELECT dm.id, dm.conversation_id, dm.sender_id,
             CASE WHEN dm.is_deleted THEN '[mensagem removida]' ELSE dm.body END AS body,
             CASE WHEN dm.is_deleted THEN '[]'::jsonb ELSE COALESCE(dm.attachments, '[]'::jsonb) END AS attachments,
             dm.client_ref,
             dm.reply_to_message_id,
             dm.is_deleted, dm.created_at, dm.edited_at,
             u.username, u.minecraft_name, u.photo_url,
             CASE WHEN reply.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', reply.id,
               'sender_id', reply.sender_id,
               'body', CASE WHEN reply.is_deleted THEN '[mensagem removida]' ELSE reply.body END,
               'sender_name', COALESCE(reply_sender.minecraft_name, reply_sender.username, 'Jogador'),
               'is_deleted', reply.is_deleted
             ) END AS reply_to,
             COALESCE(reactions.items, '[]'::jsonb) AS reactions,
             COALESCE(my_reactions.items, '[]'::jsonb) AS my_reactions
      FROM direct_messages dm
      JOIN users u ON u.id = dm.sender_id
      LEFT JOIN direct_messages reply ON reply.id = dm.reply_to_message_id
      LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('emoji', grouped.emoji, 'count', grouped.total) ORDER BY grouped.latest_at) AS items
        FROM (
          SELECT emoji, COUNT(*)::int AS total, MAX(created_at) AS latest_at
          FROM direct_message_reactions
          WHERE message_id = dm.id
          GROUP BY emoji
        ) grouped
      ) reactions ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(emoji ORDER BY created_at) AS items
        FROM direct_message_reactions
        WHERE message_id = dm.id AND user_id = $2
      ) my_reactions ON TRUE
      WHERE dm.conversation_id = $1
        ${cursorClause}
      ORDER BY dm.id DESC
      LIMIT $3
    `, params);

    const ordered = rows.reverse();
    // Marca como lido (fire-and-forget) e notifica via SSE o peer
    const readAt = new Date().toISOString();
    pool.query(
      `INSERT INTO direct_conversation_reads(conversation_id, user_id, last_read_at)
       VALUES($1, $2, NOW())
       ON CONFLICT(conversation_id, user_id)
       DO UPDATE SET last_read_at = NOW()`,
      [conversationId, req.user.sub],
    ).then(() => {
      // ── SSE: notifica peer que as mensagens foram vistas
      notifyRead('direct', conversationId, req.user.sub, readAt);
    }).catch(err => console.warn('[direct read marker skipped]', err?.message || err));
    res.json({ rows: ordered, has_more: rows.length === limit, next_before: ordered[0]?.id || null });
  } catch (e) {
    console.error('[GET /api/me/conversations/:id/messages]', e);
    res.status(500).json({ error: 'Erro ao carregar mensagens' });
  }
});

app.post('/api/me/conversations/:id/messages', auth, async (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  const rawBody = sanitizeText(req.body?.body || req.body?.content || '');
  const attachments = normalizeChatAttachments(req.body?.attachments);
  const clientRef = normalizeClientRef(req.body?.client_ref);
  const replyToMessageId = req.body?.reply_to_message_id ? parseInt(req.body.reply_to_message_id, 10) : null;
  if (!conversationId) return res.status(400).json({ error: 'Conversa invalida' });
  if (rawBody.length > 500) return res.status(400).json({ error: 'Mensagem invalida. Use ate 500 caracteres.' });
  if (!rawBody && !attachments.length) return res.status(400).json({ error: 'Mensagem invalida. Escreva algo ou envie um anexo.' });
  const body = rawBody;

  const client = await pool.connect();
  let committed = false;
  let replyPreview = null;
  try {
    await client.query('BEGIN');
    const { rows: convRows } = await client.query(
      `SELECT id, participant_a, participant_b,
              CASE WHEN participant_a=$1 THEN participant_b ELSE participant_a END AS recipient_id
       FROM direct_conversations
       WHERE id=$2 AND (participant_a=$1 OR participant_b=$1)
       FOR UPDATE`,
      [req.user.sub, conversationId],
    );
    const conv = convRows[0];
    if (!conv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }
    const { rows: blocked } = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1)
       LIMIT 1`,
      [req.user.sub, conv.recipient_id],
    );
    if (blocked.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Nao e possivel enviar mensagem nesta conversa.' });
    }
    if (replyToMessageId) {
      const { rows: replyRows } = await client.query(
        `SELECT reply.id, reply.sender_id,
                CASE WHEN reply.is_deleted THEN '[mensagem removida]' ELSE reply.body END AS body,
                COALESCE(sender.minecraft_name, sender.username, 'Jogador') AS sender_name,
                reply.is_deleted
         FROM direct_messages reply
         JOIN users sender ON sender.id=reply.sender_id
         WHERE reply.id=$1 AND reply.conversation_id=$2
         LIMIT 1`,
        [replyToMessageId, conversationId],
      );
      if (!replyRows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Mensagem respondida nao pertence a esta conversa.' });
      }
      replyPreview = replyRows[0];
    }

    const { rows } = await client.query(
      `INSERT INTO direct_messages(conversation_id, sender_id, body, attachments, client_ref, reply_to_message_id)
       VALUES($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, conversation_id, sender_id, body, attachments, client_ref, reply_to_message_id, is_deleted, created_at, edited_at`,
      [conversationId, req.user.sub, body, JSON.stringify(attachments), clientRef, replyToMessageId],
    );
    await client.query('UPDATE direct_conversations SET last_message_at=NOW() WHERE id=$1', [conversationId]);
    await client.query(
      `INSERT INTO direct_conversation_reads(conversation_id, user_id, last_read_at)
       VALUES($1, $2, NOW())
       ON CONFLICT(conversation_id, user_id)
       DO UPDATE SET last_read_at = NOW()`,
      [conversationId, req.user.sub],
    );
    await client.query('COMMIT');
    committed = true;

    const messageNotification = await createSocialNotification({
      recipientId: conv.recipient_id,
      actorId: req.user.sub,
      type: 'direct_message',
      entityType: 'direct_message',
      entityId: rows[0].id,
      previewText: body || chatAttachmentPreviewText(attachments),
    }).catch(err => {
      console.error('[direct_message notification failed]', err);
      return null;
    });

    // ── SSE fan-out: push instantâneo para o peer (e outras abas do remetente)
    notifyNewMessage('direct', conversationId, {
      ...rows[0],
      reply_to: replyPreview,
      username: req.user.username,
      minecraft_name: req.user.minecraft_name,
    });

    res.status(201).json({ ...rows[0], reply_to: replyPreview, notification_created: Boolean(messageNotification) });
  } catch (e) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/me/conversations/:id/messages]', e);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  } finally {
    client.release();
  }
});

app.post('/api/me/conversations/:id/read', auth, async (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  if (!conversationId) return res.status(400).json({ error: 'Conversa invalida' });
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM direct_conversations
       WHERE id=$2 AND (participant_a=$1 OR participant_b=$1)
       LIMIT 1`,
      [req.user.sub, conversationId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversa nao encontrada' });
    await pool.query(
      `INSERT INTO direct_conversation_reads(conversation_id, user_id, last_read_at)
       VALUES($1, $2, NOW())
       ON CONFLICT(conversation_id, user_id)
       DO UPDATE SET last_read_at = NOW()`,
      [conversationId, req.user.sub],
    );
    // ── SSE: notifica o peer que esta conversa foi lida
    notifyRead('direct', conversationId, req.user.sub, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/me/conversations/:id/read]', e);
    res.status(500).json({ error: 'Erro ao marcar conversa como lida' });
  }
});

app.get('/api/me/group-conversations', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 60);
  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.name, g.owner_id, g.created_at, g.last_message_at,
             COUNT(gm.user_id)::int AS member_count,
             last_msg.id AS last_message_id,
             last_msg.body AS last_message_body,
             COALESCE(last_msg.attachments, '[]'::jsonb) AS last_message_attachments,
             last_msg.sender_id AS last_message_sender_id,
             last_msg.created_at AS last_message_at,
             COALESCE(sender.minecraft_name, sender.username) AS last_sender_name,
             COALESCE(unread.count, 0)::int AS unread_count
      FROM chat_groups g
      JOIN chat_group_members me ON me.group_id = g.id AND me.user_id = $1
      JOIN chat_group_members gm ON gm.group_id = g.id
      LEFT JOIN LATERAL (
        SELECT id, body, attachments, sender_id, created_at
        FROM chat_group_messages
        WHERE group_id = g.id AND is_deleted = FALSE
        ORDER BY id DESC
        LIMIT 1
      ) last_msg ON TRUE
      LEFT JOIN users sender ON sender.id = last_msg.sender_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count
        FROM chat_group_messages msg
        WHERE msg.group_id = g.id
          AND msg.sender_id != $1
          AND msg.is_deleted = FALSE
          AND msg.created_at > COALESCE(me.last_read_at, 'epoch'::timestamptz)
      ) unread ON TRUE
      GROUP BY g.id, last_msg.id, last_msg.body, last_msg.attachments, last_msg.sender_id, last_msg.created_at, sender.minecraft_name, sender.username, unread.count
      ORDER BY COALESCE(last_msg.created_at, g.last_message_at, g.created_at) DESC
      LIMIT $2
    `, [req.user.sub, limit]);
    res.json({ rows });
  } catch (e) {
    console.error('[GET /api/me/group-conversations]', e);
    res.status(500).json({ error: 'Erro ao listar grupos' });
  }
});

app.post('/api/me/group-conversations', auth, async (req, res) => {
  const name = sanitize(req.body?.name || '').slice(0, 80);
  const memberIds = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(id => parseInt(id, 10)).filter(Boolean) : [];
  const uniqueMemberIds = [...new Set([req.user.sub, ...memberIds])].slice(0, 20);
  if (!name || name.length < 2) return res.status(400).json({ error: 'Nome do grupo invalido.' });
  if (uniqueMemberIds.length < 2) return res.status(400).json({ error: 'Escolha pelo menos uma pessoa.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: allowedRows } = await client.query(
      `SELECT u.id
       FROM users u
       LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.id = ANY($2::int[])
         AND (u.id = $1 OR COALESCE(up.public_profile, TRUE) = TRUE)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
         )`,
      [req.user.sub, uniqueMemberIds],
    );
    const allowed = allowedRows.map(row => Number(row.id));
    if (!allowed.includes(Number(req.user.sub)) || allowed.length < 2) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Nao foi possivel criar grupo com esses membros.' });
    }
    const { rows } = await client.query(
      'INSERT INTO chat_groups(name, owner_id) VALUES($1, $2) RETURNING id, name, owner_id, created_at, last_message_at',
      [name, req.user.sub],
    );
    const group = rows[0];
    for (const userId of allowed) {
      await client.query(
        `INSERT INTO chat_group_members(group_id, user_id, role, last_read_at)
         VALUES($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [group.id, userId, Number(userId) === Number(req.user.sub) ? 'owner' : 'member'],
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...group, member_count: allowed.length, unread_count: 0 });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/me/group-conversations]', e);
    res.status(500).json({ error: 'Erro ao criar grupo' });
  } finally {
    client.release();
  }
});

app.get('/api/me/group-conversations/:id/messages', auth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const limit = clampInt(req.query.limit, 50, 1, 80);
  if (!groupId) return res.status(400).json({ error: 'Grupo invalido' });
  try {
    const { rows: allowed } = await pool.query('SELECT 1 FROM chat_group_members WHERE group_id=$2 AND user_id=$1 LIMIT 1', [req.user.sub, groupId]);
    if (!allowed.length) return res.status(404).json({ error: 'Grupo nao encontrado' });
    const { rows } = await pool.query(`
      SELECT msg.id, msg.group_id, msg.sender_id,
             CASE WHEN msg.is_deleted THEN '[mensagem removida]' ELSE msg.body END AS body,
             CASE WHEN msg.is_deleted THEN '[]'::jsonb ELSE COALESCE(msg.attachments, '[]'::jsonb) END AS attachments,
             msg.client_ref,
             msg.reply_to_message_id,
             msg.created_at, msg.edited_at, msg.is_deleted,
             u.username, u.minecraft_name, u.photo_url,
             CASE WHEN reply.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', reply.id,
               'sender_id', reply.sender_id,
               'body', CASE WHEN reply.is_deleted THEN '[mensagem removida]' ELSE reply.body END,
               'sender_name', COALESCE(reply_sender.minecraft_name, reply_sender.username, 'Jogador'),
               'is_deleted', reply.is_deleted
             ) END AS reply_to,
             COALESCE(reactions.items, '[]'::jsonb) AS reactions,
             COALESCE(my_reactions.items, '[]'::jsonb) AS my_reactions
      FROM chat_group_messages msg
      JOIN users u ON u.id = msg.sender_id
      LEFT JOIN chat_group_messages reply ON reply.id = msg.reply_to_message_id
      LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('emoji', grouped.emoji, 'count', grouped.total) ORDER BY grouped.latest_at) AS items
        FROM (
          SELECT emoji, COUNT(*)::int AS total, MAX(created_at) AS latest_at
          FROM group_message_reactions
          WHERE message_id = msg.id
          GROUP BY emoji
        ) grouped
      ) reactions ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(emoji ORDER BY created_at) AS items
        FROM group_message_reactions
        WHERE message_id = msg.id AND user_id = $2
      ) my_reactions ON TRUE
      WHERE msg.group_id = $1
      ORDER BY msg.id DESC
      LIMIT $3
    `, [groupId, req.user.sub, limit]);
    pool.query('UPDATE chat_group_members SET last_read_at=NOW() WHERE group_id=$1 AND user_id=$2', [groupId, req.user.sub])
      .catch(err => console.warn('[group read marker skipped]', err?.message || err));
    res.json({ rows: rows.reverse() });
  } catch (e) {
    console.error('[GET /api/me/group-conversations/:id/messages]', e);
    res.status(500).json({ error: 'Erro ao carregar mensagens do grupo' });
  }
});

app.post('/api/me/group-conversations/:id/messages', auth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const rawBody = sanitizeText(req.body?.body || '');
  const attachments = normalizeChatAttachments(req.body?.attachments);
  const clientRef = normalizeClientRef(req.body?.client_ref);
  const replyToMessageId = req.body?.reply_to_message_id ? parseInt(req.body.reply_to_message_id, 10) : null;
  if (!groupId) return res.status(400).json({ error: 'Grupo invalido' });
  if (rawBody.length > 500) return res.status(400).json({ error: 'Mensagem invalida. Use ate 500 caracteres.' });
  if (!rawBody && !attachments.length) return res.status(400).json({ error: 'Mensagem invalida.' });
  const body = rawBody;
  const client = await pool.connect();
  let replyPreview = null;
  try {
    await client.query('BEGIN');
    const { rows: allowed } = await client.query('SELECT 1 FROM chat_group_members WHERE group_id=$2 AND user_id=$1 LIMIT 1', [req.user.sub, groupId]);
    if (!allowed.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Grupo nao encontrado' });
    }
    if (replyToMessageId) {
      const { rows: replyRows } = await client.query(
        `SELECT reply.id, reply.sender_id,
                CASE WHEN reply.is_deleted THEN '[mensagem removida]' ELSE reply.body END AS body,
                COALESCE(sender.minecraft_name, sender.username, 'Jogador') AS sender_name,
                reply.is_deleted
         FROM chat_group_messages reply
         JOIN users sender ON sender.id=reply.sender_id
         WHERE reply.id=$1 AND reply.group_id=$2
         LIMIT 1`,
        [replyToMessageId, groupId],
      );
      if (!replyRows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Mensagem respondida nao pertence a este grupo.' });
      }
      replyPreview = replyRows[0];
    }
    const { rows } = await client.query(
      `INSERT INTO chat_group_messages(group_id, sender_id, body, attachments, client_ref, reply_to_message_id)
       VALUES($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, group_id, sender_id, body, attachments, client_ref, reply_to_message_id, is_deleted, created_at, edited_at`,
      [groupId, req.user.sub, body, JSON.stringify(attachments), clientRef, replyToMessageId],
    );
    await client.query('UPDATE chat_groups SET last_message_at=NOW() WHERE id=$1', [groupId]);
    await client.query('UPDATE chat_group_members SET last_read_at=NOW() WHERE group_id=$1 AND user_id=$2', [groupId, req.user.sub]);
    await client.query('COMMIT');
    // ── SSE fan-out: push instantâneo para membros do grupo
    notifyNewMessage('group', groupId, {
      ...rows[0],
      reply_to: replyPreview,
      username: req.user.username,
      minecraft_name: req.user.minecraft_name,
    });
    res.status(201).json({ ...rows[0], reply_to: replyPreview });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/me/group-conversations/:id/messages]', e);
    res.status(500).json({ error: 'Erro ao enviar mensagem no grupo' });
  } finally {
    client.release();
  }
});

async function chatMessageContext(kind, containerId, messageId, viewerId, db = pool) {
  const isGroup = kind === 'group';
  const table = isGroup ? 'chat_group_messages' : 'direct_messages';
  const containerColumn = isGroup ? 'group_id' : 'conversation_id';
  const membership = isGroup
    ? 'EXISTS (SELECT 1 FROM chat_group_members gm WHERE gm.group_id=msg.group_id AND gm.user_id=$3)'
    : 'EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.id=msg.conversation_id AND (dc.participant_a=$3 OR dc.participant_b=$3))';
  const { rows } = await db.query(
    `SELECT msg.id, msg.${containerColumn} AS container_id, msg.sender_id, msg.body, msg.attachments,
            msg.reply_to_message_id, msg.is_deleted, msg.created_at, msg.edited_at
     FROM ${table} msg
     WHERE msg.id=$1 AND msg.${containerColumn}=$2 AND ${membership}
     LIMIT 1`,
    [messageId, containerId, viewerId],
  );
  return rows[0] || null;
}

async function chatReactionSummary(kind, messageId, viewerId, db = pool) {
  const table = kind === 'group' ? 'group_message_reactions' : 'direct_message_reactions';
  const { rows } = await db.query(
    `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id=$2) AS reacted_by_me
     FROM ${table}
     WHERE message_id=$1
     GROUP BY emoji
     ORDER BY MAX(created_at)`,
    [messageId, viewerId],
  );
  return {
    reactions: rows.map(row => ({ emoji: row.emoji, count: row.count })),
    my_reactions: rows.filter(row => row.reacted_by_me).map(row => row.emoji),
  };
}

function registerChatMessageInteractionRoutes(kind) {
  const isGroup = kind === 'group';
  const base = isGroup ? '/api/me/group-conversations/:containerId/messages/:messageId' : '/api/me/conversations/:containerId/messages/:messageId';
  const table = isGroup ? 'chat_group_messages' : 'direct_messages';
  const reactionTable = isGroup ? 'group_message_reactions' : 'direct_message_reactions';

  app.patch(base, auth, async (req, res) => {
    const containerId = parseInt(req.params.containerId, 10);
    const messageId = parseInt(req.params.messageId, 10);
    const body = sanitizeText(req.body?.body || '');
    if (!containerId || !messageId) return res.status(400).json({ error: 'Mensagem invalida.' });
    if (!body || body.length > 500) return res.status(400).json({ error: 'Use entre 1 e 500 caracteres.' });
    try {
      const message = await chatMessageContext(kind, containerId, messageId, req.user.sub);
      if (!message) return res.status(404).json({ error: 'Mensagem nao encontrada.' });
      if (Number(message.sender_id) !== Number(req.user.sub)) return res.status(403).json({ error: 'Voce so pode editar suas mensagens.' });
      if (message.is_deleted) return res.status(409).json({ error: 'Mensagem removida nao pode ser editada.' });
      const { rows } = await pool.query(
        `UPDATE ${table} SET body=$1, edited_at=NOW() WHERE id=$2 RETURNING id, body, edited_at, is_deleted`,
        [body, messageId],
      );
      const update = { ...rows[0], sender_id: req.user.sub, [isGroup ? 'group_id' : 'conversation_id']: containerId };
      notifyMessageUpdate(kind, containerId, update);
      res.json(update);
    } catch (e) {
      console.error(`[PATCH ${base}]`, e);
      res.status(500).json({ error: 'Erro ao editar mensagem.' });
    }
  });

  app.delete(base, auth, async (req, res) => {
    const containerId = parseInt(req.params.containerId, 10);
    const messageId = parseInt(req.params.messageId, 10);
    if (!containerId || !messageId) return res.status(400).json({ error: 'Mensagem invalida.' });
    try {
      const message = await chatMessageContext(kind, containerId, messageId, req.user.sub);
      if (!message) return res.status(404).json({ error: 'Mensagem nao encontrada.' });
      if (Number(message.sender_id) !== Number(req.user.sub)) return res.status(403).json({ error: 'Voce so pode remover suas mensagens.' });
      const { rows } = await pool.query(
        `UPDATE ${table}
         SET is_deleted=TRUE, deleted_at=NOW(), body='', attachments='[]'::jsonb
         WHERE id=$1
         RETURNING id, is_deleted, deleted_at`,
        [messageId],
      );
      const update = {
        ...rows[0],
        body: '[mensagem removida]',
        attachments: [],
        sender_id: req.user.sub,
        [isGroup ? 'group_id' : 'conversation_id']: containerId,
      };
      notifyMessageUpdate(kind, containerId, update);
      res.json(update);
    } catch (e) {
      console.error(`[DELETE ${base}]`, e);
      res.status(500).json({ error: 'Erro ao remover mensagem.' });
    }
  });

  app.post(`${base}/reactions`, auth, async (req, res) => {
    const containerId = parseInt(req.params.containerId, 10);
    const messageId = parseInt(req.params.messageId, 10);
    const emoji = String(req.body?.emoji || '').trim();
    if (!containerId || !messageId || !CHAT_REACTIONS.has(emoji)) return res.status(400).json({ error: 'Reacao invalida.' });
    try {
      const message = await chatMessageContext(kind, containerId, messageId, req.user.sub);
      if (!message || message.is_deleted) return res.status(404).json({ error: 'Mensagem nao encontrada.' });
      await pool.query(
        `INSERT INTO ${reactionTable}(message_id, user_id, emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [messageId, req.user.sub, emoji],
      );
      const summary = await chatReactionSummary(kind, messageId, req.user.sub);
      const update = { id: messageId, sender_id: message.sender_id, ...summary, [isGroup ? 'group_id' : 'conversation_id']: containerId };
      notifyMessageUpdate(kind, containerId, { ...update, my_reactions: undefined });
      if (Number(message.sender_id) !== Number(req.user.sub)) {
        await createSocialNotification({
          recipientId: message.sender_id,
          actorId: req.user.sub,
          type: 'message_reaction',
          entityType: isGroup ? 'group_message' : 'direct_message',
          entityId: messageId,
          previewText: `${emoji} ${String(message.body || '').slice(0, 90)}`,
        }).catch(err => console.error('[message reaction notification failed]', err));
      }
      res.json(update);
    } catch (e) {
      console.error(`[POST ${base}/reactions]`, e);
      res.status(500).json({ error: 'Erro ao reagir a mensagem.' });
    }
  });

  app.delete(`${base}/reactions/:emoji`, auth, async (req, res) => {
    const containerId = parseInt(req.params.containerId, 10);
    const messageId = parseInt(req.params.messageId, 10);
    const emoji = String(req.params.emoji || '').trim();
    if (!containerId || !messageId || !CHAT_REACTIONS.has(emoji)) return res.status(400).json({ error: 'Reacao invalida.' });
    try {
      const message = await chatMessageContext(kind, containerId, messageId, req.user.sub);
      if (!message) return res.status(404).json({ error: 'Mensagem nao encontrada.' });
      await pool.query(`DELETE FROM ${reactionTable} WHERE message_id=$1 AND user_id=$2 AND emoji=$3`, [messageId, req.user.sub, emoji]);
      const summary = await chatReactionSummary(kind, messageId, req.user.sub);
      const update = { id: messageId, sender_id: message.sender_id, ...summary, [isGroup ? 'group_id' : 'conversation_id']: containerId };
      notifyMessageUpdate(kind, containerId, { ...update, my_reactions: undefined });
      res.json(update);
    } catch (e) {
      console.error(`[DELETE ${base}/reactions/:emoji]`, e);
      res.status(500).json({ error: 'Erro ao remover reacao.' });
    }
  });
}

registerChatMessageInteractionRoutes('direct');
registerChatMessageInteractionRoutes('group');

// FEED DE ATIVIDADES (Postagens locais do site)
// ─────────────────────────────────────────────
app.get('/api/community/trending-hashtags', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT LOWER(tag_match[1]) AS tag, COUNT(*)::int AS count
      FROM user_posts,
           regexp_matches(content, '#([a-zA-Z0-9_À-ÿ]{2,32})', 'g') AS tag_match
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY LOWER(tag_match[1])
      ORDER BY count DESC, tag ASC
      LIMIT 5
    `);
    res.json({ trends: rows });
  } catch (e) {
    console.error('[GET /api/community/trending-hashtags]', e);
    res.status(500).json({ error: 'Erro ao buscar hashtags' });
  }
});

// Extrai usuários mencionados (ex: @joao_gamer)
function extractMentions(text) {
  const regex = /@([a-z0-9_]{3,32})/gi;
  const matches = [...text.matchAll(regex)];
  return [...new Set(matches.map(m => m[1].toLowerCase()))];
}

// Criar uma postagem com suporte a Menções (@)
app.get('/api/community/affiliations', auth, async (req, res) => {
  try {
    const { rows: identities } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.role,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             TRUE AS is_self,
             NULL::bigint AS affiliation_id,
             NULL::timestamptz AS granted_at,
             NULL::timestamptz AS last_used_at
      FROM users u
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE u.id = $1
      UNION ALL
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.role,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             FALSE AS is_self,
             af.id AS affiliation_id,
             af.created_at AS granted_at,
             af.last_used_at
      FROM account_affiliations af
      JOIN users u ON u.id = af.owner_user_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE af.delegate_user_id = $1
        AND af.status = 'active'
        AND 'post' = ANY(af.scopes)
      ORDER BY is_self DESC, display_name ASC, username ASC
    `, [req.user.sub]);

    const { rows: delegates } = await pool.query(`
      SELECT af.id AS affiliation_id,
             af.status,
             af.created_at AS granted_at,
             af.last_used_at,
             d.id, d.username, d.minecraft_name, d.photo_url, d.role,
             COALESCE(dup.display_name, '') AS display_name,
             COALESCE(dup.avatar_url, '') AS avatar_url,
             ${socialRankSql('d', 'dpb')} AS rank,
             ${socialMeritSql('d', 'dpb')} AS merit,
             ${primaryIntegrationFieldsSql('d')} AS integration
      FROM account_affiliations af
      JOIN users d ON d.id = af.delegate_user_id
      LEFT JOIN user_preferences dup ON dup.user_id = d.id
      LEFT JOIN player_balances dpb ON LOWER(dpb.minecraft_name) = LOWER(d.minecraft_name)
      WHERE af.owner_user_id = $1
        AND af.status = 'active'
        AND 'post' = ANY(af.scopes)
      ORDER BY af.created_at DESC
    `, [req.user.sub]);

    res.json({ publishing_identities: identities, granted_delegates: delegates });
  } catch (e) {
    console.error('[GET /api/community/affiliations]', e);
    res.status(500).json({ error: 'Erro ao carregar contas afiliadas.' });
  }
});

app.post('/api/community/affiliations', auth, affiliationLimiter, async (req, res) => {
  const rawIdentifier = sanitize(req.body?.username || req.body?.identifier || '').replace(/^@/, '').toLowerCase();
  if (!rawIdentifier || rawIdentifier.length < 3 || rawIdentifier.length > 64) {
    return res.status(400).json({ error: 'Informe um usuario valido.' });
  }
  if (req.user.is_verified === false) {
    return res.status(403).json({ error: 'Verifique sua conta antes de autorizar afiliadas.' });
  }

  try {
    const { rows: targetRows } = await pool.query(
      `SELECT id, username, minecraft_name, role, is_verified
       FROM users u
       WHERE LOWER(u.username) = $1
          OR LOWER(COALESCE(u.minecraft_name, '')) = $1
          OR EXISTS (
            SELECT 1
            FROM user_integrations ui
            WHERE ui.user_id = u.id
              AND LOWER(COALESCE(ui.xbox_gamertag, '')) = $1
          )
       LIMIT 1`,
      [rawIdentifier],
    );
    const delegate = targetRows[0];
    if (!delegate) return res.status(404).json({ error: 'Usuario nao encontrado.' });
    if (Number(delegate.id) === Number(req.user.sub)) {
      return res.status(400).json({ error: 'Voce ja pode publicar pela sua propria conta.' });
    }
    if (delegate.is_verified === false) {
      return res.status(400).json({ error: 'A conta autorizada precisa estar verificada.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO account_affiliations(owner_user_id, delegate_user_id, status, scopes, created_by, created_at, updated_at, revoked_at)
       VALUES($1, $2, 'active', ARRAY['post']::text[], $1, NOW(), NOW(), NULL)
       ON CONFLICT(owner_user_id, delegate_user_id)
       DO UPDATE SET status='active',
                     scopes=ARRAY['post']::text[],
                     updated_at=NOW(),
                     revoked_at=NULL
       RETURNING id, owner_user_id, delegate_user_id, created_at`,
      [req.user.sub, delegate.id],
    );

    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'security',
      severity: 'warning',
      targetId: delegate.id,
      targetName: delegate.username,
      message: `${req.user.username} autorizou ${delegate.username} a publicar como sua conta`,
      metadata: { affiliation_id: rows[0].id, scope: 'post' },
    });

    res.status(201).json({ ok: true, affiliation: rows[0], delegate });
  } catch (e) {
    console.error('[POST /api/community/affiliations]', e);
    res.status(500).json({ error: 'Erro ao autorizar conta afiliada.' });
  }
});

app.delete('/api/community/affiliations/:id', auth, affiliationLimiter, async (req, res) => {
  const affiliationId = parseInt(req.params.id, 10);
  if (!affiliationId) return res.status(400).json({ error: 'ID invalido.' });
  try {
    const { rows } = await pool.query(
      `UPDATE account_affiliations
       SET status='revoked', revoked_at=NOW(), updated_at=NOW()
       WHERE id=$1
         AND status='active'
         AND (owner_user_id=$2 OR delegate_user_id=$2)
       RETURNING id, owner_user_id, delegate_user_id`,
      [affiliationId, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'Afiliacao nao encontrada.' });

    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'security',
      severity: 'warning',
      targetId: affiliationId,
      message: `Afiliacao #${affiliationId} revogada`,
      metadata: rows[0],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/community/affiliations/:id]', e);
    res.status(500).json({ error: 'Erro ao revogar afiliacao.' });
  }
});

function uploadCommunityImage(file, userId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = url => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const timeout = setTimeout(() => {
      fail(new Error('Cloudinary demorou para responder ao upload.'));
    }, 30000);
    const folder = process.env.CLOUDINARY_COMMUNITY_FOLDER || 'forca-aliada/community-posts';
    const stream = cloudinary.uploader.upload_stream({
      folder,
      resource_type: 'image',
      format: 'webp',
      use_filename: false,
      unique_filename: true,
      overwrite: false,
      context: { uploaded_by: String(userId || '') },
      // Resize: limite de 1600px no lado maior (c_limit não aumenta imagens menores).
      // quality:auto:good — visualmente transparente na tela, melhor que :eco para fotos.
      // strip_profile — remove EXIF/ICC sem afetar visual (poupa ~10-30KB por imagem).
      transformation: [
        { width: 1600, height: 1600, crop: 'limit' },
        { fetch_format: 'webp', quality: 'auto:good', flags: 'strip_profile' },
      ],
    }, (err, result) => {
      clearTimeout(timeout);
      if (err) return fail(err);
      if (!result?.secure_url) return fail(new Error('Cloudinary nao retornou URL segura.'));
      done(result.secure_url);
    });
    stream.on?.('error', err => {
      clearTimeout(timeout);
      fail(err);
    });
    stream.end(file.buffer);
  });
}

function uploadChatAttachment(file, userId) {
  const kind = chatAttachmentKind(file);
  if (!kind) throw new Error('Tipo de arquivo nao permitido.');

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = result => {
      if (settled) return;
      settled = true;
      if (!result?.secure_url) return fail(new Error('Cloudinary nao retornou URL segura.'));
      resolve({
        url: result.secure_url,
        type: kind,
        name: cleanFileName(file.originalname || result.original_filename || 'arquivo'),
        mime_type: file.mimetype || '',
        size: Number(result.bytes || file.size || 0) || 0,
        width: Number(result.width || 0) || null,
        height: Number(result.height || 0) || null,
        duration: Number(result.duration || 0) || null,
      });
    };
    const timeout = setTimeout(() => {
      fail(new Error('Cloudinary demorou para responder ao upload.'));
    }, 60000);
    // Cloudinary free tier não suporta resource_type:'video' para áudio.
    // Áudio vai como 'raw' — armazenado e entregue como URL direta sem transformação.
    // use_filename:true preserva a extensão (.webm/.ogg/.m4a) no public_id,
    // fazendo o Cloudinary servir com Content-Type correto (audio/webm etc.)
    // em vez de application/octet-stream (que causa download automático no browser).
    const resourceType = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'raw';
    const isAudio = kind === 'audio';
    const folder = process.env.CLOUDINARY_CHAT_FOLDER || `forca-aliada/chat/${kind}`;
    const options = {
      folder,
      resource_type: resourceType,
      use_filename: isAudio,      // áudio: preserva extensão na URL
      unique_filename: true,
      overwrite: false,
      context: {
        uploaded_by: String(userId || ''),
        original_name: cleanFileName(file.originalname || 'arquivo'),
      },
    };
    if (kind === 'image' && !/^image\/gif$/i.test(file.mimetype || '')) {
      options.format = 'webp';
      // Chat: 1200px máximo — imagens de chat são menores que posts no feed.
      options.transformation = [
        { width: 1200, height: 1200, crop: 'limit' },
        { fetch_format: 'webp', quality: 'auto:good', flags: 'strip_profile' },
      ];
    }
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      clearTimeout(timeout);
      if (err) return fail(err);
      done(result);
    });
    stream.on?.('error', err => {
      clearTimeout(timeout);
      fail(err);
    });
    stream.end(file.buffer);
  });
}

app.post('/api/community/upload', auth, uploadLimiter, communityMediaUploadMiddleware, async (req, res) => {
  if (!cloudinaryIsConfigured()) {
    return res.status(503).json({ error: 'Upload de imagens ainda nao esta configurado.' });
  }
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ error: 'Selecione ao menos uma imagem.' });
  if (files.length > 4) return res.status(400).json({ error: 'Envie no maximo 4 imagens por post.' });

  try {
    // ── Moderação: analisa todas as imagens antes de qualquer upload ──────────
    const moderationResults = await Promise.all(files.map(f => moderateImageBuffer(f.buffer)));
    for (const result of moderationResults) {
      if (result.verdict === 'rejected') {
        console.warn(`[Moderation] Imagem rejeitada (${result.reason}) — user ${req.user.sub}`);
        return res.status(422).json({ error: 'Uma ou mais imagens contêm conteúdo impróprio e não podem ser publicadas.' });
      }
    }
    const hasSuspicious = moderationResults.some(r => r.verdict === 'suspicious');
    // ─────────────────────────────────────────────────────────────────────────

    const urls = await Promise.all(files.map(file => uploadCommunityImage(file, req.user.sub)));

    // Se alguma imagem ficou na zona cinza, enfileira o post para revisão do admin.
    // O post_id ainda não existe aqui (criado em /api/community/posts), então
    // marcamos o upload temporário pelo userId para que o admin possa revisar.
    if (hasSuspicious) {
      console.warn(`[Moderation] Imagens suspeitas de user ${req.user.sub} — enfileiradas para revisão.`);
      await queueForModeration('community_upload_user', req.user.sub);
    }

    res.status(201).json({ urls, flagged: hasSuspicious });
  } catch (e) {
    console.error('[POST /api/community/upload]', e);
    res.status(502).json({ error: 'Nao foi possivel enviar as imagens agora.' });
  }
});

// ── Upload de imagem de perfil (avatar / capa) ─────────────────────────────
// Endpoint único que recebe o campo 'file', faz upload para o Cloudinary e
// retorna { url } — compatível com o uploadImageBlob() do frontend.
// Chat attachments: recebe ate 4 arquivos no campo 'files' e retorna metadados seguros.
app.post('/api/me/chat/attachments', auth, uploadLimiter, chatAttachmentUploadMiddleware, async (req, res) => {
  if (!cloudinaryIsConfigured()) {
    return res.status(503).json({ error: 'Upload de anexos ainda nao esta configurado.' });
  }
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ error: 'Selecione ao menos um arquivo.' });
  if (files.length > CHAT_ATTACHMENT_MAX_FILES) {
    return res.status(400).json({ error: 'Envie no maximo 4 anexos por mensagem.' });
  }

  try {
    const imageFiles = files.filter(file => chatAttachmentKind(file) === 'image');
    const moderationResults = await Promise.all(imageFiles.map(file => moderateImageBuffer(file.buffer)));
    for (const result of moderationResults) {
      if (result.verdict === 'rejected') {
        console.warn(`[Moderation] Anexo de chat rejeitado (${result.reason}) - user ${req.user.sub}`);
        return res.status(422).json({ error: 'Uma imagem contem conteudo improprio e nao pode ser enviada.' });
      }
    }

    const attachments = await Promise.all(files.map(file => uploadChatAttachment(file, req.user.sub)));
    res.status(201).json({
      attachments,
      flagged: moderationResults.some(result => result.verdict === 'suspicious'),
    });
  } catch (e) {
    console.error('[POST /api/me/chat/attachments]', e);
    res.status(502).json({ error: 'Nao foi possivel enviar o anexo agora.' });
  }
});

// Upload de imagem de perfil (avatar / capa).
const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(file.mimetype || '')) {
      return cb(new Error('Envie apenas imagens.'));
    }
    cb(null, true);
  },
});

function profileImageUploadMiddleware(req, res, next) {
  profileImageUpload.single('file')(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'A imagem pode ter no máximo 10MB.'
        : `Upload inválido (${err.code}).`;
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: err.message || 'Upload inválido.' });
  });
}

app.post('/api/upload', auth, uploadLimiter, profileImageUploadMiddleware, async (req, res) => {
  if (!cloudinaryIsConfigured()) {
    return res.status(503).json({ error: 'Upload de imagens ainda não está configurado.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Selecione uma imagem.' });

  try {
    // ── Moderação: analisa antes de subir pro Cloudinary ─────────────────────
    const modResult = await moderateImageBuffer(req.file.buffer);
    if (modResult.verdict === 'rejected') {
      console.warn(`[Moderation] Imagem de perfil rejeitada (${modResult.reason}) — user ${req.user.sub}`);
      return res.status(422).json({ error: 'A imagem contém conteúdo impróprio e não pode ser usada como foto de perfil.' });
    }
    if (modResult.verdict === 'suspicious') {
      console.warn(`[Moderation] Imagem de perfil suspeita — user ${req.user.sub}, enfileirando para revisão.`);
      await queueForModeration('profile_image_user', req.user.sub);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const folder = process.env.CLOUDINARY_PROFILE_FOLDER || 'forca-aliada/profile-images';
    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const done = u => { if (!settled) { settled = true; resolve(u); } };
      const fail = e => { if (!settled) { settled = true; reject(e); } };
      const timeout = setTimeout(() => fail(new Error('Timeout no upload.')), 30000);
      const stream = cloudinary.uploader.upload_stream({
        folder,
        resource_type: 'image',
        format: 'webp',
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        context: { uploaded_by: String(req.user.sub || '') },
        // Perfis: 800px máx para avatares, 1800px para capas.
        // O tipo vem como query param (?type=avatar|cover), defaultando para cover.
        // quality:auto:good — boa qualidade visual, WebP já é muito eficiente.
        transformation: [
          {
            width: (req.query.type === 'avatar') ? 800 : 1800,
            height: (req.query.type === 'avatar') ? 800 : 600,
            crop: 'limit',
          },
          { fetch_format: 'webp', quality: 'auto:good', flags: 'strip_profile' },
        ],
      }, (err, result) => {
        clearTimeout(timeout);
        if (err) return fail(err);
        if (!result?.secure_url) return fail(new Error('Cloudinary não retornou URL.'));
        done(result.secure_url);
      });
      stream.on?.('error', e => { clearTimeout(timeout); fail(e); });
      stream.end(req.file.buffer);
    });
    res.status(201).json({ url, flagged: modResult.verdict === 'suspicious' });
  } catch (e) {
    console.error('[POST /api/upload]', e);
    res.status(502).json({ error: 'Não foi possível enviar a imagem agora.' });
  }
});

app.post('/api/community/posts', auth, postLimiter, async (req, res) => {
  const content = sanitizeText(req.body?.content || '');
  const mediaUrls = normalizePostMediaUrls(req.body?.media_urls);
  const requestedPublishAt = req.body?.publish_at ? new Date(req.body.publish_at) : null;

  // Poll validation
  const rawPollOptions = req.body?.poll_options;
  const pollDurationHours = Number(req.body?.poll_duration_hours) || 24;
  const hasPoll = Array.isArray(rawPollOptions) && rawPollOptions.length >= 2;
  const pollOptions = hasPoll
    ? rawPollOptions.map(o => ({
        text: String(typeof o === 'object' ? o?.text : o || '').trim(),
        option_image_url: normalizePostMediaUrls([typeof o === 'object' ? o?.option_image_url : ''])[0] || '',
      })).filter(o => o.text).slice(0, 4)
    : [];

  if (!content && !mediaUrls.length && !hasPoll) return res.status(400).json({ error: 'Escreva algo ou adicione uma imagem.' });
  if (content && content.length < 2 && !mediaUrls.length && !hasPoll) return res.status(400).json({ error: 'Post muito curto.' });
  if (content.length > 280) return res.status(400).json({ error: 'Post excede 280 caracteres.' });
  if (hasPoll && pollOptions.length < 2) return res.status(400).json({ error: 'Enquete precisa de pelo menos 2 opcoes.' });
  if (hasPoll && pollDurationHours < 1) return res.status(400).json({ error: 'Duracao invalida.' });
  if (hasPoll && pollOptions.some(o => o.text.length > 80)) return res.status(400).json({ error: 'Opcao de enquete muito longa (max 80 chars).' });
  if (requestedPublishAt && Number.isNaN(requestedPublishAt.getTime())) return res.status(400).json({ error: 'Data de agendamento invalida.' });
  if (requestedPublishAt && requestedPublishAt.getTime() < Date.now() + 30_000) return res.status(400).json({ error: 'Escolha um horario futuro para agendar.' });
  if (requestedPublishAt && requestedPublishAt.getTime() > Date.now() + 366 * 24 * 3600 * 1000) return res.status(400).json({ error: 'Agende com no maximo um ano de antecedencia.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const publishIdentity = await resolvePublishAuthor(req.user.sub, req.body?.publish_as_user_id, client);
    if (requestedPublishAt) {
      const { rows: scheduledRows } = await client.query(
        `INSERT INTO scheduled_posts(author_id, created_by_user_id, content, media_urls, poll_options, poll_duration_hours, publish_at)
         VALUES($1,$2,$3,$4::text[],$5::jsonb,$6,$7)
         RETURNING id, author_id, content, media_urls, poll_options, poll_duration_hours, publish_at, status, created_at`,
        [publishIdentity.authorId, req.user.sub, content, mediaUrls, JSON.stringify(pollOptions), pollDurationHours, requestedPublishAt],
      );
      if (publishIdentity.affiliationId) {
        await client.query('UPDATE account_affiliations SET last_used_at=NOW(), updated_at=NOW() WHERE id=$1', [publishIdentity.affiliationId]);
      }
      await client.query('COMMIT');
      return res.status(202).json({ scheduled: true, post: scheduledRows[0] });
    }
    const { rows } = await client.query(
      `INSERT INTO user_posts(author_id, created_by_user_id, content, media_urls)
       VALUES($1, $2, $3, $4::text[])
       RETURNING id, content, media_urls, created_at, updated_at, edit_count, is_pinned, author_id, created_by_user_id`,
      [publishIdentity.authorId, req.user.sub, content, mediaUrls],
    );
    const newPost = rows[0];
    if (publishIdentity.affiliationId) {
      await client.query('UPDATE account_affiliations SET last_used_at=NOW(), updated_at=NOW() WHERE id=$1', [publishIdentity.affiliationId]);
    }

    // Create poll if provided
    let pollData = null;
    if (hasPoll && pollOptions.length >= 2) {
      const endsAt = new Date(Date.now() + pollDurationHours * 3600 * 1000);
      const { rows: pollRows } = await client.query(
        `INSERT INTO post_polls(post_id, ends_at) VALUES($1, $2) RETURNING id, ends_at`,
        [newPost.id, endsAt],
      );
      const poll = pollRows[0];
      const insertedOptions = [];
      for (let i = 0; i < pollOptions.length; i++) {
        const { rows: optRows } = await client.query(
          `INSERT INTO post_poll_options(poll_id, text, option_image_url, sort_order) VALUES($1, $2, $3, $4) RETURNING id, text, option_image_url, sort_order`,
          [poll.id, pollOptions[i].text, pollOptions[i].option_image_url, i],
        );
        insertedOptions.push({ id: optRows[0].id, text: optRows[0].text, option_image_url: optRows[0].option_image_url, votes: 0 });
      }
      pollData = {
        id: poll.id,
        ends_at: poll.ends_at,
        is_closed: false,
        user_vote_id: null,
        options: insertedOptions,
      };
    }

    const mentions = extractMentions(content);
    if (mentions.length > 0) {
      const { rows: mentionedUsers } = await client.query(
        'SELECT id, minecraft_name, username FROM users WHERE LOWER(username) = ANY($1) OR LOWER(minecraft_name) = ANY($1)',
        [mentions],
      );
      for (const mUser of mentionedUsers) {
        if (mUser.id === publishIdentity.authorId) continue;
        await client.query(
          "INSERT INTO content_mentions(content_type, content_id, mentioned_user_id) VALUES('post', $1, $2) ON CONFLICT DO NOTHING",
          [newPost.id, mUser.id],
        );
        await optionalTransactionStep(client, 'post mention notification', () => createSocialNotification({
          recipientId: mUser.id,
          actorId: publishIdentity.authorId,
          type: 'mention_post',
          entityType: 'post',
          entityId: newPost.id,
          previewText: content,
        }, client));
        const targetName = mUser.minecraft_name || mUser.username;
        const authorName = publishIdentity.author.minecraft_name || publishIdentity.author.username;
        createMinecraftNotification({
          minecraftName: targetName,
          title: 'Voce foi mencionado!',
          body: `${authorName} mencionou voce em uma postagem: "${content.substring(0, 40)}..."`,
          type: 'social',
          icon: '💬',
          createdBy: req.user.sub,
        }).catch(err => console.warn('[post minecraft mention notification skipped]', err?.message || err));
      }
    }
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'create',
      targetId: newPost.id,
      targetName: publishIdentity.author.username,
      message: publishIdentity.delegated
        ? `Post #${newPost.id} publicado como ${publishIdentity.author.username} por ${req.user.username}`
        : `Post #${newPost.id} publicado`,
      metadata: {
        author_id: publishIdentity.authorId,
        created_by_user_id: req.user.sub,
        affiliation_id: publishIdentity.affiliationId,
      },
    });
    await client.query('COMMIT');
    emitCommunityEvent('new-post', {
      postId: Number(newPost.id),
      authorId: Number(publishIdentity.authorId),
      createdAt: newPost.created_at,
    });
    notifyProfileSubscribers({
      creatorId: publishIdentity.authorId,
      type: 'creator_post',
      entityType: 'post',
      entityId: newPost.id,
      previewText: content,
    }).catch(err => console.warn('[subscriber post notification skipped]', err?.message || err));
    const author = publishIdentity.author;
    res.status(201).json({
      ...newPost,
      author_id: publishIdentity.authorId,
      username: author.username,
      minecraft_name: author.minecraft_name,
      photo_url: author.photo_url,
      role: author.role,
      display_name: author.display_name,
      avatar_url: author.avatar_url,
      cover_url: author.cover_url,
      rank: author.rank,
      merit: author.merit,
      integration: author.integration,
      delegated: publishIdentity.delegated,
      likes_count: 0,
      comments_count: 0,
      reposts_count: 0,
      poll: pollData,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/community/posts]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao publicar.' });
  } finally {
    client.release();
  }
});

// Buscar o Feed (Geral ou Seguindo) - COM PAGINAÇÃO POR CURSOR (ID)
app.get('/api/me/scheduled-posts', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sp.id, sp.author_id, sp.content, sp.media_urls, sp.poll_options, sp.poll_duration_hours,
              sp.publish_at, sp.status, sp.published_post_id, sp.failure_reason, sp.created_at,
              u.username, u.minecraft_name, u.photo_url,
              COALESCE(up.display_name, '') AS display_name,
              COALESCE(up.avatar_url, '') AS avatar_url
       FROM scheduled_posts sp
       JOIN users u ON u.id=sp.author_id
       LEFT JOIN user_preferences up ON up.user_id=u.id
       WHERE sp.created_by_user_id=$1
       ORDER BY CASE WHEN sp.status='scheduled' THEN 0 ELSE 1 END, sp.publish_at ASC
       LIMIT 100`,
      [req.user.sub],
    );
    res.json({ rows });
  } catch (e) {
    console.error('[GET /api/me/scheduled-posts]', e);
    res.status(500).json({ error: 'Erro ao listar posts agendados.' });
  }
});

app.delete('/api/me/scheduled-posts/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Agendamento invalido.' });
  try {
    const { rows } = await pool.query(
      `UPDATE scheduled_posts SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND created_by_user_id=$2 AND status='scheduled'
       RETURNING id, status`,
      [id, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'Agendamento nao encontrado ou ja processado.' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[DELETE /api/me/scheduled-posts/:id]', e);
    res.status(500).json({ error: 'Erro ao cancelar agendamento.' });
  }
});

app.post('/api/me/scheduled-posts/:id/retry', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Agendamento invalido.' });
  try {
    const { rows } = await pool.query(
      `UPDATE scheduled_posts
       SET status='scheduled', failure_reason=NULL, publish_at=GREATEST(publish_at, NOW() + INTERVAL '30 seconds'), updated_at=NOW()
       WHERE id=$1 AND created_by_user_id=$2 AND status='failed'
       RETURNING id, status, publish_at`,
      [id, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'Falha de agendamento nao encontrada.' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[POST /api/me/scheduled-posts/:id/retry]', e);
    res.status(500).json({ error: 'Erro ao reagendar post.' });
  }
});

let scheduledPostWorkerRunning = false;
async function publishDueScheduledPosts() {
  if (scheduledPostWorkerRunning) return;
  scheduledPostWorkerRunning = true;
  try {
    await pool.query(
      `UPDATE scheduled_posts SET status='scheduled', updated_at=NOW()
       WHERE status='publishing' AND updated_at < NOW() - INTERVAL '10 minutes'`,
    );
    const { rows: due } = await pool.query(
      `WITH claimed AS (
         SELECT id FROM scheduled_posts
         WHERE status='scheduled' AND publish_at <= NOW()
         ORDER BY publish_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 12
       )
       UPDATE scheduled_posts sp
       SET status='publishing', updated_at=NOW()
       FROM claimed
       WHERE sp.id=claimed.id
       RETURNING sp.*`,
    );

    for (const scheduled of due) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: postRows } = await client.query(
          `INSERT INTO user_posts(author_id, created_by_user_id, content, media_urls, created_at)
           VALUES($1,$2,$3,$4::text[],$5)
           RETURNING id`,
          [scheduled.author_id, scheduled.created_by_user_id, scheduled.content, scheduled.media_urls || [], scheduled.publish_at],
        );
        const postId = postRows[0].id;
        const options = Array.isArray(scheduled.poll_options) ? scheduled.poll_options.filter(option => option?.text || typeof option === 'string').slice(0, 4) : [];
        if (options.length >= 2) {
          const { rows: pollRows } = await client.query(
            'INSERT INTO post_polls(post_id, ends_at) VALUES($1, $2) RETURNING id',
            [postId, new Date(Date.now() + Number(scheduled.poll_duration_hours || 24) * 3600 * 1000)],
          );
          for (let index = 0; index < options.length; index++) {
            await client.query(
              'INSERT INTO post_poll_options(poll_id, text, option_image_url, sort_order) VALUES($1,$2,$3,$4)',
              [pollRows[0].id, options[index]?.text || options[index], options[index]?.option_image_url || '', index],
            );
          }
        }
        const mentions = extractMentions(scheduled.content || '');
        if (mentions.length) {
          const { rows: mentionedUsers } = await client.query(
            'SELECT id FROM users WHERE LOWER(username)=ANY($1) OR LOWER(minecraft_name)=ANY($1)',
            [mentions],
          );
          for (const mentioned of mentionedUsers) {
            if (Number(mentioned.id) === Number(scheduled.author_id)) continue;
            await client.query(
              `INSERT INTO content_mentions(content_type, content_id, mentioned_user_id)
               VALUES('post',$1,$2) ON CONFLICT DO NOTHING`,
              [postId, mentioned.id],
            );
            await optionalTransactionStep(client, 'scheduled post mention notification', () => createSocialNotification({
              recipientId: mentioned.id,
              actorId: scheduled.author_id,
              type: 'mention_post',
              entityType: 'post',
              entityId: postId,
              previewText: scheduled.content,
            }, client));
          }
        }
        await client.query(
          `UPDATE scheduled_posts SET status='published', published_post_id=$2, updated_at=NOW() WHERE id=$1`,
          [scheduled.id, postId],
        );
        await client.query(
          `INSERT INTO social_notifications(recipient_id, actor_id, type, entity_type, entity_id, preview_text)
           VALUES($1,NULL,'scheduled_post_published','post',$2,$3)`,
          [scheduled.created_by_user_id || scheduled.author_id, postId, String(scheduled.content || 'Post agendado publicado').slice(0, 120)],
        );
        await client.query('COMMIT');
        emitCommunityEvent('notification', {
          recipientId: Number(scheduled.created_by_user_id || scheduled.author_id),
          notificationId: null,
          type: 'scheduled_post_published',
        });
        emitCommunityEvent('new-post', {
          postId: Number(postId),
          authorId: Number(scheduled.author_id),
          createdAt: scheduled.publish_at,
        });
        notifyProfileSubscribers({
          creatorId: scheduled.author_id,
          type: 'creator_post',
          entityType: 'post',
          entityId: postId,
          previewText: scheduled.content,
        }).catch(err => console.warn('[subscriber scheduled post notification skipped]', err?.message || err));
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        await pool.query(
          `UPDATE scheduled_posts SET status='failed', failure_reason=$2, updated_at=NOW() WHERE id=$1`,
          [scheduled.id, String(e?.message || 'Falha ao publicar').slice(0, 500)],
        ).catch(() => {});
        console.error('[scheduled post publish]', e);
      } finally {
        client.release();
      }
    }
  } catch (e) {
    console.error('[scheduled post worker]', e);
  } finally {
    scheduledPostWorkerRunning = false;
  }
}

app.get('/api/community/posts', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const filter = req.query.filter || 'all';
  const cursor = parseInt(req.query.cursor, 10) || null;
  const search = req.query.search ? `%${sanitize(req.query.search).toLowerCase()}%` : null;
  const hashtag = req.query.hashtag ? sanitize(req.query.hashtag).replace(/^#/, '').toLowerCase() : null;
  const params = [req.user.sub, limit];
  const conditions = [
    `NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
         OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
    )`,
    `NOT EXISTS (
      SELECT 1 FROM user_blocks oub
      WHERE ou.id IS NOT NULL
        AND ((oub.blocker_id = $1 AND oub.blocked_id = ou.id)
          OR (oub.blocker_id = ou.id AND oub.blocked_id = $1))
    )`,
  ];

  if (cursor) {
    params.push(cursor);
    conditions.push(`p.id < $${params.length}`);
  }
  if (filter === 'following') {
    conditions.push(`(p.author_id IN (SELECT following_id FROM user_follows WHERE follower_id = $1) OR p.author_id = $1)`);
  }
  if (filter === 'saved') {
    conditions.push(`EXISTS (
      SELECT 1 FROM post_saves ps_filter
      WHERE ps_filter.user_id = $1
        AND ps_filter.post_id = COALESCE(p.repost_of_id, p.id)
    )`);
  }
  if (filter === 'trending') {
    conditions.push(`COALESCE(op.created_at, p.created_at) > NOW() - INTERVAL '24 hours'`);
  }
  if (search) {
    params.push(search);
    conditions.push(`(LOWER(p.content) LIKE $${params.length} OR LOWER(COALESCE(op.content, '')) LIKE $${params.length} OR LOWER(COALESCE(u.minecraft_name, u.username, '')) LIKE $${params.length} OR LOWER(COALESCE(ou.minecraft_name, ou.username, '')) LIKE $${params.length})`);
  }
  if (hashtag) {
    params.push(`%#${hashtag}%`);
    conditions.push(`(LOWER(p.content) LIKE $${params.length} OR LOWER(COALESCE(op.content, '')) LIKE $${params.length})`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned, p.pinned_at,
             p.created_by_user_id,
             p.repost_of_id,
             op.content AS repost_original_content,
             op.media_urls AS repost_original_media_urls,
             op.created_at AS repost_original_created_at,
             ou.id AS repost_original_author_id,
             ou.username AS repost_original_username,
             ou.minecraft_name AS repost_original_minecraft_name,
             ou.photo_url AS repost_original_photo_url,
             COALESCE(oup.display_name, '') AS repost_original_display_name,
             COALESCE(oup.avatar_url, '') AS repost_original_avatar_url,
             ou.role AS repost_original_role,
             ${primaryIntegrationFieldsSql('ou')} AS repost_original_integration,
             ${socialRankSql('ou', 'opb')} AS repost_original_rank,
             ${socialMeritSql('ou', 'opb')} AS repost_original_merit,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = COALESCE(p.repost_of_id, p.id))::int AS likes_count,
             (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = COALESCE(p.repost_of_id, p.id))::int AS reposts_count,
             u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.role,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             COALESCE(up.cover_url, '') AS cover_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = COALESCE(p.repost_of_id, p.id) AND pl.user_id = $1) AS liked_by_me,
             EXISTS(SELECT 1 FROM user_posts rp WHERE rp.repost_of_id = COALESCE(p.repost_of_id, p.id) AND rp.author_id = $1 AND rp.content = '') AS reposted_by_me,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = COALESCE(p.repost_of_id, p.id) AND pc.is_deleted = FALSE)::int AS comments_count,
             COALESCE((
               SELECT json_agg(row_to_json(rc) ORDER BY rc.created_at ASC, rc.id ASC)
               FROM (
                 SELECT pc.id, pc.content, pc.media_urls, pc.created_at, pc.author_id,
                   pc.likes_count, pc.reply_count,
                   EXISTS(
                     SELECT 1 FROM comment_likes cl
                     WHERE cl.comment_id = pc.id AND cl.user_id = $1
                   ) AS liked_by_me,
                   (SELECT COUNT(*)::int FROM comment_saves cs WHERE cs.comment_id = pc.id) AS saves_count,
                   EXISTS(
                     SELECT 1 FROM comment_saves cs
                     WHERE cs.comment_id = pc.id AND cs.user_id = $1
                   ) AS saved_by_me,
                   cu.username, cu.minecraft_name, cu.photo_url, cu.is_platform_verified,
                   COALESCE(cup.display_name, '') AS display_name,
                   COALESCE(cup.avatar_url, '') AS avatar_url
                 FROM post_comments pc
                 JOIN users cu ON cu.id = pc.author_id
                 LEFT JOIN user_preferences cup ON cup.user_id = cu.id
                 WHERE pc.post_id = COALESCE(p.repost_of_id, p.id)
                   AND pc.is_deleted = FALSE
                   AND pc.parent_comment_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM user_blocks cub
                     WHERE (cub.blocker_id = $1 AND cub.blocked_id = cu.id)
                        OR (cub.blocker_id = cu.id AND cub.blocked_id = $1)
                   )
                 ORDER BY pc.created_at ASC, pc.id ASC
                 LIMIT 3
               ) rc
             ), '[]'::json) AS recent_comments,
             (SELECT json_build_object(
               'id', pp.id,
               'ends_at', pp.ends_at,
               'is_closed', (pp.ends_at < NOW()),
               'user_vote_id', (SELECT ppv.option_id FROM post_poll_votes ppv WHERE ppv.poll_id = pp.id AND ppv.user_id = $1),
               'options', COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', ppo.id,
                   'text', ppo.text,
                   'option_image_url', ppo.option_image_url,
                   'votes', (SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id = ppo.id)
                 ) ORDER BY ppo.sort_order)
                 FROM post_poll_options ppo
                 WHERE ppo.poll_id = pp.id
               ), '[]'::json)
             ) FROM post_polls pp WHERE pp.post_id = COALESCE(p.repost_of_id, p.id) LIMIT 1) AS poll
      FROM user_posts p
      JOIN users u ON p.author_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      LEFT JOIN user_posts op ON op.id = p.repost_of_id
      LEFT JOIN users ou ON ou.id = op.author_id
      LEFT JOIN user_preferences oup ON oup.user_id = ou.id
      LEFT JOIN player_balances opb ON LOWER(opb.minecraft_name) = LOWER(ou.minecraft_name)
      ${whereClause}
      ORDER BY p.is_pinned DESC, p.pinned_at DESC NULLS LAST, p.id DESC
      LIMIT $2
    `, params);
    const hasMore = rows.length === limit;
    const nextCursor = hasMore ? rows[rows.length - 1].id : null;
    res.json({ posts: rows, next_cursor: nextCursor, has_more: hasMore });
  } catch (e) {
    console.error('[GET /api/community/posts]', e);
    res.status(500).json({ error: 'Erro ao buscar o feed.' });
  }
});

// ── FEED RECOMENDADO v2 ──────────────────────────────────────────────────────
// Substituído pelo algoritmo Feed v2 (feed_v2_server.mjs).
// Novos sinais: saves, reposts, velocidade, penalidade de visualização,
// exclusão de sessão, bônus de mídia, diversidade de autores e session noise.
feedV2Endpoint(app, auth, pool, {
  clampInt,
  sanitize,
  primaryIntegrationFieldsSql,
  socialRankSql,
  socialMeritSql,
});

app.get('/api/community/posts/:id', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.content, p.media_urls, p.created_at, p.updated_at, p.edit_count, p.is_pinned, p.pinned_at,
             (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
             u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.role,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked_by_me,
             (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count,
             (SELECT json_build_object(
               'id', pp.id,
               'ends_at', pp.ends_at,
               'is_closed', (pp.ends_at < NOW()),
               'user_vote_id', (SELECT ppv.option_id FROM post_poll_votes ppv WHERE ppv.poll_id = pp.id AND ppv.user_id = $1),
               'options', COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', ppo.id,
                   'text', ppo.text,
                   'option_image_url', ppo.option_image_url,
                   'votes', (SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id = ppo.id)
                 ) ORDER BY ppo.sort_order)
                 FROM post_poll_options ppo
                 WHERE ppo.poll_id = pp.id
               ), '[]'::json)
             ) FROM post_polls pp WHERE pp.post_id = p.id LIMIT 1) AS poll
      FROM user_posts p
      JOIN users u ON p.author_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE p.id = $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      LIMIT 1
    `, [req.user.sub, postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post nao encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/community/posts/:id]', e);
    res.status(500).json({ error: 'Erro ao buscar post' });
  }
});

app.get('/api/community/posts/:id/comments', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID inválido' });
  return app._commentListHandler(req, res, postId, req.user.sub);
});

app.post('/api/community/posts/:id/repost', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const quote = sanitizeText(req.body?.content || req.body?.quote || '').slice(0, 280);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  if (quote.length > 280) return res.status(400).json({ error: 'Repost excede 280 caracteres.' });

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const publishIdentity = await resolvePublishAuthor(req.user.sub, req.body?.publish_as_user_id, client);
    const { rows: targetRows } = await client.query(
      `SELECT COALESCE(p.repost_of_id, p.id) AS target_id,
              target.author_id,
              target.content
       FROM user_posts p
       JOIN user_posts target ON target.id = COALESCE(p.repost_of_id, p.id)
       JOIN users u ON u.id = target.author_id
       WHERE p.id = $2
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id=$1 AND ub.blocked_id=u.id)
              OR (ub.blocker_id=u.id AND ub.blocked_id=$1)
         )
       LIMIT 1`,
      [req.user.sub, postId],
    );
    const target = targetRows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Post nao encontrado para repost.' });
    }
    const { rows } = await client.query(
      `INSERT INTO user_posts(author_id, created_by_user_id, content, repost_of_id)
       VALUES($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, content, repost_of_id, created_at, updated_at, edit_count, is_pinned, author_id, created_by_user_id`,
      [publishIdentity.authorId, req.user.sub, quote, target.target_id],
    );
    if (!rows.length && !quote) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Voce ja repostou este post.' });
    }
    if (publishIdentity.affiliationId) {
      await client.query('UPDATE account_affiliations SET last_used_at=NOW(), updated_at=NOW() WHERE id=$1', [publishIdentity.affiliationId]);
    }
    // Commita antes da notificação: evita que falha em createSocialNotification
    // desfaça o repost já inserido (a notificação é operação não-crítica).
    await client.query('COMMIT');
    committed = true;
    // Fire-and-forget: notificação não deve bloquear nem reverter o repost.
    const repostNotification = await createSocialNotification({
      recipientId: target.author_id,
      actorId: publishIdentity.authorId,
      type: 'repost',
      entityType: 'post',
      entityId: target.target_id,
      previewText: quote || target.content,
    }).catch(err => {
      console.error('[repost notification failed]', err);
      return null;
    });
    notifyProfileSubscribers({
      creatorId: publishIdentity.authorId,
      type: 'creator_repost',
      entityType: 'post',
      entityId: target.target_id,
      previewText: quote || target.content,
      allOnly: true,
    }).catch(err => console.warn('[subscriber repost notification skipped]', err?.message || err));
    res.status(201).json({ ok: true, repost: rows[0], notification_created: Boolean(repostNotification) });
  } catch (e) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/community/posts/:id/repost]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao repostar.' });
  } finally {
    client.release();
  }
});

app.delete('/api/community/posts/:id/repost', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const publishIdentity = await resolvePublishAuthor(req.user.sub, req.query.publish_as_user_id || req.body?.publish_as_user_id);
    const { rowCount } = await pool.query(
      `DELETE FROM user_posts rp
       USING user_posts p
       WHERE rp.author_id = $1
         AND rp.content = ''
         AND rp.repost_of_id = COALESCE(p.repost_of_id, p.id)
         AND p.id = $2`,
      [publishIdentity.authorId, postId],
    );
    res.json({ ok: true, removed: rowCount });
  } catch (e) {
    console.error('[DELETE /api/community/posts/:id/repost]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao desfazer repost.' });
  }
});


// Criar um comentário com suporte a Menções (@)
app.delete('/api/community/reposts/:id', auth, async (req, res) => {
  const repostId = parseInt(req.params.id, 10);
  if (!repostId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM user_posts rp
       WHERE rp.id=$1
         AND rp.repost_of_id IS NOT NULL
         AND (
           rp.author_id=$2
           OR (
             rp.created_by_user_id=$2
             AND EXISTS (
               SELECT 1 FROM account_affiliations af
               WHERE af.owner_user_id=rp.author_id
                 AND af.delegate_user_id=$2
                 AND af.status='active'
                 AND 'post'=ANY(af.scopes)
             )
           )
         )
       RETURNING id, repost_of_id`,
      [repostId, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'Repost nao encontrado ou nao autorizado' });
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'delete',
      targetId: repostId,
      message: `Repost #${repostId} removido sem alterar a publicacao original`,
      metadata: { original_post_id: rows[0].repost_of_id },
    });
    res.json({ ok: true, removed_repost_id: rows[0].id, original_post_id: rows[0].repost_of_id });
  } catch (e) {
    console.error('[DELETE /api/community/reposts/:id]', e);
    res.status(500).json({ error: 'Erro ao excluir repost' });
  }
});

app.post('/api/community/posts/:id/comments', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const content = sanitizeText(req.body?.content || '');
  const mediaUrls = normalizePostMediaUrls(req.body?.media_urls);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  if ((!content && !mediaUrls.length) || content.length > 280) return res.status(400).json({ error: 'Comentario invalido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: postRows } = await client.query(
      `SELECT p.author_id, p.content, u.minecraft_name, u.username
       FROM user_posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.id=$1
       LIMIT 1`,
      [postId],
    );
    const post = postRows[0];
    if (!post) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Post nao encontrado' });
    }

    const { rows: blocked } = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1)
       LIMIT 1`,
      [req.user.sub, post.author_id],
    );
    if (blocked.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Nao e possivel comentar neste post.' });
    }

    const { rows } = await client.query(
      'INSERT INTO post_comments(post_id, author_id, content, media_urls) VALUES($1, $2, $3, $4) RETURNING id, created_at, media_urls',
      [postId, req.user.sub, content, mediaUrls],
    );
    const newComment = rows[0];

    const commentNotification = await optionalTransactionStep(client, 'comment notification', () => createSocialNotification({
      recipientId: post.author_id,
      actorId: req.user.sub,
      type: 'comment',
      entityType: 'post',
      entityId: postId,
      previewText: content,
    }, client));

    const mentions = extractMentions(content);
    if (mentions.length > 0) {
      const { rows: mentionedUsers } = await client.query(
        'SELECT id, minecraft_name, username FROM users WHERE LOWER(username) = ANY($1) OR LOWER(minecraft_name) = ANY($1)',
        [mentions],
      );
      for (const mUser of mentionedUsers) {
        if (mUser.id === req.user.sub) continue;
        await client.query(
          "INSERT INTO content_mentions(content_type, content_id, mentioned_user_id) VALUES('comment', $1, $2) ON CONFLICT DO NOTHING",
          [newComment.id, mUser.id],
        );
        await optionalTransactionStep(client, 'comment mention notification', () => createSocialNotification({
          recipientId: mUser.id,
          actorId: req.user.sub,
          type: 'mention_comment',
          entityType: 'comment',
          entityId: newComment.id,
          previewText: content,
        }, client));
        const targetName = mUser.minecraft_name || mUser.username;
        const authorName = req.user.minecraft_name || req.user.username;
        createMinecraftNotification({
          minecraftName: targetName,
          title: 'Voce foi mencionado!',
          body: `${authorName} mencionou voce em um comentario: "${content.substring(0, 40)}..."`,
          type: 'social',
          icon: '💬',
          createdBy: req.user.sub,
        }).catch(err => console.warn('[comment minecraft mention notification skipped]', err?.message || err));
      }
    }
    await client.query('COMMIT');
    notifyProfileSubscribers({
      creatorId: req.user.sub,
      type: 'creator_reply',
      entityType: 'post',
      entityId: postId,
      previewText: content,
      allOnly: true,
    }).catch(err => console.warn('[subscriber reply notification skipped]', err?.message || err));
    res.status(201).json({
      ok: true,
      id: newComment.id,
      created_at: newComment.created_at,
      media_urls: newComment.media_urls,
      notification_created: Boolean(commentNotification),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/community/posts/:id/comments]', e);
    res.status(500).json({ error: 'Erro ao comentar' });
  } finally {
    client.release();
  }
});


// ── LISTAS DE SEGUIDORES / SEGUINDO ──
app.delete('/api/community/posts/:postId/comments/:commentId', auth, async (req, res) => {
  const postId = parseInt(req.params.postId, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (!postId || !commentId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE post_comments
       SET is_deleted=TRUE, deleted_at=NOW()
       WHERE id=$1 AND post_id=$2 AND (author_id=$3 OR $4)
         AND is_deleted = FALSE`,
      [commentId, postId, req.user.sub, isPrivileged(req.user.role)],
    );
    if (!rowCount) return res.status(404).json({ error: 'Comentario nao encontrado ou sem permissao' });
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'delete',
      targetId: commentId,
      message: `Comentario #${commentId} removido`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/community/posts/:postId/comments/:commentId]', e);
    res.status(500).json({ error: 'Erro ao remover comentario' });
  }
});

app.get('/api/community/player/:identifier/followers', auth, async (req, res) => {
  const ident = parseCommunityIdentifier(req.params.identifier);
  const limit = clampInt(req.query.limit, 24, 1, 50);
  const cursor = req.query.cursor ? sanitize(req.query.cursor) : null;
  const where = ident.byId ? 'target.id = $2' : '(LOWER(target.minecraft_name) = $2 OR LOWER(target.username) = $2)';
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, uf.created_at,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS followed_by_me
      FROM user_follows uf
      JOIN users u ON uf.follower_id = u.id
      JOIN users target ON uf.following_id = target.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${where}
        AND ($3::timestamptz IS NULL OR uf.created_at < $3::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY uf.created_at DESC
      LIMIT $4
    `, [req.user.sub, ident.value, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    res.json({ rows: page, next_cursor: rows.length > limit ? page.at(-1)?.created_at : null, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/community/player/:identifier/followers]', e);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});


app.get('/api/community/player/:identifier/following', auth, async (req, res) => {
  const ident = parseCommunityIdentifier(req.params.identifier);
  const limit = clampInt(req.query.limit, 24, 1, 50);
  const cursor = req.query.cursor ? sanitize(req.query.cursor) : null;
  const where = ident.byId ? 'target.id = $2' : '(LOWER(target.minecraft_name) = $2 OR LOWER(target.username) = $2)';
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, uf.created_at,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             ${socialRankSql('u', 'pb')} AS rank,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS followed_by_me
      FROM user_follows uf
      JOIN users u ON uf.following_id = u.id
      JOIN users target ON uf.follower_id = target.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE ${where}
        AND ($3::timestamptz IS NULL OR uf.created_at < $3::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY uf.created_at DESC
      LIMIT $4
    `, [req.user.sub, ident.value, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    res.json({ rows: page, next_cursor: rows.length > limit ? page.at(-1)?.created_at : null, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/community/player/:identifier/following]', e);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});

app.get('/api/community/player/:identifier/friends', auth, async (req, res) => {
  const ident = parseCommunityIdentifier(req.params.identifier);
  const limit = clampInt(req.query.limit, 24, 1, 50);
  const cursor = req.query.cursor ? sanitize(req.query.cursor) : null;
  const where = ident.byId ? 'target.id = $2' : '(LOWER(target.minecraft_name) = $2 OR LOWER(target.username) = $2)';
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '') AS avatar_url,
             ${primaryIntegrationFieldsSql('u')} AS integration,
             GREATEST(out_f.created_at, back_f.created_at) AS created_at,
             ${socialRankSql('u', 'pb')} AS rank,
             ${socialMeritSql('u', 'pb')} AS merit,
             EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = u.id) AS followed_by_me
      FROM users target
      JOIN user_follows out_f ON out_f.follower_id = target.id
      JOIN user_follows back_f ON back_f.follower_id = out_f.following_id AND back_f.following_id = target.id
      JOIN users u ON u.id = out_f.following_id
      LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN user_preferences target_up ON target_up.user_id = target.id
      WHERE ${where}
        AND (COALESCE(target_up.public_profile, TRUE) = TRUE OR target.id = $1)
        AND ($3::timestamptz IS NULL OR GREATEST(out_f.created_at, back_f.created_at) < $3::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
             OR (ub.blocker_id = $1 AND ub.blocked_id = target.id)
             OR (ub.blocker_id = target.id AND ub.blocked_id = $1)
        )
      ORDER BY created_at DESC
      LIMIT $4
    `, [req.user.sub, ident.value, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    res.json({ rows: page, next_cursor: rows.length > limit ? page.at(-1)?.created_at : null, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/community/player/:identifier/friends]', e);
    res.status(500).json({ error: 'Erro ao listar amigos' });
  }
});


// Curtir um post
app.post('/api/community/posts/:id/like', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: postRows } = await client.query('SELECT author_id, content FROM user_posts WHERE id=$1 LIMIT 1', [postId]);
    const post = postRows[0];
    if (!post) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Post nao encontrado' });
    }
    const { rows: blocked } = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id=$1 AND blocked_id=$2)
          OR (blocker_id=$2 AND blocked_id=$1)
       LIMIT 1`,
      [req.user.sub, post.author_id],
    );
    if (blocked.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Acao indisponivel.' });
    }
    const { rowCount } = await client.query('INSERT INTO post_likes(post_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [postId, req.user.sub]);
    if (rowCount > 0) {
      await client.query('UPDATE user_posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);
    }
    await client.query('COMMIT');
    let notification = null;
    if (rowCount > 0) {
      notification = await createSocialNotification({
        recipientId: post.author_id,
        actorId: req.user.sub,
        type: 'post_like',
        entityType: 'post',
        entityId: postId,
        previewText: post.content,
      }).catch(err => {
        console.error('[like notification failed]', err);
        return null;
      });
    }
    res.json({ ok: true, created: rowCount > 0, notification_created: Boolean(notification) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/community/posts/:id/like]', e);
    res.status(500).json({ error: 'Erro ao curtir' });
  } finally {
    client.release();
  }
});

// Descurtir um post
app.delete('/api/community/posts/:id/like', auth, async (req, res) => {
  const postId = parseInt(req.params.id);
  if (!postId) return res.status(400).json({ error: 'ID inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2', [postId, req.user.sub]);
    if (rowCount > 0) {
      await client.query('UPDATE user_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1', [postId]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao descurtir' });
  } finally {
    client.release();
  }
});

// ── Quem curtiu o post ────────────────────────────────────────────────────────
app.get('/api/community/posts/:id/likers', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  const limit = clampInt(req.query.limit, 30, 1, 50);
  const cursor = parseInt(req.query.cursor, 10) || null;
  try {
    const params = [req.user.sub, postId, limit + 1];
    const cursorClause = cursor ? `AND pl.user_id > $${params.length + 1}` : '';
    if (cursor) params.push(cursor);
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '')   AS avatar_url,
             ${socialRankSql('u', 'pb')}   AS rank,
             pl.created_at
      FROM post_likes pl
      JOIN users u ON u.id = pl.user_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE pl.post_id = $2
        ${cursorClause}
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY pl.created_at DESC, u.id ASC
      LIMIT $3
    `, params);
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? page[page.length - 1]?.id : null;
    res.json({ likers: page, next_cursor, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/community/posts/:id/likers]', e);
    res.status(500).json({ error: 'Erro ao buscar curtidas' });
  }
});

// ── Quem repostou o post ──────────────────────────────────────────────────────
app.get('/api/community/posts/:id/reposters', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  const limit = clampInt(req.query.limit, 30, 1, 50);
  const cursor = parseInt(req.query.cursor, 10) || null;
  try {
    const params = [req.user.sub, postId, limit + 1];
    const cursorClause = cursor ? `AND rp.author_id > $${params.length + 1}` : '';
    if (cursor) params.push(cursor);
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
             COALESCE(up.display_name, '') AS display_name,
             COALESCE(up.avatar_url, '')   AS avatar_url,
             ${socialRankSql('u', 'pb')}   AS rank,
             rp.created_at,
             rp.content AS quote_content
      FROM user_posts rp
      JOIN users u ON u.id = rp.author_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
      WHERE rp.repost_of_id = $2
        ${cursorClause}
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY rp.created_at DESC, u.id ASC
      LIMIT $3
    `, params);
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? page[page.length - 1]?.id : null;
    res.json({ reposters: page, next_cursor, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/community/posts/:id/reposters]', e);
    res.status(500).json({ error: 'Erro ao buscar reposts' });
  }
});

// ── Feed v2: impressões, saves, não tenho interesse ──────────────────────────
impressionsEndpoint(app, auth, pool, impressionLimiter);
savePostEndpoint(app, auth, pool);
unsavePostEndpoint(app, auth, pool);
notInterestedEndpoint(app, auth, pool);
undoNotInterestedEndpoint(app, auth, pool);

// ── Comment Thread Fix: endpoint /thread robusto + público + /share/comment ──
registerCommentThreadFix(app, pool, auth, {
  primaryIntegrationFieldsSql,
  socialRankSql,
});

// ── Comment Upgrade: likes, threading, sort, sub-thread ──────────────────────
registerCommentUpgradeEndpoints(app, pool, auth, {
  sanitize,
  sanitizeText,
  clampInt,
  isPrivileged,
  socialRankSql,
  primaryIntegrationFieldsSql,
  createSocialNotification,
  notifyProfileSubscribers,
  auditFromReq,
  extractMentions,
  normalizePostMediaUrls,
});

// Apagar o próprio post
app.patch('/api/community/posts/:id', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const content = sanitizeText(req.body?.content || '');
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  if (!content || content.length < 2) return res.status(400).json({ error: 'Post muito curto.' });
  if (content.length > 280) return res.status(400).json({ error: 'Post excede 280 caracteres.' });
  try {
    const { rows } = await pool.query(
      `SELECT p.author_id, p.created_by_user_id, p.created_at, p.edit_count,
              EXISTS (
                SELECT 1 FROM account_affiliations af
                WHERE af.owner_user_id = p.author_id
                  AND af.delegate_user_id = $2
                  AND af.status = 'active'
                  AND 'post' = ANY(af.scopes)
              ) AS has_active_delegation
       FROM user_posts p
       WHERE p.id=$1`,
      [postId, req.user.sub],
    );
    const post = rows[0];
    if (!post) return res.status(404).json({ error: 'Post nao encontrado' });
    const canEditPost = Number(post.author_id) === Number(req.user.sub)
      || (Number(post.created_by_user_id) === Number(req.user.sub) && post.has_active_delegation);
    if (!canEditPost) return res.status(403).json({ error: 'forbidden' });
    const ageMinutes = (Date.now() - new Date(post.created_at).getTime()) / 60000;
    if (ageMinutes > 15) return res.status(403).json({ error: 'Edicao permitida apenas nos primeiros 15 minutos.' });
    const { rows: updated } = await pool.query(
      `UPDATE user_posts
       SET content=$1, updated_at=NOW(), edit_count=COALESCE(edit_count, 0)+1
       WHERE id=$2
       RETURNING id, content, created_at, updated_at, edit_count, is_pinned`,
      [content, postId],
    );
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'update',
      targetId: postId,
      message: `Post #${postId} editado`,
    });
    res.json(updated[0]);
  } catch (e) {
    console.error('[PATCH /api/community/posts/:id]', e);
    res.status(500).json({ error: 'Erro ao editar post' });
  }
});

app.delete('/api/community/posts/:id', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  try {
    const { rows } = await pool.query(
      `DELETE FROM user_posts p
       WHERE p.id=$1
         AND (
           p.author_id=$2
           OR (
             p.created_by_user_id=$2
             AND EXISTS (
               SELECT 1 FROM account_affiliations af
               WHERE af.owner_user_id = p.author_id
                 AND af.delegate_user_id = $2
                 AND af.status = 'active'
                 AND 'post' = ANY(af.scopes)
             )
           )
         )
       RETURNING id`,
      [postId, req.user.sub],
    );
    if (!rows.length) return res.status(404).json({ error: 'Post nao encontrado ou nao autorizado' });
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'delete',
      targetId: postId,
      message: `Post #${postId} removido pelo autor`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/community/posts/:id]', e);
    res.status(500).json({ error: 'Erro ao excluir' });
  }
});

// ── Poll vote ─────────────────────────────────────────────────────────────────
app.get('/api/community/polls', auth, async (req, res) => {
  const ids = String(req.query.post_ids || '')
    .split(',')
    .map(id => parseInt(id, 10))
    .filter(Boolean);
  const postIds = [...new Set(ids)].slice(0, 25);
  if (!postIds.length) return res.json({ polls: [] });

  try {
    const { rows } = await pool.query(`
      SELECT p.id AS post_id,
             json_build_object(
               'id', pp.id,
               'ends_at', pp.ends_at,
               'is_closed', (pp.ends_at < NOW()),
               'user_vote_id', (SELECT ppv.option_id FROM post_poll_votes ppv WHERE ppv.poll_id = pp.id AND ppv.user_id = $1),
               'options', COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', ppo.id,
                   'text', ppo.text,
                   'option_image_url', ppo.option_image_url,
                   'votes', (SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id = ppo.id)
                 ) ORDER BY ppo.sort_order)
                 FROM post_poll_options ppo
                 WHERE ppo.poll_id = pp.id
               ), '[]'::json)
             ) AS poll
      FROM user_posts p
      JOIN users u ON u.id = p.author_id
      JOIN post_polls pp ON pp.post_id = p.id
      WHERE p.id = ANY($2::int[])
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
        )
      ORDER BY array_position($2::int[], p.id)
    `, [req.user.sub, postIds]);
    res.json({ polls: rows });
  } catch (e) {
    console.error('[GET /api/community/polls]', e);
    res.status(500).json({ error: 'Erro ao sincronizar enquetes' });
  }
});

app.post('/api/community/posts/:id/poll/vote', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body?.option_id, 10);
  if (!postId || !optionId) return res.status(400).json({ error: 'Dados invalidos' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get poll
    const { rows: pollRows } = await client.query(
      'SELECT id, ends_at FROM post_polls WHERE post_id=$1 LIMIT 1', [postId]
    );
    if (!pollRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Enquete nao encontrada' });
    }
    const poll = pollRows[0];
    if (new Date(poll.ends_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Enquete encerrada' });
    }
    // Check option belongs to poll
    const { rows: optRows } = await client.query(
      'SELECT id FROM post_poll_options WHERE id=$1 AND poll_id=$2', [optionId, poll.id]
    );
    if (!optRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Opcao nao encontrada' });
    }
    // Check already voted
    const { rows: existingVote } = await client.query(
      'SELECT option_id FROM post_poll_votes WHERE poll_id=$1 AND user_id=$2', [poll.id, req.user.sub]
    );
    if (existingVote.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Voce ja votou nesta enquete', voted_option_id: existingVote[0].option_id });
    }
    // Insert vote
    await client.query(
      'INSERT INTO post_poll_votes(poll_id, option_id, user_id) VALUES($1,$2,$3)',
      [poll.id, optionId, req.user.sub]
    );
    // Fetch updated poll state
    const { rows: updatedOptions } = await client.query(
      `SELECT ppo.id, ppo.text, ppo.option_image_url, ppo.sort_order,
              (SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id = ppo.id) AS votes
       FROM post_poll_options ppo WHERE ppo.poll_id=$1 ORDER BY ppo.sort_order`, [poll.id]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      poll: {
        id: poll.id,
        ends_at: poll.ends_at,
        is_closed: false,
        user_vote_id: optionId,
        options: updatedOptions,
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/community/posts/:id/poll/vote]', e);
    res.status(500).json({ error: 'Erro ao votar' });
  } finally {
    client.release();
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/community/report', auth, async (req, res) => {
  const contentType = sanitize(req.body?.content_type);
  const contentId = parseInt(req.body?.content_id, 10);
  const reason = sanitize(req.body?.reason);
  const description = sanitize(req.body?.description || '').slice(0, 600);
  if (!REPORT_CONTENT_TYPES.has(contentType) || !contentId || !REPORT_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Denuncia invalida' });
  }

  try {
    let exists;
    if (contentType === 'post') exists = await pool.query('SELECT id FROM user_posts WHERE id=$1', [contentId]);
    if (contentType === 'comment') exists = await pool.query('SELECT id FROM post_comments WHERE id=$1', [contentId]);
    if (contentType === 'user') exists = await pool.query('SELECT id FROM users WHERE id=$1', [contentId]);
    if (!exists?.rows?.length) return res.status(404).json({ error: 'Conteudo nao encontrado' });

    const { rows } = await pool.query(
      `INSERT INTO content_reports(reporter_id, content_type, content_id, reason, description)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(reporter_id, content_type, content_id)
       DO UPDATE SET reason=$4, description=$5, status='pending', created_at=NOW()
       RETURNING id`,
      [req.user.sub, contentType, contentId, reason, description || null],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM content_reports
       WHERE content_type=$1 AND content_id=$2 AND status='pending'`,
      [contentType, contentId],
    );
    const count = countRows[0]?.count || 0;
    if (count >= 3) {
      await pool.query(
        `INSERT INTO moderation_queue(content_type, content_id, report_count)
         VALUES($1, $2, $3)
         ON CONFLICT(content_type, content_id)
         DO UPDATE SET report_count=$3, status='pending'`,
        [contentType, contentId, count],
      );
    }

    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'security',
      severity: 'warning',
      targetId: contentId,
      targetName: contentType,
      message: `Denuncia criada: ${contentType} #${contentId}`,
      metadata: { reportId: rows[0].id, reason },
    });
    res.status(201).json({ ok: true, id: rows[0].id, report_count: count });
  } catch (e) {
    console.error('[POST /api/community/report]', e);
    res.status(500).json({ error: 'Erro ao enviar denuncia' });
  }
});

app.get('/api/admin/reports', auth, requireAdmin, async (req, res) => {
  const status = sanitize(req.query.status || 'pending');
  const page   = clampInt(req.query.page,  0, 0, 100000);
  const limit  = clampInt(req.query.limit, 20, 1, 100);
  const whereClause = status && status !== 'all' ? `WHERE cr.status = $1` : '';
  const countParams = status && status !== 'all' ? [status] : [];
  const rowParams   = status && status !== 'all' ? [status, limit, page * limit] : [limit, page * limit];
  const limitIdx    = rowParams.length - 1;
  const offsetIdx   = rowParams.length;
  try {
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(`
        SELECT
          cr.*,
          reporter.username   AS reporter_username,
          reporter.photo_url  AS reporter_photo,
          reviewer.username   AS reviewer_username,
          -- autor do conteúdo denunciado
          author.id           AS author_id,
          author.username     AS author_username,
          author.minecraft_name AS author_minecraft,
          author.photo_url    AS author_photo,
          -- prévia do conteúdo
          CASE
            WHEN cr.content_type = 'post'
              THEN (SELECT p.content FROM user_posts p WHERE p.id = cr.content_id LIMIT 1)
            WHEN cr.content_type = 'comment'
              THEN (SELECT c.content FROM post_comments c WHERE c.id = cr.content_id LIMIT 1)
            ELSE NULL
          END AS content_preview,
          CASE
            WHEN cr.content_type = 'post'
              THEN (SELECT p.media_urls FROM user_posts p WHERE p.id = cr.content_id LIMIT 1)
            ELSE NULL
          END AS content_media_urls,
          -- número total de denúncias pendentes para este item
          (SELECT COUNT(*)::int FROM content_reports x
           WHERE x.content_type = cr.content_type AND x.content_id = cr.content_id
             AND x.status = 'pending') AS total_reports_for_item
        FROM content_reports cr
        JOIN users reporter ON reporter.id = cr.reporter_id
        LEFT JOIN users reviewer ON reviewer.id = cr.reviewed_by
        LEFT JOIN LATERAL (
          SELECT u.id, u.username, u.minecraft_name, u.photo_url
          FROM user_posts p JOIN users u ON u.id = p.author_id
          WHERE cr.content_type = 'post' AND p.id = cr.content_id
          UNION ALL
          SELECT u.id, u.username, u.minecraft_name, u.photo_url
          FROM post_comments c JOIN users u ON u.id = c.author_id
          WHERE cr.content_type = 'comment' AND c.id = cr.content_id
          UNION ALL
          SELECT u.id, u.username, u.minecraft_name, u.photo_url
          FROM users u WHERE cr.content_type = 'user' AND u.id = cr.content_id
          LIMIT 1
        ) author ON TRUE
        ${whereClause}
        ORDER BY cr.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, rowParams),
      pool.query(`
        SELECT COUNT(*)::int AS total FROM content_reports cr ${whereClause}
      `, countParams),
    ]);
    res.json({ rows, total: countRows[0]?.total ?? 0, page, limit });
  } catch (e) {
    console.error('[GET /api/admin/reports]', e);
    res.status(500).json({ error: 'Erro ao listar denuncias' });
  }
});

app.patch('/api/admin/reports/:id', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = sanitize(req.body?.action || '');
  if (!id || !['dismiss', 'remove_content', 'warn_user'].includes(action)) {
    return res.status(400).json({ error: 'Acao invalida' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM content_reports WHERE id=$1 FOR UPDATE', [id]);
    const report = rows[0];
    if (!report) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Denuncia nao encontrada' });
    }
    let status = 'reviewed_kept';
    if (action === 'dismiss') status = 'dismissed';
    if (action === 'remove_content') {
      status = 'reviewed_removed';
      if (report.content_type === 'post') await client.query('DELETE FROM user_posts WHERE id=$1', [report.content_id]);
      if (report.content_type === 'comment') {
        await client.query('UPDATE post_comments SET is_deleted=TRUE, deleted_at=NOW() WHERE id=$1', [report.content_id]);
      }
    }
    if (action === 'warn_user') {
      // Resolve o user_id do conteúdo denunciado para enviar notificação
      let warnedUserId = null;
      try {
        if (report.content_type === 'post') {
          const { rows: prows } = await client.query('SELECT author_id FROM user_posts WHERE id=$1', [report.content_id]);
          warnedUserId = prows[0]?.author_id ?? null;
        } else if (report.content_type === 'comment') {
          const { rows: crows } = await client.query('SELECT author_id FROM post_comments WHERE id=$1', [report.content_id]);
          warnedUserId = crows[0]?.author_id ?? null;
        } else if (report.content_type === 'user') {
          warnedUserId = report.content_id;
        }
        if (warnedUserId) {
          // Insere notificação de aviso para o utilizador
          await client.query(
            `INSERT INTO social_notifications
               (recipient_id, actor_id, type, entity_type, entity_id, preview_text, is_read, created_at)
             VALUES ($1, $2, 'moderation_warn', $3, $4, $5, FALSE, NOW())`,
            [
              warnedUserId,
              req.user.sub,
              report.content_type,
              report.content_id,
              'A staff revisou uma denúncia sobre seu conteúdo e emitiu um aviso. Por favor, siga as regras da comunidade.',
            ],
          );
        }
      } catch (warnErr) {
        console.warn('[warn_user] Falha ao criar notificação de aviso:', warnErr.message);
        // Não bloqueia a ação principal
      }
      status = 'reviewed_kept';
    }
    await client.query(
      `UPDATE content_reports
       SET status=$1, reviewed_by=$2, reviewed_at=NOW(), action_taken=$3
       WHERE id=$4`,
      [status, req.user.sub, action, id],
    );
    await client.query(
      `UPDATE moderation_queue
       SET status=$1, reviewed_by=$2, reviewed_at=NOW()
       WHERE content_type=$3 AND content_id=$4`,
      [status === 'reviewed_removed' ? 'removed' : 'reviewed', req.user.sub, report.content_type, report.content_id],
    );
    await client.query('COMMIT');
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'moderation',
      severity: action === 'remove_content' ? 'warning' : 'info',
      targetId: report.content_id,
      targetName: report.content_type,
      message: `Denuncia #${id} revisada: ${action}`,
    });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PATCH /api/admin/reports/:id]', e);
    res.status(500).json({ error: 'Erro ao revisar denuncia' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/posts/:id', auth, requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const reason = sanitize(req.body?.reason || 'moderation').slice(0, 160);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rows } = await pool.query(`
      DELETE FROM user_posts p
      USING users u
      WHERE p.id=$1 AND u.id=p.author_id
      RETURNING p.id, u.id AS author_id, u.username, u.minecraft_name
    `, [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post nao encontrado' });
    const targetName = rows[0].minecraft_name || rows[0].username;
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'delete',
      severity: 'warning',
      targetId: postId,
      targetName,
      message: `Post #${postId} removido por admin: ${reason}`,
      metadata: { authorId: rows[0].author_id, reason },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/admin/posts/:id]', e);
    res.status(500).json({ error: 'Erro ao excluir post' });
  }
});

// ── Integrações Xbox e Mojang (Área Logada) ─────────────────
app.patch('/api/admin/posts/:id/pin', auth, requireAdmin, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const pinned = Boolean(req.body?.pinned);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rows } = await pool.query(
      `UPDATE user_posts
       SET is_pinned=$2, pinned_at=CASE WHEN $2 THEN NOW() ELSE NULL END
       WHERE id=$1 AND repost_of_id IS NULL
       RETURNING id, is_pinned, pinned_at`,
      [postId, pinned],
    );
    if (!rows.length) return res.status(404).json({ error: 'Post nao encontrado' });
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'moderation',
      severity: 'info',
      targetId: postId,
      message: pinned ? `Post #${postId} fixado` : `Post #${postId} desfixado`,
    });
    res.json({ ok: true, post: rows[0] });
  } catch (e) {
    console.error('[PATCH /api/admin/posts/:id/pin]', e);
    res.status(500).json({ error: 'Erro ao atualizar fixacao' });
  }
});

app.get('/api/me/social-notifications', auth, async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const cursor = req.query.cursor ? sanitize(req.query.cursor) : null;
  const type = sanitize(req.query.type || '').toLowerCase();
  const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true';
  try {
    const params = [req.user.sub];
    const conditions = ['sn.recipient_id = $1'];
    if (cursor) {
      params.push(cursor);
      conditions.push(`sn.created_at < $${params.length}::timestamptz`);
    }
    if (unreadOnly) conditions.push('sn.is_read = FALSE');
    if (type === 'mentions') {
      conditions.push("sn.type IN ('mention_post','mention_comment')");
    } else if (type === 'interactions') {
      conditions.push("sn.type IN ('post_like','comment','comment_reply','comment_like','message_reaction','repost')");
    } else if (SOCIAL_NOTIFICATION_TYPES.has(type)) {
      params.push(type);
      conditions.push(`sn.type = $${params.length}`);
    }
    params.push(limit + 1);
    const limitParam = params.length;

    const { rows } = await pool.query(`
      SELECT sn.id, sn.type, sn.entity_type, sn.entity_id, sn.preview_text, sn.is_read, sn.created_at,
             sn.group_count, sn.actor_ids,
             actor.id AS actor_id, actor.username AS actor_username, actor.minecraft_name AS actor_minecraft_name,
             actor.photo_url AS actor_photo_url,
             COALESCE(actor_prefs.avatar_url, '') AS actor_avatar_url,
             COALESCE(actor_prefs.display_name, '') AS actor_display_name,
             ${primaryIntegrationFieldsSql('actor')} AS actor_integration
      FROM social_notifications sn
      LEFT JOIN users actor ON actor.id = sn.actor_id
      LEFT JOIN user_preferences actor_prefs ON actor_prefs.user_id = actor.id
      WHERE ${conditions.join(' AND ')}
        AND (
          actor.id IS NULL OR NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id=$1 AND ub.blocked_id=actor.id)
               OR (ub.blocker_id=actor.id AND ub.blocked_id=$1)
          )
        )
      ORDER BY sn.created_at DESC
      LIMIT $${limitParam}
    `, params);
    const page = rows.slice(0, limit);
    res.json({ rows: page, next_cursor: rows.length > limit ? page.at(-1)?.created_at : null, has_more: rows.length > limit });
  } catch (e) {
    console.error('[GET /api/me/social-notifications]', e);
    res.status(500).json({ error: 'Erro ao listar notificacoes sociais' });
  }
});

app.get('/api/me/social-notifications/unread-count', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM social_notifications WHERE recipient_id=$1 AND is_read=FALSE',
      [req.user.sub],
    );
    res.json({ count: rows[0]?.count || 0 });
  } catch (e) {
    console.error('[GET /api/me/social-notifications/unread-count]', e);
    res.status(500).json({ error: 'Erro ao contar notificacoes sociais' });
  }
});

app.post('/api/me/social-notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE social_notifications SET is_read=TRUE WHERE recipient_id=$1 AND is_read=FALSE', [req.user.sub]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/me/social-notifications/read-all]', e);
    res.status(500).json({ error: 'Erro ao marcar notificacoes sociais' });
  }
});

app.patch('/api/me/social-notifications/:id/read', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const isRead = req.body?.read === false ? false : true;
  if (!id) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rowCount } = await pool.query(
      'UPDATE social_notifications SET is_read=$3 WHERE id=$1 AND recipient_id=$2',
      [id, req.user.sub, isRead],
    );
    if (!rowCount) return res.status(404).json({ error: 'Notificacao nao encontrada' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[PATCH /api/me/social-notifications/:id/read]', e);
    res.status(500).json({ error: 'Erro ao marcar notificacao social' });
  }
});

app.delete('/api/me/social-notifications/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID invalido' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM social_notifications WHERE id=$1 AND recipient_id=$2',
      [id, req.user.sub],
    );
    if (!rowCount) return res.status(404).json({ error: 'Notificacao nao encontrada' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/me/social-notifications/:id]', e);
    res.status(500).json({ error: 'Erro ao excluir notificacao social' });
  }
});

app.get('/api/me/xbox/friends', auth, xboxApiLimiter, async (req, res) => {
  try {
    const requestedIntegrationId = req.query.integration_id ? Number(req.query.integration_id) : null;
    if (req.query.integration_id && (!Number.isInteger(requestedIntegrationId) || requestedIntegrationId <= 0)) {
      return res.status(400).json({ error: 'invalid integration id' });
    }

    const params = [req.user.sub];
    let where = 'WHERE user_id=$1 AND xbox_xuid IS NOT NULL'; 
    if (requestedIntegrationId) {
      params.push(requestedIntegrationId);
      where += ` AND id=$${params.length}`;
    }

    const { rows: integrations } = await pool.query(
      `SELECT id, mc_name, mc_edition, is_primary, ms_refresh_token
       FROM user_integrations
       ${where}
       ORDER BY is_primary DESC, updated_at DESC NULLS LAST, id ASC`,
      params
    );
    if (!integrations.length) {
      throw new Error('Nenhuma conta Microsoft vinculada encontrada.');
    }

    const friendXuids = new Set();
    const checkedAccounts = [];
    const warnings = [];

    for (const integration of integrations) {
      if (!integration.ms_refresh_token) {
        warnings.push({
          integrationId: integration.id,
          mc_name: integration.mc_name,
          message: 'Sessão expirada. Por favor, clique em "Vincular Xbox" novamente para reconectar esta conta.'
        });
        continue; 
      }

      try {
        const accessToken = await refreshMsAccessToken(req.user.sub, integration.id);
        const xblData  = await getXboxLiveToken(accessToken);
        const xstsXbox = await getXSTSToken(xblData.Token, 'http://xboxlive.com');
        const uhs = xstsXbox.DisplayClaims?.xui?.[0]?.uhs || xblData.DisplayClaims?.xui?.[0]?.uhs;

        const friendsRes = await fetch(
          'https://peoplehub.xboxlive.com/users/me/people/social/decoration/detail',
          {
            headers: {
              'Authorization': `XBL3.0 x=${uhs};${xstsXbox.Token}`,
              'x-xbl-contract-version': '2',
              'Accept-Language': 'pt-BR',
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!friendsRes.ok) throw new Error('Não foi possível obter a lista de amigos do Xbox Live.');
        const friendsData = await friendsRes.json();
        const people = Array.isArray(friendsData.people) ? friendsData.people : [];
        people.map(p => p?.xuid).filter(Boolean).forEach(xuid => friendXuids.add(String(xuid)));
        checkedAccounts.push({
          id: integration.id,
          mc_name: integration.mc_name,
          mc_edition: integration.mc_edition || 'java',
          friendsTotal: people.length,
        });
      } catch (accountErr) {
        warnings.push({
          integrationId: integration.id,
          mc_name: integration.mc_name,
          message: accountErr.message || 'Falha ao consultar esta conta Microsoft.',
        });
      }
    }

    if (!checkedAccounts.length && warnings.length) {
      throw new Error(warnings[0].message);
    }

    let commonFriends = [];
    const xuids = Array.from(friendXuids);
    if (xuids.length > 0) {
      const { rows: matched } = await pool.query(
        `SELECT DISTINCT ON (u.id)
                u.id,
                u.username,
                u.minecraft_name,
                u.photo_url,
                ui.xbox_xuid,
                EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
         FROM user_integrations ui
         JOIN users u ON ui.user_id = u.id
         WHERE ui.xbox_xuid = ANY($1)
           AND u.id <> $2
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks ub
             WHERE (ub.blocker_id = $2 AND ub.blocked_id = u.id)
                OR (ub.blocker_id = u.id AND ub.blocked_id = $2)
           )
         ORDER BY u.id, ui.is_primary DESC, ui.updated_at DESC NULLS LAST`,
        [xuids, req.user.sub]
      );
      commonFriends = matched;
    }

    return res.json({
      xboxFriendsTotal: xuids.length,
      serverFriends: commonFriends,
      accountsChecked: checkedAccounts,
      warnings,
    });
  } catch (err) {
    console.error('[xbox/friends]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── EFETIVA A CONEXÃO (Segue os amigos encontrados) ──
app.post('/api/me/xbox/friends/sync', auth, async (req, res) => {
  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'Lista de IDs inválida' });

  let newConnections = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const targetId of user_ids) {
      const parsedId = parseInt(targetId);
      if (!parsedId || parsedId === req.user.sub) continue;

      const { rows: blocked } = await client.query(
        `SELECT 1 FROM user_blocks
         WHERE (blocker_id=$1 AND blocked_id=$2)
            OR (blocker_id=$2 AND blocked_id=$1)
         LIMIT 1`,
        [req.user.sub, parsedId]
      );
      if (blocked.length) continue;

      const { rowCount } = await client.query(
        'INSERT INTO user_follows(follower_id, following_id) VALUES($1, $2) ON CONFLICT DO NOTHING',
        [req.user.sub, parsedId]
      );

      if (rowCount > 0) {
        newConnections++;
        const { rows: target } = await client.query('SELECT minecraft_name FROM users WHERE id=$1', [parsedId]);
        await createSocialNotification({
          recipientId: parsedId,
          actorId: req.user.sub,
          type: 'new_follower',
          entityType: 'user',
          entityId: req.user.sub,
          previewText: `${req.user.minecraft_name || req.user.username} encontrou seu perfil pelo Xbox e comecou a seguir voce.`,
        }, client);
        if (target[0]?.minecraft_name) {
          await createMinecraftNotification({
            minecraftName: target[0].minecraft_name,
            title: 'Sincronia do Xbox',
            body: `${req.user.minecraft_name || req.user.username} encontrou seu perfil pelo Xbox e começou a seguir você!`,
            type: 'social', icon: '🤝', createdBy: req.user.sub
          });
        }
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, newConnections });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao sincronizar contatos' });
  } finally {
    client.release();
  }
});

app.post('/api/me/minecraft/skin', auth, xboxApiLimiter, async (req, res) => {
  const { skinUrl } = req.body;
  if (!skinUrl) return res.status(400).json({ error: 'URL da skin obrigatória' });

  try {
    // Renova token MS com verificação de erros robusta
    const accessToken = await refreshMsAccessToken(req.user.sub, null, 'java');

    const xblData = await getXboxLiveToken(accessToken);
    const xstsMC  = await getXSTSToken(xblData.Token, 'rp://api.minecraftservices.com/');
    const mcToken = await getMinecraftAccessToken(xblData.DisplayClaims.xui[0].uhs, xstsMC.Token);

    const skinPost = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${mcToken.access_token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ variant: 'classic', url: skinUrl }),
    });

    if (!skinPost.ok) throw new Error('Mojang rejeitou a troca (Verifique URL ou Rate Limit)');

    await audit({
      actorId: req.user.sub, actorName: req.user.username, type: 'update',
      message: `${req.user.username} alterou a skin oficial via Painel.`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[minecraft/skin]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ME – Preferências
// ─────────────────────────────────────────────
const DEFAULT_PREFERENCES = Object.freeze({
  email_server: true,
  email_events: true,
  email_community: true,
  public_profile: true,
  show_online: true,
  public_history: false,
  theme: 'dark',
  bio: '',
  display_name: '',
  avatar_url: '',
  cover_url: '',
  profile_layout: 'posts',
  profile_links: [],
});

const ALLOWED_THEMES = new Set(['light', 'dark', 'auto']);
const ALLOWED_PROFILE_LAYOUTS = new Set(['posts', 'replies', 'reposts', 'media']);

function normalizeSocialName(value = '') {
  return sanitize(value).replace(/\s+/g, ' ').slice(0, 40);
}

function normalizeProfileImageUrl(value = '') {
  const raw = sanitize(value).slice(0, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizePreferences(input = {}) {
  const prefs = { ...DEFAULT_PREFERENCES };
  for (const key of ['email_server', 'email_events', 'email_community', 'public_profile', 'show_online', 'public_history']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) prefs[key] = Boolean(input[key]);
  }
  if (ALLOWED_THEMES.has(input.theme)) prefs.theme = input.theme;
  if (input.bio !== undefined) prefs.bio = sanitize(input.bio).slice(0, 160);
  if (input.display_name !== undefined) prefs.display_name = normalizeSocialName(input.display_name);
  if (input.avatar_url !== undefined) prefs.avatar_url = normalizeProfileImageUrl(input.avatar_url);
  if (input.cover_url !== undefined) prefs.cover_url = normalizeProfileImageUrl(input.cover_url);
  if (ALLOWED_PROFILE_LAYOUTS.has(input.profile_layout)) prefs.profile_layout = input.profile_layout;
  if (Array.isArray(input.profile_links)) {
    prefs.profile_links = input.profile_links
      .filter(l => l && typeof l === 'object' && typeof l.url === 'string' && l.url.trim())
      .slice(0, 5)
      .map(l => ({ label: sanitize(String(l.label || '')).slice(0, 40), url: sanitize(String(l.url || '')).slice(0, 300) }));
  }
  return prefs;
}

async function ensureUserPreferences(userId, overrides = {}) {
  const prefs = normalizePreferences(overrides);
  const { rows } = await pool.query(
    `INSERT INTO user_preferences(user_id,email_server,email_events,email_community,public_profile,show_online,public_history,theme,bio,display_name,avatar_url,cover_url,profile_layout,profile_links,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       email_server=$2,
       email_events=$3,
       email_community=$4,
       public_profile=$5,
       show_online=$6,
       public_history=$7,
       theme=$8,
       bio=$9,
       display_name=$10,
       avatar_url=$11,
       cover_url=$12,
       profile_layout=$13,
       profile_links=$14,
       updated_at=NOW()
     RETURNING email_server,email_events,email_community,public_profile,show_online,public_history,theme,bio,display_name,avatar_url,cover_url,profile_layout,profile_links,updated_at`,
    [userId, prefs.email_server, prefs.email_events, prefs.email_community, prefs.public_profile, prefs.show_online, prefs.public_history, prefs.theme, prefs.bio, prefs.display_name, prefs.avatar_url, prefs.cover_url, prefs.profile_layout, JSON.stringify(prefs.profile_links)],
  );
  return rows[0];
}

app.get('/api/me/preferences', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email_server,email_events,email_community,public_profile,show_online,public_history,theme,bio,display_name,avatar_url,cover_url,profile_layout,profile_links,updated_at FROM user_preferences WHERE user_id=$1',
    [req.user.sub],
  );
  if (rows.length) return res.json(normalizePreferences(rows[0]));
  const prefs = await ensureUserPreferences(req.user.sub);
  res.json(normalizePreferences(prefs));
});

app.put('/api/me/preferences', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email_server,email_events,email_community,public_profile,show_online,public_history,theme,bio,display_name,avatar_url,cover_url,profile_layout,profile_links FROM user_preferences WHERE user_id=$1',
    [req.user.sub],
  );
  const prefs = await ensureUserPreferences(req.user.sub, { ...(rows[0] || {}), ...(req.body || {}) });
  await audit({
    actorId: req.user.sub,
    actorName: req.user.username,
    type: 'update',
    targetId: req.user.sub,
    targetName: req.user.username,
    message: 'Preferências da conta atualizadas',
    metadata: { preferences: normalizePreferences(prefs) },
  });
  res.json(normalizePreferences(prefs));
});

// ─────────────────────────────────────────────
// NOTIFICAÇÕES
// ─────────────────────────────────────────────
app.get('/api/notifications', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();
  try {
    const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, (nr.user_id IS NOT NULL) AS is_read FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nd.user_id IS NULL AND COALESCE(n.scheduled_for, n.created_at) <= NOW() AND (n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4)) ORDER BY COALESCE(n.scheduled_for, n.created_at) DESC LIMIT 100`, [userId, role, String(userId), mc]);
    res.json(rows);
  } catch (err) { console.error('[GET /api/notifications]', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/notifications/unread-count', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nr.user_id IS NULL AND nd.user_id IS NULL AND COALESCE(n.scheduled_for, n.created_at) <= NOW() AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) )`, [userId, role, String(userId), mc]);
    res.json({ count: rows[0].count });
  } catch (err) { console.error('[GET /api/notifications/unread-count]', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  try {
    const visible = await pool.query(
      `SELECT id FROM notifications WHERE id=$1 AND COALESCE(scheduled_for, created_at) <= NOW() AND ( audience='all' OR (audience='role' AND audience_val=$2) OR (audience='user' AND audience_val=$3::text) OR (audience='minecraft' AND LOWER(audience_val)=$4) )`,
      [id, role, String(req.user.sub), mc],
    );
    if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });
    await pool.query(`INSERT INTO notification_reads(notification_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);
    res.json({ ok: true });
  } catch (err) { console.error('[POST /api/notifications/:id/read]', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/notifications/:id/click', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  try {
    const visible = await pool.query(
      `SELECT id FROM notifications WHERE id=$1 AND COALESCE(scheduled_for, created_at) <= NOW() AND ( audience='all' OR (audience='role' AND audience_val=$2) OR (audience='user' AND audience_val=$3::text) OR (audience='minecraft' AND LOWER(audience_val)=$4) )`,
      [id, role, String(req.user.sub), mc],
    );
    if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });
    await pool.query(
      `INSERT INTO notification_clicks(notification_id,user_id,clicked_at)
       SELECT id,$2,NOW() FROM notifications WHERE id=$1
       ON CONFLICT(notification_id,user_id) DO UPDATE SET clicked_at=NOW()`,
      [id, req.user.sub],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/notifications/:id/click]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const role = req.user.role;
  const mc = (req.user.minecraft_name || '').toLowerCase();
  try {
    const visible = await pool.query(
      `SELECT id FROM notifications WHERE id=$1 AND COALESCE(scheduled_for, created_at) <= NOW() AND ( audience='all' OR (audience='role' AND audience_val=$2) OR (audience='user' AND audience_val=$3::text) OR (audience='minecraft' AND LOWER(audience_val)=$4) )`,
      [id, role, String(req.user.sub), mc],
    );
    if (!visible.rowCount) return res.status(404).json({ error: 'notification not found' });
    await pool.query(`INSERT INTO notification_deletes(notification_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);
    res.json({ ok: true });
  } catch (err) { console.error('[DELETE /api/notifications/:id]', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const mc     = (req.user.minecraft_name || '').toLowerCase();
  try {
    await pool.query(`INSERT INTO notification_reads(notification_id, user_id) SELECT n.id, $1 FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1 LEFT JOIN notification_deletes nd ON nd.notification_id = n.id AND nd.user_id = $1 WHERE nr.user_id IS NULL AND nd.user_id IS NULL AND COALESCE(n.scheduled_for, n.created_at) <= NOW() AND ( n.audience = 'all' OR (n.audience = 'role'      AND n.audience_val = $2) OR (n.audience = 'user'      AND n.audience_val = $3::text) OR (n.audience = 'minecraft' AND LOWER(n.audience_val) = $4) ) ON CONFLICT DO NOTHING`, [userId, role, String(userId), mc]);
    res.json({ ok: true });
  } catch (err) { console.error('[POST /api/notifications/read-all]', err); res.status(500).json({ error: 'Erro interno' }); }
});

async function enforceDashboardBroadcastLimit() {
  const settings = await getRuntimeDashboardSettings();
  if (settings.broadcast_channels?.dashboard === false) {
    const error = new Error('O canal Dashboard esta desativado nas configuracoes.');
    error.status = 409;
    throw error;
  }
  const limit = Number(settings.broadcast_max_per_day ?? 8);
  if (limit <= 0) {
    const error = new Error('Broadcasts estao desativados nas configuracoes.');
    error.status = 409;
    throw error;
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM notifications WHERE created_at >= CURRENT_DATE');
  if (Number(rows[0]?.total || 0) >= limit) {
    const error = new Error(`Limite diario de ${limit} broadcasts atingido.`);
    error.status = 429;
    throw error;
  }
}

app.post('/api/admin/notifications', auth, requireAdmin, async (req, res) => {
  try {
    await enforceDashboardBroadcastLimit();
    const title       = sanitize(req.body?.title);
    const body        = sanitize(req.body?.body);
    const type        = ['info','event','system','social','warning'].includes(req.body?.type) ? req.body.type : 'info';
    const icon        = sanitize(req.body?.icon || '🔔').slice(0, 10);
    const audience    = ['all','role','user','minecraft'].includes(req.body?.audience) ? req.body.audience : 'all';
    const audienceVal = req.body?.audience_val ? sanitize(String(req.body.audience_val)) : null;
    const scheduledFor = req.body?.scheduled_for ? new Date(req.body.scheduled_for) : null;
    const linkUrl = req.body?.link_url ? sanitize(String(req.body.link_url)).slice(0, 1000) : null;

    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    if (scheduledFor && Number.isNaN(scheduledFor.getTime())) return res.status(400).json({ error: 'invalid scheduled_for' });

    if (audience === 'role' && !['owner','full','limited'].includes(audienceVal)) return res.status(400).json({ error: 'invalid role' });
    if (audience === 'user') {
      const uid = parseInt(audienceVal);
      if (!uid) return res.status(400).json({ error: 'invalid user id' });
      const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [uid]);
      if (!rows.length) return res.status(404).json({ error: 'user not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by,scheduled_for,link_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [title, body, type, icon, audience, audienceVal, req.user.sub, scheduledFor?.toISOString() || null, linkUrl],
    );

    await audit({
      actorId: req.user.sub, actorName: req.user.username, type: 'notify',
      message: `${scheduledFor && scheduledFor > new Date() ? 'Notificação agendada' : 'Notificação criada'}: "${title}"`, metadata: { notificationId: rows[0].id, scheduledFor },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[notification post error]', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao criar notificação' });
  }
});

app.get('/api/admin/notifications', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT n.*, u.username AS created_by_name, COUNT(DISTINCT nr.user_id)::int AS read_count, COUNT(DISTINCT nc.user_id)::int AS click_count, CASE WHEN n.scheduled_for > NOW() THEN 'scheduled' ELSE 'published' END AS delivery_status FROM notifications n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN notification_reads nr ON nr.notification_id = n.id LEFT JOIN notification_clicks nc ON nc.notification_id=n.id GROUP BY n.id, u.username ORDER BY COALESCE(n.scheduled_for,n.created_at) DESC`);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/admin/notifications]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/notifications/:id/resend', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    await enforceDashboardBroadcastLimit();
    const { rows } = await pool.query(`
      INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by,scheduled_for,link_url)
      SELECT title,body,type,icon,audience,audience_val,$2,NULL,link_url
      FROM notifications WHERE id=$1
      RETURNING *
    `, [id, req.user.sub]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    await auditFromReq(req, {
      actorId: req.user.sub,
      actorName: req.user.username,
      type: 'notify',
      severity: 'info',
      targetId: rows[0].id,
      message: `NotificaÃ§Ã£o #${id} reenviada por ${req.user.username}`,
      metadata: { originalNotificationId: id, notificationId: rows[0].id },
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/admin/notifications/:id/resend]', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

app.delete('/api/admin/notifications/:id', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM notifications WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    await auditFromReq(req, {
      actorId:   req.user.sub,
      actorName: req.user.username,
      type:      'delete',
      severity:  'info',
      targetId:  id,
      message:   `Notificação #${id} deletada por ${req.user.username}`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/admin/notifications/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────
app.get('/api/admin/audit', auth, requireAdmin, async (req, res) => {
  try {
    const type     = req.query.type && req.query.type !== 'all' ? req.query.type : null;
    const severity = req.query.severity && req.query.severity !== 'all' ? req.query.severity : null;
    const actor    = req.query.actor || null;
    const days     = Math.min(3650, Math.max(1, parseInt(req.query.days || 30, 10)));
    const page     = Math.max(0, parseInt(req.query.page  || 0));
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit || 50)));

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (type)     { conditions.push(`type=$${p++}`);              params.push(type); }
    if (severity) { conditions.push(`severity=$${p++}`);          params.push(severity); }
    if (actor)    { conditions.push(`(actor_name ILIKE $${p} OR message ILIKE $${p} OR target_name ILIKE $${p})`); params.push(`%${actor}%`); p++; }
    conditions.push(`created_at >= NOW() - ($${p++}::int * INTERVAL '1 day')`); params.push(days);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataParams  = [...params, limit, page * limit];
    const countParams = [...params];

    const { rows } = await pool.query(
      `SELECT id, actor_id, actor_name, type, severity, target_id, target_name,
              message, metadata, ip, user_agent, session_id, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      dataParams,
    );

    const { rows: total } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_logs ${where}`,
      countParams,
    );

    res.json({
      logs:       rows,
      total:      total[0].count,
      page,
      limit,
      totalPages: Math.ceil(total[0].count / limit),
    });
  } catch (error) {
    console.error('[GET /api/admin/audit error]', error);
    res.status(500).json({ error: 'Erro interno ao procurar logs.' });
  }
});

app.get('/api/admin/audit/export', auth, requireOwner, async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.type && req.query.type !== 'all') { params.push(req.query.type); conditions.push(`type=$${params.length}`); }
    if (req.query.severity && req.query.severity !== 'all') { params.push(req.query.severity); conditions.push(`severity=$${params.length}`); }
    if (req.query.actor) { params.push(`%${sanitize(req.query.actor)}%`); conditions.push(`(actor_name ILIKE $${params.length} OR message ILIKE $${params.length} OR target_name ILIKE $${params.length})`); }
    params.push(Math.min(3650, Math.max(1, parseInt(req.query.days || 30, 10)))); conditions.push(`created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, actor_name, type, severity, target_name, message, ip, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT 10000`,
      params,
    );

    const header = 'id,actor,tipo,severidade,alvo,mensagem,ip,data_hora\n';
    const csv = rows.map(r => [
      r.id,
      `"${(r.actor_name || '').replace(/"/g, '""')}"`,
      r.type,
      r.severity,
      `"${(r.target_name || '').replace(/"/g, '""')}"`,
      `"${(r.message || '').replace(/"/g, '""')}"`,
      r.ip || '',
      new Date(r.created_at).toISOString(),
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
    res.send('\uFEFF' + header + csv); // BOM para Excel PT-BR
  } catch (e) {
    res.status(500).json({ error: 'Falha ao exportar' });
  }
});

// ─────────────────────────────────────────────
// NOTAS DE JOGADORES
// ─────────────────────────────────────────────
app.get('/api/admin/notes/:minecraft_name', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.minecraft_name).toLowerCase();
  const { rows } = await pool.query(
    'SELECT * FROM player_notes WHERE LOWER(minecraft_name) = $1 ORDER BY created_at DESC',
    [mc],
  );
  res.json(rows);
});

app.post('/api/admin/notes', auth, requireAdmin, async (req, res) => {
  const { minecraft_name, text } = req.body || {};
  if (!minecraft_name || !text) return res.status(400).json({ error: 'Campos ausentes' });

  const { rows } = await pool.query(
    'INSERT INTO player_notes(minecraft_name, author_id, author_name, text) VALUES($1, $2, $3, $4) RETURNING *',
    [sanitize(minecraft_name), req.user.sub, req.user.username, sanitize(text)],
  );
  await auditFromReq(req, {
    actorId:    req.user.sub,
    actorName:  req.user.username,
    type:       'create',
    targetName: sanitize(minecraft_name),
    message:    `Nota adicionada ao jogador ${sanitize(minecraft_name)} por ${req.user.username}`,
  });
  res.json(rows[0]);
});

app.delete('/api/admin/notes/:id', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'invalid id' });
  await pool.query('DELETE FROM player_notes WHERE id = $1', [noteId]);
  await auditFromReq(req, {
    actorId:   req.user.sub,
    actorName: req.user.username,
    type:      'delete',
    targetId:  noteId,
    message:   `Nota #${noteId} excluída por ${req.user.username}`,
  });
  res.json({ ok: true });
});

app.get('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc = sanitize(req.params.name).toLowerCase();
  const { rows } = await pool.query(
  'SELECT id, author_name, text, created_at FROM player_notes WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC',
  [mc],
  );
  res.json(rows);
});

app.post('/api/player/:name/notes', auth, requireAdmin, async (req, res) => {
  const mc   = sanitize(req.params.name);
  const text = sanitize(req.body?.text || '');
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 1000) return res.status(400).json({ error: 'text too long' });

const { rows } = await pool.query(
'INSERT INTO player_notes(minecraft_name,author_id,author_name,text) VALUES($1,$2,$3,$4) RETURNING *',
[mc, req.user.sub, req.user.username, text],
);
res.status(201).json(rows[0]);
});

app.delete('/api/player/:name/notes/:noteId', auth, requireAdmin, async (req, res) => {
  const noteId = parseInt(req.params.noteId);
  const mc     = sanitize(req.params.name).toLowerCase();
  if (!noteId) return res.status(400).json({ error: 'invalid id' });

const ownClause = req.user.role === 'owner' ? '' : 'AND author_id=$3';
const params    = req.user.role === 'owner'
? [noteId, mc]
: [noteId, mc, req.user.sub];

const { rowCount } = await pool.query(
`DELETE FROM player_notes WHERE id=$1 AND LOWER(minecraft_name)=$2 ${ownClause}`,
params,
);
if (!rowCount) return res.status(404).json({ error: 'note not found or unauthorized' });
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// ANALYTICS & BIG DATA 
// ─────────────────────────────────────────────

registerAdminAnalytics(app, pool, auth, requireAdmin);
registerAdminDashboardV2(app, pool, auth, requireAdmin, requireOwner, auditFromReq);

app.get('/api/admin/analytics/activity', auth, requireAdmin, async (req, res) => {
  try {
    const { rows: monthly } = await pool.query(`
      SELECT 
        TO_CHAR(entered_at, 'YYYY-MM') as month,
        SUM(duration_hours) as total_hours,
        COUNT(id) as sessions_count
      FROM player_sessions 
      WHERE duration_hours IS NOT NULL
      GROUP BY TO_CHAR(entered_at, 'YYYY-MM')
      ORDER BY month ASC
    `);

    const { rows: topPlayers } = await pool.query(`
      SELECT player, SUM(duration_hours) as total_hours 
      FROM player_sessions 
      WHERE duration_hours IS NOT NULL 
      GROUP BY player 
      ORDER BY total_hours DESC 
      LIMIT 10
    `);

    const { rows: summary } = await pool.query(`
      SELECT 
        COUNT(id)::int as total_sessions, 
        SUM(duration_hours)::float as total_hours,
        COUNT(DISTINCT player)::int as unique_players
      FROM player_sessions
    `);

    res.json({
      summary: summary[0],
      monthly: monthly,
      topPlayers: topPlayers
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Erro ao gerar relatórios analíticos' });
  }
});

app.get('/api/admin/sessions/history', auth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || 0));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20)));
    const search = req.query.q ? `%${sanitize(req.query.q).toLowerCase()}%` : null;

    let query = 'FROM player_sessions WHERE left_at IS NOT NULL';
    let params = [limit, page * limit];

    if (search) {
      query += ' AND LOWER(player) LIKE $3';
      params.push(search);
    }

    const { rows } = await pool.query(
      `SELECT id, player, entered_at, left_at, duration_hours 
       ${query} 
       ORDER BY left_at DESC 
       LIMIT $1 OFFSET $2`,
      params
    );
    
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int as total ${query}`,
      search ? [search] : []
    );

    res.json({ 
      data: rows, 
      total: countRows[0].total, 
      page, 
      limit,
      totalPages: Math.ceil(countRows[0].total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro na paginação de histórico' });
  }
});

app.get('/api/players/unregistered', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ps.player, COUNT(ps.id)::int AS total_sessions, COALESCE(SUM(ps.duration_hours), 0)::float AS total_hours, MIN(ps.entered_at) AS first_seen, MAX(COALESCE(ps.left_at, ps.entered_at)) AS last_seen 
      FROM player_sessions ps 
      WHERE NOT EXISTS ( SELECT 1 FROM users u WHERE LOWER(u.minecraft_name) = LOWER(ps.player) ) 
      GROUP BY ps.player ORDER BY last_seen DESC LIMIT 500
    `);
    res.json(rows);
  } catch (err) {
    console.error('[unregistered error]', err);
    res.status(500).json({ error: 'Erro ao buscar jogadores' });
  }
});

app.get('/api/player/:name/history', auth, requireAdmin, async (req, res) => {
const mc = sanitize(req.params.name).toLowerCase();
const { rows } = await pool.query(
'SELECT entered_at, left_at, duration_hours FROM player_sessions WHERE LOWER(player)=$1 ORDER BY entered_at DESC',
[mc],
);
res.json(rows);
});

// ─────────────────────────────────────────────
// ADMIN – Gerenciamento de usuários
// ─────────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (_req, res) => {
try {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.email, u.minecraft_name, u.photo_url, u.role, u.is_verified, u.is_platform_verified, u.created_at,
      COALESCE(pb.merit_total, 0)     AS merit_total,
      COALESCE(pb.capital_balance, 0) AS capital_balance,
      COALESCE(pb.rank, 'ferro')      AS rank
    FROM users u
    LEFT JOIN player_balances pb ON pb.minecraft_name = LOWER(u.minecraft_name)
    ORDER BY u.id DESC
  `);
  res.json(rows);
} catch (err) {
  console.error('[GET /api/admin/users error]', err);
  res.status(500).json({ error: 'Internal server error' });}
});

app.get('/api/admin/users/:id/insights', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  try {
    const [
      profileResult,
      socialResult,
      gameResult,
      providersResult,
      legacyResult,
    ] = await Promise.all([
      pool.query(`
        SELECT u.id, u.username, u.email, u.minecraft_name, u.role, u.is_verified, u.is_platform_verified, u.created_at,
          COALESCE(up.display_name,'') AS display_name,
          COALESCE(up.bio,'') AS bio,
          COALESCE(up.avatar_url,'') AS avatar_url,
          COALESCE(up.cover_url,'') AS cover_url,
          COALESCE(up.profile_links,'[]'::jsonb) AS profile_links,
          COALESCE(up.public_profile,TRUE) AS public_profile,
          COALESCE(up.show_online,TRUE) AS show_online,
          COALESCE(up.public_history,FALSE) AS public_history
        FROM users u
        LEFT JOIN user_preferences up ON up.user_id=u.id
        WHERE u.id=$1
      `, [id]),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM user_posts WHERE author_id=$1 AND repost_of_id IS NULL) AS posts,
          (SELECT COUNT(*)::int FROM user_posts WHERE author_id=$1 AND repost_of_id IS NOT NULL) AS reposts,
          (SELECT COUNT(*)::int FROM post_comments WHERE author_id=$1 AND is_deleted=FALSE) AS comments,
          (SELECT COUNT(*)::int FROM post_likes WHERE user_id=$1) AS likes_given,
          (SELECT COUNT(*)::int FROM post_saves WHERE user_id=$1) AS saves,
          (SELECT COUNT(*)::int FROM user_follows WHERE following_id=$1) AS followers,
          (SELECT COUNT(*)::int FROM user_follows WHERE follower_id=$1) AS following,
          (SELECT COUNT(*)::int FROM direct_messages WHERE sender_id=$1 AND is_deleted=FALSE)
            + (SELECT COUNT(*)::int FROM chat_group_messages WHERE sender_id=$1 AND is_deleted=FALSE) AS messages,
          (SELECT COUNT(*)::int FROM social_notifications WHERE recipient_id=$1 AND is_read=FALSE) AS unread_notifications,
          (SELECT COUNT(*)::int FROM content_reports WHERE reporter_id=$1) AS reports_made,
          (SELECT COUNT(*)::int FROM content_reports WHERE content_type='user' AND content_id=$1) AS reports_received,
          GREATEST(
            COALESCE((SELECT MAX(created_at) FROM user_posts WHERE author_id=$1), 'epoch'::timestamptz),
            COALESCE((SELECT MAX(created_at) FROM post_comments WHERE author_id=$1), 'epoch'::timestamptz),
            COALESCE((SELECT MAX(created_at) FROM direct_messages WHERE sender_id=$1), 'epoch'::timestamptz),
            COALESCE((SELECT MAX(created_at) FROM chat_group_messages WHERE sender_id=$1), 'epoch'::timestamptz)
          ) AS last_social_activity
      `, [id]),
      pool.query(`
        WITH target AS (SELECT minecraft_name FROM users WHERE id=$1)
        SELECT
          COUNT(ps.id)::int AS sessions,
          COALESCE(SUM(ps.duration_hours),0)::float AS total_hours,
          COALESCE(AVG(ps.duration_hours) FILTER (WHERE ps.duration_hours IS NOT NULL),0)::float AS avg_session_hours,
          MIN(ps.entered_at) AS first_seen,
          MAX(COALESCE(ps.left_at,ps.entered_at)) AS last_seen,
          COUNT(*) FILTER (WHERE ps.left_at IS NULL)::int > 0 AS is_online,
          COALESCE(pb.merit_total,0)::int AS merit,
          COALESCE(pb.capital_balance,0)::float AS capital,
          COALESCE(pb.rank,'ferro') AS rank
        FROM target
        LEFT JOIN player_sessions ps ON LOWER(ps.player)=LOWER(target.minecraft_name)
        LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name)=LOWER(target.minecraft_name)
        GROUP BY pb.merit_total, pb.capital_balance, pb.rank
      `, [id]),
      pool.query(`
        SELECT provider, label, connected_at FROM (
          SELECT LOWER(provider) AS provider, COALESCE(provider_email, provider) AS label, created_at AS connected_at
          FROM social_accounts WHERE user_id=$1
          UNION ALL
          SELECT 'microsoft' AS provider, COALESCE(xbox_gamertag, mc_name, 'Microsoft / Xbox') AS label, created_at AS connected_at
          FROM user_integrations WHERE user_id=$1
        ) providers
        ORDER BY connected_at DESC
      `, [id]),
      pool.query(`
        SELECT am.id, am.legacy_username, am.status, am.migration_mode, am.verification_tier,
          am.executed_at, am.created_at, ua.alias_username, ua.is_active AS alias_active
        FROM account_migrations am
        LEFT JOIN username_aliases ua ON ua.migration_id=am.id
        WHERE am.user_id=$1
        ORDER BY am.created_at DESC
        LIMIT 10
      `, [id]),
    ]);

    if (!profileResult.rows.length) return res.status(404).json({ error: 'user not found' });
    res.json({
      profile: profileResult.rows[0],
      social: socialResult.rows[0] || {},
      game: gameResult.rows[0] || {},
      providers: providersResult.rows,
      legacy: legacyResult.rows,
    });
  } catch (err) {
    console.error('[GET /api/admin/users/:id/insights]', err);
    res.status(500).json({ error: 'Erro ao carregar inteligência do perfil.' });
  }
});

app.post('/api/admin/users', auth, requireOwner, async (req, res) => {
const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const password      = req.body?.password || '';
const ALLOWED_ROLES = ['owner','full','limited'];
const role          = ALLOWED_ROLES.includes(req.body?.role) ? req.body.role : 'limited';

if (!validateUsername(username) || !validateEmail(email) || !validatePassword(password))
return res.status(400).json({ error: 'invalid fields' });

try {
const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query(
'INSERT INTO users(username,email,minecraft_name,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5,TRUE) RETURNING id',
[username, email, minecraftName, hash, role],
);

await audit({
  actorId: req.user.sub, actorName: req.user.username,
  type: 'create', targetId: rows[0].id, targetName: username,
  message: `Conta criada por admin: ${username} (${role})`,
});

res.json(rows[0]);

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

app.put('/api/admin/users/:id', auth, requireOwner, async (req, res) => {
const id            = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });

const username      = sanitize(req.body?.username).toLowerCase();
const email         = sanitize(req.body?.email).toLowerCase();
const minecraftName = sanitize(req.body?.minecraftName || username);
const photoUrl      = sanitize(req.body?.photoUrl || 'assets/images/fa-icon-dark.png');
const ALLOWED_ROLES = ['owner','full','limited'];
const role          = ALLOWED_ROLES.includes(req.body?.role) ? req.body.role : 'limited';

if (!validateUsername(username) || !validateEmail(email))
return res.status(400).json({ error: 'invalid fields' });

try {
const { rows: before } = await pool.query(
  'SELECT username, email, minecraft_name, role FROM users WHERE id=$1', [id]
);

const result = await pool.query(
'UPDATE users SET username=$1, email=$2, minecraft_name=$3, photo_url=$4, role=$5 WHERE id=$6',
[username, email, minecraftName, photoUrl, role, id],
);
if (!result.rowCount) return res.status(404).json({ error: 'user not found' });

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'update',
  severity:   before[0]?.role !== role ? 'warning' : 'info',
  targetId:   id,
  targetName: username,
  message:    `Conta editada por admin: ${before[0]?.username || username} → ${username}${before[0]?.role !== role ? ` (cargo: ${before[0]?.role} → ${role})` : ''}`,
  metadata: {
    before: before[0] || null,
    after:  { username, email, minecraftName, role },
  },
});

res.json({ ok: true });

} catch {
res.status(409).json({ error: 'username/email already exists' });
}
});

app.put('/api/admin/users/:id/password', auth, requireOwner, async (req, res) => {
const id          = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });
const newPassword = req.body?.newPassword || '';
if (!validatePassword(newPassword))
return res.status(400).json({ error: 'invalid new password' });

const { rows: target } = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
if (!target.length) return res.status(404).json({ error: 'user not found' });

const hash = await bcrypt.hash(newPassword, 10);
await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'security',
  severity:   'warning',
  targetId:   id,
  targetName: target[0].username,
  message:    `Senha redefinida por admin (${req.user.username}) para o usuário: ${target[0].username}`,
});

res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, requireOwner, async (req, res) => {
const id = parseInt(req.params.id);
if (!id) return res.status(400).json({ error: 'invalid id' });

const { rows } = await pool.query('SELECT username FROM users WHERE id=$1', [id]);
if (!rows.length) return res.status(404).json({ error: 'user not found' });

await auditFromReq(req, {
  actorId:    req.user.sub,
  actorName:  req.user.username,
  type:       'delete',
  severity:   'critical',
  targetId:   id,
  targetName: rows[0].username,
  message:    `Conta DELETADA por admin (${req.user.username}): ${rows[0].username}`,
  metadata:   { deletedUser: rows[0].username, deletedId: id },
});

await pool.query('DELETE FROM users WHERE id=$1', [id]);
res.json({ ok: true });
});

// ─────────────────────────────────────────────
// VERIFICAÇÃO DE PLATAFORMA (Selo ✓)
// O admin/owner concede ou revoga o selo de verificação manualmente
// pelo dashboard. Não é e-mail — é um distintivo de identidade notável
// atribuído pela staff a jogadores, criadores ou figuras reconhecidas.
// ─────────────────────────────────────────────
app.patch('/api/admin/users/:id/verified', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const grant = req.body?.grant === true || req.body?.grant === 'true';
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_platform_verified = $1 WHERE id = $2 RETURNING id, username, is_platform_verified`,
      [grant, id],
    );
    if (!rows.length) return res.status(404).json({ error: 'user not found' });
    await auditFromReq(req, {
      actorId:   req.user.sub,
      actorName: req.user.username,
      type:      'moderation',
      severity:  'info',
      targetId:  id,
      targetName: rows[0].username,
      message:   `Verificação de plataforma ${grant ? 'concedida' : 'revogada'} para ${rows[0].username} por ${req.user.username}`,
    });
    res.json({ ok: true, is_platform_verified: rows[0].is_platform_verified });
  } catch (e) {
    console.error('[PATCH /api/admin/users/:id/verified]', e);
    res.status(500).json({ error: 'Erro ao alterar verificação.' });
  }
});

// ─────────────────────────────────────────────
// SISTEMA DE CAPITAL E MÉRITO
// ─────────────────────────────────────────────

const RANKS = [
  { id: 'ferro',     label: 'Ferro',     icon: '🪨', minMerit: 0,    maxMerit: 149,  color: '#8E8E93' },
  { id: 'ouro',      label: 'Ouro',      icon: '🟡', minMerit: 150,  maxMerit: 499,  color: '#FF9F0A' },
  { id: 'diamante',  label: 'Diamante',  icon: '🟢', minMerit: 500,  maxMerit: 999,  color: '#30D158' },
  { id: 'netherite', label: 'Netherite', icon: '⚫', minMerit: 1000, maxMerit: null, color: '#AF52DE' },
];
const ADM_RANK = { id: 'adm', label: 'Administrador', icon: '👑', minMerit: null, maxMerit: null, color: '#0071E3' };

const OWNER_RANK = { id: 'owner', label: 'Dono', icon: 'DONO', minMerit: null, maxMerit: null, color: '#B91C1C' };

function getRankByMerit(merit) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (merit >= RANKS[i].minMerit) return RANKS[i];
  }
  return RANKS[0];
}

function getRankById(id) {
  if (id === 'adm') return ADM_RANK;
  if (id === 'owner') return OWNER_RANK;
  return RANKS.find(r => r.id === id) || RANKS[0];
}

const RANK_BENEFITS = {
  ferro:     ['Cargo inicial', 'Limite de saque: 64 💰 (1 pack)', 'Acesso padrão ao servidor'],
  ouro:      ['Participação em votações', 'Limite de saque: 128 💰 (2 packs)', 'Menor taxa de juros em empréstimos', 'Acesso à playlist musical no Discord'],
  diamante:  ['Participação em votações', 'Limite de saque: 192 💰 (3 packs)', 'Taxa de juros reduzida', 'Publicação na wiki do servidor'],
  netherite: ['Participação em votações', 'Limite de saque: 320 💰 (5 packs)', 'Taxa de juros mínima', 'Publicação na wiki do servidor', 'Cartão Netherite no Banco'],
  adm:       ['Cargo administrativo', 'Independente do sistema de Mérito', 'Acesso total ao painel'],
};

async function recalcRank(mcName, meritTotal) {
  const settings = await getRuntimeDashboardSettings();
  const thresholds = settings.rank_thresholds || {};
  const rankId = meritTotal >= Number(thresholds.netherite ?? 1000) ? 'netherite'
    : meritTotal >= Number(thresholds.diamante ?? 500) ? 'diamante'
    : meritTotal >= Number(thresholds.ouro ?? 150) ? 'ouro'
    : 'ferro';
  const rank = getRankById(rankId);
  await pool.query(`
    INSERT INTO player_balances(minecraft_name, merit_total, rank, updated_at)
    VALUES($1, $2, $3, NOW())
    ON CONFLICT(minecraft_name) DO UPDATE SET
      merit_total = $2, rank = $3, updated_at = NOW()
  `, [mcName.toLowerCase(), meritTotal, rank.id]);
  return rank;
}

async function ensureBalance(mcName) {
  const mc = mcName.toLowerCase();
  await pool.query(`
    INSERT INTO player_balances(minecraft_name, merit_total, capital_balance, rank)
    VALUES($1, 0, 0, 'ferro')
    ON CONFLICT(minecraft_name) DO NOTHING
  `, [mc]);
  const { rows } = await pool.query('SELECT * FROM player_balances WHERE minecraft_name=$1', [mc]);
  return rows[0];
}

app.get('/api/me/merit', auth, async (req, res) => {
  if (!req.user.minecraft_name)
    return res.json({ merit: 0, rank: RANKS[0], nextRank: RANKS[1], progress: 0, records: [] });

  const mc = req.user.minecraft_name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100',
    [mc]
  );

  const merit = balance.merit_total;
  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit,
    rank: { ...rank, benefits: RANK_BENEFITS[rank.id] || [] },
    nextRank: nextRank ? { ...nextRank, benefits: RANK_BENEFITS[nextRank.id] || [] } : null,
    progress,
    records,
  });
});

app.get('/api/me/capital', auth, async (req, res) => {
  if (!req.user.minecraft_name)
    return res.json({ capital: 0, records: [] });

  const mc = req.user.minecraft_name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, type, description, created_by_name, created_at FROM capital_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100',
    [mc]
  );

  res.json({ capital: balance.capital_balance, records });
});

app.get('/api/me/rank-info', auth, async (req, res) => {
  const mc = req.user.minecraft_name?.toLowerCase();
  let merit = 0;
  let capital = 0;
  let records = [];
  let capitalRecords = [];

  if (mc) {
    // Garante que o registro existe antes de ler (insert-on-conflict é idempotente)
    await ensureBalance(mc);
    // Lê balance + histórico em paralelo (3 queries simultâneas)
    const [balanceRes, meritRows, capitalRows] = await Promise.all([
      pool.query('SELECT * FROM player_balances WHERE minecraft_name=$1', [mc]),
      pool.query('SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100', [mc]),
      pool.query('SELECT id, amount, type, description, created_by_name, created_at FROM capital_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 100', [mc]),
    ]);
    merit = balanceRes.rows[0]?.merit_total || 0;
    capital = balanceRes.rows[0]?.capital_balance || 0;
    records = meritRows.rows;
    capitalRecords = capitalRows.rows;
  }

  if (['owner', 'full'].includes(req.user.role)) {
    const staffRank = req.user.role === 'owner' ? OWNER_RANK : ADM_RANK;
    return res.json({
      merit,
      capital,
      rank: { ...staffRank, benefits: RANK_BENEFITS[staffRank.id] || RANK_BENEFITS.adm || [] },
      nextRank: null,
      progress: 100,
      isAdm: true,
      records,
      capitalRecords,
      allRanks: [...RANKS, ADM_RANK, OWNER_RANK],
    });
  }

  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit,
    capital,
    rank: { ...rank, benefits: RANK_BENEFITS[rank.id] || [] },
    nextRank: nextRank ? { ...nextRank, benefits: RANK_BENEFITS[nextRank.id] || [] } : null,
    progress,
    isAdm: false,
    records,
    capitalRecords,
    allRanks: RANKS,
  });
});

app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || 20)));
  const { rows } = await pool.query(`
    SELECT pb.minecraft_name, pb.merit_total, pb.rank, pb.capital_balance
    FROM player_balances pb
    WHERE pb.merit_total > 0
    ORDER BY pb.merit_total DESC
    LIMIT $1
  `, [limit]);

  res.json(rows.map((r, i) => ({
    position: i + 1,
    minecraft_name: r.minecraft_name,
    merit: r.merit_total,
    rank: getRankById(r.rank),
    capital: r.capital_balance,
  })));
});

app.get('/api/player/:name/merit', auth, requireAdmin, async (req, res) => {
  const mc = req.params.name.toLowerCase();
  const balance = await ensureBalance(mc);

  const { rows: records } = await pool.query(
    'SELECT id, amount, reason, category, awarded_by_name, created_at FROM merit_records WHERE LOWER(minecraft_name)=$1 ORDER BY created_at DESC LIMIT 200',
    [mc]
  );

  const merit = balance.merit_total;
  const rank = getRankByMerit(merit);
  const nextRankIdx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const nextRank = nextRankIdx < RANKS.length ? RANKS[nextRankIdx] : null;
  const progress = nextRank
    ? Math.round(((merit - rank.minMerit) / (nextRank.minMerit - rank.minMerit)) * 100)
    : 100;

  res.json({
    merit, rank, nextRank, progress,
    capital: balance.capital_balance,
    records,
  });
});

app.post('/api/admin/merit', auth, requireAdmin, async (req, res) => {
  const mc       = sanitize(req.body?.minecraft_name).toLowerCase();
  const rawAmount = parseInt(req.body?.amount);
  const op       = ['credit', 'credito', 'add', 'conceder'].includes(req.body?.type) ? 'credit'
    : ['debit', 'debito', 'remove', 'penalidade'].includes(req.body?.type) ? 'debit'
    : null;
  const amount   = op === 'debit' || (!op && rawAmount < 0) ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const reason   = sanitize(req.body?.reason);
  const category = ['doacao', 'servico', 'evento', 'construcao', 'habito', 'acordo', 'penalidade', 'outro', 'outros'].includes(req.body?.category)
    ? (req.body.category === 'outro' ? 'outros' : req.body.category) : 'outros';

  if (!mc || isNaN(rawAmount) || rawAmount === 0 || !reason)
    return res.status(400).json({ error: 'Dados inválidos: minecraft_name, amount (≠0) e reason são obrigatórios.' });

  if (Math.abs(amount) > 500)
    return res.status(400).json({ error: 'Limite de ±500 Mérito por transação.' });

  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT merit_total FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentMerit = cur[0]?.merit_total || 0;
  const newMerit = Math.max(0, currentMerit + amount);

  await pool.query(
    'INSERT INTO merit_records(minecraft_name, amount, reason, category, awarded_by_id, awarded_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, reason, category, req.user.sub, req.user.username]
  );

  const newRank = await recalcRank(mc, newMerit);

  await audit({
    actorId: req.user.sub, actorName: req.user.username,
    type: 'update', targetName: mc,
    message: `Mérito ${amount > 0 ? '+' : ''}${amount} para ${mc}: "${reason}" (cat: ${category}). Total: ${newMerit}. Cargo: ${newRank.label}`,
    metadata: { mc, amount, reason, category, newMerit, newRank: newRank.id },
  });

  const actionText = amount > 0 ? 'ganhou' : 'perdeu';
  const notif = await createMinecraftNotification({
    minecraftName: mc,
    title: amount > 0 ? 'Você ganhou Mérito!' : 'Seu Mérito foi debitado',
    body: `${mc}, você ${actionText} ${Math.abs(amount)} ⭐ de Mérito. Motivo: ${reason}. Total atual: ${newMerit} ⭐. Cargo: ${newRank.label}.`,
    type: amount > 0 ? 'social' : 'warning',
    icon: amount > 0 ? '⭐' : '⚠️',
    createdBy: req.user.sub,
  });
  if (notif) {
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'notification_create', targetId: notif.id, targetName: mc,
      message: `Notificação automática de Mérito enviada para ${mc}`,
      metadata: { notificationId: notif.id, mc, amount, reason, newMerit },
    });
  }

  res.json({ ok: true, newMerit, new_total: newMerit, newRank: newRank.id, new_rank: newRank.label, rank: { ...newRank, benefits: RANK_BENEFITS[newRank.id] || [] }, prevMerit: currentMerit });
});

app.post('/api/admin/capital', auth, requireAdmin, async (req, res) => {
  const mc          = sanitize(req.body?.minecraft_name).toLowerCase();
  const rawAmount   = parseFloat(req.body?.amount);
  const rawType     = req.body?.type;
  const type        = ['credit', 'credito'].includes(rawType) ? 'credito'
    : ['debit', 'debito'].includes(rawType) ? 'debito'
    : ['rendimento', 'emprestimo', 'penalidade', 'ajuste'].includes(rawType) ? rawType
    : 'ajuste';
  const amount      = ['debito', 'penalidade'].includes(type) || (rawType === undefined && rawAmount < 0) ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const description = sanitize(req.body?.description);

  if (!mc || isNaN(rawAmount) || rawAmount === 0 || !description)
    return res.status(400).json({ error: 'Dados inválidos.' });

  await ensureBalance(mc);
  const { rows: cur } = await pool.query('SELECT capital_balance FROM player_balances WHERE minecraft_name=$1', [mc]);
  const currentCapital = cur[0]?.capital_balance || 0;
  const newCapital = Math.max(0, currentCapital + amount);

  await pool.query(
    'INSERT INTO capital_records(minecraft_name, amount, type, description, created_by_id, created_by_name) VALUES($1,$2,$3,$4,$5,$6)',
    [mc, amount, type, description, req.user.sub, req.user.username]
  );

  await pool.query(
    'UPDATE player_balances SET capital_balance=$1, updated_at=NOW() WHERE minecraft_name=$2',
    [newCapital, mc]
  );

  await audit({
    actorId: req.user.sub, actorName: req.user.username,
    type: 'update', targetName: mc,
    message: `Capital ${amount > 0 ? '+' : ''}${amount} para ${mc}: "${description}" (tipo: ${type}). Saldo: ${newCapital}`,
    metadata: { mc, amount, type, description, newCapital },
  });

  const actionText = amount > 0 ? 'ganhou' : 'perdeu';
  const notif = await createMinecraftNotification({
    minecraftName: mc,
    title: amount > 0 ? 'Você ganhou Capital!' : 'Seu Capital foi debitado',
    body: `${mc}, você ${actionText} ${Math.abs(amount).toLocaleString('pt-BR')} 💰 de Capital. Motivo: ${description}. Saldo atual: ${newCapital.toLocaleString('pt-BR')} 💰.`,
    type: amount > 0 ? 'social' : 'warning',
    icon: amount > 0 ? '💰' : '⚠️',
    createdBy: req.user.sub,
  });
  if (notif) {
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'notification_create', targetId: notif.id, targetName: mc,
      message: `Notificação automática de Capital enviada para ${mc}`,
      metadata: { notificationId: notif.id, mc, amount, type, description, newCapital },
    });
  }

  res.json({ ok: true, newCapital, new_balance: newCapital, prevCapital: currentCapital });
});

app.get('/api/admin/merit-records', auth, requireAdmin, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page || 0));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 50)));
  const mc    = req.query.mc ? sanitize(req.query.mc).toLowerCase() : null;

  const where  = mc ? 'WHERE LOWER(minecraft_name)=$1' : '';
  const params = mc ? [mc, limit, page * limit] : [limit, page * limit];

  const { rows } = await pool.query(
    `SELECT * FROM merit_records ${where} ORDER BY created_at DESC LIMIT $${mc ? 2 : 1} OFFSET $${mc ? 3 : 2}`,
    params
  );
  res.json(rows);
});

app.get('/api/admin/capital-records', auth, requireAdmin, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page || 0));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));
  const mc    = req.query.mc ? sanitize(req.query.mc).toLowerCase() : null;

  const where  = mc ? 'WHERE LOWER(minecraft_name)=$1' : '';
  const params = mc ? [mc, limit, page * limit] : [limit, page * limit];

  const { rows } = await pool.query(
    `SELECT * FROM capital_records ${where} ORDER BY created_at DESC LIMIT $${mc ? 2 : 1} OFFSET $${mc ? 3 : 2}`,
    params
  );
  res.json({ records: rows });
});

app.get('/api/admin/leaderboard', auth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pb.*, 
      (SELECT COUNT(*) FROM merit_records mr WHERE LOWER(mr.minecraft_name) = pb.minecraft_name) AS total_transactions,
      COALESCE((SELECT SUM(mr.amount) FROM merit_records mr WHERE LOWER(mr.minecraft_name) = pb.minecraft_name AND mr.created_at >= NOW() - INTERVAL '7 days'),0)::int AS weekly_delta
    FROM player_balances pb
    ORDER BY pb.merit_total DESC
    LIMIT 100
  `);

  res.json(rows.map((r, i) => ({
    position: i + 1,
    minecraft_name: r.minecraft_name,
    merit: r.merit_total,
    capital: r.capital_balance,
    rank: getRankById(r.rank),
    total_transactions: r.total_transactions,
    weekly_delta: r.weekly_delta,
    updated_at: r.updated_at,
  })));
});

app.get('/api/admin/players-with-balances', auth, requireAdmin, async (req, res) => {
  const q = req.query.q ? `%${sanitize(req.query.q).toLowerCase()}%` : '%';
  const { rows } = await pool.query(`
    SELECT ps.player AS minecraft_name,
      COALESCE(pb.merit_total, 0)     AS merit_total,
      COALESCE(pb.capital_balance, 0) AS capital_balance,
      COALESCE(pb.rank, 'ferro')      AS rank
    FROM (SELECT DISTINCT player FROM player_sessions) ps
    LEFT JOIN player_balances pb ON pb.minecraft_name = LOWER(ps.player)
    WHERE LOWER(ps.player) LIKE $1
    ORDER BY COALESCE(pb.merit_total, 0) DESC
    LIMIT 30
  `, [q]);
  res.json(rows);
});


// ─────────────────────────────────────────────
// Heartbeat de sessão (atualiza last_seen_at)
// ─────────────────────────────────────────────
app.post('/api/me/session/ping', auth, async (req, res) => {
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      'UPDATE user_sessions SET last_seen_at=NOW() WHERE token_hash=$1 AND revoked=FALSE',
      [tokenHash]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ─────────────────────────────────────────────
// ME – Sessões web
// ─────────────────────────────────────────────
app.get('/api/me/sessions', auth, async (req, res) => {
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      `SELECT id, token_hash, user_agent, ip, city, region, country, isp,
              last_seen_at, created_at, revoked
       FROM user_sessions
       WHERE user_id=$1 AND revoked=FALSE
       ORDER BY last_seen_at DESC`,
      [req.user.sub]
    );

    const sessions = rows.map(s => ({
      id:          s.id,
      is_current:  s.token_hash === currentHash,
      user_agent:  s.user_agent,
      ip:          s.ip,
      city:        s.city,
      region:      s.region,
      country:     s.country,
      isp:         s.isp,
      last_seen:   s.last_seen_at,
      created_at:  s.created_at,
    }));

    res.json({ sessions });
  } catch(e) {
    console.error('[GET /api/me/sessions]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/me/sessions/:id', auth, async (req, res) => {
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      'SELECT id, token_hash FROM user_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'session not found' });
    if (rows[0].token_hash === currentHash)
      return res.status(400).json({ error: 'cannot revoke current session' });

    await pool.query('UPDATE user_sessions SET revoked=TRUE WHERE id=$1', [rows[0].id]);
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `Sessão #${rows[0].id} encerrada remotamente`,
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('[DELETE /api/me/sessions/:id]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/me/sessions', auth, async (req, res) => {
  try {
    const rawToken = (req.headers.authorization || '').replace('Bearer ', '');
    const currentHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rowCount } = await pool.query(
      'UPDATE user_sessions SET revoked=TRUE WHERE user_id=$1 AND token_hash!=$2 AND revoked=FALSE',
      [req.user.sub, currentHash]
    );
    await audit({
      actorId: req.user.sub, actorName: req.user.username,
      type: 'update', targetId: req.user.sub,
      message: `${rowCount} outras sessões encerradas remotamente`,
    });
    res.json({ ok: true, revoked: rowCount });
  } catch(e) {
    console.error('[DELETE /api/me/sessions]', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// Middleware de captura de tentativas de acesso não autorizado
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if ((res.statusCode === 401 || res.statusCode === 403) && req.user) {
      audit({
        actorId:   req.user?.sub   || null,
        actorName: req.user?.username || null,
        type:      'security',
        severity:  'warning',
        message:   `Acesso negado: ${req.method} ${req.path}`,
        ip:        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        metadata:  { method: req.method, path: req.path, statusCode: res.statusCode },
      }).catch(() => {});
    }
    return originalJson(body);
  };
  next();
});

// ─────────────────────────────────────────────
// Moderação — Fila de IA + Denúncias
// ─────────────────────────────────────────────

// GET /api/admin/moderation-queue
// Devolve itens pendentes da fila de moderação da IA (community_upload_user e profile_image_user).
// Para community_upload_user, busca o post mais recente com mídia do utilizador.
// Para profile_image_user, devolve avatar/capa actuais do utilizador.
app.get('/api/admin/moderation-queue', auth, requireAdmin, async (req, res) => {
  const status = sanitize(req.query.status || 'pending');
  const page   = clampInt(req.query.page,  0, 0, 100000);
  const limit  = clampInt(req.query.limit, 20, 1, 100);
  try {
    const { rows } = await pool.query(`
      SELECT
        mq.id,
        mq.content_type,
        mq.content_id,
        mq.reason,
        mq.ai_confidence,
        mq.report_count,
        mq.status,
        mq.created_at,
        mq.reviewed_at,
        reviewer.username AS reviewed_by_username,
        -- utilizador envolvido
        u.id            AS user_id,
        u.username      AS user_username,
        u.minecraft_name AS user_minecraft,
        u.photo_url     AS user_photo,
        -- post mais recente com mídia (para community_upload_user)
        p.id            AS post_id,
        p.content       AS post_content,
        p.media_urls    AS post_media_urls,
        p.created_at    AS post_created_at,
        -- perfil (para profile_image_user)
        up.avatar_url   AS profile_avatar,
        up.cover_url    AS profile_cover,
        up.display_name AS profile_display_name
      FROM moderation_queue mq
      LEFT JOIN users reviewer ON reviewer.id = mq.reviewed_by
      -- resolve utilizador: para community_upload_user e profile_image_user o content_id é o user_id
      LEFT JOIN users u ON (
        mq.content_type IN ('community_upload_user','profile_image_user')
        AND u.id = mq.content_id
      )
      -- post mais recente com mídia do utilizador
      LEFT JOIN LATERAL (
        SELECT id, content, media_urls, created_at
        FROM user_posts
        WHERE author_id = mq.content_id
          AND mq.content_type = 'community_upload_user'
          AND array_length(media_urls, 1) > 0
        ORDER BY created_at DESC
        LIMIT 1
      ) p ON TRUE
      LEFT JOIN user_preferences up ON (
        mq.content_type = 'profile_image_user'
        AND up.user_id = mq.content_id
      )
      WHERE mq.content_type IN ('community_upload_user','profile_image_user')
        AND ($1 = 'all' OR mq.status = $1)
      ORDER BY mq.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, limit, page * limit]);

    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM moderation_queue
      WHERE content_type IN ('community_upload_user','profile_image_user')
        AND ($1 = 'all' OR status = $1)
    `, [status]);

    res.json({ rows, total: countRows[0]?.total ?? 0, page, limit });
  } catch (e) {
    console.error('[GET /api/admin/moderation-queue]', e);
    res.status(500).json({ error: 'Erro ao listar fila de moderação.' });
  }
});

// PATCH /api/admin/moderation-queue/:id
// Aprova (status → reviewed) ou remove conteúdo (status → removed).
// Para community_upload_user: remove o post associado se action=remove_content.
// Para profile_image_user: limpa avatar/capa se action=remove_content.
app.patch('/api/admin/moderation-queue/:id', auth, requireAdmin, async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const action = sanitize(req.body?.action || '');
  if (!id || !['approve', 'remove_content'].includes(action)) {
    return res.status(400).json({ error: 'Ação inválida. Use approve ou remove_content.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM moderation_queue WHERE id=$1 FOR UPDATE',
      [id],
    );
    const item = rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado.' });
    }

    const newStatus = action === 'approve' ? 'reviewed' : 'removed';

    if (action === 'remove_content') {
      if (item.content_type === 'community_upload_user') {
        // Remove o post mais recente com mídia do utilizador
        await client.query(`
          DELETE FROM user_posts
          WHERE id = (
            SELECT id FROM user_posts
            WHERE author_id = $1 AND array_length(media_urls, 1) > 0
            ORDER BY created_at DESC
            LIMIT 1
          )
        `, [item.content_id]);
      } else if (item.content_type === 'profile_image_user') {
        // Limpa avatar e capa do perfil
        await client.query(`
          UPDATE user_preferences
          SET avatar_url = '', cover_url = ''
          WHERE user_id = $1
        `, [item.content_id]);
      }
    }

    await client.query(`
      UPDATE moderation_queue
      SET status=$1, reviewed_by=$2, reviewed_at=NOW()
      WHERE id=$3
    `, [newStatus, req.user.sub, id]);

    await client.query('COMMIT');

    await auditFromReq(req, {
      actorId:    req.user.sub,
      actorName:  req.user.username,
      type:       'moderation',
      severity:   action === 'remove_content' ? 'warning' : 'info',
      targetId:   item.content_id,
      targetName: item.content_type,
      message:    `Fila de moderação #${id} (${item.content_type}): ${action}`,
    });

    res.json({ ok: true, status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PATCH /api/admin/moderation-queue/:id]', e);
    res.status(500).json({ error: 'Erro ao processar item da fila.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────
registerCommunityEvolution(app, pool, auth, {
  fetchMinecraftStatusCached,
  primaryIntegrationFieldsSql,
  socialRankSql,
  socialMeritSql,
  requireAdmin,
  createSocialNotification,
  notifyProfileSubscribers,
});

app.get('/api/community/player/:targetId/notification-preference', auth, async (req, res) => {
  const targetId = parseInt(req.params.targetId, 10);
  if (!targetId || targetId === Number(req.user.sub)) return res.status(400).json({ error: 'Perfil invalido' });
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM user_follows WHERE follower_id=$1 AND following_id=$2
       ) AS is_following,
       COALESCE((
         SELECT level FROM profile_notification_preferences WHERE subscriber_id=$1 AND creator_id=$2
       ), 'off') AS level`,
      [req.user.sub, targetId],
    );
    res.json({ is_following: Boolean(rows[0]?.is_following), level: rows[0]?.is_following ? rows[0]?.level : 'off' });
  } catch (e) {
    console.error('[GET profile notification preference]', e);
    res.status(500).json({ error: 'Erro ao consultar notificacoes do perfil' });
  }
});

app.put('/api/community/player/:targetId/notification-preference', auth, async (req, res) => {
  const targetId = parseInt(req.params.targetId, 10);
  const level = sanitize(req.body?.level || '').toLowerCase();
  if (!targetId || targetId === Number(req.user.sub) || !['off', 'default', 'all'].includes(level)) {
    return res.status(400).json({ error: 'Preferencia invalida' });
  }
  try {
    const follows = await pool.query('SELECT 1 FROM user_follows WHERE follower_id=$1 AND following_id=$2', [req.user.sub, targetId]);
    if (!follows.rowCount) return res.status(403).json({ error: 'Siga este perfil para ativar notificacoes.' });
    await pool.query(
      `INSERT INTO profile_notification_preferences(subscriber_id,creator_id,level,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(subscriber_id,creator_id) DO UPDATE SET level=EXCLUDED.level,updated_at=NOW()`,
      [req.user.sub, targetId, level],
    );
    res.json({ ok: true, level });
  } catch (e) {
    console.error('[PUT profile notification preference]', e);
    res.status(500).json({ error: 'Erro ao atualizar notificacoes do perfil' });
  }
});

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  console.error('[error]', {
    method: req.method,
    path: req.path,
    status,
    message: err?.message,
    stack: process.env.NODE_ENV !== 'production' ? err?.stack : undefined,
  });
  if (res.headersSent) return;
  res.status(status).json({ error: status < 500 ? err.message : 'internal error' });
});

// ─────────────────────────────────────────────
// Chat Realtime (SSE + delivery status)
// ─────────────────────────────────────────────
registerChatRealtime(app, pool, auth);

// ─────────────────────────────────────────────
// Legacy Account Migration
// ─────────────────────────────────────────────
const legacyMigrationService = registerLegacyMigration(app, pool, auth, requireAdmin, auditFromReq);

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
let scheduledPostsTimer = null;
let databaseRetryTimer = null;

function startScheduledPostPublisher() {
  if (scheduledPostsTimer) return;
  publishDueScheduledPosts().catch(() => {});
  scheduledPostsTimer = setInterval(
    () => publishDueScheduledPosts().catch(() => {}),
    SCHEDULED_POST_POLL_MS,
  );
  scheduledPostsTimer.unref?.();
}

async function prepareDatabaseForBoot() {
  await migrate();
  await seedAdmin();
  markDatabaseReady();
}

function scheduleDatabaseRetry() {
  if (databaseRetryTimer || DB_BOOT_RETRY_MS <= 0) return;
  databaseRetryTimer = setInterval(async () => {
    if (dbStartupState.ready) {
      clearInterval(databaseRetryTimer);
      databaseRetryTimer = null;
      return;
    }

    try {
      await prepareDatabaseForBoot();
      console.info('[startup:db] Banco de dados pronto apos retry.');
      startScheduledPostPublisher();
      clearInterval(databaseRetryTimer);
      databaseRetryTimer = null;
    } catch (error) {
      markDatabaseUnavailable(error);
      logDatabaseStartupError(error, '[startup:db:retry]');
    }
  }, DB_BOOT_RETRY_MS);
  databaseRetryTimer.unref?.();
}

function startHttpServer() {
  app.listen(PORT, () => console.log(`✅  API ${DEPLOY_SCHEMA_VERSION} rodando na porta ${PORT}`));
}

prepareDatabaseForBoot()
  .then(() => {
    startScheduledPostPublisher();
    startHttpServer();
  })
  .catch(error => {
    markDatabaseUnavailable(error);
    logDatabaseStartupError(error);

    if (!shouldStartWithoutDatabase(error)) {
      process.exit(1);
      return;
    }

    console.warn('[startup:db] API iniciando em modo degradado; endpoints com banco retornarao 503 ate o Postgres voltar.');
    scheduleDatabaseRetry();
    startHttpServer();
  });
