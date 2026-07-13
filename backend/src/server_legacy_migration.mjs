/**
 * Força Aliada – Legacy Account Migration Module
 * ────────────────────────────────────────────────
 * Permite que jogadores que usavam nicks piratas (offline-mode=false) vinculem
 * seus dados históricos à conta com nome original após a migração para online-mode=true.
 *
 * Modos de migração:
 *  • separate — Alias apenas. Nenhum dado é movido.
 *  • partial  — Soma merit/capital. Histórico unificado com marcador visual de corte.
 *  • full     — Merge completo + irreversível. Todos os registros renomeados.
 *
 * Verificação de propriedade (Tier System):
 *  Tier 0 — Admin pre-seed (legacy_migration_presets) → aprovação automática
 *  Tier 1 — Email match automático → aprovação automática
 *  Tier 2 — Código enviado para o e-mail da conta legacy → verificação por código
 *  Tier 3 — Revisão manual pelo admin → fila de moderação
 */

import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// ─────────────────────────────────────────────
// UUID offline do Minecraft
// Idêntico ao algoritmo OfflinePlayer UUID do Paper/Bukkit
// ─────────────────────────────────────────────
function computeOfflineUUID(username) {
  const data = Buffer.from(`OfflinePlayer:${username}`, 'utf8');
  const hash = crypto.createHash('md5').update(data).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// ─────────────────────────────────────────────
// SQL de schema — executado em migrate()
// ─────────────────────────────────────────────
export const LEGACY_MIGRATION_SCHEMA_SQL = String.raw`
-- ═══════════════════════════════════════════════════════════════════
-- Presets criados pelo admin para pré-aprovar casos conhecidos
-- Ex: "CaioLeal" → user_id do Caio (Porralho)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS legacy_migration_presets (
  id               SERIAL PRIMARY KEY,
  legacy_username  VARCHAR(255) NOT NULL,
  target_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lmp_legacy_lower
  ON legacy_migration_presets (LOWER(legacy_username));
CREATE INDEX IF NOT EXISTS idx_lmp_target
  ON legacy_migration_presets (target_user_id);

-- ═══════════════════════════════════════════════════════════════════
-- Solicitações de migração (ciclo de vida completo)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS account_migrations (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_username       VARCHAR(255) NOT NULL,
  legacy_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  legacy_offline_uuid   VARCHAR(64),
  legacy_data_snapshot  JSONB,
  verification_tier     VARCHAR(20),
  verified_at           TIMESTAMPTZ,
  status                VARCHAR(30) DEFAULT 'pending_verification',
  migration_mode        VARCHAR(10),
  executed_at           TIMESTAMPTZ,
  reversible_until      TIMESTAMPTZ,
  confirm_token         VARCHAR(80),
  confirm_token_expires TIMESTAMPTZ,
  request_ip            VARCHAR(64),
  request_ua            TEXT,
  reviewed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  admin_notes           TEXT,
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_am_legacy_lower_active
  ON account_migrations (LOWER(legacy_username))
  WHERE status IN ('verified','pending_admin','completed','pending_verification');
CREATE INDEX IF NOT EXISTS idx_am_user        ON account_migrations (user_id);
CREATE INDEX IF NOT EXISTS idx_am_legacy_name ON account_migrations (LOWER(legacy_username));
CREATE INDEX IF NOT EXISTS idx_am_status      ON account_migrations (status);
CREATE INDEX IF NOT EXISTS idx_am_created     ON account_migrations (created_at DESC);

-- ═══════════════════════════════════════════════════════════════════
-- Aliases de username (resultado de qualquer migração concluída)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS username_aliases (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_username      VARCHAR(255) NOT NULL,
  migration_id        INTEGER REFERENCES account_migrations(id) ON DELETE SET NULL,
  migration_mode      VARCHAR(10) NOT NULL,
  alias_active_until  TIMESTAMPTZ,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ua_alias_lower
  ON username_aliases (LOWER(alias_username));
CREATE INDEX IF NOT EXISTS idx_ua_user ON username_aliases (user_id);

-- ═══════════════════════════════════════════════════════════════════
-- Verificação por código de e-mail
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS migration_verifications (
  id             SERIAL PRIMARY KEY,
  migration_id   INTEGER NOT NULL REFERENCES account_migrations(id) ON DELETE CASCADE,
  email          VARCHAR(255) NOT NULL,
  code           VARCHAR(10) NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  attempts       INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (migration_id)
);
CREATE INDEX IF NOT EXISTS idx_mv_migration ON migration_verifications (migration_id);

-- ═══════════════════════════════════════════════════════════════════
-- Alterações em tabelas existentes para suportar migração
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS merged_into_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS migration_note      TEXT;

ALTER TABLE player_sessions
  ADD COLUMN IF NOT EXISTS is_alias_session    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alias_original_name VARCHAR(255);

ALTER TABLE merit_records
  ADD COLUMN IF NOT EXISTS migrated_from_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS migration_id       INTEGER REFERENCES account_migrations(id) ON DELETE SET NULL;

ALTER TABLE capital_records
  ADD COLUMN IF NOT EXISTS migrated_from_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS migration_id       INTEGER REFERENCES account_migrations(id) ON DELETE SET NULL;

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS pending_legacy_suggestion VARCHAR(255);
`;

// ─────────────────────────────────────────────
// E-mail de verificação de migração
// ─────────────────────────────────────────────
async function sendMigrationVerificationEmail(email, legacyNick, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[legacy-migration] RESEND_API_KEY não configurada — e-mail não enviado'); return; }
  const from = process.env.EMAIL_FROM || 'no-reply@ogabriels.com';
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e5ea;border-radius:14px;">
  <h2 style="color:#1d1d1f;margin:0 0 8px;">Verificação de Conta Anterior</h2>
  <p style="color:#1d1d1f;margin:0 0 4px;">Olá, <strong>${legacyNick}</strong>!</p>
  <p style="color:#86868b;margin:0 0 20px;">
    Uma solicitação foi feita para vincular esta conta à uma conta da Força Aliada.
    Use o código abaixo para confirmar que esta conta é sua:
  </p>
  <div style="background:#f2f2f7;padding:18px;border-radius:10px;text-align:center;margin:0 0 20px;">
    <strong style="font-size:34px;letter-spacing:6px;color:#C44444;">${code}</strong>
  </div>
  <p style="color:#86868b;font-size:13px;margin:0 0 8px;">Este código expira em 15 minutos.</p>
  <p style="color:#ff3b30;font-size:13px;font-weight:600;margin:0;">
    ⚠️ Se você não fez esta solicitação, ignore este e-mail — sua conta continuará segura.
  </p>
</div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: email,
        subject: '🔐 Código de vinculação de conta anterior — Força Aliada',
        html,
      }),
    });
  } catch (e) {
    console.error('[legacy-migration-email]', e);
  }
}

// ─────────────────────────────────────────────
// Rate limiters
// ─────────────────────────────────────────────
const migrationDiscoveryLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24h
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas consultas de contas anteriores. Tente novamente amanhã.' },
  keyGenerator: (req) => `migration_discovery:${req.user?.sub || req.ip}`,
});

const migrationRequestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas solicitações de migração. Tente novamente amanhã.' },
  keyGenerator: (req) => `migration_request:${req.user?.sub || req.ip}`,
});

const migrationExecutionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de execução. Aguarde uma hora.' },
  keyGenerator: (req) => `migration_execution:${req.user?.sub || req.ip}`,
});

const migrationVerifyLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 min (1 reenvio de e-mail por janela)
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de verificação. Aguarde 30 minutos.' },
  keyGenerator: (req) => `migration_verify:${req.user?.sub || req.ip}`,
});

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

/** Preview dos dados existentes para um nick legacy */
async function getLegacyDataPreview(pool, legacyName) {
  const name = legacyName.trim().toLowerCase();
  const [balRes, sessRes, meritRes, capRes, userRes] = await Promise.all([
    pool.query(
      `SELECT merit_total, capital_balance FROM player_balances WHERE LOWER(minecraft_name)=$1`, [name]
    ),
    pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(duration_hours),0) AS hours FROM player_sessions WHERE LOWER(player)=$1`, [name]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM merit_records WHERE LOWER(minecraft_name)=$1`, [name]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM capital_records WHERE LOWER(minecraft_name)=$1`, [name]
    ),
    pool.query(
      `SELECT id, username, email, minecraft_name, merged_into_user_id
       FROM users WHERE LOWER(minecraft_name)=$1 OR LOWER(username)=$1 LIMIT 1`,
      [name]
    ),
  ]);

  const balance = balRes.rows[0] || null;
  const sessions = sessRes.rows[0];
  const hasData = !!balance || Number(sessions.count) > 0;

  return {
    hasData,
    merit: Number(balance?.merit_total || 0),
    capital: Number(balance?.capital_balance || 0),
    sessions: Number(sessions.count),
    hours: Math.round(Number(sessions.hours) * 10) / 10,
    meritRecords: Number(meritRes.rows[0]?.count || 0),
    capitalRecords: Number(capRes.rows[0]?.count || 0),
    legacyUser: userRes.rows[0] || null,
  };
}

/** Valida se o usuário pode reivindicar o nick legacy */
async function checkEligibility(pool, currentUser, legacyName) {
  const name = legacyName.trim().toLowerCase();

  // Nick não pode ser o atual
  if (currentUser.minecraft_name && currentUser.minecraft_name.toLowerCase() === name) {
    return { eligible: false, reason: 'Este é o seu nick atual, não um nick anterior.' };
  }

  // Verificar migração ativa existente para este nick
  const { rows: existingMig } = await pool.query(
    `SELECT id, user_id, status FROM account_migrations
     WHERE LOWER(legacy_username)=$1
     AND status NOT IN ('rejected','reversed')
     LIMIT 1`,
    [name]
  );
  if (existingMig.length) {
    if (existingMig[0].user_id === currentUser.sub) {
      return { eligible: false, reason: 'Você já tem uma solicitação ativa para este nick.' };
    }
    return { eligible: false, reason: 'Este nick já foi reivindicado por outro usuário.' };
  }

  // Verificar se há alias para este nick
  const { rows: existingAlias } = await pool.query(
    `SELECT id FROM username_aliases WHERE LOWER(alias_username)=$1 AND is_active=TRUE LIMIT 1`,
    [name]
  );
  if (existingAlias.length) {
    return { eligible: false, reason: 'Este nick já está vinculado a outra conta.' };
  }

  // Usuário atual deve ter conta Microsoft vinculada
  const { rows: integration } = await pool.query(
    `SELECT id FROM user_integrations WHERE user_id=$1 AND is_primary=TRUE LIMIT 1`,
    [currentUser.sub]
  );
  if (!integration.length) {
    return { eligible: false, reason: 'Vincule sua conta Microsoft antes de solicitar migração legacy (Conexões & Redes).' };
  }

  // Conta legacy não pode ter Microsoft vinculada (seria conta original, não pirata)
  const { rows: legacyUserRows } = await pool.query(
    `SELECT u.id, u.email, u.username, u.merged_into_user_id
     FROM users u WHERE LOWER(u.minecraft_name)=$1 OR LOWER(u.username)=$1 LIMIT 1`,
    [name]
  );
  if (legacyUserRows.length) {
    const lu = legacyUserRows[0];
    if (lu.merged_into_user_id) {
      return { eligible: false, reason: 'Esta conta já foi mesclada com outra conta.' };
    }
    const { rows: luIntegration } = await pool.query(
      `SELECT id FROM user_integrations WHERE user_id=$1 AND mc_uuid IS NOT NULL AND mc_uuid NOT LIKE 'bedrock_%' LIMIT 1`,
      [lu.id]
    );
    if (luIntegration.length) {
      return { eligible: false, reason: 'Esta conta já possui vínculo Microsoft e não pode ser reivindicada como legacy.' };
    }
  }

  return { eligible: true };
}

/** Determina qual tier de verificação se aplica */
async function determineVerificationTier(pool, currentUser, legacyName, legacyUser) {
  const name = legacyName.trim().toLowerCase();

  // Tier 0: Preset criado pelo admin
  const { rows: preset } = await pool.query(
    `SELECT id FROM legacy_migration_presets WHERE LOWER(legacy_username)=$1 AND target_user_id=$2 LIMIT 1`,
    [name, currentUser.sub]
  );
  if (preset.length) {
    return { tier: 0, tierName: 'admin_preset', autoApprove: true };
  }

  // Tier 1: Mesmo e-mail
  if (legacyUser && legacyUser.email && currentUser.email &&
      legacyUser.email.toLowerCase() === currentUser.email.toLowerCase()) {
    return { tier: 1, tierName: 'email_match', autoApprove: true };
  }

  // Tier 2: E-mail da conta legacy existe → enviar código
  if (legacyUser && legacyUser.email) {
    return { tier: 2, tierName: 'email_code', autoApprove: false, email: legacyUser.email };
  }

  // Tier 3: Revisão manual
  return { tier: 3, tierName: 'admin_review', autoApprove: false };
}

// ─────────────────────────────────────────────
// Executores de migração (dentro de transação)
// ─────────────────────────────────────────────

async function executeSeparate(pool, migrationId, currentUserId, legacyName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO username_aliases (user_id, alias_username, migration_id, migration_mode, is_active)
       VALUES ($1,$2,$3,'separate',TRUE) ON CONFLICT DO NOTHING`,
      [currentUserId, legacyName, migrationId]
    );
    await client.query(
      `UPDATE account_migrations
       SET status='completed', executed_at=NOW(), migration_mode='separate', updated_at=NOW()
       WHERE id=$1`,
      [migrationId]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function executePartial(pool, migrationId, currentUserId, legacyName, legacyUserId, newMcName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Snapshot para reversão futura
    const { rows: snapRows } = await client.query(`
      SELECT jsonb_build_object(
        'player_balances', (SELECT row_to_json(pb) FROM player_balances pb WHERE LOWER(minecraft_name)=LOWER($1)),
        'session_count',   (SELECT COUNT(*) FROM player_sessions WHERE LOWER(player)=LOWER($1)),
        'session_hours',   (SELECT COALESCE(SUM(duration_hours),0) FROM player_sessions WHERE LOWER(player)=LOWER($1)),
        'snapshot_at',     to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ) AS snap
    `, [legacyName]);
    await client.query(
      `UPDATE account_migrations SET legacy_data_snapshot=$1, migration_mode='partial', updated_at=NOW() WHERE id=$2`,
      [snapRows[0].snap, migrationId]
    );

    // 2. Garantir linha na tabela de balanços do usuário atual
    await client.query(
      `INSERT INTO player_balances (minecraft_name, merit_total, capital_balance)
       VALUES ($1, 0, 0) ON CONFLICT (minecraft_name) DO NOTHING`,
      [newMcName]
    );

    // 3. Somar merit e capital do nick legado ao nick atual
    await client.query(
      `UPDATE player_balances
       SET merit_total     = merit_total     + COALESCE((SELECT merit_total FROM player_balances WHERE LOWER(minecraft_name)=LOWER($2)),0),
           capital_balance = capital_balance + COALESCE((SELECT capital_balance FROM player_balances WHERE LOWER(minecraft_name)=LOWER($2)),0)
       WHERE LOWER(minecraft_name)=LOWER($1)`,
      [newMcName, legacyName]
    );
    await client.query(`DELETE FROM player_balances WHERE LOWER(minecraft_name)=LOWER($1)`, [legacyName]);

    // 4. Marcar sessões do nick antigo com flag de alias (preserva nome para separador visual)
    await client.query(
      `UPDATE player_sessions
       SET is_alias_session=TRUE, alias_original_name=player
       WHERE LOWER(player)=LOWER($1)`,
      [legacyName]
    );

    // 5. Se havia conta de site: migrar posts/comments para o usuário atual
    if (legacyUserId) {
      await client.query(`UPDATE user_posts    SET author_id=$1 WHERE author_id=$2`, [currentUserId, legacyUserId]);
      await client.query(`UPDATE post_comments SET author_id=$1 WHERE author_id=$2`, [currentUserId, legacyUserId]);
      await client.query(
        `INSERT INTO post_likes (post_id, user_id)
         SELECT post_id, $1 FROM post_likes WHERE user_id=$2 ON CONFLICT DO NOTHING`,
        [currentUserId, legacyUserId]
      );
      await client.query(`DELETE FROM post_likes WHERE user_id=$1`, [legacyUserId]);
      await client.query(
        `UPDATE users SET merged_into_user_id=$1, merged_at=NOW(), migration_note='Migração partial' WHERE id=$2`,
        [currentUserId, legacyUserId]
      );
    }

    // 6. Criar alias com timestamp de corte para o separador visual
    const { rows: cutoffRows } = await client.query(
      `SELECT MAX(entered_at) AS last_session FROM player_sessions WHERE LOWER(alias_original_name)=LOWER($1)`,
      [legacyName]
    );
    await client.query(
      `INSERT INTO username_aliases (user_id, alias_username, migration_id, migration_mode, alias_active_until, is_active)
       VALUES ($1,$2,$3,'partial',$4,TRUE) ON CONFLICT DO NOTHING`,
      [currentUserId, legacyName, migrationId, cutoffRows[0]?.last_session || null]
    );

    // 7. Concluir — reversível por 7 dias
    await client.query(
      `UPDATE account_migrations
       SET status='completed', executed_at=NOW(), migration_mode='partial',
           reversible_until=NOW() + INTERVAL '7 days', updated_at=NOW()
       WHERE id=$1`,
      [migrationId]
    );

    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function executeFull(pool, migrationId, currentUserId, legacyName, legacyUserId, newMcName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Snapshot completo para auditoria admin (irreversível mas auditado)
    const { rows: snapRows } = await client.query(`
      SELECT jsonb_build_object(
        'player_sessions',  (SELECT json_agg(ps) FROM player_sessions ps WHERE LOWER(player)=LOWER($1)),
        'player_balances',  (SELECT row_to_json(pb) FROM player_balances pb WHERE LOWER(minecraft_name)=LOWER($1)),
        'merit_records',    (SELECT json_agg(mr) FROM merit_records mr WHERE LOWER(minecraft_name)=LOWER($1)),
        'capital_records',  (SELECT json_agg(cr) FROM capital_records cr WHERE LOWER(minecraft_name)=LOWER($1)),
        'snapshot_at',      to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ) AS snap
    `, [legacyName]);
    await client.query(
      `UPDATE account_migrations SET legacy_data_snapshot=$1, migration_mode='full', updated_at=NOW() WHERE id=$2`,
      [snapRows[0].snap, migrationId]
    );

    // 2. Renomear player_sessions para o novo nick
    await client.query(
      `UPDATE player_sessions SET player=$1 WHERE LOWER(player)=LOWER($2)`,
      [newMcName, legacyName]
    );

    // 3. Renomear merit_records com rastreamento de origem
    await client.query(
      `UPDATE merit_records SET minecraft_name=$1, migrated_from_name=$2, migration_id=$3
       WHERE LOWER(minecraft_name)=LOWER($2)`,
      [newMcName, legacyName, migrationId]
    );

    // 4. Renomear capital_records com rastreamento de origem
    await client.query(
      `UPDATE capital_records SET minecraft_name=$1, migrated_from_name=$2, migration_id=$3
       WHERE LOWER(minecraft_name)=LOWER($2)`,
      [newMcName, legacyName, migrationId]
    );

    // 5. Somar player_balances e deletar entrada legacy
    await client.query(
      `INSERT INTO player_balances (minecraft_name, merit_total, capital_balance)
       VALUES ($1, 0, 0) ON CONFLICT (minecraft_name) DO NOTHING`,
      [newMcName]
    );
    await client.query(
      `UPDATE player_balances
       SET merit_total     = merit_total     + COALESCE((SELECT merit_total FROM player_balances WHERE LOWER(minecraft_name)=LOWER($2)),0),
           capital_balance = capital_balance + COALESCE((SELECT capital_balance FROM player_balances WHERE LOWER(minecraft_name)=LOWER($2)),0)
       WHERE LOWER(minecraft_name)=LOWER($1)`,
      [newMcName, legacyName]
    );
    await client.query(`DELETE FROM player_balances WHERE LOWER(minecraft_name)=LOWER($1)`, [legacyName]);

    // 6. Migrar tudo da conta de site legacy
    if (legacyUserId) {
      await client.query(`UPDATE user_posts    SET author_id=$1 WHERE author_id=$2`, [currentUserId, legacyUserId]);
      await client.query(`UPDATE post_comments SET author_id=$1 WHERE author_id=$2`, [currentUserId, legacyUserId]);
      await client.query(
        `INSERT INTO post_likes (post_id, user_id)
         SELECT post_id, $1 FROM post_likes WHERE user_id=$2 ON CONFLICT DO NOTHING`,
        [currentUserId, legacyUserId]
      );
      await client.query(`DELETE FROM post_likes WHERE user_id=$1`, [legacyUserId]);
      await client.query(
        `INSERT INTO user_follows (follower_id, following_id)
         SELECT $1, following_id FROM user_follows WHERE follower_id=$2
           AND following_id != $1 ON CONFLICT DO NOTHING`,
        [currentUserId, legacyUserId]
      );
      await client.query(`DELETE FROM user_follows WHERE follower_id=$1`, [legacyUserId]);
      await client.query(
        `UPDATE player_notes SET minecraft_name=$1 WHERE LOWER(minecraft_name)=LOWER($2)`,
        [newMcName, legacyName]
      );
      await client.query(
        `UPDATE users
         SET merged_into_user_id=$1, merged_at=NOW(), migration_note='Migração full — dados transferidos para conta original'
         WHERE id=$2`,
        [currentUserId, legacyUserId]
      );
    }

    // 7. Alias interno (is_active=FALSE — só para auditoria admin, não aparece em UI)
    await client.query(
      `INSERT INTO username_aliases (user_id, alias_username, migration_id, migration_mode, is_active)
       VALUES ($1,$2,$3,'full',FALSE) ON CONFLICT DO NOTHING`,
      [currentUserId, legacyName, migrationId]
    );

    // 8. Concluir — irreversível (sem reversible_until)
    await client.query(
      `UPDATE account_migrations
       SET status='completed', executed_at=NOW(), migration_mode='full',
           reversible_until=NULL, updated_at=NOW()
       WHERE id=$1`,
      [migrationId]
    );

    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ─────────────────────────────────────────────
// Helper: extrair IP do req
// ─────────────────────────────────────────────
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
}

// ─────────────────────────────────────────────
// Exportação principal: registro das rotas
// ─────────────────────────────────────────────
export function registerLegacyMigration(app, pool, auth, requireAdmin, requireOwner, auditFromReq) {

  // ══════════════════════════════════════════════════════════════
  // GET /api/me/legacy/suggestion
  // Badge na nav + sugestão automática baseada em nick anterior
  // ══════════════════════════════════════════════════════════════
  app.get('/api/me/legacy/suggestion', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT up.pending_legacy_suggestion,
                am.id AS mig_id, am.status, am.migration_mode,
                am.legacy_username, am.executed_at
         FROM user_preferences up
         LEFT JOIN account_migrations am
           ON am.user_id=$1
           AND am.status NOT IN ('rejected','reversed')
         WHERE up.user_id=$1
         LIMIT 1`,
        [req.user.sub]
      );
      const row = rows[0] || {};
      res.json({
        suggestion: row.pending_legacy_suggestion || null,
        activeMigration: row.mig_id ? {
          id: row.mig_id,
          status: row.status,
          mode: row.migration_mode,
          legacyUsername: row.legacy_username,
          executedAt: row.executed_at,
        } : null,
      });
    } catch (e) {
      console.error('[legacy/suggestion]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/check
  // Verifica elegibilidade e retorna preview dos dados do nick
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/check', auth, migrationDiscoveryLimiter, async (req, res) => {
    const legacyName = String(req.body?.legacy_username || '').trim();
    if (!legacyName || legacyName.length < 2 || legacyName.length > 64) {
      return res.status(400).json({ error: 'Nick inválido (entre 2 e 64 caracteres).' });
    }

    try {
      const eligibility = await checkEligibility(pool, req.user, legacyName);
      if (!eligibility.eligible) {
        return res.status(400).json({ error: eligibility.reason });
      }

      const preview = await getLegacyDataPreview(pool, legacyName);
      if (!preview.hasData) {
        return res.status(404).json({ error: `Nenhum dado encontrado para "${legacyName}" no servidor. Verifique se o nick está correto.` });
      }

      res.json({ eligible: true, preview });
    } catch (e) {
      console.error('[legacy/check]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/request
  // Cria solicitação de migração e dispara verificação
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/request', auth, migrationRequestLimiter, async (req, res) => {
    const legacyName = String(req.body?.legacy_username || '').trim();
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    if (!legacyName || legacyName.length < 2 || legacyName.length > 64) {
      return res.status(400).json({ error: 'Nick inválido.' });
    }
    if (!['separate', 'partial', 'full'].includes(mode)) {
      return res.status(400).json({ error: 'Escolha um modo de vinculação válido.' });
    }

    try {
      const eligibility = await checkEligibility(pool, req.user, legacyName);
      if (!eligibility.eligible) return res.status(400).json({ error: eligibility.reason });

      const preview = await getLegacyDataPreview(pool, legacyName);
      if (!preview.hasData) {
        return res.status(404).json({ error: `Nenhum dado encontrado para "${legacyName}".` });
      }

      const legacyUser = preview.legacyUser;
      const offlineUUID = computeOfflineUUID(legacyName);

      // Obter email do usuário atual para Tier 1
      const { rows: meRows } = await pool.query(
        `SELECT email FROM users WHERE id=$1`, [req.user.sub]
      );
      req.user.email = meRows[0]?.email;

      const tierInfo = await determineVerificationTier(pool, req.user, legacyName, legacyUser);

      // Determinar status inicial
      const initialStatus = tierInfo.autoApprove
        ? 'verified'
        : (tierInfo.tier === 3 ? 'pending_admin' : 'pending_verification');

      // Criar registro de migração
      const { rows: migRows } = await pool.query(
        `INSERT INTO account_migrations
           (user_id, legacy_username, legacy_user_id, legacy_offline_uuid,
            verification_tier, status, migration_mode, request_ip, request_ua)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          req.user.sub,
          legacyName,
          legacyUser?.id || null,
          offlineUUID,
          tierInfo.tierName,
          initialStatus,
          mode,
          getIp(req),
          req.headers['user-agent'] || null,
        ]
      );
      const migrationId = migRows[0].id;

      // Tier 2: gerar e enviar código por e-mail
      if (tierInfo.tier === 2) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await pool.query(
          `INSERT INTO migration_verifications (migration_id, email, code, expires_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (migration_id) DO UPDATE SET code=$3, expires_at=$4, attempts=0`,
          [migrationId, tierInfo.email, code, expiresAt]
        );
        await sendMigrationVerificationEmail(tierInfo.email, legacyName, code);
      }

      // Se auto-aprovado, marcar verified_at
      if (tierInfo.autoApprove) {
        await pool.query(
          `UPDATE account_migrations SET verified_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [migrationId]
        );
      }

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'info',
        targetName: legacyName,
        message: `Solicitação de migração legacy criada: "${legacyName}" (tier ${tierInfo.tier} — ${tierInfo.tierName})`,
        metadata: { migrationId, mode, tier: tierInfo.tier, tierName: tierInfo.tierName, autoApprove: tierInfo.autoApprove, offlineUUID },
      });

      res.json({
        migrationId,
        mode,
        tier: tierInfo.tier,
        tierName: tierInfo.tierName,
        autoApproved: tierInfo.autoApprove,
        pendingAdmin: tierInfo.tier === 3,
        emailSent: tierInfo.tier === 2,
        emailMask: tierInfo.tier === 2
          ? tierInfo.email.replace(/(.{2}).*(@.*)/, '$1***$2')
          : null,
        preview,
      });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Já existe uma solicitação ativa para este nick.' });
      }
      console.error('[legacy/request]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/verify
  // Confirma código de e-mail (Tier 2)
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/verify', auth, migrationVerifyLimiter, async (req, res) => {
    const { migration_id, code } = req.body || {};
    if (!migration_id || !code) return res.status(400).json({ error: 'Dados incompletos.' });

    try {
      const { rows } = await pool.query(
        `SELECT am.id, am.status, am.user_id,
                mv.code AS exp_code, mv.expires_at, mv.attempts
         FROM account_migrations am
         LEFT JOIN migration_verifications mv ON mv.migration_id=am.id
         WHERE am.id=$1 AND am.user_id=$2`,
        [migration_id, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada.' });

      const mig = rows[0];
      if (mig.status !== 'pending_verification') {
        return res.status(400).json({ error: 'Esta solicitação não aguarda verificação por código.' });
      }
      if (!mig.exp_code) {
        return res.status(400).json({ error: 'Nenhum código de verificação disponível.' });
      }
      if (new Date(mig.expires_at) < new Date()) {
        return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
      }
      if (mig.attempts >= 3) {
        return res.status(429).json({ error: 'Muitas tentativas. Solicite um novo código.' });
      }

      // Incrementar tentativas antes de verificar
      await pool.query(
        `UPDATE migration_verifications SET attempts=attempts+1 WHERE migration_id=$1`,
        [migration_id]
      );

      if (String(code).trim() !== String(mig.exp_code).trim()) {
        return res.status(400).json({ error: 'Código incorreto.' });
      }

      // Código correto — marcar como verificado
      await pool.query(
        `UPDATE account_migrations SET status='verified', verified_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [migration_id]
      );
      await pool.query(`DELETE FROM migration_verifications WHERE migration_id=$1`, [migration_id]);

      res.json({ verified: true });
    } catch (e) {
      console.error('[legacy/verify]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/resend-code
  // Reenvia código de verificação por e-mail
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/resend-code', auth, migrationVerifyLimiter, async (req, res) => {
    const { migration_id } = req.body || {};
    if (!migration_id) return res.status(400).json({ error: 'migration_id obrigatório.' });

    try {
      const { rows } = await pool.query(
        `SELECT am.legacy_username, mv.email, am.status
         FROM account_migrations am
         JOIN migration_verifications mv ON mv.migration_id=am.id
         WHERE am.id=$1 AND am.user_id=$2`,
        [migration_id, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada.' });
      if (rows[0].status !== 'pending_verification') {
        return res.status(400).json({ error: 'Esta solicitação não aguarda verificação.' });
      }

      const { legacy_username, email } = rows[0];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await pool.query(
        `UPDATE migration_verifications SET code=$1, expires_at=$2, attempts=0, created_at=NOW() WHERE migration_id=$3`,
        [code, expiresAt, migration_id]
      );
      await sendMigrationVerificationEmail(email, legacy_username, code);

      res.json({
        sent: true,
        emailMask: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
      });
    } catch (e) {
      console.error('[legacy/resend-code]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // GET /api/me/legacy/status
  // Lista migrações do usuário atual
  // ══════════════════════════════════════════════════════════════
  app.get('/api/me/legacy/status', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT am.id, am.legacy_username, am.status, am.migration_mode,
                am.verification_tier, am.verified_at, am.executed_at,
                am.reversible_until, am.rejection_reason, am.created_at,
                ua.alias_username
         FROM account_migrations am
         LEFT JOIN username_aliases ua ON ua.migration_id=am.id
         WHERE am.user_id=$1
         ORDER BY am.created_at DESC
         LIMIT 20`,
        [req.user.sub]
      );
      res.json({ migrations: rows });
    } catch (e) {
      console.error('[legacy/status]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/execute
  // Executa migração (separate/partial) ou prepara token para full
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/execute', auth, migrationExecutionLimiter, async (req, res) => {
    const { migration_id, mode } = req.body || {};
    if (!migration_id || !['separate', 'partial', 'full'].includes(mode)) {
      return res.status(400).json({ error: 'Dados inválidos. mode deve ser separate, partial ou full.' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT am.*, u.minecraft_name AS current_mc_name
         FROM account_migrations am
         JOIN users u ON u.id=am.user_id
         WHERE am.id=$1 AND am.user_id=$2`,
        [migration_id, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada.' });

      const mig = rows[0];
      if (mig.status !== 'verified') {
        return res.status(400).json({ error: 'Esta solicitação ainda não foi verificada ou aprovada.' });
      }
      if (mig.migration_mode && mig.migration_mode !== mode) {
        return res.status(409).json({ error: `Esta solicitação foi verificada para o modo "${mig.migration_mode}". Crie uma nova solicitação para alterar o modo.` });
      }
      if (!mig.current_mc_name && mode !== 'separate') {
        return res.status(400).json({ error: 'Seu perfil não tem um nick Minecraft vinculado. Vincule sua conta Microsoft primeiro.' });
      }

      // Modo full: gerar token de confirmação, não executar ainda
      if (mode === 'full') {
        const confirmToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
        await pool.query(
          `UPDATE account_migrations
           SET confirm_token=$1, confirm_token_expires=$2, migration_mode='full', updated_at=NOW()
           WHERE id=$3`,
          [confirmToken, expiresAt, migration_id]
        );
        return res.json({ confirmRequired: true, confirmToken, expiresInSeconds: 600 });
      }

      // Executar separate ou partial
      const newMcName = mig.current_mc_name;
      if (mode === 'separate') {
        await executeSeparate(pool, migration_id, req.user.sub, mig.legacy_username);
      } else {
        await executePartial(pool, migration_id, req.user.sub, mig.legacy_username, mig.legacy_user_id, newMcName);
      }

      // Limpar sugestão automática
      await pool.query(
        `UPDATE user_preferences SET pending_legacy_suggestion=NULL WHERE user_id=$1`,
        [req.user.sub]
      );

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: mode === 'partial' ? 'warning' : 'info',
        targetName: mig.legacy_username,
        message: `Migração ${mode} concluída: "${mig.legacy_username}" → "${newMcName || 'sem_nick'}"`,
        metadata: { migrationId: migration_id, mode, legacyUserId: mig.legacy_user_id },
      });

      res.json({ executed: true, mode });
    } catch (e) {
      console.error('[legacy/execute]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // POST /api/me/legacy/confirm-full
  // Executa migração full após confirmação com token
  // ══════════════════════════════════════════════════════════════
  app.post('/api/me/legacy/confirm-full', auth, migrationExecutionLimiter, async (req, res) => {
    const { migration_id, confirm_token } = req.body || {};
    if (!migration_id || !confirm_token) {
      return res.status(400).json({ error: 'migration_id e confirm_token são obrigatórios.' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT am.*, u.minecraft_name AS current_mc_name
         FROM account_migrations am
         JOIN users u ON u.id=am.user_id
         WHERE am.id=$1 AND am.user_id=$2`,
        [migration_id, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada.' });

      const mig = rows[0];
      if (mig.status !== 'verified') {
        return res.status(400).json({ error: 'Solicitação não verificada.' });
      }
      if (!mig.confirm_token || mig.confirm_token !== confirm_token) {
        return res.status(400).json({ error: 'Token de confirmação inválido.' });
      }
      if (!mig.confirm_token_expires || new Date(mig.confirm_token_expires) < new Date()) {
        return res.status(400).json({ error: 'Token expirado. Reinicie o processo de confirmação.' });
      }

      const newMcName = mig.current_mc_name;
      await executeFull(pool, migration_id, req.user.sub, mig.legacy_username, mig.legacy_user_id, newMcName);

      // Limpar sugestão
      await pool.query(
        `UPDATE user_preferences SET pending_legacy_suggestion=NULL WHERE user_id=$1`,
        [req.user.sub]
      );

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'critical',
        targetName: mig.legacy_username,
        message: `Migração FULL (IRREVERSÍVEL) concluída: "${mig.legacy_username}" → "${newMcName}"`,
        metadata: { migrationId: migration_id, mode: 'full', legacyUserId: mig.legacy_user_id, newMcName },
      });

      res.json({ executed: true, mode: 'full' });
    } catch (e) {
      console.error('[legacy/confirm-full]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // DELETE /api/me/legacy/reverse/:id
  // Reverter migração separate ou partial (dentro da janela de reversão)
  // ══════════════════════════════════════════════════════════════
  app.delete('/api/me/legacy/reverse/:id', auth, async (req, res) => {
    const migrationId = Number(req.params.id);
    if (!migrationId) return res.status(400).json({ error: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT * FROM account_migrations WHERE id=$1 AND user_id=$2`,
        [migrationId, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: 'Solicitação não encontrada.' });

      const mig = rows[0];
      if (mig.status !== 'completed') {
        return res.status(400).json({ error: 'Apenas migrações concluídas podem ser revertidas.' });
      }
      if (mig.migration_mode === 'full') {
        return res.status(400).json({ error: 'Migração total é irreversível.' });
      }
      if (mig.reversible_until && new Date(mig.reversible_until) < new Date()) {
        return res.status(400).json({ error: 'O prazo de reversão (7 dias) expirou.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Remover alias
        await client.query(
          `DELETE FROM username_aliases WHERE migration_id=$1`,
          [migrationId]
        );

        // Modo partial: restaurar dados via snapshot
        if (mig.migration_mode === 'partial' && mig.legacy_data_snapshot) {
          const snap = mig.legacy_data_snapshot;

          // Desmarcar sessões legacy
          await client.query(
            `UPDATE player_sessions
             SET is_alias_session=FALSE, alias_original_name=NULL
             WHERE LOWER(alias_original_name)=LOWER($1)`,
            [mig.legacy_username]
          );

          // Restaurar balanço legacy e remover do atual
          const snapBal = snap.player_balances;
          if (snapBal) {
            // Subtrair do balanço atual o que foi somado
            await client.query(
              `UPDATE player_balances
               SET merit_total     = GREATEST(0, merit_total - $1),
                   capital_balance = GREATEST(0, capital_balance - $2)
               WHERE LOWER(minecraft_name) = (
                 SELECT LOWER(minecraft_name) FROM users WHERE id=$3
               )`,
              [snapBal.merit_total || 0, snapBal.capital_balance || 0, req.user.sub]
            );
            // Recriar entrada legacy
            await client.query(
              `INSERT INTO player_balances (minecraft_name, merit_total, capital_balance)
               VALUES ($1,$2,$3)
               ON CONFLICT (minecraft_name) DO UPDATE
                 SET merit_total=$2, capital_balance=$3`,
              [mig.legacy_username, snapBal.merit_total || 0, snapBal.capital_balance || 0]
            );
          }

          // Restaurar conta legacy no site se havia
          if (mig.legacy_user_id) {
            await client.query(
              `UPDATE users SET merged_into_user_id=NULL, merged_at=NULL, migration_note=NULL WHERE id=$1`,
              [mig.legacy_user_id]
            );
            // Devolver posts/comments para o usuário legacy
            await client.query(
              `UPDATE user_posts SET author_id=$1 WHERE author_id=$2 AND created_at < $3`,
              [mig.legacy_user_id, req.user.sub, mig.executed_at]
            );
            await client.query(
              `UPDATE post_comments SET author_id=$1 WHERE author_id=$2 AND created_at < $3`,
              [mig.legacy_user_id, req.user.sub, mig.executed_at]
            );
          }
        }

        await client.query(
          `UPDATE account_migrations SET status='reversed', updated_at=NOW() WHERE id=$1`,
          [migrationId]
        );

        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'warning',
        targetName: mig.legacy_username,
        message: `Migração revertida: "${mig.legacy_username}" (modo ${mig.migration_mode})`,
        metadata: { migrationId, mode: mig.migration_mode },
      });

      res.json({ reversed: true });
    } catch (e) {
      console.error('[legacy/reverse]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: GET /api/admin/legacy/pending
  // Lista solicitações aguardando revisão manual
  // ══════════════════════════════════════════════════════════════
  app.get('/api/admin/legacy/pending', auth, requireOwner, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT am.*, u.username AS requester_username, u.minecraft_name AS requester_mc, u.email AS requester_email
         FROM account_migrations am
         JOIN users u ON u.id=am.user_id
         WHERE am.status='pending_admin'
         ORDER BY am.created_at ASC`
      );
      const enriched = await Promise.all(rows.map(async (r) => {
        const preview = await getLegacyDataPreview(pool, r.legacy_username);
        return { ...r, preview };
      }));
      res.json({ migrations: enriched });
    } catch (e) {
      console.error('[admin/legacy/pending]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: GET /api/admin/legacy/all
  // Lista todas as migrações
  // ══════════════════════════════════════════════════════════════
  app.get('/api/admin/legacy/all', auth, requireOwner, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT am.*, u.username AS requester_username, u.minecraft_name AS requester_mc,
                rev.username AS reviewer_username
         FROM account_migrations am
         JOIN users u ON u.id=am.user_id
         LEFT JOIN users rev ON rev.id=am.reviewed_by
         ORDER BY am.created_at DESC
         LIMIT 200`
      );
      res.json({ migrations: rows });
    } catch (e) {
      console.error('[admin/legacy/all]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: POST /api/admin/legacy/:id/approve
  // Aprova solicitação de revisão manual
  // ══════════════════════════════════════════════════════════════
  app.post('/api/admin/legacy/:id/approve', auth, requireOwner, async (req, res) => {
    const migrationId = Number(req.params.id);
    const notes = String(req.body?.notes || '').trim();

    try {
      const { rows } = await pool.query(
        `UPDATE account_migrations
         SET status='verified', verified_at=NOW(), verification_tier='admin_review',
             reviewed_by=$1, reviewed_at=NOW(), admin_notes=$2, updated_at=NOW()
         WHERE id=$3 AND status='pending_admin'
         RETURNING legacy_username, user_id`,
        [req.user.sub, notes || null, migrationId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Solicitação não encontrada ou já processada.' });
      }

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'warning',
        targetId: migrationId, targetName: rows[0].legacy_username,
        message: `Admin aprovou migração legacy #${migrationId}: "${rows[0].legacy_username}" para user #${rows[0].user_id}`,
        metadata: { migrationId, notes, targetUserId: rows[0].user_id },
      });

      res.json({ approved: true });
    } catch (e) {
      console.error('[admin/legacy/approve]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: POST /api/admin/legacy/:id/reject
  // Rejeita solicitação de revisão manual
  // ══════════════════════════════════════════════════════════════
  app.post('/api/admin/legacy/:id/reject', auth, requireOwner, async (req, res) => {
    const migrationId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Informe o motivo da rejeição.' });

    try {
      const { rows } = await pool.query(
        `UPDATE account_migrations
         SET status='rejected', reviewed_by=$1, reviewed_at=NOW(),
             rejection_reason=$2, updated_at=NOW()
         WHERE id=$3 AND status='pending_admin'
         RETURNING legacy_username`,
        [req.user.sub, reason, migrationId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Solicitação não encontrada ou já processada.' });
      }

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'info',
        targetId: migrationId, targetName: rows[0].legacy_username,
        message: `Admin rejeitou migração legacy #${migrationId}: "${rows[0].legacy_username}" — ${reason}`,
        metadata: { migrationId, reason },
      });

      res.json({ rejected: true });
    } catch (e) {
      console.error('[admin/legacy/reject]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: POST /api/admin/legacy/preset
  // Cria preset de pré-aprovação automática (caso como Caio/Porralho)
  // ══════════════════════════════════════════════════════════════
  app.post('/api/admin/legacy/preset', auth, requireOwner, async (req, res) => {
    const legacyUsername = String(req.body?.legacy_username || '').trim();
    const targetUserId   = Number(req.body?.target_user_id);
    const note           = String(req.body?.note || '').trim();

    if (!legacyUsername || !targetUserId) {
      return res.status(400).json({ error: 'legacy_username e target_user_id são obrigatórios.' });
    }

    try {
      const { rows: uRows } = await pool.query(
        `SELECT username, minecraft_name FROM users WHERE id=$1`, [targetUserId]
      );
      if (!uRows.length) return res.status(404).json({ error: 'Usuário de destino não encontrado.' });

      const { rows } = await pool.query(
        `INSERT INTO legacy_migration_presets (legacy_username, target_user_id, created_by, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (LOWER(legacy_username)) DO UPDATE
           SET target_user_id=$2, created_by=$3, note=$4, created_at=NOW()
         RETURNING id`,
        [legacyUsername, targetUserId, req.user.sub, note || null]
      );

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'info',
        targetName: legacyUsername,
        message: `Preset legacy criado: "${legacyUsername}" → user #${targetUserId} (${uRows[0].username})`,
        metadata: { presetId: rows[0].id, targetUserId, targetUsername: uRows[0].username, note },
      });

      res.json({ preset: { id: rows[0].id, legacy_username: legacyUsername }, targetUser: uRows[0] });
    } catch (e) {
      console.error('[admin/legacy/preset]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: GET /api/admin/legacy/presets
  // Lista todos os presets
  // ══════════════════════════════════════════════════════════════
  app.get('/api/admin/legacy/presets', auth, requireOwner, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT lmp.id, lmp.legacy_username, lmp.note, lmp.created_at,
                u.id AS target_user_id, u.username AS target_username, u.minecraft_name AS target_mc,
                ab.username AS created_by_name
         FROM legacy_migration_presets lmp
         JOIN users u ON u.id=lmp.target_user_id
         LEFT JOIN users ab ON ab.id=lmp.created_by
         ORDER BY lmp.created_at DESC`
      );
      res.json({ presets: rows });
    } catch (e) {
      console.error('[admin/legacy/presets]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ADMIN: DELETE /api/admin/legacy/preset/:id
  // Remove preset
  // ══════════════════════════════════════════════════════════════
  app.delete('/api/admin/legacy/preset/:id', auth, requireOwner, async (req, res) => {
    const presetId = Number(req.params.id);
    try {
      const { rows } = await pool.query(
        `DELETE FROM legacy_migration_presets WHERE id=$1 RETURNING legacy_username`,
        [presetId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Preset não encontrado.' });

      await auditFromReq(req, {
        actorId: req.user.sub, actorName: req.user.username,
        type: 'account_migration', severity: 'info',
        message: `Preset legacy removido: "${rows[0].legacy_username}" (#${presetId})`,
        metadata: { presetId },
      });

      res.json({ deleted: true });
    } catch (e) {
      console.error('[admin/legacy/preset DELETE]', e);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Retorna utilitário público para uso em outros módulos
  // (ex: chamar após OAuth Microsoft quando nick muda)
  // ══════════════════════════════════════════════════════════════
  return {
    /**
     * Detectar automaticamente se há dados de um nick anterior
     * e gravar sugestão no perfil do usuário.
     * Chamar no handler de OAuth Microsoft após atualização do minecraft_name.
     *
     * @param {number} userId - ID do usuário no site
     * @param {string|null} previousMcName - Nick antigo (antes do OAuth)
     * @param {string} newMcName - Nick novo (após OAuth)
     */
    async detectLegacyOnOAuthCallback(userId, previousMcName, newMcName) {
      if (!previousMcName || !newMcName) return;
      if (previousMcName.toLowerCase() === newMcName.toLowerCase()) return;

      try {
        const preview = await getLegacyDataPreview(pool, previousMcName);
        if (!preview.hasData) return;

        // Verificar se já existe migração ou alias para este nick
        const { rows: existing } = await pool.query(
          `SELECT id FROM account_migrations
           WHERE LOWER(legacy_username)=$1 AND status NOT IN ('rejected','reversed')
           LIMIT 1`,
          [previousMcName.toLowerCase()]
        );
        if (existing.length) return; // Já tem migração ativa

        const { rows: existingAlias } = await pool.query(
          `SELECT id FROM username_aliases WHERE LOWER(alias_username)=$1 AND is_active=TRUE LIMIT 1`,
          [previousMcName.toLowerCase()]
        );
        if (existingAlias.length) return; // Já tem alias

        // Gravar sugestão para exibir o badge na aba Conta Anterior
        await pool.query(
          `INSERT INTO user_preferences (user_id, pending_legacy_suggestion)
           VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET pending_legacy_suggestion=$2`,
          [userId, previousMcName]
        );

        console.log(`[legacy/auto-detect] Sugestão gravada: user #${userId} tem dados do nick "${previousMcName}"`);
      } catch (e) {
        console.error('[legacy/auto-detect]', e);
      }
    },

    /** Utilitário para admin pre-seed via script */
    computeOfflineUUID,
  };
}
