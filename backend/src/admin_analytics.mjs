const clamp = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const periodBounds = (days) => {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const previousStart = new Date(start.getTime() - days * 86400000);
  return { start, end, previousStart };
};

const activityEventsSql = `
  SELECT author_id AS user_id, created_at, 'post'::text AS event_type FROM user_posts
  UNION ALL SELECT author_id, created_at, 'comment' FROM post_comments WHERE is_deleted = FALSE
  UNION ALL SELECT user_id, created_at, 'like' FROM post_likes
  UNION ALL SELECT user_id, created_at, 'save' FROM post_saves
  UNION ALL SELECT user_id, last_seen_at, 'view' FROM post_impressions
  UNION ALL SELECT follower_id, created_at, 'follow' FROM user_follows
  UNION ALL SELECT sender_id, created_at, 'message' FROM direct_messages WHERE is_deleted = FALSE
  UNION ALL SELECT sender_id, created_at, 'message' FROM chat_group_messages WHERE is_deleted = FALSE
`;

export function registerAdminAnalytics(app, pool, auth, requireAdmin) {
  app.get('/api/admin/analytics/command-center', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 30, 7, 180);
    const { start, end, previousStart } = periodBounds(days);
    const params = [start.toISOString(), end.toISOString(), previousStart.toISOString()];

    try {
      const [
        summaryResult,
        dailyResult,
        topContentResult,
        segmentsResult,
        topicsResult,
        formatsResult,
        contributorsResult,
        rankResult,
        peopleResult,
        providersResult,
        cohortsResult,
        serverResult,
      ] = await Promise.all([
        pool.query(`
          WITH events AS (${activityEventsSql}),
          current_active AS (
            SELECT DISTINCT user_id FROM events WHERE created_at >= $1 AND created_at < $2
          ),
          previous_active AS (
            SELECT DISTINCT user_id FROM events WHERE created_at >= $3 AND created_at < $1
          ),
          current_engaged AS (
            SELECT DISTINCT user_id FROM events
            WHERE created_at >= $1 AND created_at < $2 AND event_type NOT IN ('view')
          ),
          new_users AS (
            SELECT id, created_at FROM users WHERE created_at >= $1 AND created_at < $2
          ),
          activated_new_users AS (
            SELECT DISTINCT nu.id
            FROM new_users nu
            JOIN events e ON e.user_id = nu.id
              AND e.created_at >= nu.created_at
              AND e.created_at < nu.created_at + INTERVAL '7 days'
          ),
          current_posts AS (
            SELECT id, author_id, created_at FROM user_posts
            WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NULL
          ),
          first_responses AS (
            SELECT p.id, MIN(c.created_at) AS first_response_at
            FROM current_posts p
            JOIN post_comments c ON c.post_id = p.id AND c.is_deleted = FALSE AND c.author_id <> p.author_id
            GROUP BY p.id
          )
          SELECT
            (SELECT COUNT(*)::int FROM users) AS registered_users,
            (SELECT COUNT(*)::int FROM users WHERE created_at >= $1 AND created_at < $2) AS new_users,
            (SELECT COUNT(*)::int FROM users WHERE created_at >= $3 AND created_at < $1) AS previous_new_users,
            (SELECT COUNT(*)::int FROM current_active) AS active_users,
            (SELECT COUNT(*)::int FROM previous_active) AS previous_active_users,
            (SELECT COUNT(*)::int FROM current_engaged) AS engaged_users,
            (SELECT COUNT(*)::int FROM current_active ca JOIN previous_active pa USING(user_id)) AS retained_users,
            (SELECT COUNT(*)::int FROM events WHERE created_at >= NOW() - INTERVAL '1 day') AS events_1d,
            (SELECT COUNT(DISTINCT user_id)::int FROM events WHERE created_at >= NOW() - INTERVAL '1 day') AS dau,
            (SELECT COUNT(DISTINCT user_id)::int FROM events WHERE created_at >= NOW() - INTERVAL '7 days') AS wau,
            (SELECT COUNT(DISTINCT user_id)::int FROM events WHERE created_at >= NOW() - INTERVAL '30 days') AS mau,
            (SELECT COUNT(*)::int FROM current_posts) AS posts,
            (SELECT COUNT(*)::int FROM user_posts WHERE created_at >= $3 AND created_at < $1 AND repost_of_id IS NULL) AS previous_posts,
            (SELECT COUNT(DISTINCT author_id)::int FROM current_posts) AS creators,
            (SELECT COUNT(*)::int FROM post_comments WHERE created_at >= $1 AND created_at < $2 AND is_deleted = FALSE) AS comments,
            (SELECT COUNT(*)::int FROM post_likes WHERE created_at >= $1 AND created_at < $2) AS likes,
            (SELECT COUNT(*)::int FROM user_posts WHERE created_at >= $1 AND created_at < $2 AND repost_of_id IS NOT NULL) AS reposts,
            (SELECT COUNT(*)::int FROM post_saves WHERE created_at >= $1 AND created_at < $2) AS saves,
            (SELECT COUNT(*)::int FROM post_poll_votes WHERE created_at >= $1 AND created_at < $2) AS poll_votes,
            (SELECT COALESCE(SUM(view_count),0)::int FROM post_impressions WHERE last_seen_at >= $1 AND last_seen_at < $2) AS impressions,
            (SELECT COUNT(DISTINCT user_id)::int FROM post_impressions WHERE last_seen_at >= $1 AND last_seen_at < $2) AS viewers,
            (SELECT COALESCE(AVG(total_dwell_ms),0)::float FROM post_impressions WHERE last_seen_at >= $1 AND last_seen_at < $2) AS avg_dwell_ms,
            (SELECT COUNT(*)::int FROM direct_messages WHERE created_at >= $1 AND created_at < $2 AND is_deleted = FALSE)
              + (SELECT COUNT(*)::int FROM chat_group_messages WHERE created_at >= $1 AND created_at < $2 AND is_deleted = FALSE) AS messages,
            (SELECT COUNT(*)::int FROM user_follows WHERE created_at >= $1 AND created_at < $2) AS new_connections,
            (SELECT COUNT(*)::int FROM user_follows WHERE created_at >= $3 AND created_at < $1) AS previous_new_connections,
            (SELECT COUNT(*)::int FROM user_follows) AS total_connections,
            (SELECT COALESCE(SUM(duration_hours),0)::float FROM player_sessions WHERE entered_at >= $1 AND entered_at < $2) AS play_hours,
            (SELECT COUNT(DISTINCT LOWER(player))::int FROM player_sessions WHERE entered_at >= $1 AND entered_at < $2) AS unique_players,
            (SELECT COUNT(*)::int FROM content_reports WHERE status = 'pending') AS pending_reports,
            (SELECT COUNT(*)::int FROM moderation_queue WHERE status = 'pending') AS pending_moderation,
            (SELECT COUNT(*)::int FROM scheduled_posts WHERE status = 'failed') AS failed_scheduled_posts,
            (SELECT COUNT(*)::int FROM users WHERE is_verified = FALSE) AS unverified_users,
            (SELECT COALESCE(SUM(merit_total),0)::int FROM player_balances) AS total_merit,
            (SELECT COALESCE(SUM(capital_balance),0)::float FROM player_balances) AS total_capital,
            (SELECT COUNT(*)::int FROM activated_new_users) AS activated_new_users,
            (SELECT COUNT(*)::int FROM new_users) AS activation_base,
            (SELECT COUNT(*)::int FROM first_responses) AS responded_posts,
            (SELECT COUNT(*)::int FROM current_posts) AS response_base,
            (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60),0)::float
              FROM first_responses JOIN current_posts USING(id)) AS avg_first_response_minutes,
            (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at)) / 3600),0)::float
              FROM content_reports WHERE reviewed_at >= $1 AND reviewed_at < $2) AS avg_moderation_hours
        `, params),
        pool.query(`
          WITH days AS (
            SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
          ),
          events AS (${activityEventsSql})
          SELECT
            d.day,
            COUNT(DISTINCT e.user_id)::int AS active_users,
            COUNT(*) FILTER (WHERE e.event_type = 'post')::int AS posts,
            COUNT(*) FILTER (WHERE e.event_type IN ('comment','like','save','follow'))::int AS interactions,
            COUNT(*) FILTER (WHERE e.event_type = 'message')::int AS messages,
            COALESCE((SELECT SUM(ps.duration_hours)::float FROM player_sessions ps WHERE ps.entered_at::date = d.day),0) AS play_hours
          FROM days d
          LEFT JOIN events e ON e.created_at::date = d.day
          GROUP BY d.day
          ORDER BY d.day
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          SELECT
            p.id, u.username, u.minecraft_name, COALESCE(up.display_name, '') AS display_name,
            LEFT(REGEXP_REPLACE(p.content, E'[\\n\\r]+', ' ', 'g'), 110) AS preview,
            p.created_at, (array_length(p.media_urls, 1) > 0) AS has_media, p.media_urls[1] AS thumbnail_url,
            COALESCE(i.impressions, 0)::int AS impressions,
            COALESCE(i.viewers, 0)::int AS viewers,
            COALESCE(i.avg_dwell_ms, 0)::float AS avg_dwell_ms,
            COALESCE(l.likes, 0)::int AS likes,
            COALESCE(c.comments, 0)::int AS comments,
            COALESCE(r.reposts, 0)::int AS reposts,
            COALESCE(s.saves, 0)::int AS saves,
            (COALESCE(l.likes,0) + COALESCE(c.comments,0) * 2 + COALESCE(r.reposts,0) * 3 + COALESCE(s.saves,0) * 4)::int AS quality_score
          FROM user_posts p
          JOIN users u ON u.id = p.author_id
          LEFT JOIN user_preferences up ON up.user_id = u.id
          LEFT JOIN LATERAL (
            SELECT SUM(view_count)::int AS impressions, COUNT(DISTINCT user_id)::int AS viewers, AVG(total_dwell_ms)::float AS avg_dwell_ms
            FROM post_impressions WHERE post_id = p.id
          ) i ON TRUE
          LEFT JOIN LATERAL (SELECT COUNT(*)::int AS likes FROM post_likes WHERE post_id = p.id) l ON TRUE
          LEFT JOIN LATERAL (SELECT COUNT(*)::int AS comments FROM post_comments WHERE post_id = p.id AND is_deleted = FALSE) c ON TRUE
          LEFT JOIN LATERAL (SELECT COUNT(*)::int AS reposts FROM user_posts WHERE repost_of_id = p.id) r ON TRUE
          LEFT JOIN LATERAL (SELECT COUNT(*)::int AS saves FROM post_saves WHERE post_id = p.id) s ON TRUE
          WHERE p.created_at >= $1 AND p.created_at < $2 AND p.repost_of_id IS NULL
          ORDER BY quality_score DESC, impressions DESC, p.created_at DESC
          LIMIT 10
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          WITH stats AS (
            SELECT
              u.id,
              (SELECT COUNT(DISTINCT pi.post_id) FROM post_impressions pi WHERE pi.user_id = u.id AND pi.last_seen_at >= $1 AND pi.last_seen_at < $2) AS views,
              (SELECT COUNT(*) FROM user_posts p WHERE p.author_id = u.id AND p.created_at >= $1 AND p.created_at < $2 AND p.repost_of_id IS NULL) AS posts,
              (SELECT COUNT(*) FROM post_comments c WHERE c.author_id = u.id AND c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted = FALSE) AS comments,
              (SELECT COUNT(*) FROM post_likes l WHERE l.user_id = u.id AND l.created_at >= $1 AND l.created_at < $2) AS likes,
              (SELECT COUNT(*) FROM post_saves s WHERE s.user_id = u.id AND s.created_at >= $1 AND s.created_at < $2) AS saves
            FROM users u
          ),
          classified AS (
            SELECT CASE
              WHEN posts >= 3 AND (comments + likes + saves) >= 10 THEN 'champions'
              WHEN posts >= 1 THEN 'creators'
              WHEN (comments + likes + saves) >= 2 THEN 'contributors'
              WHEN views >= 1 THEN 'viewers'
              ELSE 'dormant'
            END AS segment
            FROM stats
          )
          SELECT segment, COUNT(*)::int AS total FROM classified GROUP BY segment
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          WITH tags AS (
            SELECT LOWER(m.tag_match[1]) AS tag, p.id AS post_id
            FROM user_posts p
            CROSS JOIN LATERAL regexp_matches(p.content, '#([[:alnum:]_]{2,32})', 'g') AS m(tag_match)
            WHERE p.created_at >= $1 AND p.created_at < $2 AND p.repost_of_id IS NULL
          )
          SELECT
            tag, COUNT(DISTINCT post_id)::int AS posts,
            COALESCE(SUM((SELECT COUNT(*) FROM post_likes l WHERE l.post_id = tags.post_id)),0)::int
              + COALESCE(SUM((SELECT COUNT(*) * 2 FROM post_comments c WHERE c.post_id = tags.post_id AND c.is_deleted = FALSE)),0)::int AS engagement
          FROM tags
          GROUP BY tag
          ORDER BY engagement DESC, posts DESC
          LIMIT 10
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          WITH performance AS (
            SELECT
              p.id,
              CASE
                WHEN EXISTS(SELECT 1 FROM post_polls pp WHERE pp.post_id = p.id) THEN 'poll'
                WHEN array_length(p.media_urls, 1) > 0 THEN 'media'
                ELSE 'text'
              END AS format,
              (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id)
                + (SELECT COUNT(*) * 2 FROM post_comments c WHERE c.post_id = p.id AND c.is_deleted = FALSE)
                + (SELECT COUNT(*) * 3 FROM user_posts r WHERE r.repost_of_id = p.id)
                + (SELECT COUNT(*) * 4 FROM post_saves s WHERE s.post_id = p.id) AS quality,
              COALESCE((SELECT SUM(view_count) FROM post_impressions i WHERE i.post_id = p.id),0) AS impressions
            FROM user_posts p
            WHERE p.created_at >= $1 AND p.created_at < $2 AND p.repost_of_id IS NULL
          )
          SELECT format, COUNT(*)::int AS posts, COALESCE(AVG(quality),0)::float AS avg_quality,
            COALESCE(AVG(impressions),0)::float AS avg_impressions
          FROM performance GROUP BY format ORDER BY avg_quality DESC
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          SELECT
            u.id, u.username, u.minecraft_name, COALESCE(up.display_name,'') AS display_name,
            activity.posts, activity.comments, activity.connections,
            COALESCE(pb.merit_total,0)::int AS merit,
            (activity.posts * 5 + activity.comments * 2 + activity.connections)::int AS contribution_score
          FROM users u
          LEFT JOIN user_preferences up ON up.user_id = u.id
          LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name) = LOWER(u.minecraft_name)
          CROSS JOIN LATERAL (
            SELECT
              (SELECT COUNT(*)::int FROM user_posts p WHERE p.author_id = u.id AND p.created_at >= $1 AND p.created_at < $2 AND p.repost_of_id IS NULL) AS posts,
              (SELECT COUNT(*)::int FROM post_comments c WHERE c.author_id = u.id AND c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted = FALSE) AS comments,
              (SELECT COUNT(*)::int FROM user_follows f WHERE f.follower_id = u.id AND f.created_at >= $1 AND f.created_at < $2) AS connections
          ) activity
          WHERE activity.posts + activity.comments > 0
          ORDER BY contribution_score DESC, merit DESC
          LIMIT 8
        `, [start.toISOString(), end.toISOString()]),
        pool.query(`
          SELECT LOWER(COALESCE(NULLIF(rank,''),'ferro')) AS rank, COUNT(*)::int AS total,
            COALESCE(SUM(merit_total),0)::int AS merit, COALESCE(SUM(capital_balance),0)::float AS capital
          FROM player_balances GROUP BY LOWER(COALESCE(NULLIF(rank,''),'ferro')) ORDER BY total DESC
        `),
        pool.query(`
          WITH events AS (${activityEventsSql}),
          recent AS (
            SELECT DISTINCT user_id FROM events WHERE created_at >= NOW() - INTERVAL '30 days'
          )
          SELECT
            COUNT(*)::int AS registered,
            COUNT(*) FILTER (WHERE u.is_verified = TRUE)::int AS email_verified,
            COUNT(*) FILTER (WHERE u.is_platform_verified = TRUE)::int AS platform_verified,
            COUNT(*) FILTER (WHERE NULLIF(TRIM(u.minecraft_name),'') IS NOT NULL)::int AS minecraft_linked,
            COUNT(*) FILTER (
              WHERE NULLIF(TRIM(COALESCE(up.display_name,'')),'') IS NOT NULL
                AND NULLIF(TRIM(COALESCE(up.bio,'')),'') IS NOT NULL
                AND NULLIF(TRIM(COALESCE(up.avatar_url,'')),'') IS NOT NULL
            )::int AS complete_profiles,
            COUNT(*) FILTER (WHERE recent.user_id IS NOT NULL)::int AS active_30d,
            COUNT(*) FILTER (WHERE recent.user_id IS NULL)::int AS dormant_30d,
            COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM social_accounts sa WHERE sa.user_id=u.id))::int AS social_connected,
            COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM user_integrations ui WHERE ui.user_id=u.id))::int AS microsoft_connected
          FROM users u
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN recent ON recent.user_id=u.id
          WHERE u.merged_into_user_id IS NULL
        `),
        pool.query(`
          SELECT provider, COUNT(*)::int AS accounts, COUNT(DISTINCT user_id)::int AS users
          FROM (
            SELECT LOWER(provider) AS provider, user_id FROM social_accounts
            UNION ALL
            SELECT 'microsoft' AS provider, user_id FROM user_integrations
          ) connected
          GROUP BY provider
          ORDER BY users DESC, provider ASC
        `),
        pool.query(`
          WITH events AS (${activityEventsSql}),
          cohorts AS (
            SELECT id, created_at, date_trunc('week', created_at)::date AS cohort_week
            FROM users
            WHERE created_at >= NOW() - INTERVAL '70 days'
              AND merged_into_user_id IS NULL
          )
          SELECT
            cohort_week,
            COUNT(*)::int AS joined,
            COUNT(*) FILTER (WHERE EXISTS(
              SELECT 1 FROM events e WHERE e.user_id=cohorts.id
                AND e.created_at >= cohorts.created_at
                AND e.created_at < cohorts.created_at + INTERVAL '7 days'
            ))::int AS activated_7d,
            COUNT(*) FILTER (WHERE EXISTS(
              SELECT 1 FROM events e WHERE e.user_id=cohorts.id
                AND e.created_at >= cohorts.created_at + INTERVAL '7 days'
                AND e.created_at < cohorts.created_at + INTERVAL '30 days'
            ))::int AS retained_30d
          FROM cohorts
          GROUP BY cohort_week
          ORDER BY cohort_week ASC
        `),
        pool.query(`
          WITH current_players AS (
            SELECT DISTINCT LOWER(player) AS player
            FROM player_sessions WHERE entered_at >= $1 AND entered_at < $2
          ),
          previous_players AS (
            SELECT DISTINCT LOWER(player) AS player
            FROM player_sessions WHERE entered_at < $1
          ),
          first_seen AS (
            SELECT LOWER(player) AS player, MIN(entered_at) AS first_seen_at
            FROM player_sessions GROUP BY LOWER(player)
          )
          SELECT
            (SELECT COUNT(*)::int FROM player_sessions WHERE entered_at >= $1 AND entered_at < $2) AS sessions,
            (SELECT COALESCE(AVG(duration_hours),0)::float FROM player_sessions WHERE entered_at >= $1 AND entered_at < $2 AND duration_hours IS NOT NULL) AS avg_session_hours,
            (SELECT COUNT(*)::int FROM current_players) AS unique_players,
            (SELECT COUNT(*)::int FROM current_players cp JOIN previous_players pp USING(player)) AS returning_players,
            (SELECT COUNT(*)::int FROM first_seen WHERE first_seen_at >= $1 AND first_seen_at < $2) AS new_players,
            (SELECT COALESCE(MAX(players_online),0)::int FROM server_status_checks WHERE checked_at >= $1 AND checked_at < $2) AS peak_online,
            (SELECT COALESCE(AVG(latency_ms),0)::float FROM server_status_checks WHERE checked_at >= $1 AND checked_at < $2 AND online=TRUE) AS avg_latency_ms,
            (SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE COUNT(*) FILTER (WHERE online=TRUE)::float / COUNT(*) * 100 END
               FROM server_status_checks WHERE checked_at >= $1 AND checked_at < $2) AS uptime_pct
        `, [start.toISOString(), end.toISOString()]),
      ]);

      const summary = summaryResult.rows[0] || {};
      const interactions = Number(summary.likes || 0) + Number(summary.comments || 0)
        + Number(summary.reposts || 0) + Number(summary.saves || 0) + Number(summary.poll_votes || 0);
      const percentage = (part, total) => Number(total || 0) > 0 ? (Number(part || 0) / Number(total)) * 100 : 0;

      res.json({
        generated_at: end.toISOString(),
        period: { days, start: start.toISOString(), end: end.toISOString(), previous_start: previousStart.toISOString() },
        summary: {
          ...summary,
          interactions,
          engagement_rate: percentage(interactions, summary.impressions),
          retention_rate: percentage(summary.retained_users, summary.previous_active_users),
          activation_rate: percentage(summary.activated_new_users, summary.activation_base),
          response_rate: percentage(summary.responded_posts, summary.response_base),
          dau_mau: percentage(summary.dau, summary.mau),
          wau_mau: percentage(summary.wau, summary.mau),
          engaged_active_rate: percentage(summary.engaged_users, summary.active_users),
          creator_active_rate: percentage(summary.creators, summary.active_users),
          save_rate: percentage(summary.saves, summary.impressions),
          amplification_rate: percentage(summary.reposts, summary.impressions),
          conversation_rate: percentage(summary.comments, summary.impressions),
          interactions_per_post: Number(summary.posts || 0) > 0 ? interactions / Number(summary.posts) : 0,
        },
        daily: dailyResult.rows,
        top_content: topContentResult.rows,
        segments: segmentsResult.rows,
        topics: topicsResult.rows,
        formats: formatsResult.rows,
        contributors: contributorsResult.rows,
        ranks: rankResult.rows,
        people: peopleResult.rows[0] || {},
        providers: providersResult.rows,
        cohorts: cohortsResult.rows,
        server: serverResult.rows[0] || {},
      });
    } catch (error) {
      console.error('[GET /api/admin/analytics/command-center]', error);
      res.status(500).json({ error: 'Erro ao gerar inteligencia operacional.' });
    }
  });
}
