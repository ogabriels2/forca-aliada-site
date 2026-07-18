const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const cleanText = (value, max = 500) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const number = value => Number(value || 0);

export const SOCIAL_DELIVERY_LEVELS = Object.freeze({
  1: Object.freeze({ factor: 0.65, label: 'reduzido' }),
  2: Object.freeze({ factor: 0.30, label: 'limitado' }),
  3: Object.freeze({ factor: 0.08, label: 'severo' }),
  4: Object.freeze({ factor: 0.00, label: 'oculto' }),
});

export const SOCIAL_DELIVERY_SURFACES = Object.freeze([
  'recommended',
  'following',
  'trending',
  'discover',
  'search',
  'public_feed',
  'notifications',
  'sitemap',
]);

export const DEFAULT_SOCIAL_DELIVERY_SURFACES = Object.freeze([...SOCIAL_DELIVERY_SURFACES]);

const RESTRICTION_REASON_CODES = new Set([
  'spam',
  'manipulation',
  'safety',
  'low_quality',
  'suspected_automation',
  'investigation',
  'other',
]);

const IMPRESSION_SURFACES = [
  ...SOCIAL_DELIVERY_SURFACES,
  'profile',
  'direct',
];

const sqlStringList = values => values.map(value => `'${String(value).replaceAll("'", "''")}'`).join(',');

export const ADMIN_SOCIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS community_delivery_restrictions (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('profile','post')),
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_post_id INTEGER REFERENCES user_posts(id) ON DELETE CASCADE,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  delivery_factor NUMERIC(5,4) NOT NULL CHECK (delivery_factor >= 0 AND delivery_factor <= 1),
  surfaces TEXT[] NOT NULL DEFAULT ARRAY['recommended','following','trending','discover','search','public_feed','notifications','sitemap']::text[],
  reason_code VARCHAR(40) NOT NULL,
  reason_detail TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','superseded')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (target_type='profile' AND target_user_id IS NOT NULL AND target_post_id IS NULL)
    OR (target_type='post' AND target_post_id IS NOT NULL AND target_user_id IS NULL)
  ),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (cardinality(surfaces) > 0)
);
CREATE INDEX IF NOT EXISTS idx_delivery_restrictions_user_active
  ON community_delivery_restrictions(target_user_id, starts_at, ends_at)
  WHERE status='active' AND target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_restrictions_post_active
  ON community_delivery_restrictions(target_post_id, starts_at, ends_at)
  WHERE status='active' AND target_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_restrictions_expiry
  ON community_delivery_restrictions(ends_at)
  WHERE status='active' AND ends_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_restrictions_one_active_user
  ON community_delivery_restrictions(target_user_id)
  WHERE status='active' AND target_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_restrictions_one_active_post
  ON community_delivery_restrictions(target_post_id)
  WHERE status='active' AND target_post_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_delivery_restriction_events (
  id BIGSERIAL PRIMARY KEY,
  restriction_id BIGINT NOT NULL REFERENCES community_delivery_restrictions(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('created','updated','expired','revoked','superseded')),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_restriction_events_history
  ON community_delivery_restriction_events(restriction_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS post_impression_daily (
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE,
  surface VARCHAR(24) NOT NULL CHECK (surface IN (${sqlStringList(IMPRESSION_SURFACES)})),
  viewer_was_follower BOOLEAN NOT NULL DEFAULT FALSE,
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  total_dwell_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_dwell_ms >= 0),
  max_reaction SMALLINT NOT NULL DEFAULT 0 CHECK (max_reaction BETWEEN 0 AND 5),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(day, user_id, post_id, surface)
);
CREATE INDEX IF NOT EXISTS idx_post_impression_daily_post_day
  ON post_impression_daily(post_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_post_impression_daily_user_day
  ON post_impression_daily(user_id, day DESC);

CREATE TABLE IF NOT EXISTS profile_view_daily (
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface VARCHAR(24) NOT NULL DEFAULT 'profile',
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(day, viewer_id, profile_user_id, surface),
  CHECK (viewer_id <> profile_user_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_view_daily_profile_day
  ON profile_view_daily(profile_user_id, day DESC);

CREATE TABLE IF NOT EXISTS social_follow_events (
  id BIGSERIAL PRIMARY KEY,
  follower_id INTEGER NOT NULL,
  following_id INTEGER NOT NULL,
  event_type VARCHAR(12) NOT NULL CHECK (event_type IN ('follow','unfollow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS idx_social_follow_events_following
  ON social_follow_events(following_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_follow_events_follower
  ON social_follow_events(follower_id, created_at DESC);

CREATE OR REPLACE FUNCTION fa_record_social_follow_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO social_follow_events(follower_id, following_id, event_type, created_at)
    VALUES(NEW.follower_id, NEW.following_id, 'follow', COALESCE(NEW.created_at, NOW()));
    RETURN NEW;
  END IF;
  INSERT INTO social_follow_events(follower_id, following_id, event_type, created_at)
  VALUES(OLD.follower_id, OLD.following_id, 'unfollow', NOW());
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_social_follow_events ON user_follows;
CREATE TRIGGER trg_social_follow_events
AFTER INSERT OR DELETE ON user_follows
FOR EACH ROW EXECUTE FUNCTION fa_record_social_follow_event();

ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(16) NOT NULL DEFAULT 'active';
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS removed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_posts ADD COLUMN IF NOT EXISTS removal_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_user_posts_moderation_status
  ON user_posts(moderation_status, created_at DESC);
`;

export const POST_IMPRESSION_DAILY_UPSERT_SQL = `
INSERT INTO post_impression_daily
  (day,user_id,post_id,surface,viewer_was_follower,view_count,total_dwell_ms,max_reaction,first_seen_at,last_seen_at)
VALUES(CURRENT_DATE,$1,$2,$3,$4,1,$5,$6,NOW(),NOW())
ON CONFLICT(day,user_id,post_id,surface) DO UPDATE SET
  viewer_was_follower = post_impression_daily.viewer_was_follower OR EXCLUDED.viewer_was_follower,
  view_count = post_impression_daily.view_count + 1,
  total_dwell_ms = post_impression_daily.total_dwell_ms + EXCLUDED.total_dwell_ms,
  max_reaction = GREATEST(post_impression_daily.max_reaction, EXCLUDED.max_reaction),
  last_seen_at = NOW()
`;

export const PROFILE_VIEW_DAILY_UPSERT_SQL = `
INSERT INTO profile_view_daily(day,viewer_id,profile_user_id,surface,view_count,first_seen_at,last_seen_at)
SELECT CURRENT_DATE,$1,$2,$3,1,NOW(),NOW()
WHERE $1::integer <> $2::integer
ON CONFLICT(day,viewer_id,profile_user_id,surface) DO UPDATE SET
  view_count = profile_view_daily.view_count + 1,
  last_seen_at = NOW()
`;

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const assertSqlIdentifier = value => {
  if (!SQL_IDENTIFIER.test(String(value))) throw new TypeError(`Identificador SQL invalido: ${value}`);
  return String(value);
};

export function deliveryFactorForLevel(level) {
  return SOCIAL_DELIVERY_LEVELS[Number(level)]?.factor ?? null;
}

export function socialDeliveryRestrictionJoinSql({
  postAlias = 'p',
  originalPostAlias = 'op',
  viewerExpression = '$1',
  evaluationExpression = 'NOW()',
  surfaceExpression = "'recommended'",
  alias = 'delivery_control',
} = {}) {
  const post = assertSqlIdentifier(postAlias);
  const original = originalPostAlias ? assertSqlIdentifier(originalPostAlias) : null;
  const joinAlias = assertSqlIdentifier(alias);
  const originalAuthor = original ? `${original}.author_id` : 'NULL::integer';
  return `LEFT JOIN LATERAL (
    SELECT MIN(r.delivery_factor)::double precision AS delivery_factor
    FROM community_delivery_restrictions r
    WHERE r.status='active'
      AND r.starts_at <= (${evaluationExpression})::timestamptz
      AND (r.ends_at IS NULL OR r.ends_at > (${evaluationExpression})::timestamptz)
      AND (${surfaceExpression})::text = ANY(r.surfaces)
      AND (
        (r.target_type='profile' AND r.target_user_id IN (${post}.author_id, ${originalAuthor}))
        OR (r.target_type='post' AND r.target_post_id IN (${post}.id,COALESCE(${post}.repost_of_id,${post}.id)))
      )
      AND (
        (${viewerExpression})::integer IS NULL
        OR ((${viewerExpression})::integer <> ${post}.author_id
          AND (${viewerExpression})::integer <> COALESCE(${originalAuthor},${post}.author_id))
      )
  ) ${joinAlias} ON TRUE`;
}

export function socialDeliveryFactorSql(alias = 'delivery_control') {
  return `COALESCE(${assertSqlIdentifier(alias)}.delivery_factor,1.0)::double precision`;
}

function parseOpaqueCursor(raw) {
  if (!raw) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return clampInt(decoded?.offset, 0, 0, 10_000_000);
  } catch {
    return 0;
  }
}

function makeOpaqueCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function observerPermissions(req) {
  const value = req.user?.observer_permissions;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function canReadPrivateActivity(req) {
  return req.user?.role !== 'observer' || observerPermissions(req).private_activity === true;
}

function canReadModeration(req) {
  return req.user?.role !== 'observer' || observerPermissions(req).moderation_private === true;
}

function socialReadGuard(req, res, next) {
  if (!canReadPrivateActivity(req)) {
    return res.status(403).json({
      error: 'Este conjunto de dados foi censurado pelo proprietario.',
      code: 'OBSERVER_SCOPE_RESTRICTED',
      scope: 'private_activity',
    });
  }
  next();
}

function moderationReadGuard(req, res, next) {
  if (!canReadPrivateActivity(req) || !canReadModeration(req)) {
    return res.status(403).json({
      error: 'Este conjunto de dados foi censurado pelo proprietario.',
      code: 'OBSERVER_SCOPE_RESTRICTED',
      scope: canReadPrivateActivity(req) ? 'moderation_private' : 'private_activity',
    });
  }
  next();
}

function periodFromRequest(req, fallbackDays = 30) {
  const days = clampInt(req.query.days, fallbackDays, 1, 366);
  const rawEnd = req.query.to ? String(req.query.to).trim() : '';
  const parsedEnd = rawEnd ? new Date(rawEnd) : null;
  // As séries diárias usam [início, fim): o limite padrão é o próximo
  // início de dia, para incluir hoje sem contar a fronteira duas vezes.
  const defaultEnd = new Date();
  defaultEnd.setHours(24, 0, 0, 0);
  let end = parsedEnd && Number.isFinite(parsedEnd.getTime()) ? parsedEnd : defaultEnd;
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) end = new Date(end.getTime() + 86400000);
  const parsedStart = req.query.from ? new Date(String(req.query.from)) : new Date(end.getTime() - days * 86400000);
  let start = Number.isFinite(parsedStart.getTime()) ? parsedStart : new Date(end.getTime() - days * 86400000);
  if (start >= end) start = new Date(end.getTime() - days * 86400000);
  const maxStart = new Date(end.getTime() - 366 * 86400000);
  if (start < maxStart) start = maxStart;
  const duration = end.getTime() - start.getTime();
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    previousStart: new Date(start.getTime() - duration).toISOString(),
  };
}

function routeError(label, res, error) {
  console.error(`[admin-social:${label}]`, error);
  const conflict = error?.code === '23505';
  res.status(conflict ? 409 : 500).json({
    error: conflict ? 'O alvo ja possui uma restricao ativa.' : 'Nao foi possivel carregar os dados sociais.',
    code: conflict ? 'ACTIVE_RESTRICTION_EXISTS' : 'ADMIN_SOCIAL_ERROR',
  });
}

async function auditSafely(auditFromReq, req, event) {
  if (typeof auditFromReq !== 'function') return;
  try {
    await auditFromReq(req, event);
  } catch (error) {
    // A falha secundária de auditoria nunca pode transformar um COMMIT válido em 500.
    console.error('[admin-social:audit]', error);
  }
}

function engagementSummary(row = {}) {
  const interactionFields = ['likes', 'comments', 'reposts', 'saves', 'poll_votes'];
  const hasDetailedInteractions = interactionFields.some(field => Object.prototype.hasOwnProperty.call(row, field));
  const interactions = hasDetailedInteractions
    ? interactionFields.reduce((total, field) => total + number(row[field]), 0)
    : number(row.interactions);
  const impressions = number(row.impressions);
  const averageDwellMs = impressions > 0 ? number(row.total_dwell_ms) / impressions : 0;
  return {
    ...row,
    interactions,
    engagement_rate: impressions > 0 ? interactions / impressions * 100 : 0,
    average_dwell_ms: averageDwellMs,
    // Compatibility aliases used by the staff console; canonical names stay available.
    avg_dwell_ms: averageDwellMs,
    ...(row.creators !== undefined ? { active_creators: number(row.creators) } : {}),
    ...(row.last_post_at !== undefined ? { last_activity_at: row.last_post_at } : {}),
  };
}

const activeRestrictionLateralSql = (
  userExpression,
  postExpression = 'NULL::integer',
  relatedUserExpression = userExpression,
  relatedPostExpression = postExpression,
) => `
LEFT JOIN LATERAL (
  SELECT r.id,r.target_type,r.level,r.delivery_factor,r.surfaces,r.reason_code,
         r.starts_at,r.ends_at,r.status
  FROM community_delivery_restrictions r
  WHERE r.status='active' AND r.starts_at<=NOW() AND (r.ends_at IS NULL OR r.ends_at>NOW())
    AND ((r.target_type='profile' AND r.target_user_id IN (${userExpression},${relatedUserExpression}))
      OR (r.target_type='post' AND r.target_post_id IN (${postExpression},${relatedPostExpression})))
  ORDER BY r.delivery_factor ASC,r.created_at DESC
  LIMIT 1
) restriction ON TRUE`;

export function registerAdminSocialRoutes(app, pool, auth, requireAdmin, requireOwner, auditFromReq) {
  if (!app || !pool || !auth || !requireAdmin || !requireOwner) {
    throw new TypeError('registerAdminSocialRoutes requer app, pool, auth, requireAdmin e requireOwner.');
  }

  app.get('/api/admin/community/overview', auth, requireAdmin, socialReadGuard, async (req, res) => {
    const period = periodFromRequest(req);
    try {
      const [summaryResult, dailyResult, topPostsResult, restrictionsResult] = await Promise.all([
        pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM users WHERE merged_into_user_id IS NULL) AS accounts,
            (SELECT COUNT(DISTINCT author_id)::int FROM user_posts
              WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NULL
                AND COALESCE(moderation_status,'active')='active') AS creators,
            (SELECT COUNT(*)::int FROM user_posts
              WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NULL
                AND COALESCE(moderation_status,'active')='active') AS posts,
            (SELECT COUNT(*)::int FROM user_posts
              WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NOT NULL
                AND COALESCE(moderation_status,'active')='active') AS reposts,
            (SELECT COUNT(*)::int FROM post_likes WHERE created_at >= $1 AND created_at < $2) AS likes,
            (SELECT COUNT(*)::int FROM post_comments
              WHERE created_at >= $1 AND created_at < $2 AND is_deleted=FALSE) AS comments,
            (SELECT COUNT(*)::int FROM post_saves WHERE created_at >= $1 AND created_at < $2) AS saves,
            (SELECT COUNT(*)::int FROM post_poll_votes WHERE created_at >= $1 AND created_at < $2) AS poll_votes,
            (SELECT COALESCE(SUM(view_count),0)::bigint FROM post_impression_daily
              WHERE day >= $1::date AND day < $2::date) AS impressions,
            (SELECT COUNT(DISTINCT user_id)::int FROM post_impression_daily
              WHERE day >= $1::date AND day < $2::date) AS unique_viewers,
            (SELECT COALESCE(SUM(total_dwell_ms),0)::bigint FROM post_impression_daily
              WHERE day >= $1::date AND day < $2::date) AS total_dwell_ms,
            (SELECT COUNT(*)::int FROM user_follows) AS follower_connections,
            (SELECT COUNT(*)::int FROM social_follow_events
              WHERE event_type='follow' AND created_at >= $1 AND created_at < $2) AS follows,
            (SELECT COUNT(*)::int FROM social_follow_events
              WHERE event_type='unfollow' AND created_at >= $1 AND created_at < $2) AS unfollows,
            (SELECT COUNT(*)::int FROM content_reports WHERE status='pending') AS pending_reports,
            (SELECT COUNT(*)::int FROM community_delivery_restrictions
              WHERE status='active' AND starts_at<=NOW() AND (ends_at IS NULL OR ends_at>NOW())) AS active_restrictions
        `, [period.start, period.end]),
        pool.query(`
          WITH days AS (
            SELECT generate_series($1::date,$2::date - 1,INTERVAL '1 day')::date AS day
          ),
          post_daily AS (
            SELECT created_at::date AS day,
              COUNT(*) FILTER (WHERE repost_of_id IS NULL)::int AS posts,
              COUNT(*) FILTER (WHERE repost_of_id IS NOT NULL)::int AS reposts,
              COUNT(DISTINCT author_id)::int AS creators
            FROM user_posts
            WHERE created_at >= $1 AND created_at < $2 AND COALESCE(moderation_status,'active')='active'
            GROUP BY 1
          ),
          interaction_daily AS (
            SELECT day,SUM(likes)::int AS likes,SUM(comments)::int AS comments,
              SUM(saves)::int AS saves,SUM(votes)::int AS poll_votes
            FROM (
              SELECT created_at::date AS day,COUNT(*) AS likes,0 AS comments,0 AS saves,0 AS votes
                FROM post_likes WHERE created_at >= $1 AND created_at < $2 GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,COUNT(*),0,0 FROM post_comments
                WHERE created_at >= $1 AND created_at < $2 AND is_deleted=FALSE GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,0,COUNT(*),0 FROM post_saves
                WHERE created_at >= $1 AND created_at < $2 GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,0,0,COUNT(*) FROM post_poll_votes
                WHERE created_at >= $1 AND created_at < $2 GROUP BY 1
            ) events GROUP BY day
          ),
          impression_daily AS (
            SELECT day,SUM(view_count)::bigint AS impressions,COUNT(DISTINCT user_id)::int AS viewers,
              SUM(total_dwell_ms)::bigint AS dwell_ms
            FROM post_impression_daily WHERE day >= $1::date AND day < $2::date GROUP BY day
          )
          SELECT d.day,
            COALESCE(p.posts,0)::int AS posts,COALESCE(p.reposts,0)::int AS reposts,
            COALESCE(p.creators,0)::int AS creators,
            COALESCE(i.likes,0)::int AS likes,COALESCE(i.comments,0)::int AS comments,
            COALESCE(i.saves,0)::int AS saves,COALESCE(i.poll_votes,0)::int AS poll_votes,
            COALESCE(v.impressions,0)::bigint AS impressions,COALESCE(v.viewers,0)::int AS viewers,
            COALESCE(v.dwell_ms,0)::bigint AS total_dwell_ms
          FROM days d
          LEFT JOIN post_daily p USING(day)
          LEFT JOIN interaction_daily i USING(day)
          LEFT JOIN impression_daily v USING(day)
          ORDER BY d.day
        `, [period.start, period.end]),
        pool.query(`
          WITH impressions AS (
            SELECT post_id,SUM(view_count)::bigint AS impressions,COUNT(DISTINCT user_id)::int AS viewers,
              SUM(total_dwell_ms)::bigint AS total_dwell_ms
            FROM post_impression_daily WHERE day >= $1::date AND day < $2::date GROUP BY post_id
          ), likes AS (
            SELECT post_id,COUNT(*)::int AS likes FROM post_likes
            WHERE created_at >= $1 AND created_at < $2 GROUP BY post_id
          ), comments AS (
            SELECT post_id,COUNT(*)::int AS comments FROM post_comments
            WHERE created_at >= $1 AND created_at < $2 AND is_deleted=FALSE GROUP BY post_id
          ), reposts AS (
            SELECT repost_of_id AS post_id,COUNT(*)::int AS reposts FROM user_posts
            WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NOT NULL GROUP BY repost_of_id
          ), saves AS (
            SELECT post_id,COUNT(*)::int AS saves FROM post_saves
            WHERE created_at >= $1 AND created_at < $2 GROUP BY post_id
          )
          SELECT p.id,p.author_id,p.content,p.media_urls,p.created_at,p.is_pinned,
            u.username,u.minecraft_name,COALESCE(up.display_name,'') AS display_name,
            COALESCE(up.avatar_url,'') AS avatar_url,
            COALESCE(i.impressions,0)::bigint AS impressions,COALESCE(i.viewers,0)::int AS unique_viewers,
            COALESCE(i.total_dwell_ms,0)::bigint AS total_dwell_ms,
            COALESCE(l.likes,0)::int AS likes,COALESCE(c.comments,0)::int AS comments,
            COALESCE(r.reposts,0)::int AS reposts,COALESCE(s.saves,0)::int AS saves,
            (COALESCE(l.likes,0)+COALESCE(c.comments,0)+COALESCE(r.reposts,0)+COALESCE(s.saves,0))::int AS interactions
          FROM user_posts p
          JOIN users u ON u.id=p.author_id
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN impressions i ON i.post_id=p.id
          LEFT JOIN likes l ON l.post_id=p.id
          LEFT JOIN comments c ON c.post_id=p.id
          LEFT JOIN reposts r ON r.post_id=p.id
          LEFT JOIN saves s ON s.post_id=p.id
          WHERE p.repost_of_id IS NULL AND COALESCE(p.moderation_status,'active')='active'
            AND (i.post_id IS NOT NULL OR l.post_id IS NOT NULL OR c.post_id IS NOT NULL OR r.post_id IS NOT NULL OR s.post_id IS NOT NULL)
          ORDER BY interactions DESC,impressions DESC,p.id DESC
          LIMIT 10
        `, [period.start, period.end]),
        pool.query(`
          SELECT r.id,r.target_type,r.target_user_id,r.target_post_id,r.level,
            r.delivery_factor,r.surfaces,r.reason_code,r.starts_at,r.ends_at,r.created_at,
            COALESCE(u.username,pu.username) AS target_username,
            COALESCE(u.minecraft_name,pu.minecraft_name) AS target_minecraft_name
          FROM community_delivery_restrictions r
          LEFT JOIN users u ON u.id=r.target_user_id
          LEFT JOIN user_posts p ON p.id=r.target_post_id
          LEFT JOIN users pu ON pu.id=p.author_id
          WHERE r.status='active' AND r.starts_at<=NOW() AND (r.ends_at IS NULL OR r.ends_at>NOW())
          ORDER BY r.delivery_factor ASC,r.created_at DESC
          LIMIT 20
        `),
      ]);

      const summary = engagementSummary(summaryResult.rows[0] || {});
      if (!canReadModeration(req)) {
        summary.pending_reports = null;
        summary.reports = null;
        summary.active_restrictions = null;
        summary.moderation_censored = true;
      } else {
        summary.reports = summary.pending_reports;
      }
      res.json({
        summary,
        daily: dailyResult.rows.map(engagementSummary),
        top_posts: topPostsResult.rows.map(engagementSummary),
        active_restrictions: canReadModeration(req) ? restrictionsResult.rows : [],
        moderation_censored: !canReadModeration(req),
      });
    } catch (error) {
      routeError('overview', res, error);
    }
  });

  app.get('/api/admin/community/accounts', auth, requireAdmin, socialReadGuard, async (req, res) => {
    const period = periodFromRequest(req);
    const limit = clampInt(req.query.limit, 30, 1, 100);
    const offset = parseOpaqueCursor(req.query.cursor);
    const params = [period.start, period.end];
    const conditions = ['a.merged_into_user_id IS NULL'];
    const q = cleanText(req.query.q, 80).toLowerCase();
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(LOWER(COALESCE(a.username,'')) LIKE $${params.length}
        OR LOWER(COALESCE(a.minecraft_name,'')) LIKE $${params.length}
        OR LOWER(COALESCE(a.display_name,'')) LIKE $${params.length})`);
    }
    const role = cleanText(req.query.role, 20).toLowerCase();
    if (['owner', 'full', 'observer', 'limited'].includes(role)) {
      params.push(role);
      conditions.push(`a.role=$${params.length}`);
    }
    const status = cleanText(req.query.status, 20).toLowerCase();
    if (!canReadModeration(req) && ['normal', 'restricted', 'reported'].includes(status)) {
      return res.status(403).json({ error: 'Este filtro exige acesso a moderacao.', code: 'OBSERVER_SCOPE_RESTRICTED', scope: 'moderation_private' });
    }
    if (status === 'restricted') conditions.push('a.restriction_id IS NOT NULL');
    if (status === 'normal') conditions.push('a.restriction_id IS NULL');
    if (status === 'reported') conditions.push('a.pending_reports > 0');
    if (status === 'creator') conditions.push('a.posts > 0');
    if (status === 'inactive') conditions.push('(a.last_post_at IS NULL OR a.last_post_at < $1::timestamptz)');
    const order = ({
      reach: 'a.impressions DESC,a.id DESC',
      engagement: 'a.interactions DESC,a.id DESC',
      followers: 'a.followers DESC,a.id DESC',
      posts: 'a.posts DESC,a.id DESC',
      newest: 'a.created_at DESC,a.id DESC',
      activity: 'a.last_post_at DESC NULLS LAST,a.id DESC',
      recent: 'a.last_post_at DESC NULLS LAST,a.id DESC',
    })[cleanText(req.query.sort, 20)] || 'a.impressions DESC,a.id DESC';
    params.push(limit + 1, offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    try {
      const { rows } = await pool.query(`
        WITH account_rows AS (
          SELECT u.id,u.username,u.minecraft_name,u.role,u.is_verified,u.is_platform_verified,u.created_at,
            u.merged_into_user_id,COALESCE(up.display_name,'') AS display_name,
            COALESCE(up.avatar_url,'') AS avatar_url,u.photo_url,
            COALESCE(pm.posts,0)::int AS posts,COALESCE(pm.reposts_authored,0)::int AS reposts_authored,
            pm.last_post_at,COALESCE(pm.interactions,0)::int AS interactions,
            COALESCE(im.impressions,0)::bigint AS impressions,COALESCE(im.unique_viewers,0)::int AS unique_viewers,
            COALESCE(im.total_dwell_ms,0)::bigint AS total_dwell_ms,
            COALESCE(f.followers,0)::int AS followers,COALESCE(f.following,0)::int AS following,
            COALESCE(reports.pending_reports,0)::int AS pending_reports,
            restriction.id AS restriction_id,restriction.level AS restriction_level,
            restriction.delivery_factor,restriction.ends_at AS restriction_ends_at
          FROM users u
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE p.repost_of_id IS NULL)::int AS posts,
              COUNT(*) FILTER (WHERE p.repost_of_id IS NOT NULL)::int AS reposts_authored,
              MAX(p.created_at) AS last_post_at,
              (SELECT COUNT(*) FROM post_likes l JOIN user_posts own ON own.id=l.post_id
                WHERE own.author_id=u.id AND l.created_at >= $1 AND l.created_at < $2)
              + (SELECT COUNT(*) FROM post_comments c JOIN user_posts own ON own.id=c.post_id
                WHERE own.author_id=u.id AND c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted=FALSE)
              + (SELECT COUNT(*) FROM post_saves s JOIN user_posts own ON own.id=s.post_id
                WHERE own.author_id=u.id AND s.created_at >= $1 AND s.created_at < $2)
              + (SELECT COUNT(*) FROM user_posts repost JOIN user_posts own ON own.id=repost.repost_of_id
                WHERE own.author_id=u.id AND repost.created_at >= $1 AND repost.created_at < $2)
              + (SELECT COUNT(*) FROM post_poll_votes vote
                  JOIN post_polls poll ON poll.id=vote.poll_id
                  JOIN user_posts own ON own.id=poll.post_id
                WHERE own.author_id=u.id AND vote.created_at >= $1 AND vote.created_at < $2) AS interactions
            FROM user_posts p
            WHERE p.author_id=u.id AND p.created_at >= $1 AND p.created_at < $2
              AND COALESCE(p.moderation_status,'active')='active'
          ) pm ON TRUE
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(d.view_count),0)::bigint AS impressions,
              COUNT(DISTINCT d.user_id)::int AS unique_viewers,
              COALESCE(SUM(d.total_dwell_ms),0)::bigint AS total_dwell_ms
            FROM post_impression_daily d JOIN user_posts p ON p.id=d.post_id
            WHERE p.author_id=u.id AND d.day >= $1::date AND d.day < $2::date
          ) im ON TRUE
          LEFT JOIN LATERAL (
            SELECT (SELECT COUNT(*) FROM user_follows x WHERE x.following_id=u.id)::int AS followers,
              (SELECT COUNT(*) FROM user_follows x WHERE x.follower_id=u.id)::int AS following
          ) f ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS pending_reports FROM content_reports cr
            WHERE cr.status='pending' AND (
              (cr.content_type='user' AND cr.content_id=u.id)
              OR (cr.content_type='post' AND EXISTS(SELECT 1 FROM user_posts p WHERE p.id=cr.content_id AND p.author_id=u.id))
            )
          ) reports ON TRUE
          ${activeRestrictionLateralSql('u.id')}
        )
        SELECT * FROM account_rows a
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${order}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `, params);
      const items = rows.slice(0, limit).map(row => {
        if (!canReadModeration(req)) {
          row.pending_reports = null;
          row.restriction_id = null;
          row.restriction_level = null;
          row.delivery_factor = null;
          row.restriction_ends_at = null;
          row.moderation_censored = true;
        }
        return engagementSummary(row);
      });
      res.json({ items, next_cursor: rows.length > limit ? makeOpaqueCursor(offset + limit) : null });
    } catch (error) {
      routeError('accounts', res, error);
    }
  });

  const accountDetailHandler = async (req, res) => {
    const accountId = Number.parseInt(req.params.id, 10);
    if (!accountId) return res.status(400).json({ error: 'Conta invalida.', code: 'INVALID_ACCOUNT_ID' });
    const period = periodFromRequest(req);
    const moderationVisible = canReadModeration(req);

    const summarySql = `
      SELECT
        (SELECT COUNT(*)::int FROM user_posts p WHERE p.author_id=$1 AND p.created_at >= $2 AND p.created_at < $3
          AND p.repost_of_id IS NULL AND COALESCE(p.moderation_status,'active')='active') AS posts,
        (SELECT COUNT(*)::int FROM user_posts p WHERE p.author_id=$1 AND p.created_at >= $2 AND p.created_at < $3
          AND p.repost_of_id IS NOT NULL AND COALESCE(p.moderation_status,'active')='active') AS reposts_authored,
        (SELECT COUNT(*)::int FROM post_comments WHERE author_id=$1 AND created_at >= $2 AND created_at < $3 AND is_deleted=FALSE) AS comments_authored,
        (SELECT COUNT(*)::int FROM post_likes WHERE user_id=$1 AND created_at >= $2 AND created_at < $3) AS likes_given,
        (SELECT COUNT(*)::int FROM post_saves WHERE user_id=$1 AND created_at >= $2 AND created_at < $3) AS saves_given,
        (SELECT COUNT(*)::int FROM post_likes l JOIN user_posts p ON p.id=l.post_id
          WHERE p.author_id=$1 AND l.created_at >= $2 AND l.created_at < $3) AS likes,
        (SELECT COUNT(*)::int FROM post_comments c JOIN user_posts p ON p.id=c.post_id
          WHERE p.author_id=$1 AND c.created_at >= $2 AND c.created_at < $3 AND c.is_deleted=FALSE) AS comments,
        (SELECT COUNT(*)::int FROM user_posts r JOIN user_posts p ON p.id=r.repost_of_id
          WHERE p.author_id=$1 AND r.created_at >= $2 AND r.created_at < $3) AS reposts,
        (SELECT COUNT(*)::int FROM post_saves s JOIN user_posts p ON p.id=s.post_id
          WHERE p.author_id=$1 AND s.created_at >= $2 AND s.created_at < $3) AS saves,
        (SELECT COUNT(*)::int FROM post_poll_votes v JOIN post_polls pp ON pp.id=v.poll_id JOIN user_posts p ON p.id=pp.post_id
          WHERE p.author_id=$1 AND v.created_at >= $2 AND v.created_at < $3) AS poll_votes,
        (SELECT COALESCE(SUM(d.view_count),0)::bigint FROM post_impression_daily d JOIN user_posts p ON p.id=d.post_id
          WHERE p.author_id=$1 AND d.day >= $2::date AND d.day < $3::date) AS impressions,
        (SELECT COUNT(DISTINCT d.user_id)::int FROM post_impression_daily d JOIN user_posts p ON p.id=d.post_id
          WHERE p.author_id=$1 AND d.day >= $2::date AND d.day < $3::date) AS unique_viewers,
        (SELECT COALESCE(SUM(d.total_dwell_ms),0)::bigint FROM post_impression_daily d JOIN user_posts p ON p.id=d.post_id
          WHERE p.author_id=$1 AND d.day >= $2::date AND d.day < $3::date) AS total_dwell_ms,
        (SELECT COALESCE(SUM(view_count),0)::bigint FROM profile_view_daily
          WHERE profile_user_id=$1 AND day >= $2::date AND day < $3::date) AS profile_views,
        (SELECT COUNT(DISTINCT viewer_id)::int FROM profile_view_daily
          WHERE profile_user_id=$1 AND day >= $2::date AND day < $3::date) AS unique_profile_viewers,
        (SELECT COUNT(*)::int FROM user_follows WHERE following_id=$1) AS followers,
        (SELECT COUNT(*)::int FROM user_follows WHERE follower_id=$1) AS following,
        (SELECT COUNT(*)::int FROM social_follow_events WHERE following_id=$1 AND event_type='follow' AND created_at >= $2 AND created_at < $3) AS follows,
        (SELECT COUNT(*)::int FROM social_follow_events WHERE following_id=$1 AND event_type='unfollow' AND created_at >= $2 AND created_at < $3) AS unfollows,
        (SELECT COUNT(*)::int FROM content_reports cr WHERE cr.status='pending' AND (
          (cr.content_type='user' AND cr.content_id=$1)
          OR (cr.content_type='post' AND EXISTS(SELECT 1 FROM user_posts p WHERE p.id=cr.content_id AND p.author_id=$1))
        )) AS pending_reports
    `;

    try {
      const [accountResult, currentResult, previousResult, dailyResult, postsResult] = await Promise.all([
        pool.query(`
          SELECT u.id,u.username,u.minecraft_name,u.role,u.is_verified,u.is_platform_verified,u.created_at,
            COALESCE(up.display_name,'') AS display_name,COALESCE(up.bio,'') AS bio,
            COALESCE(up.avatar_url,'') AS avatar_url,COALESCE(up.cover_url,'') AS cover_url,
            u.photo_url,COALESCE(up.public_profile,TRUE) AS public_profile,
            restriction.id AS restriction_id,restriction.level AS restriction_level,
            restriction.delivery_factor,restriction.surfaces AS restriction_surfaces,
            restriction.reason_code AS restriction_reason_code,
            restriction.starts_at AS restriction_starts_at,restriction.ends_at AS restriction_ends_at
          FROM users u
          LEFT JOIN user_preferences up ON up.user_id=u.id
          ${activeRestrictionLateralSql('u.id')}
          WHERE u.id=$1 AND u.merged_into_user_id IS NULL
          LIMIT 1
        `, [accountId]),
        pool.query(summarySql, [accountId, period.start, period.end]),
        pool.query(summarySql, [accountId, period.previousStart, period.start]),
        pool.query(`
          WITH days AS (SELECT generate_series($2::date,$3::date - 1,INTERVAL '1 day')::date AS day),
          post_stats AS (
            SELECT p.created_at::date AS day,COUNT(*) FILTER (WHERE p.repost_of_id IS NULL)::int AS posts,
              COUNT(*) FILTER (WHERE p.repost_of_id IS NOT NULL)::int AS reposts_authored
            FROM user_posts p WHERE p.author_id=$1 AND p.created_at >= $2 AND p.created_at < $3
              AND COALESCE(p.moderation_status,'active')='active' GROUP BY 1
          ),
          impression_stats AS (
            SELECT d.day,SUM(d.view_count)::bigint AS impressions,COUNT(DISTINCT d.user_id)::int AS viewers,
              SUM(d.total_dwell_ms)::bigint AS total_dwell_ms
            FROM post_impression_daily d JOIN user_posts p ON p.id=d.post_id
            WHERE p.author_id=$1 AND d.day >= $2::date AND d.day < $3::date GROUP BY d.day
          ),
          interaction_stats AS (
            SELECT day,SUM(likes)::int AS likes,SUM(comments)::int AS comments,
              SUM(reposts)::int AS reposts,SUM(saves)::int AS saves
            FROM (
              SELECT l.created_at::date AS day,COUNT(*) AS likes,0 AS comments,0 AS reposts,0 AS saves
                FROM post_likes l JOIN user_posts p ON p.id=l.post_id
                WHERE p.author_id=$1 AND l.created_at >= $2 AND l.created_at < $3 GROUP BY 1
              UNION ALL
              SELECT c.created_at::date,0,COUNT(*),0,0 FROM post_comments c JOIN user_posts p ON p.id=c.post_id
                WHERE p.author_id=$1 AND c.created_at >= $2 AND c.created_at < $3 AND c.is_deleted=FALSE GROUP BY 1
              UNION ALL
              SELECT r.created_at::date,0,0,COUNT(*),0 FROM user_posts r JOIN user_posts p ON p.id=r.repost_of_id
                WHERE p.author_id=$1 AND r.created_at >= $2 AND r.created_at < $3 GROUP BY 1
              UNION ALL
              SELECT s.created_at::date,0,0,0,COUNT(*) FROM post_saves s JOIN user_posts p ON p.id=s.post_id
                WHERE p.author_id=$1 AND s.created_at >= $2 AND s.created_at < $3 GROUP BY 1
            ) x GROUP BY day
          ), profile_stats AS (
            SELECT day,SUM(view_count)::bigint AS profile_views FROM profile_view_daily
            WHERE profile_user_id=$1 AND day >= $2::date AND day < $3::date GROUP BY day
          )
          SELECT d.day,COALESCE(p.posts,0)::int AS posts,COALESCE(p.reposts_authored,0)::int AS reposts_authored,
            COALESCE(i.impressions,0)::bigint AS impressions,COALESCE(i.viewers,0)::int AS unique_viewers,
            COALESCE(i.total_dwell_ms,0)::bigint AS total_dwell_ms,
            COALESCE(x.likes,0)::int AS likes,COALESCE(x.comments,0)::int AS comments,
            COALESCE(x.reposts,0)::int AS reposts,COALESCE(x.saves,0)::int AS saves,0::int AS poll_votes,
            COALESCE(v.profile_views,0)::bigint AS profile_views
          FROM days d LEFT JOIN post_stats p USING(day) LEFT JOIN impression_stats i USING(day)
          LEFT JOIN interaction_stats x USING(day) LEFT JOIN profile_stats v USING(day)
          ORDER BY d.day
        `, [accountId, period.start, period.end]),
        pool.query(`
          SELECT p.id,p.content,p.media_urls,p.created_at,p.updated_at,p.edit_count,p.is_pinned,
            p.moderation_status,
            COALESCE(im.impressions,0)::bigint AS impressions,COALESCE(im.unique_viewers,0)::int AS unique_viewers,
            COALESCE(im.total_dwell_ms,0)::bigint AS total_dwell_ms,
            (SELECT COUNT(*)::int FROM post_likes l WHERE l.post_id=p.id AND l.created_at >= $2 AND l.created_at < $3) AS likes,
            (SELECT COUNT(*)::int FROM post_comments c WHERE c.post_id=p.id AND c.created_at >= $2 AND c.created_at < $3 AND c.is_deleted=FALSE) AS comments,
            (SELECT COUNT(*)::int FROM user_posts r WHERE r.repost_of_id=p.id AND r.created_at >= $2 AND r.created_at < $3) AS reposts,
            (SELECT COUNT(*)::int FROM post_saves s WHERE s.post_id=p.id AND s.created_at >= $2 AND s.created_at < $3) AS saves,
            restriction.id AS restriction_id,restriction.level AS restriction_level,
            restriction.delivery_factor,restriction.ends_at AS restriction_ends_at
          FROM user_posts p
          LEFT JOIN LATERAL (
            SELECT SUM(d.view_count)::bigint AS impressions,COUNT(DISTINCT d.user_id)::int AS unique_viewers,
              SUM(d.total_dwell_ms)::bigint AS total_dwell_ms
            FROM post_impression_daily d WHERE d.post_id=p.id AND d.day >= $2::date AND d.day < $3::date
          ) im ON TRUE
          ${activeRestrictionLateralSql('p.author_id', 'p.id')}
          WHERE p.author_id=$1 AND p.repost_of_id IS NULL
            AND ($4::boolean OR COALESCE(p.moderation_status,'active')='active')
          ORDER BY impressions DESC,p.id DESC
          LIMIT 20
        `, [accountId, period.start, period.end, moderationVisible]),
      ]);

      if (!accountResult.rows.length) return res.status(404).json({ error: 'Conta nao encontrada.', code: 'ACCOUNT_NOT_FOUND' });
      const account = accountResult.rows[0];
      const summary = engagementSummary(currentResult.rows[0] || {});
      summary.previous = engagementSummary(previousResult.rows[0] || {});
      summary.followers_gained = summary.follows;
      summary.reports = summary.pending_reports;
      summary.previous.followers_gained = summary.previous.follows;
      summary.previous.reports = summary.previous.pending_reports;
      if (!moderationVisible) {
        for (const key of ['restriction_id', 'restriction_level', 'delivery_factor', 'restriction_surfaces', 'restriction_reason_code', 'restriction_starts_at', 'restriction_ends_at']) account[key] = null;
        account.moderation_censored = true;
        summary.pending_reports = null;
        summary.reports = null;
        summary.moderation_censored = true;
        summary.previous.pending_reports = null;
        summary.previous.reports = null;
        summary.previous.moderation_censored = true;
      }
      const posts = postsResult.rows.map(row => {
        if (!moderationVisible) {
          row.restriction_id = null;
          row.restriction_level = null;
          row.delivery_factor = null;
          row.restriction_ends_at = null;
          row.moderation_censored = true;
        }
        return engagementSummary({ ...row, poll_votes: 0 });
      });
      res.json({ account, summary, daily: dailyResult.rows.map(engagementSummary), posts });
    } catch (error) {
      routeError('account-detail', res, error);
    }
  };
  app.get('/api/admin/community/accounts/:id', auth, requireAdmin, socialReadGuard, accountDetailHandler);
  app.get('/api/admin/community/accounts/:id/analytics', auth, requireAdmin, socialReadGuard, accountDetailHandler);

  app.get('/api/admin/community/posts', auth, requireAdmin, socialReadGuard, async (req, res) => {
    const period = periodFromRequest(req);
    const limit = clampInt(req.query.limit, 30, 1, 100);
    const offset = parseOpaqueCursor(req.query.cursor);
    const params = [period.start, period.end];
    const conditions = [];
    const q = cleanText(req.query.q, 120).toLowerCase();
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(LOWER(COALESCE(x.content,'')) LIKE $${params.length}
        OR LOWER(COALESCE(x.username,'')) LIKE $${params.length}
        OR LOWER(COALESCE(x.minecraft_name,'')) LIKE $${params.length}
        OR LOWER(COALESCE(x.display_name,'')) LIKE $${params.length})`);
    }
    const authorId = Number.parseInt(req.query.author_id, 10);
    if (authorId) {
      params.push(authorId);
      conditions.push(`x.author_id=$${params.length}`);
    }
    const format = cleanText(req.query.format, 20).toLowerCase();
    if (format === 'repost') conditions.push('x.repost_of_id IS NOT NULL');
    if (format === 'poll') conditions.push('x.has_poll=TRUE');
    if (format === 'media') conditions.push('x.has_media=TRUE');
    if (format === 'text') conditions.push('x.repost_of_id IS NULL AND x.has_poll=FALSE AND x.has_media=FALSE');
    const status = cleanText(req.query.status, 20).toLowerCase();
    if (!canReadModeration(req) && ['normal', 'restricted', 'reported', 'removed'].includes(status)) {
      return res.status(403).json({ error: 'Este filtro exige acesso a moderacao.', code: 'OBSERVER_SCOPE_RESTRICTED', scope: 'moderation_private' });
    }
    if (status === 'restricted') conditions.push('x.restriction_id IS NOT NULL');
    if (status === 'normal') conditions.push("x.restriction_id IS NULL AND x.moderation_status='active'");
    if (status === 'reported') conditions.push('x.pending_reports > 0');
    if (status === 'pinned') conditions.push('x.is_pinned=TRUE');
    if (status === 'removed') conditions.push("x.moderation_status='removed'");
    if (status === 'active') conditions.push("x.moderation_status='active'");
    const minImpressions = clampInt(req.query.min_impressions, 0, 0, 1_000_000_000);
    if (minImpressions > 0) {
      params.push(minImpressions);
      conditions.push(`x.impressions >= $${params.length}`);
    }
    const minInteractions = clampInt(req.query.min_interactions, 0, 0, 1_000_000_000);
    if (minInteractions > 0) {
      params.push(minInteractions);
      conditions.push(`x.interactions >= $${params.length}`);
    }
    const requestedSort = cleanText(req.query.sort, 20);
    if (!canReadModeration(req) && requestedSort === 'reports') {
      return res.status(403).json({ error: 'Esta ordenacao exige acesso a moderacao.', code: 'OBSERVER_SCOPE_RESTRICTED', scope: 'moderation_private' });
    }
    const order = ({
      reach: 'x.impressions DESC,x.id DESC',
      engagement: 'x.interactions DESC,x.id DESC',
      reports: 'x.pending_reports DESC,x.id DESC',
      oldest: 'x.created_at ASC,x.id ASC',
      newest: 'x.created_at DESC,x.id DESC',
      recent: 'x.created_at DESC,x.id DESC',
    })[requestedSort] || 'x.created_at DESC,x.id DESC';
    if (!canReadModeration(req)) conditions.push("x.moderation_status='active' AND x.original_moderation_status='active'");
    params.push(limit + 1, offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;
    const outerWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const { rows } = await pool.query(`
        WITH post_rows AS (
          SELECT p.id,p.author_id,p.created_by_user_id,p.repost_of_id,p.content,p.media_urls,
            p.created_at,p.updated_at,p.edit_count,p.is_pinned,p.pinned_at,
            COALESCE(p.moderation_status,'active') AS moderation_status,
            COALESCE(original.moderation_status,'active') AS original_moderation_status,
            p.removed_at,p.removal_reason,
            u.username,u.minecraft_name,COALESCE(up.display_name,'') AS display_name,
            COALESCE(up.avatar_url,'') AS avatar_url,u.photo_url,
            array_length(p.media_urls,1)>0 AS has_media,
            EXISTS(SELECT 1 FROM post_polls pp WHERE pp.post_id=COALESCE(p.repost_of_id,p.id)) AS has_poll,
            COALESCE(im.impressions,0)::bigint AS impressions,COALESCE(im.unique_viewers,0)::int AS unique_viewers,
            COALESCE(im.total_dwell_ms,0)::bigint AS total_dwell_ms,
            COALESCE(metrics.likes,0)::int AS likes,COALESCE(metrics.comments,0)::int AS comments,
            COALESCE(metrics.reposts,0)::int AS reposts,COALESCE(metrics.saves,0)::int AS saves,
            COALESCE(metrics.poll_votes,0)::int AS poll_votes,
            (COALESCE(metrics.likes,0)+COALESCE(metrics.comments,0)+COALESCE(metrics.reposts,0)
              +COALESCE(metrics.saves,0)+COALESCE(metrics.poll_votes,0))::int AS interactions,
            COALESCE(reports.pending_reports,0)::int AS pending_reports,
            restriction.id AS restriction_id,restriction.target_type AS restriction_target_type,
            restriction.level AS restriction_level,restriction.delivery_factor,
            restriction.surfaces AS restriction_surfaces,restriction.ends_at AS restriction_ends_at
          FROM user_posts p
          JOIN users u ON u.id=p.author_id
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN user_posts original ON original.id=p.repost_of_id
          LEFT JOIN LATERAL (
            SELECT SUM(d.view_count)::bigint AS impressions,COUNT(DISTINCT d.user_id)::int AS unique_viewers,
              SUM(d.total_dwell_ms)::bigint AS total_dwell_ms
            FROM post_impression_daily d
            WHERE d.post_id=COALESCE(p.repost_of_id,p.id) AND d.day >= $1::date AND d.day < $2::date
          ) im ON TRUE
          LEFT JOIN LATERAL (
            SELECT
              (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=COALESCE(p.repost_of_id,p.id) AND l.created_at >= $1 AND l.created_at < $2)::int AS likes,
              (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=COALESCE(p.repost_of_id,p.id) AND c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted=FALSE)::int AS comments,
              (SELECT COUNT(*) FROM user_posts r WHERE r.repost_of_id=COALESCE(p.repost_of_id,p.id) AND r.created_at >= $1 AND r.created_at < $2)::int AS reposts,
              (SELECT COUNT(*) FROM post_saves s WHERE s.post_id=COALESCE(p.repost_of_id,p.id) AND s.created_at >= $1 AND s.created_at < $2)::int AS saves,
              (SELECT COUNT(*) FROM post_poll_votes v JOIN post_polls pp ON pp.id=v.poll_id
                WHERE pp.post_id=COALESCE(p.repost_of_id,p.id) AND v.created_at >= $1 AND v.created_at < $2)::int AS poll_votes
          ) metrics ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS pending_reports FROM content_reports cr
            WHERE cr.content_type='post' AND cr.content_id=COALESCE(p.repost_of_id,p.id) AND cr.status='pending'
          ) reports ON TRUE
          ${activeRestrictionLateralSql('p.author_id', 'p.id', 'COALESCE(original.author_id,p.author_id)', 'COALESCE(p.repost_of_id,p.id)')}
          WHERE p.created_at >= $1 AND p.created_at < $2
        )
        SELECT * FROM post_rows x ${outerWhere}
        ORDER BY ${order}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `, params);
      const moderationVisible = canReadModeration(req);
      const items = rows.slice(0, limit).map(row => {
        delete row.original_moderation_status;
        if (!moderationVisible) {
          row.pending_reports = null;
          for (const key of ['restriction_id', 'restriction_target_type', 'restriction_level', 'delivery_factor', 'restriction_surfaces', 'restriction_ends_at']) row[key] = null;
          row.removal_reason = null;
          row.moderation_censored = true;
        }
        return engagementSummary(row);
      });
      res.json({ items, next_cursor: rows.length > limit ? makeOpaqueCursor(offset + limit) : null });
    } catch (error) {
      routeError('posts', res, error);
    }
  });

  app.get('/api/admin/community/posts/:id', auth, requireAdmin, socialReadGuard, async (req, res) => {
    const postId = Number.parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ error: 'Publicacao invalida.', code: 'INVALID_POST_ID' });
    const period = periodFromRequest(req);
    const moderationVisible = canReadModeration(req);
    try {
      const [postResult, metricsResult, dailyResult, reportsResult, restrictionResult] = await Promise.all([
        pool.query(`
          SELECT p.id,p.author_id,p.created_by_user_id,p.repost_of_id,p.content,p.media_urls,
            p.created_at,p.updated_at,p.edit_count,p.is_pinned,p.pinned_at,
            COALESCE(p.moderation_status,'active') AS moderation_status,p.removed_at,p.removal_reason,
            COALESCE(op.moderation_status,'active') AS original_moderation_status,
            u.username,u.minecraft_name,u.role,u.is_platform_verified,u.photo_url,
            COALESCE(up.display_name,'') AS display_name,COALESCE(up.avatar_url,'') AS avatar_url,
            COALESCE(up.cover_url,'') AS cover_url,
            CASE WHEN op.id IS NULL THEN NULL ELSE json_build_object(
              'id',op.id,'author_id',op.author_id,'content',op.content,'media_urls',op.media_urls,
              'created_at',op.created_at,'username',ou.username,'minecraft_name',ou.minecraft_name,
              'display_name',COALESCE(oup.display_name,''),'avatar_url',COALESCE(oup.avatar_url,'')) END AS original_post,
            (SELECT json_build_object(
              'id',pp.id,'ends_at',pp.ends_at,
              'options',COALESCE((SELECT json_agg(json_build_object(
                'id',o.id,'text',o.text,'option_image_url',o.option_image_url,
                'votes',(SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id=o.id)) ORDER BY o.sort_order)
                FROM post_poll_options o WHERE o.poll_id=pp.id),'[]'::json))
              FROM post_polls pp WHERE pp.post_id=COALESCE(p.repost_of_id,p.id) LIMIT 1) AS poll,
            COALESCE((SELECT json_agg(row_to_json(comment_row) ORDER BY comment_row.created_at DESC)
              FROM (SELECT c.id,c.author_id,c.content,c.media_urls,c.created_at,c.likes_count,c.reply_count,
                cu.username,cu.minecraft_name,COALESCE(cup.display_name,'') AS display_name,
                COALESCE(cup.avatar_url,'') AS avatar_url
                FROM post_comments c JOIN users cu ON cu.id=c.author_id
                LEFT JOIN user_preferences cup ON cup.user_id=cu.id
                WHERE c.post_id=COALESCE(p.repost_of_id,p.id) AND c.is_deleted=FALSE
                ORDER BY c.created_at DESC LIMIT 25) comment_row),'[]'::json) AS recent_comments
          FROM user_posts p JOIN users u ON u.id=p.author_id
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN user_posts op ON op.id=p.repost_of_id
          LEFT JOIN users ou ON ou.id=op.author_id
          LEFT JOIN user_preferences oup ON oup.user_id=ou.id
          WHERE p.id=$1 LIMIT 1
        `, [postId]),
        pool.query(`
          WITH target AS (
            SELECT COALESCE(repost_of_id,id) AS id FROM user_posts WHERE id=$1
          ), views AS (
            SELECT COALESCE(SUM(d.view_count),0)::bigint AS impressions,
              COUNT(DISTINCT d.user_id)::int AS unique_viewers,
              COALESCE(SUM(d.total_dwell_ms),0)::bigint AS total_dwell_ms,
              COALESCE(SUM(d.view_count) FILTER (WHERE d.viewer_was_follower),0)::bigint AS follower_impressions,
              COALESCE(SUM(d.view_count) FILTER (WHERE NOT d.viewer_was_follower),0)::bigint AS discovery_impressions
            FROM post_impression_daily d
            WHERE d.post_id=(SELECT id FROM target) AND d.day >= $2::date AND d.day < $3::date
          ), surfaces AS (
            SELECT COALESCE(jsonb_object_agg(surface,impressions),'{}'::jsonb) AS impressions_by_surface
            FROM (
              SELECT d.surface,SUM(d.view_count)::bigint AS impressions
              FROM post_impression_daily d
              WHERE d.post_id=(SELECT id FROM target) AND d.day >= $2::date AND d.day < $3::date
              GROUP BY d.surface
            ) grouped
          )
          SELECT v.*,s.impressions_by_surface,
            (SELECT COUNT(*)::int FROM post_likes l WHERE l.post_id=(SELECT id FROM target) AND l.created_at >= $2 AND l.created_at < $3) AS likes,
            (SELECT COUNT(*)::int FROM post_comments c WHERE c.post_id=(SELECT id FROM target) AND c.created_at >= $2 AND c.created_at < $3 AND c.is_deleted=FALSE) AS comments,
            (SELECT COUNT(*)::int FROM user_posts r WHERE r.repost_of_id=(SELECT id FROM target) AND r.created_at >= $2 AND r.created_at < $3) AS reposts,
            (SELECT COUNT(*)::int FROM post_saves ps WHERE ps.post_id=(SELECT id FROM target) AND ps.created_at >= $2 AND ps.created_at < $3) AS saves,
            (SELECT COUNT(*)::int FROM post_poll_votes pv JOIN post_polls pp ON pp.id=pv.poll_id
              WHERE pp.post_id=(SELECT id FROM target) AND pv.created_at >= $2 AND pv.created_at < $3) AS poll_votes,
            (SELECT COUNT(*)::int FROM content_reports cr WHERE cr.content_type='post' AND cr.content_id=$1) AS reports_total,
            (SELECT COUNT(*)::int FROM content_reports cr WHERE cr.content_type='post' AND cr.content_id=$1 AND cr.status='pending') AS reports_pending
          FROM views v CROSS JOIN surfaces s
        `, [postId, period.start, period.end]),
        pool.query(`
          WITH target AS (SELECT COALESCE(repost_of_id,id) AS id FROM user_posts WHERE id=$1),
          days AS (SELECT generate_series($2::date,$3::date - 1,INTERVAL '1 day')::date AS day),
          views AS (
            SELECT day,SUM(view_count)::bigint AS impressions,COUNT(DISTINCT user_id)::int AS unique_viewers,
              SUM(total_dwell_ms)::bigint AS total_dwell_ms
            FROM post_impression_daily WHERE post_id=(SELECT id FROM target) AND day >= $2::date AND day < $3::date GROUP BY day
          ), events AS (
            SELECT day,SUM(likes)::int AS likes,SUM(comments)::int AS comments,SUM(reposts)::int AS reposts,SUM(saves)::int AS saves
            FROM (
              SELECT created_at::date AS day,COUNT(*) AS likes,0 AS comments,0 AS reposts,0 AS saves FROM post_likes
                WHERE post_id=(SELECT id FROM target) AND created_at >= $2 AND created_at < $3 GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,COUNT(*),0,0 FROM post_comments
                WHERE post_id=(SELECT id FROM target) AND created_at >= $2 AND created_at < $3 AND is_deleted=FALSE GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,0,COUNT(*),0 FROM user_posts
                WHERE repost_of_id=(SELECT id FROM target) AND created_at >= $2 AND created_at < $3 GROUP BY 1
              UNION ALL
              SELECT created_at::date,0,0,0,COUNT(*) FROM post_saves
                WHERE post_id=(SELECT id FROM target) AND created_at >= $2 AND created_at < $3 GROUP BY 1
            ) x GROUP BY day
          )
          SELECT d.day,COALESCE(v.impressions,0)::bigint AS impressions,COALESCE(v.unique_viewers,0)::int AS unique_viewers,
            COALESCE(v.total_dwell_ms,0)::bigint AS total_dwell_ms,
            COALESCE(e.likes,0)::int AS likes,COALESCE(e.comments,0)::int AS comments,
            COALESCE(e.reposts,0)::int AS reposts,COALESCE(e.saves,0)::int AS saves,0::int AS poll_votes
          FROM days d LEFT JOIN views v USING(day) LEFT JOIN events e USING(day) ORDER BY d.day
        `, [postId, period.start, period.end]),
        moderationVisible ? pool.query(`
          SELECT cr.id,cr.reporter_id,reporter.username AS reporter_username,cr.reason,cr.description,
            cr.status,cr.action_taken,cr.created_at,cr.reviewed_at,reviewer.username AS reviewer_username
          FROM content_reports cr JOIN users reporter ON reporter.id=cr.reporter_id
          LEFT JOIN users reviewer ON reviewer.id=cr.reviewed_by
          WHERE cr.content_type='post' AND cr.content_id=$1
          ORDER BY cr.created_at DESC LIMIT 100
        `, [postId]) : Promise.resolve({ rows: [] }),
        moderationVisible ? pool.query(`
          WITH target AS (
            SELECT p.author_id AS selected_author_id,
              COALESCE(original.id,p.id) AS original_post_id,
              COALESCE(original.author_id,p.author_id) AS original_author_id
            FROM user_posts p
            LEFT JOIN user_posts original ON original.id=p.repost_of_id
            WHERE p.id=$1
          )
          SELECT r.*,creator.username AS created_by_username,revoker.username AS revoked_by_username,
            CASE WHEN r.status='active' AND r.ends_at<=NOW() THEN 'expired' ELSE r.status END AS effective_status
          FROM community_delivery_restrictions r
          CROSS JOIN target
          LEFT JOIN users creator ON creator.id=r.created_by
          LEFT JOIN users revoker ON revoker.id=r.revoked_by
          WHERE r.target_post_id IN ($1,target.original_post_id)
            OR r.target_user_id IN (target.selected_author_id,target.original_author_id)
          ORDER BY (r.status='active' AND r.starts_at<=NOW() AND (r.ends_at IS NULL OR r.ends_at>NOW())) DESC,
            r.delivery_factor ASC,r.created_at DESC
        `, [postId]) : Promise.resolve({ rows: [] }),
      ]);

      if (!postResult.rows.length) return res.status(404).json({ error: 'Publicacao nao encontrada.', code: 'POST_NOT_FOUND' });
      const post = postResult.rows[0];
      if (!moderationVisible && (post.moderation_status !== 'active' || post.original_moderation_status !== 'active')) {
        return res.status(404).json({ error: 'Publicacao nao encontrada.', code: 'POST_NOT_FOUND' });
      }
      delete post.original_moderation_status;
      if (!moderationVisible) {
        post.removal_reason = null;
        post.removed_at = null;
        post.moderation_censored = true;
      }
      const metrics = engagementSummary(metricsResult.rows[0] || {});
      if (!moderationVisible) {
        metrics.reports_total = null;
        metrics.reports_pending = null;
        metrics.moderation_censored = true;
      }
      const activeRestriction = restrictionResult.rows.find(row => row.effective_status === 'active'
        && new Date(row.starts_at).getTime() <= Date.now()
        && (!row.ends_at || new Date(row.ends_at).getTime() > Date.now())) || null;
      res.json({
        post,
        metrics,
        daily: dailyResult.rows.map(engagementSummary),
        reports: reportsResult.rows,
        restriction: activeRestriction,
        moderation_censored: !moderationVisible,
      });
    } catch (error) {
      routeError('post-detail', res, error);
    }
  });

  app.get('/api/admin/community/restrictions', auth, requireAdmin, moderationReadGuard, async (req, res) => {
    const limit = clampInt(req.query.limit, 40, 1, 100);
    const offset = parseOpaqueCursor(req.query.cursor);
    const params = [];
    const conditions = [];
    const targetType = cleanText(req.query.target_type, 20).toLowerCase();
    if (['profile', 'post'].includes(targetType)) {
      params.push(targetType);
      conditions.push(`r.target_type=$${params.length}`);
    }
    const status = cleanText(req.query.status, 20).toLowerCase();
    if (status === 'active') conditions.push("r.status='active' AND r.starts_at<=NOW() AND (r.ends_at IS NULL OR r.ends_at>NOW())");
    if (status === 'expired') conditions.push("(r.status='expired' OR (r.status='active' AND r.ends_at<=NOW()))");
    if (['revoked', 'superseded'].includes(status)) {
      params.push(status);
      conditions.push(`r.status=$${params.length}`);
    }
    const q = cleanText(req.query.q, 80).toLowerCase();
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(LOWER(COALESCE(target_user.username,post_user.username,'')) LIKE $${params.length}
        OR LOWER(COALESCE(target_user.minecraft_name,post_user.minecraft_name,'')) LIKE $${params.length}
        OR LOWER(COALESCE(r.reason_detail,'')) LIKE $${params.length})`);
    }
    params.push(limit + 1, offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const { rows } = await pool.query(`
        SELECT r.id,r.target_type,r.target_user_id,r.target_post_id,
          COALESCE(r.target_user_id,r.target_post_id) AS target_id,
          r.level,r.delivery_factor,
          r.surfaces,r.reason_code,r.reason_detail,r.starts_at,r.ends_at,r.status AS stored_status,r.created_at,
          r.revoked_at,r.revoke_reason,
          CASE WHEN r.status='active' AND r.ends_at<=NOW() THEN 'expired' ELSE r.status END AS status,
          CASE WHEN r.status='active' AND r.ends_at<=NOW() THEN 'expired' ELSE r.status END AS effective_status,
          creator.id AS created_by,creator.username AS created_by_username,
          revoker.id AS revoked_by,revoker.username AS revoked_by_username,
          COALESCE(target_user.id,post_user.id) AS target_account_id,
          COALESCE(target_user.username,post_user.username) AS target_username,
          COALESCE(target_user.minecraft_name,post_user.minecraft_name) AS target_minecraft_name,
          COALESCE(target_prefs.display_name,post_prefs.display_name,'') AS target_display_name,
          COALESCE(NULLIF(target_prefs.display_name,''),NULLIF(post_prefs.display_name,''),
            target_user.username,post_user.username,target_user.minecraft_name,post_user.minecraft_name) AS target_name,
          COALESCE(target_prefs.avatar_url,post_prefs.avatar_url,'') AS target_avatar_url,
          target_post.content AS target_post_content,target_post.media_urls AS target_post_media_urls,
          COALESCE((SELECT json_agg(json_build_object(
            'id',e.id,'event_type',e.event_type,'actor_id',e.actor_id,'actor_username',actor.username,
            'reason',e.reason,'before_state',e.before_state,'after_state',e.after_state,
            'created_at',e.created_at) ORDER BY e.created_at DESC,e.id DESC)
            FROM community_delivery_restriction_events e LEFT JOIN users actor ON actor.id=e.actor_id
            WHERE e.restriction_id=r.id),'[]'::json) AS events
        FROM community_delivery_restrictions r
        JOIN users creator ON creator.id=r.created_by
        LEFT JOIN users revoker ON revoker.id=r.revoked_by
        LEFT JOIN users target_user ON target_user.id=r.target_user_id
        LEFT JOIN user_preferences target_prefs ON target_prefs.user_id=target_user.id
        LEFT JOIN user_posts target_post ON target_post.id=r.target_post_id
        LEFT JOIN users post_user ON post_user.id=target_post.author_id
        LEFT JOIN user_preferences post_prefs ON post_prefs.user_id=post_user.id
        ${where}
        ORDER BY (r.status='active' AND r.starts_at<=NOW() AND (r.ends_at IS NULL OR r.ends_at>NOW())) DESC,
          r.created_at DESC,r.id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `, params);
      res.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? makeOpaqueCursor(offset + limit) : null });
    } catch (error) {
      routeError('restrictions', res, error);
    }
  });

  app.post('/api/admin/community/restrictions', auth, requireOwner, async (req, res) => {
    const targetType = cleanText(req.body?.target_type, 20).toLowerCase();
    const targetId = Number.parseInt(req.body?.target_id, 10);
    const level = Number.parseInt(req.body?.level, 10);
    const levelConfig = SOCIAL_DELIVERY_LEVELS[level];
    const rawReasonCode = cleanText(req.body?.reason_code, 40).toLowerCase();
    const reasonCode = rawReasonCode === 'quality' ? 'low_quality' : rawReasonCode;
    const reasonDetail = cleanText(req.body?.reason_detail, 500);
    if (!['profile', 'post'].includes(targetType) || !targetId) {
      return res.status(400).json({ error: 'Alvo invalido.', code: 'INVALID_RESTRICTION_TARGET' });
    }
    if (!levelConfig) return res.status(400).json({ error: 'Nivel invalido.', code: 'INVALID_RESTRICTION_LEVEL' });
    if (!RESTRICTION_REASON_CODES.has(reasonCode)) {
      return res.status(400).json({ error: 'Categoria de motivo invalida.', code: 'INVALID_RESTRICTION_REASON' });
    }
    if (reasonDetail.length < 8) {
      return res.status(400).json({ error: 'Informe um motivo com pelo menos 8 caracteres.', code: 'REASON_REQUIRED' });
    }
    const requestedSurfaces = Array.isArray(req.body?.surfaces)
      ? [...new Set(req.body.surfaces.flatMap(value => {
        const surface = cleanText(value, 24).toLowerCase();
        // The current staff UI calls the combined feed surfaces simply `feed`.
        return surface === 'feed' ? ['recommended', 'following', 'public_feed'] : [surface];
      }))]
      : [];
    const surfaces = requestedSurfaces.length ? requestedSurfaces : [...DEFAULT_SOCIAL_DELIVERY_SURFACES];
    if (!surfaces.length || surfaces.some(surface => !SOCIAL_DELIVERY_SURFACES.includes(surface))) {
      return res.status(400).json({ error: 'Superficie de entrega invalida.', code: 'INVALID_DELIVERY_SURFACE' });
    }
    const durationHoursInput = req.body?.duration_hours;
    const durationHours = Number(durationHoursInput ?? 24);
    const permanent = req.body?.permanent === true;
    const permanentConfirmed = cleanText(req.body?.confirm, 80) === 'RESTRINGIR PERMANENTEMENTE';
    if (permanent && !permanentConfirmed) {
      return res.status(400).json({ error: 'Confirme a restricao permanente.', code: 'CONFIRMATION_REQUIRED' });
    }
    const startsAt = new Date();
    let endsAt = null;
    if (!permanent) {
      const explicitEnd = req.body?.ends_at ? new Date(String(req.body.ends_at)) : null;
      if (explicitEnd && Number.isFinite(explicitEnd.getTime())) endsAt = explicitEnd;
      else if (Number.isFinite(durationHours)) endsAt = new Date(startsAt.getTime() + durationHours * 3600000);
      if (!endsAt || endsAt.getTime() < startsAt.getTime() + 15 * 60000
        || endsAt.getTime() > startsAt.getTime() + 366 * 86400000) {
        return res.status(400).json({ error: 'Duracao invalida. Use entre 15 minutos e 366 dias.', code: 'INVALID_RESTRICTION_DURATION' });
      }
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const targetResult = targetType === 'profile'
        ? await client.query('SELECT id,username,minecraft_name FROM users WHERE id=$1 AND merged_into_user_id IS NULL FOR UPDATE', [targetId])
        : await client.query(`SELECT p.id,p.author_id,u.username,u.minecraft_name FROM user_posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1 FOR UPDATE`, [targetId]);
      if (!targetResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Alvo nao encontrado.', code: 'RESTRICTION_TARGET_NOT_FOUND' });
      }

      const targetColumn = targetType === 'profile' ? 'target_user_id' : 'target_post_id';
      const previous = await client.query(`
        SELECT * FROM community_delivery_restrictions
        WHERE ${targetColumn}=$1 AND status='active'
        FOR UPDATE
      `, [targetId]);
      const replaced = await client.query(`
        UPDATE community_delivery_restrictions
        SET status=CASE WHEN ends_at IS NOT NULL AND ends_at<=NOW() THEN 'expired' ELSE 'superseded' END,
          updated_at=NOW()
        WHERE ${targetColumn}=$1 AND status='active'
        RETURNING *
      `, [targetId]);
      const replacedById = new Map(replaced.rows.map(row => [String(row.id), row]));
      for (const old of previous.rows) {
        const after = replacedById.get(String(old.id));
        const eventType = after?.status || 'superseded';
        await client.query(`
          INSERT INTO community_delivery_restriction_events
            (restriction_id,event_type,actor_id,reason,before_state,after_state)
          VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
        `, [old.id, eventType, req.user.sub, `Substituida pela nova restricao do alvo ${targetType} #${targetId}`,
          JSON.stringify(old), JSON.stringify(after || { ...old, status: eventType })]);
      }

      const { rows } = await client.query(`
        INSERT INTO community_delivery_restrictions
          (target_type,target_user_id,target_post_id,level,delivery_factor,surfaces,reason_code,reason_detail,starts_at,ends_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11)
        RETURNING *
      `, [targetType, targetType === 'profile' ? targetId : null, targetType === 'post' ? targetId : null,
        level, levelConfig.factor, surfaces, reasonCode, reasonDetail, startsAt, endsAt, req.user.sub]);
      const restriction = rows[0];
      await client.query(`
        INSERT INTO community_delivery_restriction_events
          (restriction_id,event_type,actor_id,reason,after_state)
        VALUES($1,'created',$2,$3,$4::jsonb)
      `, [restriction.id, req.user.sub, reasonDetail, JSON.stringify(restriction)]);
      await client.query('COMMIT');

      await auditSafely(auditFromReq, req, {
        actorId: req.user.sub,
        actorName: req.user.username,
        type: 'moderation',
        severity: level >= 3 || permanent ? 'warning' : 'info',
        targetId,
        targetName: targetType,
        message: `Restricao de entrega criada: ${targetType} #${targetId}, nivel ${level}`,
        metadata: { restriction_id: restriction.id, target_type: targetType, level, surfaces, reason_code: reasonCode, ends_at: endsAt?.toISOString?.() || null },
      });
      res.status(201).json({ restriction });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      routeError('restriction-create', res, error);
    } finally {
      client?.release();
    }
  });

  app.post('/api/admin/community/restrictions/:id/revoke', auth, requireOwner, async (req, res) => {
    const restrictionId = Number.parseInt(req.params.id, 10);
    const reason = cleanText(req.body?.reason, 500);
    if (!restrictionId) return res.status(400).json({ error: 'Restricao invalida.', code: 'INVALID_RESTRICTION_ID' });
    if (reason.length < 8) return res.status(400).json({ error: 'Informe um motivo com pelo menos 8 caracteres.', code: 'REASON_REQUIRED' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const currentResult = await client.query('SELECT * FROM community_delivery_restrictions WHERE id=$1 FOR UPDATE', [restrictionId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Restricao nao encontrada.', code: 'RESTRICTION_NOT_FOUND' });
      }
      if (current.status !== 'active' || (current.ends_at && new Date(current.ends_at).getTime() <= Date.now())) {
        if (current.status === 'active') {
          await client.query("UPDATE community_delivery_restrictions SET status='expired',updated_at=NOW() WHERE id=$1", [restrictionId]);
          await client.query(`INSERT INTO community_delivery_restriction_events
            (restriction_id,event_type,actor_id,reason,before_state,after_state)
            VALUES($1,'expired',$2,$3,$4::jsonb,$5::jsonb)`, [restrictionId, req.user.sub,
            'Expiracao reconhecida durante tentativa de revogacao', JSON.stringify(current), JSON.stringify({ ...current, status: 'expired' })]);
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
        return res.status(409).json({ error: 'A restricao ja nao esta ativa.', code: 'RESTRICTION_NOT_ACTIVE' });
      }
      const { rows } = await client.query(`
        UPDATE community_delivery_restrictions
        SET status='revoked',revoked_by=$2,revoked_at=NOW(),revoke_reason=$3,updated_at=NOW()
        WHERE id=$1 RETURNING *
      `, [restrictionId, req.user.sub, reason]);
      const revoked = rows[0];
      await client.query(`
        INSERT INTO community_delivery_restriction_events
          (restriction_id,event_type,actor_id,reason,before_state,after_state)
        VALUES($1,'revoked',$2,$3,$4::jsonb,$5::jsonb)
      `, [restrictionId, req.user.sub, reason, JSON.stringify(current), JSON.stringify(revoked)]);
      await client.query('COMMIT');
      await auditSafely(auditFromReq, req, {
        actorId: req.user.sub,
        actorName: req.user.username,
        type: 'moderation',
        severity: 'info',
        targetId: current.target_user_id || current.target_post_id,
        targetName: current.target_type,
        message: `Restricao de entrega #${restrictionId} revogada`,
        metadata: { restriction_id: restrictionId, target_type: current.target_type, reason },
      });
      res.json({ restriction: revoked });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      routeError('restriction-revoke', res, error);
    } finally {
      client?.release();
    }
  });
}
