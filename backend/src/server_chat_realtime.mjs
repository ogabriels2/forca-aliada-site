/**
 * Força Aliada — Chat Realtime Patch (server_chat_realtime.mjs)
 * ─────────────────────────────────────────────────────────────
 * Adiciona ao Express:
 *
 *  1. GET  /api/me/chat/stream?conv=<id>&kind=direct|group
 *     Server-Sent Events: push imediato de novas mensagens e eventos
 *     de read/presença sem polling. Funciona no Render.com free tier.
 *
 *  2. GET  /api/me/conversations/:id/status
 *     Retorna {peer_last_read_at, peer_is_online, my_last_read_at}
 *     para calcular os ticks de delivery da última mensagem enviada.
 *
 *  3. GET  /api/me/group-conversations/:id/status
 *     Igual ao acima mas para grupos (retorna array de membros com last_read_at).
 *
 * COMO ADICIONAR AO server.mjs
 * ─────────────────────────────
 *  No topo do server.mjs:
 *    import { registerChatRealtime } from './server_chat_realtime.mjs';
 *
 *  Logo após declarar `app` e `pool` (antes do app.listen):
 *    registerChatRealtime(app, pool, auth);
 *
 * DESIGN DE SSE NO RENDER.COM (free tier)
 * ─────────────────────────────────────────
 *  • Render free instance dorme após 15 min de inatividade.
 *    O SSE keepalive de 25s mantém a instância acordada enquanto
 *    alguém está no chat, sem custo de compute extra.
 *  • Cada instância Render é single-process (sem sticky sessions),
 *    mas o SSE funciona DENTRO do mesmo processo — o fan-out é
 *    feito por um EventEmitter em memória, não por Redis/PubSub.
 *    Isso é correto porque o Render free tier tem apenas 1 instância.
 *  • Máximo 200 clientes SSE simultâneos (muito acima da capacidade
 *    real do free tier). Cada conexão é um generator async + stream HTTP.
 *  • Timeout de 4 min: o cliente reconecta automaticamente via
 *    EventSource (built-in) com `Last-Event-ID`.
 *
 * TICKS DE DELIVERY (modelo WhatsApp)
 * ─────────────────────────────────────
 *  ⏳  client_status='pending'  — aguardando confirmação do servidor
 *  ✓   client_status='sent'     — servidor salvou, outro lado ainda não viu
 *  ✓✓  client_status='delivered'— outro lado está online (last_seen_at recente)
 *  ✓✓🔵 client_status='read'   — outro lado abriu a conversa (last_read_at > msg.created_at)
 */

import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ── Fan-out bus em memória ─────────────────────────────────────────────────────
// key: "direct:<conversationId>" ou "group:<groupId>"
// value: Set de { userId, res } onde res é a Response SSE
const _sseBus = new EventEmitter();
_sseBus.setMaxListeners(500); // headroom

// ── Registro de presença web (sem tocar no banco) ──────────────────────────────
// key: userId (number), value: { convKey: string, lastSeenAt: number }
const _webPresence = new Map();
const WEB_PRESENCE_TTL = 90_000; // 90s — online se visto nos últimos 90s

function setWebPresence(userId, convKey) {
  _webPresence.set(userId, { convKey, lastSeenAt: Date.now() });
}

function isWebOnline(userId) {
  const entry = _webPresence.get(userId);
  if (!entry) return false;
  return Date.now() - entry.lastSeenAt < WEB_PRESENCE_TTL;
}

function cleanWebPresence() {
  const cutoff = Date.now() - WEB_PRESENCE_TTL;
  for (const [uid, entry] of _webPresence) {
    if (entry.lastSeenAt < cutoff) _webPresence.delete(uid);
  }
}
setInterval(cleanWebPresence, 60_000);

// ── authSSE: autentica requisição SSE via ?_token= OU Authorization header ─────
// EventSource nativo do browser NÃO suporta headers customizados, por isso o
// token JWT é enviado como query param. Validamos identicamente ao middleware auth.
async function authSSE(req, pool) {
  const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || '';
  const rawToken = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || (req.query._token || '').trim();
  if (!rawToken) throw Object.assign(new Error('missing token'), { status: 401 });

  let decoded;
  try {
    decoded = jwt.verify(rawToken, JWT_SECRET);
  } catch {
    throw Object.assign(new Error('invalid token'), { status: 401 });
  }

  const { rows } = await pool.query(
    'SELECT id, role, is_verified, minecraft_name, username FROM users WHERE id=$1',
    [decoded.sub],
  );
  if (!rows.length) throw Object.assign(new Error('user deleted'), { status: 401 });

  // Verifica revogação (mesma lógica do middleware auth)
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { rows: sessionRows } = await pool.query(
    'SELECT 1 FROM user_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked=FALSE LIMIT 1',
    [tokenHash, rows[0].id],
  );
  if (!sessionRows.length) throw Object.assign(new Error('session revoked'), { status: 401 });

  return { ...rows[0], sub: rows[0].id };
}


// ── Helpers SSE ───────────────────────────────────────────────────────────────
function sseWrite(res, event, data, id) {
  if (res.writableEnded) return;
  let chunk = '';
  if (id !== undefined) chunk += `id: ${id}\n`;
  if (event) chunk += `event: ${event}\n`;
  chunk += `data: ${JSON.stringify(data)}\n\n`;
  res.write(chunk);
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx / Render proxy
  res.flushHeaders();
}

// ── Funções de fan-out (chamadas pelo server.mjs ao salvar mensagem) ───────────
export function emitNewMessage(convKey, message) {
  _sseBus.emit(convKey, { type: 'message', message });
}

export function emitMessageUpdate(convKey, message) {
  _sseBus.emit(convKey, { type: 'update', message });
}

export function emitReadReceipt(convKey, userId, lastReadAt) {
  _sseBus.emit(convKey, { type: 'read', userId, lastReadAt });
}

export function emitPresence(convKey, userId, online) {
  _sseBus.emit(convKey, { type: 'presence', userId, online });
}

// ── Registro principal ────────────────────────────────────────────────────────
export function registerChatRealtime(app, pool, auth) {

  // ── 1. SSE stream ────────────────────────────────────────────────────────────
  // Usa authSSE (não o middleware auth) porque EventSource nativo não suporta
  // headers customizados — o token é enviado via ?_token= no query string.
  app.get('/api/me/chat/stream', async (req, res) => {
    let user;
    try {
      user = await authSSE(req, pool);
    } catch (err) {
      return res.status(err.status || 401).json({ error: err.message });
    }

    const convId = parseInt(req.query.conv, 10);
    const kind = req.query.kind === 'group' ? 'group' : 'direct';
    const userId = user.sub;

    if (!convId) return res.status(400).json({ error: 'conv obrigatório' });

    const convKey = `${kind}:${convId}`;

    // Verifica participação (assíncrono mas não bloqueia o header SSE)
    const participationQuery = kind === 'group'
      ? `SELECT 1 FROM chat_group_members WHERE group_id=$1 AND user_id=$2 LIMIT 1`
      : `SELECT 1 FROM direct_conversations WHERE id=$1 AND (participant_a=$2 OR participant_b=$2) LIMIT 1`;

    pool.query(participationQuery, [convId, userId]).then(({ rows }) => {
      if (!rows.length) {
        res.status(403).end();
        return;
      }

      // Setup SSE
      sseHeaders(res);
      setWebPresence(userId, convKey);

      // Anuncia presença ao parceiro
      emitPresence(convKey, userId, true);

      // Keepalive a cada 25s para evitar timeout do proxy e manter instância Render viva
      const keepalive = setInterval(() => {
        if (res.writableEnded) { clearInterval(keepalive); return; }
        res.write(': ping\n\n');
      }, 25_000);

      // Listener de eventos do bus
      function onBusEvent(payload) {
        if (res.writableEnded) {
          _sseBus.off(convKey, onBusEvent);
          return;
        }
        // Não enviar de volta para o próprio remetente (mensagens próprias já estão na UI via optimistic)
        // MAS enviamos tudo para garantir sincronização entre abas
        sseWrite(res, payload.type, payload, Date.now());
      }

      _sseBus.on(convKey, onBusEvent);

      // Heartbeat de presença web
      const presenceInterval = setInterval(() => {
        if (res.writableEnded) { clearInterval(presenceInterval); return; }
        setWebPresence(userId, convKey);
        emitPresence(convKey, userId, true);
      }, 30_000);

      // Cleanup ao fechar
      req.on('close', () => {
        clearInterval(keepalive);
        clearInterval(presenceInterval);
        _sseBus.off(convKey, onBusEvent);
        // Pequeno delay para não piscar o online dot em reconexões rápidas
        setTimeout(() => {
          if (!isWebOnline(userId)) {
            emitPresence(convKey, userId, false);
          }
        }, 5000);
      });

      // Evento inicial de conexão
      sseWrite(res, 'connected', { convKey, userId, ts: Date.now() });

    }).catch(() => {
      if (!res.headersSent) res.status(500).end();
    });
  });

  // ── 2. Status de conversa direta (delivery ticks) ────────────────────────────
  app.get('/api/me/conversations/:id/status', auth, async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    const userId = req.user.sub;
    if (!convId) return res.status(400).json({ error: 'id inválido' });

    try {
      // Verifica participação e pega o outro participante
      const { rows: convRows } = await pool.query(
        `SELECT id,
                CASE WHEN participant_a=$1 THEN participant_b ELSE participant_a END AS peer_id
         FROM direct_conversations
         WHERE id=$2 AND (participant_a=$1 OR participant_b=$1)
         LIMIT 1`,
        [userId, convId],
      );
      if (!convRows.length) return res.status(404).json({ error: 'não encontrado' });

      const peerId = convRows[0].peer_id;
      const convKey = `direct:${convId}`;

      // Busca last_read_at do peer e do me
      const { rows: readRows } = await pool.query(
        `SELECT user_id, last_read_at
         FROM direct_conversation_reads
         WHERE conversation_id=$1 AND user_id = ANY($2)`,
        [convId, [userId, peerId]],
      );

      const myRead = readRows.find(r => Number(r.user_id) === Number(userId));
      const peerRead = readRows.find(r => Number(r.user_id) === Number(peerId));

      // Online: presença web em memória (mais preciso) + fallback para user_sessions
      let peerIsOnline = isWebOnline(peerId);
      if (!peerIsOnline) {
        const { rows: sessionRows } = await pool.query(
          `SELECT 1 FROM user_sessions
           WHERE user_id=$1 AND revoked=FALSE
             AND last_seen_at > NOW() - INTERVAL '90 seconds'
           LIMIT 1`,
          [peerId],
        );
        peerIsOnline = sessionRows.length > 0;
      }

      res.json({
        peer_id: peerId,
        peer_last_read_at: peerRead?.last_read_at || null,
        peer_is_online: peerIsOnline,
        my_last_read_at: myRead?.last_read_at || null,
      });
    } catch (e) {
      console.error('[GET /api/me/conversations/:id/status]', e);
      res.status(500).json({ error: 'Erro ao buscar status' });
    }
  });

  // ── 3. Status de grupo ───────────────────────────────────────────────────────
  app.get('/api/me/group-conversations/:id/status', auth, async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const userId = req.user.sub;
    if (!groupId) return res.status(400).json({ error: 'id inválido' });

    try {
      const { rows: memberRows } = await pool.query(
        `SELECT gm.user_id, gm.last_read_at,
                COALESCE(u.minecraft_name, u.username) AS name
         FROM chat_group_members gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id=$1`,
        [groupId],
      );

      if (!memberRows.length) return res.status(404).json({ error: 'não encontrado' });

      const isMember = memberRows.some(r => Number(r.user_id) === Number(userId));
      if (!isMember) return res.status(403).json({ error: 'acesso negado' });

      const members = memberRows.map(r => ({
        user_id: r.user_id,
        name: r.name,
        last_read_at: r.last_read_at,
        is_online: isWebOnline(r.user_id),
      }));

      res.json({ members });
    } catch (e) {
      console.error('[GET /api/me/group-conversations/:id/status]', e);
      res.status(500).json({ error: 'Erro ao buscar status do grupo' });
    }
  });

  // ── 4. Heartbeat de presença web (chamado pelo cliente a cada 30s) ───────────
  // Atualiza user_sessions.last_seen_at SEM fazer query pesada de auth completo
  app.post('/api/me/presence', auth, (req, res) => {
    const userId = req.user.sub;
    const convKey = req.body?.conv_key || null;
    setWebPresence(userId, convKey);
    if (convKey) emitPresence(convKey, userId, true);
    // Atualiza last_seen_at assincronamente (fire-and-forget, não bloqueia a resposta)
    pool.query(
      `UPDATE user_sessions SET last_seen_at=NOW() WHERE user_id=$1 AND revoked=FALSE`,
      [userId],
    ).catch(() => {});
    res.json({ ok: true });
  });

  console.info('[chat-realtime] SSE + status endpoints registrados ✓');
}

// ── Hook para ser chamado após INSERT de mensagem no server.mjs ────────────────
// Uso no server.mjs após salvar a mensagem:
//   import { notifyNewMessage } from './server_chat_realtime.mjs';
//   notifyNewMessage('direct', conversationId, savedMessage);
export function notifyNewMessage(kind, convId, message) {
  const convKey = `${kind}:${convId}`;
  emitNewMessage(convKey, message);
}

export function notifyMessageUpdate(kind, convId, message) {
  const convKey = `${kind}:${convId}`;
  emitMessageUpdate(convKey, message);
}

export function notifyRead(kind, convId, userId, lastReadAt) {
  const convKey = `${kind}:${convId}`;
  emitReadReceipt(convKey, userId, lastReadAt);
}
