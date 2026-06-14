const API_ORIGIN = 'https://forca-aliada-site.onrender.com';
const DYNAMIC_PATHS = [
  /^\/share\//,
  /^\/sitemap(?:-[a-z0-9-]+)?\.xml$/,
  /^\/sitemap-posts-page-\d+\.xml$/,
];

function isDynamicPath(pathname) {
  return DYNAMIC_PATHS.some(pattern => pattern.test(pathname));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!isDynamicPath(url.pathname)) return env.ASSETS.fetch(request);

    const upstream = new URL(url.pathname + url.search, API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', 'https');

    return fetch(upstream, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  },
};
