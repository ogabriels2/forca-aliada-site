import assert from 'node:assert/strict';
import { classifyCloudStatus, nextCloudMonitorState } from '../src/cloud_monitor_policy.mjs';

const status = (online, source, count = 0, list = []) => ({
  online, source, players: { online: count, list },
});

assert.equal(classifyCloudStatus(status(false, 'failed')), 'inconclusive');
assert.equal(classifyCloudStatus(status(true, 'ping', 1, [])), 'online-count-only');
assert.equal(classifyCloudStatus(status(true, 'udp_query', 1, ['Bedrock User'])), 'online-with-list');
assert.equal(classifyCloudStatus(status(true, 'ping', 0, [])), 'online-empty');

const firstOffline = nextCloudMonitorState({}, status(false, 'mcstatus_offline'));
assert.equal(firstOffline.shouldCloseAll, false, 'uma leitura offline isolada nao pode fechar sessoes');
const confirmedOffline = nextCloudMonitorState(firstOffline, status(false, 'mcstatus_offline'));
assert.equal(confirmedOffline.shouldCloseAll, true, 'duas leituras offline definitivas confirmam o estado');
assert.equal(nextCloudMonitorState(confirmedOffline, status(false, 'failed')).consecutiveOfflineChecks, 0);

console.log('cloud monitor policy: ok');
