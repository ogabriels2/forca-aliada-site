const DEFINITIVE_OFFLINE_SOURCES = new Set([
  'state_machine',
  'state_machine_fallback',
  'mcstatus_confirmed_offline',
  'mcstatus_offline',
  'tcpshield_max_zero_confirmed',
  'tcpshield_max_zero_fallback',
  'tcpshield_max_zero_mcstatus',
  'offline_motd_match_fallback',
]);

export function classifyCloudStatus(status) {
  if (!status || status.source === 'failed') return 'inconclusive';
  if (!status.online) {
    return DEFINITIVE_OFFLINE_SOURCES.has(status.source) ? 'offline' : 'inconclusive';
  }

  const count = Math.max(0, Number(status.players?.online || 0));
  const players = Array.isArray(status.players?.list)
    ? status.players.list.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (players.length > 0) return 'online-with-list';
  if (count === 0) return 'online-empty';
  return 'online-count-only';
}

export function nextCloudMonitorState(previous = {}, status) {
  const classification = classifyCloudStatus(status);
  const previousOfflineChecks = Number(previous.consecutiveOfflineChecks || 0);
  return {
    classification,
    consecutiveOfflineChecks: classification === 'offline' ? previousOfflineChecks + 1 : 0,
    shouldCloseAll: classification === 'online-empty'
      || (classification === 'offline' && previousOfflineChecks + 1 >= 2),
    shouldReconcileNames: classification === 'online-with-list',
  };
}
