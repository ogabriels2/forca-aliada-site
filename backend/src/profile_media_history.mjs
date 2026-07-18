const DEFAULT_BASE_PATH = '/api/me/profile-images';
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['res.cloudinary.com']);
const MAX_URL_LENGTH = 2048;
const MAX_METADATA_BYTES = 8192;

export const PROFILE_MEDIA_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS profile_media_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_kind VARCHAR(16) NOT NULL DEFAULT 'avatar'
    CHECK (media_kind = 'avatar'),
  media_url TEXT NOT NULL
    CHECK (octet_length(media_url) BETWEEN 1 AND ${MAX_URL_LENGTH}),
  provider VARCHAR(32) NOT NULL DEFAULT 'cloudinary',
  provider_public_id TEXT,
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 20000),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 20000),
  bytes BIGINT CHECK (bytes IS NULL OR bytes BETWEEN 0 AND 52428800),
  format VARCHAR(24),
  source VARCHAR(32) NOT NULL DEFAULT 'community',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  selected_at TIMESTAMPTZ,
  UNIQUE (user_id, media_kind, media_url)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_media_history_one_current
  ON profile_media_history(user_id, media_kind)
  WHERE is_current = TRUE;

CREATE INDEX IF NOT EXISTS idx_profile_media_history_user_recent
  ON profile_media_history(user_id, media_kind, selected_at DESC NULLS LAST, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_media_history_provider_asset
  ON profile_media_history(provider, provider_public_id)
  WHERE provider_public_id IS NOT NULL AND provider_public_id <> '';

-- Reconciles a previous backfill before making the current URL active again.
UPDATE profile_media_history h
SET is_current = FALSE
FROM user_preferences up
WHERE h.user_id = up.user_id
  AND h.media_kind = 'avatar'
  AND h.is_current = TRUE
  AND h.media_url IS DISTINCT FROM NULLIF(BTRIM(up.avatar_url), '');

-- Imports only the managed Cloudinary avatars that already exist in production.
-- Arbitrary external URLs are deliberately not promoted into the selectable history.
INSERT INTO profile_media_history (
  user_id, media_kind, media_url, provider, source, is_current, selected_at
)
SELECT
  up.user_id,
  'avatar',
  BTRIM(up.avatar_url),
  'cloudinary',
  'legacy_backfill',
  TRUE,
  COALESCE(up.updated_at, NOW())
FROM user_preferences up
WHERE BTRIM(COALESCE(up.avatar_url, '')) ~* '^https://res\\.cloudinary\\.com/[^/]+/image/upload/'
ON CONFLICT (user_id, media_kind, media_url)
DO UPDATE SET
  is_current = TRUE,
  selected_at = COALESCE(profile_media_history.selected_at, EXCLUDED.selected_at);
`;

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error(`${label} invalido.`);
    error.status = 400;
    error.code = 'PROFILE_MEDIA_INVALID_ID';
    throw error;
  }
  return parsed;
}

function optionalInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function cleanToken(value, maxLength = 32, fallback = '') {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
  return cleaned || fallback;
}

function cleanPublicId(value) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned || cleaned.length > 512 || /[\0\r\n]/.test(cleaned)) return null;
  return cleaned;
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      const error = new Error('Metadados da imagem excedem o limite permitido.');
      error.status = 400;
      error.code = 'PROFILE_MEDIA_METADATA_TOO_LARGE';
      throw error;
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error?.code === 'PROFILE_MEDIA_METADATA_TOO_LARGE') throw error;
    const invalid = new Error('Metadados da imagem sao invalidos.');
    invalid.status = 400;
    invalid.code = 'PROFILE_MEDIA_INVALID_METADATA';
    throw invalid;
  }
}

function allowedHosts(extraHosts = []) {
  const configured = String(process.env.PROFILE_MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    ...configured,
    ...(Array.isArray(extraHosts) ? extraHosts : []),
  ].map(host => String(host || '').trim().toLowerCase()).filter(Boolean));
}

function normalizeAvatarUrl(value, extraHosts = []) {
  const raw = String(value ?? '').trim();
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_URL_LENGTH) {
    const error = new Error('URL da foto de perfil invalida.');
    error.status = 400;
    error.code = 'PROFILE_MEDIA_INVALID_URL';
    throw error;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error('URL da foto de perfil invalida.');
    error.status = 400;
    error.code = 'PROFILE_MEDIA_INVALID_URL';
    throw error;
  }

  const host = url.hostname.toLowerCase();
  const hosts = allowedHosts(extraHosts);
  const isCloudinary = host === 'res.cloudinary.com';
  const validCloudinaryPath = /^\/[^/]+\/image\/upload\//i.test(url.pathname);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || !hosts.has(host)
    || (isCloudinary && !validCloudinaryPath)
  ) {
    const error = new Error('A foto precisa usar uma URL HTTPS de armazenamento autorizado.');
    error.status = 400;
    error.code = 'PROFILE_MEDIA_UNTRUSTED_URL';
    throw error;
  }

  url.hash = '';
  return url.href;
}

function cloudinaryPublicIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'res.cloudinary.com') return null;
    const marker = '/image/upload/';
    const markerIndex = url.pathname.toLowerCase().indexOf(marker);
    if (markerIndex < 0) return null;
    let tail = decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
    const segments = tail.split('/').filter(Boolean);
    const versionIndex = segments.findIndex(segment => /^v\d+$/.test(segment));
    if (versionIndex >= 0) segments.splice(0, versionIndex + 1);
    tail = segments.join('/').replace(/\.[a-z0-9]{2,8}$/i, '');
    return cleanPublicId(tail);
  } catch {
    return null;
  }
}

function normalizeRecordInput(input = {}, extraHosts = []) {
  const userId = positiveInteger(input.userId ?? input.user_id, 'Usuario');
  const mediaUrl = normalizeAvatarUrl(input.avatarUrl ?? input.avatar_url ?? input.url, extraHosts);
  const provider = cleanToken(input.provider, 32, new URL(mediaUrl).hostname === 'res.cloudinary.com' ? 'cloudinary' : 'managed');
  const providerPublicId = cleanPublicId(
    input.providerPublicId
      ?? input.provider_public_id,
  );
  return {
    userId,
    mediaUrl,
    provider,
    providerPublicId,
    width: optionalInteger(input.width, { min: 1, max: 20000 }),
    height: optionalInteger(input.height, { min: 1, max: 20000 }),
    bytes: optionalInteger(input.bytes, { min: 0, max: 50 * 1024 * 1024 }),
    format: cleanToken(input.format, 24, '') || null,
    source: cleanToken(input.source, 32, 'community'),
    metadata: safeMetadata(input.metadata),
  };
}

async function ensurePreferencesRow(client, userId) {
  await client.query(
    `INSERT INTO user_preferences(user_id)
     VALUES($1)
     ON CONFLICT(user_id) DO NOTHING`,
    [userId],
  );
}

async function selectAvatarWithClient(client, record) {
  await ensurePreferencesRow(client, record.userId);
  await client.query(
    'SELECT user_id FROM user_preferences WHERE user_id=$1 FOR UPDATE',
    [record.userId],
  );

  await client.query(
    `UPDATE profile_media_history
     SET is_current=FALSE
     WHERE user_id=$1 AND media_kind='avatar' AND is_current=TRUE`,
    [record.userId],
  );

  const { rows } = await client.query(
    `INSERT INTO profile_media_history (
       user_id, media_kind, media_url, provider, provider_public_id,
       width, height, bytes, format, source, metadata, is_current, selected_at
     )
     VALUES($1,'avatar',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,TRUE,NOW())
     ON CONFLICT(user_id, media_kind, media_url)
     DO UPDATE SET
       provider=EXCLUDED.provider,
       provider_public_id=COALESCE(EXCLUDED.provider_public_id, profile_media_history.provider_public_id),
       width=COALESCE(EXCLUDED.width, profile_media_history.width),
       height=COALESCE(EXCLUDED.height, profile_media_history.height),
       bytes=COALESCE(EXCLUDED.bytes, profile_media_history.bytes),
       format=COALESCE(EXCLUDED.format, profile_media_history.format),
       source=EXCLUDED.source,
       metadata=profile_media_history.metadata || EXCLUDED.metadata,
       is_current=TRUE,
       selected_at=NOW()
     RETURNING id, user_id, media_url, provider, width, height, bytes, format,
               source, is_current, created_at, selected_at`,
    [
      record.userId,
      record.mediaUrl,
      record.provider,
      record.providerPublicId,
      record.width,
      record.height,
      record.bytes,
      record.format,
      record.source,
      JSON.stringify(record.metadata),
    ],
  );

  await client.query(
    `UPDATE user_preferences
     SET avatar_url=$2, updated_at=NOW()
     WHERE user_id=$1`,
    [record.userId, record.mediaUrl],
  );

  return rows[0];
}

/**
 * Records an uploaded avatar and atomically makes it the active profile image.
 *
 * @param {import('pg').Pool} pool
 * @param {{userId:number, avatarUrl:string, provider?:string, providerPublicId?:string,
 *   width?:number, height?:number, bytes?:number, format?:string, source?:string,
 *   metadata?:Record<string, unknown>}} input
 * @param {{allowedHosts?:string[]}} options
 */
export async function recordProfileAvatarSelection(pool, input, options = {}) {
  if (!pool?.connect) throw new TypeError('recordProfileAvatarSelection requer um pool PostgreSQL.');
  const record = normalizeRecordInput(input, options.allowedHosts);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await selectAvatarWithClient(client, record);
    await client.query('COMMIT');
    return selected;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stores an authenticated upload in the private history without selecting it.
 * The provider id must come from the storage API response; it is never inferred
 * from a client-supplied URL, so deletion authority cannot be forged.
 */
export async function recordProfileAvatarUpload(pool, input, options = {}) {
  if (!pool?.query) throw new TypeError('recordProfileAvatarUpload requer um pool PostgreSQL.');
  const record = normalizeRecordInput(input, options.allowedHosts);
  if (record.provider === 'cloudinary' && !record.providerPublicId) {
    const error = new Error('Identificador do arquivo enviado nao foi informado.');
    error.status = 400;
    error.code = 'PROFILE_MEDIA_MISSING_PROVIDER_ID';
    throw error;
  }
  const { rows } = await pool.query(
    `INSERT INTO profile_media_history (
       user_id, media_kind, media_url, provider, provider_public_id,
       width, height, bytes, format, source, metadata, is_current, selected_at
     )
     VALUES($1,'avatar',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,FALSE,NULL)
     ON CONFLICT(user_id, media_kind, media_url)
     DO UPDATE SET
       provider=EXCLUDED.provider,
       provider_public_id=COALESCE(profile_media_history.provider_public_id, EXCLUDED.provider_public_id),
       width=COALESCE(EXCLUDED.width, profile_media_history.width),
       height=COALESCE(EXCLUDED.height, profile_media_history.height),
       bytes=COALESCE(EXCLUDED.bytes, profile_media_history.bytes),
       format=COALESCE(EXCLUDED.format, profile_media_history.format),
       metadata=profile_media_history.metadata || EXCLUDED.metadata
     RETURNING id, user_id, media_url, provider, width, height, bytes, format,
               source, is_current, created_at, selected_at`,
    [
      record.userId,
      record.mediaUrl,
      record.provider,
      record.providerPublicId,
      record.width,
      record.height,
      record.bytes,
      record.format,
      record.source,
      JSON.stringify(record.metadata),
    ],
  );
  return rows[0];
}

function responseItem(row) {
  return {
    id: row.id,
    url: row.media_url,
    width: row.width,
    height: row.height,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    format: row.format,
    source: row.source,
    is_current: Boolean(row.effective_is_current ?? row.is_current),
    created_at: row.created_at,
    selected_at: row.selected_at,
  };
}

function httpError(res, error, fallbackMessage) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error('[profile media history]', error);
  return res.status(status).json({
    error: status >= 500 ? fallbackMessage : error.message,
    ...(error?.code ? { code: error.code } : {}),
  });
}

async function runAudit(auditFromReq, req, details) {
  try {
    await auditFromReq(req, details);
  } catch (error) {
    console.error('[profile media history audit]', error);
  }
}

/**
 * Registers the authenticated avatar-history API.
 *
 * Optional helpers:
 * - allowedHosts: additional HTTPS image hosts.
 * - deleteStoredMedia: async callback invoked before a non-current DB item is removed.
 * - basePath: route prefix; defaults to /api/me/profile-images.
 */
export function registerProfileMediaHistory(app, pool, auth, helpers = {}) {
  if (!app?.get || !app?.patch || !app?.delete) {
    throw new TypeError('registerProfileMediaHistory requer uma aplicacao Express.');
  }
  if (!pool?.connect || !pool?.query) {
    throw new TypeError('registerProfileMediaHistory requer um pool PostgreSQL.');
  }
  if (typeof auth !== 'function') {
    throw new TypeError('registerProfileMediaHistory requer o middleware auth.');
  }
  if (typeof helpers.auditFromReq !== 'function') {
    throw new TypeError('registerProfileMediaHistory requer helpers.auditFromReq para auditoria.');
  }

  const basePath = String(helpers.basePath || DEFAULT_BASE_PATH).replace(/\/+$/, '');
  const extraHosts = Array.isArray(helpers.allowedHosts) ? helpers.allowedHosts : [];
  const deleteStoredMedia = typeof helpers.deleteStoredMedia === 'function'
    ? helpers.deleteStoredMedia
    : null;

  app.get(basePath, auth, async (req, res) => {
    try {
      const userId = positiveInteger(req.user?.sub, 'Usuario');
      const limit = Math.max(1, Math.min(100, optionalInteger(req.query?.limit, { min: 1, max: 100 }) || 24));
      const { rows } = await pool.query(
        `SELECT h.id, h.media_url, h.width, h.height, h.bytes, h.format, h.source,
                h.is_current, h.created_at, h.selected_at,
                (h.is_current OR h.media_url = NULLIF(BTRIM(up.avatar_url), '')) AS effective_is_current
         FROM profile_media_history h
         LEFT JOIN user_preferences up ON up.user_id=h.user_id
         WHERE h.user_id=$1 AND h.media_kind='avatar'
         ORDER BY effective_is_current DESC, h.selected_at DESC NULLS LAST, h.created_at DESC, h.id DESC
         LIMIT $2`,
        [userId, limit],
      );
      const items = rows.map(responseItem);
      res.json({
        items,
        current_id: items.find(item => item.is_current)?.id || null,
        current_url: items.find(item => item.is_current)?.url || null,
      });
    } catch (error) {
      httpError(res, error, 'Nao foi possivel carregar o historico de fotos.');
    }
  });

  app.patch(`${basePath}/:id/activate`, auth, async (req, res) => {
    let mediaId;
    let userId;
    try {
      mediaId = positiveInteger(req.params.id, 'Foto');
      userId = positiveInteger(req.user?.sub, 'Usuario');
    } catch (error) {
      return httpError(res, error, 'Nao foi possivel selecionar a foto.');
    }

    let client;
    let selected;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await ensurePreferencesRow(client, userId);
      await client.query('SELECT user_id FROM user_preferences WHERE user_id=$1 FOR UPDATE', [userId]);
      const { rows } = await client.query(
        `SELECT id, user_id, media_url, provider, width, height, bytes, format, source,
                is_current, created_at, selected_at
         FROM profile_media_history
         WHERE id=$1 AND user_id=$2 AND media_kind='avatar'
         FOR UPDATE`,
        [mediaId, userId],
      );
      const target = rows[0];
      if (!target) {
        const error = new Error('Foto nao encontrada neste perfil.');
        error.status = 404;
        error.code = 'PROFILE_MEDIA_NOT_FOUND';
        throw error;
      }

      const mediaUrl = normalizeAvatarUrl(target.media_url, extraHosts);
      await client.query(
        `UPDATE profile_media_history
         SET is_current=FALSE
         WHERE user_id=$1 AND media_kind='avatar' AND id<>$2 AND is_current=TRUE`,
        [userId, mediaId],
      );
      const { rows: selectedRows } = await client.query(
        `UPDATE profile_media_history
         SET is_current=TRUE, selected_at=NOW()
         WHERE id=$1 AND user_id=$2
         RETURNING id, user_id, media_url, provider, width, height, bytes, format,
                   source, is_current, created_at, selected_at`,
        [mediaId, userId],
      );
      await client.query(
        'UPDATE user_preferences SET avatar_url=$2, updated_at=NOW() WHERE user_id=$1',
        [userId, mediaUrl],
      );
      await client.query('COMMIT');
      selected = selectedRows[0];
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      return httpError(res, error, 'Nao foi possivel selecionar a foto.');
    } finally {
      client?.release();
    }

    await runAudit(helpers.auditFromReq, req, {
      actorId: userId,
      actorName: req.user?.username,
      type: 'update',
      targetId: mediaId,
      targetName: 'profile_avatar',
      message: `Foto de perfil #${mediaId} selecionada pelo usuario`,
      metadata: { profileMediaId: mediaId, source: selected.source },
    });
    res.json({ ok: true, item: responseItem(selected) });
  });

  app.delete(`${basePath}/:id`, auth, async (req, res) => {
    let mediaId;
    let userId;
    try {
      mediaId = positiveInteger(req.params.id, 'Foto');
      userId = positiveInteger(req.user?.sub, 'Usuario');
    } catch (error) {
      return httpError(res, error, 'Nao foi possivel remover a foto.');
    }

    let client;
    let removed;
    let storageTarget = null;
    let storageDeleted = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await ensurePreferencesRow(client, userId);
      const { rows: preferenceRows } = await client.query(
        'SELECT avatar_url FROM user_preferences WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      const currentUrl = String(preferenceRows[0]?.avatar_url || '').trim();
      const { rows } = await client.query(
        `SELECT id, user_id, media_url, provider, provider_public_id, width, height,
                bytes, format, source, is_current, created_at, selected_at
         FROM profile_media_history
         WHERE id=$1 AND user_id=$2 AND media_kind='avatar'
         FOR UPDATE`,
        [mediaId, userId],
      );
      const target = rows[0];
      if (!target) {
        const error = new Error('Foto nao encontrada neste perfil.');
        error.status = 404;
        error.code = 'PROFILE_MEDIA_NOT_FOUND';
        throw error;
      }
      if (target.is_current || (currentUrl && currentUrl === String(target.media_url || '').trim())) {
        const error = new Error('Selecione outra foto antes de remover a foto atual.');
        error.status = 409;
        error.code = 'PROFILE_MEDIA_IS_CURRENT';
        throw error;
      }

      normalizeAvatarUrl(target.media_url, extraHosts);
      storageTarget = target;

      const { rows: deletedRows } = await client.query(
        `DELETE FROM profile_media_history
         WHERE id=$1 AND user_id=$2 AND is_current=FALSE
         RETURNING id, media_url, provider, source, created_at`,
        [mediaId, userId],
      );
      if (!deletedRows.length) {
        const error = new Error('A foto atual nao pode ser removida.');
        error.status = 409;
        error.code = 'PROFILE_MEDIA_IS_CURRENT';
        throw error;
      }
      removed = deletedRows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      return httpError(res, error, 'Nao foi possivel remover a foto.');
    } finally {
      client?.release();
    }

    if (deleteStoredMedia && storageTarget?.provider_public_id) {
      try {
        await deleteStoredMedia({
          id: storageTarget.id,
          userId,
          url: storageTarget.media_url,
          provider: storageTarget.provider,
          providerPublicId: storageTarget.provider_public_id,
        });
        storageDeleted = true;
      } catch (error) {
        // The database is authoritative. A storage failure leaves an orphaned
        // asset for later cleanup instead of a broken history row.
        console.error('[profile media storage cleanup]', error);
      }
    }

    await runAudit(helpers.auditFromReq, req, {
      actorId: userId,
      actorName: req.user?.username,
      type: 'delete',
      severity: 'info',
      targetId: mediaId,
      targetName: 'profile_avatar',
      message: `Foto antiga de perfil #${mediaId} removida pelo usuario`,
      metadata: {
        profileMediaId: mediaId,
        provider: removed.provider,
        source: removed.source,
        storageDeleted,
      },
    });
    res.json({ ok: true, removed_id: mediaId, storage_deleted: storageDeleted });
  });
}
