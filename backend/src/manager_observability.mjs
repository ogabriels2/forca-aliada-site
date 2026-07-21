const SERVICE_ID = 'forca-aliada-manager-api';
const PROTOCOL_VERSION = 2;
const PRESENCE_WRITE_INTERVAL_MS = 60_000;
const ONLINE_WINDOW_MS = 75_000;
const DATABASE_ONLINE_WINDOW_SECONDS = 180;
const TELEMETRY_RETENTION_DAYS = 120;

const TELEMETRY_METRICS = new Set([
  'feature.server',
  'feature.terminal',
  'feature.players',
  'feature.sync',
  'feature.schedule',
  'feature.mods',
  'feature.settings',
  'feature.files',
  'feature.backup',
  'feature.updates',
  'action.server_start',
  'action.server_stop',
  'action.command',
  'action.backup',
  'action.schedule',
  'action.file_read',
  'action.file_write',
  'action.mod_check',
  'action.mod_update',
  'action.remote_control',
  'action.sync_manual',
  'action.update_check',
  'action.update_install',
]);

export const MANAGER_SERVICE_ID = SERVICE_ID;
export const MANAGER_PROTOCOL_VERSION = PROTOCOL_VERSION;

export const MANAGER_OBSERVABILITY_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS manager_installations (
  installation_id     VARCHAR(80) PRIMARY KEY,
  app_key_id           INTEGER REFERENCES app_integration_keys(id) ON DELETE SET NULL,
  auth_kind            VARCHAR(20) NOT NULL DEFAULT 'app_key',
  device_name          VARCHAR(120) NOT NULL DEFAULT 'Forca Aliada Manager',
  app_version          VARCHAR(40),
  os_platform          VARCHAR(30),
  os_release           VARCHAR(80),
  os_family            VARCHAR(30),
  arch                 VARCHAR(20),
  control_mode         VARCHAR(30),
  runtime_role         VARCHAR(30),
  last_transport       VARCHAR(20),
  protocol_version     SMALLINT,
  telemetry_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  remote_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  remote_connected     BOOLEAN NOT NULL DEFAULT FALSE,
  agent_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  agent_healthy        BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at         TIMESTAMPTZ,
  last_error_code      VARCHAR(64),
  latency_ms           INTEGER,
  sync_successes       BIGINT NOT NULL DEFAULT 0,
  sync_failures        BIGINT NOT NULL DEFAULT 0,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_manager_installations_seen
  ON manager_installations(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_manager_installations_key
  ON manager_installations(app_key_id);

CREATE TABLE IF NOT EXISTS manager_health_daily (
  installation_id VARCHAR(80) REFERENCES manager_installations(installation_id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  heartbeat_count BIGINT NOT NULL DEFAULT 0,
  sync_count      BIGINT NOT NULL DEFAULT 0,
  success_count   BIGINT NOT NULL DEFAULT 0,
  failure_count   BIGINT NOT NULL DEFAULT 0,
  websocket_count BIGINT NOT NULL DEFAULT 0,
  https_count     BIGINT NOT NULL DEFAULT 0,
  latency_sum_ms  BIGINT NOT NULL DEFAULT 0,
  latency_samples BIGINT NOT NULL DEFAULT 0,
  error_counts    JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (installation_id, day)
);
CREATE INDEX IF NOT EXISTS idx_manager_health_daily_day
  ON manager_health_daily(day DESC);

CREATE TABLE IF NOT EXISTS manager_error_daily (
  installation_id VARCHAR(80) REFERENCES manager_installations(installation_id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  error_code      VARCHAR(64) NOT NULL,
  occurrence_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, day, error_code)
);
CREATE INDEX IF NOT EXISTS idx_manager_error_daily_day
  ON manager_error_daily(day DESC);

CREATE TABLE IF NOT EXISTS manager_telemetry_daily (
  installation_id VARCHAR(80) REFERENCES manager_installations(installation_id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  sequence        BIGINT NOT NULL DEFAULT 0,
  metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, day)
);
CREATE INDEX IF NOT EXISTS idx_manager_telemetry_daily_day
  ON manager_telemetry_daily(day DESC);

ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS origin_installation_id VARCHAR(80);
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS origin_transport VARCHAR(20);
ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS origin_confidence VARCHAR(20) DEFAULT 'inferred';
`;

function text(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function bool(value) {
  return value === true;
}

function int(value, min = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function installationId(value, auth = {}) {
  const candidate = text(value, 80).toLowerCase();
  if (/^[a-z0-9][a-z0-9._:-]{7,79}$/.test(candidate)) return candidate;
  return auth.appKeyId ? `legacy-key-${auth.appKeyId}` : 'legacy-shared-credential';
}

function normalizeMetadata(raw = {}, auth = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    installationId: installationId(source.installationId || source.installation_id, auth),
    deviceName: text(source.deviceName || source.device_name || 'Forca Aliada Manager', 120),
    appVersion: text(source.appVersion || source.app_version, 40),
    osPlatform: text(source.osPlatform || source.os_platform, 30),
    osRelease: text(source.osRelease || source.os_release, 80),
    osFamily: text(source.osFamily || source.os_family, 30),
    arch: text(source.arch, 20),
    controlMode: text(source.controlMode || source.control_mode, 30),
    runtimeRole: text(source.runtimeRole || source.runtime_role, 30),
    telemetryEnabled: bool(source.telemetryEnabled ?? source.telemetry_enabled),
    remoteEnabled: bool(source.remoteEnabled ?? source.remote_enabled),
    remoteConnected: bool(source.remoteConnected ?? source.remote_connected),
    agentEnabled: bool(source.agentEnabled ?? source.agent_enabled),
    agentHealthy: bool(source.agentHealthy ?? source.agent_healthy),
    latencyMs: source.latencyMs === null || source.latency_ms === null
      ? null
      : int(source.latencyMs ?? source.latency_ms, 0, 120_000),
    lastErrorCode: text(source.lastErrorCode || source.last_error_code, 64),
  };
}

function stableMetadataSignature(meta = {}) {
  const { latencyMs: _latencyMs, lastErrorCode: _lastErrorCode, ...stable } = meta;
  return JSON.stringify(stable);
}

function mergeErrorCounts(target = {}, source = {}) {
  const output = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const safeKey = text(key, 64);
    if (!safeKey) continue;
    output[safeKey] = int(output[safeKey], 0) + int(value, 0);
  }
  return output;
}

function semverParts(value) {
  return String(value || '').split(/[.-]/).slice(0, 4).map(part => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

export function managerEnvelope(req, payload = {}) {
  return {
    service: SERVICE_ID,
    protocol: PROTOCOL_VERSION,
    requestId: text(req?.managerRequestId || req?.headers?.['x-request-id'], 80) || null,
    serverTime: new Date().toISOString(),
    build: text(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT, 12) || null,
    ...payload,
  };
}

export function createManagerObservability(pool, options = {}) {
  const live = new Map();
  const persistence = new Map();
  let lastCleanupAt = 0;

  function scheduleRetentionCleanup() {
    if (Date.now() - lastCleanupAt <= 24 * 60 * 60 * 1000) return;
    lastCleanupAt = Date.now();
    Promise.all([
      pool.query(`DELETE FROM manager_telemetry_daily WHERE day < CURRENT_DATE - $1::int`, [TELEMETRY_RETENTION_DAYS]),
      pool.query(`DELETE FROM manager_health_daily WHERE day < CURRENT_DATE - $1::int`, [TELEMETRY_RETENTION_DAYS]),
      pool.query(`DELETE FROM manager_error_daily WHERE day < CURRENT_DATE - $1::int`, [TELEMETRY_RETENTION_DAYS]),
      pool.query(`DELETE FROM manager_installations WHERE last_seen_at < NOW() - ($1::int * INTERVAL '1 day')`, [TELEMETRY_RETENTION_DAYS]),
    ]).catch(error => options.onError?.(error, 'manager-retention'));
  }

  function currentEntry(id) {
    return live.get(id) || null;
  }

  function isServerSyncSource(entry) {
    return entry?.meta?.runtimeRole !== 'remote-client'
      && entry?.meta?.controlMode !== 'remote-client'
      && entry?.transport !== 'relay-websocket'
      && entry?.transport !== 'relay-https';
  }

  function latestSignal({ includeRemoteClients = false } = {}) {
    let latest = null;
    for (const entry of live.values()) {
      if (!includeRemoteClients && !isServerSyncSource(entry)) continue;
      if (!latest || entry.lastSeenMs > latest.lastSeenMs) latest = entry;
    }
    return latest;
  }

  function isAnyOnline({ includeRemoteClients = false } = {}) {
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    return [...live.values()].some(entry =>
      (includeRemoteClients || isServerSyncSource(entry)) && entry.lastSeenMs >= cutoff
    );
  }

  function connectionSummary() {
    const latest = latestSignal();
    if (!latest) return null;
    const now = Date.now();
    const onlineInstallations = [...live.values()]
      .filter(entry => isServerSyncSource(entry) && now - entry.lastSeenMs <= ONLINE_WINDOW_MS).length;
    return {
      connected: now - latest.lastSeenMs <= ONLINE_WINDOW_MS,
      onlineInstallations,
      lastSeenAt: new Date(latest.lastSeenMs).toISOString(),
      installationId: latest.meta.installationId,
      deviceName: latest.meta.deviceName,
      appVersion: latest.meta.appVersion || null,
      osFamily: latest.meta.osFamily || null,
      controlMode: latest.meta.controlMode || null,
      runtimeRole: latest.meta.runtimeRole || null,
      transport: latest.transport || null,
      latencyMs: latest.meta.latencyMs,
      lastErrorCode: latest.meta.lastErrorCode || null,
      authKind: latest.auth?.authKind || (latest.auth?.appKeyId ? 'app_key' : 'legacy'),
      keyName: text(latest.auth?.keyName, 120) || null,
      protocol: PROTOCOL_VERSION,
      confidence: 'verified',
    };
  }

  async function persistEntry(entry) {
    const pending = entry.pending;
    entry.pending = {
      heartbeats: 0, syncs: 0, successes: 0, failures: 0,
      syncSuccesses: 0, syncFailures: 0,
      websocket: 0, https: 0, latencySum: 0, latencySamples: 0, errors: {},
    };
    entry.lastPersistAttemptMs = Date.now();

    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO manager_installations (
           installation_id, app_key_id, auth_kind, device_name, app_version,
           os_platform, os_release, os_family, arch, control_mode, runtime_role,
           last_transport, protocol_version, telemetry_enabled, remote_enabled,
           remote_connected, agent_enabled, agent_healthy, last_seen_at, last_sync_at,
           last_error_code, latency_ms, sync_successes, sync_failures, metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),
           CASE WHEN $19 THEN NOW() ELSE NULL END,$20,$21,$22,$23,$24::jsonb
         )
         ON CONFLICT (installation_id) DO UPDATE SET
           app_key_id=EXCLUDED.app_key_id,
           auth_kind=EXCLUDED.auth_kind,
           device_name=EXCLUDED.device_name,
           app_version=EXCLUDED.app_version,
           os_platform=EXCLUDED.os_platform,
           os_release=EXCLUDED.os_release,
           os_family=EXCLUDED.os_family,
           arch=EXCLUDED.arch,
           control_mode=EXCLUDED.control_mode,
           runtime_role=EXCLUDED.runtime_role,
           last_transport=EXCLUDED.last_transport,
           protocol_version=EXCLUDED.protocol_version,
           telemetry_enabled=EXCLUDED.telemetry_enabled,
           remote_enabled=EXCLUDED.remote_enabled,
           remote_connected=EXCLUDED.remote_connected,
           agent_enabled=EXCLUDED.agent_enabled,
           agent_healthy=EXCLUDED.agent_healthy,
           last_seen_at=NOW(),
           last_sync_at=CASE WHEN $19 THEN NOW() ELSE manager_installations.last_sync_at END,
           last_error_code=EXCLUDED.last_error_code,
           latency_ms=EXCLUDED.latency_ms,
           sync_successes=manager_installations.sync_successes + EXCLUDED.sync_successes,
           sync_failures=manager_installations.sync_failures + EXCLUDED.sync_failures,
           metadata=EXCLUDED.metadata`,
        [
          entry.meta.installationId,
          entry.auth.appKeyId || null,
          entry.auth.authKind || (entry.auth.appKeyId ? 'app_key' : 'legacy'),
          entry.meta.deviceName,
          entry.meta.appVersion || null,
          entry.meta.osPlatform || null,
          entry.meta.osRelease || null,
          entry.meta.osFamily || null,
          entry.meta.arch || null,
          entry.meta.controlMode || null,
          entry.meta.runtimeRole || null,
          entry.transport || null,
          PROTOCOL_VERSION,
          entry.meta.telemetryEnabled,
          entry.meta.remoteEnabled,
          entry.meta.remoteConnected,
          entry.meta.agentEnabled,
          entry.meta.agentHealthy,
          entry.lastKind === 'sync',
          entry.meta.lastErrorCode || null,
          entry.meta.latencyMs,
          pending.syncSuccesses,
          pending.syncFailures,
          JSON.stringify({ keyName: text(entry.auth.keyName, 120) || null }),
        ],
      );

      await client.query(
        `INSERT INTO manager_health_daily (
           installation_id, day, heartbeat_count, sync_count, success_count,
           failure_count, websocket_count, https_count, latency_sum_ms,
           latency_samples
         ) VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (installation_id, day) DO UPDATE SET
           heartbeat_count=manager_health_daily.heartbeat_count + EXCLUDED.heartbeat_count,
           sync_count=manager_health_daily.sync_count + EXCLUDED.sync_count,
           success_count=manager_health_daily.success_count + EXCLUDED.success_count,
           failure_count=manager_health_daily.failure_count + EXCLUDED.failure_count,
           websocket_count=manager_health_daily.websocket_count + EXCLUDED.websocket_count,
           https_count=manager_health_daily.https_count + EXCLUDED.https_count,
           latency_sum_ms=manager_health_daily.latency_sum_ms + EXCLUDED.latency_sum_ms,
           latency_samples=manager_health_daily.latency_samples + EXCLUDED.latency_samples`,
        [
          entry.meta.installationId,
          pending.heartbeats,
          pending.syncs,
          pending.successes,
          pending.failures,
          pending.websocket,
          pending.https,
          pending.latencySum,
          pending.latencySamples,
        ],
      );
      if (Object.keys(pending.errors).length) {
        await client.query(
          `INSERT INTO manager_error_daily (installation_id, day, error_code, occurrence_count)
           SELECT $1, CURRENT_DATE, error_code, occurrence_count::bigint
             FROM jsonb_each_text($2::jsonb) AS pending_errors(error_code, occurrence_count)
           ON CONFLICT (installation_id, day, error_code) DO UPDATE SET
             occurrence_count=manager_error_daily.occurrence_count + EXCLUDED.occurrence_count`,
          [entry.meta.installationId, JSON.stringify(pending.errors)],
        );
      }
      await client.query('COMMIT');
      entry.lastPersistMs = Date.now();
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      entry.pending.heartbeats += pending.heartbeats;
      entry.pending.syncs += pending.syncs;
      entry.pending.successes += pending.successes;
      entry.pending.failures += pending.failures;
      entry.pending.syncSuccesses += pending.syncSuccesses;
      entry.pending.syncFailures += pending.syncFailures;
      entry.pending.websocket += pending.websocket;
      entry.pending.https += pending.https;
      entry.pending.latencySum += pending.latencySum;
      entry.pending.latencySamples += pending.latencySamples;
      entry.pending.errors = mergeErrorCounts(entry.pending.errors, pending.errors);
      throw error;
    } finally {
      client?.release();
    }
  }

  function schedulePersist(entry, force = false) {
    const id = entry.meta.installationId;
    const due = force
      || !entry.lastPersistMs
      || Date.now() - entry.lastPersistMs >= PRESENCE_WRITE_INTERVAL_MS
      || entry.metadataChanged;
    if (!due) return Promise.resolve(false);
    if (persistence.has(id)) return persistence.get(id);
    const task = persistEntry(entry)
      .catch(error => {
        options.onError?.(error, 'manager-presence');
        return false;
      })
      .finally(() => persistence.delete(id));
    persistence.set(id, task);
    return task;
  }

  async function recordSignal({ auth = {}, metadata = {}, transport = '', kind = 'heartbeat', ok = true, errorCode = '' } = {}) {
    const meta = normalizeMetadata(metadata, auth);
    const previous = currentEntry(meta.installationId);
    const metadataSignature = stableMetadataSignature(meta);
    const entry = previous || {
      meta,
      auth,
      transport: '',
      lastKind: '',
      lastSeenMs: 0,
      lastPersistMs: 0,
      lastPersistAttemptMs: 0,
      metadataSignature: '',
      metadataChanged: true,
      reportedErrorCode: '',
      pending: {
        heartbeats: 0, syncs: 0, successes: 0, failures: 0,
        syncSuccesses: 0, syncFailures: 0,
        websocket: 0, https: 0, latencySum: 0, latencySamples: 0, errors: {},
      },
    };
    entry.metadataChanged = entry.metadataSignature !== metadataSignature
      || Number(entry.auth?.appKeyId || 0) !== Number(auth?.appKeyId || 0);
    entry.meta = meta;
    entry.auth = auth;
    entry.transport = text(transport, 20);
    entry.lastKind = kind === 'sync' ? 'sync' : 'heartbeat';
    entry.lastSeenMs = Date.now();
    entry.metadataSignature = metadataSignature;
    entry.pending[entry.lastKind === 'sync' ? 'syncs' : 'heartbeats'] += 1;
    entry.pending[ok ? 'successes' : 'failures'] += 1;
    if (entry.lastKind === 'sync') entry.pending[ok ? 'syncSuccesses' : 'syncFailures'] += 1;
    if (entry.transport === 'websocket' || entry.transport === 'relay-websocket') entry.pending.websocket += 1;
    if (entry.transport === 'https' || entry.transport === 'relay-https') entry.pending.https += 1;
    if (Number.isFinite(meta.latencyMs)) {
      entry.pending.latencySum += meta.latencyMs;
      entry.pending.latencySamples += 1;
    }
    const safeError = text(errorCode || meta.lastErrorCode, 64);
    if (!ok && safeError) entry.pending.errors[safeError] = (entry.pending.errors[safeError] || 0) + 1;
    if (ok && safeError && safeError !== entry.reportedErrorCode) {
      entry.pending.errors[safeError] = (entry.pending.errors[safeError] || 0) + 1;
    }
    entry.reportedErrorCode = safeError;
    live.set(meta.installationId, entry);
    await schedulePersist(entry, !previous);
    scheduleRetentionCleanup();
    entry.metadataChanged = false;
    return { installationId: meta.installationId };
  }

  async function ingestTelemetry(auth = {}, raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const meta = normalizeMetadata(source.manager || source._manager || {}, auth);
    if (!meta.telemetryEnabled) return { accepted: false, reason: 'disabled' };
    const day = text(source.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { accepted: false, reason: 'invalid_day' };
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || Math.abs(Date.now() - dayMs) > 8 * 24 * 60 * 60 * 1000) {
      return { accepted: false, reason: 'day_out_of_range' };
    }
    const sequence = int(source.sequence, 1, Number.MAX_SAFE_INTEGER);
    const rawMetrics = source.metrics && typeof source.metrics === 'object' && !Array.isArray(source.metrics)
      ? source.metrics
      : {};
    const metrics = {};
    for (const [name, value] of Object.entries(rawMetrics).slice(0, 40)) {
      if (!TELEMETRY_METRICS.has(name)) continue;
      const metric = value && typeof value === 'object' ? value : {};
      metrics[name] = {
        count: int(metric.count, 0),
        failures: int(metric.failures, 0),
        durationMs: int(metric.durationMs, 0, Number.MAX_SAFE_INTEGER),
      };
    }
    if (!Object.keys(metrics).length) return { accepted: false, reason: 'empty' };

    await pool.query(
      `INSERT INTO manager_telemetry_daily (installation_id, day, sequence, metrics)
       VALUES ($1,$2::date,$3,$4::jsonb)
       ON CONFLICT (installation_id, day) DO UPDATE SET
         sequence=EXCLUDED.sequence,
         metrics=EXCLUDED.metrics,
         updated_at=NOW()
       WHERE manager_telemetry_daily.sequence <= EXCLUDED.sequence`,
      [meta.installationId, day, sequence, JSON.stringify(metrics)],
    );

    scheduleRetentionCleanup();
    return { accepted: true, sequence };
  }

  function overlayLive(rows) {
    const now = Date.now();
    return rows.map(row => {
      const active = live.get(row.installation_id);
      const lastSeenMs = active ? active.lastSeenMs : new Date(row.last_seen_at).getTime();
      return {
        ...row,
        online: active ? now - active.lastSeenMs <= ONLINE_WINDOW_MS : !!row.online,
        last_seen_at: active ? new Date(active.lastSeenMs).toISOString() : row.last_seen_at,
        last_transport: active?.transport || row.last_transport,
        latency_ms: active?.meta?.latencyMs ?? row.latency_ms,
      };
    });
  }

  async function loadOverview(days = 30) {
    const safeDays = int(days, 1, 120);
    const [installationResult, summaryResult, distributionResult, healthResult, telemetryResult, keyResult, errorResult] = await Promise.all([
      pool.query(
        `SELECT i.*, k.name AS key_name,
                (i.last_seen_at > NOW() - ($1::int * INTERVAL '1 second')) AS online
           FROM manager_installations i
           LEFT JOIN app_integration_keys k ON k.id=i.app_key_id
          ORDER BY i.last_seen_at DESC
          LIMIT 500`,
        [DATABASE_ONLINE_WINDOW_SECONDS],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_installations,
                COUNT(*) FILTER (WHERE last_seen_at > NOW() - ($1::int * INTERVAL '1 second'))::int AS online,
                COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '24 hours')::int AS active_24h,
                COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '30 days')::int AS active_30d,
                COUNT(*) FILTER (WHERE telemetry_enabled)::int AS telemetry_opt_in,
                COUNT(*) FILTER (WHERE auth_kind LIKE 'legacy%')::int AS legacy_credentials,
                COALESCE(SUM(sync_successes), 0)::bigint AS sync_successes,
                COALESCE(SUM(sync_failures), 0)::bigint AS sync_failures
           FROM manager_installations`,
        [DATABASE_ONLINE_WINDOW_SECONDS],
      ),
      pool.query(
        `SELECT dimension, name, COUNT(*)::int AS count
           FROM (
             SELECT 'version' AS dimension, COALESCE(NULLIF(app_version, ''), 'Nao informado') AS name FROM manager_installations
             UNION ALL
             SELECT 'os', COALESCE(NULLIF(os_family, ''), 'Nao informado') FROM manager_installations
             UNION ALL
             SELECT 'mode', COALESCE(NULLIF(control_mode, ''), 'Nao informado') FROM manager_installations
             UNION ALL
             SELECT 'transport', COALESCE(NULLIF(last_transport, ''), 'Nao informado') FROM manager_installations
             UNION ALL
             SELECT 'runtime', COALESCE(NULLIF(runtime_role, ''), 'Nao informado') FROM manager_installations
           ) distributions
          GROUP BY dimension, name
          ORDER BY dimension, count DESC, name`,
      ),
      pool.query(
        `SELECT day,
                SUM(heartbeat_count)::bigint AS heartbeats,
                SUM(sync_count)::bigint AS syncs,
                SUM(success_count)::bigint AS successes,
                SUM(failure_count)::bigint AS failures,
                SUM(websocket_count)::bigint AS websocket,
                SUM(https_count)::bigint AS https,
                SUM(latency_sum_ms)::bigint AS latency_sum,
                SUM(latency_samples)::bigint AS latency_samples
           FROM manager_health_daily
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY day
          ORDER BY day`,
        [safeDays],
      ),
      pool.query(
        `SELECT installation_id, day, metrics
           FROM manager_telemetry_daily
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          ORDER BY day`,
        [safeDays],
      ),
      pool.query(
        `SELECT k.id, k.name, k.created_at, k.last_used_at, u.username AS created_by,
                COUNT(i.installation_id)::int AS installations,
                COUNT(i.installation_id) FILTER (WHERE i.last_seen_at > NOW() - ($1::int * INTERVAL '1 second'))::int AS online_installations,
                MAX(i.last_seen_at) AS last_seen_at
           FROM app_integration_keys k
           LEFT JOIN users u ON u.id=k.created_by
           LEFT JOIN manager_installations i ON i.app_key_id=k.id
          GROUP BY k.id, u.username
          ORDER BY k.created_at DESC`,
        [DATABASE_ONLINE_WINDOW_SECONDS],
      ),
      pool.query(
        `SELECT error_code, SUM(occurrence_count)::bigint AS occurrence_count
           FROM manager_error_daily
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY error_code
          ORDER BY occurrence_count DESC, error_code`,
        [safeDays],
      ),
    ]);

    const installations = overlayLive(installationResult.rows);
    const aggregate = summaryResult.rows[0] || {};
    const totalInstallations = Number(aggregate.total_installations || 0);
    const online = totalInstallations <= installations.length
      ? installations.filter(row => row.online).length
      : Number(aggregate.online || 0);
    const active24h = Number(aggregate.active_24h || 0);
    const active30d = Number(aggregate.active_30d || 0);
    const distribution = dimension => distributionResult.rows
      .filter(row => row.dimension === dimension)
      .map(row => ({ name: row.name, count: Number(row.count || 0) }));
    const versions = distribution('version');
    const latestVersion = versions.map(item => item.name).filter(name => /^\d/.test(name)).sort(compareVersions).pop() || null;
    const latestVersionCount = latestVersion ? Number(versions.find(item => item.name === latestVersion)?.count || 0) : 0;
    const successes = Number(aggregate.sync_successes || 0);
    const failures = Number(aggregate.sync_failures || 0);
    const telemetryOptIn = Number(aggregate.telemetry_opt_in || 0);
    const featureTotals = {};
    for (const row of telemetryResult.rows) {
      for (const [name, value] of Object.entries(row.metrics || {})) {
        if (!TELEMETRY_METRICS.has(name)) continue;
        const target = featureTotals[name] || { metric: name, count: 0, failures: 0, durationMs: 0 };
        target.count += int(value?.count, 0);
        target.failures += int(value?.failures, 0);
        target.durationMs += int(value?.durationMs, 0, Number.MAX_SAFE_INTEGER);
        featureTotals[name] = target;
      }
    }
    const trend = healthResult.rows.map(row => {
      const samples = Number(row.latency_samples || 0);
      return {
        day: row.day,
        heartbeats: Number(row.heartbeats || 0),
        syncs: Number(row.syncs || 0),
        successes: Number(row.successes || 0),
        failures: Number(row.failures || 0),
        websocket: Number(row.websocket || 0),
        https: Number(row.https || 0),
        avgLatencyMs: samples ? Math.round(Number(row.latency_sum || 0) / samples) : null,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      periodDays: safeDays,
      summary: {
        totalInstallations,
        listedInstallations: installations.length,
        installationsTruncated: totalInstallations > installations.length,
        online,
        active24h,
        active30d,
        latestVersion,
        latestVersionAdoptionPct: totalInstallations ? Math.round((latestVersionCount / totalInstallations) * 100) : 0,
        syncSuccessRatePct: successes + failures ? Math.round((successes / (successes + failures)) * 1000) / 10 : null,
        telemetryOptIn,
        telemetryCoveragePct: totalInstallations ? Math.round((telemetryOptIn / totalInstallations) * 100) : 0,
        legacyCredentials: Number(aggregate.legacy_credentials || 0),
      },
      health: {
        api: 'operational',
        database: options.getDatabaseState?.() || { status: 'unknown' },
        websocketConnections: options.getSocketCount?.() || 0,
        latestSignalAt: installations[0]?.last_seen_at || null,
      },
      distributions: {
        versions,
        operatingSystems: distribution('os'),
        modes: distribution('mode'),
        transports: distribution('transport'),
        runtimeRoles: distribution('runtime'),
      },
      trend,
      errors: errorResult.rows.map(row => ({ code: row.error_code, count: Number(row.occurrence_count || 0) })),
      features: Object.values(featureTotals).sort((a, b) => b.count - a.count),
      installations,
      credentials: keyResult.rows.map(row => ({ ...row, online_installations: Number(row.online_installations || 0), installations: Number(row.installations || 0) })),
      privacy: {
        usageTelemetryOptional: true,
        operationalPresenceRequired: true,
        excluded: ['nomes de jogadores', 'comandos', 'logs', 'enderecos IP', 'caminhos de arquivos', 'MOTD e conteudo do servidor'],
        retentionDays: TELEMETRY_RETENTION_DAYS,
      },
    };
  }

  function registerAdminRoutes(app, auth, requireOwner) {
    app.get('/api/admin/manager/overview', auth, requireOwner, async (req, res) => {
      try {
        const data = await loadOverview(req.query.days || 30);
        res.json(managerEnvelope(req, { ok: true, ...data }));
      } catch (error) {
        options.onError?.(error, 'manager-overview');
        res.status(500).json(managerEnvelope(req, { ok: false, error: 'Nao foi possivel carregar os dados do Manager.' }));
      }
    });

    app.get('/api/admin/manager/installations/:id', auth, requireOwner, async (req, res) => {
      const id = installationId(req.params.id, {});
      try {
        const [installationResult, healthResult, telemetryResult, errorResult] = await Promise.all([
          pool.query(
            `SELECT i.*, k.name AS key_name
               FROM manager_installations i
               LEFT JOIN app_integration_keys k ON k.id=i.app_key_id
              WHERE i.installation_id=$1`,
            [id],
          ),
          pool.query('SELECT * FROM manager_health_daily WHERE installation_id=$1 ORDER BY day DESC LIMIT 120', [id]),
          pool.query('SELECT day, sequence, metrics, updated_at FROM manager_telemetry_daily WHERE installation_id=$1 ORDER BY day DESC LIMIT 120', [id]),
          pool.query('SELECT day, error_code, occurrence_count FROM manager_error_daily WHERE installation_id=$1 ORDER BY day DESC, occurrence_count DESC LIMIT 500', [id]),
        ]);
        if (!installationResult.rows.length) {
          return res.status(404).json(managerEnvelope(req, { ok: false, error: 'Instalacao nao encontrada.' }));
        }
        return res.json(managerEnvelope(req, {
          ok: true,
          installation: overlayLive(installationResult.rows)[0],
          health: healthResult.rows,
          telemetry: telemetryResult.rows,
          errors: errorResult.rows,
        }));
      } catch (error) {
        options.onError?.(error, 'manager-installation');
        return res.status(500).json(managerEnvelope(req, { ok: false, error: 'Falha ao carregar a instalacao.' }));
      }
    });
  }

  return {
    recordSignal,
    ingestTelemetry,
    isAnyOnline,
    latestSignal,
    connectionSummary,
    loadOverview,
    registerAdminRoutes,
    normalizeMetadata,
    serviceId: SERVICE_ID,
    protocolVersion: PROTOCOL_VERSION,
  };
}
