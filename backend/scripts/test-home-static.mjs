import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const designSource = fs.readFileSync(path.join(root, 'assets/js/fa-design-system.js'), 'utf8');
const designCss = fs.readFileSync(path.join(root, 'assets/css/fa-design-system.css'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const manifestSource = fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8');

let parsedScripts = 0;
const scriptPattern = /<script\b(?![^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
for (const match of indexSource.matchAll(scriptPattern)) {
  const source = match[1].trim();
  if (!source) continue;
  new Function(source);
  parsedScripts += 1;
}
assert.equal(parsedScripts, 2, 'expected both inline home scripts to parse');

assert.match(indexSource, /<main id="conteudo-principal">/);
assert.match(indexSource, /<nav class="mobile-nav-overlay"[^>]+aria-hidden="true" inert>/);
assert.match(indexSource, /aria-controls="mobile-nav" aria-expanded="false"/);
assert.match(indexSource, /data-gallery-index="2"/);
assert.match(indexSource, /'galeria27\.webp'/);
assert.match(indexSource, /fa-pwa\.js\?v=pwa6-20260722/);
assert.match(indexSource, /fetch\(`\$\{API_BASE\}\/api\/auth\/logout`/);
assert.match(indexSource, /keepalive: true/);
assert.match(indexSource, /#lightbox-img[\s\S]*object-fit: contain/);
assert.match(indexSource, /\.hero \{[\s\S]*min-height: 100vh;[\s\S]*min-height: 100svh;/);
assert.match(indexSource, /data-close-menu[^\n]*\)\) setMobileMenu\(false\);/);
assert.match(indexSource, /setUserDropdown\(false\);\s+userToggle\.focus\(\);/);
assert.match(indexSource, /aria-label="Abrir menu da conta de \$\{username\}"/);
assert.doesNotMatch(indexSource, /window\.addEventListener\('load', async/);
assert.doesNotMatch(indexSource, /https:\/\/placehold\.co/);
assert.doesNotMatch(indexSource, /<div[^>]+role="button"/);

assert.match(designSource, /classList\.add\('fa-motion-ready'\)/);
assert.match(designCss, /\.fa-motion-ready \.fa-reveal/);
assert.match(serviceWorkerSource, /fa-static-v51-home-repair/);
assert.match(serviceWorkerSource, /OFFLINE_NOT_FOUND_URL/);
assert.ok(serviceWorkerSource.includes("|| /^\\/community\\/(?:post|profile)\\/[^/]+$/.test(url.pathname);"));
assert.match(serviceWorkerSource, /if \(isTerms\) return caches\.match\('termos\.html'\)/);
assert.match(serviceWorkerSource, /if \(isPrivacy\) return caches\.match\('privacidade\.html'\)/);
assert.equal(JSON.parse(manifestSource).start_url, '/?source=pwa');

console.log('home static checks passed');
