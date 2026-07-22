import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(projectRoot, '.pages-dist');

const publicFiles = [
  '_headers',
  '_routes.json',
  '_worker.js',
  'account.html',
  'community.html',
  'community.webmanifest',
  'dashboard.html',
  'guia.html',
  'index.html',
  'llms.txt',
  'login.html',
  'manifest.webmanifest',
  'post.html',
  'privacidade.html',
  'profile.html',
  'recuperar.html',
  'robots.txt',
  'service-worker.js',
  'signup.html',
  'staff-offline.html',
  'staff.webmanifest',
  'termos.html',
];

const publicDirectories = ['.well-known', 'assets'];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const relativePath of [...publicFiles, ...publicDirectories]) {
  const source = resolve(projectRoot, relativePath);
  await stat(source);
  await cp(source, resolve(outputRoot, relativePath), {
    recursive: true,
    force: true,
  });
}

console.log(`Prepared ${publicFiles.length} files and ${publicDirectories.length} directories in .pages-dist`);
