const clamp = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const DASHBOARD_DEFAULTS = {
  server_ip: 'fa.ogabriels.com',
  server_port: 25565,
  maintenance_message: '',
  max_players: 80,
  whitelist_enabled: true,
  moderation_mode: 'ai',
  rank_thresholds: { ferro: 0, ouro: 150, diamante: 500, netherite: 1000 },
  broadcast_max_per_day: 8,
  broadcast_channels: { dashboard: true, push: true, email: false },
};

export const DASHBOARD_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admin_dashboard_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_templates (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  icon VARCHAR(20) DEFAULT 'bell',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_url TEXT;
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_for);
CREATE TABLE IF NOT EXISTS notification_clicks (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(notification_id,user_id)
);
CREATE TABLE IF NOT EXISTS whitelist_queue_attempts (
  id BIGSERIAL PRIMARY KEY,
  queue_id INTEGER NOT NULL REFERENCES whitelist_queue(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_delivered_at TIMESTAMPTZ,
  previous_delivered_by INTEGER REFERENCES app_integration_keys(id) ON DELETE SET NULL,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_whitelist_queue_attempts_queue ON whitelist_queue_attempts(queue_id, attempted_at DESC);
ALTER TABLE moderation_queue ADD COLUMN IF NOT EXISTS ai_confidence FLOAT;
`;

const activityEventsSql = `
  SELECT author_id AS user_id, created_at FROM user_posts
  UNION ALL SELECT author_id, created_at FROM post_comments WHERE is_deleted = FALSE
  UNION ALL SELECT user_id, created_at FROM post_likes
  UNION ALL SELECT user_id, created_at FROM post_saves
  UNION ALL SELECT follower_id, created_at FROM user_follows
  UNION ALL SELECT sender_id, created_at FROM direct_messages WHERE is_deleted = FALSE
  UNION ALL SELECT sender_id, created_at FROM chat_group_messages WHERE is_deleted = FALSE
`;

const jsonData = (res, data, meta) => res.json(meta ? { data, meta } : { data });

function gini(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const sum = sorted.reduce((total, value) => total + value, 0);
  if (!sum) return 0;
  const weighted = sorted.reduce((total, value, index) => total + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * sum) - (sorted.length + 1) / sorted.length;
}

function registerRouteError(label, res, error) {
  console.error(`[dashboard-v2:${label}]`, error);
  res.status(500).json({ error: 'Nao foi possivel carregar os dados solicitados.', code: 'DASHBOARD_V2_ERROR' });
}

export function registerAdminDashboardV2(app, pool, auth, requireAdmin, requireOwner, auditFromReq) {
  const activityHeatmap = async (req, res) => {
    const days = clamp(req.query.days, 30, 7, 180);
    try {
      const { rows } = await pool.query(`
        SELECT EXTRACT(DOW FROM entered_at)::int AS day_of_week,
          EXTRACT(HOUR FROM entered_at)::int AS hour_of_day,
          COUNT(DISTINCT LOWER(player))::int AS unique_players,
          COUNT(*)::int AS sessions,
          COALESCE(SUM(duration_hours), 0)::float AS play_hours
        FROM player_sessions
        WHERE entered_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY 1, 2
        ORDER BY 1, 2
      `, [days]);
      jsonData(res, rows, { days, cells: 168 });
    } catch (error) {
      registerRouteError('activity-heatmap', res, error);
    }
  };

  app.get('/api/admin/analytics/activity-heatmap', auth, requireAdmin, activityHeatmap);
  app.get('/api/admin/server/activity-heatmap', auth, requireAdmin, activityHeatmap);

  app.get('/api/admin/analytics/comparison', auth, requireAdmin, async (req, res) => {
    const primaryDays = clamp(req.query.primary_days || req.query.days, 30, 7, 180);
    const compareDays = clamp(req.query.compare_days || req.query.days, primaryDays, 7, 180);
    try {
      const { rows } = await pool.query(`
        WITH periods AS (
          SELECT 'current'::text AS period, NOW() - ($1::int * INTERVAL '1 day') AS starts_at, NOW() AS ends_at
          UNION ALL
          SELECT 'previous', NOW() - (($1::int + $2::int) * INTERVAL '1 day'), NOW() - ($1::int * INTERVAL '1 day')
        ),
        events AS (${activityEventsSql})
        SELECT p.period,
          COUNT(DISTINCT e.user_id)::int AS active_users,
          COUNT(*) FILTER (WHERE e.created_at IS NOT NULL)::int AS social_events,
          (SELECT COUNT(*)::int FROM user_posts up WHERE up.created_at >= p.starts_at AND up.created_at < p.ends_at AND up.repost_of_id IS NULL) AS posts,
          (SELECT COALESCE(SUM(duration_hours),0)::float FROM player_sessions ps WHERE ps.entered_at >= p.starts_at AND ps.entered_at < p.ends_at) AS play_hours,
          (SELECT COUNT(DISTINCT LOWER(player))::int FROM player_sessions ps WHERE ps.entered_at >= p.starts_at AND ps.entered_at < p.ends_at) AS unique_players
        FROM periods p
        LEFT JOIN events e ON e.created_at >= p.starts_at AND e.created_at < p.ends_at
        GROUP BY p.period, p.starts_at, p.ends_at ORDER BY p.period
      `, [primaryDays, compareDays]);
      jsonData(res, rows, { primary_days: primaryDays, compare_days: compareDays });
    } catch (error) {
      registerRouteError('comparison', res, error);
    }
  });

  app.get('/api/admin/analytics/cohort-retention', auth, requireAdmin, async (req, res) => {
    const weeks = clamp(req.query.weeks, 8, 4, 16);
    try {
      const { rows } = await pool.query(`
        WITH cohort_users AS (
          SELECT id AS user_id, DATE_TRUNC('week', created_at)::date AS cohort_week
          FROM users
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 week')
            AND merged_into_user_id IS NULL
        ),
        activity AS (
          SELECT DISTINCT user_id, DATE_TRUNC('week', created_at)::date AS active_week
          FROM (${activityEventsSql}) events
        ),
        offsets AS (SELECT GENERATE_SERIES(0, $1::int - 1) AS weeks_after)
        SELECT cu.cohort_week, o.weeks_after,
          COUNT(DISTINCT cu.user_id)::int AS cohort_size,
          COUNT(DISTINCT a.user_id)::int AS retained_users,
          CASE WHEN COUNT(DISTINCT cu.user_id) = 0 THEN 0
            ELSE ROUND(COUNT(DISTINCT a.user_id)::numeric / COUNT(DISTINCT cu.user_id) * 100, 1)
          END::float AS retention_pct
        FROM cohort_users cu
        CROSS JOIN offsets o
        LEFT JOIN activity a ON a.user_id = cu.user_id
          AND a.active_week = cu.cohort_week + (o.weeks_after * INTERVAL '1 week')
        WHERE cu.cohort_week + (o.weeks_after * INTERVAL '1 week') <= DATE_TRUNC('week', NOW())
        GROUP BY cu.cohort_week, o.weeks_after
        ORDER BY cu.cohort_week DESC, o.weeks_after
      `, [weeks]);
      jsonData(res, rows, { weeks });
    } catch (error) {
      registerRouteError('cohort-retention', res, error);
    }
  });

  app.get('/api/admin/analytics/churn-risk', auth, requireAdmin, async (req, res) => {
    const limit = clamp(req.query.limit, 20, 5, 100);
    try {
      const { rows } = await pool.query(`
        WITH social_activity AS (${activityEventsSql}),
        social_last AS (
          SELECT user_id, MAX(created_at) AS last_social_at FROM social_activity GROUP BY user_id
        ),
        sessions AS (
          SELECT LOWER(player) AS player,
            MAX(COALESCE(left_at, entered_at)) AS last_server_at,
            COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '28 days')::int AS sessions_4w,
            COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '56 days' AND entered_at < NOW() - INTERVAL '28 days')::int AS sessions_prev_4w,
            COUNT(*) FILTER (WHERE entered_at >= NOW() - INTERVAL '120 days')::int AS sessions_120d
          FROM player_sessions GROUP BY LOWER(player)
        )
        SELECT u.id, u.username, u.minecraft_name, u.photo_url, u.created_at,
          s.last_server_at, sl.last_social_at,
          COALESCE(s.sessions_4w, 0)::int AS sessions_4w,
          COALESCE(s.sessions_prev_4w, 0)::int AS sessions_prev_4w,
          COALESCE(s.sessions_120d, 0)::int AS sessions_120d
        FROM users u
        LEFT JOIN sessions s ON s.player = LOWER(u.minecraft_name)
        LEFT JOIN social_last sl ON sl.user_id = u.id
        WHERE u.merged_into_user_id IS NULL AND u.role = 'limited'
      `);

      const now = Date.now();
      const risk = rows.map((row) => {
        const serverDays = row.last_server_at ? (now - new Date(row.last_server_at).getTime()) / 86400000 : 999;
        const socialDays = row.last_social_at ? (now - new Date(row.last_social_at).getTime()) / 86400000 : 999;
        const abruptStop = Number(row.sessions_prev_4w) >= 8 && Number(row.sessions_4w) <= Math.max(1, Number(row.sessions_prev_4w) * 0.2);
        const declining = Number(row.sessions_prev_4w) > 0 && Number(row.sessions_4w) < Number(row.sessions_prev_4w) * 0.55;
        const score = Math.min(100,
          (serverDays >= 14 ? 40 : serverDays >= 7 ? 20 : 0)
          + (socialDays >= 21 ? 30 : socialDays >= 10 ? 15 : 0)
          + (declining ? 20 : 0)
          + (abruptStop ? 10 : 0));
        const lastActionAt = [row.last_server_at, row.last_social_at].filter(Boolean).sort().at(-1) || row.created_at;
        return { ...row, risk_score: score, last_action_at: lastActionAt, reasons: { server_inactive: serverDays >= 14, social_inactive: socialDays >= 21, declining, abrupt_stop: abruptStop } };
      }).filter((row) => row.risk_score > 0).sort((a, b) => b.risk_score - a.risk_score).slice(0, limit);
      jsonData(res, risk, { total: risk.length });
    } catch (error) {
      registerRouteError('churn-risk', res, error);
    }
  });

  app.get('/api/admin/analytics/economy-overview', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 30, 7, 180);
    try {
      const [balances, flow, meritVelocity, recent, promotions] = await Promise.all([
        pool.query(`
          SELECT pb.minecraft_name, pb.merit_total::int, pb.capital_balance::float, pb.rank,
            COALESCE(SUM(mr.amount) FILTER (WHERE mr.created_at >= NOW() - INTERVAL '7 days'), 0)::int AS weekly_delta
          FROM player_balances pb
          LEFT JOIN merit_records mr ON LOWER(mr.minecraft_name) = LOWER(pb.minecraft_name)
          GROUP BY pb.minecraft_name, pb.merit_total, pb.capital_balance, pb.rank
          ORDER BY pb.merit_total DESC
        `),
        pool.query(`
          WITH days AS (SELECT GENERATE_SERIES((NOW() - ($1::int * INTERVAL '1 day'))::date, NOW()::date, INTERVAL '1 day')::date AS day)
          SELECT d.day,
            COALESCE(SUM(c.amount) FILTER (WHERE c.amount > 0), 0)::float AS credits,
            ABS(COALESCE(SUM(c.amount) FILTER (WHERE c.amount < 0), 0))::float AS debits,
            COALESCE(SUM(c.amount), 0)::float AS net
          FROM days d LEFT JOIN capital_records c ON c.created_at::date = d.day
          GROUP BY d.day ORDER BY d.day
        `, [days]),
        pool.query(`
          SELECT created_at::date AS day, COUNT(*)::int AS transactions, COALESCE(SUM(amount),0)::int AS net_merit
          FROM merit_records WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY created_at::date ORDER BY day
        `, [days]),
        pool.query(`
          SELECT 'capital'::text AS kind, minecraft_name, amount::float, type AS category, description AS reason, created_by_name AS staff, created_at
          FROM capital_records
          UNION ALL
          SELECT 'merit', minecraft_name, amount::float, category, reason, awarded_by_name, created_at FROM merit_records
          ORDER BY created_at DESC LIMIT 20
        `),
        pool.query(`
          SELECT minecraft_name, merit_total::int, rank,
            CASE
              WHEN merit_total < 150 THEN 150
              WHEN merit_total < 500 THEN 500
              WHEN merit_total < 1000 THEN 1000
              ELSE NULL
            END AS next_threshold
          FROM player_balances WHERE merit_total < 1000 ORDER BY merit_total DESC LIMIT 20
        `),
      ]);
      const values = balances.rows.map((row) => Number(row.capital_balance || 0));
      const summary = {
        total_merit: balances.rows.reduce((sum, row) => sum + Number(row.merit_total || 0), 0),
        total_capital: values.reduce((sum, value) => sum + value, 0),
        holders: balances.rows.length,
        gini_index: Number(gini(values).toFixed(4)),
        transactions_per_day_7d: Number((meritVelocity.rows.slice(-7).reduce((sum, row) => sum + Number(row.transactions || 0), 0) / 7).toFixed(1)),
      };
      const distribution = [
        { label: '0-50', total: balances.rows.filter((r) => r.merit_total <= 50).length },
        { label: '51-150', total: balances.rows.filter((r) => r.merit_total > 50 && r.merit_total <= 150).length },
        { label: '151-400', total: balances.rows.filter((r) => r.merit_total > 150 && r.merit_total <= 400).length },
        { label: '400+', total: balances.rows.filter((r) => r.merit_total > 400).length },
      ];
      const rankDistribution = ['ferro', 'ouro', 'diamante', 'netherite'].map((rank) => {
        const members = balances.rows.filter((row) => row.rank === rank);
        return {
          rank,
          total: members.length,
          avg_merit: members.length ? Math.round(members.reduce((sum, row) => sum + Number(row.merit_total || 0), 0) / members.length) : 0,
          avg_capital: members.length ? Number((members.reduce((sum, row) => sum + Number(row.capital_balance || 0), 0) / members.length).toFixed(1)) : 0,
        };
      });
      jsonData(res, {
        summary,
        flow: flow.rows,
        merit_velocity: meritVelocity.rows,
        distribution,
        rank_distribution: rankDistribution,
        leaders: balances.rows.slice(0, 10),
        recent_transactions: recent.rows,
        promotions: promotions.rows,
      });
    } catch (error) {
      registerRouteError('economy-overview', res, error);
    }
  });

  app.get('/api/admin/analytics/staff-performance', auth, requireOwner, async (req, res) => {
    const days = clamp(req.query.days, 30, 7, 180);
    try {
      const { rows } = await pool.query(`
        WITH staff AS (
          SELECT id AS actor_id, username AS actor_name FROM users WHERE role IN ('owner','full')
        ), audit_stats AS (
          SELECT actor_id,
            COALESCE(SUM(action_count),0)::int AS total_actions,
            COALESCE(SUM(action_count) FILTER (WHERE type IN ('moderation','delete') OR action IN ('moderation_review','delete')),0)::int AS moderation_actions,
            COALESCE(SUM(action_count) FILTER (WHERE type IN ('notify','notification_create')),0)::int AS broadcasts,
            COALESCE(SUM(action_count) FILTER (WHERE type IN ('merit','capital') OR action IN ('merit_grant','capital_adjust')),0)::int AS economy_actions,
            COALESCE(SUM(action_count) FILTER (WHERE severity='critical'),0)::int AS critical_actions,
            JSONB_OBJECT_AGG(COALESCE(action,type,'system'), action_count) AS actions_by_category,
            MAX(last_action_at) AS last_action_at
          FROM (
            SELECT actor_id, type, action, severity, COUNT(*)::int AS action_count, MAX(created_at) AS last_action_at
            FROM audit_logs WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY actor_id,type,action,severity
          ) grouped GROUP BY actor_id
        ), report_stats AS (
          SELECT reviewed_by AS actor_id,
            COUNT(*)::int AS reports_reviewed,
            COALESCE(AVG(EXTRACT(EPOCH FROM (reviewed_at-created_at))/3600),0)::float AS avg_report_response_hours
          FROM content_reports WHERE reviewed_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY reviewed_by
        ), moderation_stats AS (
          SELECT reviewed_by AS actor_id,
            COUNT(*)::int AS posts_moderated,
            COUNT(*) FILTER (WHERE status IN ('reviewed','approved','kept'))::int AS posts_approved,
            COUNT(*) FILTER (WHERE status IN ('removed','reviewed_removed'))::int AS posts_removed
          FROM moderation_queue WHERE reviewed_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY reviewed_by
        ), merit_stats AS (
          SELECT awarded_by_id AS actor_id,
            COALESCE(SUM(amount) FILTER (WHERE amount > 0),0)::int AS merit_granted,
            ABS(COALESCE(SUM(amount) FILTER (WHERE amount < 0),0))::int AS merit_removed
          FROM merit_records WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY awarded_by_id
        )
        SELECT s.actor_id,s.actor_name,
          COALESCE(a.total_actions,0)::int AS total_actions,
          COALESCE(a.moderation_actions,0)::int AS moderation_actions,
          COALESCE(a.broadcasts,0)::int AS broadcasts,
          COALESCE(a.economy_actions,0)::int AS economy_actions,
          COALESCE(a.critical_actions,0)::int AS critical_actions,
          COALESCE(a.actions_by_category,'{}'::jsonb) AS actions_by_category,
          COALESCE(r.reports_reviewed,0)::int AS reports_reviewed,
          COALESCE(r.avg_report_response_hours,0)::float AS avg_report_response_hours,
          COALESCE(m.posts_moderated,0)::int AS posts_moderated,
          COALESCE(m.posts_approved,0)::int AS posts_approved,
          COALESCE(m.posts_removed,0)::int AS posts_removed,
          COALESCE(me.merit_granted,0)::int AS merit_granted,
          COALESCE(me.merit_removed,0)::int AS merit_removed,
          a.last_action_at
        FROM staff s
        LEFT JOIN audit_stats a ON a.actor_id=s.actor_id
        LEFT JOIN report_stats r ON r.actor_id=s.actor_id
        LEFT JOIN moderation_stats m ON m.actor_id=s.actor_id
        LEFT JOIN merit_stats me ON me.actor_id=s.actor_id
        ORDER BY total_actions DESC, s.actor_name LIMIT 30
      `, [days]);
      jsonData(res, rows, { days });
    } catch (error) {
      registerRouteError('staff-performance', res, error);
    }
  });

  app.get('/api/admin/users/:id/timeline', auth, requireAdmin, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID invalido.', code: 'INVALID_ID' });
    try {
      const userResult = await pool.query('SELECT id, username, minecraft_name, is_verified, is_platform_verified, created_at FROM users WHERE id=$1', [id]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.', code: 'USER_NOT_FOUND' });
      const mc = user.minecraft_name || '';
      const [session, post, merit, audit, legacy] = await Promise.all([
        pool.query('SELECT MIN(entered_at) AS first_at, MAX(COALESCE(left_at,entered_at)) AS last_at, COUNT(*)::int AS total FROM player_sessions WHERE LOWER(player)=LOWER($1)', [mc]),
        pool.query('SELECT MIN(created_at) AS first_at, COUNT(*)::int AS total FROM user_posts WHERE author_id=$1', [id]),
        pool.query('SELECT created_at AS timestamp, amount, reason, category FROM merit_records WHERE LOWER(minecraft_name)=LOWER($1) ORDER BY created_at DESC LIMIT 20', [mc]),
        pool.query('SELECT created_at AS timestamp, type, message, severity FROM audit_logs WHERE target_id=$1 OR actor_id=$1 ORDER BY created_at DESC LIMIT 40', [id]),
        pool.query('SELECT created_at AS timestamp, executed_at, status, legacy_username, migration_mode FROM account_migrations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [id]),
      ]);
      const events = [
        { type: 'signup', timestamp: user.created_at, label: 'Cadastro criado', detail: `@${user.username}` },
        user.is_verified && { type: 'verified', timestamp: user.created_at, label: 'E-mail verificado' },
        user.is_platform_verified && { type: 'platform_verified', timestamp: user.created_at, label: 'Perfil verificado pela plataforma' },
        session.rows[0]?.first_at && { type: 'first_session', timestamp: session.rows[0].first_at, label: 'Primeira sessao no servidor', detail: `${session.rows[0].total} sessoes registradas` },
        post.rows[0]?.first_at && { type: 'first_post', timestamp: post.rows[0].first_at, label: 'Primeira publicacao', detail: `${post.rows[0].total} publicacoes` },
        ...merit.rows.map((row) => ({ type: 'merit', timestamp: row.timestamp, label: `Merito ${Number(row.amount) >= 0 ? '+' : ''}${row.amount}`, detail: `${row.category}: ${row.reason}` })),
        ...audit.rows.map((row) => ({ type: 'audit', timestamp: row.timestamp, label: row.message || row.type, detail: row.severity })),
        ...legacy.rows.map((row) => ({ type: 'legacy', timestamp: row.executed_at || row.timestamp, label: `Migracao legacy: ${row.status}`, detail: `${row.legacy_username} (${row.migration_mode || 'pendente'})` })),
      ].filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      jsonData(res, events);
    } catch (error) {
      registerRouteError('user-timeline', res, error);
    }
  });

  app.get('/api/admin/server/uptime-timeline', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 30, 1, 90);
    try {
      const { rows } = await pool.query(`
        SELECT DATE_TRUNC('hour', checked_at) AS bucket,
          CASE WHEN COUNT(*) = 0 THEN 0 ELSE ROUND(COUNT(*) FILTER (WHERE online)::numeric / COUNT(*) * 100, 1) END::float AS uptime_pct,
          MAX(players_online)::int AS peak_players,
          AVG(latency_ms) FILTER (WHERE online)::float AS avg_latency_ms
        FROM server_status_checks
        WHERE checked_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY 1 ORDER BY 1
      `, [days]);
      jsonData(res, rows, { days });
    } catch (error) {
      registerRouteError('uptime-timeline', res, error);
    }
  });

  app.get('/api/admin/server/presence', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 28, 7, 90);
    try {
      const { rows } = await pool.query(`
        WITH days AS (
          SELECT GENERATE_SERIES((CURRENT_DATE - ($1::int - 1))::date, CURRENT_DATE, INTERVAL '1 day')::date AS day
        ), unique_players AS (
          SELECT entered_at::date AS day, COUNT(DISTINCT LOWER(player))::int AS unique_players
          FROM player_sessions
          WHERE entered_at >= CURRENT_DATE - ($1::int - 1)
          GROUP BY entered_at::date
        ), samples AS (
          SELECT d.day, point
          FROM days d
          CROSS JOIN LATERAL GENERATE_SERIES(d.day::timestamptz, d.day::timestamptz + INTERVAL '23 hours 45 minutes', INTERVAL '15 minutes') point
        ), concurrency AS (
          SELECT s.day, s.point, COUNT(ps.player)::int AS players_online
          FROM samples s
          LEFT JOIN player_sessions ps
            ON ps.entered_at <= s.point
           AND COALESCE(ps.left_at, NOW()) > s.point
          GROUP BY s.day, s.point
        )
        SELECT d.day,
          COALESCE(u.unique_players,0)::int AS unique_players,
          COALESCE(MAX(c.players_online),0)::int AS peak_players
        FROM days d
        LEFT JOIN unique_players u ON u.day=d.day
        LEFT JOIN concurrency c ON c.day=d.day
        GROUP BY d.day,u.unique_players
        ORDER BY d.day
      `, [days]);
      jsonData(res, rows, { days, sample_minutes: 15 });
    } catch (error) {
      registerRouteError('server-presence', res, error);
    }
  });

  app.get('/api/admin/scheduled-posts', auth, requireAdmin, async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT sp.*, u.username, u.minecraft_name, COALESCE(up.display_name, '') AS display_name
        FROM scheduled_posts sp
        JOIN users u ON u.id = sp.author_id
        LEFT JOIN user_preferences up ON up.user_id = u.id
        ORDER BY sp.publish_at DESC LIMIT 500
      `);
      jsonData(res, rows);
    } catch (error) {
      registerRouteError('scheduled-posts', res, error);
    }
  });

  app.post('/api/admin/scheduled-posts/:id/retry', auth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE scheduled_posts SET status='scheduled', failure_reason=NULL,
          publish_at=GREATEST(COALESCE($2::timestamptz, publish_at), NOW() + INTERVAL '30 seconds'), updated_at=NOW()
        WHERE id=$1 AND status IN ('failed','cancelled') RETURNING *
      `, [req.params.id, req.body?.publish_at || null]);
      if (!rows.length) return res.status(404).json({ error: 'Agendamento nao encontrado.', code: 'POST_NOT_FOUND' });
      jsonData(res, rows[0]);
    } catch (error) {
      registerRouteError('scheduled-post-retry', res, error);
    }
  });

  app.get('/api/admin/players/directory', auth, requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT u.id, u.username, CASE WHEN $1='owner' THEN u.email ELSE NULL END AS email, u.minecraft_name, u.photo_url, u.role, u.is_verified, u.is_platform_verified, u.created_at,
          COALESCE(pb.merit_total,0)::int AS merit, COALESCE(pb.capital_balance,0)::float AS capital, COALESCE(pb.rank,'ferro') AS rank,
          s.last_seen, COALESCE(s.sessions,0)::int AS sessions, COALESCE(s.total_hours,0)::float AS total_hours,
          COALESCE(p.posts,0)::int AS posts, COALESCE(c.comments,0)::int AS comments,
          GREATEST(COALESCE(s.last_seen,'epoch'), COALESCE(p.last_post,'epoch'), COALESCE(c.last_comment,'epoch')) AS last_activity
        FROM users u
        LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name)=LOWER(u.minecraft_name)
        LEFT JOIN LATERAL (SELECT MAX(COALESCE(left_at,entered_at)) AS last_seen, COUNT(*) AS sessions, SUM(duration_hours) AS total_hours FROM player_sessions WHERE LOWER(player)=LOWER(u.minecraft_name)) s ON TRUE
        LEFT JOIN LATERAL (SELECT COUNT(*) AS posts, MAX(created_at) AS last_post FROM user_posts WHERE author_id=u.id AND repost_of_id IS NULL) p ON TRUE
        LEFT JOIN LATERAL (SELECT COUNT(*) AS comments, MAX(created_at) AS last_comment FROM post_comments WHERE author_id=u.id AND is_deleted=FALSE) c ON TRUE
        WHERE u.merged_into_user_id IS NULL ORDER BY last_activity DESC NULLS LAST
      `, [req.user.role]);
      jsonData(res, rows);
    } catch (error) {
      registerRouteError('players-directory', res, error);
    }
  });

  app.patch('/api/admin/users/bulk-verified', auth, requireAdmin, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 250) : [];
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um usuario.', code: 'EMPTY_SELECTION' });
    try {
      const { rows } = await pool.query('UPDATE users SET is_platform_verified=$2 WHERE id=ANY($1::int[]) RETURNING id, username, is_platform_verified', [ids, req.body?.verified !== false]);
      await auditFromReq?.(req, { type: 'update', message: `Verificacao em lote para ${rows.length} usuario(s)`, metadata: { ids } });
      jsonData(res, rows);
    } catch (error) {
      registerRouteError('bulk-verified', res, error);
    }
  });

  app.post('/api/admin/users/bulk-notify', auth, requireAdmin, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 250) : [];
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 1200);
    if (!ids.length || !title || !body) return res.status(400).json({ error: 'Selecao, titulo e mensagem sao obrigatorios.', code: 'INVALID_BULK_NOTIFICATION' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO notifications(title,body,type,icon,audience,audience_val,created_by)
        SELECT $1,$2,$3,$4,'user',id::text,$5 FROM users WHERE id=ANY($6::int[]) RETURNING id
      `, [title, body, req.body?.type || 'info', req.body?.icon || 'bell', req.user.sub, ids]);
      await auditFromReq?.(req, { type: 'notify', message: `Aviso em lote para ${rows.length} usuario(s)`, metadata: { ids } });
      jsonData(res, { created: rows.length });
    } catch (error) {
      registerRouteError('bulk-notify', res, error);
    }
  });

  app.get('/api/admin/access/overview', auth, requireAdmin, async (req, res) => {
    try {
      const [counts, queue, manager] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE u.is_verified = FALSE)::int AS awaiting_email,
            COUNT(*) FILTER (WHERE u.is_verified = TRUE AND NULLIF(TRIM(COALESCE(u.minecraft_name, '')), '') IS NULL)::int AS awaiting_minecraft,
            (SELECT COUNT(*)::int FROM whitelist_queue WHERE delivered_at IS NULL) AS queued,
            (SELECT COUNT(*)::int FROM whitelist_queue WHERE delivered_at IS NOT NULL) AS delivered
          FROM users u
          WHERE u.merged_into_user_id IS NULL
        `),
        pool.query(`
          SELECT q.id, q.minecraft_name, q.user_id, q.queued_at, q.delivered_at,
            u.username, CASE WHEN $1='owner' THEN u.email ELSE NULL END AS email, u.is_verified, u.is_platform_verified,
            k.name AS delivered_by_name,
            (SELECT COUNT(*)::int FROM whitelist_queue_attempts a WHERE a.queue_id=q.id) AS retry_count,
            CASE WHEN q.delivered_at IS NULL THEN 'queued' ELSE 'delivered' END AS status
          FROM whitelist_queue q
          LEFT JOIN users u ON u.id = q.user_id
          LEFT JOIN app_integration_keys k ON k.id = q.delivered_by
          ORDER BY (q.delivered_at IS NULL) DESC, COALESCE(q.delivered_at, q.queued_at) DESC
          LIMIT 250
        `, [req.user.role]),
        pool.query(`
          SELECT id, name, last_used_at
          FROM app_integration_keys
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT 1
        `),
      ]);
      jsonData(res, {
        summary: counts.rows[0] || {},
        queue: queue.rows,
        manager: manager.rows[0] || null,
        delivery_note: 'Entregue significa que o endpoint reservou o item para o Manager; não confirma resposta recebida nem aplicação no servidor.',
      });
    } catch (error) {
      registerRouteError('access-overview', res, error);
    }
  });

  app.post('/api/admin/access/whitelist', auth, requireAdmin, async (req, res) => {
    const minecraftName = String(req.body?.minecraft_name || '').trim();
    const userId = Number(req.body?.user_id) || null;
    if (!/^[A-Za-z0-9_]{2,16}$/.test(minecraftName)) {
      return res.status(400).json({ error: 'Informe um nick Java válido, com 2 a 16 letras, números ou _.', code: 'INVALID_MINECRAFT_NAME' });
    }
    try {
      if (userId) {
        const account = await pool.query('SELECT id, minecraft_name FROM users WHERE id=$1 AND merged_into_user_id IS NULL', [userId]);
        if (!account.rows.length) return res.status(404).json({ error: 'Conta do site não encontrada.', code: 'ACCESS_USER_NOT_FOUND' });
        const linkedName = String(account.rows[0].minecraft_name || '').trim();
        if (!linkedName) return res.status(409).json({ error: 'A conta informada ainda não possui Minecraft vinculado.', code: 'ACCESS_ACCOUNT_NOT_LINKED' });
        if (linkedName && linkedName.toLowerCase() !== minecraftName.toLowerCase()) {
          return res.status(409).json({ error: `A conta informada está vinculada a ${linkedName}, não a ${minecraftName}.`, code: 'ACCESS_IDENTITY_MISMATCH' });
        }
      }
      const existing = await pool.query(
        'SELECT * FROM whitelist_queue WHERE LOWER(minecraft_name)=LOWER($1) AND delivered_at IS NULL ORDER BY id DESC LIMIT 1',
        [minecraftName],
      );
      if (existing.rows.length) return jsonData(res, { ...existing.rows[0], already_queued: true });
      const { rows } = await pool.query(
        'INSERT INTO whitelist_queue(minecraft_name,user_id,queued_at) VALUES($1,$2,NOW()) RETURNING *',
        [minecraftName, userId],
      );
      await auditFromReq?.(req, { type: 'create', severity: 'warning', message: `Entrada manual na lista de acesso: ${minecraftName}`, target_name: minecraftName, metadata: { queue_id: rows[0].id, user_id: userId } });
      jsonData(res, rows[0]);
    } catch (error) {
      registerRouteError('access-whitelist-create', res, error);
    }
  });

  app.post('/api/admin/access/whitelist/:id/requeue', auth, requireAdmin, async (req, res) => {
    const reason = String(req.body?.reason || 'Reenvio solicitado pela staff').trim().slice(0, 500);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM whitelist_queue WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!current.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Entrada da lista de acesso não encontrada.', code: 'ACCESS_ENTRY_NOT_FOUND' });
      }
      await client.query(`
        INSERT INTO whitelist_queue_attempts(queue_id,previous_delivered_at,previous_delivered_by,requested_by,reason)
        VALUES($1,$2,$3,$4,$5)
      `, [current.rows[0].id, current.rows[0].delivered_at, current.rows[0].delivered_by, req.user.sub, reason]);
      const { rows } = await client.query(`
        UPDATE whitelist_queue
        SET queued_at=NOW(), delivered_at=NULL, delivered_by=NULL
        WHERE id=$1
        RETURNING *
      `, [req.params.id]);
      await client.query('COMMIT');
      await auditFromReq?.(req, { type: 'update', severity: 'warning', message: `Reenvio à lista de acesso: ${rows[0].minecraft_name}`, target_name: rows[0].minecraft_name, metadata: { queue_id: rows[0].id, reason, previous_delivered_at: current.rows[0].delivered_at } });
      jsonData(res, rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      registerRouteError('access-whitelist-requeue', res, error);
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/analytics/social-graph', auth, requireAdmin, async (req, res) => {
    const limit = clamp(req.query.limit, 80, 20, 200);
    try {
      const [nodes, edges] = await Promise.all([
        pool.query(`
          SELECT u.id, u.username, u.minecraft_name, COALESCE(up.display_name,'') AS display_name,
            COALESCE(pb.rank,'ferro') AS rank, COUNT(f.follower_id)::int AS followers
          FROM users u
          LEFT JOIN user_preferences up ON up.user_id=u.id
          LEFT JOIN player_balances pb ON LOWER(pb.minecraft_name)=LOWER(u.minecraft_name)
          LEFT JOIN user_follows f ON f.following_id=u.id
          WHERE u.merged_into_user_id IS NULL
          GROUP BY u.id, up.display_name, pb.rank ORDER BY followers DESC LIMIT $1
        `, [limit]),
        pool.query('SELECT follower_id AS source, following_id AS target, created_at FROM user_follows ORDER BY created_at DESC LIMIT 1000'),
      ]);
      const ids = new Set(nodes.rows.map((node) => Number(node.id)));
      jsonData(res, { nodes: nodes.rows, edges: edges.rows.filter((edge) => ids.has(Number(edge.source)) && ids.has(Number(edge.target))) });
    } catch (error) {
      registerRouteError('social-graph', res, error);
    }
  });

  app.get('/api/admin/analytics/moderation-overview', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 14, 7, 90);
    try {
      const [summary, daily] = await Promise.all([
        pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM moderation_queue WHERE status='pending') AS pending_ai,
            (SELECT COUNT(*)::int FROM content_reports WHERE status='pending') AS pending_reports,
            (SELECT COUNT(*)::int FROM moderation_queue WHERE reviewed_at >= NOW() - ($1::int * INTERVAL '1 day') AND status='reviewed') AS approved,
            (SELECT COUNT(*)::int FROM moderation_queue WHERE reviewed_at >= NOW() - ($1::int * INTERVAL '1 day') AND status='removed') AS removed,
            (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (reviewed_at-created_at))/3600),0)::float FROM content_reports WHERE reviewed_at >= NOW() - ($1::int * INTERVAL '1 day')) AS avg_response_hours
        `, [days]),
        pool.query(`
          SELECT created_at::date AS day, COUNT(*)::int AS reports FROM content_reports
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 1
        `, [days]),
      ]);
      jsonData(res, { summary: summary.rows[0], daily: daily.rows });
    } catch (error) {
      registerRouteError('moderation-overview', res, error);
    }
  });

  app.get('/api/admin/analytics/audit-overview', auth, requireAdmin, async (req, res) => {
    const days = clamp(req.query.days, 30, 7, 180);
    try {
      const [heatmap, actors] = await Promise.all([
        pool.query(`
          SELECT EXTRACT(DOW FROM created_at)::int AS day_of_week, EXTRACT(HOUR FROM created_at)::int AS hour_of_day, COUNT(*)::int AS actions
          FROM audit_logs WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1,2 ORDER BY 1,2
        `, [days]),
        pool.query(`
          SELECT COALESCE(actor_name,'Sistema') AS actor_name, COUNT(*)::int AS actions
          FROM audit_logs WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1 ORDER BY actions DESC LIMIT 5
        `, [days]),
      ]);
      jsonData(res, { heatmap: heatmap.rows, actors: actors.rows });
    } catch (error) {
      registerRouteError('audit-overview', res, error);
    }
  });

  app.get('/api/admin/notification-templates', auth, requireAdmin, async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM notification_templates ORDER BY updated_at DESC');
      jsonData(res, rows);
    } catch (error) {
      registerRouteError('notification-templates', res, error);
    }
  });

  app.post('/api/admin/notification-templates', auth, requireAdmin, async (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 1200);
    if (!title || !body) return res.status(400).json({ error: 'Titulo e mensagem sao obrigatorios.', code: 'INVALID_TEMPLATE' });
    try {
      const { rows } = await pool.query(
        'INSERT INTO notification_templates(title,body,type,icon,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [title, body, req.body?.type || 'info', req.body?.icon || 'bell', req.user.sub],
      );
      jsonData(res, rows[0]);
    } catch (error) {
      registerRouteError('create-notification-template', res, error);
    }
  });

  app.delete('/api/admin/notification-templates/:id', auth, requireAdmin, async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM notification_templates WHERE id=$1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Template nao encontrado.', code: 'TEMPLATE_NOT_FOUND' });
      jsonData(res, { ok: true });
    } catch (error) {
      registerRouteError('delete-notification-template', res, error);
    }
  });

  app.get('/api/admin/settings', auth, requireOwner, async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT settings, updated_at FROM admin_dashboard_settings WHERE id=1');
      jsonData(res, { ...DASHBOARD_DEFAULTS, ...(rows[0]?.settings || {}), rank_thresholds: DASHBOARD_DEFAULTS.rank_thresholds, updated_at: rows[0]?.updated_at || null });
    } catch (error) {
      registerRouteError('settings', res, error);
    }
  });

  app.put('/api/admin/settings', auth, requireOwner, async (req, res) => {
    try {
      const current = await pool.query('SELECT settings FROM admin_dashboard_settings WHERE id=1');
      const raw = { ...DASHBOARD_DEFAULTS, ...(current.rows[0]?.settings || {}), ...(req.body || {}) };
      const settings = {
        ...raw,
        server_ip: String(raw.server_ip || DASHBOARD_DEFAULTS.server_ip).trim().slice(0,255),
        server_port: clamp(raw.server_port, DASHBOARD_DEFAULTS.server_port, 1, 65535),
        max_players: clamp(raw.max_players, DASHBOARD_DEFAULTS.max_players, 1, 10000),
        whitelist_enabled: raw.whitelist_enabled !== false,
        maintenance_message: String(raw.maintenance_message || '').trim().slice(0,500),
        moderation_mode: ['manual','ai'].includes(raw.moderation_mode) ? raw.moderation_mode : 'ai',
        broadcast_max_per_day: clamp(raw.broadcast_max_per_day, DASHBOARD_DEFAULTS.broadcast_max_per_day, 0, 1000),
        broadcast_channels: {
          dashboard: raw.broadcast_channels?.dashboard !== false,
          push: raw.broadcast_channels?.push !== false,
          email: raw.broadcast_channels?.email === true,
        },
        rank_thresholds: DASHBOARD_DEFAULTS.rank_thresholds,
      };
      const { rows } = await pool.query(`
        INSERT INTO admin_dashboard_settings(id,settings,updated_by,updated_at) VALUES(1,$1::jsonb,$2,NOW())
        ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=NOW()
        RETURNING settings,updated_at
      `, [JSON.stringify(settings), req.user.sub]);
      await auditFromReq?.(req, { type: 'update', severity: 'warning', message: 'Configuracoes globais do dashboard atualizadas' });
      jsonData(res, { ...rows[0].settings, updated_at: rows[0].updated_at });
    } catch (error) {
      registerRouteError('update-settings', res, error);
    }
  });

  app.get('/api/admin/settings/export/:kind', auth, requireOwner, async (req, res) => {
    const queries = {
      audit: 'SELECT * FROM audit_logs ORDER BY created_at DESC',
      merit: 'SELECT * FROM merit_records ORDER BY created_at DESC',
      sessions: 'SELECT * FROM player_sessions ORDER BY entered_at DESC',
      users: 'SELECT id,username,email,minecraft_name,role,is_verified,is_platform_verified,created_at FROM users ORDER BY id',
    };
    if (!queries[req.params.kind]) return res.status(400).json({ error: 'Tipo de exportacao invalido.', code: 'INVALID_EXPORT' });
    try {
      const { rows } = await pool.query(queries[req.params.kind]);
      jsonData(res, rows, { kind: req.params.kind, total: rows.length, exported_at: new Date().toISOString() });
    } catch (error) {
      registerRouteError('settings-export', res, error);
    }
  });

  app.post('/api/admin/settings/actions', auth, requireOwner, async (req, res) => {
    const action = String(req.body?.action || '');
    if (['clear_reviewed_moderation', 'delete_inactive_accounts', 'reset_merit'].includes(action)) {
      return res.status(423).json({
        error: 'Esta ação crítica foi desativada até existir backup durável, preview de impacto e recuperação verificável.',
        code: 'CRITICAL_ACTION_REQUIRES_RUNBOOK',
      });
    }
    const confirmed = req.body?.confirm === action.toUpperCase();
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!confirmed) return res.status(400).json({ error: `Digite ${action.toUpperCase()} para confirmar.`, code: 'CONFIRMATION_REQUIRED' });
    if (reason.length < 8) return res.status(400).json({ error: 'Informe um motivo com pelo menos 8 caracteres.', code: 'REASON_REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let affected = 0;
      if (action === 'clear_reviewed_moderation') {
        const result = await client.query(`DELETE FROM moderation_queue WHERE status <> 'pending'`);
        affected = result.rowCount;
      } else if (action === 'reset_merit') {
        const result = await client.query(`UPDATE player_balances SET merit_total=0, rank='ferro', updated_at=NOW() WHERE merit_total <> 0`);
        affected = result.rowCount;
      } else if (action === 'delete_inactive_accounts') {
        const months = clamp(req.body?.months, 12, 6, 60);
        const candidates = await client.query(`
          SELECT u.id,u.username,u.email,u.minecraft_name,u.created_at
          FROM users u WHERE u.role='limited'
            AND u.created_at < NOW() - ($1::int * INTERVAL '1 month')
            AND NOT EXISTS (SELECT 1 FROM player_sessions ps WHERE LOWER(ps.player)=LOWER(u.minecraft_name) AND ps.entered_at >= NOW() - ($1::int * INTERVAL '1 month'))
            AND NOT EXISTS (SELECT 1 FROM user_posts p WHERE p.author_id=u.id AND p.created_at >= NOW() - ($1::int * INTERVAL '1 month'))
        `, [months]);
        const result = await client.query(`
          DELETE FROM users u WHERE u.role='limited'
            AND u.created_at < NOW() - ($1::int * INTERVAL '1 month')
            AND NOT EXISTS (SELECT 1 FROM player_sessions ps WHERE LOWER(ps.player)=LOWER(u.minecraft_name) AND ps.entered_at >= NOW() - ($1::int * INTERVAL '1 month'))
            AND NOT EXISTS (SELECT 1 FROM user_posts p WHERE p.author_id=u.id AND p.created_at >= NOW() - ($1::int * INTERVAL '1 month'))
        `, [months]);
        affected = result.rowCount;
        req.dashboardActionExport = candidates.rows;
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Acao invalida.', code: 'INVALID_ACTION' });
      }
      await client.query('COMMIT');
      await auditFromReq?.(req, { type: 'delete', severity: 'critical', message: `Ação crítica: ${action} (${affected} registro(s))`, metadata: { action, affected, reason } });
      jsonData(res, { ok: true, action, affected, export: req.dashboardActionExport || undefined });
    } catch (error) {
      await client.query('ROLLBACK');
      registerRouteError('settings-action', res, error);
    } finally {
      client.release();
    }
  });
}
