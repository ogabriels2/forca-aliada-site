import assert from 'node:assert/strict';
import { createManagerReleaseResolver, MANAGER_RELEASES_URL } from '../src/manager_release.mjs';

function response({ status = 200, json = null, text = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return typeof json === 'function' ? json() : json; },
    async text() { return text; },
  };
}

let calls = 0;
let now = Date.parse('2026-07-21T22:00:00Z');
const apiResolver = createManagerReleaseResolver({
  now: () => now,
  cacheMs: 60_000,
  fetchImpl: async () => {
    calls += 1;
    return response({
      json: {
        tag_name: 'v1.1.5',
        name: 'Forca Aliada Manager 1.1.5',
        published_at: '2026-07-21T21:45:00Z',
        assets: [{ name: 'Forca-Aliada-Manager-Setup-1.1.5.exe', size: 100438956 }],
      },
    });
  },
});
const first = await apiResolver();
assert.equal(first.version, '1.1.5');
assert.equal(first.status, 'ready');
assert.match(first.downloadUrl, /releases\/download\/v1\.1\.5\/Forca-Aliada-Manager-Setup-1\.1\.5\.exe$/);
assert.equal((await apiResolver()).version, '1.1.5');
assert.equal(calls, 1, 'cache deve impedir uma consulta ao GitHub a cada refresh do dashboard');

let fallbackCalls = 0;
const metadataResolver = createManagerReleaseResolver({
  fetchImpl: async url => {
    fallbackCalls += 1;
    if (String(url).includes('api.github.com')) return response({ status: 403 });
    return response({ text: 'version: 1.1.5\nfiles:\n  - url: Forca-Aliada-Manager-Setup-1.1.5.exe\n' });
  },
});
const fallback = await metadataResolver();
assert.equal(fallback.version, '1.1.5');
assert.equal(fallback.source, 'electron-updater-metadata');
assert.match(fallback.downloadUrl, /releases\/latest\/download\/Forca-Aliada-Manager-Setup-1\.1\.5\.exe$/);
assert.equal(fallbackCalls, 2);

now += 61_000;
let failedCalls = 0;
const staleResolver = createManagerReleaseResolver({
  now: () => now,
  cacheMs: 1000,
  fetchImpl: async () => {
    failedCalls += 1;
    if (failedCalls === 1) {
      return response({
        json: {
          tag_name: 'v1.1.5',
          assets: [{ name: 'Forca-Aliada-Manager-Setup-1.1.5.exe', size: 10 }],
        },
      });
    }
    throw Object.assign(new Error('network down'), { code: 'ECONNRESET' });
  },
});
assert.equal((await staleResolver()).status, 'ready');
now += 2000;
const stale = await staleResolver();
assert.equal(stale.version, '1.1.5');
assert.equal(stale.status, 'stale');
assert.equal(stale.stale, true);

const unavailable = await createManagerReleaseResolver({
  fetchImpl: async () => response({ status: 503 }),
})();
assert.equal(unavailable.version, null);
assert.equal(unavailable.downloadUrl, '');
assert.equal(unavailable.releasePageUrl, MANAGER_RELEASES_URL);

console.log('Release do Manager: API oficial, latest.yml, cache e contingencia validados.');
