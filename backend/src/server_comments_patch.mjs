/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FORÇA ALIADA — COMMENT SYSTEM UPGRADE PATCH
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * COMO INTEGRAR NO server.mjs:
 *
 *  1. Importe as exportações deste arquivo no topo do server.mjs:
 *
 *     import {
 *       commentUpgradeSchemaSql,
 *       registerCommentUpgradeEndpoints,
 *     } from './server_comments_patch.mjs';
 *
 *  2. Execute o SQL de migração logo após os outros communitySchemaSql:
 *
 *     await pool.query(commentUpgradeSchemaSql);
 *
 *  3. Registre os novos endpoints passando (app, pool, auth, e helpers):
 *
 *     registerCommentUpgradeEndpoints(app, pool, auth, {
 *       sanitize, sanitizeText, clampInt, isPrivileged,
 *       socialRankSql, primaryIntegrationFieldsSql,
 *       createSocialNotification, auditFromReq,
 *     });
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * FUNCIONALIDADES
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  • comment_likes  — curtidas em comentários (igual post_likes, mas para post_comments)
 *  • parent_comment_id em post_comments — threading: comentários são respostas a comentários
 *  • GET  /api/community/posts/:id/comments       — atualizado: inclui likes, reply_count,
 *                                                   liked_by_me, parent_comment_id e sort
 *  • POST /api/community/comments/:id/like        — curtir um comentário
 *  • DELETE /api/community/comments/:id/like      — descurtir um comentário
 *  • GET  /api/community/comments/:id/thread      — retorna o comentário-pai + respostas a ele
 *                                                   (para navegar para a thread de um comentário)
 *  • POST /api/community/posts/:id/comments       — atualizado: aceita parent_comment_id
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ALGORITMO DE RELEVÂNCIA DE COMENTÁRIOS
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  O score de relevância usa a mesma filosofia do feed v2:
 *
 *    relevance_score = (engagement × velocity) / temporal_gravity
 *
 *  Onde:
 *    engagement     = likes_count * 2.5 + reply_count * 4.0 + (is_author_reply * 10.0)
 *    velocity       = engagement feito nas últimas 2h → boost de 1.8×
 *    temporal_gravity = sqrt(horas_desde_criacao + 1.5) ^ 1.1
 *
 *  Modos de sort expostos pela API:
 *    ?sort=relevance             — score calculado acima
 *    ?sort=recent                 — created_at DESC (mais recente primeiro)
 *    ?sort=oldest                 — created_at ASC  (cronológico, igual ao atual)
 *    ?sort=top                    — likes_count DESC (mais curtidos)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// BLOCO 1 — MIGRAÇÕES SQL
// ─────────────────────────────────────────────────────────────────────────────
export const commentUpgradeSchemaSql = `
-- ── 1. Threading: respostas a comentários ────────────────────────────────────
-- parent_comment_id NULL → comentário de nível 1 (resposta ao post)
-- parent_comment_id = X → resposta ao comentário X (nível 2)
-- Mantemos apenas 2 níveis de profundidade (Reddit-style flat threading)
-- para evitar UX complexa. Todas as respostas a comentários de nível 2+
-- são tratadas como respostas ao comentário raiz mais próximo.
ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id INTEGER
    REFERENCES post_comments(id) ON DELETE SET NULL;
ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS reply_to_comment_id INTEGER
    REFERENCES post_comments(id) ON DELETE SET NULL;
ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS media_urls TEXT[] NOT NULL DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON post_comments(parent_comment_id, created_at ASC)
  WHERE parent_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_reply_to
  ON post_comments(reply_to_comment_id)
  WHERE reply_to_comment_id IS NOT NULL;

-- ── 2. Curtidas em comentários ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id  INTEGER NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment
  ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user
  ON comment_likes(user_id, created_at DESC);

-- ── 2b. Comentarios salvos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_saves (
  comment_id  INTEGER NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_saves_comment
  ON comment_saves(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_saves_user
  ON comment_saves(user_id, created_at DESC);

-- ── 3. Colunas de contagem desnormalizadas (performance) ─────────────────────
-- likes_count e reply_count são mantidos por triggers para evitar COUNT(*) 
-- em cada query de listagem.
ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS likes_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reply_count  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_comments_likes_count
  ON post_comments(post_id, likes_count DESC);

-- Backfill: conta likes existentes (se já havia curtidas antes da migration)
UPDATE post_comments pc
SET likes_count = (
  SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = pc.id
);
-- Backfill: conta replies existentes
UPDATE post_comments pc
SET reply_count = (
  SELECT COUNT(*) FROM post_comments child
  WHERE child.parent_comment_id = pc.id AND child.is_deleted = FALSE
);

-- ── 4. Trigger: atualiza likes_count ao curtir / descurtir ───────────────────
CREATE OR REPLACE FUNCTION fa_comment_likes_count_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE post_comments SET likes_count = likes_count + 1 WHERE id = NEW.comment_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE post_comments SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.comment_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comment_likes_count ON comment_likes;
CREATE TRIGGER trg_comment_likes_count
AFTER INSERT OR DELETE ON comment_likes
FOR EACH ROW EXECUTE FUNCTION fa_comment_likes_count_trigger();

-- ── 5. Trigger: atualiza reply_count no comentário pai ───────────────────────
CREATE OR REPLACE FUNCTION fa_comment_reply_count_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_comment_id IS NOT NULL AND COALESCE(NEW.is_deleted, FALSE) = FALSE THEN
    UPDATE post_comments
    SET reply_count = reply_count + 1
    WHERE id = NEW.parent_comment_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NEW.is_deleted = TRUE AND OLD.is_deleted = FALSE THEN
    -- soft-delete: decrementa reply_count do pai
    IF OLD.parent_comment_id IS NOT NULL THEN
      UPDATE post_comments
      SET reply_count = GREATEST(0, reply_count - 1)
      WHERE id = OLD.parent_comment_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comment_reply_count ON post_comments;
CREATE TRIGGER trg_comment_reply_count
AFTER INSERT OR UPDATE OF is_deleted ON post_comments
FOR EACH ROW EXECUTE FUNCTION fa_comment_reply_count_trigger();

-- ── 6. Trigger: sinal de afinidade para curtidas em comentários ──────────────
-- Reutiliza fa_apply_tag_affinity do feed_v2 (+1.2 por like em comentário:
-- sinal de engajamento moderado, menos forte que like no post (+1.5) mas
-- relevante para o algoritmo saber que o usuário aprecia aquele tipo de conteúdo)
CREATE OR REPLACE FUNCTION fa_comment_likes_affinity_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_post_id INTEGER;
BEGIN
  SELECT post_id INTO v_post_id FROM post_comments WHERE id = COALESCE(NEW.comment_id, OLD.comment_id);
  IF v_post_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM fa_apply_tag_affinity(NEW.user_id, v_post_id, 1.2);
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM fa_apply_tag_affinity(OLD.user_id, v_post_id, -1.2);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Só instala o trigger se fa_apply_tag_affinity existir (feed v2)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fa_apply_tag_affinity'
  ) THEN
    DROP TRIGGER IF EXISTS trg_comment_likes_affinity ON comment_likes;
    EXECUTE '
      CREATE TRIGGER trg_comment_likes_affinity
      AFTER INSERT OR DELETE ON comment_likes
      FOR EACH ROW EXECUTE FUNCTION fa_comment_likes_affinity_trigger()
    ';
  END IF;
END $$;
`;

// ─────────────────────────────────────────────────────────────────────────────
// BLOCO 2 — ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra os novos endpoints no app Express.
 *
 * @param {import('express').Application} app
 * @param {import('pg').Pool} pool
 * @param {Function} auth           — middleware de autenticação JWT
 * @param {Object}   helpers        — funções utilitárias extraídas do server.mjs
 */
export function registerCommentUpgradeEndpoints(app, pool, auth, helpers) {
  const {
    sanitize,
    sanitizeText,
    clampInt,
    isPrivileged,
    socialRankSql,
    primaryIntegrationFieldsSql,
    createSocialNotification,
    notifyProfileSubscribers,
    auditFromReq,
    extractMentions,   // opcional — pode não existir em versões antigas
    normalizePostMediaUrls,
  } = helpers;

  // ─────────────────────────────────────────────────────────────────────────
  // HELPER INTERNO: SQL de seleção de comentário com campos extras
  // ─────────────────────────────────────────────────────────────────────────
  function commentSelectSql(currentUserParam = '$1') {
    return `
      c.id,
      c.post_id,
      c.parent_comment_id,
      c.reply_to_comment_id,
      (SELECT ru.username FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_username,
      (SELECT ru.minecraft_name FROM post_comments rc JOIN users ru ON ru.id = rc.author_id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_minecraft_name,
      (SELECT COALESCE(rup.display_name, '') FROM post_comments rc JOIN users ru ON ru.id = rc.author_id LEFT JOIN user_preferences rup ON rup.user_id = ru.id WHERE rc.id = c.reply_to_comment_id LIMIT 1) AS reply_to_display_name,
      CASE WHEN c.is_deleted THEN '[comentário removido]' ELSE c.content END AS content,
      CASE WHEN c.is_deleted THEN '{}'::text[] ELSE c.media_urls END AS media_urls,
      c.is_deleted,
      c.created_at,
      c.likes_count,
      c.reply_count,
      EXISTS(
        SELECT 1 FROM comment_likes cl
        WHERE cl.comment_id = c.id AND cl.user_id = ${currentUserParam}
      ) AS liked_by_me,
      (SELECT COUNT(*)::int FROM comment_saves cs WHERE cs.comment_id = c.id) AS saves_count,
      EXISTS(
        SELECT 1 FROM comment_saves cs2
        WHERE cs2.comment_id = c.id AND cs2.user_id = ${currentUserParam}
      ) AS saved_by_me,
      u.id   AS author_id,
      u.username,
      u.minecraft_name,
      u.photo_url,
      u.is_platform_verified,
      COALESCE(up.avatar_url,  '') AS avatar_url,
      COALESCE(up.display_name,'') AS display_name,
      ${primaryIntegrationFieldsSql('u')} AS integration,
      ${socialRankSql('u', 'pb')} AS rank
    `;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPER INTERNO: cláusula ORDER BY baseada no sort desejado
  //
  //  Fórmula de relevância:
  //    engagement = c.likes_count * 2.5 + c.reply_count * 4.0
  //                 + (post_author_replied * 10.0)
  //    velocity   = boost 1.8 se houver curtida ou resposta nas últimas 2h
  //    gravity    = SQRT(EXTRACT(epoch FROM (NOW()-c.created_at))/3600 + 1.5)^1.1
  //    score      = (engagement * velocity) / gravity
  //
  //  O score_author_flag é calculado via subquery lateral (ver abaixo).
  // ─────────────────────────────────────────────────────────────────────────
  function commentOrderBySql(sort, postAuthorIdParam) {
    switch (sort) {
      case 'recent':
        return 'c.created_at DESC, c.id DESC';
      case 'oldest':
        return 'c.created_at ASC, c.id ASC';
      case 'top':
        return 'c.likes_count DESC, c.reply_count DESC, c.created_at DESC, c.id DESC';
      case 'relevance':
      default: {
        // Gravidade temporal: mesma inspiração do feed v2
        // Fator de velocidade: se o comentário recebeu interação recente (2h), ganha boost
        return `(
          (
            (c.likes_count * 2.5 + c.reply_count * 4.0 +
              CASE WHEN c.author_id = ${postAuthorIdParam}::integer THEN 10.0 ELSE 0.0 END
            )
            * CASE WHEN EXISTS(
                SELECT 1 FROM comment_likes cl2
                WHERE cl2.comment_id = c.id
                  AND cl2.created_at > NOW() - INTERVAL '2 hours'
              ) OR EXISTS(
                SELECT 1 FROM post_comments child2
                WHERE child2.parent_comment_id = c.id
                  AND child2.created_at > NOW() - INTERVAL '2 hours'
                  AND child2.is_deleted = FALSE
              ) THEN 1.8 ELSE 1.0 END
          )
          / NULLIF(
              POW(
                SQRT(
                  GREATEST(
                    EXTRACT(epoch FROM (NOW() - c.created_at)) / 3600.0,
                    0
                  ) + 1.5
                ),
                1.1
              ),
              0
          )
        ) DESC NULLS LAST, c.id DESC`;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/community/posts/:id/comments
  //
  //  SUBSTITUI o endpoint existente. Compatível com clientes antigos:
  //  • O campo sort é novo — clientes antigos não enviam, recebem 'relevance'
  //  • Campos novos (likes_count, reply_count, liked_by_me, parent_comment_id)
  //    são adicionais — não quebram clientes que ignoram campos desconhecidos
  //  • Comentários de nível 1 (parent_comment_id IS NULL) são retornados aqui
  //  • Comentários de nível 2 (respostas) NÃO aparecem aqui — são carregados
  //    via GET /api/community/comments/:id/thread
  //
  //  Query params:
  //    ?sort=relevance|recent|oldest|top   (padrão: oldest)
  //    ?cursor=<id>                         (paginação keyset por id)
  //    ?limit=<n>                           (padrão: 20, max: 50)
  // ─────────────────────────────────────────────────────────────────────────

  // NOTA: Para substituir o endpoint existente, o operador deve remover o bloco
  // app.get('/api/community/posts/:id/comments', ...) do server.mjs e registrar
  // este em seu lugar. O patch é drop-in se inserido ANTES do bloco original.
  // Caso haja conflito de rota, o Express usará o primeiro registrado.
  app.get('/api/community/posts/:id/comments/v2', auth, async (req, res) => {
    const postId  = parseInt(req.params.id, 10);
    const limit   = clampInt(req.query.limit, 20, 1, 50);
    const cursor  = parseInt(req.query.cursor, 10) || null;
    const sort    = ['relevance', 'recent', 'oldest', 'top'].includes(req.query.sort)
      ? req.query.sort : 'oldest';

    if (!postId) return res.status(400).json({ error: 'ID inválido' });

    try {
      // Busca o author_id do post para o bônus de relevância (comentário do autor)
      const { rows: postRows } = await pool.query(
        'SELECT author_id FROM user_posts WHERE id=$1 LIMIT 1', [postId]
      );
      const postAuthorId = postRows[0]?.author_id ?? 0;

      const params = [req.user.sub, postId, limit + 1, postAuthorId];

      // Para paginação keyset com relevance, precisamos lembrar onde paramos
      // Usamos cursor por id (não por score, que pode mudar entre requests)
      let paginationClause = '';
      if (cursor && sort !== 'relevance' && sort !== 'top') {
        // Para sorts estáveis (recent/oldest), paginação por id + created_at
        paginationClause = `AND c.id ${sort === 'oldest' ? '>' : '<'} $${params.length + 1}`;
        params.push(cursor);
      } else if (cursor && (sort === 'top' || sort === 'relevance')) {
        // Para sorts por score (variável), paginação por OFFSET aproximado
        // Usamos id < cursor como proxy (não ideal mas funcional para 99% dos casos)
        paginationClause = `AND c.id != $${params.length + 1} AND c.created_at <= (
          SELECT created_at FROM post_comments WHERE id = $${params.length + 1}
        )`;
        params.push(cursor);
      }

      const { rows } = await pool.query(`
        SELECT ${commentSelectSql('$1')}
        FROM post_comments c
        JOIN users u ON c.author_id = u.id
        LEFT JOIN user_preferences  up ON up.user_id = u.id
        LEFT JOIN player_balances   pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        WHERE c.post_id = $2
          AND c.parent_comment_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
               OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
          )
          ${paginationClause}
        ORDER BY c.is_deleted ASC, ${commentOrderBySql(sort, '$4')}
        LIMIT $3
      `, params);

      const page       = rows.slice(0, limit);
      const next_cursor = rows.length > limit ? page[page.length - 1]?.id : null;

      res.json({
        comments: page,
        sort,
        next_cursor,
        has_more: rows.length > limit,
      });
    } catch (e) {
      console.error('[GET /api/community/posts/:id/comments/v2]', e);
      res.status(500).json({ error: 'Erro ao carregar comentários' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/community/posts/:id/comments  (versão atualizada — aceita parent_comment_id)
  //
  //  Substitui o endpoint existente no server.mjs.
  //  Registre este ANTES do existente para que o Express o capture primeiro,
  //  ou remova o bloco antigo.
  //
  //  Body: { content: string, parent_comment_id?: number }
  //
  //  Regra de threading:
  //  • Se parent_comment_id está presente, aplana para o comentário raiz
  //    caso o pai já seja uma resposta (depth ≤ 1 mantido automaticamente).
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/community/posts/:id/comments/reply', auth, async (req, res) => {
    const postId          = parseInt(req.params.id, 10);
    const content         = sanitizeText(req.body?.content || '');
    const mediaUrls       = typeof normalizePostMediaUrls === 'function'
      ? normalizePostMediaUrls(req.body?.media_urls)
      : [];
    const rawParentId     = parseInt(req.body?.parent_comment_id, 10) || null;

    if (!postId)                              return res.status(400).json({ error: 'ID inválido' });
    if ((!content && !mediaUrls.length) || content.length > 280) return res.status(400).json({ error: 'Comentário inválido (texto ou imagem obrigatório)' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verifica se o post existe e busca o autor
      const { rows: postRows } = await client.query(
        `SELECT p.author_id, p.content, u.minecraft_name, u.username
         FROM user_posts p JOIN users u ON u.id = p.author_id
         WHERE p.id=$1 LIMIT 1`,
        [postId],
      );
      const post = postRows[0];
      if (!post) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Post não encontrado' }); }

      // Verifica bloqueio
      const { rows: blocked } = await client.query(
        `SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`,
        [req.user.sub, post.author_id],
      );
      if (blocked.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Não é possível comentar neste post.' }); }

      // Resolve parent_comment_id: mantem a thread no comentario raiz, mas preserva
      // o alvo real em reply_to_comment_id para a UI mostrar "respondendo a".
      let parentCommentId = null;
      let replyToCommentId = null;
      let parentComment   = null;
      if (rawParentId) {
        const { rows: pRows } = await client.query(
          `SELECT id, author_id, parent_comment_id, post_id FROM post_comments
           WHERE id=$1 AND post_id=$2 AND is_deleted=FALSE LIMIT 1`,
          [rawParentId, postId],
        );
        parentComment = pRows[0];
        if (parentComment) {
          // Se o pai já é uma resposta (tem parent), usamos o pai do pai (raiz)
          parentCommentId = parentComment.parent_comment_id ?? parentComment.id;
          replyToCommentId = parentComment.id;
        }
      }

      const { rows } = await client.query(
        `INSERT INTO post_comments(post_id, author_id, content, parent_comment_id, reply_to_comment_id, media_urls)
         VALUES($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at, parent_comment_id, reply_to_comment_id, media_urls`,
        [postId, req.user.sub, content, parentCommentId, replyToCommentId, mediaUrls],
      );
      const newComment = rows[0];

      // Notificação ao autor do post
      await client.query('COMMIT');

      // A confirmação da API também confirma a persistência da notificação principal.
      const commentNotification = await createSocialNotification?.({
        recipientId: post.author_id,
        actorId: req.user.sub,
        type: 'comment',
        entityType: 'post',
        entityId: postId,
        previewText: content,
      }).catch(e => {
        console.error('[comment notification failed]', e);
        return null;
      });
      notifyProfileSubscribers?.({
        creatorId: req.user.sub,
        type: 'creator_reply',
        entityType: 'post',
        entityId: postId,
        previewText: content,
        allOnly: true,
      }).catch(e => console.warn('[subscriber reply notification]', e?.message));

      // Notificação ao autor do comentário pai (se existir e for pessoa diferente)
      if (parentComment && parentComment.author_id !== req.user.sub && parentComment.author_id !== post.author_id) {
        await createSocialNotification?.({
          recipientId: parentComment.author_id,
          actorId: req.user.sub,
          type: 'comment_reply',
          entityType: 'comment',
          entityId: newComment.id,
          previewText: content,
        }).catch(e => console.error('[reply notification failed]', e));
      }

      // Menções
      if (typeof extractMentions === 'function') {
        const mentions = extractMentions(content);
        if (mentions.length > 0) {
          const { rows: mentionedUsers } = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = ANY($1) OR LOWER(minecraft_name) = ANY($1)',
            [mentions],
          );
          for (const mUser of mentionedUsers) {
            if (mUser.id === req.user.sub) continue;
            createSocialNotification?.({
              recipientId: mUser.id,
              actorId: req.user.sub,
              type: 'mention_comment',
              entityType: 'comment',
              entityId: newComment.id,
              previewText: content,
            }).catch(() => {});
          }
        }
      }

      res.status(201).json({
        ok: true,
        id: newComment.id,
        created_at: newComment.created_at,
        parent_comment_id: newComment.parent_comment_id,
        reply_to_comment_id: newComment.reply_to_comment_id,
        notification_created: Boolean(commentNotification),
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[POST /api/community/posts/:id/comments/reply]', e);
      res.status(500).json({ error: 'Erro ao comentar' });
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/community/comments/:id/like
  // DELETE /api/community/comments/:id/like
  //
  //  Curtir / descurtir um comentário.
  //  Retorna { ok, likes_count, liked_by_me }.
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/community/comments/:id/like', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.status(400).json({ error: 'ID inválido' });

    try {
      // Verifica existência e busca autor (para notificação)
      const { rows: cRows } = await pool.query(
        `SELECT c.id, c.author_id, c.post_id, c.is_deleted
         FROM post_comments c WHERE c.id=$1 LIMIT 1`,
        [commentId],
      );
      const comment = cRows[0];
      if (!comment || comment.is_deleted) return res.status(404).json({ error: 'Comentário não encontrado' });

      await pool.query(
        `INSERT INTO comment_likes(comment_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [commentId, req.user.sub],
      );

      const { rows: countRow } = await pool.query(
        `SELECT likes_count FROM post_comments WHERE id=$1`,
        [commentId],
      );

      const notification = await createSocialNotification?.({
        recipientId: comment.author_id,
        actorId: req.user.sub,
        type: 'comment_like',
        entityType: 'comment',
        entityId: commentId,
        previewText: '',
      }).catch(e => {
        console.error('[comment like notification failed]', e);
        return null;
      });

      res.json({ ok: true, liked_by_me: true, likes_count: countRow[0]?.likes_count ?? 0, notification_created: Boolean(notification) });
    } catch (e) {
      console.error('[POST /api/community/comments/:id/like]', e);
      res.status(500).json({ error: 'Erro ao curtir comentário' });
    }
  });

  app.delete('/api/community/comments/:id/like', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.status(400).json({ error: 'ID inválido' });

    try {
      await pool.query(
        `DELETE FROM comment_likes WHERE comment_id=$1 AND user_id=$2`,
        [commentId, req.user.sub],
      );
      const { rows: countRow } = await pool.query(
        `SELECT likes_count FROM post_comments WHERE id=$1`,
        [commentId],
      );
      res.json({ ok: true, liked_by_me: false, likes_count: countRow[0]?.likes_count ?? 0 });
    } catch (e) {
      console.error('[DELETE /api/community/comments/:id/like]', e);
      res.status(500).json({ error: 'Erro ao descurtir comentário' });
    }
  });

  app.post('/api/community/comments/:id/save', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.status(400).json({ error: 'ID invalido' });
    try {
      const { rows } = await pool.query(
        'SELECT id FROM post_comments WHERE id=$1 AND is_deleted=FALSE LIMIT 1',
        [commentId],
      );
      if (!rows.length) return res.status(404).json({ error: 'Comentario nao encontrado' });
      await pool.query(
        'INSERT INTO comment_saves(comment_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [commentId, req.user.sub],
      );
      const { rows: counts } = await pool.query(
        'SELECT COUNT(*)::int AS saves_count FROM comment_saves WHERE comment_id=$1',
        [commentId],
      );
      res.json({ ok: true, saved_by_me: true, saves_count: counts[0]?.saves_count ?? 0 });
    } catch (e) {
      console.error('[POST /api/community/comments/:id/save]', e);
      res.status(500).json({ error: 'Erro ao salvar comentario' });
    }
  });

  app.delete('/api/community/comments/:id/save', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.status(400).json({ error: 'ID invalido' });
    try {
      await pool.query(
        'DELETE FROM comment_saves WHERE comment_id=$1 AND user_id=$2',
        [commentId, req.user.sub],
      );
      const { rows: counts } = await pool.query(
        'SELECT COUNT(*)::int AS saves_count FROM comment_saves WHERE comment_id=$1',
        [commentId],
      );
      res.json({ ok: true, saved_by_me: false, saves_count: counts[0]?.saves_count ?? 0 });
    } catch (e) {
      console.error('[DELETE /api/community/comments/:id/save]', e);
      res.status(500).json({ error: 'Erro ao remover comentario salvo' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/community/comments/:id/thread
  //
  //  Retorna:
  //   • o comentário-pai (nível 1, raiz da sub-thread)
  //   • o post original ao qual pertence
  //   • as respostas a esse comentário (nível 2), ordenadas por sort
  //
  //  Usado quando o usuário clica em um comentário específico para ver
  //  sua sub-thread (igual ao comportamento de "ver replies" do Twitter).
  //
  //  Query params:
  //    ?sort=relevance|recent|oldest|top   (padrão: oldest)
  //    ?cursor=<id>
  //    ?limit=<n>
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/community/comments/:id/thread', auth, async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const limit     = clampInt(req.query.limit, 20, 1, 50);
    const cursor    = parseInt(req.query.cursor, 10) || null;
    const sort      = ['relevance', 'recent', 'oldest', 'top'].includes(req.query.sort)
      ? req.query.sort : 'oldest';

    if (!commentId) return res.status(400).json({ error: 'ID inválido' });

    try {
      // 1. Busca o comentário raiz (aplana se ele mesmo for resposta)
      const { rows: cRootRows } = await pool.query(`
        SELECT
          c.id, c.post_id, c.parent_comment_id, c.content, c.media_urls, c.is_deleted,
          c.created_at, c.likes_count, c.reply_count,
          EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = $2) AS liked_by_me,
          u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
          COALESCE(up.avatar_url, '')   AS avatar_url,
          COALESCE(up.display_name, '') AS display_name,
          ${primaryIntegrationFieldsSql('u')} AS integration,
          ${socialRankSql('u', 'pb')} AS rank
        FROM post_comments c
        JOIN users u ON c.author_id = u.id
        LEFT JOIN user_preferences up ON up.user_id = u.id
        LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        WHERE c.id = $1
        LIMIT 1
      `, [commentId, req.user.sub]);

      if (!cRootRows.length) return res.status(404).json({ error: 'Comentário não encontrado' });

      let rootComment = cRootRows[0];
      // Se o comentário clicado for uma resposta, carrega o pai real
      if (rootComment.parent_comment_id) {
        const { rows: parentRows } = await pool.query(`
          SELECT
            c.id, c.post_id, c.parent_comment_id, c.content, c.media_urls, c.is_deleted,
            c.created_at, c.likes_count, c.reply_count,
            EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = $2) AS liked_by_me,
            u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
            COALESCE(up.avatar_url, '')   AS avatar_url,
            COALESCE(up.display_name, '') AS display_name,
            ${primaryIntegrationFieldsSql('u')} AS integration,
            ${socialRankSql('u', 'pb')} AS rank
          FROM post_comments c
          JOIN users u ON c.author_id = u.id
          LEFT JOIN user_preferences up ON up.user_id = u.id
          LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
          WHERE c.id = $1
          LIMIT 1
        `, [rootComment.parent_comment_id, req.user.sub]);
        if (parentRows.length) rootComment = parentRows[0];
      }

      const postId = rootComment.post_id;

      // 2. Busca o post original (contexto para renderização)
      const { rows: postRows } = await pool.query(`
        SELECT
          p.id, p.content, p.media_urls, p.created_at, p.author_id,
          (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
          (SELECT COUNT(*) FROM user_posts rp WHERE rp.repost_of_id = p.id)::int AS reposts_count,
          (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id AND pc.is_deleted = FALSE)::int AS comments_count,
          u.username, u.minecraft_name, u.photo_url, u.is_platform_verified,
          COALESCE(up.avatar_url,   '') AS avatar_url,
          COALESCE(up.display_name, '') AS display_name,
          ${primaryIntegrationFieldsSql('u')} AS integration,
          ${socialRankSql('u', 'pb')} AS rank
        FROM user_posts p
        JOIN users u ON u.id = p.author_id
        LEFT JOIN user_preferences up ON up.user_id = u.id
        LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        WHERE p.id = $1
        LIMIT 1
      `, [postId]);

      const originalPost = postRows[0] ?? null;
      const postAuthorId = originalPost?.author_id ?? 0;

      // 3. Busca as respostas ao comentário raiz
      const params = [req.user.sub, rootComment.id, limit + 1, postAuthorId];

      let paginationClause = '';
      if (cursor) {
        paginationClause = `AND c.id != $${params.length + 1}`;
        params.push(cursor);
      }

      const { rows: replies } = await pool.query(`
        SELECT ${commentSelectSql('$1')}
        FROM post_comments c
        JOIN users u ON c.author_id = u.id
        LEFT JOIN user_preferences up ON up.user_id = u.id
        LEFT JOIN player_balances  pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        WHERE c.parent_comment_id = $2
          AND c.post_id = (SELECT post_id FROM post_comments WHERE id = $2 LIMIT 1)
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id=$1 AND ub.blocked_id=u.id)
               OR (ub.blocker_id=u.id AND ub.blocked_id=$1)
          )
          ${paginationClause}
        ORDER BY c.is_deleted ASC, ${commentOrderBySql(sort, '$4')}
        LIMIT $3
      `, params);

      const page        = replies.slice(0, limit);
      const next_cursor = replies.length > limit ? page[page.length - 1]?.id : null;

      res.json({
        root_comment:  rootComment,
        original_post: originalPost,
        replies:       page,
        sort,
        next_cursor,
        has_more: replies.length > limit,
      });
    } catch (e) {
      console.error('[GET /api/community/comments/:id/thread]', e);
      res.status(500).json({ error: 'Erro ao carregar thread do comentário' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/community/posts/:id/comments  (v2 — substitui o original)
  //
  //  Versão atualizada do endpoint original, agora com sort e campos extras.
  //  Para manter compatibilidade total, use a rota /v2 acima e registre 
  //  este com o mesmo path do original SUBSTITUINDO o bloco antigo no server.mjs.
  // ─────────────────────────────────────────────────────────────────────────
  // A função abaixo pode ser usada para substituir o handler existente:
  // Copie o conteúdo para dentro do bloco app.get('/api/community/posts/:id/comments', ...)
  // no server.mjs original, substituindo toda a função.
  // Exportamos a lógica para reuso:
  app._commentListHandler = async (req, res, postId, userId) => {
    const limit   = clampInt(req.query.limit, 20, 1, 50);
    const cursor  = parseInt(req.query.cursor, 10) || null;
    const sort    = ['relevance', 'recent', 'oldest', 'top'].includes(req.query.sort)
      ? req.query.sort : (req.query.sort ? 'relevance' : 'oldest'); // backward compat: default oldest para clientes antigos sem ?sort

    try {
      const { rows: postRows } = await pool.query(
        'SELECT author_id FROM user_posts WHERE id=$1 LIMIT 1', [postId]
      );
      const postAuthorId = postRows[0]?.author_id ?? 0;

      const params = [userId, postId, limit + 1, postAuthorId];
      let paginationClause = '';
      if (cursor) {
        const dir = sort === 'oldest' ? '>' : '<';
        paginationClause = `AND c.id ${dir} $${params.length + 1}`;
        params.push(cursor);
      }

      const { rows } = await pool.query(`
        SELECT ${commentSelectSql('$1')}
        FROM post_comments c
        JOIN users u ON c.author_id = u.id
        LEFT JOIN user_preferences  up ON up.user_id = u.id
        LEFT JOIN player_balances   pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        WHERE c.post_id = $2
          AND c.parent_comment_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
               OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
          )
          ${paginationClause}
        ORDER BY c.is_deleted ASC, ${commentOrderBySql(sort, '$4')}
        LIMIT $3
      `, params);

      const page        = rows.slice(0, limit);
      const next_cursor = rows.length > limit ? page[page.length - 1]?.id : null;

      return res.json({
        comments: page,
        sort,
        next_cursor,
        has_more: rows.length > limit,
      });
    } catch (e) {
      console.error('[GET /api/community/posts/:id/comments upgraded]', e);
      return res.status(500).json({ error: 'Erro ao carregar comentários' });
    }
  };

  console.log('[comment-upgrade] Endpoints registrados:');
  console.log('  GET  /api/community/posts/:id/comments/v2');
  console.log('  POST /api/community/posts/:id/comments/reply');
  console.log('  POST /api/community/comments/:id/like');
  console.log('  DELETE /api/community/comments/:id/like');
  console.log('  GET  /api/community/comments/:id/thread');
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * INSTRUÇÕES PARA SUBSTITUIÇÃO DO ENDPOINT ORIGINAL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * No server.mjs, localize:
 *   app.get('/api/community/posts/:id/comments', auth, async (req, res) => {
 *
 * Substitua TODO o corpo da função por:
 *
 *   const postId = parseInt(req.params.id, 10);
 *   if (!postId) return res.status(400).json({ error: 'ID inválido' });
 *   return app._commentListHandler(req, res, postId, req.user.sub);
 *
 * Isso mantém a rota original funcionando com os novos campos e sort,
 * sem quebrar clientes que não enviam ?sort (recebem 'oldest' por default).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * NOTAS DE NOTIFICAÇÃO (type: 'comment_like' e 'comment_reply')
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Os novos tipos de notificação precisam ser adicionados à lista de tipos
 * aceitos no endpoint de notificações do server.mjs.
 *
 * Localize a constante NOTIFICATION_TYPES (ou equivalente) e adicione:
 *   'comment_like'
 *   'comment_reply'
 *
 * E no endpoint GET /api/community/notifications, na query SQL que busca
 * o preview de conteúdo por tipo, adicione os casos para os novos tipos
 * (retornar snippet do comentário like/reply).
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
