const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT              = process.env.PORT || 3000; // build v2
const SB_URL            = process.env.SUPABASE_URL || '';
const SB_KEY            = process.env.SUPABASE_KEY || '';
const SB_SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || SB_KEY; // service role key bypasses RLS
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD || '';
// Random token generated at each server start — clients must re-login after redeploy
const ADMIN_TOKEN    = ADMIN_PASSWORD ? crypto.randomBytes(20).toString('hex') : '';
const LANDING_DIR    = path.join(__dirname, 'Grand Line \u2014 One Piece TCG');

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

// ── GumGum.gg deck parser ─────────────────────────────────────
// Individual deck page: https://gumgum.gg/decklists/deck/[region]/[format]/[uuid]
// Deck data in deckbuilder link: /deckbuilder?deck=4xOP10-065;4xOP09-069;...
function _parseGumgumHtml(res, html) {
  // Deck string from deckbuilder link (semicolons may be URL-encoded as %3B)
  const deckM = html.match(/deckbuilder\?deck=([^"&\s<>]+)/i);
  const cards = [];
  if (deckM) {
    const deckStr = decodeURIComponent(deckM[1]);
    const re = /(\d+)x([A-Z0-9]+(?:-[A-Z0-9]+)*)/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(deckStr)) !== null) {
      const count = parseInt(m[1]);
      const id    = m[2].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (count >= 1 && count <= 4) cards.push({ count, id });
    }
  }

  // Rank: first occurrence of "1st" / "2nd" etc. on the page
  const rankM = html.match(/\b(\d+(?:st|nd|rd|th))\b/i);
  const placement = rankM ? rankM[1] : '';

  const autoLabel = placement ? `GumGum · ${placement}` : 'GumGum build';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — paste the full deck page URL (not the list page)' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { player: '', placement, archetype: '', autoLabel, source: 'gumgum' } }));
  }
}

// ── Limitless tournament bulk parser ─────────────────────────
// /tournaments/{id}/decklists — multiple decks on one page.
// Each deck is preceded by: <h2>1st PlayerName</h2><h3>Archetype [price]</h3>
function _extractTournamentDecks(html) {
  const CARD_RE = /\/images\/decklist\/(\d+)\.png[\s\S]{0,400}?href="\/cards\/([A-Z]{1,4}\d*-\d{3,4})"/gi;
  const decks = [];
  const parts = html.split(/<h2[^>]*>/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const h2M = chunk.match(/^([^<]+)<\/h2>/);
    if (!h2M) continue;
    const h2Text = h2M[1].trim();
    const rankM  = h2Text.match(/^(\d+(?:st|nd|rd|th))\s+(.+)$/i);
    const placement = rankM ? rankM[1] : '';
    const player    = rankM ? rankM[2].trim() : h2Text;
    const h3M = chunk.match(/<h3[^>]*>([^<[]+)/i);
    const archetype = h3M ? h3M[1].trim() : '';
    CARD_RE.lastIndex = 0;
    const cards = [];
    const seen  = new Set();
    let m;
    while ((m = CARD_RE.exec(chunk)) !== null) {
      const count = parseInt(m[1]);
      const id    = m[2].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (count >= 1 && count <= 4) cards.push({ count, id });
    }
    if (!cards.length) continue;
    const shortRank = placement.match(/^(\d+(?:st|nd|rd|th))/i)?.[1] || '';
    const autoLabel = [player, shortRank].filter(Boolean).join(' · ') || archetype || `Deck ${i}`;
    decks.push({ player, placement, archetype, autoLabel, cards });
  }
  return decks;
}

function _parseLimitlessTournamentHtml(res, html) {
  const decks = _extractTournamentDecks(html);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!decks.length) {
    res.end(JSON.stringify({ ok: false, error: 'No decks found — make sure the URL ends in /decklists' }));
  } else {
    res.end(JSON.stringify({ ok: true, decks }));
  }
}

// Parse Limitless HTML: extract cards + tournament metadata from a /decks/list/{id} page.
// Card count:  src="…/images/decklist/N.png"
// Card ID:     href="/cards/OP13-002"
// Player:      <title>Archetype by PlayerName – Limitless One Piece</title>
// Placement:   <a href="/tournaments/NNN">1st Place Championship Finals Las Vegas</a>
function _parseLimitlessHtml(res, html) {
  // ── Cards ──
  const re = /\/images\/decklist\/(\d+)\.png[\s\S]{0,400}?href="\/cards\/([A-Z]{1,4}\d*-\d{3,4})"/gi;
  const cards = [];
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const count = parseInt(m[1]);
    const id    = m[2].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (count >= 1 && count <= 4) cards.push({ count, id });
  }

  // ── Metadata ──
  // Title: "Red/Blue Ace by Everydayclutch – Limitless One Piece"
  const titleM = html.match(/<title>(.+?) by ([^–—<]+?)\s*[–—]/i);
  const archetype = titleM ? titleM[1].trim() : '';
  const player    = titleM ? titleM[2].trim() : '';

  // Tournament link text: "1st Place Championship Finals Las Vegas"
  const tourM = html.match(/href="\/tournaments\/\d+"[^>]*>\s*([^<]+?)\s*<\/a>/i);
  const placement = tourM ? tourM[1].trim() : '';

  // Short rank for label: "1st", "2nd", etc.
  const rankM = placement.match(/^(\d+(?:st|nd|rd|th))/i);
  const shortRank = rankM ? rankM[1] : '';

  // Auto-label: "Everydayclutch · 1st" or fall back to archetype
  const autoLabel = [player, shortRank].filter(Boolean).join(' · ') || archetype || 'Imported build';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — Limitless may have changed their markup' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { player, placement, archetype, autoLabel } }));
  }
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
    return serve(res, path.join(__dirname, 'index.html'), MIME['.html'], injectSB);
  }
  if (url === '/styles.css') {
    return serve(res, path.join(__dirname, 'styles.css'), MIME['.css']);
  }
  if (url === '/app.js') {
    return serve(res, path.join(__dirname, 'app.js'), MIME['.js']);
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
            const id = (c.id || '').trim().toUpperCase().replace(/[_-][RP]\d+$/i, ''); // strip promo/reprint variants like _r1, _p1
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

  // ── Limitless TCG decklist proxy ─────────────────────────────
  // Fetches a limitlesstcg.com/decks/list/{id} page and parses cards.
  // Returns { ok, cards: [{id,count}] }
  if (url.startsWith('/api/fetch-limitless')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?limitlesstcg\.com\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only limitlesstcg.com URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    };
    https.get(opts, proxyRes => {
      // Follow one redirect if needed
      if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
        const redir = new URL(proxyRes.headers.location, targetUrl);
        const rOpts = {
          hostname: redir.hostname, path: redir.pathname + redir.search,
          headers: opts.headers
        };
        https.get(rOpts, r2 => {
          let html = ''; r2.on('data', c => html += c);
          r2.on('end', () => _parseLimitlessHtml(res, html));
        }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
        return;
      }
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseLimitlessHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  // ── Bandai deck recipe parser ────────────────────────────────
// Parses en.onepiece-cardgame.com/feature/deck/deck_NNN.php pages.
// Card ID:  src="/images/cardlist/card/OP01-006.png"
// Quantity: x4 (text node immediately after the img)
function _parseBandaiHtml(res, html) {
  const re = /\/cardlist\/card\/([A-Z0-9]{2,7}-\d{3,4})\.png[^>]*>[\s\S]{0,300}?x(\d+)/gi;
  const cards = [];
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const id    = m[1].toUpperCase();
    const count = parseInt(m[2]);
    if (seen.has(id)) continue;
    seen.add(id);
    if (count >= 1 && count <= 4) cards.push({ count, id });
  }

  // Deck name from <title> or first <h1>/<h2>
  const titleM = html.match(/<title>([^|<]+)/i);
  const deckName = titleM ? titleM[1].trim() : '';
  const autoLabel = deckName || 'Bandai Deck Recipe';

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  if (!cards.length) {
    res.end(JSON.stringify({ ok: false, error: 'No cards found — Bandai may have changed their markup' }));
  } else {
    res.end(JSON.stringify({ ok: true, cards, meta: { archetype: deckName, player: '', placement: '', autoLabel, source: 'bandai' } }));
  }
}

// ── Bandai deck recipe proxy ──────────────────────────────────
// Proxies en.onepiece-cardgame.com/feature/deck/deck_NNN.php
if (url.startsWith('/api/fetch-bandai')) {
  const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
  if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?onepiece-cardgame\.com\//)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Only onepiece-cardgame.com URLs are allowed' }));
    return;
  }
  const parsedUrl = new URL(targetUrl);
  const opts = {
    hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  };
  https.get(opts, proxyRes => {
    // Follow one redirect if needed
    if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
      const redir = new URL(proxyRes.headers.location, targetUrl);
      const rOpts = { hostname: redir.hostname, path: redir.pathname + redir.search, headers: opts.headers };
      https.get(rOpts, r2 => {
        let html = ''; r2.on('data', c => html += c);
        r2.on('end', () => _parseBandaiHtml(res, html));
      }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
      return;
    }
    let html = ''; proxyRes.on('data', c => html += c);
    proxyRes.on('end', () => _parseBandaiHtml(res, html));
  }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
  return;
}

// ── GumGum.gg decklist proxy ─────────────────────────────────
  if (url.startsWith('/api/fetch-gumgum')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?gumgum\.gg\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only gumgum.gg URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html,application/xhtml+xml' }
    };
    https.get(opts, proxyRes => {
      if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 302 && proxyRes.headers.location) {
        const redir = new URL(proxyRes.headers.location, targetUrl);
        const rOpts = { hostname: redir.hostname, path: redir.pathname + redir.search, headers: opts.headers };
        https.get(rOpts, r2 => {
          let html = ''; r2.on('data', c => html += c);
          r2.on('end', () => _parseGumgumHtml(res, html));
        }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
        return;
      }
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseGumgumHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  // ── Limitless tournament bulk decklist proxy ─────────────────
  if (url.startsWith('/api/fetch-limitless-tournament')) {
    const targetUrl = new URL('http://x' + req.url).searchParams.get('url') || '';
    if (!targetUrl.match(/^https?:\/\/([\w-]+\.)?limitlesstcg\.com\/tournaments\//)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Only limitlesstcg.com/tournaments/... URLs are allowed' }));
      return;
    }
    const parsedUrl = new URL(targetUrl);
    const opts = {
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html,application/xhtml+xml' }
    };
    https.get(opts, proxyRes => {
      let html = ''; proxyRes.on('data', c => html += c);
      proxyRes.on('end', () => _parseLimitlessTournamentHtml(res, html));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: e.message })); });
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

  // ── Admin login ──────────────────────────────────────────────
  if (url === '/api/admin-login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token: ADMIN_TOKEN }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Wrong password' }));
        }
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  // ── Admin token verify ───────────────────────────────────────
  if (url.startsWith('/api/admin-verify')) {
    const token = new URL('http://x' + req.url).searchParams.get('token') || '';
    if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // ── Admin: save LEADERS + DECKLISTS to Supabase ──────────────
  // Uses service role key (bypasses RLS). Admin token required.
  if (url === '/api/save-deck-data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) { res.writeHead(413); res.end('Payload too large'); } });
    req.on('end', async () => {
      try {
        const { token, leaders, decklists, variantRows } = JSON.parse(body);
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }
        if (!SB_URL || !SB_SERVICE_KEY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Supabase not configured' }));
          return;
        }

        function sbUpsert(rows) {
          return new Promise((resolve, reject) => {
            const sbBody = JSON.stringify(rows);
            const u = new URL('/rest/v1/optcg_sync?on_conflict=id,user_id', SB_URL);
            const opts = {
              hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(sbBody),
                'apikey': SB_SERVICE_KEY,
                'Authorization': 'Bearer ' + SB_SERVICE_KEY,
                'Prefer': 'resolution=merge-duplicates'
              }
            };
            const sbReq = https.request(opts, sbRes => {
              let b = ''; sbRes.on('data', c => b += c);
              sbRes.on('end', () => resolve({ status: sbRes.statusCode, body: b }));
            });
            sbReq.on('error', reject); sbReq.write(sbBody); sbReq.end();
          });
        }

        // 1. Save leaders + legacy decklists blob
        const baseRows = [
          { id: 'leaders-data',   payload: leaders,   user_id: 'admin', updated_at: new Date().toISOString() },
          { id: 'decklists-data', payload: decklists, user_id: 'admin', updated_at: new Date().toISOString() },
        ];
        const r1 = await sbUpsert(baseRows);
        if (r1.status >= 300) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r1.body.slice(0, 300) })); return;
        }

        // 2. Save per-variant rows: deck:{deckKey}:{variantIdx}
        if (Array.isArray(variantRows) && variantRows.length > 0) {
          const vRows = variantRows.map(v => ({
            id: `deck:${v.deckKey}:${v.variantIdx}`,
            payload: v.payload,
            user_id: 'admin',
            updated_at: new Date().toISOString()
          }));
          // Chunk into 50 rows per request to stay within limits
          const CHUNK = 50;
          for (let i = 0; i < vRows.length; i += CHUNK) {
            const r = await sbUpsert(vRows.slice(i, i + CHUNK));
            if (r.status >= 300) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'variant rows: ' + r.body.slice(0, 200) })); return;
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // ── Scrape status (public read) ─────────────────────────────
  if (url === '/api/scrape-status') {
    _getScrapeState().then(state => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, ...state }));
    }).catch(() => { res.writeHead(500); res.end('{}'); });
    return;
  }

  // ── Manual scrape trigger (admin only) ──────────────────────
  if (url === '/api/trigger-scrape') {
    const token = new URL('http://x' + req.url).searchParams.get('token') || '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Scrape triggered in background' }));
    runDailyScrape().catch(e => console.error('[scraper] Manual trigger error:', e.message));
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, () => {
  console.log(`Grand Line running on port ${PORT}`);
});

// ════════════════════════════════════════════════════════════════
// DAILY TOURNAMENT AUTO-SCRAPER
// Runs 3 min after startup, then every 24 h.
// Fetches all new Limitless One Piece tournaments → parses every
// decklist → assigns each to the right leader via LEADER_MAP →
// appends as a variant row in Supabase optcg_sync.
// ════════════════════════════════════════════════════════════════

// Leader card ID → deckKey (auto-generated from DECKLISTS in rosinante_spa.html)
// Add new leaders here when new sets are released.
const LEADER_MAP = {
  "OP01-002":"op01_law",   "OP07-019":"op7bonney",  "OP08-021":"op8carrot",
  "OP08-058":"op8sabo",    "OP09-001":"op9shanks",  "OP09-022":"op9lim",
  "OP09-062":"op9robin",   "OP09-081":"op9teach",   "OP11-001":"op11koby",
  "OP11-022":"op11shirahoshi","OP11-040":"op11luffy","OP11-041":"op11nami",
  "OP12-001":"op12rayleigh","OP12-040":"op12kuzan", "OP12-041":"op12sanji",
  "OP12-061":"op12mirror", "OP13-001":"op13luffy",  "OP13-002":"op13ace",
  "OP13-003":"op13roger",  "OP13-004":"op13sabo",   "OP13-079":"op13imu",
  "OP13-100":"op13bonney", "OP14-020":"op14mihawk", "OP14-040":"op14jinbe",
  "OP14-041":"op14boa",    "OP14-060":"op14doffy",  "OP14-079":"op14crocodile",
  "OP14-080":"op14moria",  "EB02-010":"eb2luffy",   "EB03-001":"eb3vivi",
  "ST13-003":"st13luffy",  "ST29-001":"st29luffy",  "P-117":"p117nami",
};

// ── Helpers ───────────────────────────────────────────────────

function _scraperGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OPTCG-Guide-Bot/1.0)', 'Accept': 'text/html' } };
    https.get(opts, r => {
      if ((r.statusCode === 301 || r.statusCode === 302) && r.headers.location) {
        return _scraperGet(new URL(r.headers.location, url).href).then(resolve).catch(reject);
      }
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

function _scraperSbGet(path) {
  return new Promise((resolve, reject) => {
    if (!SB_URL || !SB_SERVICE_KEY) { resolve(null); return; }
    const u = new URL(path, SB_URL);
    https.get({ hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': 'Bearer ' + SB_SERVICE_KEY }
    }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}

function _scraperSbUpsert(rows) {
  return new Promise((resolve, reject) => {
    if (!SB_URL || !SB_SERVICE_KEY) { resolve({ status: 503 }); return; }
    const body = JSON.stringify(rows);
    const u = new URL('/rest/v1/optcg_sync?on_conflict=id,user_id', SB_URL);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'apikey': SB_SERVICE_KEY, 'Authorization': 'Bearer ' + SB_SERVICE_KEY,
        'Prefer': 'resolution=merge-duplicates' } };
    const req = https.request(opts, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function _getScrapeState() {
  try {
    const rows = await _scraperSbGet('/rest/v1/optcg_sync?id=eq.scrape%3Astate&select=payload');
    if (Array.isArray(rows) && rows[0]?.payload) return rows[0].payload;
  } catch(e) {}
  return { importedIds: [], lastRun: null, totalSaved: 0 };
}

async function _saveScrapeState(state) {
  await _scraperSbUpsert([{
    id: 'scrape:state', payload: state, user_id: 'admin',
    updated_at: new Date().toISOString()
  }]);
}

async function _getCardMeta(ids) {
  if (!ids.length) return {};
  const idList = ids.map(id => `"${id}"`).join(',');
  const rows = await _scraperSbGet(`/rest/v1/card_metadata?id=in.(${idList})&select=id,card_type,card_name`);
  const map = {};
  if (Array.isArray(rows)) rows.forEach(r => { map[r.id] = { type: r.card_type, name: r.card_name }; });
  return map;
}

async function _buildSections(cards, leaderCardId) {
  const others = cards.filter(c => c.id !== leaderCardId);
  const metaMap = await _getCardMeta(others.map(c => c.id));
  const chars = [], events = [], stages = [], other = [];
  for (const card of others) {
    const m = metaMap[card.id] || {};
    const entry = { id: card.id, name: m.name || card.id, count: card.count };
    if      (m.type === 'Character') chars.push(entry);
    else if (m.type === 'Event')     events.push(entry);
    else if (m.type === 'Stage')     stages.push(entry);
    else                             other.push(entry);
  }
  const sections = [];
  if (chars.length)  sections.push({ title: 'Character', cards: chars });
  if (events.length) sections.push({ title: 'Event',     cards: events });
  if (stages.length) sections.push({ title: 'Stage',     cards: stages });
  if (other.length)  sections.push({ title: 'Other',     cards: other });
  return sections;
}

async function _countExistingVariants(deckKey) {
  try {
    const rows = await _scraperSbGet(`/rest/v1/optcg_sync?id=like.deck%3A${deckKey}%3A*&select=id`);
    return Array.isArray(rows) ? rows.length : 0;
  } catch(e) { return 0; }
}

// ── Main scrape function ───────────────────────────────────────
async function runDailyScrape() {
  if (!SB_URL || !SB_SERVICE_KEY) {
    console.log('[scraper] Supabase not configured — skipping');
    return;
  }
  console.log('[scraper] Daily tournament scrape starting');
  try {
    const state = await _getScrapeState();
    const importedIds = new Set((state.importedIds || []).map(Number));

    // Fetch recent tournament IDs from Limitless
    const listHtml = await _scraperGet('https://onepiece.limitlesstcg.com/tournaments');
    const ids = [];
    const re = /href="\/tournaments\/(\d+)"/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(listHtml)) !== null) {
      const id = parseInt(m[1]);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const newIds = ids.slice(0, 30).filter(id => !importedIds.has(id));
    console.log(`[scraper] ${ids.length} tournaments found, ${newIds.length} new`);

    let totalSaved = state.totalSaved || 0;

    for (const tournamentId of newIds) {
      console.log(`[scraper] Fetching tournament ${tournamentId}`);
      try {
        const html  = await _scraperGet(`https://onepiece.limitlesstcg.com/tournaments/${tournamentId}/decklists`);
        const decks = _extractTournamentDecks(html);

        if (!decks.length) { importedIds.add(tournamentId); continue; }

        let saved = 0;
        for (const deck of decks) {
          // Identify leader card
          const leaderCard = deck.cards.find(c => LEADER_MAP[c.id]);
          if (!leaderCard) continue;
          const deckKey = LEADER_MAP[leaderCard.id];

          const sections = await _buildSections(deck.cards, leaderCard.id);
          if (!sections.length) continue;

          const nextIdx = await _countExistingVariants(deckKey);
          const result  = await _scraperSbUpsert([{
            id: `deck:${deckKey}:${nextIdx}`,
            payload: {
              label: deck.autoLabel,
              sections,
              meta: {
                player: deck.player, placement: deck.placement,
                archetype: deck.archetype, date: '',
                source: 'limitless-auto',
                url: `https://onepiece.limitlesstcg.com/tournaments/${tournamentId}/decklists`
              }
            },
            user_id: 'admin',
            updated_at: new Date().toISOString()
          }]);
          if (result.status < 300) { saved++; totalSaved++; }
          await new Promise(r => setTimeout(r, 250)); // gentle rate limit
        }

        console.log(`[scraper] Tournament ${tournamentId}: ${saved}/${decks.length} saved`);
        importedIds.add(tournamentId);

        // Persist state after each tournament so a crash doesn't repeat work
        await _saveScrapeState({
          importedIds: [...importedIds], lastRun: new Date().toISOString(), totalSaved
        });
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`[scraper] Tournament ${tournamentId} error:`, e.message);
      }
    }

    console.log(`[scraper] Done. Total decks ever saved: ${totalSaved}`);
  } catch(e) {
    console.error('[scraper] Fatal error:', e.message);
  }
}

// ── Schedule ──────────────────────────────────────────────────
// Run 3 min after startup (let server init), then every 24 h
setTimeout(runDailyScrape, 3 * 60 * 1000);
setInterval(runDailyScrape, 24 * 60 * 60 * 1000);
