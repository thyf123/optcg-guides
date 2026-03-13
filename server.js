const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 3000;
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';

const LANDING_DIR = path.join(__dirname, 'Grand Line \u2014 One Piece TCG');
const APP_FILE    = path.join(__dirname, 'rosinante_spa.html');
const LOGIN_FILE  = path.join(__dirname, 'login.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

function injectSB(html) {
  const tag = `<script>window._SB_URL="${SB_URL}";window._SB_KEY="${SB_KEY}";</script>`;
  return html.replace('<head>', '<head>' + tag);
}

function serve(res, filePath, mime, transform) {
  let content;
  try { content = fs.readFileSync(filePath, mime.startsWith('text') ? 'utf8' : null); }
  catch (e) { res.writeHead(404); res.end('Not found'); return; }
  if (transform) content = transform(content);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(content);
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  // ── Landing page (entry point) ──────────────────────────────
  if (url === '/' || url === '/index.html') {
    return serve(res, path.join(LANDING_DIR, 'index.html'), MIME['.html']);
  }

  // ── Landing page static assets ──────────────────────────────
  if (url === '/base.css')  return serve(res, path.join(LANDING_DIR, 'base.css'),  MIME['.css']);
  if (url === '/style.css') return serve(res, path.join(LANDING_DIR, 'style.css'), MIME['.css']);

  // ── Login page ──────────────────────────────────────────────
  if (url === '/login') {
    return serve(res, LOGIN_FILE, MIME['.html'], injectSB);
  }

  // ── App (the OPTCG SPA) ─────────────────────────────────────
  if (url === '/app') {
    return serve(res, APP_FILE, MIME['.html'], injectSB);
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  console.log(`Grand Line running on port ${PORT}`);
});
