const RELEASE_REPOSITORY = 'ogabriels2/forca-aliada-releases';
const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
const UPDATE_METADATA_URL = `${RELEASES_URL}/download/latest.yml`;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 45 * 1000;
const DEFAULT_TIMEOUT_MS = 7000;

function versionOf(value) {
  const match = String(value || '').trim().match(/^v?(\d+\.\d+\.\d+)$/i);
  return match ? match[1] : '';
}

function assetNameFor(version) {
  return version ? `Forca-Aliada-Manager-Setup-${version}.exe` : '';
}

function releasePageUrl(tag = '') {
  const safeTag = String(tag || '').trim();
  return /^v?\d+\.\d+\.\d+$/i.test(safeTag)
    ? `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(safeTag)}`
    : RELEASES_URL;
}

function directDownloadUrl(assetName, tag = 'latest') {
  if (!/^Forca-Aliada-Manager-Setup-\d+\.\d+\.\d+\.exe$/.test(String(assetName || ''))) return '';
  const target = tag === 'latest' ? 'latest' : `download/${encodeURIComponent(tag)}`;
  return tag === 'latest'
    ? `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/${encodeURIComponent(assetName)}`
    : `https://github.com/${RELEASE_REPOSITORY}/releases/${target}/${encodeURIComponent(assetName)}`;
}

function errorCode(error) {
  const code = String(error?.code || '').trim();
  if (code) return code.slice(0, 64);
  const status = Number(error?.status || 0);
  return status ? `HTTP_${status}` : 'RELEASE_LOOKUP_FAILED';
}

async function request(fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Fetch indisponivel no runtime do backend.');
    error.code = 'FETCH_UNAVAILABLE';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: options.accept || 'application/octet-stream',
        'User-Agent': 'Forca-Aliada-Manager-Dashboard',
      },
    });
    if (!response?.ok) {
      const error = new Error(`Release metadata returned HTTP ${response?.status || 0}.`);
      error.code = 'RELEASE_HTTP_ERROR';
      error.status = Number(response?.status || 0);
      throw error;
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fromGitHubApi(fetchImpl, timeoutMs) {
  const response = await request(fetchImpl, RELEASE_API_URL, {
    timeoutMs,
    accept: 'application/vnd.github+json',
  });
  const payload = await response.json();
  const version = versionOf(payload?.tag_name);
  const expectedAsset = assetNameFor(version);
  const asset = Array.isArray(payload?.assets)
    ? payload.assets.find(item => item?.name === expectedAsset)
    : null;
  if (!version || !asset) {
    const error = new Error('The latest GitHub release has no validated Windows installer.');
    error.code = 'RELEASE_ASSET_INVALID';
    throw error;
  }
  return {
    version,
    tag: String(payload.tag_name),
    name: String(payload.name || `Forca Aliada Manager ${version}`).slice(0, 120),
    assetName: expectedAsset,
    assetSize: Number(asset.size || 0) || null,
    publishedAt: payload.published_at || null,
    downloadUrl: directDownloadUrl(expectedAsset, String(payload.tag_name)),
    releasePageUrl: releasePageUrl(payload.tag_name),
    source: 'github-release-api',
  };
}

async function fromUpdateMetadata(fetchImpl, timeoutMs) {
  const response = await request(fetchImpl, UPDATE_METADATA_URL, { timeoutMs, accept: 'application/x-yaml, text/yaml, text/plain' });
  const body = await response.text();
  // latest.yml has a fixed electron-updater schema. Only two allowlisted
  // scalar fields are read here; everything else is ignored.
  const version = versionOf(body.match(/^version:\s*["']?([^\s"']+)["']?\s*$/mi)?.[1]);
  const rawAsset = body.match(/^\s*-\s+url:\s*["']?([^\r\n"']+\.exe)["']?\s*$/mi)?.[1] || '';
  const assetName = decodeURIComponent(String(rawAsset).split(/[\\/]/).pop() || '');
  if (!version || assetName !== assetNameFor(version)) {
    const error = new Error('The public update metadata has no validated Windows installer.');
    error.code = 'UPDATE_METADATA_INVALID';
    throw error;
  }
  return {
    version,
    tag: `v${version}`,
    name: `Forca Aliada Manager ${version}`,
    assetName,
    assetSize: null,
    publishedAt: null,
    downloadUrl: directDownloadUrl(assetName, 'latest'),
    releasePageUrl: RELEASES_URL,
    source: 'electron-updater-metadata',
  };
}

export function createManagerReleaseResolver(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const cacheMs = Math.max(1000, Number(options.cacheMs || DEFAULT_CACHE_MS));
  const failureRetryMs = Math.max(1000, Number(options.failureRetryMs || DEFAULT_FAILURE_RETRY_MS));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  let cached = null;
  let expiresAt = 0;
  let retryAt = 0;
  let inFlight = null;

  async function refresh() {
    let primaryError = null;
    try {
      const release = await fromGitHubApi(fetchImpl, timeoutMs);
      cached = { ...release, status: 'ready', stale: false, checkedAt: new Date(now()).toISOString(), errorCode: '' };
      expiresAt = now() + cacheMs;
      retryAt = 0;
      return { ...cached };
    } catch (error) {
      primaryError = error;
    }

    try {
      const release = await fromUpdateMetadata(fetchImpl, timeoutMs);
      cached = { ...release, status: 'ready', stale: false, checkedAt: new Date(now()).toISOString(), errorCode: '' };
      expiresAt = now() + cacheMs;
      retryAt = 0;
      return { ...cached };
    } catch (fallbackError) {
      retryAt = now() + failureRetryMs;
      if (cached?.version) {
        return {
          ...cached,
          status: 'stale',
          stale: true,
          checkedAt: new Date(now()).toISOString(),
          errorCode: `${errorCode(primaryError)}+${errorCode(fallbackError)}`.slice(0, 129),
        };
      }
      return {
        version: null,
        tag: null,
        name: 'Forca Aliada Manager',
        assetName: null,
        assetSize: null,
        publishedAt: null,
        downloadUrl: '',
        releasePageUrl: RELEASES_URL,
        source: 'unavailable',
        status: 'unavailable',
        stale: false,
        checkedAt: new Date(now()).toISOString(),
        errorCode: `${errorCode(primaryError)}+${errorCode(fallbackError)}`.slice(0, 129),
      };
    }
  }

  return async function getLatestManagerRelease({ force = false } = {}) {
    const timestamp = now();
    if (!force && cached && timestamp < expiresAt) return { ...cached };
    if (!force && timestamp < retryAt) {
      return cached
        ? { ...cached, status: 'stale', stale: true }
        : {
            version: null,
            downloadUrl: '',
            releasePageUrl: RELEASES_URL,
            source: 'unavailable',
            status: 'unavailable',
            stale: false,
            checkedAt: new Date(timestamp).toISOString(),
            errorCode: 'RELEASE_RETRY_DELAY',
          };
    }
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return { ...(await inFlight) };
  };
}

const defaultResolver = createManagerReleaseResolver();

export function getLatestManagerRelease(options) {
  return defaultResolver(options);
}

export const MANAGER_RELEASES_URL = RELEASES_URL;
