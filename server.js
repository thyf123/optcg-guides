const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT   = process.env.PORT || 3000;
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';

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
    return serve(res, path.join(__dirname, 'landing.html'), MIME['.html']);
  }

  // ── Landing page static assets ──────────────────────────────
  if (url === '/base.css')  return serve(res, path.join(__dirname, 'base.css'),  MIME['.css']);
  if (url === '/style.css') return serve(res, path.join(__dirname, 'style.css'), MIME['.css']);

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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Starting card import...\n');

    const ALL_SETS = [
      'OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10','OP11','OP12','OP13','OP14',
      'EB01','EB02','EB03','EB04',
      'ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09','ST10',
      'ST11','ST12','ST13','ST14','ST15','ST16','ST17','ST18','ST19','ST20',
      'P'
    ];

    const SB_URL_LOCAL = process.env.SUPABASE_URL || SB_URL;
    const SB_KEY_LOCAL = process.env.SUPABASE_KEY || SB_KEY;

    function httpsGet(url) {
      return new Promise((resolve, reject) => {
        https.get(url, r => {
          let b = ''; r.on('data', c => b += c);
          r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
    }

    function upsert(rows) {
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
        const req = https.request(opts, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>resolve(r.statusCode)); });
        req.on('error', reject); req.write(body); req.end();
      });
    }

    (async () => {
      let total = 0;
      for (const setId of ALL_SETS) {
        try {
          const data = await httpsGet(`https://www.optcgapi.com/api/sets/filtered/?card_set_id=${encodeURIComponent(setId)}`);
          if (!Array.isArray(data) || !data.length) { res.write(`${setId}: skipped\n`); await new Promise(r=>setTimeout(r,800)); continue; }
          const rows = data.map(c => {
            const id = (c.card_id||c.card_set_id||'').trim().toUpperCase();
            const t = (c.card_type||c.type||'').trim();
            const ctrRaw = c.counter??c.counter_plus_power??c.card_counter??null;
            const ctr = ctrRaw!=null ? Number(String(ctrRaw).replace(/[^0-9]/g,'')) : null;
            return { id, card_type: t?t[0].toUpperCase()+t.slice(1).toLowerCase():null, cost:c.cost??c.card_cost??null, counter:ctr, card_name:c.card_name||null, card_color:c.card_color||null, set_id:setId };
          }).filter(r=>r.id);
          const status = await upsert(rows);
          res.write(`${setId}: ${rows.length} cards (status ${status})\n`);
          total += rows.length;
        } catch(e) { res.write(`${setId}: ERROR ${e.message}\n`); }
        await new Promise(r => setTimeout(r, 800));
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
