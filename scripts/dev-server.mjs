// Safe local development HTTP server for GymLog V2.
// Binds ONLY to 127.0.0.1 (loopback), applies the security headers from _headers, and refuses to
// serve personal data files, CSV exports, ZIP archives, git metadata, or test/build scripts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

const ALLOWED_EXACT = new Set([
  'index.html',
  'manifest.webmanifest',
  'precache.json',
  'seed-defaults.json',
  'sw.js',
]);

function isAllowedPath(relPath) {
  if (ALLOWED_EXACT.has(relPath)) return true;
  if (relPath.startsWith('src/') && !relPath.includes('..')) return true;
  if (relPath.startsWith('icons/') && !relPath.includes('..')) return true;
  return false;
}

export function createDevServer({ rootDir = ROOT } = {}) {
  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
    );

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    const cleanPath = decodedPath.replace(/^\/+/, '');
    const relPath = cleanPath === '' ? 'index.html' : cleanPath;

    if (!isAllowedPath(relPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const diskPath = path.join(rootDir, relPath);
    if (!diskPath.startsWith(rootDir) || !fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(diskPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(diskPath).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const host = '127.0.0.1';
  const server = createDevServer();
  server.listen(port, host, () => {
    console.log(`GymLog V2 local dev server listening at http://localhost:${port}/ (bound to ${host})`);
  });
}
