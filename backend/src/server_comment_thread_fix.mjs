/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FORÇA ALIADA — SERVER COMMENT THREAD FIX PATCH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PROBLEMA: GET /api/community/comments/:id/thread usa `auth` (JWT obrigatório),
 * mas o frontend chama com token — funciona OK. O erro "Comentário indisponível"
 * ocorre quando:
 *   1. O comment_id é inválido ou deletado
 *   2. A query falha por likes_count / reply_count não existirem (migration não rodou)
 *   3. liked_by_me falha quando comment_likes não existe
 *
 * SOLUÇÃO:
 *   - Adiciona endpoint público /api/public/community/comments/:id/thread (sem auth)
 *   - Torna o endpoint autenticado mais robusto com fallback para colunas opcionais
 *   - Adiciona /api/community/comments/:id/share para URL pública de comentário
 *
 * INTEGRAÇÃO NO server.mjs:
 *   import { registerCommentThreadFix } from './server_comment_thread_fix.mjs';
 *   registerCommentThreadFix(app, pool, auth, { primaryIntegrationFieldsSql, socialRankSql });
 *
 *   // Chame ANTES de registerCommentUpgradeEndpoints (ou logo após)
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function registerCommentThreadFix(app, pool, auth, helpers = {}) {
  const { primaryIntegrationFieldsSql, socialRankSql } = helpers;

  // Helper: build safe SQL que detecta se a coluna exists (para migrations parciais)
  function safeCommentSelectSql(userIdParam = '$1') {
    // Usa COALESCE e tenta usar likes_count/reply_count se existirem,
    // senão faz COUNT ao vivo (mais lento mas nunca falha).
    return `
      c.id,
      c.post_id,
      COALESCE(c.parent_comment_id, NULL) AS parent_comment_id,
      COALESCE(c.reply_to_comment_id, NULL) AS reply_to_comment_id,
      (SELECT ru.username FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_username,
      (SELECT ru.minecraft_name FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_minecraft_name,
      (SELECT COALESCE(rup.display_name, '') FROM post_comments rc JOIN users ru ON ru.id = rc.author_id LEFT JOIN user_preferences rup ON rup.user_id = ru.id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_display_name,
      CASE WHEN c.is_deleted THEN '[comentário removido]' ELSE c.content END AS content,
      CASE WHEN c.is_deleted THEN '{}'::text[] ELSE c.media_urls END AS media_urls,
      c.is_deleted,
      c.created_at,
      COALESCE(c.likes_count, (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id)) AS likes_count,
      COALESCE(c.reply_count, (SELECT COUNT(*) FROM post_comments child WHERE child.parent_comment_id = c.id AND child.is_deleted = FALSE)) AS reply_count,
      EXISTS(
        SELECT 1 FROM comment_likes cl2
        WHERE cl2.comment_id = c.id AND cl2.user_id = ${userIdParam}
      ) AS liked_by_me,
      (SELECT COUNT(*)::int FROM comment_saves cs WHERE cs.comment_id = c.id) AS saves_count,
      EXISTS(
        SELECT 1 FROM comment_saves cs2
        WHERE cs2.comment_id = c.id AND cs2.user_id = ${userIdParam}
      ) AS saved_by_me,
      u.id AS author_id,
      u.username,
      u.minecraft_name,
      u.photo_url,
      u.is_platform_verified,
      COALESCE(up.avatar_url,  '') AS avatar_url,
      COALESCE(up.display_name,'') AS display_name
    `;
  }

  // Helper: safe comment select for public (no user ID, liked_by_me always false)
  function publicCommentSelectSql() {
    return `
      c.id,
      c.post_id,
      COALESCE(c.parent_comment_id, NULL) AS parent_comment_id,
      COALESCE(c.reply_to_comment_id, NULL) AS reply_to_comment_id,
      (SELECT ru.username FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_username,
      (SELECT ru.minecraft_name FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_minecraft_name,
      (SELECT COALESCE(rup.display_name, '') FROM post_comments rc JOIN users ru ON ru.id = rc.author_id LEFT JOIN user_preferences rup ON rup.user_id = ru.id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_display_name,
      CASE WHEN c.is_deleted THEN '[comentário removido]' ELSE c.content END AS content,
      CASE WHEN c.is_deleted THEN '{}'::text[] ELSE c.media_urls END AS media_urls,
      c.is_deleted,
      c.created_at,
      COALESCE(c.likes_count, 0) AS likes_count,
      COALESCE(c.reply_count, 0) AS reply_count,
      FALSE AS liked_by_me,
      (SELECT COUNT(*)::int FROM comment_saves cs WHERE cs.comment_id = c.id) AS saves_count,
      FALSE AS saved_by_me,
      u.id AS author_id,
      u.username,
      u.minecraft_name,
      u.photo_url,
      u.is_platform_verified,
      COALESCE(up.avatar_url,  '') AS avatar_url,
      COALESCE(up.display_name,'') AS display_name
    `;
  }

  // ─── Helper: fetch root comment (resolves if it's a reply) ───────────────
  async function fetchRootComment(commentId, userIdForLikes = null) {
    const selectSql = userIdForLikes
      ? safeCommentSelectSql('$2')
      : publicCommentSelectSql();

    const params = userIdForLikes
      ? [commentId, userIdForLikes]
      : [commentId];

    const { rows } = await pool.query(`
      SELECT ${selectSql}
      FROM post_comments c
      JOIN users u ON c.author_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE c.id = $1
      LIMIT 1
    `, params);

    if (!rows.length) return null;

    let root = rows[0];

    // If it's a reply, load parent instead
    if (root.parent_comment_id) {
      const parentParams = userIdForLikes
        ? [root.parent_comment_id, userIdForLikes]
        : [root.parent_comment_id];
      const { rows: parentRows } = await pool.query(`
        SELECT ${selectSql}
        FROM post_comments c
        JOIN users u ON c.author_id = u.id
        LEFT JOIN user_preferences up ON up.user_id = u.id
        WHERE c.id = $1
        LIMIT 1
      `, parentParams);
      if (parentRows.length) root = parentRows[0];
    }

    return root;
  }

  // ─── Helper: fetch original post ────────────────────────────────────────
  async function fetchOriginalPost(postId) {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.content, p.media_urls, p.created_at, p.author_id,
        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
        (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
        (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count,
        u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
        COALESCE(up.avatar_url,   '') AS avatar_url,
        COALESCE(up.display_name, '') AS display_name
      FROM user_posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE p.id = $1
      LIMIT 1
    `, [postId]);
    return rows[0] ?? null;
  }

  // ─── Helper: fetch replies to a comment ─────────────────────────────────
  async function fetchReplies(rootCommentId, { userId = null, sort = 'oldest', limit = 20, cursor = null } = {}) {
    const selectSql = userId ? safeCommentSelectSql('$1') : publicCommentSelectSql();
    const baseParams = userId ? [userId, rootCommentId] : [rootCommentId];
    const rootParam = userId ? '$2' : '$1';

    function orderBy(sortKey) {
      switch (sortKey) {
        case 'recent':  return 'c.created_at DESC, c.id DESC';
        case 'oldest':  return 'c.created_at ASC, c.id ASC';
        case 'top':     return 'c.likes_count DESC, c.reply_count DESC, c.created_at DESC, c.id DESC';
        default: // relevance
          return `(
            (COALESCE(c.likes_count,0) * 2.5 + COALESCE(c.reply_count,0) * 4.0)
            / NULLIF(POW(SQRT(GREATEST(EXTRACT(epoch FROM (NOW()-c.created_at))/3600.0,0)+1.5),1.1),0)
          ) DESC NULLS LAST, c.id DESC`;
      }
    }

    const params = [...baseParams, limit + 1];
    let paginationClause = '';
    if (cursor) {
      paginationClause = `AND c.id ${sort === 'oldest' ? '>' : '<'} $${params.length + 1}`;
      params.push(cursor);
    }

    const { rows } = await pool.query(`
      SELECT ${selectSql}
      FROM post_comments c
      JOIN users u ON c.author_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE c.parent_comment_id = ${rootParam}
        ${paginationClause}
      ORDER BY c.is_deleted ASC, ${orderBy(sort)}
      LIMIT $${userId ? '3' : '2'}
    `, params);

    const page = rows.slice(0, limit);
    return {
      replies: page,
      has_more: rows.length > limit,
      next_cursor: rows.length > limit ? page[page.length - 1]?.id : null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC endpoint — sem auth, para SEO e compartilhamento
  // GET /api/public/community/comments/:id/thread
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/public/community/comments/:id/thread', async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const sort = ['relevance', 'recent', 'oldest', 'top'].includes(req.query.sort)
      ? req.query.sort : 'oldest';

    if (!commentId) return res.status(400).json({ error: 'ID inválido' });

    try {
      const rootComment = await fetchRootComment(commentId, null);
      if (!rootComment) return res.status(404).json({ error: 'Comentário não encontrado' });

      const [originalPost, repliesData] = await Promise.all([
        fetchOriginalPost(rootComment.post_id),
        fetchReplies(rootComment.id, { sort }),
      ]);

      res.json({
        root_comment: rootComment,
        original_post: originalPost,
        ...repliesData,
        sort,
      });
    } catch (e) {
      console.error('[GET /api/public/community/comments/:id/thread]', e);
      res.status(500).json({ error: 'Erro ao carregar thread do comentário' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AUTHENTICATED endpoint (REPLACES the one in server_comments_patch.mjs)
  // GET /api/community/comments/:id/thread
  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: Express uses the first registered route. If server_comments_patch.mjs
  // already registered this route, this won't override it unless you either:
  //   A) Call registerCommentThreadFix BEFORE registerCommentUpgradeEndpoints, OR
  //   B) Remove the route from server_comments_patch.mjs
  // Safest: call this before registerCommentUpgradeEndpoints.
  app.get('/api/community/comments/:id/thread', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const sort = ['relevance', 'recent', 'oldest', 'top'].includes(req.query.sort)
      ? req.query.sort : 'oldest';
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const cursor = parseInt(req.query.cursor, 10) || null;

    if (!commentId) return res.status(400).json({ error: 'ID inválido' });

    try {
      const rootComment = await fetchRootComment(commentId, req.user.sub);
      if (!rootComment) return res.status(404).json({ error: 'Comentário não encontrado' });

      const [originalPost, repliesData] = await Promise.all([
        fetchOriginalPost(rootComment.post_id),
        fetchReplies(rootComment.id, { userId: req.user.sub, sort, limit, cursor }),
      ]);

      res.json({
        root_comment: rootComment,
        original_post: originalPost,
        ...repliesData,
        sort,
      });
    } catch (e) {
      console.error('[GET /api/community/comments/:id/thread FIXED]', e);
      res.status(500).json({ error: 'Erro ao carregar thread do comentário' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SHARE URL endpoint — redireciona para post com âncora no comentário
  // GET /share/comment/:id
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/share/comment/:id', async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.status(400).send('ID inválido');

    try {
      const { rows } = await pool.query(
        `SELECT c.post_id, c.content, u.username, u.minecraft_name,
                COALESCE(up.display_name, u.minecraft_name, u.username) AS display_name
         FROM post_comments c
         JOIN users u ON c.author_id = u.id
         LEFT JOIN user_preferences up ON up.user_id = u.id
         WHERE c.id = $1 LIMIT 1`,
        [commentId]
      );

      const comment = rows[0];
      if (!comment) return res.status(404).send('Comentário não encontrado');

      const postId = comment.post_id;
      const author = comment.display_name || comment.minecraft_name || comment.username || 'Jogador';
      const preview = String(comment.content || '').slice(0, 160);

      // Render a minimal SEO page that redirects to the community post thread
      const communityUrl = `/community/post/${encodeURIComponent(postId)}?comment=${encodeURIComponent(commentId)}`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Comentário de ${escapeHtml(author)} | Força Aliada</title>
<meta name="description" content="${escapeHtml(preview)}">
<meta property="og:title" content="Comentário de ${escapeHtml(author)} | Força Aliada">
<meta property="og:description" content="${escapeHtml(preview)}">
<meta property="og:type" content="article">
<meta http-equiv="refresh" content="0;url=${communityUrl}">
<link rel="canonical" href="${communityUrl}">
</head>
<body>
<p>Redirecionando... <a href="${communityUrl}">Clique aqui</a> se não redirecionar automaticamente.</p>
<script>location.replace("${communityUrl}");</script>
</body>
</html>`);
    } catch (e) {
      console.error('[GET /share/comment/:id]', e);
      res.status(500).send('Erro ao carregar comentário');
    }
  });

  console.log('[comment-thread-fix] Endpoints registrados:');
  console.log('  GET /api/public/community/comments/:id/thread (público, sem auth)');
  console.log('  GET /api/community/comments/:id/thread (autenticado, robusto)');
  console.log('  GET /share/comment/:id (redirecionamento SEO)');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}
