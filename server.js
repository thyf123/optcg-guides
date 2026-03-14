const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = process.env.PORT || 3000;
const SB_URL      = process.env.SUPABASE_URL || '';
const SB_KEY      = process.env.SUPABASE_KEY || '';
const LANDING_DIR = path.join(__dirname, 'Grand Line \u2014 One Piece TCG');

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

  // ── Landing page ────────────────────────────────────────────
  if (url === '/' || url === '/index.html') {
    return serve(res, path.join(LANDING_DIR, 'index.html'), MIME['.html']);
  }

  // ── Landing page static assets ──────────────────────────────
  if (url === '/base.css')  return serve(res, path.join(LANDING_DIR, 'base.css'),  MIME['.css']);
  if (url === '/style.css') return serve(res, path.join(LANDING_DIR, 'style.css'), MIME['.css']);

  // ── Login page ──────────────────────────────────────────────
  if (url === '/login') {
    return serve(res, path.join(__dirname, 'login.html'), MIME['.html'], injectSB);
  }

  // ── App (the OPTCG SPA) ─────────────────────────────────────
  if (url === '/app') {
    return serve(res, path.join(__dirname, 'rosinante_spa.html'), MIME['.html'], injectSB);
  }

  // ── One-time card import: fetches all sets → saves to Supabase ──
  // Trigger by visiting /api/import-cards in browser (Railway's IP, not yours)
  if (url === '/api/import-cards') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    res.write('Starting card import from punk-records (GitHub)...\n');

    // Source: https://github.com/buhbbl/punk-records — static JSON, no API key, no rate limits
    const GH_RAW = 'https://raw.githubusercontent.com/buhbbl/punk-records/main/english';
    const SB_URL_LOCAL = process.env.SUPABASE_URL || 'https://ecsvfbupidmoaekxlcau.supabase.co';
    const SB_KEY_LOCAL = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjc3ZmYnVwaWRtb2Fla3hsY2F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM0MDI0MDQsImV4cCI6MjA1ODk3ODQwNH0.iSu_Hn9a0RhJ8TjS7FMPKa5u7DPqyMF7H0GCnQYRb0o';

    function httpsGet(url) {
      return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Node.js' } }, r => {
          let b = ''; r.on('data', c => b += c);
          r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
    }

    function upsertBatch(rows) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(rows);
        const u = new URL('/rest/v1/card_metadata?on_conflict=id', SB_URL_LOCAL);
        const opts = {
          hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            'apikey': SB_KEY_LOCAL, 'Authorization': 'Bearer ' + SB_KEY_LOCAL,
            'Prefer': 'resolution=merge-duplicates'
          }
        };
        const req = https.request(opts, r => {
          let b = '';
          r.on('data', c => b += c);
          r.on('end', () => resolve({ status: r.statusCode, body: b }));
        });
        req.on('error', reject); req.write(body); req.end();
      });
    }
    // Send in chunks of 100 to stay within Supabase's row/payload limits
    async function upsert(rows) {
      const CHUNK = 100;
      let worstStatus = 200;
      let errorBody = '';
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { status, body } = await upsertBatch(rows.slice(i, i + CHUNK));
        if (status >= 300) { worstStatus = status; errorBody = body; }
      }
      return { status: worstStatus, errorBody };
    }

    (async () => {
      let total = 0;
      // Step 1: get pack index
      const packs = await httpsGet(`${GH_RAW}/packs.json`);
      if (!packs) { res.write('ERROR: could not fetch packs.json\n'); res.end(); return; }
      const packIds = Object.keys(packs);
      res.write(`Found ${packIds.length} packs. Importing...\n`);

      // Step 2: fetch each pack's card data
      for (const packId of packIds) {
        const label = packs[packId]?.title_parts?.label || packId;
        try {
          const cards = await httpsGet(`${GH_RAW}/data/${packId}.json`);
          if (!Array.isArray(cards) || !cards.length) { res.write(`${label}: skipped (empty)\n`); continue; }
          const rows = cards.map(c => {
            const id = (c.id || '').trim().toUpperCase().replace(/_R\d+$/, ''); // strip promo variants like _r1
            const setId = id.split('-')[0];
            const ctr = c.counter != null ? Number(String(c.counter).replace(/[^0-9]/g,'')) : null;
            const color = Array.isArray(c.colors) ? c.colors[0] : (c.colors || null);
            const cat = c.category || '';
            return { id, card_type: cat, cost: c.cost ?? null, counter: isNaN(ctr) ? null : ctr, card_name: c.name || null, card_color: color, set_id: setId };
          }).filter(r => r.id && r.set_id);
          const { status, errorBody } = await upsert(rows);
          const suffix = status >= 300 ? ` ← ${errorBody.slice(0, 200)}` : '';
          res.write(`${label} (${packId}): ${rows.length} cards → Supabase ${status}${suffix}\n`);
          total += rows.length;
        } catch(e) { res.write(`${label}: ERROR ${e.message}\n`); }
        await new Promise(r => setTimeout(r, 200)); // gentle delay, GitHub CDN is fast
      }
      res.write(`\nDone. ${total} total cards imported.\n`);
      res.end();
    })();
    return;
  }

  // ── Card data proxy (avoids CORS on client side) ────────────
  if (url === '/api/cards') {
    const setId = (req.url.split('set=')[1] || '').split('&')[0];
    if (!setId) { res.writeHead(400); res.end('Missing set param'); return; }
    const apiUrl = `https://www.optcgapi.com/api/sets/filtered/?card_set_id=${encodeURIComponent(setId)}`;
    https.get(apiUrl, apiRes => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(body);
      });
    }).on('error', e => { res.writeHead(502); res.end('Upstream error'); });
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  console.log(`Grand Line running on port ${PORT}`);
});
