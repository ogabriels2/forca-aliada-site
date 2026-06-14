import { EventEmitter } from 'node:events';

const communityBus = new EventEmitter();
communityBus.setMaxListeners(500);

const REACTION_CODES = new Set(['heart', 'fire', 'trophy', 'shocked', 'diamond', 'handshake']);

export const COMMUNITY_EVOLUTION_SCHEMA_SQL = `
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS group_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE social_notifications ADD COLUMN IF NOT EXISTS actor_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE post_poll_options ADD COLUMN IF NOT EXISTS option_image_url TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL CHECK (code IN ('heart','fire','trophy','shocked','diamond','handshake')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id, code);

CREATE TABLE IF NOT EXISTS user_stories (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  content VARCHAR(280) DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_user_stories_active ON user_stories(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS story_views (
  story_id BIGINT NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views(viewer_id, viewed_at DESC);
`;

export function emitCommunityEvent(event, payload) {
  communityBus.emit(event, payload);
}

function safeText(value, max = 280) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function isSafeMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com' && url.pathname.includes('/image/upload/');
  } catch {
    return false;
  }
}

function reactionSummarySql(postAlias = 'p') {
  return `COALESCE((
    SELECT json_agg(json_build_object('code', grouped.code, 'count', grouped.count) ORDER BY grouped.count DESC, grouped.code)
    FROM (
      SELECT pr.code, COUNT(*)::int AS count
      FROM post_reactions pr
      WHERE pr.post_id = ${postAlias}.id
      GROUP BY pr.code
    ) grouped
  ), '[]'::json)`;
}

export function registerCommunityEvolution(app, pool, auth, helpers = {}) {
  const {
    fetchMinecraftStatusCached,
    primaryIntegrationFieldsSql = () => "'{}'::json",
    socialRankSql = () => "'ferro'",
    socialMeritSql = () => '0',
    requireAdmin = (_req, _res, next) => next(),
  } = helpers;

  app.get('/api/community/feed/stream', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const userId = Number(req.user.sub);
    const listener = payload => {
      if (Number(payload?.authorId) === userId) return;
      res.write(`event: new-post\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const typingListener = payload => {
      if (Number(payload?.recipientId) !== userId) return;
      res.write(`event: typing\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    communityBus.on('new-post', listener);
    communityBus.on('typing', typingListener);
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      communityBus.off('new-post', listener);
      communityBus.off('typing', typingListener);
    });
  });

  app.get('/api/community/posts/:id/reactions', auth, async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ error: 'ID invalido' });
    try {
      const { rows } = await pool.query(
        `SELECT pr.code, COUNT(*)::int AS count,
                COALESCE(json_agg(json_build_object(
                  'id', u.id, 'username', u.username, 'minecraft_name', u.minecraft_name,
                  'display_name', COALESCE(up.display_name,''), 'avatar_url', COALESCE(up.avatar_url,'')
                ) ORDER BY pr.updated_at DESC) FILTER (WHERE u.id IS NOT NULL), '[]'::json) AS people
         FROM post_reactions pr
         JOIN users u ON u.id=pr.user_id
         LEFT JOIN user_preferences up ON up.user_id=u.id
         WHERE pr.post_id=$1
         GROUP BY pr.code
         ORDER BY count DESC, pr.code`,
        [postId],
      );
      const mine = await pool.query('SELECT code FROM post_reactions WHERE post_id=$1 AND user_id=$2', [postId, req.user.sub]);
      res.json({ reactions: rows, my_reaction: mine.rows[0]?.code || null });
    } catch (e) {
      console.error('[GET post reactions]', e);
      res.status(500).json({ error: 'Erro ao listar reacoes' });
    }
  });

  app.post('/api/community/posts/:id/reactions', auth, async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    const code = safeText(req.body?.code, 20).toLowerCase();
    if (!postId || !REACTION_CODES.has(code)) return res.status(400).json({ error: 'Reacao invalida' });
    try {
      const exists = await pool.query('SELECT 1 FROM user_posts WHERE id=$1', [postId]);
      if (!exists.rowCount) return res.status(404).json({ error: 'Post nao encontrado' });
      await pool.query(
        `INSERT INTO post_reactions(post_id,user_id,code)
         VALUES($1,$2,$3)
         ON CONFLICT(post_id,user_id) DO UPDATE SET code=EXCLUDED.code, updated_at=NOW()`,
        [postId, req.user.sub, code],
      );
      const { rows } = await pool.query(
        'SELECT code, COUNT(*)::int AS count FROM post_reactions WHERE post_id=$1 GROUP BY code ORDER BY count DESC, code',
        [postId],
      );
      res.json({ ok: true, my_reaction: code, reactions: rows });
    } catch (e) {
      console.error('[POST post reactions]', e);
      res.status(500).json({ error: 'Erro ao reagir' });
    }
  });

  app.delete('/api/community/posts/:id/reactions', auth, async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ error: 'ID invalido' });
    try {
      await pool.query('DELETE FROM post_reactions WHERE post_id=$1 AND user_id=$2', [postId, req.user.sub]);
      const { rows } = await pool.query(
        'SELECT code, COUNT(*)::int AS count FROM post_reactions WHERE post_id=$1 GROUP BY code ORDER BY count DESC, code',
        [postId],
      );
      res.json({ ok: true, my_reaction: null, reactions: rows });
    } catch (e) {
      console.error('[DELETE post reactions]', e);
      res.status(500).json({ error: 'Erro ao remover reacao' });
    }
  });

  app.get('/api/community/stories', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.user_id, s.media_url, s.content, s.created_at, s.expires_at,
                u.username, u.minecraft_name, COALESCE(up.display_name,'') AS display_name,
                COALESCE(up.avatar_url,'') AS avatar_url,
                EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$1) AS viewed_by_me,
                (SELECT COUNT(*)::int FROM story_views sv WHERE sv.story_id=s.id) AS views_count
         FROM user_stories s
         JOIN users u ON u.id=s.user_id
         LEFT JOIN user_preferences up ON up.user_id=u.id
         WHERE s.expires_at > NOW()
           AND (s.user_id=$1 OR s.user_id IN (SELECT following_id FROM user_follows WHERE follower_id=$1))
         ORDER BY CASE WHEN s.user_id=$1 THEN 0 ELSE 1 END, viewed_by_me ASC, s.created_at ASC`,
        [req.user.sub],
      );
      res.json({ stories: rows });
    } catch (e) {
      console.error('[GET stories]', e);
      res.status(500).json({ error: 'Erro ao listar Momentos' });
    }
  });

  app.get('/api/community/stories/:userId', auth, async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ error: 'Usuario invalido' });
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.user_id, s.media_url, s.content, s.created_at, s.expires_at,
                u.username, u.minecraft_name, COALESCE(up.display_name,'') AS display_name,
                COALESCE(up.avatar_url,'') AS avatar_url,
                EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$1) AS viewed_by_me
         FROM user_stories s
         JOIN users u ON u.id=s.user_id
         LEFT JOIN user_preferences up ON up.user_id=u.id
         WHERE s.user_id=$2 AND s.expires_at > NOW()
         ORDER BY s.created_at ASC`,
        [req.user.sub, userId],
      );
      res.json({ stories: rows });
    } catch (e) {
      console.error('[GET user stories]', e);
      res.status(500).json({ error: 'Erro ao listar Momentos' });
    }
  });

  app.post('/api/community/stories', auth, async (req, res) => {
    const mediaUrl = String(req.body?.media_url || '').trim();
    const content = safeText(req.body?.content, 280);
    if (!isSafeMediaUrl(mediaUrl)) return res.status(400).json({ error: 'Envie uma imagem valida para o Momento' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO user_stories(user_id,media_url,content)
         VALUES($1,$2,$3)
         RETURNING id,user_id,media_url,content,created_at,expires_at`,
        [req.user.sub, mediaUrl, content],
      );
      res.status(201).json({ story: rows[0] });
    } catch (e) {
      console.error('[POST stories]', e);
      res.status(500).json({ error: 'Erro ao publicar Momento' });
    }
  });

  app.delete('/api/community/stories/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID invalido' });
    const result = await pool.query('DELETE FROM user_stories WHERE id=$1 AND user_id=$2', [id, req.user.sub]);
    if (!result.rowCount) return res.status(404).json({ error: 'Momento nao encontrado' });
    res.json({ ok: true });
  });

  app.post('/api/community/stories/:id/view', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID invalido' });
    await pool.query(
      `INSERT INTO story_views(story_id,viewer_id) VALUES($1,$2)
       ON CONFLICT(story_id,viewer_id) DO UPDATE SET viewed_at=NOW()`,
      [id, req.user.sub],
    );
    res.json({ ok: true });
  });

  app.get('/api/community/discover', auth, async (req, res) => {
    try {
      const [players, posts, tags] = await Promise.all([
        pool.query(
          `SELECT u.id,u.username,u.minecraft_name,COALESCE(up.display_name,'') AS display_name,
                  COALESCE(up.avatar_url,'') AS avatar_url, ${socialRankSql('u','pb')} AS rank,
                  ${socialMeritSql('u','pb')} AS merit,
                  EXISTS(SELECT 1 FROM player_sessions ps WHERE ps.left_at IS NULL AND LOWER(ps.player)=LOWER(u.minecraft_name)) AS is_online
           FROM users u
           LEFT JOIN user_preferences up ON up.user_id=u.id
           LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name)=LOWER(u.minecraft_name)
           WHERE u.id<>$1
             AND NOT EXISTS(SELECT 1 FROM user_follows f WHERE f.follower_id=$1 AND f.following_id=u.id)
             AND NOT EXISTS(SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=u.id) OR (ub.blocker_id=u.id AND ub.blocked_id=$1))
           ORDER BY is_online DESC, merit DESC NULLS LAST, u.created_at DESC
           LIMIT 8`,
          [req.user.sub],
        ),
        pool.query(
          `SELECT p.id,p.content,p.media_urls,p.created_at,u.id AS author_id,u.username,u.minecraft_name,
                  COALESCE(up.display_name,'') AS display_name,COALESCE(up.avatar_url,'') AS avatar_url,
                  (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.post_id=p.id) AS likes_count,
                  (SELECT COUNT(*)::int FROM post_comments pc WHERE pc.post_id=p.id AND pc.is_deleted=FALSE) AS comments_count,
                  ${reactionSummarySql('p')} AS reactions
           FROM user_posts p
           JOIN users u ON u.id=p.author_id
           LEFT JOIN user_preferences up ON up.user_id=u.id
           WHERE p.repost_of_id IS NULL AND p.created_at > NOW()-INTERVAL '7 days'
             AND NOT EXISTS(SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$1 AND ub.blocked_id=u.id) OR (ub.blocker_id=u.id AND ub.blocked_id=$1))
           ORDER BY ((SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) * 2
                    + (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id=p.id AND pc.is_deleted=FALSE) * 4) DESC,
                    p.created_at DESC
           LIMIT 3`,
          [req.user.sub],
        ),
        pool.query(
          `SELECT LOWER(tag_match[1]) AS tag, COUNT(*)::int AS count
           FROM user_posts p,
           LATERAL regexp_matches(p.content,'#([[:alnum:]_]{2,32})','g') AS tag_match
           WHERE p.created_at > NOW()-INTERVAL '7 days'
           GROUP BY LOWER(tag_match[1])
           ORDER BY count DESC, tag
           LIMIT 10`,
        ),
      ]);
      res.json({ players: players.rows, posts: posts.rows, hashtags: tags.rows });
    } catch (e) {
      console.error('[GET discover]', e);
      res.status(500).json({ error: 'Erro ao montar descoberta' });
    }
  });

  app.get('/api/community/search', auth, async (req, res) => {
    const query = safeText(req.query?.q, 80).toLowerCase();
    const type = ['all', 'players', 'posts', 'hashtags'].includes(req.query?.type) ? req.query.type : 'all';
    if (query.length < 2) return res.json({ players: [], posts: [], hashtags: [] });
    const like = `%${query.replace(/^#/, '')}%`;
    try {
      const [players, posts, hashtags] = await Promise.all([
        type === 'all' || type === 'players' ? pool.query(
          `SELECT u.id,u.username,u.minecraft_name,COALESCE(up.display_name,'') AS display_name,
                  COALESCE(up.avatar_url,'') AS avatar_url
           FROM users u LEFT JOIN user_preferences up ON up.user_id=u.id
           WHERE (LOWER(COALESCE(u.username,'')) LIKE $1 OR LOWER(COALESCE(u.minecraft_name,'')) LIKE $1 OR LOWER(COALESCE(up.display_name,'')) LIKE $1)
             AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$2 AND ub.blocked_id=u.id) OR (ub.blocker_id=u.id AND ub.blocked_id=$2))
           ORDER BY u.created_at DESC LIMIT 10`, [like, req.user.sub],
        ) : Promise.resolve({ rows: [] }),
        type === 'all' || type === 'posts' ? pool.query(
          `SELECT p.id,p.content,p.media_urls,p.created_at,u.id AS author_id,u.username,u.minecraft_name,
                  COALESCE(up.display_name,'') AS display_name,COALESCE(up.avatar_url,'') AS avatar_url
           FROM user_posts p JOIN users u ON u.id=p.author_id LEFT JOIN user_preferences up ON up.user_id=u.id
           WHERE LOWER(COALESCE(p.content,'')) LIKE $1
             AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id=$2 AND ub.blocked_id=u.id) OR (ub.blocker_id=u.id AND ub.blocked_id=$2))
           ORDER BY p.created_at DESC LIMIT 14`, [like, req.user.sub],
        ) : Promise.resolve({ rows: [] }),
        type === 'all' || type === 'hashtags' ? pool.query(
          `SELECT LOWER(tag_match[1]) AS tag,COUNT(*)::int AS count
           FROM user_posts p,LATERAL regexp_matches(p.content,'#([[:alnum:]_]{2,32})','g') AS tag_match
           WHERE LOWER(tag_match[1]) LIKE $1 GROUP BY LOWER(tag_match[1]) ORDER BY count DESC LIMIT 10`, [like],
        ) : Promise.resolve({ rows: [] }),
      ]);
      res.json({ players: players.rows, posts: posts.rows, hashtags: hashtags.rows });
    } catch (e) {
      console.error('[GET community search]', e);
      res.status(500).json({ error: 'Erro na busca unificada' });
    }
  });

  app.get('/api/server/live-players', auth, async (_req, res) => {
    try {
      const status = typeof fetchMinecraftStatusCached === 'function' ? await fetchMinecraftStatusCached() : null;
      const { rows } = await pool.query(
        `SELECT ps.player,ps.entered_at,u.id,u.username,u.minecraft_name,
                COALESCE(up.display_name,'') AS display_name,COALESCE(up.avatar_url,'') AS avatar_url,
                ${primaryIntegrationFieldsSql('u')} AS integration
         FROM player_sessions ps
         LEFT JOIN users u ON LOWER(u.minecraft_name)=LOWER(ps.player)
         LEFT JOIN user_preferences up ON up.user_id=u.id
         WHERE ps.left_at IS NULL
         ORDER BY ps.entered_at ASC
         LIMIT 20`,
      );
      res.json({
        online: Boolean(status?.online),
        host: status?.host || process.env.MC_HOST || 'fa.ogabriels.com',
        count: Number(status?.players?.online ?? rows.length),
        max: Number(status?.players?.max || 0),
        players: rows,
        checked_at: status?.checkedAt?.toISOString?.() || new Date().toISOString(),
      });
    } catch (e) {
      console.error('[GET live players]', e);
      res.status(500).json({ error: 'Erro ao consultar servidor' });
    }
  });

  app.get('/api/server/hourly', auth, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT date_trunc('hour',checked_at) AS timestamp,
                ROUND(AVG(players_online))::int AS players
         FROM server_status_checks
         WHERE checked_at > NOW()-INTERVAL '24 hours'
         GROUP BY date_trunc('hour',checked_at)
         ORDER BY timestamp ASC`,
      );
      res.json({ hours: rows });
    } catch (e) {
      console.error('[GET server hourly]', e);
      res.status(500).json({ error: 'Erro ao consultar atividade' });
    }
  });

  app.get('/api/admin/analytics/server-hourly', auth, requireAdmin, async (req, res) => {
    const hours = Math.max(1, Math.min(168, parseInt(req.query?.hours, 10) || 24));
    try {
      const { rows } = await pool.query(
        `SELECT date_trunc('hour',checked_at) AS timestamp,ROUND(AVG(players_online))::int AS players
         FROM server_status_checks
         WHERE checked_at > NOW()-($1::text || ' hours')::interval
         GROUP BY date_trunc('hour',checked_at) ORDER BY timestamp ASC`,
        [hours],
      );
      res.json({ hours: rows });
    } catch (e) {
      console.error('[GET admin server hourly]', e);
      res.status(500).json({ error: 'Erro ao consultar atividade' });
    }
  });

  app.get('/api/server/activity', auth, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ps.player,ps.entered_at,ps.origin,u.id,u.username,u.minecraft_name,
                COALESCE(up.display_name,'') AS display_name,COALESCE(up.avatar_url,'') AS avatar_url,
                ${primaryIntegrationFieldsSql('u')} AS integration
         FROM player_sessions ps
         LEFT JOIN users u ON LOWER(u.minecraft_name)=LOWER(ps.player)
         LEFT JOIN user_preferences up ON up.user_id=u.id
         WHERE ps.entered_at > NOW()-INTERVAL '6 hours'
         ORDER BY ps.entered_at DESC
         LIMIT 8`,
      );
      res.json({ activity: rows });
    } catch (e) {
      console.error('[GET server activity]', e);
      res.status(500).json({ error: 'Erro ao consultar atividade recente' });
    }
  });

  app.get('/api/community/player/:id/web-presence', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Usuario invalido' });
    const { rows } = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM user_sessions WHERE user_id=$1 AND revoked=FALSE AND last_seen_at>NOW()-INTERVAL '3 minutes'
       ) AS is_online,
       (SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id=$1) AS last_seen_at`,
      [id],
    );
    res.json(rows[0] || { is_online: false, last_seen_at: null });
  });

  app.post('/api/community/typing', auth, async (req, res) => {
    const recipientId = parseInt(req.body?.recipient_id, 10);
    if (!recipientId || recipientId === Number(req.user.sub)) return res.status(400).json({ error: 'Destinatario invalido' });
    emitCommunityEvent('typing', {
      actorId: Number(req.user.sub),
      recipientId,
      isTyping: Boolean(req.body?.is_typing),
      at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });
}
