// =============================================================================
// FORCA ALIADA — FEED ALGORITHM v2
// =============================================================================
//
// COMO INTEGRAR NO server.mjs:
//
//  1. Execute o feedV2SchemaSql logo após o pool.query(communitySchemaSql)
//     (ou onde fica o bloco de migrações SQL de posts/curtidas)
//
//  2. Adicione o impressionLimiter junto aos outros rate limiters
//
//  3. Adicione os novos endpoints (impressions, saves, not-interested)
//     logo após o DELETE /api/community/posts/:id/like existente
//
//  4. SUBSTITUA COMPLETAMENTE o endpoint GET /api/community/feed pelo novo
//
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// BLOCO 1 — MIGRATIONS SQL
// Adicionar após: await pool.query(communitySchemaSql) ou similar
// =============================================================================
export const feedV2SchemaSql = `
-- ── Impressões: quais posts o usuário viu, por quanto tempo e com qual reação ──
CREATE TABLE IF NOT EXISTS post_impressions (
  user_id        INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id        INTEGER  NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count     SMALLINT NOT NULL DEFAULT 1,
  total_dwell_ms INTEGER  NOT NULL DEFAULT 0,  -- milissegundos acumulados no viewport
  -- 0=só viu | 1=pausou>5s | 2=curtiu | 3=comentou | 4=repostou | 5=salvou
  max_reaction   SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_impressions_user ON post_impressions(user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_impressions_post ON post_impressions(post_id);

-- ── Salvar posts (bookmarks) — sinal de maior qualidade de interesse ──────────
CREATE TABLE IF NOT EXISTS post_saves (
  post_id    INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_saves_user ON post_saves(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saves_post ON post_saves(post_id);

-- ── "Não tenho interesse" — suprime post específico ou todo o autor do feed ──
CREATE TABLE IF NOT EXISTS feed_not_interested (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('post', 'author')),
  post_id     INTEGER     REFERENCES user_posts(id) ON DELETE CASCADE,
  author_id   INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fni_user_post   ON feed_not_interested(user_id, post_id)   WHERE post_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fni_user_author ON feed_not_interested(user_id, author_id)  WHERE author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fni_user ON feed_not_interested(user_id);

-- ── Trigger de afinidade para saves (+3.0 — sinal mais forte que like ou comentário) ──
CREATE OR REPLACE FUNCTION fa_post_saves_affinity_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fa_apply_tag_affinity(NEW.user_id, NEW.post_id, 3.0);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM fa_apply_tag_affinity(OLD.user_id, OLD.post_id, -3.0);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_saves_affinity ON post_saves;
CREATE TRIGGER trg_post_saves_affinity
AFTER INSERT OR DELETE ON post_saves
FOR EACH ROW EXECUTE FUNCTION fa_post_saves_affinity_trigger();
`;

// =============================================================================
// BLOCO 2 — RATE LIMITER
// Adicionar junto aos outros rate limiters (postLimiter, uploadLimiter, etc.)
// =============================================================================
//
// const impressionLimiter = rateLimit({
//   windowMs: 60 * 1000,
//   limit: 60,
//   keyGenerator: (req) => String(req.user?.sub || req.ip),
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: { error: 'Limite de impressões atingido.' },
// });
//
// =============================================================================

// =============================================================================
// BLOCO 3 — NOVOS ENDPOINTS
// Adicionar após o DELETE /api/community/posts/:id/like existente
// =============================================================================

// ─── POST /api/community/feed/impressions ─────────────────────────────────────
// Registra em lote os posts vistos, dwell time e nível de engajamento.
// O cliente envia um batch a cada 30s e ao sair da página.
//
// Body: { impressions: [{post_id, dwell_ms, max_reaction}] }
//
// Níveis de max_reaction (definidos pelo cliente):
//   0 = impression pura (viu mas não parou)
//   1 = pausou (dwell > 5s, sem ação explícita)
//   2 = curtiu
//   3 = comentou
//   4 = repostou
//   5 = salvou
export const impressionsEndpoint = (app, auth, pool, impressionLimiter) => {
app.post('/api/community/feed/impressions', auth, impressionLimiter, async (req, res) => {
  const raw = Array.isArray(req.body?.impressions) ? req.body.impressions : [];
  if (!raw.length) return res.json({ ok: true, recorded: 0 });

  // Valida e sanitiza
  const impressions = raw
    .filter(imp => Number.isInteger(Number(imp.post_id)) && Number(imp.post_id) > 0)
    .slice(0, 100) // máximo 100 por batch
    .map(imp => ({
      post_id:      Number(imp.post_id),
      dwell_ms:     Math.max(0, Math.min(300_000, Number(imp.dwell_ms) || 0)), // máx 5min
      max_reaction: Math.max(0, Math.min(5,       Number(imp.max_reaction) || 0)),
    }));

  if (!impressions.length) return res.json({ ok: true, recorded: 0 });

  const userId = req.user.sub;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const imp of impressions) {
      // Upsert: atualiza se já existe, senão insere
      await client.query(`
        INSERT INTO post_impressions
          (user_id, post_id, first_seen_at, last_seen_at, view_count, total_dwell_ms, max_reaction)
        VALUES ($1, $2, NOW(), NOW(), 1, $3, $4)
        ON CONFLICT (user_id, post_id) DO UPDATE
          SET last_seen_at   = NOW(),
              view_count     = post_impressions.view_count + 1,
              total_dwell_ms = post_impressions.total_dwell_ms + $3,
              max_reaction   = GREATEST(post_impressions.max_reaction, $4)
      `, [userId, imp.post_id, imp.dwell_ms, imp.max_reaction]);

      // Afinidade passiva: leu com atenção mas não interagiu explicitamente.
      // Sinal fraco (+0.3) — indica interesse sem compromisso.
      // Só aplicamos se ainda não teve interação (max_reaction < 2).
      if (imp.dwell_ms >= 8_000 && imp.max_reaction < 2) {
        await client.query(
          'SELECT fa_apply_tag_affinity($1, $2, $3)',
          [userId, imp.post_id, 0.3],
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, recorded: impressions.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /api/community/feed/impressions]', e);
    res.status(500).json({ error: 'Erro ao registrar impressoes.' });
  } finally {
    client.release();
  }
});
};

// ─── POST /api/community/posts/:id/save ─────────────────────────────────────
// Salva um post (bookmark). Dispara trigger de afinidade (+3.0).
export const savePostEndpoint = (app, auth, pool) => {
app.post('/api/community/posts/:id/save', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });

  try {
    const { rowCount } = await pool.query(
      'INSERT INTO post_saves(post_id, user_id) VALUES($1, $2) ON CONFLICT DO NOTHING',
      [postId, req.user.sub],
    );

    // Registra como impressão de máxima qualidade (max_reaction=5)
    if (rowCount > 0) {
      await pool.query(`
        INSERT INTO post_impressions(user_id, post_id, max_reaction, first_seen_at, last_seen_at)
        VALUES($1, $2, 5, NOW(), NOW())
        ON CONFLICT (user_id, post_id) DO UPDATE
          SET max_reaction = GREATEST(post_impressions.max_reaction, 5),
              last_seen_at = NOW()
      `, [req.user.sub, postId]);
    }

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS saves_count FROM post_saves WHERE post_id=$1',
      [postId],
    );
    res.json({ ok: true, saved: rowCount > 0, saves_count: rows[0]?.saves_count ?? 0 });
  } catch (e) {
    console.error('[POST /api/community/posts/:id/save]', e);
    res.status(500).json({ error: 'Erro ao salvar post.' });
  }
});
};

// ─── DELETE /api/community/posts/:id/save ───────────────────────────────────
export const unsavePostEndpoint = (app, auth, pool) => {
app.delete('/api/community/posts/:id/save', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM post_saves WHERE post_id=$1 AND user_id=$2',
      [postId, req.user.sub],
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS saves_count FROM post_saves WHERE post_id=$1',
      [postId],
    );
    res.json({ ok: true, removed: rowCount > 0, saves_count: rows[0]?.saves_count ?? 0 });
  } catch (e) {
    console.error('[DELETE /api/community/posts/:id/save]', e);
    res.status(500).json({ error: 'Erro ao remover save.' });
  }
});
};

// ─── POST /api/community/posts/:id/not-interested ───────────────────────────
// scope: 'post' (padrão) → esconde este post específico
// scope: 'author' → esconde todos os posts deste autor no feed
export const notInterestedEndpoint = (app, auth, pool) => {
app.post('/api/community/posts/:id/not-interested', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  const scope = req.body?.scope === 'author' ? 'author' : 'post';

  try {
    if (scope === 'author') {
      const { rows } = await pool.query(
        'SELECT author_id FROM user_posts WHERE id=$1 LIMIT 1',
        [postId],
      );
      if (!rows.length) return res.status(404).json({ error: 'Post nao encontrado' });
      await pool.query(`
        INSERT INTO feed_not_interested(user_id, target_type, author_id)
        VALUES($1, 'author', $2)
        ON CONFLICT (user_id, author_id) WHERE author_id IS NOT NULL DO NOTHING
      `, [req.user.sub, rows[0].author_id]);
    } else {
      await pool.query(`
        INSERT INTO feed_not_interested(user_id, target_type, post_id)
        VALUES($1, 'post', $2)
        ON CONFLICT (user_id, post_id) WHERE post_id IS NOT NULL DO NOTHING
      `, [req.user.sub, postId]);
    }
    res.json({ ok: true, scope });
  } catch (e) {
    console.error('[POST /api/community/posts/:id/not-interested]', e);
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
});
};

// ─── DELETE /api/community/posts/:id/not-interested ─────────────────────────
export const undoNotInterestedEndpoint = (app, auth, pool) => {
app.delete('/api/community/posts/:id/not-interested', auth, async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!postId) return res.status(400).json({ error: 'ID invalido' });
  try {
    await pool.query(
      "DELETE FROM feed_not_interested WHERE user_id=$1 AND post_id=$2 AND target_type='post'",
      [req.user.sub, postId],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/community/posts/:id/not-interested]', e);
    res.status(500).json({ error: 'Erro ao remover.' });
  }
});
};

// =============================================================================
// BLOCO 4 — ENDPOINT PRINCIPAL: GET /api/community/feed (SUBSTITUIÇÃO TOTAL)
// =============================================================================
//
// FÓRMULA DO HOT_SCORE:
//
//   hot_score =
//     ( engagement_score × velocity_mult × affinity_mult × social_mult × media_mult )
//     ─────────────────────────────────────────────────────────────────────────────── × session_noise × seen_penalty
//                               temporal_gravity
//
//   Depois, author_diversity_penalty divide posts do mesmo autor na página:
//     1º post → ÷1.0  |  2º post → ÷2.5  |  3º+ → ÷9.0
//
// NOVOS PARÂMETROS DO CLIENTE (além dos existentes):
//   session_seed   : string aleatória gerada 1× por sessão (crypto.randomUUID())
//                    → garante jitter diferente a cada abertura do app
//   is_new_session : "true" na primeira carga de cada sessão
//                    → exclui posts já vistos sem engajamento nas últimas 48h
//
// SINAIS NOVOS VS. VERSÃO ANTERIOR:
//   ✅ Reposts no cálculo de engajamento (era ignorado)
//   ✅ Saves (peso 6.0 — sinal mais forte de qualidade)
//   ✅ Votos em enquetes (peso 2.0)
//   ✅ Velocidade: curtidas na última 1h/6h (posts em alta agora)
//   ✅ Afinidade passiva: dwell longo sem interação (+0.3 via endpoint)
//   ✅ Penalidade de visualização (posts já vistos saem do feed)
//   ✅ Exclusão de nova sessão (posts sem engajamento invisíveis por 48h)
//   ✅ Bônus de mídia: posts com imagens/enquetes (+15%/+10%)
//   ✅ Freshness boost: posts < 2h de quem sigo recebem 2.2× social
//   ✅ Gravidade temporal diferenciada: posts de seguidos decaem mais lento
//   ✅ Session noise com seed aleatório (jitter varia a cada sessão)
//   ✅ Author diversity mais agressivo (3º post penalizado 9×)
//   ✅ Supressão "não tenho interesse" por post ou autor
//   ✅ saved_by_me na resposta (frontend pode mostrar botão salvo)
//
export const feedV2Endpoint = (app, auth, pool, { clampInt, sanitize, primaryIntegrationFieldsSql, socialRankSql, socialMeritSql }) => {

app.get('/api/community/feed', auth, async (req, res) => {
  const limit          = clampInt(req.query.limit, 20, 1, 50);
  const filter         = req.query.filter || 'all';
  const isNewSession   = req.query.is_new_session === 'true';

  // evaluation_timestamp: âncora temporal fixa durante o scroll da sessão atual.
  // Evita que posts "pulem" de posição enquanto o usuário rola para baixo.
  const rawEvaluation = String(req.query.evaluation_timestamp || '').trim();
  const evaluationDate = rawEvaluation ? new Date(rawEvaluation) : new Date();
  if (!Number.isFinite(evaluationDate.getTime())) {
    return res.status(400).json({ error: 'evaluation_timestamp invalido' });
  }
  const evaluationTimestamp = evaluationDate.toISOString();

  // session_seed: string aleatória gerada pelo cliente 1× por sessão.
  // É usada apenas para o jitter — garante feed visualmente diferente a cada abertura.
  const sessionSeed = sanitize(
    String(req.query.session_seed || req.user.sub + '-' + evaluationTimestamp),
  ).slice(0, 128);

  // Cursor de paginação keyset (score decrescente, id desempate)
  let cursorScore = null;
  let cursorId    = null;
  const hasCursor = req.query.cursor_score !== undefined || req.query.cursor_id !== undefined;
  if (hasCursor) {
    cursorScore = Number(req.query.cursor_score);
    cursorId    = parseInt(req.query.cursor_id, 10);
    if (!Number.isFinite(cursorScore) || !cursorId) {
      return res.status(400).json({ error: 'Cursor invalido' });
    }
  }

  const search  = req.query.search  ? `%${sanitize(req.query.search).toLowerCase()}%`                  : null;
  const hashtag = req.query.hashtag ? sanitize(req.query.hashtag).replace(/^#/, '').toLowerCase() : null;

  // $1 = userId, $2 = limit+1, $3 = evalTs, $4 = cursorScore, $5 = cursorId, $6 = sessionSeed
  const params = [req.user.sub, limit + 1, evaluationTimestamp, cursorScore, cursorId, sessionSeed];

  // ── Condições WHERE da base ─────────────────────────────────────────────────
  const conditions = [
    // Bloqueios mútuos (usuário ou autor)
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
    // "Não tenho interesse": suprime post específico ou todos os posts do autor
    `NOT EXISTS (
       SELECT 1 FROM feed_not_interested fni
       WHERE fni.user_id = $1
         AND (
           (fni.target_type = 'post'   AND fni.post_id   = COALESCE(p.repost_of_id, p.id))
           OR (fni.target_type = 'author' AND fni.author_id = p.author_id)
         )
    )`,
  ];

  // Nova sessão: exclui posts já vistos sem engajamento nas últimas 48h.
  // Efeito: ao abrir o app, o usuário vê conteúdo fresco — não os mesmos posts de ontem.
  // Depois de 48h, os posts voltam a aparecer (se ainda tiverem pontuação alta).
  if (isNewSession) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM post_impressions pi_excl
      WHERE pi_excl.user_id  = $1
        AND pi_excl.post_id  = COALESCE(p.repost_of_id, p.id)
        AND pi_excl.max_reaction < 2
        AND pi_excl.last_seen_at > NOW() - INTERVAL '48 hours'
    )`);
  }

  if (filter === 'following') {
    conditions.push(
      `(p.author_id IN (SELECT following_id FROM user_follows WHERE follower_id = $1) OR p.author_id = $1)`,
    );
  }

  if (search) {
    params.push(search);
    conditions.push(`(
      LOWER(p.content) LIKE $${params.length}
      OR LOWER(COALESCE(op.content, '')) LIKE $${params.length}
      OR LOWER(COALESCE(u.minecraft_name, u.username, '')) LIKE $${params.length}
      OR LOWER(COALESCE(ou.minecraft_name, ou.username, '')) LIKE $${params.length}
    )`);
  }

  if (hashtag) {
    params.push(hashtag);
    conditions.push(`EXISTS (
      SELECT 1
      FROM regexp_matches(
        COALESCE(p.content, '') || ' ' || COALESCE(op.content, ''),
        '#([[:alnum:]_]{2,32})', 'g'
      ) AS hx(tag_match)
      WHERE LOWER(hx.tag_match[1]) = $${params.length}
    )`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await pool.query(`
      WITH base AS (
        -- ── CTE BASE: join de todos os dados estruturais do post ──────────────
        SELECT
               p.id, p.content, p.media_urls, p.created_at, p.updated_at,
               p.edit_count, p.is_pinned, p.pinned_at, p.created_by_user_id, p.repost_of_id,
               COALESCE(p.repost_of_id, p.id)         AS target_id,
               COALESCE(op.content, p.content)        AS target_content,
               op.content                             AS repost_original_content,
               op.media_urls                          AS repost_original_media_urls,
               op.created_at                          AS repost_original_created_at,
               ou.id                                  AS repost_original_author_id,
               ou.username                            AS repost_original_username,
               ou.minecraft_name                      AS repost_original_minecraft_name,
               ou.photo_url                           AS repost_original_photo_url,
               COALESCE(oup.display_name, '')         AS repost_original_display_name,
               COALESCE(oup.avatar_url,   '')         AS repost_original_avatar_url,
               ou.role                                AS repost_original_role,
               ${primaryIntegrationFieldsSql('ou')}   AS repost_original_integration,
               ${socialRankSql('ou', 'opb')}          AS repost_original_rank,
               ${socialMeritSql('ou', 'opb')}         AS repost_original_merit,
               u.id AS author_id, u.username, u.minecraft_name, u.photo_url, u.role,
               u.is_platform_verified,
               ou.is_platform_verified                AS repost_original_is_platform_verified,
               COALESCE(up.display_name, '')          AS display_name,
               COALESCE(up.avatar_url,   '')          AS avatar_url,
               COALESCE(up.cover_url,    '')          AS cover_url,
               ${primaryIntegrationFieldsSql('u')}    AS integration,
               ${socialRankSql('u', 'pb')}            AS rank,
               ${socialMeritSql('u', 'pb')}           AS merit,
               -- Sinal de conexão social (seguindo o autor?)
               EXISTS(
                 SELECT 1 FROM user_follows uf
                 WHERE uf.follower_id = $1 AND uf.following_id = p.author_id
               ) AS is_following,
               -- Posts com mídia visual recebem bônus de engajamento
               (array_length(COALESCE(p.media_urls, '{}'::text[]), 1) > 0) AS has_media,
               -- Posts com enquete recebem bônus menor (interação ativa)
               EXISTS(
                 SELECT 1 FROM post_polls pp
                 WHERE pp.post_id = COALESCE(p.repost_of_id, p.id)
               ) AS has_poll
        FROM user_posts p
        JOIN  users            u   ON  p.author_id    = u.id
        LEFT JOIN user_preferences up  ON  up.user_id    = u.id
        LEFT JOIN player_balances  pb  ON  LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
        LEFT JOIN user_posts       op  ON  op.id         = p.repost_of_id
        LEFT JOIN users            ou  ON  ou.id         = op.author_id
        LEFT JOIN user_preferences oup ON  oup.user_id   = ou.id
        LEFT JOIN player_balances  opb ON  LOWER(opb.minecraft_name) = LOWER(ou.minecraft_name)
        ${whereClause}
      ),

      metrics AS (
        -- ── CTE MÉTRICAS: agrega todos os sinais de engajamento ────────────────
        SELECT b.*,
               COALESCE(likes_agg.n,      0)::int            AS likes_count,
               COALESCE(comments_agg.n,   0)::int            AS comments_count,
               COALESCE(reposts_agg.n,    0)::int            AS reposts_count,
               COALESCE(saves_agg.n,      0)::int            AS saves_count,
               COALESCE(pv_agg.n,         0)::int            AS poll_votes_count,
               COALESCE(aff_agg.affinity, 0)::double precision AS affinity_sum,
               -- Velocidade: curtidas por janela de tempo (detecta posts em alta agora)
               COALESCE(vel.likes_1h,     0)::int            AS likes_1h,
               COALESCE(vel.likes_6h,     0)::int            AS likes_6h,
               -- Dados de impressão: histórico pessoal deste usuário com este post
               imp.view_count     AS imp_view_count,
               imp.total_dwell_ms AS imp_dwell_ms,
               imp.max_reaction   AS imp_max_reaction

        FROM base b

        -- Curtidas totais
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n
          FROM post_likes pl WHERE pl.post_id = b.target_id
        ) likes_agg ON TRUE

        -- Comentários ativos
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n
          FROM post_comments pc
          WHERE pc.post_id = b.target_id AND pc.is_deleted = FALSE
        ) comments_agg ON TRUE

        -- Reposts totais
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n
          FROM user_posts rp WHERE rp.repost_of_id = b.target_id
        ) reposts_agg ON TRUE

        -- Saves / bookmarks (sinal de maior qualidade)
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n
          FROM post_saves ps WHERE ps.post_id = b.target_id
        ) saves_agg ON TRUE

        -- Votos em enquetes (interação explícita e intencional)
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ppo.votes_count), 0)::int AS n
          FROM post_polls       pp
          JOIN post_poll_options ppo ON ppo.poll_id = pp.id
          WHERE pp.post_id = b.target_id
        ) pv_agg ON TRUE

        -- Afinidade por hashtag: soma das pontuações das tags do post que o usuário já interagiu
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(uta.affinity_score), 0)::double precision AS affinity
          FROM (
            SELECT DISTINCT LOWER(rx.tag_match[1]) AS tag
            FROM regexp_matches(
              COALESCE(b.target_content, ''),
              '#([[:alnum:]_]{2,32})', 'g'
            ) AS rx(tag_match)
          ) tags
          JOIN user_tag_affinity uta ON uta.user_id = $1 AND uta.tag = tags.tag
        ) aff_agg ON TRUE

        -- Velocidade: crescimento recente (posts que estão ganhando tração AGORA)
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE pl.created_at > NOW() - INTERVAL '1 hour' )::int AS likes_1h,
            COUNT(*) FILTER (WHERE pl.created_at > NOW() - INTERVAL '6 hours')::int AS likes_6h
          FROM post_likes pl WHERE pl.post_id = b.target_id
        ) vel ON TRUE

        -- Impressões: quantas vezes o usuário viu este post e como interagiu
        LEFT JOIN post_impressions imp
          ON imp.user_id = $1 AND imp.post_id = b.target_id
      ),

      scored AS (
        -- ── CTE SCORE: calcula cada componente do hot_score ─────────────────────
        SELECT m.*,

          -- ① ENGAJAMENTO LOGARÍTMICO (multi-sinal)
          -- Pesos calibrados pelo custo de intenção de cada ação:
          --   Salvar (6.0) > Repostar (5.0) > Comentar (3.5) > Votar (2.0) > Curtir (1.5)
          -- Log evita que posts virais dominem infinitamente.
          (LOG(GREATEST(1.0,
            (m.likes_count      * 1.5) +
            (m.comments_count   * 3.5) +
            (m.reposts_count    * 5.0) +
            (m.saves_count      * 6.0) +
            (m.poll_votes_count * 2.0)
          )) + 1.0)::double precision AS engagement_score,

          -- ② VELOCIDADE (posts ganhando tração agora)
          -- Detecta crescimento acelerado e dá um impulso temporário.
          -- Decai naturalmente com a gravidade temporal quando o hype passa.
          (1.0 + LOG(GREATEST(1.0,
            (m.likes_1h * 5.0) + (m.likes_6h * 2.0)
          )) * 0.4)::double precision AS velocity_mult,

          -- ③ AFINIDADE POR HASHTAG (personalização por interesse)
          -- Soma das pontuações de afinidade do usuário com as tags do post.
          -- Multiplicador de 0.25 (acima do 0.2 original) para personalização mais forte.
          -- Nunca cria bolha: posts sem tags conhecidas ainda têm multiplicador 1.0.
          (1.0 + (COALESCE(m.affinity_sum, 0) * 0.25))::double precision AS affinity_mult,

          -- ④ SINAL SOCIAL (seguindo o autor + frescor)
          -- Posts muito recentes de quem sigo recebem um boost forte (não fique por ver!).
          -- Posts mais antigos de seguidos: boost moderado.
          -- Descoberta (não segue): sem boost, compete pela qualidade pura.
          (CASE
            WHEN m.is_following
                 AND EXTRACT(EPOCH FROM ($3::timestamptz - m.created_at)) / 3600.0 < 2.0
              THEN 2.2   -- Post fresquíssimo de quem sigo: máxima prioridade
            WHEN m.is_following
              THEN 1.6   -- Post de quem sigo (qualquer idade)
            ELSE 1.0     -- Descoberta: sem bônus social
          END)::double precision AS social_mult,

          -- ⑤ BÔNUS DE MÍDIA (conteúdo visual/interativo retém mais atenção)
          -- Pesquisa indica que imagens aumentam dwell time em ~35%.
          -- Enquetes têm interação explícita, também valem um bônus menor.
          (CASE
            WHEN m.has_media THEN 1.15
            WHEN m.has_poll  THEN 1.10
            ELSE 1.0
          END)::double precision AS media_mult,

          -- ⑥ GRAVIDADE TEMPORAL (decay estilo HackerNews, diferenciado por relação)
          -- Posts de seguidos decaem MAIS DEVAGAR (expoente 1.55 vs 1.90).
          -- Efeito: posts antigos de quem sigo ainda aparecem; post viral de desconhecido some rápido.
          -- +2h no denominador: evita divisão por zero para posts com < 1h de vida.
          POWER(
            GREATEST(0.0, EXTRACT(EPOCH FROM ($3::timestamptz - m.created_at)) / 3600.0 + 2.0),
            CASE WHEN m.is_following THEN 1.55 ELSE 1.90 END
          )::double precision AS temporal_gravity,

          -- ⑦ PENALIDADE DE VISUALIZAÇÃO (coração do sistema "sem repetição")
          -- Posts já vistos são progressivamente suprimidos com base em:
          --   a) número de vezes que o usuário os viu
          --   b) se parou para ler (dwell_ms)
          --   c) qual foi a máxima interação realizada
          -- Efeito: posts nunca vistos têm score máximo (×1.0).
          -- Posts vistos e salvos/repostados ainda aparecem raramente (×0.20).
          -- Posts vistos e ignorados 3+ vezes praticamente somem (×0.02).
          (CASE
            WHEN m.imp_view_count IS NULL THEN 1.00  -- nunca viu: sem penalidade
            WHEN m.imp_max_reaction >= 4  THEN 0.20  -- repostou ou salvou: aparece bem raramente
            WHEN m.imp_max_reaction >= 2  THEN 0.12  -- curtiu ou comentou: aparece muito raramente
            WHEN m.imp_dwell_ms > 5000    THEN 0.05  -- leu >5s sem interagir: quase esconde
            WHEN m.imp_view_count >= 3    THEN 0.02  -- viu 3× sem interagir: praticamente esconde
            ELSE                               0.07  -- passou por cima sem parar
          END)::double precision AS seen_penalty,

          -- ⑧ RUÍDO DE SESSÃO (garante feed diferente a cada abertura)
          -- Usa session_seed (gerado aleatoriamente pelo cliente por sessão)
          -- em vez do evaluation_timestamp (que é quase idêntico a cada reload).
          -- Amplitude: ±12.5% → jitter de 25% total.
          -- Deterministico por (post_id + session_seed) → paginação keyset não duplica posts.
          (1.0 + ((MOD(
            ABS(hashtext(m.id::text || ':' || $6::text))::bigint,
            100000
          )::double precision / 100000.0) * 0.25))::double precision AS session_noise

        FROM metrics m
      ),

      raw_score AS (
        -- ── CTE RAW_SCORE: combina todos os componentes ───────────────────────
        SELECT s.*,
          -- Fórmula final combinada:
          -- (engajamento × velocidade × afinidade × social × mídia) / gravidade × ruído × penalidade
          (
            (s.engagement_score *
             s.velocity_mult    *
             s.affinity_mult    *
             s.social_mult      *
             s.media_mult)
            / s.temporal_gravity
          )
          * s.session_noise
          * s.seen_penalty
          AS raw_hot_score
        FROM scored s
      ),

      author_ranked AS (
        -- ── CTE DIVERSIDADE DE AUTORES ────────────────────────────────────────
        -- Ranqueia posts de cada autor separadamente para calcular quantos
        -- posts do mesmo autor já apareceram na página atual.
        SELECT r.*,
          ROW_NUMBER() OVER (
            PARTITION BY r.author_id
            ORDER BY r.raw_hot_score DESC, r.id DESC
          ) AS author_diversity_rank
        FROM raw_score r
      ),

      final AS (
        -- ── CTE FINAL: aplica penalidade de diversidade de autores ─────────────
        -- 1º post do autor: sem penalidade (compete livremente).
        -- 2º post: pontuação dividida por 2.5 (penalidade moderada).
        -- 3º+ post: pontuação dividida por 9.0 (rarissimamente aparece).
        -- Efeito: feed varia muito mais em termos de perfis exibidos.
        SELECT a.*,
          (a.raw_hot_score / CASE
            WHEN a.author_diversity_rank = 1 THEN 1.0
            WHEN a.author_diversity_rank = 2 THEN 2.5
            ELSE                                  9.0
          END)::double precision AS hot_score
        FROM author_ranked a
      )

      -- ── SELECT FINAL ──────────────────────────────────────────────────────────
      SELECT
             f.id, f.content, f.media_urls, f.created_at, f.updated_at, f.edit_count,
             f.is_pinned, f.pinned_at, f.created_by_user_id, f.repost_of_id,
             f.repost_original_content, f.repost_original_media_urls, f.repost_original_created_at,
             f.repost_original_author_id, f.repost_original_username, f.repost_original_minecraft_name,
             f.repost_original_photo_url, f.repost_original_display_name, f.repost_original_avatar_url,
             f.repost_original_role, f.repost_original_integration,
             f.repost_original_rank, f.repost_original_merit,
             f.likes_count, f.reposts_count, f.comments_count, f.saves_count,
             f.author_id, f.username, f.minecraft_name, f.photo_url, f.role,
             f.is_platform_verified, f.repost_original_is_platform_verified,
             f.display_name, f.avatar_url, f.cover_url, f.integration, f.rank, f.merit,
             -- Ações do usuário atual neste post
             EXISTS(SELECT 1 FROM post_likes pl
                    WHERE pl.post_id = f.target_id AND pl.user_id = $1)                                           AS liked_by_me,
             EXISTS(SELECT 1 FROM user_posts rp
                    WHERE rp.repost_of_id = f.target_id AND rp.author_id = $1 AND rp.content = '')              AS reposted_by_me,
             EXISTS(SELECT 1 FROM post_saves  ps
                    WHERE ps.post_id = f.target_id AND ps.user_id = $1)                                          AS saved_by_me,
             -- Comentários recentes (preview de até 3)
             COALESCE(recent.recent_comments, '[]'::json) AS recent_comments,
             -- Scores de debug (úteis para análise; podem ser removidos em produção)
             f.hot_score, f.engagement_score, f.velocity_mult, f.affinity_mult,
             f.social_mult, f.media_mult, f.temporal_gravity, f.seen_penalty,
             f.session_noise, f.author_diversity_rank,
             f.hot_score::text AS hot_score_cursor,
             -- Enquete associada (se existir)
             poll_lateral.poll_data AS poll

      FROM final f

      -- Preview dos últimos 3 comentários (filtrando bloqueios)
      LEFT JOIN LATERAL (
        SELECT json_agg(row_to_json(rc)) AS recent_comments
        FROM (
          SELECT pc.id, pc.content, pc.created_at, cu.username, cu.minecraft_name
          FROM post_comments pc
          JOIN users cu ON cu.id = pc.author_id
          WHERE pc.post_id = f.target_id
            AND pc.is_deleted = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks cub
              WHERE (cub.blocker_id = $1 AND cub.blocked_id = cu.id)
                 OR (cub.blocker_id = cu.id AND cub.blocked_id = $1)
            )
          ORDER BY pc.created_at DESC
          LIMIT 3
        ) rc
      ) recent ON TRUE

      -- Dados da enquete (se existir)
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'id',           pp.id,
          'ends_at',      pp.ends_at,
          'is_closed',    (pp.ends_at < NOW()),
          'user_vote_id', (SELECT ppv.option_id FROM post_poll_votes ppv
                           WHERE ppv.poll_id = pp.id AND ppv.user_id = $1),
          'options', COALESCE((
            SELECT json_agg(json_build_object(
              'id',    ppo.id,
              'text',  ppo.text,
              'votes', (SELECT COUNT(*)::int FROM post_poll_votes v WHERE v.option_id = ppo.id)
            ) ORDER BY ppo.sort_order)
            FROM post_poll_options ppo WHERE ppo.poll_id = pp.id
          ), '[]'::json)
        ) AS poll_data
        FROM post_polls pp WHERE pp.post_id = f.target_id LIMIT 1
      ) poll_lateral ON TRUE

      -- Cursor de paginação keyset: só retorna posts com score menor que o cursor
      WHERE ($4::double precision IS NULL OR $5::integer IS NULL
             OR (f.hot_score, f.id) < ($4::double precision, $5::integer))
      ORDER BY f.hot_score DESC, f.id DESC
      LIMIT $2
    `, params);

    const page    = rows.slice(0, limit);
    const last    = page.at(-1);
    const hasMore = rows.length > limit;

    res.json({
      posts:                page,
      evaluation_timestamp: evaluationTimestamp,
      session_seed:         sessionSeed,
      next_cursor: hasMore && last
        ? { score: last.hot_score_cursor || String(last.hot_score), id: Number(last.id) }
        : null,
      has_more: hasMore,
    });
  } catch (e) {
    console.error('[GET /api/community/feed v2]', e);
    res.status(500).json({ error: 'Erro ao buscar o feed recomendado.' });
  }
});

}; // fim feedV2Endpoint
